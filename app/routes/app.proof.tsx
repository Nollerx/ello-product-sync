// Proof — the merchant-facing evidence page.
//
// One page, three jobs:
//   1. The scorecard: attributed sales, try-on→purchase rate, median time to
//      purchase (tracked since day one, displayed here for the first time).
//   2. The proof test: start/stop a widget-wide A/B holdout and read the lift
//      with a significance verdict. Measured, not modeled.
//   3. The receipts: every attributed order with its Shopify order id and the
//      try-on→purchase gap, exportable, auditable line by line.

import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Badge,
  Banner,
  Button,
  DataTable,
  Select,
} from "@shopify/polaris";
import { CashDollarIcon, TargetIcon, ClockIcon, ChartVerticalFilledIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { SectionHeading, brand } from "../components/ui";
import { HeadlineStrip, KpiTile, StatusPill, type Tone } from "../components/analytics";
import { getConversionSummary, getStoreContext } from "../lib/analytics.server";
import { AB_MIN_SESSIONS_PER_ARM, type AbResults } from "../lib/ab-shared";
import {
  getExperimentResults,
  getLatestExperiment,
  getReceipts,
  startExperiment,
  stopExperiment,
} from "../lib/ab-testing.server";
import { supabaseAdmin } from "../lib/supabase.server";

const RANGE_DAYS = 30;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const store = await getStoreContext(shop);
  if (!store.slug) {
    return { ready: false as const };
  }
  const slug = store.slug;
  const to = new Date();
  const from = new Date(to.getTime() - RANGE_DAYS * 24 * 60 * 60 * 1000);

  const [summary, experiment, receipts] = await Promise.all([
    getConversionSummary(slug, from, to),
    getLatestExperiment(slug),
    getReceipts(slug, from, to, 100),
  ]);
  const results: AbResults | null = experiment
    ? await getExperimentResults(slug, experiment.id)
    : null;

  // Product titles for the receipts table (best-effort; ids fall back through).
  const titles: Record<string, string> = {};
  try {
    const ids = Array.from(new Set(receipts.map((r) => r.productId).filter(Boolean))) as string[];
    if (ids.length) {
      const { data } = await supabaseAdmin
        .from("clothing_items")
        .select("item_id, name")
        .eq("store_id", slug)
        .in("item_id", ids);
      for (const row of data ?? []) {
        if (row.item_id && row.name) titles[row.item_id as string] = row.name as string;
      }
    }
  } catch (err) {
    console.error("[proof] title lookup failed (non-fatal):", err);
  }

  return {
    ready: true as const,
    summary,
    experiment,
    results,
    receipts,
    titles,
    rangeDays: RANGE_DAYS,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await getStoreContext(session.shop);
  if (!store.slug) return { ok: false, error: "Store not found." };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent === "start") {
    const pct = Number(form.get("holdoutPercent") ?? 10);
    return startExperiment(store.slug, pct);
  }
  if (intent === "stop") {
    const experimentId = String(form.get("experimentId") ?? "");
    if (!experimentId) return { ok: false, error: "Missing experiment id." };
    return stopExperiment(store.slug, experimentId);
  }
  return { ok: false, error: "Unknown action." };
};

// ─── formatting helpers ─────────────────────────────────────────────────────

function money(value: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: value >= 1000 ? 0 : 2,
    }).format(value);
  } catch {
    return `$${Math.round(value).toLocaleString()}`;
  }
}

function humanizeSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  if (sec < 60) return "under a minute";
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return h < 3 ? `${h}h ${m % 60}m` : `${h} hours`;
  const d = Math.floor(h / 24);
  return d === 1 ? `1 day ${h % 24}h` : `${d} days`;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Side-by-side group panel: the conversion rate huge, the sample right under
// it. "Saw the widget" wears brand blue; the holdout stays neutral ink — the
// comparison should read in under three seconds.
function ArmPanel({
  label,
  hint,
  stats,
  accent,
  currency,
}: {
  label: string;
  hint: string;
  stats: { sessions: number; purchaseSessions: number; revenue: number; conversionPct: number | null };
  accent?: boolean;
  currency: string | null;
}) {
  const cr = stats.conversionPct != null ? `${Number(stats.conversionPct).toFixed(1)}%` : "—";
  return (
    <div
      style={{
        border: `1px solid ${accent ? brand.blue200 : brand.ink200}`,
        background: accent ? brand.blue50 : brand.white,
        borderRadius: 12,
        padding: "18px 20px",
      }}
    >
      <BlockStack gap="100">
        <span
          style={{
            fontSize: 11,
            fontWeight: 650,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: accent ? brand.blue700 : brand.ink500,
          }}
        >
          {label}
        </span>
        <span style={{ fontSize: 38, fontWeight: 600, lineHeight: 1.05, color: accent ? brand.blue : brand.ink }}>
          {cr}
        </span>
        <Text as="span" variant="bodySm" tone="subdued">
          conversion to purchase
        </Text>
        <div style={{ borderTop: `1px solid ${accent ? brand.blue200 : brand.ink100}`, marginTop: 8, paddingTop: 10, fontSize: 13, color: brand.ink600 }}>
          <strong style={{ color: brand.ink }}>{stats.sessions.toLocaleString()}</strong> shoppers ·{" "}
          <strong style={{ color: brand.ink }}>{stats.purchaseSessions.toLocaleString()}</strong> bought ·{" "}
          <strong style={{ color: brand.ink }}>{money(stats.revenue, currency)}</strong> revenue
        </div>
        <Text as="span" variant="bodySm" tone="subdued">
          {hint}
        </Text>
      </BlockStack>
    </div>
  );
}

