// Visual QA playground for the Editorial Ledger admin overhaul. Renders the
// real production components (ui.tsx + analytics.tsx) with representative data
// so the design can be screenshotted without a Shopify session. Dev-only —
// never imported by the app.
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { AppProvider as PolarisAppProvider, Card, BlockStack, InlineGrid, Text } from "@shopify/polaris";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import "@shopify/polaris/build/esm/styles.css";
import "../../app/styles/admin-theme.css";

import { brand, Eyebrow, MonoMeta, PageHeader, PillButton, SectionHeading, Stat, fonts, tnum } from "../../app/components/ui";
import {
  Delta,
  DailyPerformanceCard,
  Funnel,
  FunnelBar,
  HeadlineStrip,
  Heatmap,
  KpiBand,
  KpiTile,
  LineSeries,
  LockedCard,
  TimeRangeSelector,
  TrendChart,
  verdictFromDelta,
} from "../../app/components/analytics";

const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

// 90 days of plausible dailies with the real totals' shape (spiky revenue,
// wavy try-ons peaking late July).
const days = Array.from({ length: 90 }, (_, i) => {
  const d = new Date(2026, 4, 11 + i);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
});
const tryons = days.map((_, i) => {
  const base = 6 + Math.round(4 * Math.sin(i / 5));
  const surge = i > 55 && i < 75 ? Math.round(60 * Math.exp(-((i - 66) ** 2) / 40)) : 0;
  return Math.max(0, base + surge);
});
const carts = tryons.map((t, i) => (i > 55 && t > 20 ? Math.round(t / 18) : i % 13 === 0 ? 1 : 0));
const revenue = days.map((_, i) => (i === 28 ? 820 : i === 41 ? 1156 : i === 66 ? 3370 : i === 69 ? 1100 : 0));

function Playground() {
  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: "28px 24px 64px", fontFamily: "'Inter', -apple-system, sans-serif" }}>
      <BlockStack gap="500">
        <PageHeader
          kicker="The data behind the try-on"
          title="Analytics"
          actions={
            <>
              <TimeRangeSelector />
              <PillButton variant="primary">Export CSV</PillButton>
            </>
          }
        />

        <HeadlineStrip>
          Try-ons drove <Text as="span" fontWeight="semibold">$6,446</Text> in sales, up 212%. Your weak spot: a{" "}
          <Text as="span" fontWeight="semibold">96%</Text> drop from tried on to added to cart.
        </HeadlineStrip>

        <KpiBand
          tiles={[
            { label: "Attributed revenue", value: "$6,446", delta: 212, accent: true, status: verdictFromDelta(212), hint: "90d · orders after a try-on" },
            { label: "Buy rate after try-on", value: "6.9%", hint: "sessions that bought" },
            { label: "Shoppers who opened it", value: "1,503", delta: 12, status: verdictFromDelta(12) },
            { label: "Total try-ons", value: "1,140", delta: 4, hint: "1,090 successful", status: verdictFromDelta(4) },
          ]}
        />

        <DailyPerformanceCard
          revenue={days.map((day, i) => ({ day, value: revenue[i] }))}
          tryons={days.map((day, i) => ({ day, value: tryons[i] }))}
          carts={days.map((day, i) => ({ day, value: carts[i] }))}
          totals={{ revenue: 6446, tryons: 1140, carts: 43 }}
          deltas={{ revenue: 212, tryons: 4, carts: 438 }}
          formatMoney={money}
          rangeDays={90}
          cartConversionPct={2}
        />

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="500">
          <Card padding="500">
            <BlockStack gap="400">
              <SectionHeading eyebrow="Journey" title="Session funnel" description="Every stage from opening the widget to buying." />
              <Funnel
                stages={[
                  { key: "opens", label: "Widget opens", value: 1503 },
                  { key: "tryons", label: "Try-ons", value: 1140 },
                  { key: "cart", label: "Cart adds", value: 43 },
                  { key: "purchased", label: "Purchased", value: 21 },
                ]}
              />
            </BlockStack>
          </Card>
          <BlockStack gap="500">
            <Card padding="500">
              <BlockStack gap="300">
                <Eyebrow>Widget-to-cart journey</Eyebrow>
                <FunnelBar label="Widget opens" value={1503} max={1503} />
                <FunnelBar label="Try-ons" value={1140} max={1503} />
                <FunnelBar label="Cart adds" value={43} max={1503} />
              </BlockStack>
            </Card>
            <Stat label="Attributed revenue" value="$6,446" hint="90d · verified window" accent />
          </BlockStack>
        </InlineGrid>

        <Card padding="500">
          <BlockStack gap="400">
            <SectionHeading eyebrow="Trend" title="Engagement rate over time" />
            <LineSeries data={days.map((day, i) => ({ day, count: Math.max(1, Math.round(30 + 12 * Math.sin(i / 7))) }))} height={120} />
          </BlockStack>
        </Card>

        <Card padding="500">
          <BlockStack gap="400">
            <SectionHeading eyebrow="Timing" title="Peak try-on times" />
            <Heatmap
              grid={Array.from({ length: 7 }, (_, d) =>
                Array.from({ length: 24 }, (_, h) => (h > 8 && h < 23 ? Math.max(0, Math.round(8 * Math.sin(((h - 8) / 14) * Math.PI) + (d >= 5 ? 4 : 0))) : 0)),
              )}
            />
          </BlockStack>
        </Card>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="500">
          <LockedCard feature="Engagement analytics" />
          <Card padding="500">
            <BlockStack gap="400">
              <SectionHeading eyebrow="Multi-series" title="Daily activity" />
              <TrendChart
                days={days}
                series={[
                  { label: "Try-ons", color: brand.blue, values: tryons, area: true },
                  { label: "Cart adds", color: brand.success, values: carts },
                  { label: "Conversion", color: brand.ink500, values: tryons.map((t, i) => (t > 0 ? Math.round((carts[i] / t) * 100) : 0)), dashed: true, axis: "right", suffix: "%" },
                ]}
              />
            </BlockStack>
          </Card>
        </InlineGrid>

        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <Delta value={212} />
          <Delta value={-31} />
          <Delta value={0} />
          <MonoMeta>90d · orders after a try-on</MonoMeta>
          <span style={{ fontFamily: fonts.serif, fontSize: 27, ...tnum }}>1,140</span>
        </div>
      </BlockStack>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <MemoryRouter>
    <PolarisAppProvider i18n={polarisTranslations}>
      <Playground />
    </PolarisAppProvider>
  </MemoryRouter>,
);
