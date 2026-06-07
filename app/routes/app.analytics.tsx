import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Badge,
  DataTable,
  Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../lib/supabase.server";

const WINDOW_DAYS = 30;

interface ProductRow {
  productId: string;
  name: string;
  tryons: number;
  conversionPct: number | null;
  revenue: number;
}

// ─── Loader ───────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const { data: store } = await supabaseAdmin
    .from("vto_stores")
    .select("store_slug")
    .eq("shop_domain", session.shop)
    .maybeSingle();

  const slug = (store?.store_slug as string | undefined) ?? null;

  if (!slug) {
    return {
      hasStore: false as const,
      currencyCode: "USD",
      totals: null,
      totalTryons: 0,
      successCount: 0,
      bySurface: {} as Record<string, number>,
      daily: [] as Array<{ day: string; count: number }>,
      products: [] as ProductRow[],
      widgetOpens: 0,
    };
  }

  const to = new Date();
  const from = new Date(to.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  // Pull everything we can in parallel. Each guarded so one failure doesn't
  // blank the whole page.
  const [summaryRes, productConvRes, opensRes, eventsRes, countRes] =
    await Promise.all([
      supabaseAdmin.rpc("get_vto_conversion_summary", {
        p_store_slug: slug,
        p_from: fromIso,
        p_to: toIso,
      }),
      supabaseAdmin.rpc("get_vto_product_conversion", {
        p_store_slug: slug,
        p_from: fromIso,
        p_to: toIso,
      }),
      supabaseAdmin.rpc("get_widget_opens_summary", {
        p_store_slug: slug,
        p_from: fromIso,
        p_to: toIso,
      }),
      supabaseAdmin
        .from("tryon_events")
        .select("created_at, success, entry_source")
        .eq("store_slug", slug)
        .gte("created_at", fromIso)
        .lt("created_at", toIso)
        .order("created_at", { ascending: false })
        .limit(1000),
      supabaseAdmin
        .from("tryon_events")
        .select("*", { count: "exact", head: true })
        .eq("store_slug", slug)
        .gte("created_at", fromIso)
        .lt("created_at", toIso),
    ]);

  const summaryRow = Array.isArray(summaryRes.data) ? summaryRes.data[0] : null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const summary = (summaryRow as any) ?? null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const productConv = (productConvRes.data as any[] | null) ?? [];

  // get_widget_opens_summary returns a JSONB object with totals.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opens = (opensRes.data as any) ?? null;
  const widgetOpens = Number(opens?.total_opens ?? opens?.totalOpens ?? 0) || 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events = (eventsRes.data as any[] | null) ?? [];
  const totalTryons = countRes.count ?? events.length;

  // Aggregate by surface + daily series from the sampled events.
  const bySurface: Record<string, number> = {};
  let successCount = 0;
  const dailyMap = new Map<string, number>();
  for (const ev of events) {
    if (ev.success) successCount += 1;
    const src = (ev.entry_source as string | null) ?? "unknown";
    bySurface[src] = (bySurface[src] ?? 0) + 1;
    const day = String(ev.created_at).slice(0, 10);
    dailyMap.set(day, (dailyMap.get(day) ?? 0) + 1);
  }

  // Build a continuous last-30-days series so the chart has no gaps.
  const daily: Array<{ day: string; count: number }> = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(to.getTime() - i * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    daily.push({ day: d, count: dailyMap.get(d) ?? 0 });
  }

  // Resolve product names + shop currency in a single admin GraphQL call.
  const topProducts = productConv.slice(0, 10);
  const idToGid = (raw: string): string =>
    raw.startsWith("gid://") ? raw : `gid://shopify/Product/${raw}`;
  const gids = topProducts
    .map((p) => (p.product_id ? idToGid(String(p.product_id)) : null))
    .filter((g): g is string => Boolean(g));

  let currencyCode = "USD";
  const nameByGid = new Map<string, string>();
  try {
    const resp = await admin.graphql(
      `#graphql
      query AnalyticsMeta($ids: [ID!]!) {
        shop { currencyCode }
        nodes(ids: $ids) { ... on Product { id title } }
      }`,
      { variables: { ids: gids } },
    );
    const json = await resp.json();
    currencyCode = json?.data?.shop?.currencyCode ?? "USD";
    for (const node of json?.data?.nodes ?? []) {
      if (node?.id && node?.title) nameByGid.set(node.id, node.title);
    }
  } catch (err) {
    console.error("[analytics] product/currency lookup failed (non-fatal):", err);
  }

  const products: ProductRow[] = topProducts.map((p) => {
    const pid = String(p.product_id ?? "");
    const name = nameByGid.get(idToGid(pid)) ?? (pid || "Unknown product");
    return {
      productId: pid,
      name,
      tryons: Number(p.tryons ?? 0),
      conversionPct: p.conversion_pct != null ? Number(p.conversion_pct) : null,
      revenue: Number(p.attributed_revenue ?? 0),
    };
  });

  return {
    hasStore: true as const,
    currencyCode,
    totals: summary
      ? {
          tryonSessions: Number(summary.tryon_sessions ?? 0),
          viewed: Number(summary.sessions_viewed_product ?? 0),
          addedToCart: Number(summary.sessions_added_to_cart ?? 0),
          purchased: Number(summary.sessions_purchased ?? 0),
          revenue: Number(summary.attributed_revenue ?? 0),
          purchaseConversionPct:
            summary.purchase_conversion_pct != null
              ? Number(summary.purchase_conversion_pct)
              : null,
        }
      : null,
    totalTryons,
    successCount,
    bySurface,
    daily,
    products,
    widgetOpens,
  };
};

