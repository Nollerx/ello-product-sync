import { useEffect, useState } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useNavigate } from "react-router";
import {
  Page,
  Text,
  Card,
  Button,
  BlockStack,
  InlineStack,
  Badge,
  Box,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { syncShopifyMerchantToSupabase } from "../lib/shopify-billing.server";
import {
  AOV_DEFAULT,
  OVERAGE_USD_PER_TRYON,
  PRICING_PLANS,
  breakEvenOrders,
  formatMoney,
} from "../lib/pricing-plans";

const TRIAL_DAYS = 7;

// ─── Billing config lookup (mirrors shopify.server.ts) ───────────────────────

type BillingLineItem = {
  amount: number;
  currencyCode: string;
  interval: "EVERY_30_DAYS" | "ANNUAL";
  terms?: string;
};

function getBillingPlan(planKey: string, isTest: boolean): { lineItems: BillingLineItem[]; test: boolean } | null {
  const configs = Object.fromEntries(
    PRICING_PLANS.flatMap((plan) => [
      [`${plan.key}_monthly`, { amount: plan.monthlyPrice, interval: "EVERY_30_DAYS" as const }],
      [`${plan.key}_annual`, { amount: plan.annualPrice, interval: "ANNUAL" as const }],
    ]),
  );
  const cfg = configs[planKey];
  if (!cfg) return null;
  return {
    test: isTest,
    lineItems: [
      { amount: cfg.amount, currencyCode: "USD", interval: cfg.interval },
      { amount: 15, currencyCode: "USD", interval: "EVERY_30_DAYS", terms: `$${OVERAGE_USD_PER_TRYON.toFixed(2)} per try-on beyond your plan's included amount` },
    ],
  };
}

// ─── Loader ──────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const billingError = url.searchParams.get("billingError") ?? null;
  return { billingError };
}

