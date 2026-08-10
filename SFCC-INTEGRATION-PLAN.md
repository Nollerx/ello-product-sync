# Ello VTO × Salesforce Commerce Cloud — Integration Plan

_Date: 2026-07-24 · Status: PLAN ONLY (no code changes made) · Author: research synthesis (repo audit + 5-agent SFCC research sweep, sources cited inline)_

**The one-sentence strategy:** keep a single widget codebase and ship SFCC as an *adapter tier on top of Ello Anywhere* — a small `ello-sfcc.js` adapter (product detection + native cart), an optional `int_ello` cartridge (perfect context + server-grade attribution), and a tiny npm component for headless storefronts — sold direct with Stripe billing, no marketplace required.

---

## 0. Why this is worth doing (verified market facts)

- **~5,500 live SFCC stores; ~1,800 are apparel (SFCC's #1 vertical at 32.6%), and essentially all are $1M+/yr revenue** — Coach, Ralph Lauren, Lululemon-tier. This is precisely the enterprise ICP the summer sprint targets. (Store Leads; 07-15 platform research.)
- **Zero GenAI shopper-photo apparel try-on competitors on-platform.** Verified again 2026-07-24: AppExchange search for "virtual try-on" returns exactly one result — Zakeke (a 3D/AR product *customizer*, not generative apparel try-on). GenLook is Shopify + raw API only; Veesual (model-swap paradigm, not shopper photo) claims SFCC support in third-party roundups but has no listing and no verified live SFCC store; Zyler/Style.me/3DLOOK have no SFCC presence. The lane is still empty.
- **Nobody needs Salesforce's permission.** A cartridge is ordinary site code the brand's own devs install; the LINK marketplace was retired into AppExchange (now "AgentExchange"), listings are optional credibility, free listings carry 0% revenue share, and script-tag/direct deals owe Salesforce nothing. Klarna, Yotpo, Bazaarvoice, Nosto, Dynamic Yield all distribute via GitHub/docs + direct contract.
- **The widget is already ~70% portable.** The repo audit confirmed the render pipeline, wardrobe (IndexedDB), session machinery, holdout bucketing, and try-on limits are platform-neutral, and the Ello Anywhere v1 adapter (`public/ello-anywhere.js`, commit 76f8cc3, live-verified on atlasapparel.shop) already provides the platform-abstraction seams: `data-ello-tryon` triggers, `window.ELLO_CART_HOOK` / `setCartHandler`, `ELLO_NO_SHOPIFY_CART`, and Method 0 product-handle injection into `widget-main.js`.

**Sequencing discipline (the standing rule):** sales before dev. The full production build below is trigger-gated on a real SFCC prospect (Boot Barn / PacSun conversation, or an inbound like 7th Earth). What's justified *now* is Phase A only — the demo-grade SFRA adapter — because it doubles as a sales asset: it makes the existing demo bookmarklet do a REAL add-to-cart on a prospect's live SFCC site, which is the pitch.

---

## 1. Know your enemy: the three SFCC architectures

A prospect runs one of three storefront generations (or a hybrid). Everything downstream — injection, product data, cart, attribution — branches on this, so fingerprint first.

| Generation | What it is | Share (estimate) | Ello path |
|---|---|---|---|
| **SFRA** (2018–now) | Server-rendered ISML + controllers, jQuery on the client, `app_storefront_base` + overlay cartridges | ~60–75%, the mainstream | **Primary target.** Adapter works with zero brand code; cartridge for production |
| **SiteGenesis** (legacy) | Older server-rendered stack, fragile jQuery/AMD client JS | ~10–20%, shrinking | Supported via per-brand form-replay adapter; **deprioritize** |
| **Composable / PWA Kit** (2021–now) | React SPA on Managed Runtime, SCAPI + SLAS auth; often *hybrid* (headless PDP, SFRA checkout) | ~10–20%, concentrated in our target tier | npm component + `setCartHandler` (the Adyen/Klarna pattern) |

Salesforce's "Storefront Next" went GA June 2026 — too new to matter yet; watch it.

**Fingerprinting from the outside** (add to Deal Builder / qualification flow):
- `/on/demandware.static/` asset URLs, `/on/demandware.store/Sites-*-Site/` URLs, `dwsid`/`dwanonymous_*` cookies, `window.dwAnalytics` → SFCC, server-rendered (SG or SFRA).
- `.product-detail[data-pid]` + Bootstrap classes on the PDP → **SFRA specifically** (this markup is quoted from SFRA base `productDetails.isml`).
- `window.__PRELOADED_STATE__`, `/mobify/proxy/` paths, SCAPI calls to `*.api.commercecloud.salesforce.com` → PWA Kit/composable.
- Mixed (PDP has `__PRELOADED_STATE__`, checkout flips to `/on/demandware.store/`) → hybrid; ask which runtime owns the PDP.
- OCAPI is **deprecated (April 2026, security-only until ~April 2028)** — everything server-side we build targets **SCAPI** only.

---

## 2. The integration design, seam by seam

### 2.1 Getting the script on the page (injection)

| Tier | Mechanism | Who does it | Time |
|---|---|---|---|
| Demo | Existing bookmarklet / `demo-launch.mjs` (bypasses CSP via Playwright) | Us | minutes |
| Pilot | GTM/Tealium Custom HTML tag on PDP page-type, **or** an existing footer content slot with an HTML asset carrying the two script tags | Brand's marketing/dev, no deploy | days (governance approval is the real critical path) |
| Production | `int_ello_sfra` cartridge registering the sanctioned SFRA hooks `app.template.htmlHead` / `app.template.afterFooter` in `hooks.json` — no brand-template edits at all. This is exactly how Noibu, Nosto, and Dynamic Yield inject. SiteGenesis variant = one documented `<isinclude>` line | Brand's agency, rides their release train | 3–8 weeks wall-clock (release cadence, not eng effort) |
| Composable | React Helmet tag or our `<ElloTryOn>` component in their storefront repo | Brand's frontend team, PR + Managed Runtime deploy | days–weeks |

**CSP reality:** stock SFRA's default CSP is only `frame-ancestors 'self'` — **many SFRA storefronts have no `script-src` at all** and the widget loads with zero allowlisting. Where a brand does enforce CSP (Arc'teryx does), it lives in `httpHeadersConf.json` in their cartridge (SFRA) or `ssr.js` (PWA Kit) — a code deploy. Our ask must be minimal: **serve everything (loader, bundle, API, images) through `widget.ellotryon.com`** so the request is literally "add one hostname to `script-src`, `connect-src`, `img-src` (+ `data:`/`blob:` in img-src)." Offer a `Content-Security-Policy-Report-Only` dry-run so their team validates risk-free. The eCDN cannot rewrite headers — don't plan on CDN-layer workarounds.

