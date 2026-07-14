// Proof — the merchant-facing evidence page, and the single home for testing.
//
// One page, four jobs:
//   1. The scorecard: attributed sales, try-on→purchase rate, median time to
//      purchase (tracked since day one, displayed here for the first time).
//   2. The proof test: start/stop a widget-wide A/B holdout and read the lift
//      with a significance verdict. Measured, not modeled.
//   3. The outfit-upsell test: the Complete-the-Look holdout split (treatment vs
//      holdout AOV). The toggle used to live on Widget Design; every
//      experiment now starts and reports here.
//   4. The receipts: every attributed order with its Shopify order id and the
//      try-on→purchase gap, exportable, auditable line by line.
//
// The two tests are independent by construction: the widget-wide holdout
// buckets on FNV(session:experiment_id), the CTL split on session-id last-char
// parity — running both at once cannot cross-contaminate.

import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
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
import {
  getConversionSummary,
  getCtlPerformance,
  getReturnRates,
  getStoreContext,
} from "../lib/analytics.server";
import {
  AB_MIN_SESSIONS_PER_ARM,
  CTL_MIN_ORDERS_PER_ARM,
  type AbResults,
} from "../lib/ab-shared";
import {
  getExperimentResults,
  getReceipts,
  listExperiments,
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

  const url = new URL(request.url);

  // Fresh walkthrough view: render the page exactly as a brand-new store sees
  // it — nothing deleted, nothing stopped, just a view. Exit brings it all back.
  if (url.searchParams.get("view") === "fresh") {
    const storeRow = await supabaseAdmin
      .from("vto_stores")
      .select("complete_the_look_enabled")
      .eq("shop_domain", shop)
      .maybeSingle()
      .then((r) => r.data);
    return {
      ready: true as const,
      freshView: true as const,
      summary: null,
      experiment: null,
      experiments: [],
      latestExperimentId: null,
      results: null,
      receipts: [],
      titles: {} as Record<string, string>,
      ctl: null,
      ctlFeatureOn: storeRow?.complete_the_look_enabled === true,
      ctlTestRunning: false,
      ctlTestSince: null as string | null,
      ctlTestPct: 50,
      returns: null,
      rangeDays: RANGE_DAYS,
      windowLabel: null as string | null,
    };
  }

  // History: every test is kept forever. The page shows the latest by default;
  // ?experiment=<id> pins a past one. One test = one window: when a test is
  // selected, the WHOLE page (scorecard, outfit test, returns, receipts) reads
  // over that test's window, so a past test brings the entire readout back.
  const requestedExperimentId = url.searchParams.get("experiment");
  const experiments = await listExperiments(slug);
  const latestExperiment = experiments[0] ?? null;
  const experiment =
    (requestedExperimentId && experiments.find((e) => e.id === requestedExperimentId)) ||
    latestExperiment;
  const winFrom = experiment ? new Date(experiment.startedAt) : from;
  const winTo = experiment?.endedAt ? new Date(experiment.endedAt) : to;

  const [summary, receipts, ctl, returns, storeRow, results] = await Promise.all([
    getConversionSummary(slug, winFrom, winTo),
    getReceipts(slug, winFrom, winTo, 100),
    getCtlPerformance(slug, winFrom, winTo),
    getReturnRates(slug, winFrom, winTo),
    supabaseAdmin
      .from("vto_stores")
      .select("complete_the_look_enabled, ctl_holdout_enabled, ctl_holdout_enabled_at, ctl_holdout_percent")
      .eq("shop_domain", shop)
      .maybeSingle()
      .then((r) => r.data),
    experiment ? getExperimentResults(slug, experiment.id) : Promise.resolve(null),
  ]);

  const fmtDay = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const windowLabel = experiment
    ? `${fmtDay(winFrom)} – ${experiment.endedAt ? fmtDay(winTo) : "now"}`
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
    freshView: false as const,
    summary,
    experiment,
    experiments,
    latestExperimentId: latestExperiment?.id ?? null,
    results,
    receipts,
    titles,
    ctl,
    ctlFeatureOn: storeRow?.complete_the_look_enabled === true,
    ctlTestRunning: storeRow?.ctl_holdout_enabled === true,
    ctlTestSince: (storeRow?.ctl_holdout_enabled_at as string | null) ?? null,
    ctlTestPct: Number(storeRow?.ctl_holdout_percent ?? 50),
    returns,
    rangeDays: RANGE_DAYS,
    windowLabel,
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
    const res = await startExperiment(store.slug, pct);
    if (res.ok) {
      // One test: the outfit 50/50 rides along whenever Complete the Look is
      // on. Stamp only on OFF→ON so an already-running outfit window is never
      // shrunk (its arms recompute per window from the enabled_at stamp).
      const { data: prior } = await supabaseAdmin
        .from("vto_stores")
        .select("ctl_holdout_enabled, complete_the_look_enabled")
        .eq("shop_domain", session.shop)
        .maybeSingle();
      if (prior?.complete_the_look_enabled === true && prior?.ctl_holdout_enabled !== true) {
        await supabaseAdmin
          .from("vto_stores")
          .update({ ctl_holdout_enabled: true, ctl_holdout_enabled_at: new Date().toISOString() })
          .eq("shop_domain", session.shop);
      }
    }
    return res;
  }
  if (intent === "stop") {
    const experimentId = String(form.get("experimentId") ?? "");
    if (!experimentId) return { ok: false, error: "Missing experiment id." };
    const res = await stopExperiment(store.slug, experimentId);
    if (res.ok) {
      // One test: stopping the test releases the outfit 50/50 too (flag only —
      // the enabled_at stamp stays, so this window's arms remain readable).
      await supabaseAdmin
        .from("vto_stores")
        .update({ ctl_holdout_enabled: false })
        .eq("shop_domain", session.shop);
    }
    return res;
  }
  // Reset for walkthroughs: stop any running widget test (it stays in history)
  // and let the client flip to the fresh view. The outfit test is deliberately
  // left as-is so past windows keep their arms.
  if (intent === "reset_demo") {
    const running = (await listExperiments(store.slug)).find((e) => e.status === "running");
    if (running) await stopExperiment(store.slug, running.id);
    return { ok: true, action: "reset" as const };
  }
  // CTL test lifecycle (moved here from Widget Design). Same bookkeeping as
  // before: ctl_holdout_enabled_at is stamped only on the OFF→ON transition
  // so re-toggling can never shrink the measurement window.
  if (intent === "ctl_start" || intent === "ctl_stop") {
    const wantOn = intent === "ctl_start";
    const rawPct = Math.round(Number(form.get("ctlHoldoutPercent") ?? 50));
    const pct = Number.isFinite(rawPct) ? Math.min(50, Math.max(1, rawPct)) : 50;
    const { data: prior } = await supabaseAdmin
      .from("vto_stores")
      .select("ctl_holdout_enabled, complete_the_look_enabled")
      .eq("shop_domain", session.shop)
      .maybeSingle();
    if (wantOn && prior?.complete_the_look_enabled !== true) {
      return { ok: false, error: "Turn on Complete the Look in Widget Design first." };
    }
    const turningOn = wantOn && prior?.ctl_holdout_enabled !== true;
    const { error } = await supabaseAdmin
      .from("vto_stores")
      .update({
        ctl_holdout_enabled: wantOn,
        ...(turningOn
          ? { ctl_holdout_enabled_at: new Date().toISOString(), ctl_holdout_percent: pct }
          : {}),
      })
      .eq("shop_domain", session.shop);
    if (error) {
      console.error("[proof] CTL test toggle failed:", error.message);
      return { ok: false, error: "Could not update the outfit test. Try again." };
    }
    return { ok: true };
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

// CTL arm panel: same silhouette as ArmPanel but the headline number is AOV —
// the outfit test moves order VALUE, not conversion, so that's what reads big.
function CtlArmPanel({
  label,
  hint,
  aov,
  sessions,
  orders,
  revenue,
  accent,
  currency,
}: {
  label: string;
  hint: string;
  aov: number | null;
  sessions: number;
  orders: number;
  revenue: number;
  accent?: boolean;
  currency: string | null;
}) {
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
          {aov != null ? money(aov, currency) : "—"}
        </span>
        <Text as="span" variant="bodySm" tone="subdued">
          average order value
        </Text>
        <div style={{ borderTop: `1px solid ${accent ? brand.blue200 : brand.ink100}`, marginTop: 8, paddingTop: 10, fontSize: 13, color: brand.ink600 }}>
          <strong style={{ color: brand.ink }}>{sessions.toLocaleString()}</strong> shoppers ·{" "}
          <strong style={{ color: brand.ink }}>{orders.toLocaleString()}</strong> orders ·{" "}
          <strong style={{ color: brand.ink }}>{money(revenue, currency)}</strong> revenue
        </div>
        <Text as="span" variant="bodySm" tone="subdued">
          {hint}
        </Text>
      </BlockStack>
    </div>
  );
}

