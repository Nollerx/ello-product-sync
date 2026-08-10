// TEMPORARY QA probe (safe to delete): measures the Home revenue-hero card vs
// HeroSkeleton. JSX for both blocks is copied verbatim from
// app/routes/app._index.tsx (fixtures inlined) so rendered heights are the
// real thing. Never imported by the app.
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { AppProvider as PolarisAppProvider, Card, BlockStack, InlineGrid, Text } from "@shopify/polaris";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import "@shopify/polaris/build/esm/styles.css";
import "../../app/styles/admin-theme.css";

import { brand, Eyebrow, MonoMeta, fonts, tnum } from "../../app/components/ui";
import { Delta, FunnelBar } from "../../app/components/analytics";

const m = {
  attributedRevenue: 6446,
  revenueDelta: 212,
  purchaseConversionPct: 6.9,
  widgetOpens: 1503,
  totalTryons: 1140,
  totalCartAdds: 43,
};
const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
const RANGE_DAYS_range = 90;

// ── Verbatim copy of the resolved hero card (app._index.tsx ~632-668) ──
function HeroResolved() {
  return (
    <Card padding="500">
      <InlineGrid columns={{ xs: "1fr", md: "1fr 1fr" }} gap="500">
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
            {money(m.attributedRevenue)}
          </span>
          <Delta value={m.revenueDelta} />
          <MonoMeta>{RANGE_DAYS_range}d · orders placed after a try-on</MonoMeta>
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
  );
}

// ── Verbatim copy of HeroSkeleton (app._index.tsx ~1206-1229) ──
function HeroSkeleton() {
  return (
    <Card padding="500">
      <InlineGrid columns={{ xs: "1fr", md: "1fr 1fr" }} gap="500">
        <BlockStack gap="150">
          <div style={{ width: 130, height: 15, borderRadius: 3, background: brand.ink50 }} />
          <div style={{ width: 210, height: 48, borderRadius: 8, background: brand.ink50 }} />
          <div style={{ width: 120, height: 16, borderRadius: 4, background: brand.ink50 }} />
          <div style={{ width: 230, height: 12, borderRadius: 3, background: brand.ink50 }} />
          <div style={{ width: 220, height: 14, borderRadius: 4, background: brand.ink50 }} />
        </BlockStack>
        <BlockStack gap="300">
          <div style={{ width: 165, height: 15, borderRadius: 3, background: brand.ink50 }} />
          {[0, 1, 2].map((i) => (
            <BlockStack key={i} gap="100">
              <div style={{ width: "100%", height: 16, borderRadius: 4, background: brand.ink50 }} />
              <div style={{ width: "100%", height: 9, borderRadius: 3, background: brand.ink50 }} />
            </BlockStack>
          ))}
        </BlockStack>
      </InlineGrid>
    </Card>
  );
}

function Probe() {
  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: 24 }}>
      <div id="resolved">
        <HeroResolved />
      </div>
      <div style={{ height: 32 }} />
      <div id="skeleton">
        <HeroSkeleton />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <MemoryRouter>
    <PolarisAppProvider i18n={polarisTranslations}>
      <Probe />
    </PolarisAppProvider>
  </MemoryRouter>,
);
