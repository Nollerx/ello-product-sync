// Widget-wide A/B holdout experiments + proof-report data layer.
//
// The experiment mechanics live in three places that must agree:
//   widget-loader.js   — FNV-1a bucket, session mint, exposure beacon, UI gate
//   ello_ab_bucket()   — the same FNV-1a hash in Postgres (anti-drift)
//   this module        — lifecycle (start/stop), results, significance, receipts
//
// Sessions are the experiment unit (the shopper's 7-day sliding id), exposures
// are the denominators (one row per session per experiment, recorded for BOTH
// variants by the loader), and conversions are any purchase_events row for the
// same session at-or-after first exposure. Revenue is order-deduped, gross of
// returns (no read_orders scope yet — label it that way wherever displayed).

import { supabaseAdmin } from "./supabase.server";
import {
  AB_MIN_SESSIONS_PER_ARM,
  AB_MIN_TOTAL_CONVERTERS,
  AB_PRODUCT_MAX_PRODUCTS,
  AB_PRODUCT_ROW_MIN_CONVERTERS,
  AB_PRODUCT_ROW_MIN_SESSIONS_PER_ARM,
  normalCdf,
  type AbExperiment,
  type AbProductArmStats,
  type AbProductResults,
  type AbProductRow,
  type AbResults,
  type AbTestProduct,
  type AbVariantStats,
  type ReceiptRow,
} from "./ab-shared";

// Types + verdict thresholds live in ab-shared.ts (client-safe — the Proof
// page renders them); re-exported here so server callers import one module.
export {
  AB_MIN_SESSIONS_PER_ARM,
  AB_MIN_TOTAL_CONVERTERS,
  type AbExperiment,
  type AbProductResults,
  type AbProductRow,
  type AbResults,
  type AbTestProduct,
  type AbVariantStats,
  type ReceiptRow,
};

// ─── Experiment lifecycle ───────────────────────────────────────────────────

function mapExperiment(row: Record<string, unknown>): AbExperiment {
  const kind = row.kind === "product" ? ("product" as const) : ("sitewide" as const);
  const rawProducts = Array.isArray(row.test_products) ? (row.test_products as unknown[]) : null;
  const testProducts: AbTestProduct[] | null =
    kind === "product" && rawProducts
      ? rawProducts
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((p: any) => ({
            id: String(p?.id ?? ""),
            handle: String(p?.handle ?? ""),
            title: String(p?.title ?? p?.handle ?? p?.id ?? "Product"),
          }))
          .filter((p) => p.id)
      : null;
  return {
    id: row.id as string,
    storeSlug: row.store_slug as string,
    name: (row.name as string) ?? "Widget holdout test",
    holdoutPercent: Number(row.holdout_percent ?? 10),
    status: (row.status as "running" | "completed") ?? "completed",
    startedAt: row.started_at as string,
    endedAt: (row.ended_at as string | null) ?? null,
    ctlAttached: row.ctl_attached === true,
    kind,
    testProducts,
  };
}

/** The store's most recent experiment (running or completed), if any. */
export async function getLatestExperiment(slug: string): Promise<AbExperiment | null> {
  const { data, error } = await supabaseAdmin
    .from("vto_experiments")
    .select("*")
    .eq("store_slug", slug)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[ab] latest experiment lookup failed (non-fatal):", error.message);
    return null;
  }
  return data ? mapExperiment(data) : null;
}

/** Every experiment for the store, newest first — the Proof page's history picker. */
export async function listExperiments(slug: string): Promise<AbExperiment[]> {
  const { data, error } = await supabaseAdmin
    .from("vto_experiments")
    .select("*")
    .eq("store_slug", slug)
    .order("started_at", { ascending: false })
    .limit(24);
  if (error) {
    console.error("[ab] experiment list failed (non-fatal):", error.message);
    return [];
  }
  return (data ?? []).map(mapExperiment);
}

/**
 * Start a holdout experiment: one running experiment per store (DB-enforced),
 * and the vto_stores ab_* flags flow to the widget via get_widget_config with
 * a config_version bump so live shoppers pick it up within ~30s.
 */
