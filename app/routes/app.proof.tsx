// Proof — the merchant-facing evidence page, and the single home for testing.
//
// Experiments are presented as QUESTIONS, not configurations — a merchant
// picks the question, Ello picks the statistics:
//   1. "Does try-on lift my store's sales?"  — the site-wide holdout: a slice
//      of shoppers browses without Ello and everyone's buying is compared.
//   2. "Which products does try-on actually sell?" — the product split test:
//      on the merchant's chosen products, every shopper is split 50/50
//      (product-salted hash) and conversion is compared on the SAME product.
//      Splitting shoppers within a product — not products against each other —
//      is what keeps the comparison clean.
//   3. "Does the outfit upsell raise order size?" — the Complete-the-Look
//      holdout split (treatment vs holdout AOV).
// Plus the standing evidence: the scorecard, the returns comparison, and the
// receipts ledger (every attributed order, exportable, auditable line by line).
//
// One question at a time: the DB enforces a single running experiment per
// store, which is also the honest-statistics rule (overlapping tests would
// contaminate each other's arms). The CTL split rides along with a site-wide
// start; the splits stay mechanically independent (FNV salted per experiment
// / per experiment+product / 'ctl'), so they can never cross-contaminate.

import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  Checkbox,
  InlineStack,
  InlineGrid,
  Text,
  Badge,
  Banner,
  Button,
  DataTable,
  Select,
} from "@shopify/polaris";
import {
  ConnectIcon,
  HideIcon,
  ProductIcon,
  ReturnIcon,
} from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { MonoMeta, PageHeader, PillButton, SectionHeading, brand } from "../components/ui";
import { HeadlineStrip, IconChip, KpiBand, StatusPill, type Tone } from "../components/analytics";
import {
  getConversionSummary,
  getCtlPerformance,
  getReturnRates,
  getStoreContext,
} from "../lib/analytics.server";
import {
  AB_MIN_SESSIONS_PER_ARM,
  AB_PRODUCT_MAX_PRODUCTS,
  AB_PRODUCT_ROW_MIN_SESSIONS_PER_ARM,
  AB_VERDICT_CONFIDENCE,
  CTL_MIN_ORDERS_PER_ARM,
  welchAovConfidence,
  type AbProductResults,
  type AbResults,
  type AbTestProduct,
} from "../lib/ab-shared";
import {
  getExperimentResults,
  getProductExperimentResults,
  getReceipts,
  getTopViewedProducts,
  listExperiments,
  startExperiment,
  startProductExperiment,
  stopExperiment,
} from "../lib/ab-testing.server";
import { fetchStorefrontProductRefs } from "../lib/storefront-names.server";
import { supabaseAdmin } from "../lib/supabase.server";

const RANGE_DAYS = 30;

