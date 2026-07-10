# Complete the Look — the Styling Rail + AOV/Upsell analytics (execution plan)

Owner: Andrew · Dialed 2026-06-28 · Builds on the PDP image-swap hub · Goal: lift AOV on already-attributed orders + prove it in the dashboard

## Decisions resolved (2026-06-28)

- **V1 = ONE complementary item**, via the existing `addToOutfit` iterative-layering mechanic. Try on shirt →
  rail suggests pants → tap adds pants onto the look. ONE extra generation, layered on the previous result.
  **No backend change, no prompt change, no Vertex / multi-image work.**
- **Multi-image "reshoot from original" is PARKED** (future, for 2–3 piece outfits). The model supports it
  (Nano Banana 2 / Gemini 3.1 Flash Image takes up to 14 reference images, and Vertex's `generateContent`
  accepts multiple image parts), but it needs: the `/tryon` wrapper to forward an image array, a reworked
  prompt with distinctly-labelled references ("the top from image 2, the trousers from image 3"), and a
  reliability pass (stacked edits can silently drop a garment ~10–20%). None of that is needed for one-item V1.
- **"Add the look" = adds the WHOLE outfit (base A + the complementary item) to cart in one tap** — Andrew's
  "add both directly" vision — with a guard so A isn't double-added if the shopper already used the theme's ATC.
- Upsell revenue measured from the **pixel** (`variant.price`). ✅
- Cart `ello_session_id` attribute written on "Add the look" (attribution safety net). ✅
- Public causal-lift claims (A/B holdout): **BUILD IT.** Andrew wants a real holdout/control built INTO the
  dashboard — the store turns the A/B test on, the widget buckets each shopper automatically, the dashboard
  reports treatment vs holdout (see Increment 8). This is the scientific lift number for Dov/LA Apparel.

## Status

- **Increment 0 — ✅ BUILT + verified, DEPLOYED-but-inert.** `elloCompleteTheLookOn()` gate
  (widget-main.js, gated ON TOP of `elloPdpHubModeOn`), `completeTheLookEnabled` mapped in widget-loader.js
  (`buildConfigFromRow` + `buildDefaultConfig`), dev-pdp.html opts the dev store in, `?ello_ctl=1/0` URL override.
  Gate truth table 9/9 (default OFF → false, requires hub mode, URL/localStorage overrides work). Shipped to both
  services in the v2.7.12 working-tree deploy (2026-06-29) but INERT — gated default-OFF.
  - **DB:** the `complete_the_look_enabled` column ALREADY EXISTS in prod — added by the canonical
    `supabase/migrations/20260629_pdp_image_swap_enabled.sql` (self-contained: BOTH flags + a `get_widget_config`
    returning both). The standalone `20260628_complete_the_look_enabled.sql` I drafted was **deleted** — it was
    redundant and its `get_widget_config` omitted `pdp_image_swap_enabled`, so applying it would regress the pdp
    passthrough. **No migration to run for CTL.**
  - **To actually enable CTL** (beyond `?ello_ctl=1`): build an admin toggle mirroring the pdp_image_swap toggle in
    `app.widget-design.tsx`, or flip `complete_the_look_enabled` directly. (CTL is now independent of hub/swap.)
  - NOTE: gate later **decoupled** (2026-06-30) — `elloCompleteTheLookOn()` no longer requires `elloPdpHubModeOn()`
    (which is dead); it gates on the flag / `?ello_ctl` only, because the rail renders in-widget, not on the swapped image.
- **Increment 1 — ✅ BUILT + verified (NOT deployed).** `elloPickComplementary(garmentA)` +
  `elloMapRecToItem(p)` in widget-main.js (~5452, on `window`). Async, merchant-curated-only: fetches
  `/recommendations/products.json?intent=complementary`, maps each product to a try-on-able sampleClothing-shaped item
  (prefers in-memory entry, else builds from the response; cents→dollars), hard-filters to in-stock + GID-resolvable +
  `isClothingItem`; any fetch failure/empty → `[]`. `node --check` passes; isolated logic test 11/11.