export async function startExperiment(
  slug: string,
  holdoutPercent: number,
): Promise<{ ok: boolean; error?: string; experimentId?: string }> {
  const pct = Math.round(holdoutPercent);
  if (!Number.isFinite(pct) || pct < 1 || pct > 50) {
    return { ok: false, error: "Holdout must be between 1% and 50%." };
  }
  const { data, error } = await supabaseAdmin
    .from("vto_experiments")
    .insert({ store_slug: slug, holdout_percent: pct, status: "running" })
    .select("id")
    .single();
  if (error || !data) {
    const msg = error?.message ?? "insert failed";
    if (msg.includes("uq_vto_experiments_one_running")) {
      return { ok: false, error: "An experiment is already running for this store." };
    }
    console.error("[ab] start experiment failed:", msg);
    return { ok: false, error: "Could not start the experiment. Try again." };
  }
  const { error: storeErr } = await supabaseAdmin
    .from("vto_stores")
    .update({
      ab_experiment_enabled: true,
      ab_experiment_id: data.id,
      ab_holdout_percent: pct,
      ab_experiment_kind: "sitewide",
      ab_test_products: null,
    })
    .eq("store_slug", slug);
  if (storeErr) {
    // Roll the experiment row back so the store can retry cleanly.
    await supabaseAdmin.from("vto_experiments").delete().eq("id", data.id);
    console.error("[ab] store flag update failed:", storeErr.message);
    return { ok: false, error: "Could not activate the experiment on the widget." };
  }
  return { ok: true, experimentId: data.id as string };
}

/**
 * Start a product split test: on the chosen products, every shopper is split
 * 50/50 (product-salted hash) — half see try-on, half don't — and conversion
 * is compared on the same product. The product list freezes on the experiment
 * row (with titles, for the readout) and a slim {id, handle} copy rides
 * vto_stores → get_widget_config to the loader.
 */
export async function startProductExperiment(
  slug: string,
  products: AbTestProduct[],
): Promise<{ ok: boolean; error?: string; experimentId?: string }> {
  const clean = products
    .map((p) => ({
      id: String(p.id).replace(/^.*\//, ""),
      handle: String(p.handle || "").toLowerCase(),
      title: String(p.title || p.handle || p.id),
    }))
    .filter((p) => /^\d{1,20}$/.test(p.id) && p.handle.length > 0);
  if (clean.length === 0) {
    return { ok: false, error: "Pick at least one product for the test." };
  }
  if (clean.length > AB_PRODUCT_MAX_PRODUCTS) {
    return { ok: false, error: `A test can hold at most ${AB_PRODUCT_MAX_PRODUCTS} products.` };
  }
  const { data, error } = await supabaseAdmin
    .from("vto_experiments")
    .insert({
      store_slug: slug,
      name: "Product split test",
      holdout_percent: 50,
      status: "running",
      kind: "product",
      test_products: clean,
    })
    .select("id")
    .single();
  if (error || !data) {
    const msg = error?.message ?? "insert failed";
    if (msg.includes("uq_vto_experiments_one_running")) {
      return { ok: false, error: "A test is already running — one question at a time." };
    }
    console.error("[ab] start product experiment failed:", msg);
    return { ok: false, error: "Could not start the test. Try again." };
  }
  const { error: storeErr } = await supabaseAdmin
    .from("vto_stores")
    .update({
      ab_experiment_enabled: true,
      ab_experiment_id: data.id,
      ab_holdout_percent: 50,
      ab_experiment_kind: "product",
      ab_test_products: clean.map(({ id, handle }) => ({ id, handle })),
    })
    .eq("store_slug", slug);
  if (storeErr) {
    await supabaseAdmin.from("vto_experiments").delete().eq("id", data.id);
    console.error("[ab] product store flag update failed:", storeErr.message);
    return { ok: false, error: "Could not activate the test on the widget." };
  }
  return { ok: true, experimentId: data.id as string };
}

/** Stop the running experiment: freeze the measurement window, release the widget. */
export async function stopExperiment(
  slug: string,
  experimentId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabaseAdmin
    .from("vto_experiments")
    .update({ status: "completed", ended_at: new Date().toISOString() })
    .eq("id", experimentId)
    .eq("store_slug", slug)
    .eq("status", "running");
  if (error) {
    console.error("[ab] stop experiment failed:", error.message);
    return { ok: false, error: "Could not stop the experiment." };
  }
  const { error: storeErr } = await supabaseAdmin
    .from("vto_stores")
    .update({ ab_experiment_enabled: false, ab_experiment_kind: "sitewide", ab_test_products: null })
    .eq("store_slug", slug);
  if (storeErr) {
    console.error("[ab] store flag release failed:", storeErr.message);
    return { ok: false, error: "Experiment stopped, but the widget flag didn't release. Retry." };
  }
  return { ok: true };
}

// ─── Results + significance ────────────────────────────────────────────────

/**
 * One-sided two-proportion z-test: how confident are we that the exposed group
 * converts better than the holdout? Returns null when either arm is empty.
 */
export function twoProportionConfidence(
  exposedConverters: number,
  exposedSessions: number,
  holdoutConverters: number,
  holdoutSessions: number,
): number | null {
  if (exposedSessions <= 0 || holdoutSessions <= 0) return null;
  const p1 = exposedConverters / exposedSessions;
  const p2 = holdoutConverters / holdoutSessions;
  const pooled = (exposedConverters + holdoutConverters) / (exposedSessions + holdoutSessions);
  if (pooled <= 0 || pooled >= 1) return null;
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / exposedSessions + 1 / holdoutSessions));
  if (se === 0) return null;
  const z = (p1 - p2) / se;
  return normalCdf(z);
}

