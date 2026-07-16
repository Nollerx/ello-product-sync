/**
 * Ello VTO — DEMO ENGINE (sales screen-recordings on ANY prospect Shopify store)
 * ============================================================================
 *
 * WHAT THIS IS
 *   A self-contained script that drops the real Ello VTO widget onto a prospect's
 *   live Shopify store — a store that has NEVER installed the app — so Andrew can
 *   screen-record a native-looking try-on for outreach. It is loaded by the tiny
 *   bookmarklet / console snippet on demo-bookmarklet.html.
 *
 * WHY THE PLAIN `?ello_dev=1` FLAG ISN'T ENOUGH
 *   widget-loader.js reads `?ello_dev=1` only when it is ALREADY on the page. A
 *   prospect store has no Ello embed, so nothing reads the flag (confirmed on
 *   comfrt.com, 2026-07-04). This script IS the thing that puts the loader on the
 *   page — and points it at the ello-dev-store's config + try-on auth.
 *
 * WHAT IT DOES  (maps 1:1 to the four demo requirements)
 *   1. INJECT the loader — from this script's OWN origin. The bookmarklet loads
 *      THIS file from http://localhost:3000 first (when `npm run vite` is up) and
 *      falls back to the deployed public Cloud Run origin, so `BASE` below is
 *      already "local when available, cloud otherwise". Everything (loader,
 *      widget-main.js, widget.html, /api/widget-config, /tryon) is served from BASE.
 *   2. INITIALIZE against the ello-dev-store — inject the loader with
 *      data-store-slug="ello-dev-store" so config resolves to the demo store and
 *      every try-on POSTs storeSlug=ello-dev-store (the /tryon proxy authenticates
 *      purely on that slug — no per-store secret — so it "just works").
 *   3. READ the prospect's product — handled by widget-main.js's existing product
 *      detection (og:image + /products/<handle>.js variant image). We just pass the
 *      live handle / product id / variant id into window.Ello.openTryOn(ctx).
 *   4. LOOK NATIVE — the demo store's config renders the floating launcher AND we
 *      inject a native-styled inline "Try it on" button next to Add-to-Cart on PDPs.
 *
 * SAFETY (same spirit as widget-loader.js's localhost-only ello_dev regex)
 *   • Sets window.__ELLO_DEMO__ = true. The un-curated Complete-the-Look fallback
 *     in widget-main.js is gated on that flag, so a real shopper on a real store is
 *     never affected — even after this file ships to Cloud Run.
 *   • The local origin is only ever localhost/127.0.0.1 (BASE is this file's own
 *     origin; the bookmarklet only ever loads it from localhost or Cloud Run).
 *   • Everything is a no-op unless a human runs the bookmarklet in their own tab.
 *
 * This file is ALSO the readable source of the paste-in console snippet.
 */
