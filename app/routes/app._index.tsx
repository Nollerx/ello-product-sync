import { useEffect, useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useRevalidator } from "react-router";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  Box,
  InlineStack,
  InlineGrid,
  Banner,
  Badge,
  Link,
  ProgressBar,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../lib/supabase.server";
import { getThemeWidgetStatus, persistThemeStatus } from "../lib/theme-status.server";
import { getAppEmbedEditorUrl, getInlineTryOnBlockEditorUrl } from "../lib/onboarding.server";
import { InlineButtonPlacementHelp } from "../components/inline-placement-help";
import { getPlanConfig } from "../lib/shopify-billing.server";
import { resolveStorefront } from "../lib/storefront-names.server";
import { brand } from "../components/ui";
import { FunnelBar, KpiTile, TimeRangeSelector } from "../components/analytics";
import { parseRange, pctDelta, rangeWindow, RANGE_DAYS } from "../lib/timerange";
import {
  buildSessions,
  fetchCoreEvents,
  getConversionSummary,
  getPrevCounts,
  recentSessions,
  type RecentSession,
} from "../lib/analytics.server";

const ACTIVATION_REFRESH_STORAGE_KEY = "ello.billing.activationRefreshCount";
const MAX_ACTIVATION_REFRESH_ATTEMPTS = 5;

// Where the "Rate Ello" card sends happy merchants. TODO(andrew): confirm the
// real App Store listing handle — this opens the review modal on the listing.
const REVIEW_URL = "https://apps.shopify.com/ello-virtual-try-on#modal-show=ReviewListingModal";
const SUPPORT_EMAIL = "support@ello.services";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const apiKey = process.env.SHOPIFY_API_KEY;

  // Read the LIVE published theme to learn whether our placements are actually
  // on (source of truth — the old `widget_enabled` flag never reflected this).
  // Kicked off here so it runs in parallel with the metrics queries below.
  const themeStatusPromise = getThemeWidgetStatus(admin);

  // Step 1: Store data
  const { data: storeData } = await supabaseAdmin
    .from("vto_stores")
    .select("store_slug, account_id, widget_enabled, storefront_token, shop_domain")
    .eq("shop_domain", session.shop)
    .maybeSingle();

  const accountId = storeData?.account_id ?? null;

  // Step 2: Active subscription
  const subResult = accountId
    ? await supabaseAdmin
        .from("vto_subscriptions")
        .select("id, plan_id, billing_interval, shopify_subscription_id")
        .eq("account_id", accountId)
        .eq("status", "active")
        .order("shopify_subscription_id", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle()
    : { data: null };

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

  // Step 4: Dashboard metrics over the selected range (?range=7d|30d|90d),
  // with deltas vs the previous window. Graceful — failures just show zeros.
  const range = parseRange(url.searchParams.get("range"));
  const win = rangeWindow(range);

  let attributedRevenue = 0;
  let purchaseConversionPct: number | null = null;
  let cartConversionPct: number | null = null;
  let totalTryons = 0;
  let totalCartAdds = 0;
  let widgetOpens = 0;
  let revenueDelta: number | null = null;
  let tryonsDelta: number | null = null;
  let cartsDelta: number | null = null;
  let recent: RecentSession[] = [];
  let recentProductNames: Record<string, string> = {};
  let currencyCode = "USD";
  const slug = storeData?.store_slug ?? null;
  if (slug) {
    // Recent sessions always look at the last 7 days so the table stays fresh
    // and the Home loader stays light even on the 90-day range.
    const recentWin = rangeWindow("7d");
    const [summary, counts, prevCounts, recentCore] = await Promise.all([
      getConversionSummary(slug, win.from, win.to),
      getPrevCounts(slug, win.from, win.to),
      getPrevCounts(slug, win.prevFrom, win.prevTo),
      fetchCoreEvents(slug, recentWin.from, recentWin.to),
    ]);
    attributedRevenue = summary?.revenue ?? 0;
    purchaseConversionPct = summary?.purchaseConversionPct ?? null;
    cartConversionPct =
      summary && summary.tryonSessions > 0
        ? Math.round((summary.addedToCart / summary.tryonSessions) * 100)
        : null;
    totalTryons = counts.tryons;
    totalCartAdds = counts.carts;
    widgetOpens = counts.opens;
    revenueDelta = pctDelta(attributedRevenue, prevCounts.revenue);
    tryonsDelta = pctDelta(counts.tryons, prevCounts.tryons);
    cartsDelta = pctDelta(counts.carts, prevCounts.carts);
    recent = recentSessions(buildSessions(recentCore), 8);

    const recentIds = Array.from(new Set(recent.flatMap((s) => s.products)));
    const idToGid = (raw: string): string => (raw.startsWith("gid://") ? raw : `gid://shopify/Product/${raw}`);
    const meta = await resolveStorefront(
      storeData?.shop_domain ?? null,
      storeData?.storefront_token ?? null,
      recentIds.map(idToGid),
    );
    currencyCode = meta.currencyCode;
    recentProductNames = Object.fromEntries(
      recentIds.map((id) => [id, meta.titles.get(idToGid(id)) ?? id]),
    );
  }

  // Resolve the live theme read (kicked off at the top) and cache it so other
  // surfaces can show last-known state without their own theme call.
  const themeStatus = await themeStatusPromise;
  persistThemeStatus(session.shop, themeStatus).catch((e) =>
    console.warn("[Dashboard] theme status cache write failed:", e),
  );

  const skipBilling = process.env.SKIP_BILLING === "true";
  const billingActivationPending = url.searchParams.get("billing") === "activating";
  const pendingPlanKey = url.searchParams.get("plan");
  const pendingPlanDisplayName = pendingPlanKey
    ? planConfig[pendingPlanKey]?.displayName ?? null
    : null;

  return {
    shop: session.shop,
    apiKey,
    storeSlug: slug,
    // Live theme-derived status (source of truth) — see theme-status.server.ts.
    themeStatusOk: themeStatus.ok,
    themeStatusReason: themeStatus.reason,
    appEmbedEnabled: themeStatus.appEmbedEnabled,
    appEmbedPresentButDisabled: themeStatus.appEmbedPresentButDisabled,
    inlineButtonAdded: themeStatus.inlineButtonAdded,
    appEmbedDeepLink: getAppEmbedEditorUrl(session.shop),
    inlineButtonDeepLink: getInlineTryOnBlockEditorUrl(session.shop),
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
    range,
    attributedRevenue,
    purchaseConversionPct,
    cartConversionPct,
    totalTryons,
    totalCartAdds,
    widgetOpens,
    revenueDelta,
    tryonsDelta,
    cartsDelta,
    recent,
    recentProductNames,
    currencyCode,
  };
};