export async function getExperimentResults(
  slug: string,
  experimentId: string,
): Promise<AbResults | null> {
  const { data, error } = await supabaseAdmin.rpc("get_ab_experiment_results", {
    p_store_slug: slug,
    p_experiment_id: experimentId,
  });
  if (error) {
    console.error("[ab] experiment results failed (non-fatal):", error.message);
    return null;
  }
  const empty: AbVariantStats = {
    sessions: 0,
    purchaseSessions: 0,
    orders: 0,
    revenue: 0,
    conversionPct: null,
    pdpSessions: 0,
    pdpPurchaseSessions: 0,
    pdpConversionPct: null,
  };
  const byVariant: Record<string, AbVariantStats> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of (data ?? []) as any[]) {
    byVariant[row.variant as string] = {
      sessions: Number(row.sessions ?? 0),
      purchaseSessions: Number(row.purchase_sessions ?? 0),
      orders: Number(row.orders ?? 0),
      revenue: Number(row.revenue ?? 0),
      conversionPct: row.conversion_pct == null ? null : Number(row.conversion_pct),
      pdpSessions: Number(row.pdp_sessions ?? 0),
      pdpPurchaseSessions: Number(row.pdp_purchase_sessions ?? 0),
      pdpConversionPct: row.pdp_conversion_pct == null ? null : Number(row.pdp_conversion_pct),
    };
  }
  const exposed = byVariant.exposed ?? empty;
  const holdout = byVariant.holdout ?? empty;

  const crE = exposed.sessions > 0 ? exposed.purchaseSessions / exposed.sessions : null;
  const crH = holdout.sessions > 0 ? holdout.purchaseSessions / holdout.sessions : null;
  const relativeLift = crE != null && crH != null && crH > 0 ? (crE - crH) / crH : null;
  const confidence = twoProportionConfidence(
    exposed.purchaseSessions,
    exposed.sessions,
    holdout.purchaseSessions,
    holdout.sessions,
  );
  // Lift-implied incremental revenue: revenue-per-session delta scaled across
  // the exposed arm. The conservative "floor" number for the proof report.
  const rpsE = exposed.sessions > 0 ? exposed.revenue / exposed.sessions : null;
  const rpsH = holdout.sessions > 0 ? holdout.revenue / holdout.sessions : null;
  const incrementalRevenue =
    rpsE != null && rpsH != null ? Math.max(0, (rpsE - rpsH) * exposed.sessions) : null;

  const hasMinimumSample =
    exposed.sessions >= AB_MIN_SESSIONS_PER_ARM &&
    holdout.sessions >= AB_MIN_SESSIONS_PER_ARM &&
    exposed.purchaseSessions + holdout.purchaseSessions >= AB_MIN_TOTAL_CONVERTERS;

  // Product-page cut lift — diagnostic only (see AbVariantStats.pdpSessions).
  const pdpCrE = exposed.pdpSessions > 0 ? exposed.pdpPurchaseSessions / exposed.pdpSessions : null;
  const pdpCrH = holdout.pdpSessions > 0 ? holdout.pdpPurchaseSessions / holdout.pdpSessions : null;
  const pdpRelativeLift =
    pdpCrE != null && pdpCrH != null && pdpCrH > 0 ? (pdpCrE - pdpCrH) / pdpCrH : null;

  return { exposed, holdout, relativeLift, confidence, incrementalRevenue, hasMinimumSample, pdpRelativeLift };
}