// Setup payload for the product split test's question card: eligibility plus
// the "choose for me" suggestion list (most-viewed, try-on-enabled products).
type ProductSetup = {
  eligible: boolean;
  reason: string | null;
  suggestions: Array<{ id: string; title: string; handle: string; views: number }>;
} | null;

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
      productResults: null as AbProductResults | null,
      productSetup: null as ProductSetup | null,
      receipts: [],
      titles: {} as Record<string, string>,
      ctl: null,
      ctlFeatureOn: storeRow?.complete_the_look_enabled === true,
      ctlTestRunning: false,
      ctlTestSince: null as string | null,
      ctlTestPct: 50,
      ctlWindowPct: 50,
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

  const [summary, receipts, ctl, returns, storeRow, results, productResults] = await Promise.all([
    getConversionSummary(slug, winFrom, winTo),
    getReceipts(slug, winFrom, winTo, 100),
    // When the outfit split rode along with this test, freeze the arms to the
    // test's own percent + window — a later restart with a different percent
    // must never rewrite this readout. Tests without an attached outfit split
    // fall back to the store's live stamps (now end-clamped by disabled_at).
    getCtlPerformance(
      slug,
      winFrom,
      winTo,
      experiment?.ctlAttached
        ? {
            pct: experiment.holdoutPercent,
            activeFrom: experiment.startedAt,
            activeTo: experiment.endedAt,
          }
        : undefined,
    ),
    getReturnRates(slug, winFrom, winTo),
    supabaseAdmin
      .from("vto_stores")
      .select(
        "complete_the_look_enabled, ctl_holdout_enabled, ctl_holdout_enabled_at, ctl_holdout_percent, clothing_population_type, tryon_targeting_mode, tryon_included_product_ids",
      )
      .eq("shop_domain", shop)
      .maybeSingle()
      .then((r) => r.data),
    experiment && experiment.kind !== "product"
      ? getExperimentResults(slug, experiment.id)
      : Promise.resolve(null),
    experiment && experiment.kind === "product"
      ? getProductExperimentResults(slug, experiment)
      : Promise.resolve(null),
  ]);

  // Product-test setup suggestions ("choose for me"): the store's most-viewed
  // products from the last 30 days, filtered to try-on-enabled ones and
  // resolved to titles + handles. Only computed when a new test could start.
  const running = experiments.find((e) => e.status === "running") ?? null;
  let productSetup: ProductSetup = null;
  if (!running) {
    if (storeRow?.clothing_population_type === "supabase") {
      productSetup = {
        eligible: false,
        reason: "The product test needs a Shopify product catalog.",
        suggestions: [],
      };
    } else {
      try {
        const top = await getTopViewedProducts(slug, 30, 20);
        let candidates = top;
        const mode = (storeRow?.tryon_targeting_mode as string | null) || "all";
        if (mode === "products") {
          const included = new Set(
            (Array.isArray(storeRow?.tryon_included_product_ids)
              ? (storeRow!.tryon_included_product_ids as string[])
              : []
            ).map((id) => String(id).replace(/^.*\//, "")),
          );
          candidates = candidates.filter((c) => included.has(c.productId));
        } else if (mode === "all") {
          const { data: hidden } = await supabaseAdmin
            .from("clothing_items")
            .select("item_id")
            .eq("store_id", slug)
            .eq("data_source", "shopify")
            .eq("active", false);
          const hiddenIds = new Set(
            (hidden ?? []).map((r) => String(r.item_id).replace(/^.*\//, "")),
          );
          candidates = candidates.filter((c) => !hiddenIds.has(c.productId));
        }
        const refs = await fetchStorefrontProductRefs(
          store.shopDomain,
          store.storefrontToken,
          candidates.map((c) => `gid://shopify/Product/${c.productId}`),
        );
        productSetup = {
          eligible: true,
          reason: null,
          suggestions: candidates
            .map((c) => {
              const ref = refs.get(c.productId);
              return ref ? { id: c.productId, title: ref.title, handle: ref.handle, views: c.views } : null;
            })
            .filter((s): s is NonNullable<typeof s> => s != null),
        };
      } catch (err) {
        console.error("[proof] product setup suggestions failed (non-fatal):", err);
        productSetup = { eligible: true, reason: null, suggestions: [] };
      }
    }
  }

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
    productResults,
    productSetup,
    receipts,
    titles,
    ctl,
    ctlFeatureOn: storeRow?.complete_the_look_enabled === true,
    ctlTestRunning: storeRow?.ctl_holdout_enabled === true,
    ctlTestSince: (storeRow?.ctl_holdout_enabled_at as string | null) ?? null,
    ctlTestPct: Number(storeRow?.ctl_holdout_percent ?? 50),
    // The percent the displayed arms were actually classified with — the
    // pinned test's frozen value when attached, else the store's live value.
    ctlWindowPct: experiment?.ctlAttached
      ? experiment.holdoutPercent
      : Number(storeRow?.ctl_holdout_percent ?? 50),
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
        // One holdout number for everything: the outfit split reuses the
        // proof test's percentage instead of asking twice. disabled_at is
        // cleared so the previous test's end stamp can't clip this window.
        const ctlPct = Math.min(50, Math.max(1, Math.round(pct)));
        await supabaseAdmin
          .from("vto_stores")
          .update({
            ctl_holdout_enabled: true,
            ctl_holdout_enabled_at: new Date().toISOString(),
            ctl_holdout_percent: ctlPct,
            ctl_holdout_disabled_at: null,
          })
          .eq("shop_domain", session.shop);
        // Record on the experiment itself that the outfit split rode along —
        // past readouts freeze to THIS test's percent + window, so a later
        // restart can never reclassify these arms.
        if (res.experimentId) {
          await supabaseAdmin
            .from("vto_experiments")
            .update({ ctl_attached: true })
            .eq("id", res.experimentId);
        }
      }
    }
    return res;
  }
  if (intent === "start_product") {
    // The client sends [{id, title?, handle?}] (numeric ids or GIDs). Handles
    // and titles are re-resolved server-side from the Storefront API so the
    // frozen list is authoritative — a stale client label can't corrupt the
    // widget's URL matching. Products that fail to resolve are dropped.
    let picked: Array<{ id: string; title?: string; handle?: string }> = [];
    try {
      const parsed = JSON.parse(String(form.get("products") ?? "[]"));
      if (Array.isArray(parsed)) picked = parsed;
    } catch {
      return { ok: false, error: "Could not read the product list. Try again." };
    }
    const ids = Array.from(
      new Set(
        picked
          .map((p) => String(p?.id ?? "").replace(/^.*\//, ""))
          .filter((id) => /^\d{1,20}$/.test(id)),
      ),
    ).slice(0, AB_PRODUCT_MAX_PRODUCTS);
    if (ids.length === 0) return { ok: false, error: "Pick at least one product for the test." };
    const refs = await fetchStorefrontProductRefs(
      store.shopDomain,
      store.storefrontToken,
      ids.map((id) => `gid://shopify/Product/${id}`),
    );
    const products: AbTestProduct[] = ids
      .map((id) => refs.get(id))
      .filter((r): r is NonNullable<typeof r> => r != null)
      .map((r) => ({ id: r.id, handle: r.handle, title: r.title }));
    if (products.length === 0) {
      return { ok: false, error: "None of those products could be resolved. Are they published?" };
    }
    const res = await startProductExperiment(store.slug, products);
    if (!res.ok) return res;
    return { ok: true, dropped: ids.length - products.length };
  }
  if (intent === "stop") {
    const experimentId = String(form.get("experimentId") ?? "");
    if (!experimentId) return { ok: false, error: "Missing experiment id." };
    const { data: priorStop } = await supabaseAdmin
      .from("vto_stores")
      .select("ctl_holdout_enabled")
      .eq("shop_domain", session.shop)
      .maybeSingle();
    const res = await stopExperiment(store.slug, experimentId);
    if (res.ok) {
      // One test: stopping the test releases the outfit split too. The
      // enabled_at stamp stays and disabled_at closes the window, so this
      // test's arms stay readable while post-stop sessions (who all see the
      // rail again) can never leak into a "holdout" arm.
      await supabaseAdmin
        .from("vto_stores")
        .update({
          ctl_holdout_enabled: false,
          ...(priorStop?.ctl_holdout_enabled === true
            ? { ctl_holdout_disabled_at: new Date().toISOString() }
            : {}),
        })
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
    const turningOff = !wantOn && prior?.ctl_holdout_enabled === true;
    const { error } = await supabaseAdmin
      .from("vto_stores")
      .update({
        ctl_holdout_enabled: wantOn,
        ...(turningOn
          ? {
              ctl_holdout_enabled_at: new Date().toISOString(),
              ctl_holdout_percent: pct,
              ctl_holdout_disabled_at: null,
            }
          : {}),
        ...(turningOff ? { ctl_holdout_disabled_at: new Date().toISOString() } : {}),
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
  stats: {
    sessions: number;
    purchaseSessions: number;
    revenue: number;
    conversionPct: number | null;
    pdpSessions?: number;
    pdpPurchaseSessions?: number;
    pdpConversionPct?: number | null;
  };
  accent?: boolean;
  currency: string | null;
}) {
  const cr = stats.conversionPct != null ? `${Number(stats.conversionPct).toFixed(1)}%` : "—";
  const pdpSessions = stats.pdpSessions ?? 0;
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
        {pdpSessions > 0 && (
          <div style={{ fontSize: 13, color: brand.ink600 }}>
            On product pages:{" "}
            <strong style={{ color: brand.ink }}>{(stats.pdpPurchaseSessions ?? 0).toLocaleString()}</strong> of{" "}
            <strong style={{ color: brand.ink }}>{pdpSessions.toLocaleString()}</strong> bought
            {stats.pdpConversionPct != null ? ` (${Number(stats.pdpConversionPct).toFixed(1)}%)` : ""}
          </div>
        )}
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

// Icon-led section heading — the Ello admin pattern (icon chip, decision-first
// words) applied to the three sections of the one test.
function IconHeading({
  icon,
  tone,
  title,
  description,
}: {
  icon: ComponentProps<typeof IconChip>["source"];
  tone: Tone;
  title: string;
  description: string;
}) {
  return (
    <InlineStack gap="300" blockAlign="start" wrap={false}>
      <IconChip source={icon} tone={tone} size={36} />
      <SectionHeading title={title} description={description} />
    </InlineStack>
  );
}

// One row of the start block: an icon and the plain-English answer this test
// will produce. Three of these replace two cards of controls.
function AnswerRow({
  icon,
  tone,
  title,
  text,
}: {
  icon: ComponentProps<typeof IconChip>["source"];
  tone: Tone;
  title: string;
  text: string;
}) {
  return (
    <InlineStack gap="300" blockAlign="start" wrap={false}>
      <IconChip source={icon} tone={tone} size={34} />
      <div style={{ minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: brand.ink, display: "block" }}>
          {title}
        </span>
        <Text as="span" variant="bodySm" tone="subdued">
          {text}
        </Text>
      </div>
    </InlineStack>
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

// Same verdict ladder for the product test's pooled readout.
function pooledVerdict(pooled: NonNullable<AbProductResults>["pooled"]): { label: string; tone: Tone } {
  if (!pooled.hasMinimumSample) return { label: "Collecting data", tone: "neutral" };
  if (pooled.relativeLift == null || pooled.confidence == null)
    return { label: "Collecting data", tone: "neutral" };
  if (pooled.relativeLift <= 0) return { label: "No lift yet", tone: "watch" };
  if (pooled.confidence >= AB_VERDICT_CONFIDENCE) return { label: "Proven lift", tone: "good" };
  if (pooled.confidence >= 0.9) return { label: "Likely lift", tone: "watch" };
  return { label: "Too early to call", tone: "neutral" };
}

// "≈ N more days at the current pace" for a running test's collecting banner.
// Pace = the SLOWER arm's fill rate since the test started; null when there's
// no pace yet or the verdict bar is already cleared.
function paceEstimateDays(
  startedAt: string,
  exposedSessions: number,
  holdoutSessions: number,
  minPerArm: number,
): number | null {
  const daysElapsed = Math.max((Date.now() - new Date(startedAt).getTime()) / 86400000, 0.25);
  const minArm = Math.min(exposedSessions, holdoutSessions);
  const deficit = minPerArm - minArm;
  if (deficit <= 0) return null;
  const rate = minArm / daysElapsed;
  if (rate <= 0) return null;
  return Math.ceil(deficit / rate);
}

// One question in the experiments menu: icon chip, the plain-English question,
// what the merchant will learn, and either a start control or an expand hook.
// Expandable cards (onOpen given) are clickable anywhere while collapsed and
// wear a blue ring while open — the same "this one is active" language as the
// Widget Design style tiles.
function QuestionCard({
  icon,
  tone,
  question,
  learn,
  meta,
  pill,
  action,
  open,
  onOpen,
  onClose,
  children,
}: {
  icon: ComponentProps<typeof IconChip>["source"];
  tone: Tone;
  question: string;
  learn: string;
  meta?: string;
  pill?: { label: string; tone: Tone } | null;
  action?: ReactNode;
  open?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  children?: ReactNode;
}) {
  const expandable = typeof onOpen === "function";
  const clickable = expandable && !open;
  const resolvedAction =
    action ??
    (expandable ? (
      open ? (
        <PillButton onClick={() => onClose?.()}>Close</PillButton>
      ) : (
        <PillButton onClick={() => onOpen?.()}>Set up</PillButton>
      )
    ) : undefined);
  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onOpen?.() : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") onOpen?.();
            }
          : undefined
      }
      style={{
        border: `1px solid ${open ? brand.blue300 : brand.ink200}`,
        boxShadow: open ? `0 0 0 1px ${brand.blue300}` : undefined,
        background: brand.white,
        borderRadius: 12,
        padding: "16px 18px",
        cursor: clickable ? "pointer" : undefined,
        transition: "border-color 120ms ease, box-shadow 120ms ease",
      }}
    >
      <BlockStack gap="200">
        <InlineStack gap="300" blockAlign="start" wrap={false}>
          <IconChip source={icon} tone={tone} size={36} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <InlineStack gap="200" blockAlign="center" wrap>
              <span style={{ fontSize: 15, fontWeight: 600, color: brand.ink }}>{question}</span>
              {pill && <StatusPill label={pill.label} tone={pill.tone} />}
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              {learn}
            </Text>
          </div>
          {resolvedAction && <div style={{ flexShrink: 0 }}>{resolvedAction}</div>}
        </InlineStack>
        {meta && !open && <MonoMeta>{meta}</MonoMeta>}
        {children}
      </BlockStack>
    </div>
  );
}

// ─── page ───────────────────────────────────────────────────────────────────

export default function ProofPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok: boolean; error?: string; action?: string; dropped?: number }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [holdoutPct, setHoldoutPct] = useState("10");
  // Which question card is expanded in the experiments menu.
  const [openQuestion, setOpenQuestion] = useState<"sitewide" | "product" | null>(null);
  // Product-test setup state, seeded from the loader's "choose for me" list.
  const initialSetup = data.ready ? data.productSetup : null;
  const [productList, setProductList] = useState<
    Array<{ id: string; title: string; handle: string; views?: number }>
  >(() => initialSetup?.suggestions ?? []);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set((initialSetup?.suggestions ?? []).map((s) => s.id)),
  );
  // Suggestions can arrive on a later revalidation (e.g. right after a test
  // stops) — adopt them only while the merchant hasn't built their own list.
  useEffect(() => {
    if (!initialSetup || initialSetup.suggestions.length === 0) return;
    setProductList((prev) => (prev.length ? prev : initialSetup.suggestions));
    setSelectedIds((prev) => (prev.size ? prev : new Set(initialSetup.suggestions.map((s) => s.id))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSetup?.suggestions.length]);
  const selectedViews = useMemo(
    () =>
      productList
        .filter((p) => selectedIds.has(p.id))
        .reduce((n, p) => n + (p.views ?? 0), 0),
    [productList, selectedIds],
  );

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

  if (!data.ready) {
    return (
      <Page title="Proof">
        <Banner tone="warning">
          <p>Finish onboarding first — this page unlocks once your store is connected.</p>
        </Banner>
      </Page>
    );
  }

  const { summary, experiment, experiments, latestExperimentId, results, productResults, productSetup, receipts, titles, ctl, ctlFeatureOn, ctlTestRunning, ctlTestSince, ctlTestPct, ctlWindowPct, returns, rangeDays, freshView, windowLabel } = data;

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
    return `${e.kind === "product" ? "Product test" : "Store-wide"} · ${d(e.startedAt)} – ${
      e.endedAt ? d(e.endedAt) : "now"
    } · ${e.status === "running" ? "Running" : "Completed"}`;
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

  // The lift KPI reads from whichever test the page is windowed to.
  const isProductTest = experiment?.kind === "product";
  const activeLift = isProductTest ? productResults?.pooled.relativeLift ?? null : results?.relativeLift ?? null;
  const activeConfidence = isProductTest ? productResults?.pooled.confidence ?? null : results?.confidence ?? null;
  const activeHasSample = isProductTest
    ? productResults?.pooled.hasMinimumSample ?? false
    : results?.hasMinimumSample ?? false;
  const verdict = isProductTest
    ? productResults
      ? pooledVerdict(productResults.pooled)
      : null
    : results
      ? liftVerdict(results)
      : null;
  const liftPct = activeLift != null ? `${activeLift >= 0 ? "+" : ""}${(activeLift * 100).toFixed(1)}%` : "—";
  const confidencePct =
    activeConfidence != null ? `${Math.min(99.9, activeConfidence * 100).toFixed(1)}%` : "—";

  // Experiments menu: shown whenever nothing is running and we're not pinned
  // to a past test — covers both "never ran a test" and "latest completed".
  const runningNow = experiment?.status === "running";
  const showMenu = !runningNow && !viewingPast;
  const hasEverRun = experiments.length > 0;
  const selectedCount = productList.filter((p) => selectedIds.has(p.id)).length;
  // Rough time-to-verdict for the setup card: selected products' recent view
  // pace, halved per arm, against the pooled 200/arm bar. Views only exist for
  // suggested products, so picker-only lists show no estimate.
  const estSetupDays =
    selectedViews > 0 ? Math.ceil(AB_MIN_SESSIONS_PER_ARM / (selectedViews / 30 / 2)) : null;

  const pickProducts = async () => {
    const picker = window.shopify?.resourcePicker;
    if (!picker) return;
    const sel = await picker({
      type: "product",
      multiple: true,
      selectionIds: productList
        .filter((p) => selectedIds.has(p.id))
        .map((p) => ({ id: `gid://shopify/Product/${p.id}` })),
    });
    if (!sel) return;
    const mapped = sel.map((r) => ({
      id: r.id.replace(/^.*\//, ""),
      title: r.title ?? r.id,
      handle: r.handle ?? "",
      views: productList.find((p) => p.id === r.id.replace(/^.*\//, ""))?.views,
    }));
    setProductList(mapped);
    setSelectedIds(new Set(mapped.map((m) => m.id)));
  };

  const startProductTest = () => {
    const products = productList
      .filter((p) => selectedIds.has(p.id))
      .map(({ id, title, handle }) => ({ id, title, handle }));
    fetcher.submit(
      { intent: "start_product", products: JSON.stringify(products) },
      { method: "post" },
    );
  };

  // CTL test verdict: the lift number renders once each arm has enough orders,
  // but "causal" is only claimed when the Welch t-test on AOV clears the same
  // confidence bar as the conversion test. AOV is a high-variance mean — a gap
  // at 10 orders per arm is usually noise, and stamping it "causal" is exactly
  // the overstatement a buyer's finance team would catch.
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
  const ctlConfidence = ctlReady
    ? welchAovConfidence(ctl.tAov, ctl.tAovStddev, ctl.tOrders, ctl.hAov, ctl.hAovStddev, ctl.hOrders)
    : null;
  const ctlSignificant = ctlConfidence != null && ctlConfidence >= AB_VERDICT_CONFIDENCE;
  const ctlConfidencePct =
    ctlConfidence != null ? `${Math.min(99.9, ctlConfidence * 100).toFixed(1)}%` : null;

  const receiptRows = receipts.slice(0, 50).map((r) => [
    r.orderId ? `#${r.orderId.replace(/^.*\//, "")}` : "—",
    (r.productId && titles[r.productId]) || r.productId || "—",
    humanizeSeconds(r.secondsToPurchase),
    money(r.totalPrice, r.currency),
  ]);

  const downloadCsv = async () => {
    try {
      // Export the window on screen: the pinned test's range, not a fixed 30d.
      const res = await fetch(
        `/app/proof/export${experiment ? `?experiment=${encodeURIComponent(experiment.id)}` : ""}`,
      );
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
    <Page>
      <BlockStack gap="500">
        <PageHeader
          kicker="Experiments"
          title="Proof"
          actions={
            freshView ? (
              <PillButton onClick={() => setFreshView(false)}>Exit fresh view</PillButton>
            ) : (
              <>
                <PillButton onClick={() => setFreshView(true)}>View as a new store</PillButton>
                {experiments.length > 0 && (
                  <PillButton
                    onClick={() => fetcher.submit({ intent: "reset_demo" }, { method: "post" })}
                  >
                    Reset page
                  </PillButton>
                )}
              </>
            )
          }
        />
        <MonoMeta>Measured on your own shoppers · not modeled, not projected</MonoMeta>

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
            Shoppers who tried something on bought{" "}
            <strong>{money(attributedRevenue, currency)}</strong> of tried-on items across{" "}
            <strong>{purchaseSessions}</strong> purchases — each traceable to its order below.
          </span>
        </HeadlineStrip>

        <KpiBand
          tiles={[
            {
              label: "Tracked sales",
              value: money(attributedRevenue, currency),
              hint: "gross of returns",
              accent: true,
            },
            {
              label: "Try-on → purchase",
              value: conversionPct != null ? `${conversionPct}%` : "—",
              hint: "bought what they tried",
            },
            {
              label: "Median time to purchase",
              value: medianSecs != null ? humanizeSeconds(medianSecs) : "—",
              hint: "try-on to checkout",
            },
            {
              label: "Conversion lift",
              value: activeHasSample ? liftPct : "—",
              hint: experiment
                ? activeHasSample
                  ? `${confidencePct} confidence`
                  : "collecting data"
                : "start a test below",
              status: verdict,
            },
          ]}
        />

        {experiment && (
        <Card padding="500">
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="start" wrap>
              {isProductTest ? (
                <IconHeading
                  icon={ProductIcon}
                  tone="money"
                  title="The product split test"
                  description={`On ${experiment.testProducts?.length ?? "your chosen"} products, half of shoppers see try-on and half don't — conversion is compared on the same product.`}
                />
              ) : (
                <IconHeading
                  icon={HideIcon}
                  tone="good"
                  title="The proof test"
                  description="A slice of your shoppers browses without Ello. Every gap below is measured against them — would they have bought anyway?"
                />
              )}
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

            {(
              <BlockStack gap="300">
                <InlineStack gap="300" blockAlign="center" wrap>
                  <Badge tone={experiment.status === "running" ? "success" : "info"}>
                    {experiment.status === "running" ? "Running" : "Completed"}
                  </Badge>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {isProductTest ? "50/50 split on the test products" : `${experiment.holdoutPercent}% holdout`} · started{" "}
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
                    <Text as="p" variant="bodySm" tone="subdued">
                      How to read this: both groups count every store visitor from their very first
                      page — the same rule on both sides — so these percentages sit well below the
                      product-page conversion rate in your Shopify analytics. That&apos;s expected, not a
                      problem. The &ldquo;on product pages&rdquo; line inside each card compares only shoppers
                      who opened a product page; the verdict below is always computed on the full
                      randomized groups, so nothing is filtered out of the actual test.
                    </Text>
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
                          {results.holdout.sessions.toLocaleString()} without so far
                          {(() => {
                            const pace =
                              experiment.status === "running"
                                ? paceEstimateDays(
                                    experiment.startedAt,
                                    results.exposed.sessions,
                                    results.holdout.sessions,
                                    AB_MIN_SESSIONS_PER_ARM,
                                  )
                                : null;
                            return pace != null ? ` · about ${pace > 60 ? "60+" : pace} more days at the current pace` : "";
                          })()}
                          ). Numbers shown before that would just be noise.
                        </p>
                      </Banner>
                    )}
                  </>
                )}

                {isProductTest && productResults && (
                  <>
                    <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                      <ArmPanel
                        label="Without try-on"
                        hint="viewed a test product with try-on hidden"
                        stats={productResults.pooled.holdout}
                        currency={currency}
                      />
                      <ArmPanel
                        label="With try-on"
                        hint="viewed a test product with try-on available"
                        stats={productResults.pooled.exposed}
                        currency={currency}
                        accent
                      />
                    </InlineGrid>
                    <Text as="p" variant="bodySm" tone="subdued">
                      How to read this: each shopper who opens a test product&apos;s page counts once for
                      that product, and converts by buying that product. Both groups saw the same
                      pages — the only difference is whether try-on was there. The verdict is
                      computed on all test products pooled together; the leaderboard below shows
                      where the lift concentrates.
                    </Text>
                    {productResults.pooled.hasMinimumSample ? (
                      <LiftHero
                        value={liftPct}
                        label="conversion lift on products with try-on"
                        subline={`${confidencePct} confidence · pooled across ${productResults.rows.length} products · measured on your own shoppers`}
                        pill={verdict ?? undefined}
                      />
                    ) : (
                      <Banner tone="info">
                        <p>
                          Collecting data — the pooled verdict unlocks at{" "}
                          {AB_MIN_SESSIONS_PER_ARM.toLocaleString()} product viewers per group (
                          {productResults.pooled.exposed.sessions.toLocaleString()} with try-on /{" "}
                          {productResults.pooled.holdout.sessions.toLocaleString()} without so far
                          {(() => {
                            const pace =
                              experiment.status === "running"
                                ? paceEstimateDays(
                                    experiment.startedAt,
                                    productResults.pooled.exposed.sessions,
                                    productResults.pooled.holdout.sessions,
                                    AB_MIN_SESSIONS_PER_ARM,
                                  )
                                : null;
                            return pace != null ? ` · about ${pace > 60 ? "60+" : pace} more days at the current pace` : "";
                          })()}
                          ). Numbers shown before that would just be noise.
                        </p>
                      </Banner>
                    )}
                    <BlockStack gap="200">
                      <SectionHeading
                        title="Product leaderboard"
                        description={`Per-product verdicts unlock at ${AB_PRODUCT_ROW_MIN_SESSIONS_PER_ARM} shoppers per group on that product — until then a row honestly says it doesn't know yet.`}
                      />
                      <DataTable
                        columnContentTypes={["text", "numeric", "numeric", "numeric", "text"]}
                        headings={["Product", "Without try-on", "With try-on", "Lift", "Verdict"]}
                        rows={productResults.rows.map((r) => [
                          r.title,
                          r.holdout.conversionPct != null ? `${Number(r.holdout.conversionPct).toFixed(1)}%` : "—",
                          r.exposed.conversionPct != null ? `${Number(r.exposed.conversionPct).toFixed(1)}%` : "—",
                          r.hasRowSample && r.relativeLift != null
                            ? `${r.relativeLift >= 0 ? "+" : ""}${(r.relativeLift * 100).toFixed(0)}%`
                            : "—",
                          !r.hasRowSample ? (
                            <StatusPill key={r.productId} label="Not enough shoppers yet" tone="neutral" />
                          ) : r.relativeLift != null && r.relativeLift <= 0 ? (
                            <StatusPill key={r.productId} label="No lift yet" tone="watch" />
                          ) : r.confidence != null && r.confidence >= AB_VERDICT_CONFIDENCE ? (
                            <StatusPill key={r.productId} label="Confident lift" tone="good" />
                          ) : r.confidence != null && r.confidence >= 0.9 ? (
                            <StatusPill key={r.productId} label="Likely lift" tone="watch" />
                          ) : (
                            <StatusPill key={r.productId} label="Too early to call" tone="neutral" />
                          ),
                        ])}
                      />
                    </BlockStack>
                  </>
                )}
              </BlockStack>
            )}
          </BlockStack>
        </Card>
        )}

        {showMenu && (
          <Card padding="500">
            <BlockStack gap="400">
              <SectionHeading
                title={hasEverRun ? "Start your next test" : "Pick your question"}
                description="One test at a time — you pick the question, Ello handles the statistics. Stop any time and everything returns instantly."
              />

              <QuestionCard
                icon={HideIcon}
                tone="good"
                question="Does try-on lift my store's sales?"
                learn="A slice of shoppers browses without Ello. Comparing the two groups answers whether try-on causes more sales, store-wide."
                meta="Conversion · order value · returns — one holdout"
                pill={{ label: "Most complete", tone: "neutral" }}
                open={openQuestion === "sitewide"}
                onOpen={() => setOpenQuestion("sitewide")}
                onClose={() => setOpenQuestion(null)}
              >
                {openQuestion === "sitewide" && (
                  <BlockStack gap="300">
                    <AnswerRow
                      icon={HideIcon}
                      tone="good"
                      title="Conversion"
                      text="The holdout never sees try-on. If everyone else buys more often, that gap is the proof."
                    />
                    {ctlFeatureOn ? (
                      <AnswerRow
                        icon={ConnectIcon}
                        tone="money"
                        title="Order value"
                        text="The outfit offer hides from the same shoppers. The order-value gap is what the offer causes."
                      />
                    ) : (
                      <AnswerRow
                        icon={ConnectIcon}
                        tone="neutral"
                        title="Order value"
                        text="Turn on Complete the Look in Widget Design to include the outfit offer in this test."
                      />
                    )}
                    <AnswerRow
                      icon={ReturnIcon}
                      tone="neutral"
                      title="Returns"
                      text="Tried-on purchases get compared with your store's baseline return rate as refunds come in."
                    />
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
                          Start the test
                        </Button>
                      </fetcher.Form>
                      <Text as="span" variant="bodySm" tone="subdued">
                        One holdout, every answer. Sticky per shopper; stop any time.
                      </Text>
                    </InlineStack>
                  </BlockStack>
                )}
              </QuestionCard>

              <QuestionCard
                icon={ProductIcon}
                tone="money"
                question="Which products does try-on actually sell?"
                learn="On the products you pick, half of shoppers see try-on and half don't. Conversion is compared on the same product — a lift leaderboard, product by product."
                meta="50/50 split · needs far less traffic than a small holdout"
                pill={{ label: "Fastest verdict", tone: "good" }}
                open={openQuestion === "product"}
                onOpen={() => setOpenQuestion("product")}
                onClose={() => setOpenQuestion(null)}
              >
                {openQuestion === "product" &&
                  (productSetup?.eligible === false ? (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {productSetup.reason}
                    </Text>
                  ) : (
                    <BlockStack gap="300">
                      {productList.length > 0 ? (
                        <>
                          <Text as="p" variant="bodySm" tone="subdued">
                            Ello pre-picked your most-viewed try-on products from the last 30 days —
                            busy pages reach a verdict fastest. Untick any, or pick your own list.
                          </Text>
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))",
                              gap: 2,
                            }}
                          >
                            {productList.map((p) => (
                              <Checkbox
                                key={p.id}
                                label={p.views ? `${p.title} · ${p.views.toLocaleString()} views` : p.title}
                                checked={selectedIds.has(p.id)}
                                onChange={(checked) =>
                                  setSelectedIds((prev) => {
                                    const next = new Set(prev);
                                    if (checked) next.add(p.id);
                                    else next.delete(p.id);
                                    return next;
                                  })
                                }
                              />
                            ))}
                          </div>
                        </>
                      ) : (
                        <Text as="p" variant="bodySm" tone="subdued">
                          Pick the products to test — your busiest product pages give the fastest
                          verdict. Products must have try-on enabled.
                        </Text>
                      )}
                      <InlineStack gap="300" blockAlign="center" wrap>
                        <Button onClick={pickProducts}>Pick products myself</Button>
                        <Button
                          variant="primary"
                          loading={busy}
                          disabled={selectedCount === 0}
                          onClick={startProductTest}
                        >
                          Start the product test
                        </Button>
                        <MonoMeta>
                          {selectedCount} {selectedCount === 1 ? "product" : "products"} · 50/50 split
                          {estSetupDays != null
                            ? ` · verdict ≈ ${estSetupDays > 60 ? "60+" : estSetupDays} days`
                            : ""}
                        </MonoMeta>
                      </InlineStack>
                      {estSetupDays != null && estSetupDays > 60 && (
                        <Banner tone="warning">
                          <p>
                            These products don&apos;t get enough visits to reach a verdict in a
                            reasonable time. Add more products, or run the store-wide proof test
                            instead.
                          </p>
                        </Banner>
                      )}
                    </BlockStack>
                  ))}
              </QuestionCard>

              <QuestionCard
                icon={ConnectIcon}
                tone="money"
                question="Does the outfit upsell raise order size?"
                learn="Complete the Look hides from a slice of shoppers. The order-value gap between the groups is what the offer causes."
                meta={
                  ctlFeatureOn
                    ? "Runs on its own — and rides along automatically when you start the proof test"
                    : "Turn on Complete the Look in Widget Design first"
                }
                pill={ctlTestRunning ? { label: "Running", tone: "watch" } : { label: "Order value", tone: "money" }}
                action={
                  ctlTestRunning ? (
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="ctl_stop" />
                      <Button submit variant="plain" tone="critical" loading={busy}>
                        Stop
                      </Button>
                    </fetcher.Form>
                  ) : ctlFeatureOn ? (
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="ctl_start" />
                      <input type="hidden" name="ctlHoldoutPercent" value="50" />
                      <Button submit loading={busy}>
                        Start
                      </Button>
                    </fetcher.Form>
                  ) : undefined
                }
              />
            </BlockStack>
          </Card>
        )}

        {(ctlTestRunning || ctlHasWindowData) && (
        <Card padding="500">
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <IconHeading
                icon={ConnectIcon}
                tone="money"
                title="The outfit upsell"
                description="Same holdout, order value. The gap between the groups is what the outfit offer causes."
              />
              {ctlTestRunning && !viewingPast && <StatusPill label="Running" tone="watch" />}
            </InlineStack>

            {(
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
                        {" · stops together with the proof test · the ?ello_ctl=1 preview is paused while the test runs so it can't skew the groups"}
                      </Text>
                    </>
                  ) : (
                    <>
                      <Badge tone="info">{viewingPast ? "Part of this test" : "Window results"}</Badge>
                      <Text as="span" variant="bodySm" tone="subdued">
                        outfit test — {ctlWindowPct}% holdout — over {windowLabel ?? `the last ${rangeDays} days`}
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
                        subline={
                          ctlSignificant
                            ? `${ctlConfidencePct} confidence — measured, not modeled; the only difference between the groups is the offer`
                            : `${ctlConfidencePct ?? "—"} confidence so far — an observed gap, not proof yet; order values swing, so this needs more orders to settle`
                        }
                        pill={{
                          label:
                            ctlLift >= 0
                              ? ctlSignificant
                                ? "Causal AOV lift"
                                : "Early signal"
                              : "No lift yet",
                          tone: ctlLift >= 0 && ctlSignificant ? "good" : "watch",
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
        )}

        {(experiment != null || returnsReady) && (
          <Card padding="500">
            <BlockStack gap="400">
              <IconHeading
                icon={ReturnIcon}
                tone="neutral"
                title="Returns"
                description="Do tried-on items come back less often? Your own refunds against your own baseline."
              />
              {!returnsReady && (
                <Text as="p" tone="subdued">
                  No refunds in this window yet. Refunds land days or weeks after purchases, so
                  this section fills in last — tried-on items will be compared with your
                  store-wide baseline as they arrive.
                </Text>
              )}
              {returnsReady && (
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
              )}
              {returnsReady && returnsGap != null && returnsGap > 0 && (
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
              sliding session. The Order value column shows the whole order; the Tracked sales number above
              counts only the tried-on lines within those orders, so the two won&apos;t match — by design.
              Lift comes only from the holdout test — never from attribution. For the figures behind an
              invoice, use Billing statement: it counts the tried-on lines only, net of returns.
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