- **Increment 2 — ✅ BUILT + verified (NOT deployed).** In-widget rail: `elloEnsureCtlStyles()` (brand-token styled) +
  `elloRenderCompleteTheLook(garmentA)` + `elloTeardownCompleteTheLook()` in widget-main.js (~5560). Renders the curated
  item into `#resultSection` above the inline CTAs; gate decoupled from hub/swap; CTL suppresses the PDP swap
  (`elloPdpSwapOn() && !elloCompleteTheLookOn()`); teardown on each new try-on. Static (chip inert until Increment 3).
  `node --check` passes; gate 6/6; real markup rendered + eyeballed on-brand.
- **Scenario B (2-FIX + 3B + 4B) — ✅ BUILT + logic-verified 2026-06-30 (NOT deployed, NOT E2E-verified).** Dual-surface
  live: 2-FIX (guard → `if (elloPdpSwapOn())`, `__elloCtlLayeringInB` short-circuit in `elloPdpSwapOn`, `imgEl` reused
  verbatim on the layer pass, panel mounted in the hero success early-return). 3B (`elloMountCtlPdpPanel` inserts the
  compact brand-styled offer card BELOW the hero via `wrap.parentNode.insertBefore` — never overlays the shopper;
  `elloCtlLayerInB` re-bases on `lastResultB64` + sets `__elloCtlLayeringInB` + beats the debounce + re-runs startTryOn;
  `elloCtlAbortLayer` keeps A on the hero on a failed layer; teardown wired into `elloAbortPdpSwap` + guarded at try-on
  start). 4B (`elloAddOutfitToCartB` → ONE multi-line `/cart/add.js {items:[A,B]}`, `elloResolveCartVariantForItem`
  color-locks + size-picks + sold-out-aborts, `/cart.js` dedupe drops A if already added, currency-correct `$total`,
  `trackEvent`×2 + `/cart/update.js` attribute, success/error rendered into the panel). `node --check` passes; new-logic
  test 13/13 (variant/size/color-lock/sold-out/cancel, currency incl. non-USD, dedupe). **Not yet verified in a browser**
  — needs a curated dev store (Search & Discovery) + a real try-on; verify in the demo store or dev-pdp harness.

## The idea (locked)

After a successful try-on in hub mode (garment A is on the shopper, swapped onto the PDP image),
surface an **on-brand styling rail** under the swapped image offering 2–3 *complementary* items
(shirt → pants/shoes/bag). Tap a piece → it is **frictionlessly tried on**, layering onto the shopper's
existing result (reusing the already-built `addToOutfit` mechanic) so they see the **full outfit on their own
body**. One **"Add the look"** tap drops the whole outfit into the cart via a single `/cart/add.js` multi-item
call. Opt-out, not opt-in. A VTO-space first: the cross-sell is *tried on the shopper in seconds*, answering
"will it actually go together?" at the moment of ownership.

## How the money actually works (CORRECTED — verified against code + SQL)

Andrew earns **15% of the ENTIRE attributed order**, and a single try-on attributes the whole order. So:

- A shopper tries on the jacket → a `tryon_events` row for the jacket. They check out → the Web Pixel
  (`extensions/ello-conversion-pixel`) fires `checkout_completed` with the order's `line_items`. Because the
  jacket's `product_id` is in that order, `get_vto_conversion_summary` attributes the **full order total**,
  deduped by `order_id` (verified: `SUM(total_price)` over `SELECT DISTINCT order_id`). Andrew gets 15% of that.
- **The upsell does NOT create attribution — it raises the total that's already being attributed.**
  Buy only the jacket → 15% of $78. Add the tee + sneakers via the look → 15% of $154. Same one try-on
  attributes either way; the look nearly doubles the commission on that order. This is pure AOV lift on an
  already-attributed order — that's the entire business case.