const emptyProductArm = (): AbProductArmStats => ({
  sessions: 0,
  purchaseSessions: 0,
  orders: 0,
  revenue: 0,
  conversionPct: null,
});

/**
 * Product split test readout. The unit is a (shopper, product) view-pair;
 * conversion means the shopper bought THAT product. Pooled numbers are the
 * primary verdict (per-product rows are often underpowered on their own);
 * each row only shows its own verdict once it clears the per-row sample bar.
 */
export async function getProductExperimentResults(
  slug: string,
  experiment: AbExperiment,
): Promise<AbProductResults | null> {
  const { data, error } = await supabaseAdmin.rpc("get_ab_product_results", {
    p_store_slug: slug,
    p_experiment_id: experiment.id,
  });
  if (error) {
    console.error("[ab] product results failed (non-fatal):", error.message);
    return null;
  }
  const byProduct = new Map<string, { exposed: AbProductArmStats; holdout: AbProductArmStats }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of (data ?? []) as any[]) {
    const pid = String(row.product_id ?? "");
    if (!pid) continue;
    const entry = byProduct.get(pid) ?? { exposed: emptyProductArm(), holdout: emptyProductArm() };
    const arm: AbProductArmStats = {
      sessions: Number(row.sessions ?? 0),
      purchaseSessions: Number(row.purchase_sessions ?? 0),
      orders: Number(row.orders ?? 0),
      revenue: Number(row.revenue ?? 0),
      conversionPct: row.conversion_pct == null ? null : Number(row.conversion_pct),
    };
    if (row.variant === "holdout") entry.holdout = arm;
    else entry.exposed = arm;
    byProduct.set(pid, entry);
  }

  const meta = new Map((experiment.testProducts ?? []).map((p) => [p.id, p]));
  const rows: AbProductRow[] = [];
  // Every product in the frozen list gets a row, even with zero exposures yet.
  const allIds = new Set<string>([...meta.keys(), ...byProduct.keys()]);
  for (const pid of allIds) {
    const arms = byProduct.get(pid) ?? { exposed: emptyProductArm(), holdout: emptyProductArm() };
    const m = meta.get(pid);
    const crE = arms.exposed.sessions > 0 ? arms.exposed.purchaseSessions / arms.exposed.sessions : null;
    const crH = arms.holdout.sessions > 0 ? arms.holdout.purchaseSessions / arms.holdout.sessions : null;
    rows.push({
      productId: pid,
      title: m?.title ?? pid,
      handle: m?.handle ?? "",
      exposed: arms.exposed,
      holdout: arms.holdout,
      relativeLift: crE != null && crH != null && crH > 0 ? (crE - crH) / crH : null,
      confidence: twoProportionConfidence(
        arms.exposed.purchaseSessions,
        arms.exposed.sessions,
        arms.holdout.purchaseSessions,
        arms.holdout.sessions,
      ),
      hasRowSample:
        arms.exposed.sessions >= AB_PRODUCT_ROW_MIN_SESSIONS_PER_ARM &&
        arms.holdout.sessions >= AB_PRODUCT_ROW_MIN_SESSIONS_PER_ARM &&
        arms.exposed.purchaseSessions + arms.holdout.purchaseSessions >= AB_PRODUCT_ROW_MIN_CONVERTERS,
    });
  }
  // Busiest products first — that's where verdicts land first.
  rows.sort((a, b) => b.exposed.sessions + b.holdout.sessions - (a.exposed.sessions + a.holdout.sessions));

  const pooledArm = (pick: (r: AbProductRow) => AbProductArmStats): AbProductArmStats => {
    const sum = rows.reduce(
      (acc, r) => {
        const a = pick(r);
        acc.sessions += a.sessions;
        acc.purchaseSessions += a.purchaseSessions;
        acc.orders += a.orders;
        acc.revenue += a.revenue;
        return acc;
      },
      emptyProductArm(),
    );
    sum.conversionPct = sum.sessions > 0 ? Math.round((10000 * sum.purchaseSessions) / sum.sessions) / 100 : null;
    return sum;
  };
  const exposed = pooledArm((r) => r.exposed);
  const holdout = pooledArm((r) => r.holdout);
  const crE = exposed.sessions > 0 ? exposed.purchaseSessions / exposed.sessions : null;
  const crH = holdout.sessions > 0 ? holdout.purchaseSessions / holdout.sessions : null;
  return {
    rows,
    pooled: {
      exposed,
      holdout,
      relativeLift: crE != null && crH != null && crH > 0 ? (crE - crH) / crH : null,
      confidence: twoProportionConfidence(
        exposed.purchaseSessions,
        exposed.sessions,
        holdout.purchaseSessions,
        holdout.sessions,
      ),
      hasMinimumSample:
        exposed.sessions >= AB_MIN_SESSIONS_PER_ARM &&
        holdout.sessions >= AB_MIN_SESSIONS_PER_ARM &&
        exposed.purchaseSessions + holdout.purchaseSessions >= AB_MIN_TOTAL_CONVERTERS,
    },
  };
}