### 2.2 Product detection (the new "Method 7")

Detection ladder on SFCC, best-first (extends `detectCurrentProduct()` in `public/widget-main.js:1979+`):

1. **Cartridge context blob (production):** the hook template prints `<script type="application/json" id="ello-context">` with `{pid, masterId, variationAttributes, images, price, currency}` straight from `pdict.product` — the Dynamic Yield pattern. Deterministic, zero scraping.
2. **Adapter-supplied handle (exists):** `data-ello-tryon` → `ELLO_INLINE_CTX.productHandle` (Ello Anywhere Method 0).
3. **JSON-LD (exists):** Method 6 already parses `ProductGroup`/`Product` — verified working on arcteryx.com (35 variants w/ garment images). But **stock SFRA does not emit product JSON-LD**; big brands add it for SEO, mid-tier shops often don't. First-chance, never guaranteed.
4. **NEW — Method 7, SFRA DOM + `Product-Variation` endpoint:** read `.product-detail[data-pid]` + `.add-to-cart-url` from the PDP, then GET the same `Product-Variation?pid=<master>&dwvar_<pid>_color=...&dwvar_<pid>_size=...` endpoint the site's own swatches call. Returns the full product model JSON — **resolved variant pid, per-attribute availability, images per color, price — credential-free, same-origin, works on every SFRA site with no brand setup.** This one method is the key net-new build; it generalizes across every SFRA prospect.
5. **Microdata fallback (SiteGenesis class):** Boot Barn-tier SG sites emit schema.org **microdata** (`itemscope`/`itemprop` on `#pdpMain`), not JSON-LD — a small microdata parser (or a 5-line `window.elloProduct = {...}` config the brand drops in the template) covers them. Cheap add once Method 7 exists.
6. **SCAPI Shopper Products via our proxy (enterprise):** `getProduct?expand=availability,images,prices,variations` gives matrix + variants + imageGroups in one call. Auth = per-brand SLAS private client held server-side by us (never in the page; sidesteps SCAPI's no-wildcard CORS allowlist). 60s availability cache TTL; mandatory 429 handling.

**SFCC product model mapping** (differs from Shopify — encode in the adapter):
- Shopify product ≈ SFCC **master**; Shopify `variant_id` ≈ SFCC **variant's `pid`** (one flat string-ID namespace, usually the real SKU). Masters are NOT orderable — always resolve color+size → variant pid before add-to-cart.
- Watch **variation groups**: some storefronts' PDP `data-pid` is a color-level variation group, not the master. Resolution logic: master → (variation group) → variant.
- Availability = ATS via `orderable` flag; gate the ATC button per variant exactly like today.

### 2.3 Add-to-cart

- **SFRA (primary):** bare same-origin `POST` to `Cart-AddProduct` — **verified in published SFRA source: no CSRF middleware on this route** (unlike coupon routes). Form-encoded `pid=<variant>&quantity=1`; bundles/options/sets via JSON-string fields `childProducts`/`options`/`pidsObj`. Response JSON includes `quantityTotal`, full `cart` model, and `pliUUID` — a durable handle on the exact line item we created (line-item attribution!). URL comes from the `.add-to-cart-url` hidden input on every SFRA PDP, falling back to `/on/demandware.store/Sites-{site}-Site/{locale}/Cart-AddProduct`.
  - **Minicart update:** re-fire the site's own events **through `window.jQuery`** (same jQuery instance is load-bearing): `$('.minicart').trigger('count:update', response)` + `$('body').trigger('product:afterAddToCart', data)`; also fire the `reportingURL` beacon so the brand's analytics see the add. Fallbacks: patch `.minicart-quantity` text, or GET `Cart-MiniCartShow` and swap HTML.
  - **CSRF defense:** attempt bare POST; on CSRF failure response, scrape `input[name="csrf_token"]` from an on-page form and retry (rare custom hardening).
  - **Complete the Look:** two sequential `Cart-AddProduct` POSTs (no multi-item endpoint needed).
- **Composable:** `setCartHandler` (unchanged from Ello Anywhere) — the brand's code calls SCAPI `addItemToBasket` with its own SLAS token/BFF. **Verified: this is the industry-standard boundary** (Adyen ships an npm package doing exactly this; token-scraping the storefront's SLAS JWT is a dead end nobody credible ships). Package it as `@ello/sfcc-composable` for procurement optics.
- **Hybrid:** sniff per-page — if the PDP has `.add-to-cart-url` it's SFRA-rendered, use the controller path (session bridge keeps baskets in sync); pure-composable PDPs get the callback route.
- **SiteGenesis:** AJAX contract returns HTML not JSON; field names vary per build. Strategy = replay the PDP's own add-to-cart form with our resolved pid + `format=ajax`, inject returned HTML into the minicart. Per-brand adapter work; deprioritize.