- Because the whole order is attributed off any tried-on item, an upsell item does **not** itself need to be
  tried on to earn the 15% — but we try it on anyway (that's the feature), and we tag it so we can *measure*
  the lift (see Analytics below).

### ⚠️ Dashboard money-correctness guardrail (not a commission change, but don't misreport)

`get_vto_product_conversion` (the per-product view) is **product-influenced**: it credits each order's FULL
total under *every* product tried on that session. The look makes multi-tried-on orders the norm, so summing
per-product rows would 2–3x the real number. Commission already reads the order-deduped store summary
(correct). Just never display or pitch a number built from summed per-product rows.

## Surface decision (Andrew, 2026-06-30): DUAL-surface — the upsell follows the result

The try-on result shows in ONE of two places depending on the store, and the upsell follows it there. One resolver
picks automatically so we never wire it twice:

**`elloCtlSurfaceB()` = `elloCompleteTheLookOn() && elloPdpSwapOn()`**
- **Scenario A — result IN THE WIDGET** (`elloPdpSwapOn()` false; floating-widget / non-hero-swap stores). The rail
  renders into `#resultSection` above the inline CTAs. **Built (Increment 2).** Add-both lives in the widget.
- **Scenario B — result on the HERO IMAGE** (`elloPdpSwapOn()` true; no-bubble stores like LA Apparel). The hero
  photo becomes the shopper wearing item A AND a compact Ello panel (`#ello-ctl-pdp-panel`) is pinned to the hero
  wrapper (`elloPdpAnchor(__elloPdpSwap.imgEl)` — the same anchor the "flip to original" thumb survives on, since the
  hero swap hides the whole widget). Tap "Try it on too" → layers item B onto the hero-of-them → hero shows BOTH →
  the panel morphs and the **"Add both to cart · $total"** button appears in that panel.

**Increment-2 correction:** my `if (elloPdpSwapOn() && !elloCompleteTheLookOn())` was WRONG — it killed Scenario B.
Fix: `if (elloPdpSwapOn())`. Now the surface is chosen purely by `elloPdpSwapOn()`: in-widget render is reached only
when it is false (Scenario A); the hero-swap early-return handles Scenario B.

**The single most load-bearing wire:** the layering re-run sets `window.elloSelectedGarment = item B`, which would
make `elloPdpSwapOn()`'s garment-guard (`g.id !== handle`) return false and route B to the in-widget path — silently
breaking the hero outfit. So `elloPdpSwapOn()` must short-circuit `if (window.__elloCtlLayeringInB) return true;` as
its first line, and the layering pass must reuse `__elloPdpSwap.imgEl` VERBATIM (not re-resolve via
`elloFindPdpImage(itemB.image_url)`, which can grab a different gallery `<img>` and destroy the original-photo restore).

**Frictionless layering** reuses the `addToOutfit` mechanic (re-base on the previous result) — repainting the in-widget
image in A, the hero image (via `elloFinishPdpSwap`) in B.

## On-brand requirement (locked)

The rail must look like the merchant's store, not generic Ello black. `buildConfigFromRow` already resolves
`widgetPrimaryColor`, `widgetAccentColor`, `inlineButtonColor`, `inlineButtonTextColor`, `minimizedColor`.
`elloEnsureCtlStyles()` injects these as CSS custom properties: "Add the look" uses the merchant's
primary/inline-button color + text color, chips use the accent, with neutral fallbacks when a token is null.
No hardcoded brand colors.

## Attribution plumbing CTL must preserve (verified)

- `callElloTryOn` (widget-main.js:5709) derives `product_id` from
  `shopify_product_gid || shopify_product_id || id` → normalizes numeric to `gid://shopify/Product/N`.
  A handle-only item becomes `product_id = handle`, which never matches the pixel's GID. Hub-mode A still
  attributes via its own row, but to *measure* an upsell item it must be GID-resolvable → **hard-filter the
  rail to items with a real GID + ≥1 variant.**
- `ello_session_id` cookie (widget-main.js:2150, 7-day). On "Add the look", write
  `/cart/update.js { attributes: { ello_session_id } }` (mirrors widget-main.js:8456) so checkout attribution
  survives even though A was bought via the theme's native ATC (that cart-attribute write does NOT otherwise
  fire on the native-ATC hub path).

---

# Part A — Build the styling rail (gated, default OFF)

Gate: `elloCompleteTheLookOn()` = `ELLO_STORE_CONFIG.completeTheLookEnabled === true || ?ello_ctl=1` (decoupled from
hub/swap, 2026-06-30). DB column `complete_the_look_enabled` (default false) → `get_widget_config` → loader. Flag off
→ every store byte-for-byte unchanged.

- **0 — Flag + plumbing.** `completeTheLookEnabled` in `buildConfigFromRow`/`buildDefaultConfig`
  (widget-loader.js ~348/382), `elloCompleteTheLookOn()` near `elloPdpHubModeOn` (~6248), DB column. No visible change.
  *Verify:* dev-pdp.html — flag off → `elloCompleteTheLookOn()===false`, no rail; `?ello_ctl=1` → true.