export const action = async () => {
  return null;
};

export default function Index() {
  const navigate = useNavigate();
  const {
    themeStatusOk, themeStatusReason,
    appEmbedEnabled, appEmbedPresentButDisabled, inlineButtonAdded,
    appEmbedDeepLink, inlineButtonDeepLink,
    storeConnected, hasPlan,
    planDisplayName, planKey, includedTryons, tryonsUsed, periodEnd,
    skipBilling, billingActivationPending, pendingPlanDisplayName,
    range, attributedRevenue, purchaseConversionPct, cartConversionPct,
    totalTryons, totalCartAdds, widgetOpens,
    revenueDelta, tryonsDelta, cartsDelta,
    recent, recentProductNames, currencyCode,
  } = useLoaderData<typeof loader>();

  // Derived live-status booleans. null = couldn't read the theme (e.g. the
  // read_themes scope isn't granted yet, or a vintage .liquid product template).
  const appEmbedOn = appEmbedEnabled === true;
  const inlineOn = inlineButtonAdded === true;
  // The storefront is "live" once at least one placement is actually on.
  const storefrontLive = appEmbedOn || inlineOn;
  const themeUnreadable = !themeStatusOk;
  const scopeMissing = themeStatusReason === "missing_scope";

  const syncFetcher = useFetcher();
  const [hasAutoSynced, setHasAutoSynced] = useState(false);
  const [activationRefreshCount, setActivationRefreshCount] = useState(0);

  useEffect(() => {
    if (syncFetcher.state === "idle" && !syncFetcher.data && !hasAutoSynced) {
      syncFetcher.submit(null, { method: "POST", action: "/api/sync-token" });
      setHasAutoSynced(true);
    }
  }, [syncFetcher.state, hasAutoSynced, syncFetcher.data]);

  // Theme-editor deep links: one opens the App embeds panel with our embed
  // pre-selected; the other drops the inline button onto the product template.
  const openAppEmbed = () => window.open(appEmbedDeepLink, "_blank", "noopener");
  const openInlineSetup = () => window.open(inlineButtonDeepLink, "_blank", "noopener");

  // Re-read the live theme status when the merchant returns from the editor
  // tab. Lightweight — revalidate re-runs the loader (which reads the theme),
  // no full page reload.
  const statusRevalidator = useRevalidator();
  useEffect(() => {
    function onFocus() {
      if (statusRevalidator.state === "idle") statusRevalidator.revalidate();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [statusRevalidator]);

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

  const money = (n: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode || "USD",
      maximumFractionDigits: 0,
    }).format(n);

  // Onboarding checklist: show until all 3 steps complete
  const effectiveHasPlan = hasPlan || skipBilling;
  const showBillingActivationPending = billingActivationPending && !hasPlan && !skipBilling;
  const allOnboarded = effectiveHasPlan && storeConnected && storefrontLive;
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

  // ── Live storefront placement rows (inline button + floating embed) ──
  // The app embed is the engine — it powers every try-on, so it leads (see embedRow).
  const inlineRow: PlacementRowProps = inlineOn
    ? {
        tone: "on",
        label: "Inline Try-On button is on your product page",
        actionLabel: "Open editor",
        onAction: openInlineSetup,
      }
    : inlineButtonAdded === false
      ? {
          tone: "off",
          label: "Inline Try-On button isn't on your product page",
          helper: "Your main conversion placement — one click adds it.",
          actionLabel: "Add button",
          onAction: openInlineSetup,
        }
      : {
          tone: "unknown",
          label: "Inline Try-On button — couldn't verify",
          helper: scopeMissing
            ? "Reload above so Ello can verify your theme."
            : "We can't auto-detect it on this theme. Use the button to add it if it isn't there.",
          actionLabel: "Add button",
          onAction: openInlineSetup,
        };

  // The Ello app embed is the engine: it loads the widget on your storefront
  // and powers every try-on (the inline button included). So it leads, and its
  // CTA reassures merchants the only step is Save.
  const embedRow: PlacementRowProps = appEmbedOn
    ? {
        tone: "on",
        label: "Ello widget is on — powering try-ons across your store",
        actionLabel: "Open theme editor",
        onAction: openAppEmbed,
      }
    : appEmbedPresentButDisabled
      ? {
          tone: "off",
          label: "Ello widget is turned off in your theme",
          helper: "Click Turn on — we re-enable it for you, then just click Save in the editor.",
          actionLabel: "Turn on",
          onAction: openAppEmbed,
        }
      : appEmbedEnabled === false
        ? {
            tone: "off",
            label: "Ello widget isn't turned on yet",
            helper: "This powers every try-on. Click Turn on — we switch it on for you, then just click Save.",
            actionLabel: "Turn on",
            onAction: openAppEmbed,
          }
        : {
            tone: "unknown",
            label: "Couldn't check if the Ello widget is on",
            helper: scopeMissing
              ? "Reload above so Ello can verify your theme."
              : "We couldn't read your theme just now — reload to retry.",
            actionLabel: "Turn on",
            onAction: openAppEmbed,
          };

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
    <Page title="Dashboard">
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
                    <Badge tone={storefrontLive ? "success" : "attention"}>{storefrontLive ? "✓" : "3"}</Badge>
                    <Text as="span" variant="bodyMd" tone={storefrontLive ? "subdued" : undefined}>
                      Turn on the Ello widget
                    </Text>
                  </InlineStack>
                  {!storefrontLive && (
                    <Button onClick={openAppEmbed} size="slim">
                      {themeUnreadable ? "Set up" : "Turn on Ello"}
                    </Button>
                  )}
                </InlineStack>
              </BlockStack>
            </BlockStack>
          </Card>
        )}

        {/* ── Free-plan upgrade CTA ── */}
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

        {/* ── Upgrade nudge at 80% ── */}
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

        {/* ── Controls row ── */}
        <InlineStack align="space-between" blockAlign="center">
          <TimeRangeSelector />
          <InlineStack gap="200">
            <Button onClick={() => navigate("/app/widget-design")} variant="tertiary">Customize widget</Button>
            <Button onClick={() => navigate("/app/analytics")}>Full analytics</Button>
          </InlineStack>
        </InlineStack>

        {/* ── Revenue hero + widget-to-cart journey ── */}
        <Card padding="500">
          <InlineGrid columns={{ xs: "1fr", md: "1fr 1fr" }} gap="500">
            <BlockStack gap="150">
              <Text as="span" variant="bodySm" tone="subdued">Attributed revenue</Text>
              <span style={{ fontSize: 42, fontWeight: 650, lineHeight: 1.05, color: "#3B63D4", letterSpacing: "-0.01em" }}>
                {money(attributedRevenue)}
              </span>
              <InlineStack gap="200" blockAlign="center">
                {revenueDelta != null && (
                  <span style={{ fontSize: 12, fontWeight: 600, color: revenueDelta >= 0 ? "#17A673" : "#D94E4E" }}>
                    {revenueDelta >= 0 ? "▲" : "▼"} {Math.abs(revenueDelta)}% vs previous {RANGE_DAYS[range]} days
                  </span>
                )}
                <Text as="span" variant="bodySm" tone="subdued">
                  Orders placed after a try-on · last {RANGE_DAYS[range]} days
                </Text>
              </InlineStack>
              {purchaseConversionPct != null && (
                <Text as="span" variant="bodySm" tone="subdued">
                  {purchaseConversionPct}% of try-on sessions end in a purchase
                </Text>
              )}
            </BlockStack>
            <BlockStack gap="300">
              <Text as="span" variant="bodySm" tone="subdued">Widget-to-cart journey</Text>
              <FunnelBar label="Widget opens" value={widgetOpens} max={widgetOpens} />
              <FunnelBar label="Try-ons" value={totalTryons} max={widgetOpens} />
              <FunnelBar label="Cart adds" value={totalCartAdds} max={widgetOpens} />
            </BlockStack>
          </InlineGrid>
        </Card>

        {/* ── KPI row ── */}
        <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
          <KpiTile label="Total try-ons" value={totalTryons.toLocaleString()} delta={tryonsDelta} hint={`Last ${RANGE_DAYS[range]} days`} />
          <KpiTile
            label="Cart conversion"
            value={cartConversionPct != null ? `${cartConversionPct}%` : "—"}
            hint="Try-on sessions that added to cart"
          />
          <KpiTile label="Cart adds" value={totalCartAdds.toLocaleString()} delta={cartsDelta} hint="After a try-on" />
        </InlineGrid>

        <Layout>
          {/* ── Plan & usage ── */}
          {effectiveHasPlan && (
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center" wrap={false}>
                    <InlineStack gap="300" blockAlign="center">
                      <Text as="h2" variant="headingMd">Current Plan</Text>
                      <Badge tone={showExternalBillingPlaceholder || isDeveloperPlan ? "info" : "success"}>
                        {currentPlanBadgeLabel}
                      </Badge>
                    </InlineStack>
                    {!skipBilling && (
                      <Button onClick={() => navigate("/app/billing")} variant="plain">Change plan</Button>
                    )}
                  </InlineStack>

                  {showExternalBillingPlaceholder ? (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Billing handled outside Shopify. Your contracted plan will appear here once assigned.
                    </Text>
                  ) : isDeveloperPlan ? (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Unlimited try-ons — developer / testing plan
                    </Text>
                  ) : (
                    <BlockStack gap="150">
                      <InlineStack align="space-between">
                        <Text as="p" variant="bodySm" tone="subdued">
                          {tryonsUsed.toLocaleString()} / {includedTryons?.toLocaleString()} try-ons used
                          {periodEndFormatted && (
                            <Text as="span" variant="bodySm" tone="subdued">
                              {" · resets "}{periodEndFormatted}
                            </Text>
                          )}
                        </Text>
                        <Text as="p" variant="bodySm" tone={usagePercent >= 80 ? "critical" : "subdued"}>
                          {usagePercent}%
                        </Text>
                      </InlineStack>
                      <ProgressBar
                        progress={usagePercent}
                        tone={usagePercent >= 80 ? "critical" : "highlight"}
                        size="small"
                      />
                      {(isFreePlan || !skipBilling) && (
                        <Text as="p" variant="bodySm" tone="subdued">
                          {isFreePlan
                            ? "Free plan — no overages, upgrade to continue after 10"
                            : "$0.15/try-on for overages"}
                        </Text>
                      )}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            </Layout.Section>
          )}

          {/* ── Storefront status ── */}
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">Storefront</Text>
                  {!isLoading && themeStatusOk && storeConnected && storefrontLive && (
                    <Badge tone="success">All systems operational</Badge>
                  )}
                </InlineStack>

                {themeUnreadable && (
                  <Banner
                    tone="warning"
                    title={scopeMissing ? "Reload to verify your widget status" : "Couldn't read your theme"}
                  >
                    <Text as="p" variant="bodyMd">
                      {scopeMissing
                        ? "Ello now reads your live theme to confirm the Try-On button and widget are actually on. Reload this page to grant the one-time permission."
                        : "We couldn't read your live theme just now, so the statuses below may be out of date. Reload to try again."}
                    </Text>
                    <Box paddingBlockStart="200">
                      <Button onClick={() => window.location.reload()} variant="primary" size="slim">
                        {scopeMissing ? "Reload & verify" : "Reload"}
                      </Button>
                    </Box>
                  </Banner>
                )}

                <BlockStack gap="300">
                  <PlacementRow {...embedRow} />
                  <PlacementRow {...inlineRow} />

                  {/* Plain-language guide for placing the inline button under
                      Add-to-cart on nested themes (Horizon). Shared component. */}
                  <InlineButtonPlacementHelp />

                  <InlineStack align="space-between" blockAlign="center">
                    <InlineStack gap="200" blockAlign="center">
                      <Badge tone={storeConnected ? "success" : "attention"}>
                        {storeConnected ? "✓" : "!"}
                      </Badge>
                      <Text as="span" variant="bodyMd">
                        {storeConnected ? "Connected to Ello VTO Cloud" : "Connection issue — retrying"}
                      </Text>
                    </InlineStack>
                    {!storeConnected && (
                      <Button onClick={handleRetrySync} variant="plain" size="slim" loading={isLoading}>
                        Reconnect
                      </Button>
                    )}
                  </InlineStack>
                </BlockStack>

                {/* Only surface the banner for a persistent error. The transient
                    "Syncing…/Checking…" states are intentionally omitted: the
                    connection badges above already convey status, and a banner
                    that mounts mid-page after the sync fetcher resolves (then
                    unmounts on success) reflows everything below it on every
                    load — a recurring layout shift that hurts CLS. */}
                {syncFetcher.data && !(syncFetcher.data as { success?: boolean }).success && (
                  <Box paddingBlockStart="200">{statusBanner}</Box>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* ── Recent shopper sessions ── */}
        <Card padding="500">
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">Recent sessions</Text>
                <Text as="p" variant="bodySm" tone="subdued">The latest shoppers to use the widget · last 7 days</Text>
              </BlockStack>
              <Button variant="plain" onClick={() => navigate("/app/analytics")}>View all analytics</Button>
            </InlineStack>
            {recent.length === 0 ? (
              <Box paddingBlock="300">
                <Text as="p" tone="subdued">No shopper sessions yet. They&apos;ll appear here as soon as someone opens the widget.</Text>
              </Box>
            ) : (
              <BlockStack gap="200">
                {recent.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      border: `1px solid ${brand.ink100}`,
                      borderRadius: 12,
                      padding: "10px 14px",
                    }}
                  >
                    <BlockStack gap="050">
                      <Text as="span" variant="bodySm" fontWeight="medium">
                        {s.products.length > 0
                          ? s.products.map((p) => recentProductNames[p] ?? p).join(", ")
                          : "Browsed the widget"}
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {timeAgo(s.lastAt)}
                        {s.device ? ` · ${s.device}` : ""}
                        {s.tryonCount > 0 ? ` · ${s.tryonCount} try-on${s.tryonCount === 1 ? "" : "s"}` : ""}
                      </Text>
                    </BlockStack>
                    <InlineStack gap="200" blockAlign="center">
                      {s.revenue > 0 && (
                        <Text as="span" variant="bodySm" fontWeight="semibold">{money(s.revenue)}</Text>
                      )}
                      <Badge
                        tone={s.outcome === "purchased" ? "success" : s.outcome === "carted" ? "info" : undefined}
                      >
                        {s.outcome === "purchased"
                          ? "Purchased"
                          : s.outcome === "carted"
                            ? "Added to cart"
                            : s.outcome === "tried"
                              ? "Tried on"
                              : "Browsed"}
                      </Badge>
                    </InlineStack>
                  </div>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </Card>

        {/* ── Rate Ello ── */}
        <RateCard />

        {/* ── Slim support footer ── */}
        <Box paddingBlockStart="200" paddingBlockEnd="400">
          <InlineStack align="center" gap="300" blockAlign="center">
            <Text as="span" variant="bodySm" tone="subdued">Need help?</Text>
            <Link url={`mailto:${SUPPORT_EMAIL}`}>Contact support</Link>
            <Text as="span" variant="bodySm" tone="subdued">·</Text>
            <Button variant="plain" onClick={handleRetrySync} loading={isLoading}>
              Run sync test
            </Button>
          </InlineStack>
        </Box>
      </BlockStack>
    </Page>
  );
}

// ─── Storefront placement status row ───────────────────────────────────────
type PlacementRowProps = {
  tone: "on" | "off" | "unknown";
  label: string;
  helper?: string;
  actionLabel?: string;
  onAction?: () => void;
};

function PlacementRow({ tone, label, helper, actionLabel, onAction }: PlacementRowProps) {
  const badgeTone = tone === "on" ? "success" : tone === "off" ? "attention" : "warning";
  const symbol = tone === "on" ? "✓" : tone === "off" ? "!" : "?";
  return (
    <InlineStack align="space-between" blockAlign="center" wrap={false} gap="300">
      <InlineStack gap="200" blockAlign="center">
        <Badge tone={badgeTone}>{symbol}</Badge>
        <BlockStack gap="050">
          <Text as="span" variant="bodyMd">{label}</Text>
          {helper && (
            <Text as="span" variant="bodySm" tone="subdued">{helper}</Text>
          )}
        </BlockStack>
      </InlineStack>
      {actionLabel && onAction && (
        <Button onClick={onAction} variant={tone === "on" ? "plain" : "primary"} size="slim">
          {actionLabel}
        </Button>
      )}
    </InlineStack>
  );
}

// ─── Relative time for the recent-sessions list ────────────────────────────
function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─── Rate-the-app card ──────────────────────────────────────────────────────
// Light review-gating: 4–5 stars → App Store review modal; 1–3 → email feedback.
function RateCard() {
  const [hover, setHover] = useState(0);
  const [picked, setPicked] = useState(0);

  const choose = (n: number) => {
    setPicked(n);
    if (n >= 4) {
      window.open(REVIEW_URL, "_blank");
    } else {
      const subject = encodeURIComponent("Ello feedback");
      const body = encodeURIComponent("How can we make Ello better for your store?");
      window.location.href = `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
    }
  };

  return (
    <Card>
      <InlineStack align="space-between" blockAlign="center" wrap>
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">Enjoying Ello?</Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {picked === 0
              ? "Rate your experience — it helps other merchants find us."
              : picked >= 4
                ? "Thank you! A review means the world to a small team."
                : "Thanks — we'd love to hear how we can improve."}
          </Text>
        </BlockStack>
        <InlineStack gap="100" blockAlign="center">
          {[1, 2, 3, 4, 5].map((n) => {
            const active = (hover || picked) >= n;
            return (
              <button
                key={n}
                type="button"
                aria-label={`Rate ${n} star${n === 1 ? "" : "s"}`}
                onMouseEnter={() => setHover(n)}
                onMouseLeave={() => setHover(0)}
                onClick={() => choose(n)}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 26,
                  lineHeight: 1,
                  padding: "2px",
                  color: active ? "#E2A93A" : "#D8DCE3",
                  transition: "color 120ms ease",
                }}
              >
                ★
              </button>
            );
          })}
        </InlineStack>
      </InlineStack>
    </Card>
  );
}
