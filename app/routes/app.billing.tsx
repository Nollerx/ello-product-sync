import { useEffect, useState } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
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

// ─── Plan display data ────────────────────────────────────────────────────────

type PlanDisplay = {
  key: string;
  name: string;
  monthlyPrice: string;
  annualPrice: string;
  tryons: number | string;
  popular?: boolean;
};

const PLANS: PlanDisplay[] = [
  { key: "starter",         name: "Ello Starter",      monthlyPrice: "$97",      annualPrice: "$1,047.60",  tryons: 150 },
  { key: "launch",          name: "Ello Launch",       monthlyPrice: "$149",     annualPrice: "$1,609.20",  tryons: 400 },
  { key: "growth",          name: "Ello Growth",       monthlyPrice: "$172",     annualPrice: "$1,857.60",  tryons: 750,   popular: true },
  { key: "growth_plus",     name: "Ello Growth+",      monthlyPrice: "$289",     annualPrice: "$3,121.20",  tryons: 1800 },
  { key: "pro",             name: "Ello Pro",           monthlyPrice: "$647",     annualPrice: "$6,987.60",  tryons: 4000 },
  { key: "pro_plus",        name: "Pro Plus",           monthlyPrice: "$1,149",   annualPrice: "$12,409.20", tryons: 9000 },
  { key: "enterprise",      name: "Ello Enterprise",   monthlyPrice: "$1,897",   annualPrice: "$20,487.60", tryons: 13000 },
  { key: "enterprise_plus", name: "Ello Enterprise+",  monthlyPrice: "$5,197",   annualPrice: "$56,127.20", tryons: 25000 },
];

// ─── Billing config lookup (mirrors shopify.server.ts) ───────────────────────

type BillingLineItem = {
  amount: number;
  currencyCode: string;
  interval: "EVERY_30_DAYS" | "ANNUAL";
  terms?: string;
};

function getBillingPlan(planKey: string, isTest: boolean): { lineItems: BillingLineItem[]; test: boolean } | null {
  // Build from the plan config in shopify.server.ts billing section
  const configs: Record<string, { amount: number; interval: "EVERY_30_DAYS" | "ANNUAL" }> = {
    starter_monthly:         { amount: 97,        interval: "EVERY_30_DAYS" },
    starter_annual:          { amount: 1047.60,   interval: "ANNUAL" },
    launch_monthly:          { amount: 149,       interval: "EVERY_30_DAYS" },
    launch_annual:           { amount: 1609.20,   interval: "ANNUAL" },
    growth_monthly:          { amount: 172,       interval: "EVERY_30_DAYS" },
    growth_annual:           { amount: 1857.60,   interval: "ANNUAL" },
    growth_plus_monthly:     { amount: 289,       interval: "EVERY_30_DAYS" },
    growth_plus_annual:      { amount: 3121.20,   interval: "ANNUAL" },
    pro_monthly:             { amount: 647,       interval: "EVERY_30_DAYS" },
    pro_annual:              { amount: 6987.60,   interval: "ANNUAL" },
    pro_plus_monthly:        { amount: 1149,      interval: "EVERY_30_DAYS" },
    pro_plus_annual:         { amount: 12409.20,  interval: "ANNUAL" },
    enterprise_monthly:      { amount: 1897,      interval: "EVERY_30_DAYS" },
    enterprise_annual:       { amount: 20487.60,  interval: "ANNUAL" },
    enterprise_plus_monthly: { amount: 5197,      interval: "EVERY_30_DAYS" },
    enterprise_plus_annual:  { amount: 56127.60,  interval: "ANNUAL" },
  };
  const cfg = configs[planKey];
  if (!cfg) return null;
  return {
    test: isTest,
    lineItems: [
      { amount: cfg.amount, currencyCode: "USD", interval: cfg.interval },
      { amount: 15, currencyCode: "USD", interval: "EVERY_30_DAYS", terms: "$0.15 per try-on beyond your plan's included amount" },
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
  const requestUrl = new URL(request.url);
  const formData = await request.formData();
  const planKey = formData.get("planKey") as string;
  const interval = formData.get("interval") as string;

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

  // Return to our own confirmation route and preserve the embedded-app context
  // so Shopify can hand the merchant back to the exact post-approval screen.
  const appBaseUrl = process.env.SHOPIFY_APP_URL || requestUrl.origin;
  const returnUrl = new URL("/app/billing/confirm", appBaseUrl);
  returnUrl.searchParams.set("shop", session.shop);
  for (const key of ["shop", "host", "embedded"]) {
    const value = requestUrl.searchParams.get(key);
    if (value) returnUrl.searchParams.set(key, value);
  }
  if (!returnUrl.searchParams.has("embedded")) {
    returnUrl.searchParams.set("embedded", "1");
  }
  returnUrl.searchParams.set("plan", fullPlanKey);

  // Build the GraphQL mutation
  const recurringItem = billingPlan.lineItems[0];
  const usageItem = billingPlan.lineItems[1];

  const mutation = `#graphql
    mutation AppSubscriptionCreate(
      $name: String!,
      $returnUrl: URL!,
      $test: Boolean,
      $lineItems: [AppSubscriptionLineItemInput!]!,
      $replacementBehavior: AppSubscriptionReplacementBehavior
    ) {
      appSubscriptionCreate(
        name: $name,
        returnUrl: $returnUrl,
        test: $test,
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
  const [interval, setInterval] = useState<"monthly" | "annual">("monthly");
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);

  // When the action returns a confirmationUrl, redirect the TOP frame to it.
  // This is the correct way to handle billing redirects in embedded Shopify apps —
  // the Shopify billing page must load at the top level, not in the iframe.
  const actionData = fetcher.data as { confirmationUrl?: string; error?: string } | undefined;
  useEffect(() => {
    if (!actionData?.confirmationUrl) return;
    window.open(actionData.confirmationUrl, "_top");
  }, [actionData?.confirmationUrl]);

  const actionError = actionData?.error;
  const isSubmitting = fetcher.state === "submitting" || fetcher.state === "loading";

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
      subtitle="Start growing with virtual try-on. Cancel anytime."
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

        {/* Plan grid */}
        <Layout>
          {PLANS.map((plan) => (
            <Layout.Section key={plan.key} variant="oneHalf">
              <Card>
                <BlockStack gap="300">
                  {plan.popular && (
                    <Badge tone="success">Most Popular</Badge>
                  )}

                  <Text as="h2" variant="headingMd">
                    {plan.name}
                  </Text>

                  <Text as="p" variant="headingXl">
                    {interval === "monthly" ? plan.monthlyPrice : plan.annualPrice}
                    <Text as="span" variant="bodySm" tone="subdued">
                      {interval === "monthly" ? " /month" : " /year"}
                    </Text>
                  </Text>

                  <Text as="p" variant="bodyMd">
                    {typeof plan.tryons === "number"
                      ? `${plan.tryons.toLocaleString()} try-ons included per month`
                      : plan.tryons}
                  </Text>

                  <Text as="p" variant="bodySm" tone="subdued">
                    $0.15 per additional try-on
                  </Text>

                  <Box paddingBlockStart="200">
                    <Button
                      variant="primary"
                      fullWidth
                      onClick={() => handleSelectPlan(plan.key)}
                      loading={isSubmitting && selectedPlan === plan.key}
                      disabled={isSubmitting}
                    >
                      Select Plan
                    </Button>
                  </Box>
                </BlockStack>
              </Card>
            </Layout.Section>
          ))}
        </Layout>
      </BlockStack>
    </Page>
  );
}