// ─── Action: create subscription via GraphQL, return confirmationUrl ─────────

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const planKey = formData.get("planKey") as string;
  const interval = formData.get("interval") as string;

  // ello_free: no Shopify billing — just sync and return a redirect signal
  // for the client to navigate. (fetcher.submit does not auto-follow redirects.)
  if (planKey === "ello_free") {
    try {
      const shopQuery = await admin.graphql(`query { shop { email } }`);
      const shopJson = await shopQuery.json();
      const shopEmail = shopJson?.data?.shop?.email ?? session.shop;
      await syncShopifyMerchantToSupabase(session.shop, shopEmail, "ello_free", undefined);
    } catch (err) {
      console.error(`[Billing] ello_free sync failed for ${session.shop}:`, err);
      return { error: "Failed to activate free plan. Please try again." };
    }
    return { redirectTo: "/app" };
  }

  const fullPlanKey = `${planKey}_${interval}`;

  // Determine test mode
  let isDevStore = false;
  try {
    const shopResp = await admin.graphql(`query { shop { plan { partnerDevelopment } } }`);
    const shopJson = await shopResp.json();
    isDevStore = shopJson?.data?.shop?.plan?.partnerDevelopment === true;
  } catch { /* ignore */ }
  // eslint-disable-next-line no-undef
  const isTest = process.env.BILLING_TEST_MODE === "true" || process.env.SKIP_BILLING === "true" || isDevStore;

  const billingPlan = getBillingPlan(fullPlanKey, isTest);
  if (!billingPlan) {
    return { error: `Unknown plan: ${fullPlanKey}` };
  }

  // Return directly to the Shopify admin embedded app URL.
  // This avoids the top-level bounce through the Cloud Run URL that causes
  // a brief login page. The billing gate in app.tsx handles syncing the
  // subscription to Supabase on the next page load.
  const storeHandle = session.shop.replace(".myshopify.com", "");
  const returnUrl = `https://admin.shopify.com/store/${storeHandle}/apps/${process.env.SHOPIFY_API_KEY}/app`;

  // Build the GraphQL mutation
  const recurringItem = billingPlan.lineItems[0];
  const usageItem = billingPlan.lineItems[1];

  const mutation = `#graphql
    mutation AppSubscriptionCreate(
      $name: String!,
      $returnUrl: URL!,
      $test: Boolean,
      $trialDays: Int,
      $lineItems: [AppSubscriptionLineItemInput!]!,
      $replacementBehavior: AppSubscriptionReplacementBehavior
    ) {
      appSubscriptionCreate(
        name: $name,
        returnUrl: $returnUrl,
        test: $test,
        trialDays: $trialDays,
        lineItems: $lineItems,
        replacementBehavior: $replacementBehavior
      ) {
        appSubscription { id }
        confirmationUrl
        userErrors { field message }
      }
    }
  `;

  const variables = {
    name: fullPlanKey,
    returnUrl: returnUrl.toString(),
    test: isTest,
    trialDays: TRIAL_DAYS,
    replacementBehavior: "APPLY_IMMEDIATELY",
    lineItems: [
      {
        plan: {
          appRecurringPricingDetails: {
            price: { amount: recurringItem.amount, currencyCode: "USD" },
            interval: recurringItem.interval,
          },
        },
      },
      {
        plan: {
          appUsagePricingDetails: {
            cappedAmount: { amount: usageItem.amount, currencyCode: "USD" },
            terms: usageItem.terms,
          },
        },
      },
    ],
  };

  try {
    console.log(`[Billing] Creating subscription ${fullPlanKey} for ${session.shop} (test: ${isTest})`);
    const resp = await admin.graphql(mutation, { variables });
    const json = await resp.json();

    const result = json?.data?.appSubscriptionCreate;
    if (result?.userErrors?.length > 0) {
      const errMsg = result.userErrors.map((e: { message: string }) => e.message).join(", ");
      console.error(`[Billing] userErrors for ${session.shop}:`, errMsg);
      return { error: errMsg };
    }

    const confirmationUrl = result?.confirmationUrl;
    if (!confirmationUrl) {
      console.error("[Billing] No confirmationUrl returned");
      return { error: "Failed to create subscription — no confirmation URL" };
    }

    console.log(`[Billing] Subscription created for ${session.shop}, redirecting to: ${confirmationUrl}`);
    return { confirmationUrl };
  } catch (err) {
    console.error("[Billing] GraphQL error:", err);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function BillingPage() {
  const { billingError } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const [interval, setInterval] = useState<"monthly" | "annual">("monthly");
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [averageOrderValue, setAverageOrderValue] = useState(AOV_DEFAULT);

  // When the action returns a confirmationUrl, redirect the TOP frame to it.
  // This is the correct way to handle billing redirects in embedded Shopify apps —
  // the Shopify billing page must load at the top level, not in the iframe.
  const actionData = fetcher.data as { confirmationUrl?: string; error?: string; redirectTo?: string } | undefined;
  useEffect(() => {
    if (!actionData?.confirmationUrl) return;
    window.open(actionData.confirmationUrl, "_top");
  }, [actionData?.confirmationUrl]);

  // ello_free flow: no Shopify billing — navigate to dashboard in-app.
  useEffect(() => {
    if (!actionData?.redirectTo) return;
    navigate(actionData.redirectTo);
  }, [actionData?.redirectTo, navigate]);

  const actionError = actionData?.error;
  const isSubmitting = fetcher.state === "submitting" || fetcher.state === "loading";
  const billingIntervalLabel = interval === "monthly" ? "monthly" : "annual";

  const handleSelectPlan = (planKey: string) => {
    setSelectedPlan(planKey);
    fetcher.submit(
      { planKey, interval },
      { method: "POST" },
    );
  };

  return (
    <Page
      fullWidth
      title="Choose Your Plan"
      subtitle="Start with a 7-day free trial. Cancel anytime."
    >
      <BlockStack gap="800">

        {/* Error banner */}
        {(billingError || actionError) && (
          <Banner title="Billing Error" tone="critical">
            <Text as="p" variant="bodyMd">{actionError || billingError}</Text>
          </Banner>
        )}

        {/* Interval toggle */}
        <InlineStack align="center" gap="200">
          <Button
            variant={interval === "monthly" ? "primary" : "plain"}
            onClick={() => setInterval("monthly")}
          >
            Monthly
          </Button>
          <Button
            variant={interval === "annual" ? "primary" : "plain"}
            onClick={() => setInterval("annual")}
          >
            Annual · Save 10%
          </Button>
        </InlineStack>

        {/* Free plan — horizontal strip */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center" wrap={false}>
              <BlockStack gap="100">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">Ello Free</Text>
                  <Badge tone="info">Free</Badge>
                </InlineStack>
                <Text as="p" variant="bodyMd" tone="subdued">
                  $0/month · 10 try-ons per month · Ello branding on widget. No overages — upgrade anytime when you are ready for real traffic.
                </Text>
              </BlockStack>
              <Box minWidth="220px">
                <Button
                  fullWidth
                  onClick={() => handleSelectPlan("ello_free")}
                  loading={isSubmitting && selectedPlan === "ello_free"}
                  disabled={isSubmitting}
                >
                  Use Free Plan
                </Button>
              </Box>
            </InlineStack>
          </BlockStack>
        </Card>

        {/* AOV strip — drives the hero number on every plan card below */}
        <Box
          padding="400"
          background="bg-surface-secondary"
          borderRadius="200"
          borderWidth="025"
          borderColor="border"
        >
          <InlineStack gap="400" blockAlign="center" wrap={false}>
            <BlockStack gap="050">
              <Text as="p" variant="bodySm" tone="subdued">
                Your average order value
              </Text>
              <InlineStack gap="100" blockAlign="center">
                <Text as="span" variant="headingLg">$</Text>
                <input
                  id="average-order-value"
                  type="number"
                  min="1"
                  step="1"
                  value={averageOrderValue}
                  onChange={(event) => setAverageOrderValue(Number(event.currentTarget.value))}
                  style={{
                    width: "90px",
                    fontSize: "20px",
                    fontWeight: 600,
                    padding: "4px 8px",
                    border: "1px solid #B8BECA",
                    borderRadius: "6px",
                  }}
                />
              </InlineStack>
            </BlockStack>
            <Box>
              <Text as="p" variant="bodyMd" tone="subdued">
                Change this to see exactly how many sales each plan needs to pay for itself.
              </Text>
            </Box>
          </InlineStack>
        </Box>

        {/* Plan grid — single row of 4, featured plan elevated */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: "20px",
            alignItems: "stretch",
            paddingTop: "16px",
          }}
        >
          {PRICING_PLANS.map((plan) => {
            const monthlyBreakEven = breakEvenOrders(plan.monthlyPrice, averageOrderValue);
            const activePrice = interval === "monthly" ? plan.monthlyPrice : plan.annualPrice;
            return (
              <div
                key={plan.key}
                style={{
                  transform: plan.featured ? "translateY(-16px)" : "none",
                  display: "flex",
                  flexDirection: "column",
                  height: "100%",
                  borderRadius: "14px",
                  border: plan.featured ? "2px solid #0F5132" : "1px solid transparent",
                  boxShadow: plan.featured
                    ? "0 16px 36px rgba(15, 81, 50, 0.18)"
                    : "none",
                  overflow: "hidden",
                  background: "#FFFFFF",
                }}
              >
                <Card padding="800">
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "20px",
                      height: "100%",
                    }}
                  >
                    {plan.featured && (
                      <Box>
                        <Badge tone="success">Best first plan</Badge>
                      </Box>
                    )}

                    <BlockStack gap="200">
                      <Text as="h2" variant="headingLg">
                        Ello {plan.displayName}
                      </Text>

                      <Text as="p" variant="heading2xl">
                        {formatMoney(activePrice)}
                        <Text as="span" variant="bodyMd" tone="subdued">
                          {interval === "monthly" ? " /mo" : " /yr"}
                        </Text>
                      </Text>
                    </BlockStack>

                    <BlockStack gap="100">
                      <Text as="p" variant="headingMd" fontWeight="semibold">
                        {plan.includedTryons.toLocaleString()} try-ons/mo
                      </Text>
                      <Text as="p" variant="bodyMd" tone="subdued">
                        {plan.positioning}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        ${OVERAGE_USD_PER_TRYON.toFixed(2)} per additional · 7-day free trial
                      </Text>
                    </BlockStack>

                    <Box
                      padding="500"
                      background="bg-surface-success"
                      borderRadius="300"
                      borderWidth="025"
                      borderColor="border-success"
                    >
                      <BlockStack gap="200">
                        <span
                          style={{
                            fontSize: "64px",
                            fontWeight: 700,
                            lineHeight: 1,
                            color: "#0F5132",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {monthlyBreakEven ?? "—"}
                        </span>
                        <Text as="p" variant="bodyLg" fontWeight="semibold">
                          extra {monthlyBreakEven === 1 ? "sale from try-on covers" : "sales from try-on cover"} the month
                        </Text>
                        <Text as="p" variant="bodyMd" tone="subdued">
                          {formatMoney(plan.monthlyPrice)} ÷ {formatMoney(averageOrderValue || AOV_DEFAULT)} AOV — every sale after is profit
                        </Text>
                      </BlockStack>
                    </Box>

                    <Text as="p" variant="bodySm" tone="subdued">
                      Billed {billingIntervalLabel}. Usage resets monthly.
                      {interval === "annual" ? " Save 10% vs monthly." : ""}
                    </Text>

                    <div style={{ marginTop: "auto", paddingTop: "12px" }}>
                      <Button
                        variant="primary"
                        fullWidth
                        size="large"
                        onClick={() => handleSelectPlan(plan.key)}
                        loading={isSubmitting && selectedPlan === plan.key}
                        disabled={isSubmitting}
                      >
                        Start 7-day trial
                      </Button>
                    </div>
                  </div>
                </Card>
              </div>
            );
          })}
        </div>

        {/* Enterprise — full-width strip below the main plan row */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center" wrap={false}>
              <BlockStack gap="100">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">Enterprise</Text>
                  <Badge tone="info">Custom</Badge>
                </InlineStack>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Custom try-on volume, pricing, and rollout support. For brands that need higher included usage, procurement support, or manual account setup.
                </Text>
              </BlockStack>
              <Box minWidth="220px">
                <Button fullWidth url="mailto:andrew@ello.services?subject=Ello%20Enterprise%20plan">
                  Contact for Enterprise
                </Button>
              </Box>
            </InlineStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