(function () {
  'use strict';

  // ── This script's own origin = where the bookmarklet successfully loaded it
  //    from. localhost when `npm run vite` is up, else the public Cloud Run origin.
  var SELF = document.currentScript;
  var BASE;
  try { BASE = new URL((SELF && SELF.src) || '').origin; } catch (e) { BASE = ''; }
  if (!BASE) BASE = 'https://ello-vto-public-13593516897-u5htiuxfrq-uc.a.run.app';
  var IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE);

  // ── The designated demo shop. All config + try-on auth resolve to this store.
  var DEMO = {
    slug: 'ello-dev-store',
    shop: 'ello-dev-store.myshopify.com',
    name: 'Ello Demo'
  };
  var CLOUD_FALLBACK = 'https://ello-vto-public-13593516897-u5htiuxfrq-uc.a.run.app';

  function log() {
    try {
      var a = ['%c[Ello Demo]', 'color:#2563eb;font-weight:700'];
      for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
      console.log.apply(console, a);
    } catch (e) {}
  }

  // Re-run guard: allow a second bookmarklet press to re-open the widget instead
  // of double-injecting the loader.
  if (window.__ELLO_DEMO_BOOTED__) {
    log('already active — re-opening.');
    demoOpen();
    return;
  }
  window.__ELLO_DEMO_BOOTED__ = true;

  // ── (Safety) Mark demo mode. widget-main.js reads this to enable the
  //    un-curated Complete-the-Look fallback and NOTHING else changes for anyone
  //    who doesn't have it set.
  window.__ELLO_DEMO__ = true;
  window.__ELLO_DEBUG__ = true; // verbose widget logs during a demo

  // ── Dev vs cloud wiring for the loader ───────────────────────────────────────
  // If this file came from localhost, tell widget-loader.js to serve the widget
  // (and hit /tryon) from localhost too. If it came from Cloud Run, make sure any
  // stale local override is cleared so the loader uses its own (cloud) origin.
  try {
    if (IS_LOCAL) localStorage.setItem('ello_dev_origin', BASE);
    else localStorage.removeItem('ello_dev_origin');
  } catch (e) { /* storage disabled — loader still derives BASE from its own src */ }

  log((IS_LOCAL ? 'LOCAL' : 'CLOUD') + ' mode — serving widget from ' + BASE);

  // ── Demo settings (live-editable, persisted per browser) ─────────────────────
  // The gear panel writes these; applyDemoConfig() pushes them onto the widget's
  // live config. They survive re-clicks/reloads (localStorage) so Andrew sets his
  // preferred demo look once. `mode` is the big one: 'popup' shows the try-on in
  // the widget popup; 'mirror' turns the widget off and drops the result onto the
  // PDP hero image (pdpImageSwapEnabled) — same choice a real merchant has.
  var SETTINGS_KEY = 'ello_demo_settings';
  var DEMO_DEFAULTS = {
    mode: 'popup',          // 'popup' | 'mirror'
    launcher: true,         // floating launcher bubble visible
    inlineButton: true,     // native "Try it on" button by Add-to-Cart
    desktopPreview: false,  // desktop peek popup (off so it can't interrupt a recording)
    completeTheLook: true,  // outfit-upsell rail
    brandColor: '',         // '' = use the demo store's configured color
    inlineText: '',         // '' = use the demo store's configured button text
    ctlPairHandle: ''       // pin the Complete-the-Look suggestion to this product handle (demo scripting)
  };
  function loadSettings() {
    try { return Object.assign({}, DEMO_DEFAULTS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); }
    catch (e) { return Object.assign({}, DEMO_DEFAULTS); }
  }
  function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(demoSettings)); } catch (e) {} }
  var demoSettings = loadSettings();
  var demoOrig = null; // the demo store's own colors/text, captured on first resolve

  // Publish the pinned Complete-the-Look handle to the widget (read in demo mode
  // by elloPickComplementary → elloDemoPinnedComplementary). null when unset so
  // the recommender falls back to curated → category-guess as normal.
  function applyCtlPair() { window.__ELLO_DEMO_CTL_HANDLE__ = (demoSettings.ctlPairHandle || '').trim() || null; }
  applyCtlPair();

  function ensureDemoStyle() {
    var s = document.getElementById('ello-demo-style');
    if (!s) { s = document.createElement('style'); s.id = 'ello-demo-style'; (document.head || document.documentElement).appendChild(s); }
    return s;
  }
  // Hide only the COLLAPSED launcher (.widget-minimized) — the inline button can
  // still open the full panel, which is exactly the launcher-less merchant setup.
  function updateLauncherVisibility() {
    ensureDemoStyle().textContent = demoSettings.launcher ? '' : '#virtualTryonWidget.widget-minimized{display:none !important}';
  }
  function updateInlineButtonVisibility() {
    var b = document.getElementById('ello-demo-inline-btn');
    if (b) b.style.display = demoSettings.inlineButton ? '' : 'none';
  }
  function applyBrandColorLive() {
    var w = document.getElementById('virtualTryonWidget');
    if (!w) return;
    if (demoSettings.brandColor) w.style.setProperty('--minimized-bg', demoSettings.brandColor);
    else w.style.removeProperty('--minimized-bg'); // revert to the theme/store bubble color
  }

  // Push demoSettings onto the live widget config + apply the DOM side-effects that
  // need to happen without a page reload. Everything the widget reads at try-on
  // time (CTL, PDP swap) just needs the config flag; visibility needs DOM tweaks.
  function applyDemoConfig(cfg) {
    cfg = cfg || window.ELLO_STORE_CONFIG;
    if (!cfg) return;
    cfg.widgetVisibilityMode = 'always';     // ignore the demo store's smart-hide on prospect PDPs
    cfg.ctlHoldoutEnabled = false;            // never suppress the upsell in a demo
    cfg.fittingRoomEnabled = true;            // never let the demo store's Fitting Room toggle no-op a first-time (no-photo) inline open (widget-main.js:7290)
    cfg.floatingWidgetPdpEnabled = demoSettings.launcher;
    cfg.floatingWidgetNonPdpEnabled = demoSettings.launcher;
    cfg.inlineButtonEnabled = demoSettings.inlineButton;
    cfg.desktopPreviewEnabled = demoSettings.desktopPreview;
    cfg.completeTheLookEnabled = demoSettings.completeTheLook;
    cfg.pdpImageSwapEnabled = (demoSettings.mode === 'mirror');
    // Capture the store's own color/text once so "clear" can restore them exactly.
    if (!demoOrig) demoOrig = { pc: cfg.widgetPrimaryColor, mc: cfg.minimizedColor, ic: cfg.inlineButtonColor, it: cfg.inlineButtonText };
    cfg.widgetPrimaryColor = demoSettings.brandColor || demoOrig.pc;
    cfg.minimizedColor     = demoSettings.brandColor || demoOrig.mc;
    cfg.inlineButtonColor  = demoSettings.brandColor || demoOrig.ic;
    cfg.inlineButtonText   = demoSettings.inlineText  || demoOrig.it;

    // Keep widget-main.js's own override latches in agreement with the panel so
    // the config flag is always authoritative (no stale ?ello_ctl / ?ello_pdp_swap).
    try {
      if (demoSettings.mode === 'mirror') sessionStorage.setItem('ello_pdp_swap', '1');
      else sessionStorage.removeItem('ello_pdp_swap');
    } catch (e) {}
    try { localStorage.removeItem('ello_ctl'); } catch (e) {}

    updateLauncherVisibility();
    updateInlineButtonVisibility();
    applyBrandColorLive();
    styleInlineButtons(cfg);
  }
  window.addEventListener('ello:config-resolved', function (e) {
    applyDemoConfig((e && e.detail) || window.ELLO_STORE_CONFIG);
    log('config resolved for', DEMO.slug, '· mode:', demoSettings.mode);
  });
  // If config somehow already resolved (re-entrancy), apply now too.
  if (window.ELLO_STORE_CONFIG) applyDemoConfig(window.ELLO_STORE_CONFIG);

  // ── Inject widget-loader.js pointed at the demo store ────────────────────────
  function injectLoader() {
    if (document.getElementById('virtual-tryon-widget-container') ||
        document.getElementById('ello-demo-loader')) {
      log('loader already present — skipping inject.');
      return;
    }
    var s = document.createElement('script');
    s.id = 'ello-demo-loader';
    s.src = BASE + '/widget-loader.js?ello_demo=' + Date.now();
    // These data-* attrs are read by widget-loader.js off document.currentScript.
    // data-store-slug makes config resolve via ?store_slug=ello-dev-store (so the
    // prospect's own window.Shopify.shop is ignored for config + try-on).
    s.setAttribute('data-store-slug', DEMO.slug);
    s.setAttribute('data-shop-domain', DEMO.shop);
    s.setAttribute('data-store-name', DEMO.name);
    s.async = true;
    s.onerror = function () {
      // Local origin unreachable mid-run (vite stopped / mixed-content blocked) →
      // fall back to Cloud Run so the demo still works.
      if (BASE !== CLOUD_FALLBACK) {
        log('loader failed from ' + BASE + ' — retrying from Cloud Run.');
        BASE = CLOUD_FALLBACK;
        try { localStorage.removeItem('ello_dev_origin'); } catch (e) {}
        var s2 = document.createElement('script');
        s2.id = 'ello-demo-loader';
        s2.src = BASE + '/widget-loader.js?ello_demo=' + Date.now();
        s2.setAttribute('data-store-slug', DEMO.slug);
        s2.setAttribute('data-shop-domain', DEMO.shop);
        s2.setAttribute('data-store-name', DEMO.name);
        s2.async = true;
        (document.head || document.documentElement).appendChild(s2);
      }
    };
    (document.head || document.documentElement).appendChild(s);
    log('loader injected from ' + BASE);
  }

  function onPdp() {
    return /\/products\//.test(window.location.pathname);
  }
  function currentHandle() {
    try { var mo = window.location.pathname.match(/\/products\/([^\/\?#]+)/); return mo ? decodeURIComponent(mo[1]) : null; }
    catch (e) { return null; }
  }

  // ── Robust selected-COLOR detection ──────────────────────────────────────────
  // The try-on must use the color the shopper is looking at. Different themes
  // expose the selection differently, so we resolve it from the VISIBLE swatch
  // selection first (checked option radios / selects / aria-checked swatches),
  // matched against the product's real variants — then fall back to ?variant=,
  // the add-to-cart form, and analytics meta. We publish the winner on
  // window.__ELLO_DEMO_VARIANT_ID__, which widget-main.js trusts in demo mode.
  var __demoPj = null;
  // Headless Shopify (Hydrogen/Oxygen — e.g. spanx.com) 404s on the Liquid
  // /products/<handle>.js route. Those stores instead ship a schema.org
  // `ProductGroup` in JSON-LD carrying every color variant's image + Color/Size.
  // Read variants from THAT so color resolution still works — and so the demo
  // never fires a 404 that clutters the console mid-recording.
  function demoLdProductJson(handle) {
    try {
      var nodes = document.querySelectorAll('script[type="application/ld+json"]');
      for (var i = 0; i < nodes.length; i++) {
        var d; try { d = JSON.parse(nodes[i].textContent || 'null'); } catch (e) { continue; }
        if (!d) continue;
        var list = Array.isArray(d) ? d : (Array.isArray(d['@graph']) ? d['@graph'] : [d]);
        for (var k = 0; k < list.length; k++) {
          var n = list[k]; if (!n || typeof n !== 'object') continue;
          var ty = n['@type'];
          var isGroup = ty === 'ProductGroup' || (Array.isArray(ty) && ty.indexOf('ProductGroup') !== -1);
          var hv = n.hasVariant;
          if (!isGroup || !Array.isArray(hv) || !hv.length) continue;
          var variants = hv.map(function (v) {
            var color = v.color || v.Color || null, size = v.size || v.Size || null;
            var offer = v.offers; if (Array.isArray(offer)) offer = offer[0];
            var img = v.image; if (Array.isArray(img)) img = img[0];
            if (img && typeof img === 'object') img = img.url || img.contentUrl || null;
            var avail = !offer || /InStock|LimitedAvailability|PreOrder|BackOrder/i.test(String((offer && offer.availability) || 'InStock'));
            var id = v.sku || v.gtin || (offer && offer.sku) || ('ld:' + [color, size].filter(Boolean).join('/'));
            return {
              id: String(id),
              options: [color, size].filter(function (x) { return x != null && String(x).trim(); }).map(String),
              available: avail,
              featured_image: (typeof img === 'string' && img) ? { src: img } : null
            };
          }).filter(function (v) { return v.options.length || v.featured_image; });
          if (variants.length) return { __h: handle, __ld: true, variants: variants };
        }
      }
    } catch (e) {}
    return null;
  }
  function demoProductJson(handle) {
    if (__demoPj && __demoPj.__h === handle) return Promise.resolve(__demoPj);
    var ld = demoLdProductJson(handle);
    if (ld) { __demoPj = ld; return Promise.resolve(ld); }
    return fetch('/products/' + encodeURIComponent(handle) + '.js', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j) { j.__h = handle; __demoPj = j; } return j; })
      .catch(function () { return null; });
  }
  function normOpt(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
  function selectedOptionValues() {
    var vals = [];
    try {
      document.querySelectorAll('input[name^="option"]:checked').forEach(function (r) { if (r.value) vals.push(r.value); });
      document.querySelectorAll('select[name^="option"]').forEach(function (s) { if (s.value) vals.push(s.value); });
      document.querySelectorAll('[aria-checked="true"][data-value],[aria-checked="true"][data-option-value],[data-option-value].selected,[data-option-value].is-selected,.swatch--selected[data-value]').forEach(function (el) {
        var v = el.getAttribute('data-value') || el.getAttribute('data-option-value'); if (v) vals.push(v);
      });
    } catch (e) {}
    var seen = {}, out = [];
    vals.forEach(function (v) { var n = normOpt(v); if (n && !seen[n]) { seen[n] = 1; out.push(n); } });
    return out;
  }
  function resolveDemoVariant(handle) {
    return demoProductJson(handle).then(function (json) {
      var variants = (json && Array.isArray(json.variants)) ? json.variants : null;
      // 1) Match the VISIBLE swatch selection to a real variant (most reliable).
      if (variants) {
        var sel = selectedOptionValues();
        if (sel.length) {
          var pick = function (test) { return variants.filter(test); };
          var m = pick(function (v) { var o = (v.options || []).map(normOpt); return sel.every(function (s) { return o.indexOf(s) !== -1; }); });
          if (!m.length) m = pick(function (v) { var o = (v.options || []).map(normOpt); return sel.some(function (s) { return o.indexOf(s) !== -1; }); });
          if (m.length) return m.filter(function (v) { return v.available; })[0] || m[0];
        }
      }
      // 2) Explicit signals: ?variant= → add-to-cart form → analytics meta.
      var vid = null;
      try { vid = new URLSearchParams(location.search).get('variant'); } catch (e) {}
      if (!vid) { var i = document.querySelector('form[action*="/cart/add"] [name="id"]'); if (i && /^\d+$/.test(String(i.value))) vid = i.value; }
      if (!vid && window.ShopifyAnalytics && window.ShopifyAnalytics.meta && window.ShopifyAnalytics.meta.selectedVariantId) vid = String(window.ShopifyAnalytics.meta.selectedVariantId);
      if (vid && variants) { var want = String(vid).replace(/^gid:\/\/shopify\/ProductVariant\//, ''); var f = variants.find(function (v) { return String(v.id) === want; }); if (f) return f; }
      if (vid) return { id: vid };
      // 3) First available.
      if (variants) return variants.find(function (v) { return v.available; }) || variants[0];
      return null;
    }).catch(function () { return null; });
  }
  function publishDemoVariant(v) {
    if (!v || !v.id) return;
    window.__ELLO_DEMO_VARIANT_ID__ = String(v.id);
    window.ELLO_PRESELECTED_VARIANT_ID = String(v.id);
    window.ELLO_INLINE_CTX = window.ELLO_INLINE_CTX || {};
    window.ELLO_INLINE_CTX.variantId = String(v.id);
    var src = (v.featured_image && (v.featured_image.src || v.featured_image)) ||
              (v.featured_media && v.featured_media.preview_image && v.featured_media.preview_image.src) || null;
    if (src) window.__ELLO_DEMO_VARIANT_IMG__ = src;
  }
  var __demoVarBusy = false;
  function syncDemoVariant() {
    if (!onPdp() || __demoVarBusy) return Promise.resolve();
    __demoVarBusy = true;
    var h = currentHandle();
    if (!h) { __demoVarBusy = false; return Promise.resolve(); }
    return resolveDemoVariant(h).then(function (v) { if (v) publishDemoVariant(v); })
      .catch(function () {}).then(function () { __demoVarBusy = false; });
  }
  // Keep the selected color in sync as the shopper clicks swatches / changes size.
  function watchVariant() {
    if (!onPdp()) return;
    var deb = null;
    var kick = function () { if (deb) return; deb = setTimeout(function () { deb = null; syncDemoVariant(); }, 120); };
    document.addEventListener('change', function (e) { var t = e.target; if (t && t.name && /option/i.test(t.name)) kick(); }, true);
    document.addEventListener('click', function (e) { var t = e.target; if (t && t.closest && t.closest('[data-option-value],.swatch,[class*="swatch"],label,fieldset')) kick(); }, true);
    window.addEventListener('popstate', kick);
    syncDemoVariant(); setTimeout(syncDemoVariant, 1200); setTimeout(syncDemoVariant, 3000);
  }

  // ── Read the CURRENT product (handle + id + resolved variant) off the PDP ─────
  function currentProductCtx() {
    var ctx = { source: 'inline_button' };
    ctx.productHandle = currentHandle();
    var p = window.ShopifyAnalytics && window.ShopifyAnalytics.meta && window.ShopifyAnalytics.meta.product;
    if (p && p.id) ctx.productId = String(p.id);
    var vid = window.__ELLO_DEMO_VARIANT_ID__ || null;
    if (!vid) { try { vid = new URLSearchParams(location.search).get('variant'); } catch (e) {} }
    if (!vid) { var i = document.querySelector('form[action*="/cart/add"] [name="id"]'); if (i && /^\d+$/.test(String(i.value))) vid = i.value; }
    if (!vid && p && Array.isArray(p.variants) && p.variants[0]) vid = String(p.variants[0].id);
    if (vid) ctx.variantId = String(vid);
    return ctx;
  }

  // Fire a try-on for the current PDP product via the widget's public API. We
  // re-resolve the selected color first so the try-on always uses what's on screen.
  // Early clicks are safe: window.Ello.openTryOn queues until widget-main.js loads.
  function fireTryOn(ctx) {
    if (window.Ello && typeof window.Ello.openTryOn === 'function') {
      log('openTryOn', ctx);
      window.Ello.openTryOn(ctx);
    } else {
      var tries = 0;
      var t = setInterval(function () {
        if (window.Ello && typeof window.Ello.openTryOn === 'function') { clearInterval(t); window.Ello.openTryOn(ctx); }
        else if (++tries > 40) { clearInterval(t); log('window.Ello never appeared'); }
      }, 100);
    }
  }
  function demoTryOn() {
    syncDemoVariant().then(function () { fireTryOn(currentProductCtx()); });
  }

  // Open the full fitting room (floating-launcher equivalent) — handy off-PDP.
  function demoOpen() {
    if (window.Ello && typeof window.Ello.openFittingRoom === 'function') {
      window.Ello.openFittingRoom({ source: 'fitting_room' });
    } else if (onPdp()) {
      demoTryOn();
    }
  }

  // On-screen test: a real rendered box, not display:none, AND not merely
  // "present but invisible" (visibility:hidden / opacity:0 on the element OR an
  // ancestor). Steve Madden's Rebooted theme keeps a SECOND add-to-cart — the
  // sticky bar that slides in on scroll — in the DOM at all times as a
  // position:fixed, visibility:hidden node. It has a real 200×42 rect and a
  // non-null offsetParent, so the old width/offsetParent-only test rated it
  // "visible" and our button anchored INTO it instead of the real buy button
  // the shopper sees (Andrew, stevemadden.com 2026-07-12). Rejecting hidden
  // nodes — and walking a few ancestors, since opacity/visibility are usually
  // set on the bar's WRAPPER — is what fixes that.
  function elloIsVisible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var cs = window.getComputedStyle(el);
    // visibility inherits, so the element's own computed value already reflects a
    // hidden ancestor; opacity does NOT inherit, so walk up to catch a faded bar.
    var n = el;
    for (var i = 0; i < 6 && n && n.nodeType === 1; i++) {
      var s = (n === el) ? cs : window.getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || s.opacity === '0') return false;
      n = n.parentElement;
    }
    if (el.offsetParent === null && cs.position !== 'fixed') return false;
    return true;
  }

  // True if el sits inside a position:fixed container — a sticky/floating "quick
  // add" bar pinned to the viewport, NOT the main in-flow buy box. Computed
  // position keeps this theme-agnostic. position:sticky is deliberately allowed:
  // themes routinely make the whole product buy column sticky, and that column
  // IS the main button.
  function elloInFixedBar(el) {
    var n = el;
    for (var i = 0; i < 12 && n && n.nodeType === 1; i++) {
      if (window.getComputedStyle(n).position === 'fixed') return true;
      n = n.parentElement;
    }
    return false;
  }

  // Add-to-cart buttons inside recommendation / quick-add / upsell blocks are
  // never the main buy button — anchoring there is the same bug as the sticky
  // bar. Steve Madden renders Algolia rec cards as `ais-hit--cart-button`
  // /cart/add forms; other stores use quick-add / upsell / "you may also like"
  // wrappers. Skip them all.
  var ELLO_ATC_SKIP = '.product-recommendations,.related-products,[data-recently-viewed],' +
    '.recently-viewed,[class*="ais-hit"],[class*="quick-add" i],[class*="quick_add" i],' +
    '[class*="quickadd" i],[class*="upsell" i],[class*="cross-sell" i],[class*="crosssell" i],' +
    '[id*="recommend" i],[class*="recommend" i],[class*="also-like" i],[class*="you-may" i]';
  function elloInSkipContainer(el) {
    try { return !!(el.closest && el.closest(ELLO_ATC_SKIP)); } catch (e) { return false; }
  }

  // Broad candidate set for the store's add-to-cart control. Themes vary wildly:
  // Steve Madden's real button is `<button type="submit" id="addToCartBtn">` with
  // NO name="add", so the old name=/submit-only selector only ever found the
  // sticky-bar copy. We also text-sweep for buttons labelled "Add to cart/bag"
  // that carry none of the usual markers. Returned in document order.
  function elloAtcCandidates() {
    var out = [];
    var push = function (el) { if (el && out.indexOf(el) === -1) out.push(el); };
    var sel = 'form[action*="/cart/add"] button[type="submit"],' +
              'form[action*="/cart/add"] input[type="submit"],' +
              'form[action*="/cart/add"] [name="add"],' +
              'button[name="add"],button#addToCartBtn,' +
              'button[class*="add-to-cart" i],button[class*="add_to_cart" i],' +
              'a[class*="add-to-cart" i],[data-add-to-cart]';
    try { document.querySelectorAll(sel).forEach(push); } catch (e) {}
    try {
      document.querySelectorAll('button,a[role="button"],input[type="submit"]').forEach(function (el) {
        var t = (el.innerText || el.value || '').trim().toLowerCase();
        if (t && t.length < 24 && /^add to (cart|bag|basket)\b/.test(t)) push(el);
      });
    } catch (e) {}
    out.sort(function (a, b) {
      var p = a.compareDocumentPosition(b);
      if (p & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (p & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    return out;
  }

  // The MAIN, on-screen add-to-cart button: visible, not in a rec/quick-add
  // block, and — preferred — NOT pinned inside a fixed sticky bar. Falling back
  // to a fixed candidate only when every visible one is fixed keeps stores whose
  // buy button is legitimately fixed working.
  function elloPickVisibleAtc() {
    var cands = elloAtcCandidates().filter(function (el) {
      return elloIsVisible(el) && !elloInSkipContainer(el);
    });
    if (!cands.length) return null;
    for (var i = 0; i < cands.length; i++) { if (!elloInFixedBar(cands[i])) return cands[i]; }
    return cands[0]; // every visible candidate is in a fixed bar → best we have
  }

  // ── Native-looking inline "Try it on" button next to Add-to-Cart (PDP only) ──
  function injectInlineButton() {
    if (!onPdp()) return;

    // Anchor on the MAIN visible add-to-cart button. Stores render SEVERAL
    // /cart/add controls (quick-add rec cards, a hidden sticky bar that pops in
    // on scroll, a mobile/desktop pair). The old code took the FIRST in DOM
    // order, which could be a hidden one (AYBL slate-blue 2026-07-06) or the
    // sticky bar (Steve Madden 2026-07-12); elloPickVisibleAtc now prefers the
    // real in-flow buy button and skips rec/quick-add blocks.
    var atc = elloPickVisibleAtc();
    var form = atc ? atc.closest('form[action*="/cart/add"]') : null;
    if (!form) {
      // No button anchor yet — fall back to a visible buy FORM, but never the
      // Algolia rec template or the sticky bar (same skip rules as the button).
      var forms = document.querySelectorAll('form[action*="/cart/add"]');
      for (var fi = 0; fi < forms.length; fi++) {
        if (elloIsVisible(forms[fi]) && !elloInSkipContainer(forms[fi]) && !elloInFixedBar(forms[fi])) { form = forms[fi]; break; }
      }
    }

    var existing = document.getElementById('ello-demo-inline-btn');
    if (existing && existing.offsetParent !== null) return;   // already placed + on-screen → done
    if (!atc && !form) return;                                // no anchor yet → watchPdp's observer retries
    if (existing) { try { existing.remove(); } catch (e) {} } // stale/hidden copy from a bad anchor → re-place

    // Harden layout with an id-selector + !important stylesheet BEFORE the
    // button exists, so no theme's own button rules (text-align / display /
    // justify-content, or a spinner ::after) can knock our icon+label
    // off-center. The break differs per store (AYBL centered wrong, 2026-07-06),
    // so we defend against all of them at once instead of per-theme.
    ensureInlineBtnStyles();

    var btn = document.createElement('button');
    btn.id = 'ello-demo-inline-btn';
    btn.type = 'button';
    btn.setAttribute('data-ello-inline-btn', '1');
    btn.innerHTML =
      '<span style="display:inline-flex;align-items:center;justify-content:center;gap:8px;">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M12 6.5V5.2a2 2 0 1 1 2-2"/>' +
        '<path d="M12 6.5 3.6 13.4a1 1 0 0 0 .64 1.77h15.5a1 1 0 0 0 .64-1.77L12 6.5z"/></svg>' +
        '<span class="ello-demo-inline-label">Try it on</span>' +
      '</span>';
    btn.style.cssText = [
      'display:flex', 'align-items:center', 'justify-content:center',
      'width:100%', 'box-sizing:border-box', 'margin:10px 0 0',
      'padding:14px 18px', 'border:none', 'border-radius:8px', 'cursor:pointer',
      'font:600 15px/1.2 inherit', 'letter-spacing:.01em',
      'background:#2563eb', 'color:#fff',
      'box-shadow:0 1px 2px rgba(0,0,0,.12)', 'transition:filter .12s ease'
    ].join(';') + ';';
    btn.onmouseenter = function () { btn.style.filter = 'brightness(1.06)'; };
    btn.onmouseleave = function () { btn.style.filter = ''; };
    btn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation(); demoTryOn();
    });

    // Match the store's OWN buy button shape (hard vs round edges, caps, font,
    // height) so it reads native — the brand color stays ours.
    if (atc) matchNativeButton(btn, atc);

    // Place it full-width BELOW the buy area. If the add-to-cart button sits in a
    // horizontal cluster (e.g. LA Apparel's Try + Add-to-Cart + wishlist row),
    // insert after the WHOLE row so we drop onto our own line instead of being
    // squeezed in beside it.
    var target = atc || form;
    try {
      var p = target.parentElement, hop = 0;
      while (p && hop < 3) {
        var st = window.getComputedStyle(p);
        var rowFlex = (st.display === 'flex' || st.display === 'inline-flex') &&
                      (st.flexDirection === 'row' || st.flexDirection === 'row-reverse');
        var grid = (st.display === 'grid' || st.display === 'inline-grid');
        if ((rowFlex || grid) && p.children.length > 1) { target = p; p = p.parentElement; hop++; }
        else break;
      }
    } catch (e) {}
    if (target && target.parentNode) target.parentNode.insertBefore(btn, target.nextSibling);
    else if (form) form.appendChild(btn);

    styleInlineButtons(window.ELLO_STORE_CONFIG);
    log('inline "Try it on" button injected.');
  }

  // Copy a native button's SHAPE + typography onto ours so it matches the theme
  // (square + uppercase on LA Apparel; rounded/soft on others). Color stays ours.
  function matchNativeButton(btn, ref) {
    try {
      var cs = window.getComputedStyle(ref);
      if (cs.borderRadius) btn.style.borderRadius = cs.borderRadius;
      if (cs.textTransform && cs.textTransform !== 'none') btn.style.textTransform = cs.textTransform;
      if (cs.letterSpacing && cs.letterSpacing !== 'normal') btn.style.letterSpacing = cs.letterSpacing;
      if (cs.fontFamily) btn.style.fontFamily = cs.fontFamily;
      if (cs.fontWeight) btn.style.fontWeight = cs.fontWeight;
      if (cs.fontSize) btn.style.fontSize = cs.fontSize;
      var h = parseFloat(cs.height);
      if (h && h > 24) { btn.style.minHeight = Math.round(h) + 'px'; btn.style.paddingTop = '0'; btn.style.paddingBottom = '0'; }
    } catch (e) {}
  }

  // Belt-and-suspenders centering. An id selector (#ello-demo-inline-btn,
  // specificity 1-0-0) + !important outranks a theme's own `button {}` rules,
  // which otherwise override our inline `display:flex` and left-align the
  // icon+label (or add a ::after spinner that offsets them). Injected once,
  // idempotent, re-checked on every (re)inject.
  function ensureInlineBtnStyles() {
    if (document.getElementById('ello-demo-inline-btn-styles')) return;
    var s = document.createElement('style');
    s.id = 'ello-demo-inline-btn-styles';
    s.textContent =
      '#ello-demo-inline-btn{display:flex !important;flex-direction:row !important;align-items:center !important;justify-content:center !important;text-align:center !important;text-indent:0 !important;width:100% !important;box-sizing:border-box !important;gap:8px !important;}' +
      '#ello-demo-inline-btn>span{display:inline-flex !important;align-items:center !important;justify-content:center !important;gap:8px !important;margin:0 auto !important;width:auto !important;max-width:100% !important;transform:none !important;float:none !important;}' +
      '#ello-demo-inline-btn::before,#ello-demo-inline-btn::after{content:none !important;display:none !important;}' +
      '#ello-demo-inline-btn .ello-demo-inline-label{line-height:1.2 !important;}';
    document.head.appendChild(s);
  }

  // Pull the button's color + label from the demo store config once it resolves.
  function styleInlineButtons(cfg) {
    if (!cfg) return;
    var btn = document.getElementById('ello-demo-inline-btn');
    if (!btn) return;
    var color = cfg.inlineButtonColor || cfg.widgetPrimaryColor;
    if (color) btn.style.background = color;
    if (cfg.inlineButtonTextColor) btn.style.color = cfg.inlineButtonTextColor;
    var label = btn.querySelector('.ello-demo-inline-label');
    if (label && cfg.inlineButtonText) label.textContent = cfg.inlineButtonText;
  }

  // Re-inject the button if the theme re-renders the PDP (SPA nav / section reload).
  function watchPdp() {
    try {
      var raf = null;
      var mo = new MutationObserver(function () {
        if (raf) return;
        raf = requestAnimationFrame(function () { raf = null; injectInlineButton(); });
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* no MutationObserver — the one-shot inject still ran */ }
  }

  // ── Tiny, auto-dismissing "demo active" toast (won't sit in the recording) ───
  function toast() {
    try {
      var t = document.createElement('div');
      t.textContent = 'Ello demo active · ' + (IS_LOCAL ? 'local' : 'cloud');
      t.style.cssText = [
        'position:fixed', 'top:14px', 'left:50%', 'transform:translateX(-50%)',
        'z-index:2147483647', 'background:#111', 'color:#fff', 'font:600 12px/1 -apple-system,system-ui,sans-serif',
        'padding:9px 14px', 'border-radius:999px', 'box-shadow:0 6px 20px rgba(0,0,0,.28)',
        'opacity:0', 'transition:opacity .25s ease', 'pointer-events:none'
      ].join(';') + ';';
      document.body.appendChild(t);
      requestAnimationFrame(function () { t.style.opacity = '1'; });
      setTimeout(function () { t.style.opacity = '0'; }, 3200);
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3600);
    } catch (e) {}
  }

  // ── Settings panel (gear ⚙, bottom-left) ─────────────────────────────────────
  var panelSync = function () {};
  function setSetting(k, v) {
    demoSettings[k] = v;
    saveSettings();
    applyDemoConfig(window.ELLO_STORE_CONFIG);
    panelSync();
    log('setting', k, '=', v);
  }
  function buildSettingsPanel() {
    if (document.getElementById('ello-demo-gear')) return;
    var mk = function (tag, css, html) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (html != null) e.innerHTML = html; return e; };

    var panel = mk('div', 'position:fixed;left:18px;bottom:74px;z-index:2147483646;width:274px;max-width:calc(100vw - 36px);background:#fff;color:#111;border-radius:14px;box-shadow:0 14px 44px rgba(0,0,0,.30);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:14px 14px 12px;display:none;');
    panel.id = 'ello-demo-panel';

    var head = mk('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;');
    head.appendChild(mk('div', 'font-weight:700;letter-spacing:.02em;', 'Demo settings'));
    var close = mk('button', 'border:none;background:none;cursor:pointer;font-size:18px;line-height:1;color:#999;padding:0 2px;', '&times;');
    close.onclick = function () { panel.style.display = 'none'; };
    head.appendChild(close);
    panel.appendChild(head);

    // Mode — where the try-on result shows (popup widget vs the PDP hero image).
    panel.appendChild(mk('div', 'font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#888;margin:2px 0 6px;', 'Result shows in'));
    var seg = mk('div', 'display:flex;gap:4px;background:#f1f2f4;border-radius:9px;padding:3px;margin-bottom:12px;');
    var modeBtns = {};
    [['popup', 'Popup widget'], ['mirror', 'PDP image']].forEach(function (m) {
      var b = mk('button', 'flex:1;border:none;background:none;cursor:pointer;font:inherit;font-weight:600;font-size:12px;padding:7px 4px;border-radius:7px;color:#555;', m[1]);
      b.onclick = function () { setSetting('mode', m[0]); };
      modeBtns[m[0]] = b; seg.appendChild(b);
    });
    panel.appendChild(seg);

    // On/off surfaces
    var toggleInputs = {};
    [['launcher', 'Floating launcher'], ['inlineButton', 'Inline “Try on” button'], ['completeTheLook', 'Complete the Look'], ['desktopPreview', 'Desktop preview popup']].forEach(function (t) {
      var row = mk('label', 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;cursor:pointer;');
      row.appendChild(mk('span', 'color:#222;', t[1]));
      var cb = document.createElement('input'); cb.type = 'checkbox';
      cb.style.cssText = 'width:16px;height:16px;accent-color:#2563eb;cursor:pointer;';
      cb.onchange = function () { setSetting(t[0], cb.checked); };
      toggleInputs[t[0]] = cb; row.appendChild(cb);
      panel.appendChild(row);
    });

    // Brand color
    var colorRow = mk('div', 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0 4px;');
    colorRow.appendChild(mk('span', 'color:#222;', 'Brand color'));
    var colorWrap = mk('div', 'display:flex;align-items:center;gap:8px;');
    var colorIn = document.createElement('input'); colorIn.type = 'color';
    colorIn.style.cssText = 'width:30px;height:24px;border:1px solid #ddd;border-radius:5px;background:none;cursor:pointer;padding:0;';
    colorIn.oninput = function () { setSetting('brandColor', colorIn.value); };
    var colorClear = mk('button', 'border:none;background:none;color:#999;cursor:pointer;font-size:11px;text-decoration:underline;', 'reset');
    colorClear.onclick = function () { setSetting('brandColor', ''); };
    colorWrap.appendChild(colorIn); colorWrap.appendChild(colorClear);
    colorRow.appendChild(colorWrap); panel.appendChild(colorRow);

    // Button text
    var textRow = mk('div', 'padding:4px 0 2px;');
    textRow.appendChild(mk('div', 'color:#222;margin-bottom:5px;', 'Button text'));
    var textIn = document.createElement('input'); textIn.type = 'text';
    textIn.style.cssText = 'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #ddd;border-radius:7px;font:inherit;';
    textIn.oninput = function () { setSetting('inlineText', textIn.value); };
    textRow.appendChild(textIn); panel.appendChild(textRow);

    var reset = mk('button', 'width:100%;margin-top:12px;padding:9px;border:1px solid #eee;border-radius:8px;background:#fafafa;color:#666;cursor:pointer;font:inherit;font-size:12px;', 'Reset to store defaults');
    reset.onclick = function () { demoSettings = Object.assign({}, DEMO_DEFAULTS); saveSettings(); applyDemoConfig(window.ELLO_STORE_CONFIG); panelSync(); };
    panel.appendChild(reset);

    var gear = mk('button', 'position:fixed;left:18px;bottom:18px;z-index:2147483646;width:46px;height:46px;border-radius:50%;border:none;cursor:pointer;background:#111;box-shadow:0 4px 16px rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;',
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>');
    gear.id = 'ello-demo-gear';
    gear.title = 'Ello demo settings';
    gear.onclick = function () { panel.style.display = (panel.style.display === 'none') ? 'block' : 'none'; };

    // Reflect demoSettings into the controls.
    panelSync = function () {
      Object.keys(modeBtns).forEach(function (m) {
        var on = demoSettings.mode === m;
        modeBtns[m].style.background = on ? '#fff' : 'none';
        modeBtns[m].style.color = on ? '#111' : '#555';
        modeBtns[m].style.boxShadow = on ? '0 1px 2px rgba(0,0,0,.14)' : 'none';
      });
      Object.keys(toggleInputs).forEach(function (k) { toggleInputs[k].checked = !!demoSettings[k]; });
      colorIn.value = demoSettings.brandColor || (demoOrig && demoOrig.ic) || '#2563eb';
      if (document.activeElement !== textIn) textIn.value = demoSettings.inlineText || '';
      textIn.placeholder = (demoOrig && demoOrig.it) || 'Try it on';
    };
    panelSync();

    (document.body || document.documentElement).appendChild(panel);
    (document.body || document.documentElement).appendChild(gear);
    log('settings panel ready (gear ⚙ bottom-left).');
  }

  // ── Console control surface ──────────────────────────────────────────────────
  window.__elloDemo = {
    origin: BASE,
    local: IS_LOCAL,
    store: DEMO,
    tryOn: demoTryOn,          // fire a try-on for the current PDP product
    open: demoOpen,            // open the full fitting room
    ctx: currentProductCtx,    // inspect what product data we read off the page
    settings: function () { return demoSettings; },  // current demo settings
    set: setSetting,           // change a setting live, e.g. __elloDemo.set('mode','mirror')
    pairWith: function (handleOrUrl) { // pin the Complete-the-Look offer to a product, e.g. __elloDemo.pairWith('enhance-seamless-shorts-black')
      var h = String(handleOrUrl || '').trim();
      var m = h.match(/\/products\/([^\/?#]+)/); if (m) h = decodeURIComponent(m[1]); // accept a full product URL too
      demoSettings.ctlPairHandle = h; saveSettings(); applyCtlPair();
      log('Complete-the-Look pinned to', h || '(cleared)');
      return h;
    },
    clearPair: function () { demoSettings.ctlPairHandle = ''; saveSettings(); applyCtlPair(); log('Complete-the-Look pin cleared'); },
    reset: function () {       // undo demo mode for this tab
      try { localStorage.removeItem('ello_dev_origin'); localStorage.removeItem(SETTINGS_KEY); } catch (e) {}
      window.__ELLO_DEMO__ = false;
      window.__ELLO_DEMO_BOOTED__ = false;
      var b = document.getElementById('ello-demo-inline-btn'); if (b) b.remove();
      var g = document.getElementById('ello-demo-gear'); if (g) g.remove();
      var p = document.getElementById('ello-demo-panel'); if (p) p.remove();
      log('demo reset — reload the page for a clean state.');
    }
  };

  // ── Go ───────────────────────────────────────────────────────────────────────
  injectLoader();
  function onReady() { injectInlineButton(); watchPdp(); watchVariant(); buildSettingsPanel(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
  toast();
  log('ready. Gear ⚙ (bottom-left) = settings. Console: window.__elloDemo (tryOn / open / set / pairWith / clearPair / reset)');
})();