// The money shot: without on the left, with on the right, and the lift as
// the biggest number on the page. Every test's results end in one of these.
function LiftHero({
  value,
  label,
  subline,
  pill,
}: {
  value: string;
  label: string;
  subline?: string;
  pill?: { label: string; tone: Tone };
}) {
  return (
    <div
      style={{
        background: brand.blue50,
        border: `1px solid ${brand.blue200}`,
        borderRadius: 12,
        padding: "22px 24px",
        textAlign: "center",
      }}
    >
      <BlockStack gap="150" inlineAlign="center">
        {pill && <StatusPill label={pill.label} tone={pill.tone} />}
        <span style={{ fontSize: 56, fontWeight: 650, lineHeight: 1, color: brand.blue, letterSpacing: "-0.02em" }}>
          {value}
        </span>
        <span style={{ fontSize: 14, fontWeight: 600, color: brand.ink }}>{label}</span>
        {subline && (
          <Text as="span" variant="bodySm" tone="subdued">
            {subline}
          </Text>
        )}
      </BlockStack>
    </div>
  );
}

// Rate panel: the returns comparison — a big percentage with its units line.
function RatePanel({
  label,
  ratePct,
  detail,
  accent,
}: {
  label: string;
  ratePct: number | null;
  detail: string;
  accent?: boolean;
}) {
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
          {ratePct != null ? `${ratePct.toFixed(1)}%` : "—"}
        </span>
        <Text as="span" variant="bodySm" tone="subdued">
          of units returned
        </Text>
        <div style={{ borderTop: `1px solid ${accent ? brand.blue200 : brand.ink100}`, marginTop: 8, paddingTop: 10, fontSize: 13, color: brand.ink600 }}>
          {detail}
        </div>
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
  const fetcher = useFetcher<{ ok: boolean; error?: string; action?: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [holdoutPct, setHoldoutPct] = useState("10");

  // After a successful action, steer the view: a reset lands on the fresh
  // walkthrough page; anything else (start/stop) snaps back to the current
  // test so a pinned past test or fresh view can't mask what just happened.
  useEffect(() => {
    if (!fetcher.data?.ok) return;
    const next = new URLSearchParams(searchParams);
    if (fetcher.data.action === "reset") {
      next.delete("experiment");
      next.set("view", "fresh");
      setSearchParams(next, { replace: true });
      return;
    }
    if (next.has("experiment") || next.has("view")) {
      next.delete("experiment");
      next.delete("view");
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);
  const [ctlPct, setCtlPct] = useState("50");

  if (!data.ready) {
    return (
      <Page title="Proof">
        <Banner tone="warning">
          <p>Finish onboarding first — this page unlocks once your store is connected.</p>
        </Banner>
      </Page>
    );
  }

  const { summary, experiment, experiments, latestExperimentId, results, receipts, titles, ctl, ctlFeatureOn, ctlTestRunning, ctlTestSince, ctlTestPct, returns, rangeDays, freshView, windowLabel } = data;

  const setFreshView = (on: boolean) => {
    const next = new URLSearchParams(searchParams);
    if (on) {
      next.delete("experiment");
      next.set("view", "fresh");
    } else {
      next.delete("view");
    }
    setSearchParams(next, { replace: true });
  };

  const viewingPast =
    experiment != null && latestExperimentId != null && experiment.id !== latestExperimentId;
  // A new test can start only when nothing is running (the latest experiment
  // is the only one that can ever be running).
  const canStartNew =
    experiments.length > 0 && experiments[0].status === "completed";

  const showExperiment = (id: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (!id || id === latestExperimentId) next.delete("experiment");
    else next.set("experiment", id);
    setSearchParams(next, { replace: true });
  };

  const ctlHasWindowData = ctl != null && (ctl.tSessions > 0 || ctl.hSessions > 0);

  const fmtExperiment = (e: (typeof experiments)[number]) => {
    const d = (s: string) =>
      new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `${d(e.startedAt)} – ${e.endedAt ? d(e.endedAt) : "now"} · ${
      e.status === "running" ? "Running" : "Completed"
    } · ${e.holdoutPercent}% holdout`;
  };
  const busy = fetcher.state !== "idle";

  // Returns comparison renders only once real refunds exist — a "0% return
  // rate" computed from zero recorded refunds would be a hollow stat.
  const returnsReady =
    returns != null && returns.allUnitsRefunded > 0 && returns.allUnitsSold > 0;
  const returnsGap =
    returnsReady && returns.triedReturnRatePct != null && returns.allReturnRatePct != null
      ? returns.allReturnRatePct - returns.triedReturnRatePct
      : null;
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

  // CTL test verdict: causal AOV lift, gated on orders per arm (AOV needs
  // orders to stabilize, unlike the conversion test's session gate).
  const ctlReady =
    ctl != null &&
    ctl.tAov != null &&
    ctl.hAov != null &&
    ctl.tOrders >= CTL_MIN_ORDERS_PER_ARM &&
    ctl.hOrders >= CTL_MIN_ORDERS_PER_ARM;
  const ctlLift =
    ctlReady && ctl.hAov! > 0
      ? Math.round(((ctl.tAov! - ctl.hAov!) / ctl.hAov!) * 100)
      : null;

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
    <Page
      title="Proof"
      subtitle="Measured on your own shoppers. Not modeled, not projected."
      secondaryActions={
        freshView
          ? [{ content: "Exit fresh view", onAction: () => setFreshView(false) }]
          : [
              { content: "View as a new store", onAction: () => setFreshView(true) },
              ...(experiments.length > 0
                ? [
                    {
                      content: "Reset page (tests stay in history)",
                      destructive: true,
                      onAction: () => fetcher.submit({ intent: "reset_demo" }, { method: "post" }),
                    },
                  ]
                : []),
            ]
      }
    >
      <BlockStack gap="500">
        {actionError && <Banner tone="critical"><p>{actionError}</p></Banner>}

        {freshView && (
          <Banner tone="info" title="Fresh walkthrough view">
            <p>
              This is the page exactly as a brand-new store sees it. Nothing was deleted — your
              data and every past test come back when you{" "}
              <Button variant="plain" onClick={() => setFreshView(false)}>
                exit fresh view
              </Button>
              .
            </p>
          </Banner>
        )}

        <HeadlineStrip eyebrow={windowLabel ? `This test: ${windowLabel}` : `Last ${rangeDays} days at a glance`}>
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
            <InlineStack align="space-between" blockAlign="start" wrap>
              <SectionHeading
                title="The proof test"
                description="Hide the widget from a slice of shoppers, then compare. The holdout group answers the only question that matters: would they have bought anyway?"
              />
              {experiments.length > 1 && (
                <Select
                  label="Test history"
                  options={experiments.map((e) => ({ label: fmtExperiment(e), value: e.id }))}
                  value={experiment?.id}
                  onChange={showExperiment}
                />
              )}
            </InlineStack>

            {viewingPast && (
              <Banner tone="info">
                <p>
                  You&apos;re viewing a past test — every test is kept here forever.{" "}
                  <Button variant="plain" onClick={() => showExperiment(null)}>
                    Back to the current test
                  </Button>
                </p>
              </Banner>
            )}

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
                  Starts the outfit upsell test alongside when Complete the Look is on — one test,
                  every section of this page.
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
                  {canStartNew && !viewingPast && (
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
                        label="Without try-on"
                        hint="the holdout — same store, Ello hidden"
                        stats={results.holdout}
                        currency={currency}
                      />
                      <ArmPanel
                        label="With try-on"
                        hint="shoppers who could use Ello"
                        stats={results.exposed}
                        currency={currency}
                        accent
                      />
                    </InlineGrid>
                    {results.hasMinimumSample ? (
                      <LiftHero
                        value={liftPct}
                        label="conversion lift from try-on"
                        subline={`${confidencePct} confidence${
                          results.incrementalRevenue != null && results.incrementalRevenue > 0
                            ? ` · lift-implied new sales ${money(results.incrementalRevenue, currency)}`
                            : ""
                        } · measured on your own shoppers`}
                        pill={verdict ?? undefined}
                      />
                    ) : (
                      <Banner tone="info">
                        <p>
                          Collecting data — verdicts unlock at {AB_MIN_SESSIONS_PER_ARM.toLocaleString()} sessions
                          per group ({results.exposed.sessions.toLocaleString()} with try-on /{" "}
                          {results.holdout.sessions.toLocaleString()} without so far). Numbers shown before that
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
                title="The outfit upsell test"
                description="Complete the Look: hide the outfit offer from a slice of shoppers, then compare average order value. The gap between the groups is the lift the feature actually causes."
              />
              {ctlTestRunning && <StatusPill label="Running" tone="watch" />}
            </InlineStack>

            {!ctlFeatureOn && (
              <InlineStack gap="300" blockAlign="center" wrap>
                <Text as="span" variant="bodyMd" tone="subdued">
                  Complete the Look is off — turn it on first, then come back to prove its lift.
                </Text>
                <Button onClick={() => navigate("/app/widget-design")}>Open Widget Design</Button>
              </InlineStack>
            )}

            {ctlFeatureOn && !ctlTestRunning && !viewingPast && (
              <InlineStack gap="300" blockAlign="end" wrap>
                <Select
                  label="Holdout size"
                  options={[
                    { label: "10% never see the offer", value: "10" },
                    { label: "20% never see the offer", value: "20" },
                    { label: "50% never see the offer (recommended)", value: "50" },
                  ]}
                  value={ctlPct}
                  onChange={setCtlPct}
                />
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="ctl_start" />
                  <input type="hidden" name="ctlHoldoutPercent" value={ctlPct} />
                  <Button submit variant="primary" loading={busy}>
                    Start test
                  </Button>
                </fetcher.Form>
                <Text as="span" variant="bodySm" tone="subdued">
                  Assignment is sticky per shopper. Stop any time; everyone sees the offer again
                  instantly. Starting the proof test above starts this one too — they read as one
                  test.
                </Text>
              </InlineStack>
            )}

            {ctlFeatureOn && (ctlTestRunning || ctlHasWindowData) && (
              <BlockStack gap="300">
                <InlineStack gap="300" blockAlign="center" wrap>
                  {ctlTestRunning && !viewingPast ? (
                    <>
                      <Badge tone="success">Running</Badge>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {ctlTestPct}% holdout
                        {ctlTestSince
                          ? ` · started ${new Date(ctlTestSince).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
                          : ""}
                        {" · your preview link (?ello_ctl=1) always shows the offer, so you can demo while it runs"}
                      </Text>
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="ctl_stop" />
                        <Button submit tone="critical" variant="plain" loading={busy}>
                          Stop test
                        </Button>
                      </fetcher.Form>
                    </>
                  ) : (
                    <>
                      <Badge tone="info">{viewingPast ? "Part of this test" : "Window results"}</Badge>
                      <Text as="span" variant="bodySm" tone="subdued">
                        outfit 50/50 over {windowLabel ?? `the last ${rangeDays} days`}
                      </Text>
                    </>
                  )}
                </InlineStack>

                {ctlHasWindowData && (
                  <>
                    <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                      <CtlArmPanel
                        label="Without the offer"
                        hint="the holdout — same store, outfit rail hidden"
                        aov={ctl.hAov}
                        sessions={ctl.hSessions}
                        orders={ctl.hOrders}
                        revenue={ctl.hRevenue}
                        currency={currency}
                      />
                      <CtlArmPanel
                        label="With the offer"
                        hint="shoppers with the outfit rail available"
                        aov={ctl.tAov}
                        sessions={ctl.tSessions}
                        orders={ctl.tOrders}
                        revenue={ctl.tRevenue}
                        currency={currency}
                        accent
                      />
                    </InlineGrid>
                    {ctlLift != null ? (
                      <LiftHero
                        value={`${ctlLift >= 0 ? "+" : ""}${ctlLift}%`}
                        label="average order value lift from the outfit offer"
                        subline="measured, not modeled — the only difference between the groups is the offer"
                        pill={{
                          label: ctlLift >= 0 ? "Causal AOV lift" : "No lift yet",
                          tone: ctlLift >= 0 ? "good" : "watch",
                        }}
                      />
                    ) : (
                      <Banner tone="info">
                        <p>
                          Collecting data — the lift number unlocks at {CTL_MIN_ORDERS_PER_ARM} attributed
                          orders per group ({ctl.tOrders} with the offer / {ctl.hOrders} holdout so far).
                        </p>
                      </Banner>
                    )}
                  </>
                )}
              </BlockStack>
            )}
          </BlockStack>
        </Card>

        {returnsReady && (
          <Card padding="500">
            <BlockStack gap="400">
              <SectionHeading
                title="Returns"
                description="Do tried-on items come back less often? Refunded units as a share of units sold, from your store's own refunds — tried-on items next to your store-wide baseline."
              />
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                <RatePanel
                  label="Store-wide baseline"
                  ratePct={returns.allReturnRatePct}
                  detail={`${returns.allUnitsRefunded.toLocaleString()} of ${returns.allUnitsSold.toLocaleString()} units returned`}
                />
                <RatePanel
                  label="Tried on before buying"
                  ratePct={returns.triedReturnRatePct}
                  detail={`${returns.triedUnitsRefunded.toLocaleString()} of ${returns.triedUnitsSold.toLocaleString()} units returned`}
                  accent
                />
              </InlineGrid>
              {returnsGap != null && returnsGap > 0 && (
                <LiftHero
                  value={`−${returnsGap.toFixed(1)} pts`}
                  label="fewer returns when shoppers try on first"
                  subline="from your own orders and refunds, not an industry stat"
                  pill={{ label: "Fewer returns", tone: "good" }}
                />
              )}
            </BlockStack>
          </Card>
        )}

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