function liftVerdict(results: AbResults): { label: string; tone: Tone } {
  if (!results.hasMinimumSample) return { label: "Collecting data", tone: "neutral" };
  if (results.relativeLift == null || results.confidence == null)
    return { label: "Collecting data", tone: "neutral" };
  if (results.relativeLift <= 0) return { label: "No lift yet", tone: "watch" };
  if (results.confidence >= 0.95) return { label: "Proven lift", tone: "good" };
  if (results.confidence >= 0.9) return { label: "Likely lift", tone: "watch" };
  return { label: "Too early to call", tone: "neutral" };
}

// ─── page ───────────────────────────────────────────────────────────────────

export default function ProofPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [holdoutPct, setHoldoutPct] = useState("10");

  if (!data.ready) {
    return (
      <Page title="Proof">
        <Banner tone="warning">
          <p>Finish onboarding first — this page unlocks once your store is connected.</p>
        </Banner>
      </Page>
    );
  }

  const { summary, experiment, results, receipts, titles, rangeDays } = data;
  const busy = fetcher.state !== "idle";
  const actionError = fetcher.data && fetcher.data.ok === false ? fetcher.data.error : null;

  const attributedRevenue = summary?.revenue ?? 0;
  const purchaseSessions = summary?.purchased ?? 0;
  const conversionPct = summary?.purchaseConversionPct ?? null;
  const currency = receipts.find((r) => r.currency)?.currency ?? null;
  const medianSecs = median(receipts.map((r) => r.secondsToPurchase));

  const verdict = results ? liftVerdict(results) : null;
  const liftPct =
    results?.relativeLift != null ? `${results.relativeLift >= 0 ? "+" : ""}${(results.relativeLift * 100).toFixed(1)}%` : "—";
  const confidencePct = results?.confidence != null ? `${Math.min(99.9, results.confidence * 100).toFixed(1)}%` : "—";

  const receiptRows = receipts.slice(0, 50).map((r) => [
    r.orderId ? `#${r.orderId.replace(/^.*\//, "")}` : "—",
    (r.productId && titles[r.productId]) || r.productId || "—",
    humanizeSeconds(r.secondsToPurchase),
    money(r.totalPrice, r.currency),
  ]);

  const downloadCsv = async () => {
    try {
      const res = await fetch("/app/proof/export");
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ello-proof-receipts-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[proof] export failed:", err);
    }
  };

  return (
    <Page title="Proof" subtitle="Measured on your own shoppers. Not modeled, not projected.">
      <BlockStack gap="500">
        {actionError && <Banner tone="critical"><p>{actionError}</p></Banner>}

        <HeadlineStrip eyebrow={`Last ${rangeDays} days at a glance`}>
          <span style={{ fontSize: 15, color: brand.ink }}>
            Shoppers who tried something on generated{" "}
            <strong>{money(attributedRevenue, currency)}</strong> across{" "}
            <strong>{purchaseSessions}</strong> purchases — every one traceable to a Shopify order id below.
          </span>
        </HeadlineStrip>

        <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="300">
          <KpiTile
            label="Tracked sales"
            value={money(attributedRevenue, currency)}
            hint="attributed order revenue, gross of returns"
            icon={CashDollarIcon}
            iconTone="money"
            accent
          />
          <KpiTile
            label="Try-on → purchase"
            value={conversionPct != null ? `${conversionPct}%` : "—"}
            hint="try-on sessions that bought that product"
            icon={TargetIcon}
            iconTone="good"
          />
          <KpiTile
            label="Median time to purchase"
            value={medianSecs != null ? humanizeSeconds(medianSecs) : "—"}
            hint="from try-on to checkout"
            icon={ClockIcon}
            iconTone="neutral"
          />
          <KpiTile
            label="Conversion lift"
            value={results && results.hasMinimumSample ? liftPct : "—"}
            hint={
              experiment
                ? results?.hasMinimumSample
                  ? `${confidencePct} confidence vs holdout`
                  : "test running — collecting data"
                : "run a proof test to measure"
            }
            icon={ChartVerticalFilledIcon}
            iconTone={verdict?.tone ?? "neutral"}
            status={verdict}
          />
        </InlineGrid>

        <Card padding="500">
          <BlockStack gap="400">
            <SectionHeading
              title="The proof test"
              description="Hide the widget from a slice of shoppers, then compare. The holdout group answers the only question that matters: would they have bought anyway?"
            />

            {!experiment && (
              <InlineStack gap="300" blockAlign="end" wrap>
                <Select
                  label="Holdout size"
                  labelHidden={false}
                  options={[
                    { label: "5% of shoppers", value: "5" },
                    { label: "10% of shoppers (recommended)", value: "10" },
                    { label: "20% of shoppers", value: "20" },
                    { label: "50% of shoppers", value: "50" },
                  ]}
                  value={holdoutPct}
                  onChange={setHoldoutPct}
                />
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="start" />
                  <input type="hidden" name="holdoutPercent" value={holdoutPct} />
                  <Button submit variant="primary" loading={busy}>
                    Start proof test
                  </Button>
                </fetcher.Form>
                <Text as="span" variant="bodySm" tone="subdued">
                  Assignment is sticky per shopper. Stop any time; the widget returns instantly.
                </Text>
              </InlineStack>
            )}

            {experiment && (
              <BlockStack gap="300">
                <InlineStack gap="300" blockAlign="center" wrap>
                  <Badge tone={experiment.status === "running" ? "success" : "info"}>
                    {experiment.status === "running" ? "Running" : "Completed"}
                  </Badge>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {experiment.holdoutPercent}% holdout · started{" "}
                    {new Date(experiment.startedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    {experiment.endedAt
                      ? ` · ended ${new Date(experiment.endedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
                      : ""}
                  </Text>
                  {experiment.status === "running" && (
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="stop" />
                      <input type="hidden" name="experimentId" value={experiment.id} />
                      <Button submit tone="critical" variant="plain" loading={busy}>
                        Stop test
                      </Button>
                    </fetcher.Form>
                  )}
                  {experiment.status === "completed" && (
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="start" />
                      <input type="hidden" name="holdoutPercent" value={holdoutPct} />
                      <Button submit loading={busy}>Start a new test</Button>
                    </fetcher.Form>
                  )}
                </InlineStack>

                {results && (
                  <>
                    <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                      <ArmPanel
                        label="Saw the widget"
                        hint="shoppers with try-on available"
                        stats={results.exposed}
                        currency={currency}
                        accent
                      />
                      <ArmPanel
                        label="Holdout (no widget)"
                        hint="same store, try-on hidden"
                        stats={results.holdout}
                        currency={currency}
                      />
                    </InlineGrid>
                    {results.hasMinimumSample ? (
                      <InlineStack gap="300" blockAlign="center" wrap>
                        {verdict && <StatusPill label={verdict.label} tone={verdict.tone} />}
                        <Text as="span" variant="bodyMd">
                          Conversion lift <strong>{liftPct}</strong> at <strong>{confidencePct}</strong> confidence
                          {results.incrementalRevenue != null && results.incrementalRevenue > 0 && (
                            <>
                              {" "}· lift-implied new sales{" "}
                              <strong>{money(results.incrementalRevenue, currency)}</strong>
                            </>
                          )}
                        </Text>
                      </InlineStack>
                    ) : (
                      <Banner tone="info">
                        <p>
                          Collecting data — verdicts unlock at {AB_MIN_SESSIONS_PER_ARM.toLocaleString()} sessions
                          per group ({results.exposed.sessions.toLocaleString()} exposed /{" "}
                          {results.holdout.sessions.toLocaleString()} holdout so far). Numbers shown before that
                          would just be noise.
                        </p>
                      </Banner>
                    )}
                  </>
                )}
              </BlockStack>
            )}
          </BlockStack>
        </Card>

        <Card padding="500">
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <SectionHeading
                title="Receipts"
                description="Every attributed order: the shopper tried this product on, then bought it. Audit any line against the order id in your Shopify admin."
              />
              <Button onClick={downloadCsv} disabled={!receipts.length}>
                Export CSV
              </Button>
            </InlineStack>
            {receiptRows.length ? (
              <DataTable
                columnContentTypes={["text", "text", "text", "numeric"]}
                headings={["Order", "Product tried on", "Try-on → purchase", "Order value"]}
                rows={receiptRows}
              />
            ) : (
              <Text as="p" tone="subdued">
                No attributed orders in the last {rangeDays} days yet. They&apos;ll appear here the moment a
                shopper tries something on and buys it.
              </Text>
            )}
            <Text as="p" variant="bodySm" tone="subdued">
              Methodology: a sale is attributed when the same shopper session tried a product on and later
              purchased it (30-day window, order values gross of returns, order-deduplicated). Shopper = 7-day
              sliding session. Lift comes only from the holdout test — never from attribution.
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
