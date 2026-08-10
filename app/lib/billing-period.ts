// Billing period resolution, shared by the statement page and its CSV export so
// the two can never disagree about which sales belong to an invoice.
//
// Months are cut on the MERCHANT'S clock, not UTC. A store in America/Chicago
// selling at 11pm on Jul 31 is on the July invoice; cutting on UTC would push
// that sale into August and it would silently move between two bills. The
// boundaries are returned as exact instants so the RPC's timestamptz comparison
// does the right thing regardless of the server's own zone.

export interface BillingPeriod {
  /** "2026-07" — the canonical key, also what the export takes as ?month=. */
  key: string;
  /** Inclusive start instant. */
  from: Date;
  /** Exclusive end instant. */
  to: Date;
  /** "July 2026" */
  label: string;
  timeZone: string;
}

const MONTH_KEY = /^(\d{4})-(\d{2})$/;

/** The UTC instant at which `y-m-d 00:00:00` begins in `timeZone`.
 *
 *  Intl gives us the wall-clock reading of a guessed instant in the target
 *  zone; the gap between that reading and the wall clock we wanted is the
 *  offset, so subtracting it lands on the real instant. Applied twice because
 *  the offset itself can differ across a DST boundary — the second pass uses
 *  the offset in effect at the corrected instant. */
function zonedStartOfDay(year: number, month: number, day: number, timeZone: string): Date {
  const wanted = Date.UTC(year, month - 1, day, 0, 0, 0);
  let instant = wanted;
  for (let pass = 0; pass < 2; pass++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instant));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const readAs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    const offset = readAs - instant;
    if (offset === 0) break;
    instant = wanted - offset;
  }
  return new Date(instant);
}

function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, 1)));
}

/** Resolve `?month=YYYY-MM` into a period. Unparseable or out-of-range input
 *  falls back to the current month rather than erroring — a bad query string
 *  should never 500 a billing page. */
export function resolveBillingPeriod(monthKey: string | null, timeZone: string): BillingPeriod {
  const now = new Date();
  let year: number;
  let month: number;

  const m = monthKey ? MONTH_KEY.exec(monthKey) : null;
  if (m) {
    year = Number(m[1]);
    month = Number(m[2]);
  } else {
    // "Current month" means current on the merchant's clock too.
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit" })
      .formatToParts(now);
    year = Number(parts.find((p) => p.type === "year")?.value ?? now.getUTCFullYear());
    month = Number(parts.find((p) => p.type === "month")?.value ?? now.getUTCMonth() + 1);
  }
  if (!(month >= 1 && month <= 12) || !(year >= 2000 && year <= 2999)) {
    year = now.getUTCFullYear();
    month = now.getUTCMonth() + 1;
  }

  const from = zonedStartOfDay(year, month, 1, timeZone);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const to = zonedStartOfDay(nextYear, nextMonth, 1, timeZone);

  return {
    key: `${year}-${String(month).padStart(2, "0")}`,
    from,
    to,
    label: monthLabel(year, month),
    timeZone,
  };
}

/** The most recent `count` month keys, newest first, on the merchant's clock —
 *  the options offered in the statement's month picker. */
export function recentMonthKeys(timeZone: string, count = 12): { key: string; label: string }[] {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit" })
    .formatToParts(new Date());
  let year = Number(parts.find((p) => p.type === "year")?.value ?? new Date().getUTCFullYear());
  let month = Number(parts.find((p) => p.type === "month")?.value ?? new Date().getUTCMonth() + 1);

  const out: { key: string; label: string }[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ key: `${year}-${String(month).padStart(2, "0")}`, label: monthLabel(year, month) });
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return out;
}
