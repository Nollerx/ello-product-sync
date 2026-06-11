import { useCallback, useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Badge,
  Banner,
  Box,
  Button,
  DataTable,
  Divider,
  Popover,
  ActionList,
  Tabs,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { resolveStorefront } from "../lib/storefront-names.server";
import { SectionHeading, brand } from "../components/ui";
import {
  LineSeries,
  FunnelBar,
  Heatmap,
  InsightsList,
  KpiTile,
  LockedCard,
  TimeRangeSelector,
} from "../components/analytics";
import { parseRange, pctDelta, rangeWindow } from "../lib/timerange";
import {
  buildInsights,
  buildSessions,
  dailySeries,
  deviceSplit,
  engagementStats,
  fetchCoreEvents,
  getCatalogCategories,
  getConversionSummary,
  getPlanTier,
  getPreviewMetrics,
  getPrevCounts,
  getProductConversion,
  getShopTimezone,
  getStoreContext,
  heatmapGrid,
  onboardingCohort,
  pageInsights,
  pathComparison,
  sessionFunnel,
  uploadFriction,
} from "../lib/analytics.server";
import { EXPORT_CATEGORIES } from "../lib/analytics-shared";

const TAB_KEYS = ["funnel", "performance", "engagement", "preview"] as const;
type TabKey = (typeof TAB_KEYS)[number];

const SURFACE_LABELS: Record<string, string> = {
  inline_button: "Inline button",
  floating_widget: "Floating widget",
  preview_popup: "Preview popup",
  unknown: "Other",
};

const PAGE_TYPE_LABELS: Record<string, string> = {
  product: "Product pages",
  collection: "Collections",
  home: "Home page",
  index: "Home page",
  cart: "Cart",
  search: "Search",
  unknown: "Other",
};

// ─── Loader ───────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const range = parseRange(url.searchParams.get("range"));
  const win = rangeWindow(range);

  const [store, tier, tz] = await Promise.all([
    getStoreContext(session.shop),
    getPlanTier(session.shop),
    getShopTimezone(admin, session.shop),
  ]);

  if (!store.slug) {
    return { hasStore: false as const, range, locked: false };
  }
  const slug = store.slug;

  const [core, summary, counts, prevCounts, productConv, preview] = await Promise.all([
    fetchCoreEvents(slug, win.from, win.to),
    getConversionSummary(slug, win.from, win.to),
    getPrevCounts(slug, win.from, win.to),
    getPrevCounts(slug, win.prevFrom, win.prevTo),
    getProductConversion(slug, win.from, win.to),
    store.storeId ? getPreviewMetrics(store.storeId, win.from, win.to) : Promise.resolve(null),
  ]);

  // Names + currency for every product we might display.
  const idToGid = (raw: string): string => (raw.startsWith("gid://") ? raw : `gid://shopify/Product/${raw}`);
  const cartByProduct = new Map<string, number>();
  for (const c of core.carts) {
    if (!c.product_id) continue;
    cartByProduct.set(c.product_id, (cartByProduct.get(c.product_id) ?? 0) + 1);
  }
  const allProductIds = Array.from(
    new Set([...productConv.map((p) => p.productId), ...cartByProduct.keys()].filter(Boolean)),
  );
  const { currencyCode, titles } = await resolveStorefront(
    store.shopDomain,
    store.storefrontToken,
    allProductIds.map(idToGid),
  );
  const nameOf = (pid: string) => titles.get(idToGid(pid)) ?? pid;

  const products = productConv
    .map((p) => ({
      productId: p.productId,
      name: nameOf(p.productId),
      tryons: p.tryons,
      carts: cartByProduct.get(p.productId) ?? 0,
      conversionPct: p.conversionPct,
      revenue: p.revenue,
    }))
    .sort((a, b) => b.tryons - a.tryons);

  const placement: Record<string, number> = {};
  for (const t of core.tryons) {
    const src = t.entry_source ?? "unknown";
    placement[src] = (placement[src] ?? 0) + 1;
  }

  const base = {
    hasStore: true as const,
    range,
    locked: tier.isFree,
    currencyCode,
    summary,
    totalTryons: counts.tryons,
    successCount: core.tryons.filter((t) => t.success).length,
    widgetOpens: counts.opens,
    deltas: {
      tryons: pctDelta(counts.tryons, prevCounts.tryons),
      opens: pctDelta(counts.opens, prevCounts.opens),
      carts: pctDelta(counts.carts, prevCounts.carts),
      revenue: pctDelta(summary?.revenue ?? 0, prevCounts.revenue),
    },
    dailyTryons: dailySeries(core.tryons.map((t) => t.created_at), tz, win.from, win.to),
    placement,
    topProducts: products.slice(0, 10),
  };

  // Free plan: basic analytics only — don't compute or ship the deep cuts.
  if (tier.isFree) {
    return { ...base, advanced: null };
  }

  const sessions = buildSessions(core);
  const funnel = sessionFunnel(sessions);
  const friction = uploadFriction(core.widgetEvents);
  const devices = deviceSplit(sessions);
  const paths = pathComparison(sessions);

  // Product health: tried a lot, bought rarely.
  const withTryons = products.filter((p) => p.tryons > 0);
  const avgConv =
    withTryons.length > 0
      ? withTryons.reduce((a, p) => a + (p.conversionPct ?? 0), 0) / withTryons.length
      : 0;
  const misfits = withTryons
    .filter((p) => p.tryons >= 5 && (p.conversionPct ?? 0) <= avgConv / 2)
    .slice(0, 10);

  const categories = await getCatalogCategories(slug, allProductIds);
  const catAgg = new Map<string, { tryons: number; carts: number; revenue: number }>();
  for (const p of products) {
    const cat = categories.get(p.productId) ?? "other";
    const e = catAgg.get(cat) ?? { tryons: 0, carts: 0, revenue: 0 };
    e.tryons += p.tryons;
    e.carts += p.carts;
    e.revenue += p.revenue;
    catAgg.set(cat, e);
  }

  // Engagement trend: of the opens each day, how many turned into a try-on (%).
  // Both series share the same shop-timezone day buckets, so zip by index.
  const opensDaily = dailySeries(
    core.widgetEvents.filter((e) => e.event_type === "widget_open").map((e) => e.created_at),
    tz,
    win.from,
    win.to,
  );
  const tryonsDaily = dailySeries(core.tryons.map((t) => t.created_at), tz, win.from, win.to);
  const engagementTrend = opensDaily.map((d, i) => {
    const tries = tryonsDaily[i]?.count ?? 0;
    return { day: d.day, count: d.count > 0 ? Math.min(100, Math.round((tries / d.count) * 100)) : 0 };
  });

  return {
    ...base,
    advanced: {
      funnel,
      cohort: onboardingCohort(sessions),
      paths,
      friction,
      devices,
      pages: pageInsights(sessions),
      engagement: engagementStats(sessions),
      engagementTrend,
      heatmap: heatmapGrid(core.tryons.map((t) => t.created_at), tz),
      insights: buildInsights({ funnel, friction, devices, paths, preview, misfits }),
      skuTable: products.slice(0, 100),
      misfits,
      categoryBreakdown: Array.from(catAgg.entries())
        .map(([category, v]) => ({ category, ...v }))
        .sort((a, b) => b.tryons - a.tryons),
      preview,
    },
  };
};