// ─── UI helpers ─────────────────────────────────────────────────────────────
function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
        <Text as="span" variant="headingXl">{value}</Text>
        {hint && <Text as="span" variant="bodySm" tone="subdued">{hint}</Text>}
      </BlockStack>
    </Card>
  );
}

function FunnelRow({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <BlockStack gap="100">
      <InlineStack align="space-between">
        <Text as="span" variant="bodySm">{label}</Text>
        <Text as="span" variant="bodySm" tone="subdued">{value.toLocaleString()}</Text>
      </InlineStack>
      <div style={{ height: 10, background: "#ECEEF3", borderRadius: 6, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: "#3B63D4", borderRadius: 6 }} />
      </div>
    </BlockStack>
  );
}

const SURFACE_LABELS: Record<string, string> = {
  inline_button: "Inline button",
  floating_widget: "Floating widget",
  preview_popup: "Preview popup",
  unknown: "Other",
};

// ─── Page ─────────────────────────────────────────────────────────────────
export default function Analytics() {
  const data = useLoaderData<typeof loader>();
  const money = (n: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: data.currencyCode || "USD",
      maximumFractionDigits: 0,
    }).format(n);

  if (!data.hasStore) {
    return (
      <Page title="Analytics">
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">No store data yet</Text>
            <Text as="p" tone="subdued">
              Finish onboarding to connect your store, then your try-on analytics will appear here.
            </Text>
          </BlockStack>
        </Card>
      </Page>
    );
  }

  const t = data.totals;
  const maxDaily = Math.max(1, ...data.daily.map((d) => d.count));
  const funnelMax = t ? Math.max(1, t.tryonSessions) : 1;

  const productRows = data.products.map((p) => [
    p.name,
    p.tryons.toLocaleString(),
    p.conversionPct != null ? `${p.conversionPct}%` : "—",
    money(p.revenue),
  ]);

  const isEmpty = data.totalTryons === 0;

  return (
    <Page
      title="Analytics"
      subtitle={`Last ${WINDOW_DAYS} days`}
    >
      <BlockStack gap="400">
        {isEmpty && (
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">No try-ons yet in this window</Text>
              <Text as="p" tone="subdued">
                Once shoppers start using the Try-On button, revenue, conversion, and
                product insights will populate here automatically.
              </Text>
            </BlockStack>
          </Card>
        )}

        {/* KPI row */}
        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
          <Kpi
            label="Attributed revenue"
            value={t ? money(t.revenue) : money(0)}
            hint="Orders after a try-on"
          />
          <Kpi
            label="Purchase conversion"
            value={t && t.purchaseConversionPct != null ? `${t.purchaseConversionPct}%` : "—"}
            hint="Try-on sessions that bought"
          />
          <Kpi
            label="Try-on sessions"
            value={(t?.tryonSessions ?? 0).toLocaleString()}
            hint="Unique shoppers"
          />
          <Kpi
            label="Total try-ons"
            value={data.totalTryons.toLocaleString()}
            hint={`${data.successCount.toLocaleString()} successful`}
          />
        </InlineGrid>

        <Layout>
          {/* Daily try-ons chart */}
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Daily try-ons</Text>
                <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 140 }}>
                  {data.daily.map((d) => (
                    <div
                      key={d.day}
                      title={`${d.day}: ${d.count}`}
                      style={{
                        flex: 1,
                        height: `${Math.max(2, (d.count / maxDaily) * 100)}%`,
                        background: d.count > 0 ? "#3B63D4" : "#ECEEF3",
                        borderRadius: 3,
                        transition: "height 200ms ease",
                      }}
                    />
                  ))}
                </div>
                <InlineStack align="space-between">
                  <Text as="span" variant="bodySm" tone="subdued">
                    {data.daily[0]?.day}
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {data.daily[data.daily.length - 1]?.day}
                  </Text>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* Funnel + surface */}
          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Conversion funnel</Text>
                  {t ? (
                    <BlockStack gap="300">
                      <FunnelRow label="Tried on" value={t.tryonSessions} max={funnelMax} />
                      <FunnelRow label="Viewed product" value={t.viewed} max={funnelMax} />
                      <FunnelRow label="Added to cart" value={t.addedToCart} max={funnelMax} />
                      <FunnelRow label="Purchased" value={t.purchased} max={funnelMax} />
                    </BlockStack>
                  ) : (
                    <Text as="p" tone="subdued">No funnel data yet.</Text>
                  )}
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">By placement</Text>
                  {Object.keys(data.bySurface).length === 0 ? (
                    <Text as="p" tone="subdued">No try-ons yet.</Text>
                  ) : (
                    <BlockStack gap="200">
                      {Object.entries(data.bySurface)
                        .sort((a, b) => b[1] - a[1])
                        .map(([src, count]) => (
                          <InlineStack key={src} align="space-between">
                            <Text as="span" variant="bodySm">
                              {SURFACE_LABELS[src] ?? src}
                            </Text>
                            <Badge>{count.toLocaleString()}</Badge>
                          </InlineStack>
                        ))}
                      <Divider />
                      <InlineStack align="space-between">
                        <Text as="span" variant="bodySm" tone="subdued">Widget opens</Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {data.widgetOpens.toLocaleString()}
                        </Text>
                      </InlineStack>
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>

        {/* Most tried-on products */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Most tried-on products</Text>
            {productRows.length === 0 ? (
              <Text as="p" tone="subdued">No products have been tried on yet.</Text>
            ) : (
              <DataTable
                columnContentTypes={["text", "numeric", "numeric", "numeric"]}
                headings={["Product", "Try-ons", "Conversion", "Revenue"]}
                rows={productRows}
              />
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