### 2.4 Purchase attribution (the money seam — this funds the 15%-of-attributed-revenue deals)

**Structural advantage vs Shopify: SFCC checkout is same-origin.** PDP → checkout → confirmation all render on the brand's domain; our localStorage/cookie session id survives to the confirmation page. Shopify's cross-domain-checkout headache doesn't exist here. Off-site payment redirects (PayPal/3DS) return to the same origin with storage intact.

**No webhooks on SFCC** (a June 2026 "Asynchronous Eventing Framework" pilot exists but launches with replication events only — do not architect against it). The proven replacement is the dual path every serious vendor ships (Awin's cartridge literally advertises "client-side tag + fallback pixel + server-to-server"):

1. **Fast signal (client):** confirmation-page snippet — via cartridge include in `Order-Confirm`'s ISML (order data is server-rendered into the page from `pdict.order`: order number, totals, currency, full line items — strictly better access than post-checkout-extensibility Shopify) or, pilot-mode, a GTM tag on the confirmation page-type reading our localStorage session id. Lossy (ad blockers, abandoned confirmations, ~5–10%), never the billing signal.
2. **Server truth (billing-grade):** two parts —
   - `int_ello` extends `CheckoutServices-PlaceOrder` (SFRA) / registers an SCAPI order hook (headless) to stamp **`order.custom.elloSessionId`** from our first-party cookie inside the order transaction, consent-gated. This is the affiliate-network "clickref" pattern (Awin, Partnerize). Requires a metadata XML defining the `c_` attribute on **both Basket and Order** system objects. Never make network calls inside the hook (hook timeouts/circuit breaker) — stamp only.
   - **Ello-side SCAPI order poller:** Account Manager client with read-only **`sfcc.orders`** scope, `GET /checkout/orders/v1/organizations/{orgId}/orders?siteId=...&lastModifiedDateFrom=<watermark>` every 5–15 min (limit 200/page, offset+limit ≤ 10,000 — poll narrow windows, never deep-paginate). Feeds the existing Supabase attribution pipeline; also catches `cancelled` status transitions. Do NOT touch `exportStatus` (the brand's OMS owns it) and do NOT request write scope.
3. **Line items:** SCAPI order documents carry `productItems` with `productId`, quantity, and full pricing — our existing line-item matching (tried-on product ↔ order line under the same session id) ports directly; `pliUUID` from add-to-cart tightens it further.

**Refund netting — the honest hard part.** Returns almost never live in SFCC (post-order APIs are inactive-by-default; enterprise brands process returns in an OMS/ERP — Salesforce OMS, Manhattan, SAP). Tiered measurement contract, brand picks one:
1. **Default: fixed return-rate haircut** — net attributed revenue by the brand's own stated category return rate, trued up quarterly against their finance numbers. Unblocks the deal with zero integration.
2. **Upgrade (month 2): returns feed** — weekly extract (order no, SKU, qty, refund amount) from their OMS via SFTP/API; we net exactly as on Shopify. Every brand already produces this for finance.
3. **Salesforce OMS API access** where applicable — cleanest automation.

Contract language: "attributed revenue = server-stamped orders; refunds netted from your returns data on a weekly cycle" — never promise real-time refund netting on SFCC.

**Holdout/A-B:** our deterministic client-side bucketing (FNV-1a, mirrored in Postgres) ports untouched — client-side is also the only approach that doesn't fight SFCC's aggressive page caching. **Enterprise trust weapon:** SCAPI order documents carry an `abTestSegment` array — a skeptical brand can run the on/off split through *their own* Business Manager A/B test gating the embed, and every order is stamped with the segment, auditable by their own analytics team. Offer it; default to our bucketing for cross-platform comparability.

### 2.5 Complete the Look on SFCC

v1: **SCAPI `getProduct?expand=recommendations` + `set_products`** — merchant-curated recommendations and "shop the outfit" product sets come back on the same Shopper Products call; apparel enterprises usually curate these. v1.5: SCAPI Shopper Search for heuristic pairing (category/price-band) mirroring today's Shopify CTL heuristics. Phase 2 (if a brand asks): Einstein Recommendations API — callable by third parties with a brand-provisioned client ID (server-side only, include the shopper's `cqcid` from `window.CQuotient`). Heavyweight nightly catalog feeds (the Nosto pattern): only if we ever do cross-catalog styling server-side. Note `ELLO_NO_SHOPIFY_CART` currently suppresses CTL entirely — SFCC unsuppresses it once the SCAPI product source + native ATC exist.

### 2.6 Widget runtime hazards (mount/UI)

- Keep the bundle a **pure IIFE — never add UMD** (SiteGenesis AMD loaders would `define()` a UMD bundle into a stray RequireJS context and it would never execute). Shadow-DOM/scoped-CSS isolation (post-BOA `__elloWidget` namespace work) is exactly right for SFCC.
- PWA Kit: React owns the DOM — mount our host element appended to `document.body` outside React's root; survive SPA soft navigations (URL-watch/MutationObserver already exists for variant changes; extend to route changes); beware React 18 hydration nuking unexpected DOM injected pre-hydration.
- SFCC page caching: PDP HTML is cached for everyone — all shopper state must stay client-side + API-fetched. Our model already is.
- `cdn.jsdelivr.net` (face-api/tfjs/pose) is a second CSP origin ask — either accept the extra allowlist line or proxy those libs through `widget.ellotryon.com` (preferred; keeps the CSP ask to one hostname).
- Multi-locale/multi-site: SFCC sites are `Sites-{id}-Site/{locale}` — tenancy must map **one brand → many siteIds/locales/currencies** (see §3).

---

## 3. Backend & tenancy changes (Ello side)

Tenancy stays keyed on `store_slug` (per the existing `vto_stores` model and the `/tryon` proxy, `app/routes/tryon.tsx:52-96`). Additions:

1. **Platform field + SFCC tenant record:** `vto_stores.platform` (`shopify` | `custom` | `sfcc`), plus per-tenant SFCC config: shortCode, orgId, siteId(s), locales/currencies, SLAS private-client credentials + Account Manager client (encrypted at rest, server-side only). Multi-site brands = one billing tenant, many site configs.
2. **Provisioning without OAuth:** an internal "create SFCC tenant" flow (same shape as custom-app/SingleMerchant provisioning) — mints the slug, Stripe customer, config row. No Shopify install, no Polaris; the **existing platform-agnostic dashboard (dashboard.ello.services) is the merchant UI**.
3. **SCAPI proxy routes:** `/api/sfcc/product` (Shopper Products via per-brand SLAS client; cache variation matrices, respect 60s availability TTL, 429 backoff) and the CTL recommendations call. Widget → our proxy → SCAPI; no SLAS material ever in the page.
4. **Order poller job:** watermark loop per tenant (Cloud Run scheduled job), writing through the existing `record_purchase_event` pipeline; cancellation detection; reconciliation against confirmation-page beacons.
5. **Billing:** Stripe metered (Billing Meter API — legacy usage-records is gone) per the enterprise deal structure v5 (month 1 = 15% of attributed revenue; month 2+ = compute pass-through + 15%). `SKIP_BILLING`/`BILLING_TEST_MODE` conventions carry over; no Shopify usage-charge path for SFCC tenants (guard `createShopifyUsageCharge` on platform).
6. **Security posture:** no new anon-key surface (keep the July RPC lockdown discipline); SFCC credentials never leave the server; widget-facing calls stay slug-keyed exactly like today.

**Events that exist only because of Shopify and their SFCC replacements:** web pixel → confirmation snippet + poller; `refunds/create` webhook → returns feed/haircut; `products/*` webhooks (config_version bump) → SCAPI product reads are live per-request, catalog gate becomes optional per-tenant; `app/uninstalled` → contract off-boarding, manual.

---

## 4. Deliverables & build plan

**One widget codebase throughout — `widget-main.js` gains an SFCC detection method and an SFRA cart driver behind the existing flags; everything else is packaging.**

### Phase A — SFRA demo/pilot kit (trigger: now — it's a sales asset) · ~1–2 weeks
> **STATUS 2026-07-24: BUILT + LOCALLY VERIFIED (not deployed).** Shipped: `public/ello-sfcc.js` (adapter: fingerprint, JSON-LD/Method-7/microdata detection ladder, Cart-AddProduct driver with jQuery minicart re-fire + CSRF retry, `trackOrder()` beacon), three gated platform hooks in `widget-main.js` (`ELLO_PLATFORM_PRODUCT`, `ELLO_PLATFORM_PRODUCT_JSON`, `ELLO_PLATFORM_URL_HANDLE` — no-ops on Shopify), loader dev-origin fix, demo-bookmarklet auto-injects the adapter on demandware-fingerprinted sites, and `dev/sfcc-harness.mjs` (fake SFRA storefront). Verified E2E on the harness: Method 7 + JSON-LD detection, widget open with platform product, REAL NB2 render mirrored onto the PDP hero, two cart adds through `Cart-AddProduct` with native jQuery events updating the site minicart. Remaining Phase A: live-brand smoke test via bookmarklet (Boot Barn/PacSun), size-picker-from-result pass in popup mode, deploy.
1. `public/ello-sfcc.js` adapter (extends `ello-anywhere.js`): SFCC fingerprinting, Method 7 (`data-pid` + `Product-Variation`), variant resolution (master → variation group → variant), `Cart-AddProduct` driver + minicart event re-fire + CSRF defensive retry, `reportingURL` beacon. Registers itself as the default `ELLO_CART_HOOK` so widget-main needs minimal changes; un-suppress View-cart for SFCC (CTL stays off until Phase C).
2. `widget-main.js`: Method 7 wired into `detectCurrentProduct()`; currency/locale from the SFRA product model instead of `window.Shopify.currency`.
3. Demo integration: `demo-launch.mjs` + bookmarklet load the SFCC adapter on `/on/demandware.static`-fingerprinted sites → **real add-to-cart in the prospect's own minicart during the demo.** This is the pitch asset.
4. Pilot attribution (degraded, honest): GTM confirmation-page tag reading localStorage session id + on-page order data; manual/CSV reconciliation.

**Definition of "working version" (the user's ask): Phase A complete = widget runs, renders, and adds to cart on a live SFRA storefront via two script tags, with pilot-grade attribution.**

### Phase B — production attribution + cartridge (trigger: signed pilot) · ~2–3 weeks + brand's release train
5. `int_ello` cartridge suite (mirror the Dynamic Yield shape): `int_ello_sfra` (hooks.json → `app.template.htmlHead` loader + context blob; `Order-Confirm` attribution include), `int_ello_core` (helpers), `bm_ello`-style custom site preferences (`elloEnabled`, `elloStoreSlug`, `elloWidgetSrc`, `elloConsentMode`, placement), `metadata/` XML (site prefs + `c_elloSessionId` on Basket & Order), `CheckoutServices-PlaceOrder` extension (cookie → `order.custom.elloSessionId`, consent-gated, no network calls in-transaction), SiteGenesis `<isinclude>` notes, `httpHeadersConf.json` CSP guidance, install guide an SFCC dev executes in <1 day, GitHub repo (public or on request — the Klarna/Yotpo pattern).
6. Backend: SFCC tenant model + provisioning, SCAPI product proxy, order poller, Stripe metered billing wiring.
7. Consent adapter: Default SFCC consent / OneTrust / Usercentrics three-way (the Awin pattern), with widget (Functional/C0003) and attribution pixel (Performance/Targeting) **separately gateable**.

### Phase C — composable + CTL + marketplace (trigger: first composable prospect / post-first-logo)
8. `@ello/sfcc-composable` npm package: `<ElloTryOn>` React component (lazy-load, route-change re-arm, mount outside React root) + documented `setCartHandler` → SCAPI baskets example (incl. `c_elloSessionId` on the basket write — line-item attribution rides the brand's own call).
9. CTL v1 via SCAPI recommendations/sets through our proxy; unsuppress the rail for SFCC tenants.
10. AppExchange/AgentExchange listing: partner signup → B2C category pre-approval → security review ($999, 4–8 wks, ~50% first-fail) + ~$150/yr. **After** the first signed logo — it's the trust badge for deals #2–3, and hard fees are only ~$1,150–$3,150 total. Side benefit: partner status unlocks our own on-demand sandbox (until then, we develop in the pilot brand's sandbox — which the pilot gives us anyway).

### Sandbox verification checklist (first brand sandbox, before anything is "production")
- [ ] Basket→Order `c_` attribute copy semantics (define on both objects; verify flow-through)
- [ ] Brand's `Cart-AddProduct` has no custom CSRF hardening
- [ ] Variation-group-as-PDP-entity resolution on their catalog
- [ ] Confirmation-page include renders on all payment paths (incl. PayPal/Klarna returns)
- [ ] Poller watermark loop against their order volume; `cancelled` transitions caught
- [ ] CSP Report-Only dry run clean; consent categories mapped with their CMP
- [ ] Widget vs their jQuery version / mega-menu z-index / page-cache behavior

---

## 5. Enterprise procurement pack (prepare once, reuse every deal)

- **DPA + biometric posture — the hottest wire.** Active BIPA class actions target try-on tools at Estée Lauder, Louis Vuitton, Target et al. ($1K–$5K per violation); the *brand* wears the suit, so their counsel will grill us. Our defensible position: generation, not recognition — no biometric identifiers extracted, no identification performed; written consent flow already shipped in-widget. Must add: published retention/destruction schedule, geo-aware handling (IL/TX/WA), subprocessor list (Google/Gemini, FASHN, Supabase, Cloudflare, GCP), CCPA "sensitive PI" treatment. **Come to the table with the DPA pre-drafted — it's a differentiator.**
- **SOC 2:** frequently negotiable for a paid pilot with questionnaire + encryption story + "Type I in progress with date"; effectively required for full rollout. Start Type I via a compliance-automation platform when the first serious SFCC conversation opens (weeks, low-five-figures).
- **SLA narrative:** 99.9% + service credits; the widget fails silent and the PDP is unaffected — the graceful-degradation story is strong. Cyber/E&O insurance cert ($1–5M band) will be asked.
- **CSP ask:** one hostname, three directives, Report-Only dry run offered.

## 6. Go-to-market notes

- **Sell direct; the cartridge is collateral, not a gate.** Buyer = VP eCommerce / Director Digital Product; installer = in-house SFCC devs or the agency of record. Scope the install as "under one sprint" (it genuinely is).
- **Agency channel:** fashion-heavy SFCC shops first — RafterOne (ex-PixelMEDIA), Astound Digital, CQL, OSF, Tryzens (CQL maintains Yotpo's cartridge; Astound maintains Bazaarvoice's — agencies are a maintenance channel too). Typical referral economics ~10% of first-year revenue. A flawless public cartridge + docs lets an agency dev demo Ello without talking to us.
- **Timing:** retail Q4 code freeze is near-universal — **pitch SFCC integrations before September** or plan for January.
- **Verified SFCC targets** (see §7 for evidence): Boot Barn (SiteGenesis-era, zero fit tools — open lane), PacSun (SFRA, perfect JSON-LD, already installs vendors like TrueFit via one template snippet), Tillys (SFRA, deprioritized — org transition), Ralph Lauren (SFRA, TrueFit wired-but-dark — the door-opener angle), Coach (headless-over-SFCC, already pays Tangiblee for visual commerce), Adidas (SFCC in the stack, custom front). **Corrections to prior assumptions:** Lululemon's US site is NOT SFCC (their UK/DE/AU sites are); Arc'teryx is NOT SFCC at all (custom headless) — both remain reachable, but via the generic Ello Anywhere path + CSP allowlist, not the SFCC kit specifically.
- **One GTM caveat from the census:** conversion-critical PDP widgets on these sites are installed via template/cartridge script tags in server HTML, not through GTM — position the GTM route as pilot-fallback only, and lead with the snippet/cartridge ask.

## 7. Target-brand stack verification (live teardowns, 2026-07-24)

Direct curl + real-browser DOM inspection of one production PDP per brand. **6 of 8 non-Shopify targets run SFCC in production right now.**

| Brand | Platform (evidence) | Architecture | PDP JSON-LD | CSP |
|---|---|---|---|---|
| **bootbarn.com** | SFCC ✅ (`dwac_*` cookies, `Sites-bootbarn_us-Site` static paths) | **SiteGenesis-era** server-rendered (`#pdpMain`, `js/app.js`, jQuery 3.7.1) | **NO** — microdata only (`itemtype=schema.org/Product`). Method 6 won't fire → needs microdata fallback or `window.elloProduct` config line | **None** — zero CSP work |
| **pacsun.com** | SFCC ✅ (full `dwsid`/`dwac_*` set + live **SLAS JWT**, realm `AAJE_PRD`) | **SFRA** server-rendered, SLAS/SCAPI hybrid plumbing | **YES — ideal.** `ProductGroup` + `hasVariant` (sku, color, size, 3 images/variant, offers). Method 6 fires as-is | `frame-ancestors` only — zero CSP work |
| **tillys.com** | SFCC ✅ (robots `demandware.store` disallow, `Sites-tillys-Site`) | **SFRA** (behind Cloudflare bot challenge) | **YES** — `ProductGroup` | `frame-ancestors` only — zero CSP work |
| **coach.com** | SFCC backend ✅, **headless Next.js front** (App Router chunks + `demandware.static` + Einstein) | Hybrid headless — the Ello Anywhere shape | **YES — rich** (`ProductGroup` 10 variants + `Product`) | Massive vendor allowlist (incl. **Tangiblee**, Klarna, jsdelivr) — one-line append, they add vendors constantly |
| **ralphlauren.com** | SFCC ✅ (robots list `Product-Variation`, `CQRecomm-Start`; `Sites-RalphLauren_US-Site`) | **SFRA** (PerimeterX bot wall, Yottaa script sequencing) | Partial — single `Product`, no ProductGroup; variants live in page JS → Method 7 territory | **None** — zero CSP work |
| **adidas.com** | SFCC backend ✅ (live `/on/demandware.store/Sites-adidas-US-Site/` controller calls) | Custom Next.js micro-frontends over SFCC; treat as "SFCC in the stack, custom everything else" | Partial — single `Product` | **None** on PDP response |
| **lululemon.com** | **US = NOT SFCC** (custom Next.js, `lllapi.com`); **UK/DE/AU sites ARE SFCC** (`lululemon.co.uk/on/demandware.store/Sites-UK-Site/...`) | US headless custom; intl SFCC | **YES — excellent** (`ProductGroup`, 66 variants) | Large allowlist incl. **TrueFit + FindMine + Klarna** — exact precedent for a visual-commerce vendor |
| **arcteryx.com** | **NOT SFCC** — custom headless Next.js on Fastly Compute (Kasada bot defense) | Headless custom → pure Ello Anywhere target | YES in server HTML (35-variant ProductGroup, verified 07-23 via demo tooling); may not survive client rehydration — re-verify at pilot | Strictest of the set, but allowlists **Fibbl** (3D/AR viz) — proof they pass niche visual vendors through security review |
| aloyoga.com / vuoriclothing.com / skims.com | **Shopify** (robots templates, shop-id paths) | — | — | Native Ello app is the path; not an SFCC/Anywhere deal |

**Live widget census — how vendors actually got installed (evidence for our install path):**
- **PacSun ships TrueFit as one inline snippet in the PDP template server HTML**, and Yotpo consent-gated via OneTrust category classes — the exact shape of our pilot ask.
- **Boot Barn loads a Pixlee "demandware-specific" bundle + TurnTo + ~10 more vendors straight from server HTML** (cartridge/template installs). GTM exists everywhere, but **conversion-critical PDP widgets are NOT loaded through GTM** on any of these sites — plan pilots around a template/cartridge tag, with GTM as fallback only.
- **Coach direct-loads a per-domain managed Tangiblee bundle** + CSP entry — the headless-site vendor pattern.

**Fit/try-on tools already live on targets (sales angles):**
1. **Coach → Tangiblee LIVE** (bag visualization; not shopper-photo AI — differentiated, but they've already bought a "see it on you" tool once).
2. **Lululemon → TrueFit + FindMine LIVE** (size rec + complete-the-look — they pay for both halves of what Ello does, without the visual).
3. **PacSun → TrueFit LIVE.**
4. **Ralph Lauren → TrueFit WIRED BUT TURNED OFF** (`"TRUEFIT_ENABLED":false` in live config) — door-opener: "your TrueFit slot is dark; here's what visual try-on does instead."
5. **Boot Barn → nothing** — boots + our verified footwear pipeline = open lane (Rhys's thesis holds).

**Pilot install ask (grounded, quote this to dev teams):** SFRA site with no CSP (Boot Barn/PacSun/Tillys/RL class) = **3–6 brand-side dev-hours** (loader tag in template 1–2h, optional `data-ello-tryon` button 0.5h, cart handler 0–1h, confirmation beacon 1–2h, product config line 0.5h where JSON-LD is absent). CSP-enforcing headless (Coach/Arc'teryx class) = **6–10 hours**, the extra being the security-review meeting, not the edit. Calendar time = 1–2 sprints on their release train regardless. Strongest rebuttal to "integration is a big project": PacSun installed TrueFit with one snippet, Boot Barn loads Pixlee's Demandware bundle, Coach allowlisted Tangiblee — every install path we need is one these exact brands already shipped for a comparable vendor.

---

## 8. Risks (ranked)

1. **Attribution completeness** — mitigated by dual-path capture + contractual refund treatment; never promise Shopify-parity refund netting.
2. **Per-brand storefront variance** (custom SFRA hardening, variation-group catalogs, SG remnants) — mitigated by the sandbox checklist and the detection/cart ladders; every pilot budget includes a 2–3 day adapter-tuning line.
3. **Enterprise sales cycle ≫ build time** — the build is weeks; procurement + release trains are months. That's why Phase A (demo asset) is the only pre-prospect build.
4. **CSP/security review friction** — mitigated by the one-hostname ask + Report-Only dry run + pre-drafted DPA/BIPA pack.
5. **Composable drift** (PWA Kit versions, Storefront Next) — mitigated by keeping the brand-side surface tiny (`setCartHandler` + one component).
6. **Solo-founder bandwidth** — Phase B/C only on a signed pilot; agencies do the brand-side install labor by design.

## 9. Source appendix (load-bearing)

- SFRA Cart controller source (no CSRF on AddProduct): salesforcecommercecloud.github.io/b2c-dev-doc/.../Cart.js.html · client events: product/base.js.html
- SCAPI Orders OAS (getOrders filters/limits/scopes): github.com/SalesforceCommerceCloud/commerce-sdk · SCAPI custom properties (`c_`): developer.salesforce.com/docs/commerce/commerce-api/guide/custom-properties.html
- OCAPI deprecation: developer.salesforce.com/docs/commerce/commerce-api/guide/why-use-scapi.html
- SFRA hooks (`app.template.htmlHead`): developer.salesforce.com/docs/commerce/sfra/guide/b2c-sfra-hooks.html · SFRA base mirror: github.com/muhammadmuneeb198/storefront-reference-architecture
- CSP (`httpHeadersConf.json`, default = frame-ancestors only): rhino-inquisitor.com/secure-coding-in-salesforce-b2c-commerce-cloud/ · eCDN no-header-rewrite: developer.salesforce.com/docs/commerce/commerce-api/guide/cdn-zones-custom-rules.html
- Vendor cartridge anatomy: github.com/klarna/sfcc-klarna-payments · github.com/YotpoLtd/salesforce-cartridge · github.com/astoundcommerce/link_bazaarvoice · dy.dev/docs/salesforce-sfra (Dynamic Yield — closest analog) · Awin dual-path attribution: help.awin.com/developers/docs/salesforce-commerce-cloud
- Composable vendor pattern: docs.adyen.com/plugins/salesforce-commerce-cloud/composable-storefront · SLAS: developer.salesforce.com/docs/commerce/commerce-api/guide/slas.html · Hybrid Auth: .../hybrid-authentication.html
- Marketplace/fees: appnigma.ai/blogs/salesforce-appexchange-listing-guide-2026/ · security review fees: developer.salesforce.com/docs/atlas.en-us.packagingGuide.meta/packagingGuide/security_review_fees.htm
- BIPA try-on litigation: afslaw.com/perspectives/alerts/biometric-privacy-class-actions-take-aim-virtual-try-retailers
- Repo audit: this session, 2026-07-24 (file:line references against ello-storefront-app @ current main)
