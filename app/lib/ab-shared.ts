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
}

export interface AbVariantStats {
  sessions: number;
  purchaseSessions: number;
  orders: number;
  revenue: number;
  conversionPct: number | null;
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
