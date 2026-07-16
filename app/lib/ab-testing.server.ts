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
  normalCdf,
  type AbExperiment,
  type AbResults,
  type AbVariantStats,
  type ReceiptRow,
} from "./ab-shared";

// Types + verdict thresholds live in ab-shared.ts (client-safe — the Proof
// page renders them); re-exported here so server callers import one module.
export {
  AB_MIN_SESSIONS_PER_ARM,
  AB_MIN_TOTAL_CONVERTERS,
  type AbExperiment,
  type AbResults,
  type AbVariantStats,
  type ReceiptRow,
};

// ─── Experiment lifecycle ───────────────────────────────────────────────────

function mapExperiment(row: Record<string, unknown>): AbExperiment {
  return {
    id: row.id as string,
    storeSlug: row.store_slug as string,
    name: (row.name as string) ?? "Widget holdout test",
    holdoutPercent: Number(row.holdout_percent ?? 10),
    status: (row.status as "running" | "completed") ?? "completed",
    startedAt: row.started_at as string,
    endedAt: (row.ended_at as string | null) ?? null,
    ctlAttached: row.ctl_attached === true,
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
    .update({ ab_experiment_enabled: false })
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

  return { exposed, holdout, relativeLift, confidence, incrementalRevenue, hasMinimumSample };
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
