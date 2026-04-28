# Free Plan (ello_free) — Ello Dashboard Handoff

## What changed in Supabase

1. **New plan row**: `vto_plans.code = 'ello_free'`, `included_tryons_per_month = 10`, `monthly_price = 0`, `overage_usd_per_tryon = 0`.
2. **Default on install**: new Shopify app installs are now provisioned on `ello_free` (not `developer_free`). Existing test/dev stores can be manually bumped to `developer_free` via Supabase for unlimited testing.
3. **`record_tryon_event` RPC**: when a free-plan merchant hits 10 try-ons in the month, the RPC returns a distinct error:
   ```json
   { "allowed": false, "error": "MONTHLY_LIMIT_REACHED", "plan_code": "ello_free",
     "tryons_used": 10, "included_tryons": 10 }
   ```
   (Paid plans keep `OVERAGE_BLOCKED` / `OVERAGE_CAP_REACHED`.)
4. **`get_store_usage` RPC**: now returns `plan_code` alongside existing fields. Call signature unchanged.

Monthly reset is automatic — `record_tryon_event` creates a new `vto_usage_periods` row with `period_end = NOW() + 1 month` on the next request after the prior period expires. No cron needed.

## What the Lovable dashboard needs to implement

### 1. Usage bar at top of dashboard (free plan only)
Call `get_store_usage(p_store_slug)`. When `plan_code === 'ello_free'`:

- Display: `X / 10 try-ons used this month` with a progress bar.
- Progress bar color: default = brand color; **red when `tryons_used >= 8`** (80%).
- Show reset date: format `period_end` as "Resets MMM D".

### 2. Soft upgrade CTA banner (free plan only)
Above the usage bar, show an info banner:

> **You're on the Free plan.**
> Upgrade to unlock unlimited try-ons and full analytics.
> [ Upgrade plan ] → links to the merchant's Shopify admin embedded app billing page (`/app/billing`).

### 3. Locked metrics (free plan only)

Data continues to be tracked for free-plan stores in `tryon_events`, `widget_events`, `cart_events`. When upgraded, the merchant sees full historical data immediately — no migration needed.

For `plan_code === 'ello_free'`, **render the metric card but overlay a lock icon** on:

- **Cart Conversion Rate** — clicks to cart after try-on (from `tryon_events` + `cart_events`).
- **New vs Returning** — session repeat rate (from `widget_events.session_id`).
- **Avg / Session engagement** — average try-ons per session.
- **Revenue Attribution** — try-on → purchase funnel (joins `tryon_events` + the cart-purchase webhook data).

**Click behavior on locked card or lock icon**:
- Open an upgrade modal *or* navigate to the merchant's `/app/billing` page.
- Copy: "Upgrade to unlock this metric."

Paid plans (`plan_code !== 'ello_free'`): show the metrics normally, no lock overlay.

### 4. Upgrade-path UX
When a merchant upgrades from free to paid:
- The Shopify app's billing gate syncs `vto_subscriptions.plan_id` to the paid plan UUID on the next embedded-app page load.
- `get_store_usage` will start returning the new `plan_code` immediately.
- Historical tracking data is already present — no backfill required.
- Branding footer in the widget disappears on the next storefront page load.

## Error taxonomy reference

| Error code | HTTP | When | Widget / dashboard behavior |
|---|---|---|---|
| `MONTHLY_LIMIT_REACHED` | 403 | ello_free, 10 try-ons used | Widget shows "Monthly try-on limit reached. Upgrade to continue." Dashboard shows bar at 10/10 red. |
| `OVERAGE_BLOCKED` | 402 | Paid plan, cap hit, auto-topup off | Existing behavior |
| `OVERAGE_CAP_REACHED` | 402 | Paid plan, overage cap reached | Existing behavior |
| `NO_ACTIVE_SUBSCRIPTION` | 402 | No active sub in Supabase | Should not happen — afterAuth provisions ello_free on install |

## Example RPC response (`get_store_usage`)
```json
{
  "plan_code": "ello_free",
  "plan_name": "Ello Free",
  "included_tryons": 10,
  "tryons_used": 6,
  "tryons_remaining": 4,
  "period_start": "2026-04-01T00:00:00Z",
  "period_end": "2026-05-01T00:00:00Z",
  "overage_auto_topup": false,
  "overage_cap_credits": 100,
  "overage_credits_used": 0,
  "overage_credits_remaining": 100,
  "overage_trigger_threshold": 50,
  "overage_rate": 0.15
}
```
