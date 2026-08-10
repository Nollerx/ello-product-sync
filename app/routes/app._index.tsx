import { Suspense, useEffect, useState } from "react";
import type { FunctionComponent, ReactNode, SVGProps } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Await, useFetcher, useLoaderData, useNavigate, useRevalidator } from "react-router";
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
import {
  getThemeWidgetStatus,
  persistThemeStatus,
  type ThemeWidgetStatus,
} from "../lib/theme-status.server";
import { getAppEmbedEditorUrl, getInlineTryOnBlockEditorUrl } from "../lib/onboarding.server";
import { InlineButtonPlacementHelp } from "../components/inline-placement-help";
import { getPlanConfig } from "../lib/shopify-billing.server";
import { resolveStorefront } from "../lib/storefront-names.server";
import {
  ButtonIcon,
  CameraIcon,
  CartSaleIcon,
  CartUpIcon,
  CheckIcon,
  ClipboardChecklistIcon,
  ClockIcon,
  ConnectIcon,
  CreditCardIcon,
  DatabaseConnectIcon,
  PaintBrushFlatIcon,
  PersonIcon,
  ProductIcon,
  SettingsIcon,
  StoreOnlineIcon,
  ThemeIcon,
  ToggleOnIcon,
  ViewIcon,
} from "@shopify/polaris-icons";
import { brand, fonts, tnum, Eyebrow, MonoMeta, PageHeader } from "../components/ui";
import {
  DailyPerformanceCard,
  DailyPerformanceSkeleton,
  Delta,
  FunnelBar,
  HeadlineStrip,
  IconChip,
  StatusPill,
  TimeRangeSelector,
  type Tone,
} from "../components/analytics";
import { parseRange, pctDelta, rangeWindow, RANGE_DAYS } from "../lib/timerange";
import {
  buildSessions,
  countWidgetOpens,
  dailySeries,
  fetchCoreEvents,
  fetchEventDates,
  getConversionSummary,
  getDailyRevenue,
  getPrevCounts,
  getShopTimezone,
  recentSessions,
  type RecentSession,
} from "../lib/analytics.server";

const ACTIVATION_REFRESH_STORAGE_KEY = "ello.billing.activationRefreshCount";
const MAX_ACTIVATION_REFRESH_ATTEMPTS = 5;

// Where the "Rate Ello" card sends happy merchants. TODO(andrew): confirm the
// real App Store listing handle — this opens the review modal on the listing.
const REVIEW_URL = "https://apps.shopify.com/ello-virtual-try-on#modal-show=ReviewListingModal";
const SUPPORT_EMAIL = "support@ello.services";

// ─── Streamed loader payloads ───────────────────────────────────────────────
type DailyPoint = { day: string; value: number };

type HomeMetrics = {
  attributedRevenue: number;
  purchaseConversionPct: number | null;
  cartConversionPct: number | null;
  totalTryons: number;
  totalCartAdds: number;
  widgetOpens: number;
  revenueDelta: number | null;
  tryonsDelta: number | null;
  cartsDelta: number | null;
  currencyCode: string;
  dailyRevenue: DailyPoint[];
  dailyTryons: DailyPoint[];
  dailyCarts: DailyPoint[];
};

type HomeRecent = {
  recent: RecentSession[];
  recentProductNames: Record<string, string>;
  currencyCode: string;
};