/** Most-viewed products (normalized numeric ids) — the "choose for me" list. */
export async function getTopViewedProducts(
  slug: string,
  days = 30,
  limit = 20,
): Promise<Array<{ productId: string; views: number }>> {
  const { data, error } = await supabaseAdmin.rpc("get_vto_top_viewed_products", {
    p_store_slug: slug,
    p_days: days,
    p_limit: limit,
  });
  if (error) {
    console.error("[ab] top viewed lookup failed (non-fatal):", error.message);
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((data ?? []) as any[])
    .map((r) => ({ productId: String(r.product_id ?? ""), views: Number(r.views ?? 0) }))
    .filter((r) => /^\d{1,20}$/.test(r.productId));
}

// ─── Receipts ledger ────────────────────────────────────────────────────────

export async function getReceipts(
  slug: string,
  from: Date,
  to: Date,
  limit = 100,
): Promise<ReceiptRow[]> {
  const { data, error } = await supabaseAdmin.rpc("get_vto_receipts", {
    p_store_slug: slug,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_limit: limit,
  });
  if (error) {
    console.error("[ab] receipts fetch failed (non-fatal):", error.message);
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((data ?? []) as any[]).map((r) => ({
    orderId: (r.order_id as string | null) ?? null,
    productId: (r.product_id as string | null) ?? null,
    triedOnAt: r.tried_on_at as string,
    purchasedAt: r.purchased_at as string,
    secondsToPurchase: Number(r.seconds_to_purchase ?? 0),
    totalPrice: Number(r.total_price ?? 0),
    currency: (r.currency as string | null) ?? null,
    sessionId: (r.session_id as string | null) ?? null,
  }));
}
