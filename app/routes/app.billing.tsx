import { useEffect, useState } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useNavigate } from "react-router";
import {
  Page,
  Layout,
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

        {/* Free plan card */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Ello Free</Text>
              <Badge tone="info">Free</Badge>
            </InlineStack>
            <Text as="p" variant="headingXl">
              $0<Text as="span" variant="bodySm" tone="subdued"> /month</Text>
            </Text>
            <Text as="p" variant="bodyMd">10 try-ons per month · Ello branding on widget</Text>
            <Text as="p" variant="bodySm" tone="subdued">
              No overages. Upgrade anytime when you are ready for real traffic.
            </Text>
            <Box paddingBlockStart="200">
              <Button
                fullWidth
                onClick={() => handleSelectPlan("ello_free")}
                loading={isSubmitting && selectedPlan === "ello_free"}
                disabled={isSubmitting}
              >
                Use Free Plan
              </Button>
            </Box>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Conversion leverage calculator</Text>
            <InlineStack gap="300" blockAlign="end">
              <BlockStack gap="100">
                <label htmlFor="average-order-value">Average order value</label>
                <input
                  id="average-order-value"
                  type="number"
                  min="1"
                  step="1"
                  value={averageOrderValue}
                  onChange={(event) => setAverageOrderValue(Number(event.currentTarget.value))}
                  style={{
                    width: "120px",
                    minHeight: "36px",
                    padding: "6px 10px",
                    border: "1px solid #B8BECA",
                    borderRadius: "6px",
                  }}
                />
              </BlockStack>
              <Text as="p" variant="bodyMd" tone="subdued">
                At {formatMoney(averageOrderValue || AOV_DEFAULT)} AOV, each plan only needs a few added purchases to cover itself.
              </Text>
            </InlineStack>
          </BlockStack>
        </Card>

        {/* Plan grid */}
        <Layout>
          {PRICING_PLANS.map((plan) => {
            const monthlyBreakEven = breakEvenOrders(plan.monthlyPrice, averageOrderValue);
            const activePrice = interval === "monthly" ? plan.monthlyPrice : plan.annualPrice;
            return (
            <Layout.Section key={plan.key} variant="oneHalf">
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Ello {plan.displayName}
                    </Text>
                    {plan.featured && (
                      <Badge tone="success">Best first plan</Badge>
                    )}
                  </InlineStack>

                  <Text as="p" variant="headingXl">
                    {formatMoney(activePrice)}
                    <Text as="span" variant="bodySm" tone="subdued">
                      {interval === "monthly" ? " /month" : " /year"}
                    </Text>
                  </Text>

                  <Badge tone="info">7-day free trial</Badge>

                  <Text as="p" variant="bodyMd">
                    {plan.includedTryons.toLocaleString()} try-ons included per month
                  </Text>

                  <Text as="p" variant="bodySm" tone="subdued">
                    {plan.positioning} · ${OVERAGE_USD_PER_TRYON.toFixed(2)} per additional try-on
                  </Text>

                  <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                    <BlockStack gap="100">
                      <Text as="p" variant="bodyMd" fontWeight="semibold">
                        Needs {monthlyBreakEven ?? "-"} added {monthlyBreakEven === 1 ? "purchase" : "purchases"} to cover the monthly cost
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {formatMoney(plan.monthlyPrice)} / {formatMoney(averageOrderValue || AOV_DEFAULT)} AOV = break-even target
                      </Text>
                    </BlockStack>
                  </Box>

                  {interval === "annual" && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Annual billing saves 10% versus paying monthly.
                    </Text>
                  )}

                  <Text as="p" variant="bodySm" tone="subdued">
                    Billed {billingIntervalLabel}. Usage resets monthly.
                  </Text>

                  <Box paddingBlockStart="200">
                    <Button
                      variant="primary"
                      fullWidth
                      onClick={() => handleSelectPlan(plan.key)}
                      loading={isSubmitting && selectedPlan === plan.key}
                      disabled={isSubmitting}
                    >
                      Start 7-day trial
                    </Button>
                  </Box>
                </BlockStack>
              </Card>
            </Layout.Section>
            );
          })}
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">Enterprise</Text>
                  <Badge tone="info">Custom</Badge>
                </InlineStack>
                <Text as="p" variant="headingXl">Custom</Text>
                <Text as="p" variant="bodyMd">Custom try-on volume, pricing, and rollout support.</Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  For brands that need higher included usage, procurement support, or manual account setup.
                </Text>
                <Box paddingBlockStart="200">
                  <Button fullWidth url="mailto:andrew@ello.services?subject=Ello%20Enterprise%20plan">
                    Contact for Enterprise
                  </Button>
                </Box>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