// Last-known theme placement state persisted in vto_stores — paints the
// storefront card and checklist instantly while the live read streams in.
type ThemeCacheSnapshot = {
  appEmbedEnabled: boolean | null;
  inlineButtonAdded: boolean | null;
  reason: string | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  // eslint-disable-next-line no-undef
  const apiKey = process.env.SHOPIFY_API_KEY;
  const range = parseRange(url.searchParams.get("range"));
  const win = rangeWindow(range);

  // Live theme read (2 sequential Shopify GraphQL calls, sometimes a file
  // download) — kicked off first so it overlaps everything, and STREAMED to the
  // client instead of blocking first paint. Bounded so a stuck Shopify API can
  // never hold the stream open; the fallback renders the "couldn't read" state.
  const theme: Promise<ThemeWidgetStatus> = (async () => {
    const fallback: ThemeWidgetStatus = {
      ok: false,
      themeId: null,
      themeName: null,
      appEmbedEnabled: null,
      appEmbedPresentButDisabled: false,
      inlineButtonAdded: null,
      productTemplateParseable: false,
      reason: "graphql_error",
      checkedAt: new Date().toISOString(),
    };
    try {
      const status = await Promise.race([
        getThemeWidgetStatus(admin),
        new Promise<ThemeWidgetStatus>((resolve) => setTimeout(() => resolve(fallback), 8000)),
      ]);
      // Cache so the NEXT load paints the storefront card instantly.
      persistThemeStatus(session.shop, status).catch((e) =>
        console.warn("[Dashboard] theme status cache write failed:", e),
      );
      return status;
    } catch (err) {
      console.error("[Dashboard] theme read failed (non-fatal):", err);
      return fallback;
    }
  })();

  // ── Critical path: two fast indexed reads, then the shell renders. ──
  const { data: storeData } = await supabaseAdmin
    .from("vto_stores")
    .select(
      "store_slug, account_id, storefront_token, shop_domain, app_embed_enabled, inline_button_added, theme_status_reason",
    )
    .eq("shop_domain", session.shop)
    .maybeSingle();

  const accountId = storeData?.account_id ?? null;
  const slug = storeData?.store_slug ?? null;
  const shopDomain = (storeData?.shop_domain as string | undefined) ?? null;
  const storefrontToken = (storeData?.storefront_token as string | undefined) ?? null;

  // Active subscription + its current usage period in ONE embedded query
  // (was two sequential round trips). The embedded filter keeps only the
  // period containing `now`, newest first — overlap-proof like the old query.
  const nowIso = new Date().toISOString();
  let sub: { id: string; plan_id: string } | null = null;
  let usagePeriod: { tryons_used: number; period_end: string } | null = null;
  if (accountId) {
    const { data: subRow } = await supabaseAdmin
      .from("vto_subscriptions")
      .select("id, plan_id, vto_usage_periods(tryons_used, period_end)")
      .eq("account_id", accountId)
      .eq("status", "active")
      .lte("vto_usage_periods.period_start", nowIso)
      .gte("vto_usage_periods.period_end", nowIso)
      .order("shopify_subscription_id", { ascending: false, nullsFirst: false })
      .order("period_start", { referencedTable: "vto_usage_periods", ascending: false })
      .limit(1)
      .limit(1, { referencedTable: "vto_usage_periods" })
      .maybeSingle();
    if (subRow) {
      sub = { id: subRow.id as string, plan_id: subRow.plan_id as string };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const periods = (subRow as any).vto_usage_periods as
        | Array<{ tryons_used: number; period_end: string }>
        | null;
      usagePeriod = periods?.[0] ?? null;
    }
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

  // ── Streamed: dashboard metrics + daily chart series over ?range. ──
  // Every branch fails soft so these promises NEVER reject (a rejection would
  // error the Suspense boundary); worst case the cards show zeros.
  const emptyMetrics: HomeMetrics = {
    attributedRevenue: 0,
    purchaseConversionPct: null,
    cartConversionPct: null,
    totalTryons: 0,
    totalCartAdds: 0,
    widgetOpens: 0,
    revenueDelta: null,
    tryonsDelta: null,
    cartsDelta: null,
    currencyCode: "USD",
    dailyRevenue: [],
    dailyTryons: [],
    dailyCarts: [],
  };

  const metrics: Promise<HomeMetrics> = !slug
    ? Promise.resolve(emptyMetrics)
    : (async () => {
        try {
          const tz = await getShopTimezone(admin, session.shop);
          const [summary, prevCounts, dailyRevenue, tryonDates, cartDates, widgetOpens, sfMeta] =
            await Promise.all([
              getConversionSummary(slug, win.from, win.to),
              getPrevCounts(slug, win.prevFrom, win.prevTo),
              getDailyRevenue(slug, win.from, win.to, tz),
              fetchEventDates("tryon_events", slug, win.from, win.to),
              fetchEventDates("cart_events", slug, win.from, win.to),
              countWidgetOpens(slug, win.from, win.to),
              // ids=[] → currency-only Storefront lookup for the money formatter
              resolveStorefront(shopDomain, storefrontToken, []),
            ]);
          const attributedRevenue = summary?.revenue ?? 0;
          const totalTryons = tryonDates.length;
          const totalCartAdds = cartDates.length;
          return {
            attributedRevenue,
            purchaseConversionPct: summary?.purchaseConversionPct ?? null,
            cartConversionPct:
              summary && summary.tryonSessions > 0
                ? Math.round((summary.addedToCart / summary.tryonSessions) * 100)
                : null,
            totalTryons,
            totalCartAdds,
            widgetOpens,
            revenueDelta: pctDelta(attributedRevenue, prevCounts.revenue),
            tryonsDelta: pctDelta(totalTryons, prevCounts.tryons),
            cartsDelta: pctDelta(totalCartAdds, prevCounts.carts),
            currencyCode: sfMeta.currencyCode,
            dailyRevenue,
            dailyTryons: dailySeries(tryonDates, tz, win.from, win.to).map((d) => ({
              day: d.day,
              value: d.count,
            })),
            dailyCarts: dailySeries(cartDates, tz, win.from, win.to).map((d) => ({
              day: d.day,
              value: d.count,
            })),
          };
        } catch (err) {
          console.error("[Dashboard] metrics failed (non-fatal):", err);
          return emptyMetrics;
        }
      })();

  // ── Streamed: recent shopper sessions (always last 7 days, newest page only). ──
  const emptyRecent: HomeRecent = { recent: [], recentProductNames: {}, currencyCode: "USD" };
  const recentData: Promise<HomeRecent> = !slug
    ? Promise.resolve(emptyRecent)
    : (async () => {
        try {
          const recentWin = rangeWindow("7d");
          const core = await fetchCoreEvents(slug, recentWin.from, recentWin.to, { rowCap: 1000 });
          const recent = recentSessions(buildSessions(core), 8);
          const recentIds = Array.from(new Set(recent.flatMap((s) => s.products)));
          const idToGid = (raw: string): string =>
            raw.startsWith("gid://") ? raw : `gid://shopify/Product/${raw}`;
          const meta = await resolveStorefront(shopDomain, storefrontToken, recentIds.map(idToGid));
          return {
            recent,
            recentProductNames: Object.fromEntries(
              recentIds.map((id) => [id, meta.titles.get(idToGid(id)) ?? id]),
            ),
            currencyCode: meta.currencyCode,
          };
        } catch (err) {
          console.error("[Dashboard] recent sessions failed (non-fatal):", err);
          return emptyRecent;
        }
      })();

  // eslint-disable-next-line no-undef
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
    themeCache: {
      appEmbedEnabled: (storeData?.app_embed_enabled as boolean | null) ?? null,
      inlineButtonAdded: (storeData?.inline_button_added as boolean | null) ?? null,
      reason: (storeData?.theme_status_reason as string | null) ?? null,
    } satisfies ThemeCacheSnapshot,
    appEmbedDeepLink: getAppEmbedEditorUrl(session.shop),
    inlineButtonDeepLink: getInlineTryOnBlockEditorUrl(session.shop),
    storeConnected: !!storefrontToken,
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
    // Streamed (Suspense/Await on the client):
    metrics,
    recentData,
    theme,
  };
};

