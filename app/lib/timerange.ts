// Shared time-range handling for the analytics surfaces (Home + Analytics).
// The selected range lives in the `range` search param so it survives
// navigation and can drive every loader on the page.

export type RangeKey = "7d" | "30d" | "90d";

export const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
];

export const RANGE_DAYS: Record<RangeKey, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

export function parseRange(value: string | null): RangeKey {
  return value === "7d" || value === "90d" ? value : "30d";
}

export interface RangeWindow {
  key: RangeKey;
  days: number;
  from: Date;
  to: Date;
  /** Same-length window immediately before `from`, for deltas. */
  prevFrom: Date;
  prevTo: Date;
}

export function rangeWindow(key: RangeKey, now = new Date()): RangeWindow {
  const days = RANGE_DAYS[key];
  const ms = days * 24 * 60 * 60 * 1000;
  const from = new Date(now.getTime() - ms);
  return {
    key,
    days,
    from,
    to: now,
    prevFrom: new Date(from.getTime() - ms),
    prevTo: from,
  };
}

/** % change vs previous period; null when there's no baseline. */
export function pctDelta(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}
