import { useEffect, useState } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useNavigate } from "react-router";
import {
  Page,
  Text,
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

  const BRAND = "#0F5132";
  const BRAND_TINT = "#F1F8F4";
  const BRAND_TINT_BORDER = "#CFE7D9";
  const BORDER = "#E3E5E7";
  const TEXT_SUBDUED = "#6B7177";

  const Check = () => (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" style={{ flexShrink: 0, marginTop: "1px" }}>
      <circle cx="10" cy="10" r="10" fill={BRAND_TINT} />
      <path d="M5.8 10.2l2.6 2.6 5.8-5.8" stroke={BRAND} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );

  const featureRow = (label: string) => (
    <div key={label} style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
      <Check />
      <span style={{ fontSize: "14px", color: "#3F4448", lineHeight: 1.4 }}>{label}</span>
    </div>
  );

  return (
    <Page
      fullWidth
      title="Choose Your Plan"
      subtitle="Start with a 7-day free trial. Cancel anytime."
    >
      <Box paddingBlockStart="200" paddingBlockEnd="800">
        <BlockStack gap="600">

          {/* Error banner */}
          {(billingError || actionError) && (
            <Banner title="Billing Error" tone="critical">
              <Text as="p" variant="bodyMd">{actionError || billingError}</Text>
            </Banner>
          )}

          {/* Interval toggle — segmented control */}
          <InlineStack align="center">
            <div
              style={{
                display: "inline-flex",
                padding: "4px",
                background: "#F1F2F3",
                borderRadius: "999px",
                border: `1px solid ${BORDER}`,
              }}
            >
              <button
                type="button"
                onClick={() => setInterval("monthly")}
                style={{
                  border: "none",
                  cursor: "pointer",
                  padding: "8px 22px",
                  borderRadius: "999px",
                  fontSize: "14px",
                  fontWeight: 600,
                  background: interval === "monthly" ? "#FFFFFF" : "transparent",
                  color: interval === "monthly" ? "#1A1C1D" : TEXT_SUBDUED,
                  boxShadow: interval === "monthly" ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
                  transition: "all 0.15s ease",
                }}
              >
                Monthly
              </button>
              <button
                type="button"
                onClick={() => setInterval("annual")}
                style={{
                  border: "none",
                  cursor: "pointer",
                  padding: "8px 22px",
                  borderRadius: "999px",
                  fontSize: "14px",
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "8px",
                  background: interval === "annual" ? "#FFFFFF" : "transparent",
                  color: interval === "annual" ? "#1A1C1D" : TEXT_SUBDUED,
                  boxShadow: interval === "annual" ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
                  transition: "all 0.15s ease",
                }}
              >
                Annual
                <span
                  style={{
                    fontSize: "12px",
                    fontWeight: 700,
                    color: BRAND,
                    background: BRAND_TINT,
                    padding: "2px 8px",
                    borderRadius: "999px",
                  }}
                >
                  Save 10%
                </span>
              </button>
            </div>
          </InlineStack>

          {/* AOV calculator strip — drives the break-even number on every card */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "20px",
              flexWrap: "wrap",
              padding: "20px 24px",
              background: "#FFFFFF",
              border: `1px solid ${BORDER}`,
              borderRadius: "14px",
              boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={{ fontSize: "13px", fontWeight: 600, color: TEXT_SUBDUED, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Your average order value
              </span>
              <div style={{ display: "inline-flex", alignItems: "center" }}>
                <span style={{ fontSize: "22px", fontWeight: 700, color: "#1A1C1D", marginRight: "2px" }}>$</span>
                <input
                  id="average-order-value"
                  type="number"
                  min="1"
                  step="1"
                  value={averageOrderValue}
                  onChange={(event) => setAverageOrderValue(Number(event.currentTarget.value))}
                  style={{
                    width: "96px",
                    fontSize: "22px",
                    fontWeight: 700,
                    color: "#1A1C1D",
                    padding: "6px 10px",
                    border: `1px solid ${BORDER}`,
                    borderRadius: "8px",
                    outline: "none",
                  }}
                />
              </div>
            </div>
            <div style={{ flex: 1, minWidth: "220px", fontSize: "14px", color: TEXT_SUBDUED, lineHeight: 1.5 }}>
              Change this to see exactly how many sales each plan needs to pay for itself.
            </div>
          </div>

          {/* Plan grid — single row of 4, featured plan elevated */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
              gap: "20px",
              alignItems: "stretch",
              paddingTop: "20px",
            }}
          >
            {PRICING_PLANS.map((plan) => {
              const monthlyBreakEven = breakEvenOrders(plan.monthlyPrice, averageOrderValue);
              const activePrice = interval === "monthly" ? plan.monthlyPrice : plan.annualPrice;
              return (
                <div
                  key={plan.key}
                  style={{
                    position: "relative",
                    transform: plan.featured ? "translateY(-14px)" : "none",
                    display: "flex",
                    flexDirection: "column",
                    height: "100%",
                    borderRadius: "16px",
                    border: plan.featured ? `2px solid ${BRAND}` : `1px solid ${BORDER}`,
                    boxShadow: plan.featured
                      ? "0 18px 40px rgba(15, 81, 50, 0.16)"
                      : "0 1px 2px rgba(0,0,0,0.05)",
                    background: "#FFFFFF",
                    padding: plan.featured ? "32px 26px 26px" : "26px",
                  }}
                >
                  {plan.featured && (
                    <div
                      style={{
                        position: "absolute",
                        top: "-13px",
                        left: "50%",
                        transform: "translateX(-50%)",
                        background: BRAND,
                        color: "#FFFFFF",
                        fontSize: "12px",
                        fontWeight: 700,
                        letterSpacing: "0.03em",
                        textTransform: "uppercase",
                        padding: "5px 14px",
                        borderRadius: "999px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Best first plan
                    </div>
                  )}

                  <div style={{ display: "flex", flexDirection: "column", gap: "18px", height: "100%" }}>
                    {/* Name + price */}
                    <div>
                      <div style={{ fontSize: "15px", fontWeight: 600, color: TEXT_SUBDUED, marginBottom: "8px" }}>
                        Ello {plan.displayName}
                      </div>
                      <div style={{ display: "flex", alignItems: "baseline", gap: "6px" }}>
                        <span style={{ fontSize: "40px", fontWeight: 800, color: "#1A1C1D", lineHeight: 1, letterSpacing: "-0.02em" }}>
                          {formatMoney(activePrice)}
                        </span>
                        <span style={{ fontSize: "15px", color: TEXT_SUBDUED, fontWeight: 500 }}>
                          {interval === "monthly" ? "/mo" : "/yr"}
                        </span>
                      </div>
                      <div style={{ fontSize: "13px", color: TEXT_SUBDUED, marginTop: "6px", minHeight: "18px" }}>
                        {plan.positioning}
                        {interval === "annual" ? " · Save 10% vs monthly" : ""}
                      </div>
                    </div>

                    {/* CTA — moved up under price for stronger conversion */}
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

                    {/* Break-even callout */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "14px",
                        padding: "14px 16px",
                        background: BRAND_TINT,
                        border: `1px solid ${BRAND_TINT_BORDER}`,
                        borderRadius: "12px",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "40px",
                          fontWeight: 800,
                          lineHeight: 1,
                          color: BRAND,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {monthlyBreakEven ?? "—"}
                      </span>
                      <span style={{ fontSize: "13px", color: "#2C3A33", fontWeight: 600, lineHeight: 1.35 }}>
                        {monthlyBreakEven === 1 ? "sale from try-on" : "sales from try-on"} pays for the month
                      </span>
                    </div>

                    {/* Feature list */}
                    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                      {featureRow(`${plan.includedTryons.toLocaleString()} try-ons every month`)}
                      {featureRow("No Ello branding on widget")}
                      {featureRow(`$${OVERAGE_USD_PER_TRYON.toFixed(2)} per try-on after that`)}
                      {featureRow("7-day free trial · cancel anytime")}
                    </div>

                    <div
                      style={{
                        marginTop: "auto",
                        paddingTop: "8px",
                        fontSize: "12px",
                        color: TEXT_SUBDUED,
                      }}
                    >
                      Billed {billingIntervalLabel}. Usage resets monthly.
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Free + Enterprise — secondary options as twin strips */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: "20px",
              paddingTop: "8px",
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "14px",
                padding: "24px",
                background: "#FFFFFF",
                border: `1px solid ${BORDER}`,
                borderRadius: "14px",
                boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
              }}
            >
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">Ello Free</Text>
                <Badge tone="info">Free</Badge>
              </InlineStack>
              <div style={{ flex: 1, fontSize: "14px", color: TEXT_SUBDUED, lineHeight: 1.5 }}>
                $0/month · 10 try-ons per month · Ello branding on widget. No overages — upgrade anytime when you are ready for real traffic.
              </div>
              <Button
                onClick={() => handleSelectPlan("ello_free")}
                loading={isSubmitting && selectedPlan === "ello_free"}
                disabled={isSubmitting}
              >
                Use Free Plan
              </Button>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "14px",
                padding: "24px",
                background: "#FFFFFF",
                border: `1px solid ${BORDER}`,
                borderRadius: "14px",
                boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
              }}
            >
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">Enterprise</Text>
                <Badge tone="info">Custom</Badge>
              </InlineStack>
              <div style={{ flex: 1, fontSize: "14px", color: TEXT_SUBDUED, lineHeight: 1.5 }}>
                Custom try-on volume, pricing, and rollout support. For brands that need higher included usage, procurement support, or manual account setup.
              </div>
              <Button url="mailto:andrew@ello.services?subject=Ello%20Enterprise%20plan">
                Contact for Enterprise
              </Button>
            </div>
          </div>
        </BlockStack>
      </Box>
    </Page>
  );
}