export const action = async () => {
  return null;
};

// ─── Theme view: one shape for both the cached snapshot and the live read ───
// `live: false` = painting from the persisted snapshot while the real theme
// read streams in; warning banners are suppressed until the live result lands.
type ThemeView = {
  live: boolean;
  ok: boolean;
  appEmbedEnabled: boolean | null;
  appEmbedPresentButDisabled: boolean;
  inlineButtonAdded: boolean | null;
  scopeMissing: boolean;
};

function viewFromCache(cache: ThemeCacheSnapshot): ThemeView {
  return {
    live: false,
    // The snapshot is only ever persisted from successful reads, so a stored
    // reason means the last live read was ok.
    ok: cache.reason != null,
    appEmbedEnabled: cache.appEmbedEnabled,
    appEmbedPresentButDisabled: false,
    inlineButtonAdded: cache.inlineButtonAdded,
    scopeMissing: false,
  };
}

function viewFromLive(status: ThemeWidgetStatus): ThemeView {
  return {
    live: true,
    ok: status.ok,
    appEmbedEnabled: status.appEmbedEnabled,
    appEmbedPresentButDisabled: status.appEmbedPresentButDisabled,
    inlineButtonAdded: status.inlineButtonAdded,
    scopeMissing: status.reason === "missing_scope",
  };
}

const storefrontLiveFor = (v: ThemeView) =>
  v.appEmbedEnabled === true || v.inlineButtonAdded === true;

