// Client-safe A/B experiment types + constants (no server imports here —
// app.proof.tsx renders these in the browser; the .server module re-exports
// them for the data layer). Mirrors the analytics-shared.ts pattern.

export interface AbExperiment {
  id: string;
  storeSlug: string;
  name: string;
  holdoutPercent: number;
  status: "running" | "completed";
  startedAt: string;
  endedAt: string | null;
  /** True when the outfit (CTL) split rode along with this test's unified start. */
  ctlAttached: boolean;
}

export interface AbVariantStats {
  sessions: number;
  purchaseSessions: number;
  orders: number;
  revenue: number;
  conversionPct: number | null;
  /**
   * Product-page cut: same arm, restricted to sessions that viewed at least
   * one product page (saw_pdp stamp). Diagnostic view only — the site-wide
   * numbers above are the causal readout, because reaching a product page is
   * itself behavior the widget can influence. Zero until the saw_pdp loader
   * ships; sessions from before then are never counted here.
   */
  pdpSessions: number;
  pdpPurchaseSessions: number;
  pdpConversionPct: number | null;
}

export interface AbResults {
  exposed: AbVariantStats;
  holdout: AbVariantStats;
  /** Relative conversion lift, e.g. 0.13 = +13%. Null until both arms have data. */
  relativeLift: number | null;
  /** One-sided confidence that exposed converts better than holdout (0-1). */
  confidence: number | null;
  /** Lift-implied incremental revenue across exposed sessions (the "floor"). */
  incrementalRevenue: number | null;
  /** True once both arms clear the minimum sample bar for showing verdicts. */
  hasMinimumSample: boolean;
  /** Relative lift on the product-page cut (diagnostic — no verdict attached). */
  pdpRelativeLift: number | null;
}

export interface ReceiptRow {
  orderId: string | null;
  productId: string | null;
  triedOnAt: string;
  purchasedAt: string;
  secondsToPurchase: number;
  totalPrice: number;
  currency: string | null;
  sessionId: string | null;
}

// Verdicts only render once both arms are past these bars — below them the UI
// shows a "collecting data" state instead of a premature number.
export const AB_MIN_SESSIONS_PER_ARM = 200;
export const AB_MIN_TOTAL_CONVERTERS = 10;

// Complete-the-Look holdout test: the causal AOV lift renders once each arm has
// this many attributed orders (AOV needs orders, not sessions, to stabilize).
export const CTL_MIN_ORDERS_PER_ARM = 10;

// One-sided confidence a verdict must clear before the UI calls anything
// "causal" — same bar for the conversion z-test and the AOV t-test.
export const AB_VERDICT_CONFIDENCE = 0.95;

/** Standard normal CDF via the Abramowitz–Stegun erf approximation (|ε| < 1.5e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2);
  const erf =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * One-sided Welch t-test on AOV: how confident are we that the treatment arm's
 * average order value beats the holdout's? AOV is a high-variance mean, so the
 * arms' order counts alone say nothing — this needs the per-arm spread the RPC
 * now returns. Student-t CDF via the A&S 26.7.8 normal approximation (good to
 * ~3 decimals for df ≥ 5; verdicts gate at CTL_MIN_ORDERS_PER_ARM anyway).
 * Returns null when either arm lacks the data for a variance (n < 2 or no
 * stddev — e.g. every order the same price).
 */
export function welchAovConfidence(
  treatmentMean: number | null,
  treatmentStddev: number | null,
  treatmentN: number,
  holdoutMean: number | null,
  holdoutStddev: number | null,
  holdoutN: number,
): number | null {
  if (treatmentMean == null || holdoutMean == null) return null;
  if (treatmentStddev == null || holdoutStddev == null) return null;
  if (treatmentN < 2 || holdoutN < 2) return null;
  const v1 = (treatmentStddev * treatmentStddev) / treatmentN;
  const v2 = (holdoutStddev * holdoutStddev) / holdoutN;
  const se = Math.sqrt(v1 + v2);
  if (!Number.isFinite(se) || se <= 0) return null;
  const t = (treatmentMean - holdoutMean) / se;
  // Welch–Satterthwaite degrees of freedom.
  const df =
    ((v1 + v2) * (v1 + v2)) /
    ((v1 * v1) / (treatmentN - 1) + (v2 * v2) / (holdoutN - 1));
  if (!Number.isFinite(df) || df <= 0) return null;
  // Normal approximation to the t CDF (A&S 26.7.8).
  const z = (t * (1 - 1 / (4 * df))) / Math.sqrt(1 + (t * t) / (2 * df));
  return normalCdf(z);
}