// ─── Page ─────────────────────────────────────────────────────────────────
export default function Analytics() {
  const data = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const tabParam = searchParams.get("tab") as TabKey | null;
  const selectedTab = Math.max(0, TAB_KEYS.indexOf(tabParam ?? "funnel"));

  const onTabSelect = useCallback(
    (index: number) => {
      const next = new URLSearchParams(searchParams);
      next.set("tab", TAB_KEYS[index]);
      setSearchParams(next, { preventScrollReset: true });
    },
    [searchParams, setSearchParams],
  );

  const downloadCsv = async (category: string) => {
    setExporting(true);
    try {
      const res = await fetch(`/app/analytics/export?category=${category}&range=${data.range}`);
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const text = await res.text();
      const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `ello-${category}-${data.range}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      console.error("CSV export failed:", err);
    } finally {
      setExporting(false);
      setExportOpen(false);
    }
  };

  if (!data.hasStore) {
    return (
      <Page title="Analytics">
        <Card padding="500">
          <BlockStack gap="200">
            <SectionHeading eyebrow="Analytics" title="No store data yet" />
            <Text as="p" tone="subdued">Finish onboarding to connect your store, then your try-on analytics appear here.</Text>
          </BlockStack>
        </Card>
      </Page>
    );
  }

  const money = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: data.currencyCode || "USD", maximumFractionDigits: 0 }).format(n);
  const t = data.summary;
  const adv = data.advanced;

  const tabs = [
    { id: "funnel", content: "Funnel" },
    { id: "performance", content: "Performance" },
    { id: "engagement", content: "Engagement" },
    { id: "preview", content: "Preview widget" },
  ];

  return (
    <Page title="Analytics" fullWidth>
      <BlockStack gap="400">
        {/* Controls row */}
        <InlineStack align="space-between" blockAlign="center">
          <TimeRangeSelector />
          <Popover
            active={exportOpen}
            onClose={() => setExportOpen(false)}
            activator={
              <Button onClick={() => setExportOpen((o) => !o)} disclosure loading={exporting}>
                Export CSV
              </Button>
            }
          >
            <ActionList
              items={EXPORT_CATEGORIES.map((c) => ({
                content: c.label,
                onAction: () => downloadCsv(c.key),
              }))}
            />
          </Popover>
        </InlineStack>

        {/* KPI row — visible on every plan */}
        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
          <KpiTile label="Attributed revenue" value={money(t?.revenue ?? 0)} delta={data.deltas.revenue} accent />
          <KpiTile
            label="Purchase conversion"
            value={t?.purchaseConversionPct != null ? `${t.purchaseConversionPct}%` : "—"}
            hint="Sessions that bought"
          />
          <KpiTile label="Widget opens" value={data.widgetOpens.toLocaleString()} delta={data.deltas.opens} />
          <KpiTile
            label="Total try-ons"
            value={data.totalTryons.toLocaleString()}
            delta={data.deltas.tryons}
            hint={`${data.successCount.toLocaleString()} successful`}
          />
        </InlineGrid>

        <Tabs tabs={tabs} selected={selectedTab} onSelect={onTabSelect} />

        {TAB_KEYS[selectedTab] === "funnel" && <FunnelTab data={data} money={money} />}
        {TAB_KEYS[selectedTab] === "performance" &&
          (adv ? <PerformanceTab data={data} money={money} /> : <BasicPerformance data={data} money={money} />)}
        {TAB_KEYS[selectedTab] === "engagement" &&
          (adv ? <EngagementTab data={data} /> : <LockedCard feature="Engagement analytics" />)}
        {TAB_KEYS[selectedTab] === "preview" &&
          (adv ? <PreviewTab data={data} /> : <LockedCard feature="Preview widget analytics" />)}
      </BlockStack>
    </Page>
  );
}

type LoaderData = Awaited<ReturnType<typeof loader>>;
type PageData = Extract<LoaderData, { hasStore: true }>;
type Money = (n: number) => string;

// ─── Funnel tab ─────────────────────────────────────────────────────────────
function FunnelTab({ data, money }: { data: PageData; money: Money }) {
  const t = data.summary;
  const adv = data.advanced;

  return (
    <BlockStack gap="500">
      {/* Daily volume — everyone */}
      <Card padding="500">
        <BlockStack gap="400">
          <SectionHeading eyebrow="Engagement" title="Daily try-ons" />
          <LineSeries data={data.dailyTryons} />
          <Divider />
          <InlineStack align="space-between">
            <Text as="span" variant="bodySm" tone="subdued">{data.dailyTryons[0]?.day}</Text>
            <Text as="span" variant="bodySm" tone="subdued">Today</Text>
          </InlineStack>
        </BlockStack>
      </Card>

      {!adv && (
        <>
          {/* Free plan: attributed funnel from the RPC + lock for the rest */}
          <Card padding="500">
            <BlockStack gap="400">
              <SectionHeading eyebrow="Journey" title="Conversion funnel" />
              {t ? (
                <BlockStack gap="300">
                  <FunnelBar label="Tried on" value={t.tryonSessions} max={t.tryonSessions} />
                  <FunnelBar label="Viewed product" value={t.viewed} max={t.tryonSessions} />
                  <FunnelBar label="Added to cart" value={t.addedToCart} max={t.tryonSessions} />
                  <FunnelBar label="Purchased" value={t.purchased} max={t.tryonSessions} />
                </BlockStack>
              ) : (
                <Text as="p" tone="subdued">No funnel data yet.</Text>
              )}
            </BlockStack>
          </Card>
          <LockedCard feature="The full session funnel" />
        </>
      )}

      {adv && (
        <>
          {/* Executive summary */}
          <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
            <KpiTile label="Unique opens" value={adv.funnel.uniqueOpens.toLocaleString()} delta={data.deltas.opens} />
            <KpiTile
              label="Activation rate"
              value={adv.funnel.activationPct != null ? `${adv.funnel.activationPct}%` : "—"}
              hint="Finished setup after opening"
            />
            <KpiTile
              label="Try-on → Cart"
              value={adv.funnel.tryonToCartPct != null ? `${adv.funnel.tryonToCartPct}%` : "—"}
              delta={data.deltas.carts}
            />
            <KpiTile
              label="Bounce rate"
              value={adv.funnel.bouncePct != null ? `${adv.funnel.bouncePct}%` : "—"}
              hint="Opened, did nothing"
            />
          </InlineGrid>

          {adv.funnel.dataQualityWarning && (
            <Banner tone="info" title="Some session events are missing">
              A few sessions skipped steps (returning shoppers or blocked trackers), so stage counts were smoothed to stay consistent.
            </Banner>
          )}

          <Layout>
            <Layout.Section>
              <BlockStack gap="500">
                {/* Session funnel */}
                <Card padding="500">
                  <BlockStack gap="400">
                    <SectionHeading
                      eyebrow="Journey"
                      title="Session funnel"
                      description="Every stage a shopper passes through, from opening the widget to buying."
                    />
                    <BlockStack gap="300">
                      {adv.funnel.stages.map((s) => (
                        <FunnelBar key={s.key} label={s.label} value={s.count} max={adv.funnel.stages[0]?.count ?? 1} />
                      ))}
                    </BlockStack>
                    {adv.funnel.biggestLeak && (
                      <div
                        style={{
                          border: `1px solid ${brand.ink100}`,
                          borderLeft: `4px solid ${brand.warning}`,
                          borderRadius: 10,
                          padding: "12px 14px",
                          background: brand.offwhite,
                        }}
                      >
                        <Text as="p" variant="bodySm">
                          <strong>Biggest leak:</strong> {adv.funnel.biggestLeak.lostPct}% drop from{" "}
                          {adv.funnel.biggestLeak.fromLabel.toLowerCase()} to {adv.funnel.biggestLeak.toLabel.toLowerCase()}.
                        </Text>
                      </div>
                    )}
                  </BlockStack>
                </Card>

                {/* Upload friction */}
                <Card padding="500">
                  <BlockStack gap="400">
                    <SectionHeading
                      eyebrow="Friction"
                      title="Photo uploads"
                      description="How often shoppers succeed when uploading their own photo."
                    />
                    {adv.friction.starts === 0 ? (
                      <Text as="p" tone="subdued">No photo uploads in this period.</Text>
                    ) : (
                      <BlockStack gap="300">
                        <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
                          <MiniMetric label="Uploads started" value={adv.friction.starts.toLocaleString()} />
                          <MiniMetric
                            label="Success rate"
                            value={adv.friction.successPct != null ? `${adv.friction.successPct}%` : "—"}
                            tone={(adv.friction.successPct ?? 100) < 75 ? "critical" : undefined}
                          />
                          <MiniMetric label="Failures" value={adv.friction.failures.toLocaleString()} />
                        </InlineGrid>
                        {adv.friction.byDevice.length > 0 && (
                          <DataTable
                            columnContentTypes={["text", "numeric", "numeric"]}
                            headings={["Device", "Uploads", "Success rate"]}
                            rows={adv.friction.byDevice.map((d) => [
                              capitalize(d.device),
                              d.starts.toLocaleString(),
                              d.successPct != null ? `${d.successPct}%` : "—",
                            ])}
                          />
                        )}
                        {adv.friction.topReasons.length > 0 && (
                          <Text as="p" variant="bodySm" tone="subdued">
                            Top failure reasons: {adv.friction.topReasons.map((r) => `${r.reason} (${r.count})`).join(" · ")}
                          </Text>
                        )}
                      </BlockStack>
                    )}
                  </BlockStack>
                </Card>

                {/* Insights */}
                <Card padding="500">
                  <BlockStack gap="400">
                    <SectionHeading eyebrow="Recommendations" title="Insights" />
                    <InsightsList insights={adv.insights} />
                  </BlockStack>
                </Card>
              </BlockStack>
            </Layout.Section>

            <Layout.Section variant="oneThird">
              <BlockStack gap="500">
                {/* Purchase attribution */}
                <Card padding="500">
                  <BlockStack gap="300">
                    <SectionHeading eyebrow="Attribution" title="Purchases" />
                    <MiniMetric label="Attributed revenue" value={money(t?.revenue ?? 0)} accent />
                    <MiniMetric label="Sessions that purchased" value={(t?.purchased ?? 0).toLocaleString()} />
                    <MiniMetric
                      label="Purchase conversion"
                      value={t?.purchaseConversionPct != null ? `${t.purchaseConversionPct}%` : "—"}
                    />
                  </BlockStack>
                </Card>

                {/* First-time users */}
                <Card padding="500">
                  <BlockStack gap="300">
                    <SectionHeading eyebrow="Onboarding" title="First-time shoppers" />
                    {adv.cohort.firstTimeSessions === 0 ? (
                      <Text as="p" tone="subdued">No first-time sessions yet.</Text>
                    ) : (
                      <BlockStack gap="300">
                        <FunnelBar label="Saw the intro" value={adv.cohort.firstTimeSessions} max={adv.cohort.firstTimeSessions} />
                        <FunnelBar label="Chose to continue" value={adv.cohort.decided} max={adv.cohort.firstTimeSessions} />
                        <FunnelBar label="Finished setup" value={adv.cohort.setupComplete} max={adv.cohort.firstTimeSessions} />
                      </BlockStack>
                    )}
                  </BlockStack>
                </Card>

                {/* Path comparison */}
                <Card padding="500">
                  <BlockStack gap="300">
                    <SectionHeading
                      eyebrow="Setup paths"
                      title="Model vs upload"
                      description="How shoppers who pick a model compare with those who upload a photo."
                    />
                    {adv.paths.every((p) => p.sessions === 0) ? (
                      <Text as="p" tone="subdued">No setup sessions yet.</Text>
                    ) : (
                      <DataTable
                        columnContentTypes={["text", "numeric", "numeric", "numeric"]}
                        headings={["Path", "Sessions", "Tried on", "Carted"]}
                        rows={adv.paths.map((p) => [
                          p.label,
                          p.sessions.toLocaleString(),
                          p.tryonPct != null ? `${p.tryonPct}%` : "—",
                          p.cartPct != null ? `${p.cartPct}%` : "—",
                        ])}
                      />
                    )}
                  </BlockStack>
                </Card>

                {/* Device split */}
                <Card padding="500">
                  <BlockStack gap="300">
                    <SectionHeading eyebrow="Devices" title="Mobile vs desktop" />
                    {adv.devices.length === 0 ? (
                      <Text as="p" tone="subdued">No sessions yet.</Text>
                    ) : (
                      <DataTable
                        columnContentTypes={["text", "numeric", "numeric", "numeric"]}
                        headings={["Device", "Opens", "Try-ons", "Cart rate"]}
                        rows={adv.devices.map((d) => [
                          capitalize(d.device),
                          d.opens.toLocaleString(),
                          d.tryons.toLocaleString(),
                          d.cartPct != null ? `${d.cartPct}%` : "—",
                        ])}
                      />
                    )}
                  </BlockStack>
                </Card>
              </BlockStack>
            </Layout.Section>
          </Layout>
        </>
      )}
    </BlockStack>
  );
}

// ─── Performance tab ────────────────────────────────────────────────────────
function BasicPerformance({ data, money }: { data: PageData; money: Money }) {
  return (
    <BlockStack gap="500">
      <TopProductsCard data={data} money={money} />
      <LockedCard feature="Page & product performance" />
    </BlockStack>
  );
}

function TopProductsCard({ data, money }: { data: PageData; money: Money }) {
  return (
    <Card padding="500">
      <BlockStack gap="400">
        <SectionHeading eyebrow="Catalog" title="Most tried-on products" />
        {data.topProducts.length === 0 ? (
          <Box paddingBlock="400"><Text as="p" tone="subdued">No products have been tried on yet.</Text></Box>
        ) : (
          <DataTable
            columnContentTypes={["text", "numeric", "numeric", "numeric"]}
            headings={["Product", "Try-ons", "Conversion", "Revenue"]}
            rows={data.topProducts.map((p) => [
              p.name,
              p.tryons.toLocaleString(),
              p.conversionPct != null ? `${p.conversionPct}%` : "—",
              money(p.revenue),
            ])}
          />
        )}
      </BlockStack>
    </Card>
  );
}

function PerformanceTab({ data, money }: { data: PageData; money: Money }) {
  const adv = data.advanced;
  if (!adv) return null;

  const placementEntries = Object.entries(data.placement).sort((a, b) => b[1] - a[1]);

  return (
    <BlockStack gap="500">
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {/* Funnel by page type */}
            <Card padding="500">
              <BlockStack gap="400">
                <SectionHeading
                  eyebrow="Pages"
                  title="Where the widget works"
                  description="Opens, try-ons, and cart adds by the page a shopper started on."
                />
                {adv.pages.length === 0 ? (
                  <Text as="p" tone="subdued">No page data yet.</Text>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "numeric", "numeric", "numeric"]}
                    headings={["Page type", "Opens", "Try-on sessions", "Cart sessions"]}
                    rows={adv.pages.map((p) => [
                      PAGE_TYPE_LABELS[p.pageType] ?? capitalize(p.pageType),
                      p.opens.toLocaleString(),
                      p.tryons.toLocaleString(),
                      p.carts.toLocaleString(),
                    ])}
                  />
                )}
              </BlockStack>
            </Card>

            {/* Full SKU table */}
            <Card padding="500">
              <BlockStack gap="400">
                <SectionHeading
                  eyebrow="Catalog"
                  title="Product performance"
                  description="Every product with try-on activity in this period."
                />
                {adv.skuTable.length === 0 ? (
                  <Box paddingBlock="400"><Text as="p" tone="subdued">No products have been tried on yet.</Text></Box>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric"]}
                    headings={["Product", "Try-ons", "Cart adds", "Conversion", "Revenue"]}
                    rows={adv.skuTable.map((p) => [
                      p.name,
                      p.tryons.toLocaleString(),
                      p.carts.toLocaleString(),
                      p.conversionPct != null ? `${p.conversionPct}%` : "—",
                      money(p.revenue),
                    ])}
                  />
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="500">
            {/* Placement */}
            <Card padding="500">
              <BlockStack gap="300">
                <SectionHeading eyebrow="Sources" title="Where try-ons start" />
                {placementEntries.length === 0 ? (
                  <Text as="p" tone="subdued">No try-ons yet.</Text>
                ) : (
                  <BlockStack gap="200">
                    {placementEntries.map(([src, count]) => (
                      <InlineStack key={src} align="space-between" blockAlign="center">
                        <Text as="span" variant="bodySm">{SURFACE_LABELS[src] ?? src}</Text>
                        <Badge>{count.toLocaleString()}</Badge>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            {/* Product health */}
            <Card padding="500">
              <BlockStack gap="300">
                <SectionHeading
                  eyebrow="Product health"
                  title="Fit-risk products"
                  description="High try-ons, low conversion — often a sizing or photo problem."
                />
                {adv.misfits.length === 0 ? (
                  <Text as="p" tone="subdued">Nothing flagged. Products convert in line with your average.</Text>
                ) : (
                  <BlockStack gap="200">
                    {adv.misfits.map((m) => (
                      <InlineStack key={m.productId} align="space-between" blockAlign="center">
                        <Text as="span" variant="bodySm">{m.name}</Text>
                        <Badge tone="warning">{`${m.tryons} try-ons · ${m.conversionPct ?? 0}%`}</Badge>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            {/* Category breakdown */}
            <Card padding="500">
              <BlockStack gap="300">
                <SectionHeading eyebrow="Categories" title="By category" />
                {adv.categoryBreakdown.length === 0 ? (
                  <Text as="p" tone="subdued">No category data yet.</Text>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "numeric", "numeric"]}
                    headings={["Category", "Try-ons", "Revenue"]}
                    rows={adv.categoryBreakdown.map((c) => [
                      capitalize(c.category),
                      c.tryons.toLocaleString(),
                      money(c.revenue),
                    ])}
                  />
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </BlockStack>
  );
}

// ─── Engagement tab ─────────────────────────────────────────────────────────
function EngagementTab({ data }: { data: PageData }) {
  const adv = data.advanced;
  if (!adv) return null;

  return (
    <BlockStack gap="500">
      <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
        <KpiTile
          label="Open → try-on rate"
          value={adv.engagement.openToTryonPct != null ? `${adv.engagement.openToTryonPct}%` : "—"}
          hint="Sessions that tried something on"
        />
        <KpiTile
          label="Avg try-ons per session"
          value={adv.engagement.avgTryonsPerSession != null ? String(adv.engagement.avgTryonsPerSession) : "—"}
        />
        <KpiTile
          label="Multi-try sessions"
          value={adv.engagement.multiTryPct != null ? `${adv.engagement.multiTryPct}%` : "—"}
          hint="Tried 2+ items"
        />
      </InlineGrid>

      <Card padding="500">
        <BlockStack gap="400">
          <SectionHeading
            eyebrow="Trend"
            title="Engagement rate over time"
            description="Of the shoppers who open the widget each day, how many try something on (%)."
          />
          <LineSeries data={adv.engagementTrend} height={120} />
        </BlockStack>
      </Card>

      <Card padding="500">
        <BlockStack gap="400">
          <SectionHeading
            eyebrow="Timing"
            title="Peak try-on times"
            description="Day of week × hour of day, in your store's timezone."
          />
          <Heatmap grid={adv.heatmap} />
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

// ─── Preview widget tab ─────────────────────────────────────────────────────
function PreviewTab({ data }: { data: PageData }) {
  const adv = data.advanced;
  if (!adv) return null;
  const p = adv.preview;

  if (!p || p.impressions === 0) {
    return (
      <Card padding="500">
        <BlockStack gap="200">
          <SectionHeading eyebrow="Preview widget" title="No preview activity yet" />
          <Text as="p" tone="subdued">
            The desktop preview popup hasn&apos;t been shown in this period. Enable it in Widget Design to invite desktop shoppers to try items on.
          </Text>
        </BlockStack>
      </Card>
    );
  }

  const pct = (n: number) => (p.impressions > 0 ? Math.round((n / p.impressions) * 100) : 0);

  return (
    <BlockStack gap="500">
      <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
        <KpiTile label="Impressions" value={p.impressions.toLocaleString()} hint="Preview popups shown" />
        <KpiTile label="Engagement" value={`${pct(p.engagements)}%`} hint={`${p.engagements.toLocaleString()} clicks`} />
        <KpiTile label="Try-ons completed" value={p.tryonCompleted.toLocaleString()} hint={p.tryonFailed > 0 ? `${p.tryonFailed} failed` : undefined} />
        <KpiTile label="Dismissed forever" value={`${pct(p.dismissedForever)}%`} hint={`${p.dismissedForever.toLocaleString()} shoppers`} />
      </InlineGrid>

      <Layout>
        <Layout.Section>
          <Card padding="500">
            <BlockStack gap="400">
              <SectionHeading eyebrow="Trend" title="Daily preview activity" />
              <LineSeries data={p.daily.map((d) => ({ day: d.day, count: d.impressions }))} height={120} />
              <Text as="span" variant="bodySm" tone="subdued">Impressions per day</Text>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section variant="oneThird">
          <Card padding="500">
            <BlockStack gap="300">
              <SectionHeading eyebrow="Journey" title="Preview funnel" />
              <FunnelBar label="Shown" value={p.impressions} max={p.impressions} />
              <FunnelBar label="Engaged" value={p.engagements} max={p.impressions} />
              <FunnelBar label="Photo uploaded" value={p.photoUploaded} max={p.impressions} />
              <FunnelBar label="Try-on completed" value={p.tryonCompleted} max={p.impressions} />
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </BlockStack>
  );
}

// ─── Small helpers ──────────────────────────────────────────────────────────
function MiniMetric({
  label,
  value,
  accent,
  tone,
}: {
  label: string;
  value: string;
  accent?: boolean;
  tone?: "critical";
}) {
  return (
    <div style={{ border: `1px solid ${brand.ink100}`, borderRadius: 12, background: brand.offwhite, padding: "12px 14px" }}>
      <div style={{ fontSize: 12, color: brand.ink500, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: tone === "critical" ? brand.danger : accent ? brand.blue : brand.ink }}>
        {value}
      </div>
    </div>
  );
}

function capitalize(s: string) {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}
