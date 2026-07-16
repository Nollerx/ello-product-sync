# A/B Testing Audit Report — 2026-07-15

> **Fix status (updated same day):** every confirmed finding below is FIXED as
> of 2026-07-15 except where noted. Code: loader cart-attr write for both arms
> (#1), CTL end-clamp + frozen per-test pct/window + `COALESCE(order_id, id)`
> + per-arm stddev (migration `20260715_ctl_test_integrity`, applied to prod and
> registered), Welch-gated CTL verdict + dynamic percent label (#2/#9),
> `?ello_ctl=1` ignored while a test runs (#4), cookie read-back before minting
> (#7), fitting-room block default-hidden until config resolves (#8), CSV export
> honors the pinned window, Tracked-sales copy now says tried-on-line revenue.
> The anon RPC exposure (#6) was independently fixed the same day by the
> broader anon-hardening pass (`20260715_revoke_anon_execute_on_sensitive_rpcs`,
> verified live: reporting + ingest RPCs now service-role only). #10's
> zero-exposure experiment turned out to be the deliberately-reverted 2-minute
> Atlas start from 07-14 — and the beacon HAD landed organic rows in the
> 2026-07-13 live E2E (cleaned up afterward), so the ingest path is confirmed.
> Verified: typecheck/lint/build clean; browser harness E2E on both arms
> against live prod config; node unit tests of the CTL gate + cookie fallback
> against the real source; live RPC smoke on both call shapes. NOT yet
> deployed: Cloud Run deploy blocked on gcloud reauth (`gcloud auth login`,
> interactive) — DB changes are live now, app/widget changes ship with the next
> deploy (custom first; PUBLIC also bundles unsigned parity work + blocked
> Shopify version). Not done: rate limiting on the ingest route (accepted risk
> for now), storefront-token rotation recommended by the hardening migration.

Multi-agent audit (6 dimensions, adversarially verified) of the widget-wide A/B holdout ("proof test") and the CTL 50/50 holdout, covering bucketing, holdout suppression, exposure logging, purchase attribution, Proof-page statistics, and the live production database.

**Overall verdict: the widget-wide proof test's core machinery is sound and can be trusted for the two-bucket + holdout design. The defects cluster in (1) one lift-inflating attribution asymmetry, (2) the CTL side, and (3) label honesty.** Fix the items below before the BOA pilot readout.

---

## Verified correct (evidence-backed, not assumed)

- **Hash parity JS ↔ SQL**: `elloAbFnvBucket` (`public/widget-loader.js:486`) vs live prod `public.ello_ab_bucket()` — 400k randomized local cases + 20/20 live-DB parity checks (UUIDs, 64-char ids, unicode, the `:ctl` salt): **0 mismatches**. Bucket distribution uniform (1M ids: 9,757–10,193 per bucket).
- **Boundary semantics consistent at all 4 decision points**: holdout iff `bucket < percent` in loader (`widget-loader.js:594`), server anti-forgery (`20260710_ab_holdout_proof.sql:105`), CTL widget (`widget-main.js:7627`), CTL SQL exact complement (`20260713_ctl_holdout_percent.sql:170`). No inverted arm anywhere.
- **The 2026-07-13 column-swap fix is safe**: present in live prod, in `20260713_fix_ab_exposure_insert_swap.sql`, in the fixed-in-place `20260710` migration, and the fix migration is registered in the prod migration table — **the next deploy cannot revert it**. No drift in any AB/CTL function between prod and tree.
- **Arm mapping is by name, never by position**, loader → RPC → `ab-testing.server.ts:202` → Proof page (`app.proof.tsx:909`). A future column reorder can't swap the arms again.
- **Holdout suppression** happens at a single choke point (`elloAbApplyHoldout`, `widget-loader.js:578`): all seven surface kill-switches forced off before `ello:config-resolved`; `initializeWidget` bails before any DOM injection or widget-main.js load; hub links hidden. Holdout shoppers still get session id + pixel cookie every pageview, so denominators and their purchases keep flowing.
- **Exposure logging is symmetric and deduped**: one beacon call for both arms at the same point (`widget-loader.js:613`), same sendBeacon/keepalive transport; localStorage marker + unique index `(experiment_id, session_id)` + `ON CONFLICT DO NOTHING`. Live data: 0 duplicates, 0 NULLs, seeded 20% experiment splits 19.99/80.01 with buckets partitioning exactly at the threshold.
- **Overrides excluded (widget test)**: `?ello_ab=` and `?ello_preview=1` sessions never write exposure rows (`widget-loader.js:613`), and the server independently recomputes the hash and rejects any variant/bucket that disagrees or any non-running experiment.
- **Conversion windows sound**: purchases join exposures on session id within `[first_seen_at, ended_at]`; orders deduped via `COALESCE(order_id, id::text)` + prod unique index on `order_id`; one variant per session by construction.
- **Statistics honest for the widget test**: one-sided pooled two-proportion z-test and Abramowitz–Stegun normal CDF verified numerically (`ab-testing.server.ts:152-181`); verdicts gated at 200 sessions/arm + 10 converters (`ab-shared.ts:49`); lift computed on rates (correct for a 10% holdout); incremental revenue floored and labeled a floor.
- **Experiments independent**: widget test salts with the per-experiment UUID, CTL salts with `':ctl'`; widget-holdout shoppers are excluded from CTL entirely.
- **Session identity unified** across exposure/try-on/purchase (loader and widget-main share slug-derived keys, 7-day sliding window, cookie mirror; widget-main adopts the loader's id when storage is blocked).

Three findings were **refuted** in verification: percent two-sources-of-truth drift (written atomically with rollback), refund-netting GID format mismatch, and an experiment-start UI race (guarded by the `lateHoldout` path, `widget-loader.js:607`).

---

## Confirmed findings

### 1. HIGH — Attribution asymmetry inflates measured lift (found independently by 4 of 5 auditors)

At `checkout_completed` the pixel tries the `ello_session_id` cookie, then falls back to the cart attribute, and **drops the purchase if both are missing** (`extensions/ello-conversion-pixel/src/index.js:68-74`). The cart attribute is written only by widget-main.js (`elloWriteSessionCartAttr`, fired after try-on at `widget-main.js:10768` and on widget add-to-cart) — and **holdout shoppers never load widget-main.js**. So whenever the cookie is unreadable at purchase time (7-day cookie max-age vs indefinite cart attributes, Shop Pay / cross-origin checkout, ITP/consent-manager cookie purges — BOA is UK/GDPR territory), exposed purchases are rescued and holdout purchases silently vanish. Holdout conversions are systematically undercounted → **lift overstated, in the dishonest direction for a pilot readout**.

**Fix direction**: when an experiment is running, have widget-loader (which runs for both arms) write the same cart attribute for every shopper; or ignore the cart-attribute fallback for experiment-enrolled sessions so both arms are symmetrically cookie-only.

### 2. HIGH — CTL card claims "Causal AOV lift" with no significance test

`app.proof.tsx:1011` stamps a green causal verdict at as few as 10 orders/arm with zero variance testing (AOV is high-variance). The widget test gates properly; the CTL card doesn't. Soften the label or add a gate.

### 3. HIGH — CTL arms have no end-of-test clamp and no percent history

- No `disabled_at` bound: after a CTL test stops, rolling 30-day windows keep classifying new sessions into "holdout" even though everyone sees the rail (`20260713_ctl_holdout_percent.sql:160`).
- Arms are recomputed from **current** store state: restarting with a different percent silently reclassifies historical sessions and changes past readouts (`:166`).

The widget test handles both correctly (`ended_at` clamp, percent frozen on `vto_experiments`) — mirror that for CTL.

### 4. MEDIUM — `?ello_ctl=1` override contaminates CTL data

Widget-test overrides are excluded from data; the CTL override is not (`widget-main.js:7636-7640`), and the Proof page advertises the link to merchants. Exclude override sessions from CTL rows.

### 5. MEDIUM — `get_ctl_performance` groups by nullable `order_id`

All NULL-order-id purchases collapse into one pseudo-order with an arbitrary `MIN(session_id)` arm assignment (`20260713_ctl_holdout_percent.sql:150,184`). Use `COALESCE(order_id, id::text)` like the widget-test RPC does.

### 6. MEDIUM — Experiment data is forgeable / readable by anonymous callers (live DB)

- `record_ab_exposure` is anon-callable and the FNV hash is public, so an attacker can mine session ids for either arm and post unlimited valid exposures (no rate limit); `record_purchase_event` (7-arg) has no explicit REVOKE and is plausibly anon-executable — together enough to manufacture any lift number on the sales-critical Proof page (`20260710_ab_holdout_proof.sql:115`).
- Live `proacl` shows anon EXECUTE on `get_ab_experiment_results`, `get_ctl_performance`, `get_vto_receipts` (SECURITY DEFINER; migrations granted service_role but never revoked PUBLIC default). Anyone with a store slug can read any merchant's results and receipt ledger. **Fix: `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated`** on the reporting RPCs; add rate limiting/authenticity binding on the ingest RPCs.

### 7. MEDIUM — Storage-blocked browsers mint a new session per pageview

The loader writes a cookie mirror but never reads it back when localStorage is unavailable (`widget-loader.js:521`): inflated denominators and per-pageview arm flip-flop (dilutive, but noisy). Read the cookie as a fallback before minting.

### 8. MEDIUM — Fitting-room theme block flashes for holdout shoppers

`extensions/ello-theme-extension/blocks/fitting-room.liquid:199` has no pre-config hiding and no AB check in its fast path — holdout shoppers see the hub surface during the pre-decision window on every pageview. Hide until config resolves, like the other surfaces.

### 9. MEDIUM — Label/reporting honesty on the Proof page

- CTL results hardcoded "outfit 50/50" regardless of configured percent (`app.proof.tsx:982`).
- CSV export ignores the experiment window shown on the page (`app.proof.export.tsx:27`).
- "Tracked sales" hint says "attributed order revenue" but the SQL computes tried-on-line Qualified Revenue, while receipts show whole-order totals that can't reconcile (`app.proof.tsx:753`).

### 10. OPERATIONAL — The live beacon path has never produced a real exposure row

All 3,012 prod exposure rows are dev-store demo seed (`demo_wh_*`/`demo_wx_*`, inserted with service role bypassing the RPC — 2,984 have buckets inconsistent with the hash). The one real experiment (c93f2e94, 2026-07-14, 40 minutes) recorded **zero** exposures — plausibly just no traffic, but the end-to-end prod beacon has never been confirmed with a real row. Also: `20260710_ab_holdout_proof` and `20260710_style_overrides` are absent from the prod migration registry (hot-applied) — registry drift to remember.

**Before the BOA pilot: run one real browser session against a running experiment and confirm a hash-valid exposure row lands, then a purchase joins to it.**

---

## Lower-priority (unverified minor/low)

- `?ello_ab` override silently ignored (and logged as real data) when localStorage is unavailable.
- Config-fetch total failure fail-opens the widget for previously-bucketed holdout sessions.
- Fire-and-forget exposure with a permanent client marker: a failed beacon loses that session's exposure forever (symmetric, dilutive).
- Thank-you-page reload can double-insert NULL-order-id purchases (symmetric across arms).
- One-sided 95% z-test presented as unqualified "confidence"; "sticky per shopper" copy overstates a 7-day-session-sticky design; favorable-only hero cards (returns gap / incremental revenue render only when positive).

## Suggested fix order (pre-pilot)

1. Attribution symmetry (#1) — the only bias in the overstating direction.
2. Live smoke test of the beacon (#10).
3. REVOKE anon on reporting RPCs (#6, one SQL statement).
4. CTL clamp + percent history + override exclusion + NULL order_id (#3, #4, #5) — or de-scope CTL claims from the pilot readout and rely on the widget-wide test, whose math is clean.
5. Label fixes (#2, #9).
