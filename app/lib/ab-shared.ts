// Client-safe A/B experiment types + constants (no server imports here —
// app.proof.tsx renders these in the browser; the .server module re-exports
// them for the data layer). Mirrors the analytics-shared.ts pattern.

export type AbExperimentKind = "sitewide" | "product";

/** One product in a product split test, frozen at start time. */
export interface AbTestProduct {
  /** Normalized numeric Shopify product id (matches purchase line_items joins). */
  id: string;
  handle: string;
  title: string;
}

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
  /** 'sitewide' = the classic holdout; 'product' = per-product 50/50 split. */
  kind: AbExperimentKind;
  /** Frozen product list for product tests; null for sitewide. */
  testProducts: AbTestProduct[] | null;
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

/** One arm of one product in a product split test. */
export interface AbProductArmStats {
  sessions: number;
  purchaseSessions: number;
  orders: number;
  revenue: number;
  conversionPct: number | null;
}

export interface AbProductRow {
  productId: string;
  title: string;
  handle: string;
  exposed: AbProductArmStats;
  holdout: AbProductArmStats;
  /** Relative conversion lift on THIS product (bought it / viewed it). */
  relativeLift: number | null;
  /** One-sided confidence exposed beats holdout on this product. */
  confidence: number | null;
  /** True once this product alone clears the per-row verdict bar. */
  hasRowSample: boolean;
}

export interface AbProductResults {
  rows: AbProductRow[];
  /**
   * Pooled across every product in the test. The unit is a (shopper, product)
   * pair: each shopper who viewed a test product counts once per product, and
   * converts by buying that product. This is the test's primary verdict —
   * individual products often can't reach significance on their own.
   */
  pooled: {
    exposed: AbProductArmStats;
    holdout: AbProductArmStats;
    relativeLift: number | null;
    confidence: number | null;
    hasMinimumSample: boolean;
  };
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

// Product split test bars. The POOLED verdict reuses the same 200/arm rule as
// the site-wide test (the pooled unit is a shopper×product view-pair). A
// PER-PRODUCT row only shows its own verdict once that product alone clears
// these — below them the row honestly reads "not enough shoppers yet" instead
// of a fake-precise lift.
export const AB_PRODUCT_ROW_MIN_SESSIONS_PER_ARM = 100;
export const AB_PRODUCT_ROW_MIN_CONVERTERS = 5;
// Cap on how many products one test can hold (the frozen list rides the
// widget config payload on every storefront pageview).
export const AB_PRODUCT_MAX_PRODUCTS = 40;

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
