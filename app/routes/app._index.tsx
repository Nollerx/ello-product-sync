import { useEffect, useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  Box,
  List,
  InlineStack,
  Banner,
  Badge,
  Link,
  TextField,
  ProgressBar,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../lib/supabase.server";
import { getPlanConfig } from "../lib/shopify-billing.server";

const ACTIVATION_REFRESH_STORAGE_KEY = "ello.billing.activationRefreshCount";
const MAX_ACTIVATION_REFRESH_ATTEMPTS = 5;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const apiKey = process.env.SHOPIFY_API_KEY;

  // Step 1: Store data
  const { data: storeData } = await supabaseAdmin
    .from("vto_stores")
    .select("store_slug, account_id, widget_enabled, storefront_token")
    .eq("shop_domain", session.shop)
    .maybeSingle();

  const accountId = storeData?.account_id ?? null;

  // Step 2: Parallel — owner email + active subscription
  const [accountResult, subResult] = await Promise.all([
    accountId
      ? supabaseAdmin.from("vto_accounts").select("owner_email").eq("id", accountId).maybeSingle()
      : Promise.resolve({ data: null }),
    accountId
      ? supabaseAdmin
          .from("vto_subscriptions")
          .select("id, plan_id, billing_interval, shopify_subscription_id")
          .eq("account_id", accountId)
          .eq("status", "active")
          .order("shopify_subscription_id", { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sub = (subResult as any).data as { id: string; plan_id: string; billing_interval: string } | null;

  // Step 3: Current usage period (sequential — depends on subscription id)
  let usagePeriod: { tryons_used: number; period_end: string } | null = null;
  if (sub) {
    const now = new Date().toISOString();
    const { data } = await supabaseAdmin
      .from("vto_usage_periods")
      .select("tryons_used, period_end")
      .eq("subscription_id", sub.id)
      .lte("period_start", now)
      .gte("period_end", now)
      .maybeSingle();
    usagePeriod = data;
  }

  // Resolve plan display name and included_tryons from PLAN_CONFIG
  const planConfig = getPlanConfig();
  let planDisplayName: string | null = null;
  let planKey: string | null = null;
  let includedTryons: number | null = null;
  if (sub?.plan_id) {
    const entry = Object.entries(planConfig).find(([, meta]) => meta.planId === sub.plan_id);
    if (entry) {
      planKey = entry[0];
      planDisplayName = entry[1].displayName;
      includedTryons = entry[1].includedTryons;
    }
  }

  const skipBilling = process.env.SKIP_BILLING === "true";
  const billingActivationPending = url.searchParams.get("billing") === "activating";
  const pendingPlanKey = url.searchParams.get("plan");
  const pendingPlanDisplayName = pendingPlanKey
    ? planConfig[pendingPlanKey]?.displayName ?? null
    : null;

  return {
    shop: session.shop,
    apiKey,
    storeSlug: storeData?.store_slug ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ownerEmail: (accountResult as any).data?.owner_email ?? null,
    widgetEnabled: storeData?.widget_enabled ?? false,
    storeConnected: !!(storeData?.storefront_token),
    hasPlan: !!planDisplayName,
    planDisplayName,
    planKey,
    includedTryons,
    tryonsUsed: usagePeriod?.tryons_used ?? 0,
    periodEnd: usagePeriod?.period_end ?? null,
    skipBilling,
    billingActivationPending,
    pendingPlanDisplayName,
  };
};

export const action = async ({ request }: LoaderFunctionArgs) => {
  return null;
};

export default function Index() {
  const navigate = useNavigate();
  const {
    shop, apiKey, storeSlug, ownerEmail,
    widgetEnabled, storeConnected, hasPlan,
    planDisplayName, planKey, includedTryons, tryonsUsed, periodEnd,
    skipBilling, billingActivationPending, pendingPlanDisplayName,
  } = useLoaderData<typeof loader>();

  const syncFetcher = useFetcher();
  const [hasAutoSynced, setHasAutoSynced] = useState(false);
  const [activationRefreshCount, setActivationRefreshCount] = useState(0);

  useEffect(() => {
    if (syncFetcher.state === "idle" && !syncFetcher.data && !hasAutoSynced) {
      syncFetcher.submit(null, { method: "POST", action: "/api/sync-token" });
      setHasAutoSynced(true);
    }
  }, [syncFetcher.state, hasAutoSynced, syncFetcher.data]);

  const openThemeEditor = () => {
    const storeHandle = shop.replace(".myshopify.com", "");
    const deepLink = `https://admin.shopify.com/store/${storeHandle}/themes/current/editor?context=apps&app_id=${apiKey}`;
    window.open(deepLink, "_blank");
  };

  const handleRetrySync = () => {
    syncFetcher.submit(null, { method: "POST", action: "/api/sync-token" });
  };

  const handleRefreshActivationStatus = () => {
    window.sessionStorage.removeItem(ACTIVATION_REFRESH_STORAGE_KEY);
    setActivationRefreshCount(0);
    window.location.reload();
  };

  const isLoading = syncFetcher.state === "submitting" || syncFetcher.state === "loading";

  // Usage calculations
  const isDeveloperPlan = planKey === "developer_free" || (includedTryons ?? 0) >= 9999;
  const isFreePlan = planKey === "ello_free";
  const showExternalBillingPlaceholder =
    skipBilling && (!planKey || planKey === "developer_free" || planKey === "custom_distribution");
  const currentPlanBadgeLabel = showExternalBillingPlaceholder
    ? "Billed through Stripe"
    : (planDisplayName ?? "");
  const usagePercent =
    isDeveloperPlan || !includedTryons
      ? 0
      : Math.min(100, Math.round((tryonsUsed / includedTryons) * 100));
  const isNearLimit = !isDeveloperPlan && !showExternalBillingPlaceholder && !!includedTryons && usagePercent >= 80;
  const periodEndFormatted = periodEnd
    ? new Date(periodEnd).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : null;

  // Onboarding checklist: show until all 3 steps complete
  // When skipBilling is true, treat plan as always present (custom distribution)
  const effectiveHasPlan = hasPlan || skipBilling;
  const showBillingActivationPending = billingActivationPending && !hasPlan && !skipBilling;
  const allOnboarded = effectiveHasPlan && storeConnected && widgetEnabled;
  const activationRefreshLimitReached =
    showBillingActivationPending && activationRefreshCount >= MAX_ACTIVATION_REFRESH_ATTEMPTS;
  const pendingPlanLabel = pendingPlanDisplayName ? `${pendingPlanDisplayName} plan` : "your plan";

  useEffect(() => {
    if (!showBillingActivationPending) {
      window.sessionStorage.removeItem(ACTIVATION_REFRESH_STORAGE_KEY);
      setActivationRefreshCount(0);
      return undefined;
    }

    const storedValue = Number.parseInt(
      window.sessionStorage.getItem(ACTIVATION_REFRESH_STORAGE_KEY) ?? "0",
      10,
    );
    const refreshCount = Number.isFinite(storedValue) && storedValue >= 0 ? storedValue : 0;
    setActivationRefreshCount(refreshCount);

    if (refreshCount >= MAX_ACTIVATION_REFRESH_ATTEMPTS) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      window.sessionStorage.setItem(
        ACTIVATION_REFRESH_STORAGE_KEY,
        String(refreshCount + 1),
      );
      window.location.reload();
    }, 3000);

    return () => window.clearTimeout(timeoutId);
  }, [showBillingActivationPending]);

  // Status banner for sync card
  let statusBanner = <Banner tone="info">Checking connection status...</Banner>;
  if (isLoading) {
    statusBanner = <Banner tone="info">Syncing credentials...</Banner>;
  } else if (syncFetcher.data) {
    const result = syncFetcher.data as { success: boolean; message?: string; error?: string; retryable?: boolean; requestId?: string };
    if (result.success) {
      statusBanner = <Banner tone="success">Store Connected Successfully</Banner>;
    } else {
      const isRetryable = result.retryable !== false;
      statusBanner = (
        <Banner tone="critical" title={isRetryable ? "Connection Failed (Retrying...)" : "Connection Failed"}>
          <p>{result.message || result.error}</p>
          <div style={{ marginTop: "8px" }}>
            {isRetryable && (
              <Button onClick={handleRetrySync} variant="plain" tone="critical">Try Again</Button>
            )}
          </div>
          {result.requestId && (
            <p style={{ marginTop: "0.5rem", fontSize: "11px", opacity: 0.8 }}>Ref: {result.requestId}</p>
          )}
        </Banner>
      );
    }
  }

  return (
    <Page title="Ello Virtual Try-On">
      <BlockStack gap="500">

        {showBillingActivationPending && (
          <Banner title="Plan activation in progress" tone="info">
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">
                Your Shopify subscription for {pendingPlanLabel} was approved. We&apos;re finishing activation now.
              </Text>
              <Text as="p" variant="bodyMd">
                {activationRefreshLimitReached
                  ? "Activation is taking longer than usual. Keep checking here without going back through billing."
                  : "This page refreshes automatically while we wait for Shopify to report the active subscription."}
              </Text>
              {activationRefreshLimitReached && (
                <Box>
                  <Button onClick={handleRefreshActivationStatus} variant="plain">Refresh status</Button>
                </Box>
              )}
            </BlockStack>
          </Banner>
        )}

        {/* ── Onboarding checklist (hidden once all 3 done) ── */}
        {!allOnboarded && (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Getting Started</Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Complete these steps to go live with virtual try-on.
              </Text>
              <BlockStack gap="300">
                {!skipBilling && (
                  <InlineStack align="space-between" blockAlign="center">
                    <InlineStack gap="300" blockAlign="center">
                      <Badge tone={hasPlan ? "success" : showBillingActivationPending ? "info" : "attention"}>
                        {hasPlan ? "✓" : showBillingActivationPending ? "…" : "1"}
                      </Badge>
                      <Text as="span" variant="bodyMd"
                        tone={hasPlan ? "subdued" : showBillingActivationPending ? "subdued" : undefined}
                      >
                        {showBillingActivationPending ? "Plan activation in progress" : "Choose a plan"}
                      </Text>
                    </InlineStack>
                    {!hasPlan && !showBillingActivationPending && (
                      <Button onClick={() => navigate("/app/billing")} size="slim" variant="primary">Choose Plan</Button>
                    )}
                  </InlineStack>
                )}

                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="300" blockAlign="center">
                    <Badge tone={storeConnected ? "success" : "attention"}>{storeConnected ? "✓" : "2"}</Badge>
                    <Text as="span" variant="bodyMd" tone={storeConnected ? "subdued" : undefined}>
                      Connect your store
                    </Text>
                  </InlineStack>
                  {!storeConnected && (
                    <Button onClick={handleRetrySync} size="slim" loading={isLoading}>Reconnect</Button>
                  )}
                </InlineStack>

                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="300" blockAlign="center">
                    <Badge tone={widgetEnabled ? "success" : "attention"}>{widgetEnabled ? "✓" : "3"}</Badge>
                    <Text as="span" variant="bodyMd" tone={widgetEnabled ? "subdued" : undefined}>
                      Enable widget on storefront
                    </Text>
                  </InlineStack>
                  {!widgetEnabled && (
                    <Button onClick={openThemeEditor} size="slim">Enable Now</Button>
                  )}
                </InlineStack>
              </BlockStack>
            </BlockStack>
          </Card>
        )}

        {/* ── Free-plan upgrade CTA (always shown for ello_free) ── */}
        {isFreePlan && (
          <Banner tone="info" title="You're on the Free plan">
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">
                Upgrade to unlock unlimited try-ons and full analytics.
              </Text>
              <Box>
                <Button onClick={() => navigate("/app/billing")} variant="primary">Upgrade plan</Button>
              </Box>
            </BlockStack>
          </Banner>
        )}

        {/* ── Upgrade nudge at 80% (hidden for custom distribution) ── */}
        {isNearLimit && !skipBilling && (
          <Banner
            tone={isFreePlan ? "critical" : "warning"}
            title={isFreePlan ? "Monthly try-on limit almost reached" : "Approaching your try-on limit"}
          >
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">
                You&apos;ve used {tryonsUsed.toLocaleString()} of {includedTryons?.toLocaleString()} try-ons ({usagePercent}%).
                {isFreePlan
                  ? " Upgrade to keep try-ons running after you hit 10."
                  : " Upgrade now to avoid any interruptions."}
              </Text>
              <Box>
                <Button onClick={() => navigate("/app/billing")} variant="plain">View upgrade options</Button>
              </Box>
            </BlockStack>
          </Banner>
        )}

        <Layout>
          {/* ── Current Plan + Usage ── */}
          {effectiveHasPlan && (
            <Layout.Section variant="oneHalf">
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">Current Plan</Text>
                    <Badge tone={showExternalBillingPlaceholder || isDeveloperPlan ? "info" : "success"}>
                      {currentPlanBadgeLabel}
                    </Badge>
                  </InlineStack>

                  {showExternalBillingPlaceholder ? (
                    <BlockStack gap="200">
                      <Text as="p" variant="bodyMd" tone="subdued">
                        Billing for this store is handled outside Shopify.
                      </Text>
                      <Text as="p" variant="bodyMd" tone="subdued">
                        Once we assign your contracted plan in Ello, it will appear here automatically.
                      </Text>
                    </BlockStack>
                  ) : isDeveloperPlan ? (
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Unlimited try-ons — developer / testing plan
                    </Text>
                  ) : (
                    <BlockStack gap="200">
                      <InlineStack align="space-between">
                        <Text as="p" variant="bodySm" tone="subdued">Try-ons this period</Text>
                        <Text as="p" variant="bodySm">
                          {tryonsUsed.toLocaleString()} / {includedTryons?.toLocaleString()}
                          {periodEndFormatted && (
                            <Text as="span" variant="bodySm" tone="subdued">
                              {" · resets "}{periodEndFormatted}
                            </Text>
                          )}
                        </Text>
                      </InlineStack>
                      <ProgressBar
                        progress={usagePercent}
                        tone={usagePercent >= 80 ? "critical" : "highlight"}
                      />
                      <Text as="p" variant="bodySm" tone="subdued">
                        {usagePercent}% used
                        {isFreePlan
                          ? " · Free plan — no overages, upgrade to continue after 10"
                          : !skipBilling && " · $0.15/try-on for overages"}
                      </Text>
                    </BlockStack>
                  )}

                  {!skipBilling && <Button onClick={() => navigate("/app/billing")} variant="plain">Change Plan</Button>}
                </BlockStack>
              </Card>
            </Layout.Section>
          )}

          {/* ── Ello Dashboard credentials ── */}
          {storeSlug && (
            <Layout.Section variant={effectiveHasPlan ? "oneHalf" : "fullWidth"}>
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Your Ello Dashboard</Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Use the credentials below to log into the Ello dashboard.
                  </Text>
                  <BlockStack gap="200">
                    <TextField
                      label="Store Slug"
                      value={storeSlug}
                      readOnly
                      autoComplete="off"
                    />
                    {ownerEmail && (
                      <TextField
                        label="Login Email"
                        value={ownerEmail}
                        readOnly
                        autoComplete="off"
                      />
                    )}
                  </BlockStack>
                  <Button
                    variant="primary"
                    url={`https://dashboard.ello.services/login?slug=${storeSlug}`}
                    target="_blank"
                  >
                    Open Ello Dashboard →
                  </Button>
                </BlockStack>
              </Card>
            </Layout.Section>
          )}

          {/* ── Widget Configuration ── */}
          <Layout.Section>
            <Card>
              <BlockStack gap="500">
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">Widget Configuration</Text>
                  <Text as="p" variant="bodyMd">
                    To enable the widget on your storefront, enable the App Embed in your theme editor.
                  </Text>
                </BlockStack>
                <InlineStack gap="300">
                  <Button variant="primary" onClick={openThemeEditor}>
                    Enable on Storefront
                  </Button>
                </InlineStack>
                <Box paddingBlockStart="200">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Clicking this will open your Theme Editor. Look for &quot;Ello Virtual Try-On&quot; in the App Embeds sidebar (left) and toggle it ON.
                  </Text>
                </Box>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* ── System Status ── */}
          <Layout.Section>
            <Card>
              <BlockStack gap="500">
                <BlockStack gap="200">
                  <InlineStack align="space-between">
                    <Text as="h2" variant="headingMd">System Status</Text>
                    {!isLoading && (syncFetcher.data as { success?: boolean })?.success && (
                      <Badge tone="success">Operational</Badge>
                    )}
                  </InlineStack>
                  <Text as="p" variant="bodyMd">Secure connection to Ello VTO Cloud.</Text>
                  <Box paddingBlockStart="200">{statusBanner}</Box>
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* ── Support ── */}
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Support</Text>
                <List>
                  <List.Item>
                    <Link url="https://dashboard.ello.services" target="_blank">Documentation</Link>
                  </List.Item>
                  <List.Item>
                    <Link url="mailto:support@ello.services" target="_blank">Contact Support</Link>
                  </List.Item>
                </List>
                <Box paddingBlockStart="400">
                  <Button variant="plain" onClick={handleRetrySync} loading={isLoading}>
                    Run Sync Test
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