- **1 — Recommender = MERCHANT-CURATED ONLY (V1) + GID/try-on hard-filter.** Decision (2026-06-28): no algorithm
  picks pairings in V1 — a bad auto-pick can suppress AOV and cheapen a brand like LA Apparel. The rail shows ONLY
  when the merchant has intentionally curated the pairing.
  - `elloPickComplementary(garmentA)` (async): `GET /recommendations/products.json?product_id=<A>&intent=complementary&limit=10`
    → the merchant's hand-picked "goes-with" items from the free **Search & Discovery** app (the same data that
    powers their PDP "pairs well with" section). Prefetched during A's try-on generation (dead time), non-blocking, try/catch.
  - **Map each returned product to a try-on-able item:** prefer the existing `sampleClothing` entry by handle/id
    (full widget metadata); else build a sampleClothing-shaped object from the endpoint response (it carries
    handle, title, type, tags, images, variants). Mirror the cents→dollars handling from the `/products/{handle}.js`
    lazy-load (widget-main.js:9516, `v.price/100`), with defensive Number coercion.
  - **Hard filter:** keep only items that are GID-resolvable (`shopify_product_gid || shopify_product_id`, for
    attribution), try-on-able clothing (`isClothingItem`, widget-main.js:334, so it can be layered), and in stock.
    V1 surfaces ONE item (cap=1); function returns a ranked list (curation order) for future caps.
  - **No curation → returns `[]` → NO RAIL.** Clean no-op; the climax try-on is unchanged. This is intended:
    better no rail than a bad one.
  - **NOT building an Ello curation dashboard for V1** — Search & Discovery already IS the merchant curation
    surface, for free. **Merchant setup for CTL:** install Search & Discovery + curate complementary products
    (and for the LA Apparel demo, pre-curate the hero pairings). Document this in onboarding.
  - **Future (parked):** an Ello-side category/tag inference fallback for un-curated stores — only if Andrew
    later wants coverage there and accepts the AOV/brand risk.
  *Verify:* mocked endpoint JSON in isolation — curated response → mapped, filtered, GID-correct items; OOS / non-clothing
  / handle-only-no-GID excluded; empty/erroring response → `[]`. Live verification needs a curated store (the demo store).
- **2 — ✅ BUILT + verified 2026-06-30. In-widget rail render + ON-BRAND styling (static).**
  `elloEnsureCtlStyles()` reads the merchant brand tokens (`inlineButtonColor || widgetPrimaryColor`, `inlineButtonTextColor`,
  `widgetAccentColor`) so the "Try on" chip + accents are on-brand, not hardcoded black. `elloRenderCompleteTheLook(garmentA)`
  (async, best-effort) fetches the curated item via `elloPickComplementary`, builds the rail, and inserts it into
  `#resultSection` **above** `#ello-inline-result-ctas` (offer seen before the final Add to Cart). `elloTeardownCompleteTheLook()`
  is idempotent + called at the top of each new try-on. Gated render call sits after `renderInlineModeResultCtas()` in the
  startTryOn success path; CTL suppresses the PDP swap via `elloPdpSwapOn() && !elloCompleteTheLookOn()`. Name/price set via
  `textContent` (no markup injection). Increment 2 is static — the "Try on" chip does nothing yet (Increment 3 wires layering).
  *Verify:* `node --check` passes; gate truth-table 6/6 (decoupled, default OFF→false); real generated markup rendered + eyeballed
  on-brand. Full in-browser render needs a curated dev store (Search & Discovery) so `elloPickComplementary` returns an item.
- **3 — Layering wrapper (CAP=1, iterative, IN-WIDGET).** Tap the rail's "Try on" chip → `elloAddOutfitItem(item)`
  layers ONE garment via the existing `addToOutfit` mechanic (no backend/prompt/Vertex change) and updates the
  **in-widget result image** (`#ello-tryon-result-image`) to show A+B — the theme is never touched. Chip shows
  "Styling…" + the result shows a loading state while the layer generates. Internals: tap-guard (check
  `isTryOnProcessing` + 1.5s debounce, grey/queue rather than drop), reset `_lastTryOnTimestamp=0`, set
  `elloUserImageUrl=__elloLookBaseImage` once synchronously, replicate `addToOutfit`'s validation reset
  (9362-9364), call `startTryOn`. On success capture the new result into `__elloLookBaseImage` and push to
  `__elloLookStack[]` (drives the cart step). **Failure recovery is in-widget** (CTL already suppressed the PDP swap,
  so `__elloPdpSwapActive` is false — no `elloAbortPdpSwap` risk): restore the result image to last-good
  `__elloLookBaseImage`, revert the chip "Styling…"→"Try on", small toast; handle OVERAGE_BLOCKED/RATE_LIMIT so the
  chip never sticks. **Eyeball A+B realism before claiming "buttery."**
  *Verify:* dev-pdp.html — A→tap Try on → in-widget result updates to A+B, no validation/photo-change errors; forced failure keeps A, reverts chip.