export default function Index() {
  const navigate = useNavigate();
  const {
    themeCache,
    appEmbedDeepLink,
    inlineButtonDeepLink,
    storeConnected,
    hasPlan,
    planDisplayName,
    planKey,
    includedTryons,
    tryonsUsed,
    periodEnd,
    skipBilling,
    billingActivationPending,
    pendingPlanDisplayName,
    range,
    metrics,
    recentData,
    theme,
  } = useLoaderData<typeof loader>();

  const cacheView = viewFromCache(themeCache);

  const syncFetcher = useFetcher();
  const [hasAutoSynced, setHasAutoSynced] = useState(false);
  const [activationRefreshCount, setActivationRefreshCount] = useState(0);

  // Self-heal the storefront connection — but only when it's actually broken.
  // (The old unconditional auto-sync POSTed on every visit and its completion
  // revalidated every loader: the whole dashboard silently loaded twice.)
  useEffect(() => {
    if (!storeConnected && syncFetcher.state === "idle" && !syncFetcher.data && !hasAutoSynced) {
      syncFetcher.submit(null, { method: "POST", action: "/api/sync-token" });
      setHasAutoSynced(true);
    }
  }, [storeConnected, syncFetcher.state, hasAutoSynced, syncFetcher.data]);

  // Theme-editor deep links: one opens the App embeds panel with our embed
  // pre-selected; the other drops the inline button onto the product template.
  const openAppEmbed = () => window.open(appEmbedDeepLink, "_blank", "noopener");
  const openInlineSetup = () => window.open(inlineButtonDeepLink, "_blank", "noopener");

  // Re-read the live theme status when the merchant returns from the editor
  // tab. Revalidation runs inside a React transition, so the streamed sections
  // keep their current content while fresh data loads (no skeleton flash).
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

  const effectiveHasPlan = hasPlan || skipBilling;
  const showBillingActivationPending = billingActivationPending && !hasPlan && !skipBilling;
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

  const checklistProps = {
    effectiveHasPlan,
    hasPlan,
    skipBilling,
    storeConnected,
    showBillingActivationPending,
    isLoading,
    onChoosePlan: () => navigate("/app/billing"),
    onRetrySync: handleRetrySync,
    onOpenAppEmbed: openAppEmbed,
  };

  const storefrontProps = {
    storeConnected,
    isLoading,
    onOpenAppEmbed: openAppEmbed,
    onOpenInlineSetup: openInlineSetup,
    onRetrySync: handleRetrySync,
    syncData: syncFetcher.data as SyncResult | undefined,
  };

  return (
    <Page>
      <BlockStack gap="500">
        <PageHeader kicker="Ello Virtual Try-On" title="Dashboard" />

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

        {/* ── Onboarding checklist: instant from the cached theme snapshot,
               then live-updated when the real theme read streams in ── */}
        <Suspense fallback={<GettingStartedCard view={cacheView} {...checklistProps} />}>
          <Await resolve={theme}>
            {(t) => <GettingStartedCard view={viewFromLive(t)} {...checklistProps} />}
          </Await>
        </Suspense>

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

        {/* ── Plain-English TL;DR (only once there's signal) ── */}
        <Suspense fallback={<HeadlineSkeleton />}>
          <Await resolve={metrics}>
            {(m) =>
              m.widgetOpens > 0 ? (
                <HeadlineStrip>
                  Shoppers opened Ello <strong>{m.widgetOpens.toLocaleString()}</strong> times and ran{" "}
                  <strong>{m.totalTryons.toLocaleString()}</strong> try-on{m.totalTryons === 1 ? "" : "s"}
                  {m.totalCartAdds > 0 && (
                    <>
                      , adding <strong>{m.totalCartAdds.toLocaleString()}</strong> item{m.totalCartAdds === 1 ? "" : "s"} to cart
                    </>
                  )}
                  {m.attributedRevenue > 0 && (
                    <>
                      {" "}— <strong>{money(m.attributedRevenue, m.currencyCode)}</strong> in attributed sales
                    </>
                  )}{" "}
                  over the last {RANGE_DAYS[range]} days.
                </HeadlineStrip>
              ) : null
            }
          </Await>
        </Suspense>

        {/* ── Controls row ── */}
        <InlineStack align="space-between" blockAlign="center">
          <TimeRangeSelector />
          <Button onClick={() => navigate("/app/analytics")}>Full analytics</Button>
        </InlineStack>

        {/* ── Revenue hero + widget-to-cart journey ── */}
        <Suspense fallback={<HeroSkeleton />}>
          <Await resolve={metrics}>
            {(m) => (
              <Card padding="500">
                <InlineGrid columns={{ xs: "1fr", md: "1fr 1fr" }} gap="500">
                  {/* The page's one accented number: the money. Ledger anatomy —
                      eyebrow, Playfair hero numeral, delta, mono receipt line. */}
                  <BlockStack gap="150">
                    <Eyebrow>Attributed revenue</Eyebrow>
                    <span
                      style={{
                        fontFamily: fonts.serif,
                        fontSize: 44,
                        fontWeight: 500,
                        lineHeight: 1.08,
                        color: brand.blue,
                        letterSpacing: "-0.01em",
                        ...tnum,
                      }}
                    >
                      {money(m.attributedRevenue, m.currencyCode)}
                    </span>
                    <Delta value={m.revenueDelta} />
                    <MonoMeta>
                      {RANGE_DAYS[range]}d · orders placed after a try-on
                    </MonoMeta>
                    {m.purchaseConversionPct != null && (
                      <Text as="span" variant="bodySm" tone="subdued">
                        {m.purchaseConversionPct}% of try-on sessions end in a purchase
                      </Text>
                    )}
                  </BlockStack>
                  <BlockStack gap="300">
                    <Eyebrow>Widget-to-cart journey</Eyebrow>
                    <FunnelBar label="Widget opens" value={m.widgetOpens} max={m.widgetOpens} />
                    <FunnelBar label="Try-ons" value={m.totalTryons} max={m.widgetOpens} />
                    <FunnelBar label="Cart adds" value={m.totalCartAdds} max={m.widgetOpens} />
                  </BlockStack>
                </InlineGrid>
              </Card>
            )}
          </Await>
        </Suspense>

        {/* ── Daily performance: revenue bars + try-on/cart lines, shared
               x-axis + unified hover, driven by the range selector above ── */}
        <Suspense fallback={<DailyPerformanceSkeleton />}>
          <Await resolve={metrics}>
            {(m) => (
              <DailyPerformanceCard
                revenue={m.dailyRevenue}
                tryons={m.dailyTryons}
                carts={m.dailyCarts}
                totals={{ revenue: m.attributedRevenue, tryons: m.totalTryons, carts: m.totalCartAdds }}
                deltas={{ revenue: m.revenueDelta, tryons: m.tryonsDelta, carts: m.cartsDelta }}
                formatMoney={(v) => money(v, m.currencyCode)}
                rangeDays={RANGE_DAYS[range]}
                cartConversionPct={m.cartConversionPct}
              />
            )}
          </Await>
        </Suspense>

        <Layout>
          {/* ── Plan & usage ── */}
          {effectiveHasPlan && (
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center" wrap={false}>
                    <InlineStack gap="300" blockAlign="center">
                      <IconChip source={CreditCardIcon} tone="money" size={34} />
                      <Text as="h2" variant="headingMd">Current plan</Text>
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

          {/* ── Storefront status: cached snapshot first, live truth streams in ── */}
          <Layout.Section>
            <Suspense fallback={<StorefrontStatusCard view={cacheView} {...storefrontProps} />}>
              <Await resolve={theme}>
                {(t) => <StorefrontStatusCard view={viewFromLive(t)} {...storefrontProps} />}
              </Await>
            </Suspense>
          </Layout.Section>
        </Layout>

        {/* ── Quick actions ── */}
        <Card padding="500">
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">Quick actions</Text>
            <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
              <QuickAction
                icon={PaintBrushFlatIcon}
                label="Customize widget"
                sublabel="Colors, text & button style"
                onClick={() => navigate("/app/widget-design")}
              />
              <QuickAction
                icon={ProductIcon}
                label="Products"
                sublabel="Choose what's try-on enabled"
                onClick={() => navigate("/app/products")}
              />
              <QuickAction
                icon={PersonIcon}
                label="Leads"
                sublabel="Shoppers who shared an email"
                onClick={() => navigate("/app/leads")}
              />
              {skipBilling ? (
                <QuickAction
                  icon={SettingsIcon}
                  label="Settings"
                  sublabel="Widget & app preferences"
                  onClick={() => navigate("/app/settings")}
                />
              ) : (
                <QuickAction
                  icon={CreditCardIcon}
                  label="Plan & billing"
                  sublabel="Usage, upgrades & limits"
                  onClick={() => navigate("/app/billing")}
                />
              )}
            </InlineGrid>
          </BlockStack>
        </Card>

        {/* ── Recent shopper sessions ── */}
        <Card padding="500">
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <InlineStack gap="300" blockAlign="center">
                <IconChip source={PersonIcon} tone="neutral" size={34} />
                <BlockStack gap="050">
                  <Text as="h2" variant="headingMd">Recent sessions</Text>
                  <Text as="p" variant="bodySm" tone="subdued">The latest shoppers to use the widget · last 7 days</Text>
                </BlockStack>
              </InlineStack>
              <Button variant="plain" onClick={() => navigate("/app/analytics")}>View all analytics</Button>
            </InlineStack>
            <Suspense fallback={<RecentRowsSkeleton />}>
              <Await resolve={recentData}>
                {(r) =>
                  r.recent.length === 0 ? (
                    <Box paddingBlock="400">
                      <BlockStack gap="200" inlineAlign="center">
                        <IconChip source={ViewIcon} tone="neutral" size={38} />
                        <Text as="p" tone="subdued" alignment="center">
                          No shopper sessions yet. They&apos;ll appear here as soon as someone opens the widget.
                        </Text>
                      </BlockStack>
                    </Box>
                  ) : (
                    <BlockStack gap="200">
                      {r.recent.map((s) => {
                        const meta = OUTCOME_META[s.outcome] ?? OUTCOME_META.browsed;
                        return (
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
                            <InlineStack gap="300" blockAlign="center" wrap={false}>
                              <IconChip source={meta.icon} tone={meta.tone} size={34} />
                              <BlockStack gap="050">
                                <Text as="span" variant="bodySm" fontWeight="medium">
                                  {s.products.length > 0
                                    ? s.products.map((p) => r.recentProductNames[p] ?? p).join(", ")
                                    : "Browsed the widget"}
                                </Text>
                                <Text as="span" variant="bodySm" tone="subdued">
                                  {timeAgo(s.lastAt)}
                                  {s.device ? ` · ${s.device}` : ""}
                                  {s.tryonCount > 0 ? ` · ${s.tryonCount} try-on${s.tryonCount === 1 ? "" : "s"}` : ""}
                                </Text>
                              </BlockStack>
                            </InlineStack>
                            <InlineStack gap="200" blockAlign="center" wrap={false}>
                              {s.revenue > 0 && (
                                <Text as="span" variant="bodySm" fontWeight="semibold">
                                  {money(s.revenue, r.currencyCode)}
                                </Text>
                              )}
                              <StatusPill label={meta.label} tone={meta.tone} />
                            </InlineStack>
                          </div>
                        );
                      })}
                    </BlockStack>
                  )
                }
              </Await>
            </Suspense>
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

// ─── Money formatter (currency streams in with each data region) ────────────
function money(n: number, currencyCode: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currencyCode || "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

// ─── Shared icon-component type (matches @shopify/polaris-icons exports) ────
type IconSource = FunctionComponent<SVGProps<SVGSVGElement>>;

type SyncResult = {
  success: boolean;
  message?: string;
  error?: string;
  retryable?: boolean;
  requestId?: string;
};

// ─── Getting-started checklist (hidden once all steps done) ─────────────────
function GettingStartedCard({
  view,
  effectiveHasPlan,
  hasPlan,
  skipBilling,
  storeConnected,
  showBillingActivationPending,
  isLoading,
  onChoosePlan,
  onRetrySync,
  onOpenAppEmbed,
}: {
  view: ThemeView;
  effectiveHasPlan: boolean;
  hasPlan: boolean;
  skipBilling: boolean;
  storeConnected: boolean;
  showBillingActivationPending: boolean;
  isLoading: boolean;
  onChoosePlan: () => void;
  onRetrySync: () => void;
  onOpenAppEmbed: () => void;
}) {
  const storefrontLive = storefrontLiveFor(view);
  const allOnboarded = effectiveHasPlan && storeConnected && storefrontLive;
  if (allOnboarded) return null;

  const checklistTotal = skipBilling ? 2 : 3;
  const checklistDone =
    (skipBilling ? 0 : hasPlan ? 1 : 0) + (storeConnected ? 1 : 0) + (storefrontLive ? 1 : 0);

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="300" blockAlign="center">
            <IconChip source={ClipboardChecklistIcon} tone="money" size={34} />
            <BlockStack gap="050">
              <Text as="h2" variant="headingMd">Getting started</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Complete these steps to go live with virtual try-on.
              </Text>
            </BlockStack>
          </InlineStack>
          <StatusPill
            label={`${checklistDone} of ${checklistTotal} done`}
            tone={checklistDone === checklistTotal ? "good" : "neutral"}
          />
        </InlineStack>
        <ProgressBar
          progress={Math.round((checklistDone / checklistTotal) * 100)}
          tone="highlight"
          size="small"
        />
        <BlockStack gap="300">
          {!skipBilling && (
            <ChecklistStep
              state={hasPlan ? "done" : showBillingActivationPending ? "waiting" : "pending"}
              icon={CreditCardIcon}
              label={showBillingActivationPending ? "Plan activation in progress" : "Choose a plan"}
              action={
                !hasPlan && !showBillingActivationPending ? (
                  <Button onClick={onChoosePlan} size="slim" variant="primary">Choose plan</Button>
                ) : undefined
              }
            />
          )}

          <ChecklistStep
            state={storeConnected ? "done" : "pending"}
            icon={ConnectIcon}
            label="Connect your store"
            action={
              !storeConnected ? (
                <Button onClick={onRetrySync} size="slim" loading={isLoading}>Reconnect</Button>
              ) : undefined
            }
          />

          <ChecklistStep
            state={storefrontLive ? "done" : "pending"}
            icon={ToggleOnIcon}
            label="Turn on the Ello widget"
            action={
              !storefrontLive ? (
                <Button onClick={onOpenAppEmbed} size="slim">
                  {view.live && !view.ok ? "Set up" : "Turn on Ello"}
                </Button>
              ) : undefined
            }
          />
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

// ─── Storefront status card (placement rows + connection row) ───────────────
function StorefrontStatusCard({
  view,
  storeConnected,
  isLoading,
  onOpenAppEmbed,
  onOpenInlineSetup,
  onRetrySync,
  syncData,
}: {
  view: ThemeView;
  storeConnected: boolean;
  isLoading: boolean;
  onOpenAppEmbed: () => void;
  onOpenInlineSetup: () => void;
  onRetrySync: () => void;
  syncData: SyncResult | undefined;
}) {
  const appEmbedOn = view.appEmbedEnabled === true;
  const inlineOn = view.inlineButtonAdded === true;
  const storefrontLive = appEmbedOn || inlineOn;
  const themeUnreadable = !view.ok;
  const { scopeMissing } = view;

  // ── Live storefront placement rows (inline button + floating embed) ──
  const inlineRow: PlacementRowProps = inlineOn
    ? {
        tone: "on",
        label: "Inline Try-On button is on your product page",
        actionLabel: "Open editor",
        onAction: onOpenInlineSetup,
      }
    : view.inlineButtonAdded === false
      ? {
          tone: "off",
          label: "Inline Try-On button isn't on your product page",
          helper: "Your main conversion placement — one click adds it.",
          actionLabel: "Add button",
          onAction: onOpenInlineSetup,
        }
      : {
          tone: "unknown",
          label: "Inline Try-On button — couldn't verify",
          helper: scopeMissing
            ? "Reload above so Ello can verify your theme."
            : "We can't auto-detect it on this theme. Use the button to add it if it isn't there.",
          actionLabel: "Add button",
          onAction: onOpenInlineSetup,
        };

  // The Ello app embed is the engine: it loads the widget on your storefront
  // and powers every try-on (the inline button included). So it leads, and its
  // CTA reassures merchants the only step is Save.
  const embedRow: PlacementRowProps = appEmbedOn
    ? {
        tone: "on",
        label: "Ello widget is on — powering try-ons across your store",
        actionLabel: "Open theme editor",
        onAction: onOpenAppEmbed,
      }
    : view.appEmbedPresentButDisabled
      ? {
          tone: "off",
          label: "Ello widget is turned off in your theme",
          helper: "Click Turn on — we re-enable it for you, then just click Save in the editor.",
          actionLabel: "Turn on",
          onAction: onOpenAppEmbed,
        }
      : view.appEmbedEnabled === false
        ? {
            tone: "off",
            label: "Ello widget isn't turned on yet",
            helper: "This powers every try-on. Click Turn on — we switch it on for you, then just click Save.",
            actionLabel: "Turn on",
            onAction: onOpenAppEmbed,
          }
        : {
            tone: "unknown",
            label: "Couldn't check if the Ello widget is on",
            helper: scopeMissing
              ? "Reload above so Ello can verify your theme."
              : "We couldn't read your theme just now — reload to retry.",
            actionLabel: "Turn on",
            onAction: onOpenAppEmbed,
          };

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="300" blockAlign="center">
            <IconChip source={StoreOnlineIcon} tone="neutral" size={34} />
            <Text as="h2" variant="headingMd">Storefront</Text>
          </InlineStack>
          {!isLoading && view.ok && storeConnected && storefrontLive && (
            <Badge tone="success">All systems operational</Badge>
          )}
        </InlineStack>

        {/* Only the LIVE read may raise the warning — while the cached snapshot
            paints (view.live=false) we stay quiet instead of flashing a scare
            banner that usually resolves itself a second later. */}
        {view.live && themeUnreadable && (
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
          <PlacementRow {...embedRow} icon={ThemeIcon} />
          <PlacementRow {...inlineRow} icon={ButtonIcon} />

          {/* Plain-language guide for placing the inline button under
              Add-to-cart on nested themes (Horizon). Shared component. */}
          <InlineButtonPlacementHelp />

          <InlineStack align="space-between" blockAlign="center">
            <InlineStack gap="300" blockAlign="center">
              <IconChip
                source={DatabaseConnectIcon}
                tone={storeConnected ? "good" : "watch"}
                size={34}
              />
              <Text as="span" variant="bodyMd">
                {storeConnected ? "Connected to Ello VTO Cloud" : "Connection issue — retrying"}
              </Text>
            </InlineStack>
            {!storeConnected && (
              <Button onClick={onRetrySync} variant="plain" size="slim" loading={isLoading}>
                Reconnect
              </Button>
            )}
          </InlineStack>
        </BlockStack>

        {/* Only surface the banner for a persistent error. Transient states are
            conveyed by the badges above; a mounting/unmounting banner reflows
            everything below it and hurts CLS. */}
        {syncData && !syncData.success && (
          <Box paddingBlockStart="200">
            <Banner
              tone="critical"
              title={syncData.retryable !== false ? "Connection Failed (Retrying...)" : "Connection Failed"}
            >
              <p>{syncData.message || syncData.error}</p>
              <div style={{ marginTop: "8px" }}>
                {syncData.retryable !== false && (
                  <Button onClick={onRetrySync} variant="plain" tone="critical">Try Again</Button>
                )}
              </div>
              {syncData.requestId && (
                <p style={{ marginTop: "0.5rem", fontSize: "11px", opacity: 0.8 }}>Ref: {syncData.requestId}</p>
              )}
            </Banner>
          </Box>
        )}
      </BlockStack>
    </Card>
  );
}

// ─── Skeletons (fixed sizes so streamed sections never shift layout) ────────
// Thin gray bars centered inside line boxes sized to the REAL rendered line
// heights, so skeleton and content occupy identical vertical space.
function LineBox({ height, width, bar = 12 }: { height: number; width: number | string; bar?: number }) {
  return (
    <div style={{ height, display: "flex", alignItems: "center" }}>
      <div style={{ width, height: bar, borderRadius: 3, background: brand.ink50 }} />
    </div>
  );
}

// HeadlineStrip = 1px rule + 12px pad + eyebrow line (~17) + 4 + 14.5px/1.55
// text line (~23) + 13px pad + 1px dashed ≈ 71px.
function HeadlineSkeleton() {
  return (
    <div style={{ borderTop: `1px solid ${brand.ink200}`, borderBottom: `1px dashed ${brand.ink200}`, padding: "12px 2px 13px" }}>
      <div style={{ marginBottom: 4 }}>
        <LineBox height={17} width={170} bar={11} />
      </div>
      <LineBox height={23} width="72%" bar={14} />
    </div>
  );
}

// Mirrors the hero card line for line. Left (gap 150 = 6px): eyebrow ~17,
// serif numeral ~48, delta ~18, mono meta ~17, conversion line ~20 → 144.
// Right (gap 300 = 12px): eyebrow ~17 + 3 × FunnelBar (label 19 + 4 + bar 9).
function HeroSkeleton() {
  return (
    <Card padding="500">
      <InlineGrid columns={{ xs: "1fr", md: "1fr 1fr" }} gap="500">
        <BlockStack gap="150">
          <LineBox height={17} width={130} bar={11} />
          <div style={{ width: 210, height: 48, borderRadius: 8, background: brand.ink50 }} />
          <LineBox height={18} width={120} />
          <LineBox height={17} width={230} bar={11} />
          <LineBox height={20} width={220} bar={13} />
        </BlockStack>
        <BlockStack gap="300">
          <LineBox height={17} width={165} bar={11} />
          {[0, 1, 2].map((i) => (
            <BlockStack key={i} gap="100">
              <LineBox height={19} width="100%" bar={13} />
              <div style={{ width: "100%", height: 9, borderRadius: 3, background: brand.ink50 }} />
            </BlockStack>
          ))}
        </BlockStack>
      </InlineGrid>
    </Card>
  );
}

function RecentRowsSkeleton() {
  return (
    <BlockStack gap="200">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            height: 58,
            border: `1px solid ${brand.ink100}`,
            borderRadius: 12,
            background: brand.ink50,
          }}
        />
      ))}
    </BlockStack>
  );
}

// ─── Storefront placement status row ───────────────────────────────────────
// The identity icon says WHAT the row is (theme embed, inline button); the
// chip tone + pill say its state — same semantic color system as analytics.
type PlacementRowProps = {
  tone: "on" | "off" | "unknown";
  label: string;
  helper?: string;
  actionLabel?: string;
  onAction?: () => void;
};

const PLACEMENT_PILL: Record<PlacementRowProps["tone"], { label: string; tone: Tone }> = {
  on: { label: "On", tone: "good" },
  off: { label: "Off", tone: "watch" },
  unknown: { label: "Check", tone: "neutral" },
};

function PlacementRow({ tone, icon, label, helper, actionLabel, onAction }: PlacementRowProps & { icon: IconSource }) {
  const pill = PLACEMENT_PILL[tone];
  return (
    <InlineStack align="space-between" blockAlign="center" wrap={false} gap="300">
      <InlineStack gap="300" blockAlign="center" wrap={false}>
        <IconChip source={icon} tone={pill.tone} size={34} />
        <BlockStack gap="050">
          <InlineStack gap="200" blockAlign="center">
            <Text as="span" variant="bodyMd">{label}</Text>
            <StatusPill label={pill.label} tone={pill.tone} />
          </InlineStack>
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

// ─── Onboarding checklist step ──────────────────────────────────────────────
function ChecklistStep({
  state,
  icon,
  label,
  action,
}: {
  state: "done" | "pending" | "waiting";
  icon: IconSource;
  label: string;
  action?: ReactNode;
}) {
  const done = state === "done";
  return (
    <InlineStack align="space-between" blockAlign="center">
      <InlineStack gap="300" blockAlign="center">
        <IconChip
          source={done ? CheckIcon : state === "waiting" ? ClockIcon : icon}
          tone={done ? "good" : state === "waiting" ? "watch" : "neutral"}
        />
        <Text as="span" variant="bodyMd" tone={done || state === "waiting" ? "subdued" : undefined}>
          {label}
        </Text>
      </InlineStack>
      {action}
    </InlineStack>
  );
}

// ─── Quick action tile ──────────────────────────────────────────────────────
function QuickAction({
  icon,
  label,
  sublabel,
  onClick,
}: {
  icon: IconSource;
  label: string;
  sublabel: string;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 14px",
        border: `1px solid ${hover ? brand.blue200 : brand.ink100}`,
        borderRadius: 12,
        background: hover ? brand.blue50 : brand.white,
        cursor: "pointer",
        textAlign: "left",
        width: "100%",
        fontFamily: "inherit",
        transition: "background 120ms ease, border-color 120ms ease",
      }}
    >
      <IconChip source={icon} tone={hover ? "money" : "neutral"} size={34} />
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: brand.ink }}>{label}</span>
        <span style={{ fontSize: 12, color: brand.ink500 }}>{sublabel}</span>
      </span>
    </button>
  );
}

// ─── Recent-session outcome → icon + tone + pill label ─────────────────────
const OUTCOME_META: Record<string, { icon: IconSource; tone: Tone; label: string }> = {
  purchased: { icon: CartSaleIcon, tone: "good", label: "Purchased" },
  carted: { icon: CartUpIcon, tone: "money", label: "Added to cart" },
  tried: { icon: CameraIcon, tone: "neutral", label: "Tried on" },
  browsed: { icon: ViewIcon, tone: "neutral", label: "Browsed" },
};

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
