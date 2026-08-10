// Per-instance TTL caches that short-circuit the /app/* layout gate.
//
// The gate in app.tsx protects two invariants: (1) unfinished installs get
// routed into onboarding, and (2) unprovisioned shops get routed to billing.
// Both checks cost 3-4 Supabase round trips plus a live Shopify billing.check
// on EVERY /app/* navigation. Once a shop has passed the gate (onboarding
// complete + an active subscription), that verdict is stable for minutes at a
// time — so we cache ONLY the positive verdict, briefly, in instance memory.
//
// Safety properties:
// - Negative outcomes (redirects) are never cached, so a brand-new install can
//   never be waved through.
// - The `billing=activating` polling flow bypasses the cache at the call site,
//   so plan activation is detected live.
// - Worst-case staleness is GATE_TTL_MS: a plan change made directly on
//   Shopify syncs on the first gate pass after expiry.

const GATE_TTL_MS = 5 * 60_000;

const allowedAt = new Map<string, number>();

/** True if this shop passed the full gate within the TTL. */
export function gateAllowedRecently(shop: string): boolean {
  const at = allowedAt.get(shop);
  if (at == null) return false;
  if (Date.now() - at > GATE_TTL_MS) {
    allowedAt.delete(shop);
    return false;
  }
  return true;
}

/** Record a full successful gate pass (onboarding complete + billing allowed). */
export function markGateAllowed(shop: string): void {
  allowedAt.set(shop, Date.now());
}

/** Drop the cached verdict (e.g. on uninstall webhooks). */
export function invalidateGate(shop: string): void {
  allowedAt.delete(shop);
}