- **4 — The 2-item button: whole-outfit cart + price coercion + session attribute.** Andrew's exact spec: with one
  piece the primary CTA stays **"Add to Cart — $A"**; once the shopper layers the complementary item, it transforms
  to **"Add to Cart (2 items) · $total"** (`$total` = A + the layered item, `parseFloat`-summed) and adds the FULL
  outfit in ONE tap. `elloAddOutfitToCart()`: per-item variant resolution (single→variants[0]; cross-bucket
  multi-variant→inline size chip; identical option set→inherit A's size; else `showSizeSelector` 7872), `parseFloat`
  every price (lazy-load yields String prices 8273/9547), GID-strip (7300), ONE `POST /cart/add.js {items:[A, B]}`.
  **Double-add guard** (`window.__elloBaseAddedToCart`): skip A in the payload if it was already added, so A is never
  qty 2. 422→per-item fallback, then exactly ONE `elloRefreshThemeCart()` + one `/cart/update.js {attributes:{ello_session_id}}`.
  *Verify:* dev-pdp.html — before layering the button reads "Add to Cart — $A"; after, "Add to Cart (2 items) · $total"
  with the right sum; one tap adds both, drawer updates in place, A not doubled, one variant sold-out → other still adds.

> Increments 3 / 4 above are the **Scenario A (in-widget)** track — for floating-widget stores. The **Scenario B
> (hero)** track below is what LA Apparel (no-bubble + hero-swap) needs, and is the demo-critical path.

- **2-FIX — let CTL ride the hero swap (un-block Scenario B).** Edit the startTryOn success branch:
  `if (elloPdpSwapOn() && !elloCompleteTheLookOn())` → `if (elloPdpSwapOn())`. Now `elloPdpSwapOn()` alone chooses the
  surface (false→in-widget A, true→hero B). Add `if (window.__elloCtlLayeringInB) return true;` as the FIRST line of
  `elloPdpSwapOn()` (else the layering pass, where `elloSelectedGarment` is item B, fails the garment-guard and routes
  B to the wrong surface — the single most load-bearing wire). In the hero early-return, after `elloFinishPdpSwap`,
  stash `__elloPdpSwap.lastResultB64 = imageB64` + `__elloPdpSwap.variantIdA` (freeze A's variant) and call
  `elloMountCtlPdpPanel(garment)` when `elloCompleteTheLookOn()`.
- **3B — Scenario-B corner panel + layer onto the hero.** `elloMountCtlPdpPanel(garmentA)`: append
  `#ello-ctl-pdp-panel` to `elloPdpAnchor(__elloPdpSwap.imgEl)` (abort if no hero img; NEVER append to the hidden
  `#virtualTryonWidget`/`#resultSection`); render the brand-styled offer (one `elloPickComplementary[0]` item +
  "Try it on too"). `elloCtlLayerInB()`: set `window.__elloCtlLayeringInB=true`, `window._lastTryOnTimestamp=0` (beat
  the 1.5s debounce), point `userPhoto`/`elloUserImageUrl` at `__elloPdpSwap.lastResultB64`, set `elloSelectedGarment`
  = item B, re-run `startTryOn` → repaints the SAME hero element with BOTH. In `elloBeginPdpSwapLoading`, reuse
  `__elloPdpSwap.imgEl` verbatim when `__elloCtlLayeringInB` (skip the stale-stash reset that would break the
  flip-to-original). Clear `__elloCtlLayeringInB` in BOTH finish + `elloAbortPdpSwap`; add panel teardown to abort.
  **Eyeball A+B realism on the hero before claiming "buttery."**
- **4B — Add both to cart, from the panel (Andrew's add-to-cart answer).** On layering success the panel morphs:
  header → "Your look · 2 pieces", two stacked thumbs, one full-width **"Add both to cart · $total"** — it replaces
  the "Try it on too" button right where the shopper is looking (NOT near the theme buy box). `elloAddOutfitToCartB()`:
  ONE `POST /cart/add.js { items:[{id:vA},{id:vB}] }` (NET-NEW multi-line shape). `vA` = the FROZEN
  `__elloPdpSwap.variantIdA` (never re-resolved from the live URL). `vB` via new `elloResolveCartVariantForItem(item)`
  (available-only; size picker if >1; hard sold-out abort). **Double-add guard:** fetch `/cart.js`; if frozen `vA` is
  already a line item, send `vB` only + relabel "Add the rest · $B". Theme's native ATC untouched (adds only A).
  Currency-correct `$total` = `Number(priceA)+Number(priceB)` with ONE symbol from
  `ShopifyAnalytics.meta.currency → Shopify.currency.active → '$'` (do NOT reuse `derivePriceLabel`). On success:
  `trackEvent('inline_add_to_cart')` for BOTH, `elloRefreshThemeCart()` (no reload — would wipe the hero),
  `/cart/update.js {attributes:{ello_session_id}}` (NET-NEW + load-bearing for attribution), success/error rendered
  INTO the panel (NOT `showCartSuccessState`, whose DOM is the hidden widget); restore `elloSelectedGarment`=A after.
  *Verify:* dev-pdp.html `?ello_pdp_swap=1&ello_ctl=1` — try-on → hero shows A + panel appears; tap → hero shows A+B +
  button becomes "Add both to cart · $total"; one tap adds both, A not doubled (use native ATC first → button says
  "Add the rest"), non-USD currency correct, forced layer failure restores the hero + resets the panel.

---

# Part B — Analytics & data collection (the dashboard story)

Goal: track exactly how much the upsell drives, and the AOV of try-on shoppers, so it shows in the admin
dashboard and backs the LA Apparel lift story. Everything reuses the existing event pipeline (tryon_events →
cart_events → purchase_events → `get_vto_*` RPCs → `app.analytics.tsx`).

### What we measure
- **Try-on AOV** — average value of attributed orders = order-deduped `attributed_revenue` ÷ distinct attributed orders.
- **AOV with-look vs without-look** — segment attributed orders by whether the session had a
  `entry_source='complete_the_look'` try-on. Two AOVs + the lift %. *This is the money chart for the pitch.*
- **Upsell attach rate** — attributed orders containing ≥1 product that was a CTL try-on ÷ attributed orders.
- **Upsell revenue (realized)** — Σ over attributed orders of the line prices whose `product_id` was a CTL try-on
  that session. Needs per-line price in `line_items` (Increment 7). Falls back to item/qty counts if price absent.
- **Upsell funnel** — rail shown → item tried → look added → purchased.

### Data-availability facts (verified) that shape this
- `tryon_events` has `entry_source` and flows end-to-end, BUT `tryon.tsx:43` validates it against a hardcoded
  allowlist and drops unknown values to null → must add `'complete_the_look'`.
- `tryon_events` / `cart_events` carry **no price**; `purchase_events.line_items` is `{product_id, variant_id,
  quantity}` with **no price**. Per-line price must come from the Web Pixel (`variant.price`, always; or
  `finalLinePrice`, Checkout-Extensibility only) → enrich the pixel payload; `record_purchase_event` already
  stores `line_items` as raw JSONB, so **no DB schema change** for price.
- `app.analytics.tsx:135` already renders a `placement` breakdown keyed by `entry_source`, so CTL try-ons show
  up there automatically once tagged.
- `get_vto_conversion_summary.attributed_revenue` is order-deduped → correct AOV basis.

### Increments
- **5 — Upsell event tagging (client + server allowlist).** Widget sets `ELLO_PENDING_ENTRY_SOURCE =
  'complete_the_look'` before each layer try-on; add `'complete_the_look'` to the `tryon.tsx:43` allowlist. Fire
  lightweight widget events for the funnel (`ctl_rail_shown`, `ctl_item_tried`, `ctl_look_added` with item count +
  total) via the existing widget-event channel. Also keep `sendAnalyticsTracking('complete_the_look_add', …)`
  with Number-coerced prices as an external/n8n signal, labeled analytics-only.
  *Verify:* dev-pdp.html network shows `entrySource: complete_the_look`; the dashboard placement breakdown gains a `complete_the_look` bucket.
- **6 — Pixel line-item price enrichment.** In `extensions/ello-conversion-pixel`, add `price:
  li.variant?.price?.amount` and `final_line_price: li.finalLinePrice?.amount` (guarded) and `quantity` to each
  `line_items` entry in `checkout_completed`. No backend/DB change (JSONB passthrough).
  *Verify:* a test order's `purchase_events.line_items` rows carry a numeric price.
- **7 — Dashboard "AOV & Upsell" section (Pro-gated).** In `analytics.server.ts`, add aggregations (TS over
  `core` events, or a new `get_vto_upsell_summary` RPC) for Try-on AOV, AOV with/without look, attach rate, and
  realized upsell revenue, joining purchase `line_items.product_id` to session CTL try-ons. In `app.analytics.tsx`,
  add a metric-card section (reuse existing card components) behind the same `tier.isFree` gate as the other deep cuts.
  *Verify:* dev/seeded data — cards render correct AOV, attach %, upsell $, and a with-vs-without lift figure; free tier hides them.
- **8 — A/B holdout test (dashboard-controlled, widget-bucketed).** The honest, causal lift number.
  - **Where it lives (answers Andrew's question):** the merchant/Andrew turns it ON from the dashboard — NOT
    something individual shoppers change. New `vto_stores` columns `complete_the_look_ab_enabled` (bool) +
    `complete_the_look_holdout_pct` (int, e.g. 10–50), surfaced via `get_widget_config` →
    `completeTheLookAbEnabled` / `completeTheLookHoldoutPct` in config (same migration pattern as Increment 0).
  - **Widget buckets each shopper automatically + deterministically:** when CTL is on AND ab_enabled, hash the
    `ello_session_id` → `bucket = hash % 100 < holdout_pct ? 'holdout' : 'treatment'`. Stable per shopper
    (same person always same side). **Holdout still tries on and buys normally — only the rail is suppressed**
    (that's the control). `elloCompleteTheLookOn()` stays true; a separate `elloCtlBucket()` decides render.
  - **Record the bucket so the dashboard can segment:** tag it on the session's try-on events (add `ab_bucket`
    to the `/tryon` payload + a nullable `ab_bucket` column on `tryon_events`), or fire a one-time
    `ctl_ab_assigned` widget event. Either makes every order joinable to its bucket.
  - **Dashboard A/B card:** treatment vs holdout — sample sizes, AOV each side, attach rate, and the **lift %**
    (treatment AOV ÷ holdout AOV − 1), with a basic significance/“not enough data yet” guard.
  *Verify:* dev — flip ab_enabled + 50% holdout, confirm ~half of seeded sessions bucket to holdout and see no
  rail, the other half see it; dashboard card shows two AOVs + a lift figure and hides under the free tier.

---

## Guardrails
- All edits additive + gated behind `completeTheLookEnabled` (default OFF). Bubble mode, floating widget,
  `renderInlineModeResultCtas`, and the existing single-product add-to-cart + attribution path stay byte-for-byte.
- Analytics tagging must not change `entry_source` for existing surfaces (only ADD `complete_the_look`).
- Rigorously save/restore shared module state: `__elloPdpSwap`, `window.elloSelectedGarment`,
  `window.elloUserImageUrl`, `isTryOnProcessing`, `activePhotoValidationStatus`.
- Pre-deploy: `npm run lint && npm run typecheck && npm run build`. Verify in dev-pdp.html. Widget deploys CUSTOM
  only (Andrew installs). The pixel + dashboard changes deploy with the app; the pixel is a separate extension deploy.

## Open decisions — ALL RESOLVED (2026-06-28), see "Decisions resolved" at top
1. Backend multi-image → **parked.** V1 = one item, iterative layering, no backend/Vertex/prompt change.
2. Launch cap → **CAP=1** (still eyeball the A+B render before deploy).
3. Upsell revenue from pixel `variant.price` → **yes.**
4. Cart session-attribute write on "Add the look" → **yes** (attribution safety net).
5. A/B-holdout causal claim → **deferred.** V1 collects with-look-vs-without numbers; claim-boldness decided later.
