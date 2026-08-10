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
 *      NOT-SHOPIFY STORES: none of that detection can fire (it is all guarded on a
 *      /products/ URL), so the widget used to try on the DEMO store's own featured
 *      product and the PDP swap never ran. There the rep CLICKS the product photo
 *      once — it becomes both the garment and the image the result lands on. See
 *      "NON-SHOPIFY PROSPECTS" below.
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
  // Key is versioned: bumping it retires every rep's saved prefs so a changed
  // default (v2: mirror) actually reaches them instead of being masked by the
  // settings they already have in localStorage.
  var SETTINGS_KEY = 'ello_demo_settings_v2';
  var DEMO_DEFAULTS = {
    mode: 'mirror',         // 'popup' | 'mirror' — default: result lands on the PDP photo
    launcher: true,         // floating launcher bubble visible
    inlineButton: true,     // native "Try it on" button by Add-to-Cart
    desktopPreview: false,  // desktop peek popup (off so it can't interrupt a recording)
    completeTheLook: true,  // outfit-upsell rail
    brandColor: '',         // '' = use the demo store's configured color
    inlineText: '',         // '' = use the demo store's configured button text
    ctlPairHandle: '',      // pin the Complete-the-Look suggestion to this product handle (demo scripting)
    pdpSelector: '',        // CSS selector of the image mirror mode replaces ('' = widget auto-detects)
    btnAnchorSelector: '',  // CSS selector the inline button is placed AFTER ('' = auto: below Add-to-Cart)
    forceHostProduct: false // treat the picked photo as the garment even on /products/ URLs (non-Shopify store that fakes them)
  };
  function loadSettings() {
    try { return Object.assign({}, DEMO_DEFAULTS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); }
    catch (e) { return Object.assign({}, DEMO_DEFAULTS); }
  }
  function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(demoSettings)); } catch (e) {} }
  var demoSettings = loadSettings();
  var demoOrig = null; // the demo store's own colors/text, captured on first resolve

  // Non-Shopify prospect stores: the product photo the rep clicked, standing in
  // for everything Shopify would have told us. Declared up here (not down with
  // the logic that fills it) so the re-run guard below can safely reach code
  // that reads it. See "NON-SHOPIFY PROSPECTS" further down.
  var hostState = { product: null, imgSrc: null, handle: null, el: null };
  var __hostPrev = { product: null, urlHandle: null };

  // Publish the pinned Complete-the-Look handle to the widget (read in demo mode
  // by elloPickComplementary → elloDemoPinnedComplementary). null when unset so
  // the recommender falls back to curated → category-guess as normal.
  function applyCtlPair() { window.__ELLO_DEMO_CTL_HANDLE__ = (demoSettings.ctlPairHandle || '').trim() || null; }
  applyCtlPair();

  // Re-run guard: allow a second bookmarklet press to re-open the widget instead
  // of double-injecting the loader. It sits BELOW the settings block on purpose —
  // demoOpen() can fall through to demoTryOn(), which reads demoSettings and the
  // host-product state, and every line above it is pure, idempotent setup.
  if (window.__ELLO_DEMO_BOOTED__) {
    log('already active — re-opening.');
    demoOpen();
    return;
  }
  window.__ELLO_DEMO_BOOTED__ = true;

  // A rep picks the upsell by pasting the product's URL from the store they're
  // already browsing — no product id, no console. Everything after /products/ is
  // the handle, which is the only thing widget-main.js needs. A bare handle and a
  // handle with query junk (?variant=…&utm_…) both come out clean.
  function handleFromInput(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    var m = s.match(/\/products\/([^\/?#\s]+)/);
    if (m) return decodeURIComponent(m[1]);
    if (/^https?:\/\//i.test(s)) {
      try {
        var parts = new URL(s).pathname.split('/').filter(Boolean);
        return decodeURIComponent(parts[parts.length - 1] || '');
      } catch (e) { return ''; }
    }
    return s.replace(/^\/+|\/+$/g, '').split(/[?#]/)[0];
  }

  // Confirm the pasted product actually resolves ON THIS STORE, so a rep sees
  // "✓ <product name>" before they hit record instead of finding out mid-demo
  // that the rail fell back to a guess. Same two paths widget-main.js uses to
  // build the pinned offer: /products/<handle>.js, then the PDP's own JSON-LD
  // (headless stores 404 the .js route but still render the PDP).
  function lookupPairProduct(handle) {
    return fetch('/products/' + encodeURIComponent(handle) + '.js', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.title) return { title: j.title };
        return fetch('/products/' + encodeURIComponent(handle), { credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.text() : ''; })
          .then(function (html) {
            if (!html) return null;
            // DOMParser does not execute scripts — parsing their page is inert.
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var nodes = doc.querySelectorAll('script[type="application/ld+json"]');
            for (var i = 0; i < nodes.length; i++) {
              var d; try { d = JSON.parse(nodes[i].textContent || 'null'); } catch (e) { continue; }
              var list = Array.isArray(d) ? d : (d && Array.isArray(d['@graph']) ? d['@graph'] : [d]);
              for (var k = 0; k < list.length; k++) {
                var n = list[k]; if (!n || typeof n !== 'object') continue;
                var ty = n['@type']; var types = Array.isArray(ty) ? ty : [ty];
                if ((types.indexOf('Product') !== -1 || types.indexOf('ProductGroup') !== -1) && n.name) {
                  return { title: String(n.name) };
                }
              }
            }
            var og = doc.querySelector('meta[property="og:title"]');
            var t = og && og.getAttribute('content');
            return t ? { title: String(t) } : null;
          }).catch(function () { return null; });
      })
      .catch(function () { return null; });
  }

  // ── Auto brand color: sample the prospect's OWN buy button ───────────────────
  // A rep should never have to eyedropper a hex mid-demo. A store's add-to-cart
  // button IS its brand color, and we already resolve that exact button for the
  // inline "Try it on" placement — so read the color off it and use it for the
  // bubble, the popup accent and our button. '' in demoSettings.brandColor means
  // "auto"; a rep picking a color by hand still wins.
  var detectedBrandColor = null;

  function elloRgbToHex(str) {
    var s = String(str || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(s)) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    var m = s.match(/rgba?\(([^)]+)\)/i);
    if (!m) return null;
    var p = m[1].split(',').map(function (x) { return parseFloat(x); });
    if (p.length < 3 || p.slice(0, 3).some(isNaN)) return null;
    if (p.length > 3 && !isNaN(p[3]) && p[3] < 0.25) return null; // effectively transparent
    return '#' + p.slice(0, 3).map(function (n) {
      return ('0' + Math.max(0, Math.min(255, Math.round(n))).toString(16)).slice(-2);
    }).join('');
  }
  function elloLuminance(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length !== 6) return 1;
    var r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function detectStoreBrandColor() {
    try {
      var atc = elloCachedAtc();
      if (!atc) return null;
      // Themes paint the fill on the <button> itself OR on an inner <span>, so
      // check both before deciding the button has no fill of its own.
      var els = [atc].concat(Array.prototype.slice.call(atc.querySelectorAll('span,div'), 0, 3));
      for (var i = 0; i < els.length; i++) {
        var bg = elloRgbToHex(window.getComputedStyle(els[i]).backgroundColor);
        if (bg && elloLuminance(bg) < 0.88) return bg; // a real, non-white fill
      }
      // Outline / white buy button (LA Apparel's black-on-white): the brand is
      // the INK, not the fill. Matching the fill would render us white-on-white.
      var cs = window.getComputedStyle(atc);
      var ink = elloRgbToHex(cs.color) || elloRgbToHex(cs.borderTopColor || cs.borderColor);
      if (ink && elloLuminance(ink) < 0.88) return ink;
    } catch (e) {}
    return null;
  }
  // The color actually in force: a rep's manual pick beats the detected one.
  function effectiveBrandColor() {
    return demoSettings.brandColor || detectedBrandColor || '';
  }
  // Detect once, then push it through the same path a manual pick takes. Called
  // from injectInlineButton (the moment the buy button exists) and onReady.
  function refreshBrandColor() {
    if (detectedBrandColor) return detectedBrandColor;
    var c = detectStoreBrandColor();
    if (!c) return null;
    detectedBrandColor = c;
    log('brand color matched to this store\'s buy button:', c);
    applyDemoConfig(window.ELLO_STORE_CONFIG);
    panelSync();
    return c;
  }

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
    var c = effectiveBrandColor();
    if (c) w.style.setProperty('--minimized-bg', c);
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
    // Which image the mirror-mode result replaces. A rep's on-page pick rides the
    // SAME pdpImageSelector override a real merchant sets in Widget design, and
    // widget-main.js consults it before any auto-detection — so this works with
    // the already-deployed widget. Always overwrite: any selector saved on the
    // DEMO store's config describes the dev store's theme, never the prospect's.
    cfg.pdpImageSelector = (demoSettings.pdpSelector || '').trim() || null;
    // Capture the store's own color/text once so "clear" can restore them exactly.
    if (!demoOrig) demoOrig = { pc: cfg.widgetPrimaryColor, mc: cfg.minimizedColor, ic: cfg.inlineButtonColor, it: cfg.inlineButtonText };
    var brand = effectiveBrandColor();   // manual pick > this store's buy button > demo store's own
    cfg.widgetPrimaryColor = brand || demoOrig.pc;
    cfg.minimizedColor     = brand || demoOrig.mc;
    cfg.inlineButtonColor  = brand || demoOrig.ic;
    cfg.inlineButtonText   = demoSettings.inlineText || demoOrig.it;
    // Keep the label readable on whatever we matched (a bright brand yellow
    // would swallow the default white text).
    if (brand) cfg.inlineButtonTextColor = elloLuminance(brand) > 0.6 ? '#111111' : '#ffffff';

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
    // A picked product photo IS the proof this is a PDP. Custom (non-Shopify)
    // storefronts ship neither /products/ URLs nor product structured data, so
    // without this the inline button never injects on the very stores the
    // photo-pick exists to rescue.
    if (hostState.product) return true;
    if (/\/products\//.test(window.location.pathname)) return true;
    // Non-Shopify PDPs (e.g. Arc'teryx /us/en/shop/womens/<handle>, other SFCC/
    // custom stacks) don't use /products/. Recognize them by product structured
    // data instead — Product/ProductGroup JSON-LD or og:type=product. Collection
    // and home pages carry BreadcrumbList/ItemList, not Product, so no false hit.
    try {
      var og = document.querySelector('meta[property="og:type"]');
      if (og && /product/i.test(og.content || '')) return true;
      var lds = document.querySelectorAll('script[type="application/ld+json"]');
      for (var i = 0; i < lds.length; i++) {
        var raw = lds[i].textContent; if (!raw) continue;
        var node; try { node = JSON.parse(raw); } catch (e) { continue; }
        var arr = Array.isArray(node) ? node : (node['@graph'] || [node]);
        for (var j = 0; j < arr.length; j++) {
          var t = arr[j] && arr[j]['@type'];
          t = Array.isArray(t) ? t.join(' ') : String(t || '');
          if (/\bProduct(Group)?\b/.test(t)) return true;
        }
      }
    } catch (e) {}
    return false;
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
    // Always overwrite — colors WITHOUT their own variant image (HAUS Smoke
    // Green) must CLEAR a previous color's image, or the widget would show the
    // stale color. null = "selected variant has no image of its own".
    window.__ELLO_DEMO_VARIANT_IMG__ = src || null;
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
    ctx.productHandle = currentHandle() || (hostState.product ? hostState.handle : null);
    var p = window.ShopifyAnalytics && window.ShopifyAnalytics.meta && window.ShopifyAnalytics.meta.product;
    if (p && p.id) ctx.productId = String(p.id);
    var vid = window.__ELLO_DEMO_VARIANT_ID__ || null;
    if (!vid) { try { vid = new URLSearchParams(location.search).get('variant'); } catch (e) {} }
    if (!vid) { var i = document.querySelector('form[action*="/cart/add"] [name="id"]'); if (i && /^\d+$/.test(String(i.value))) vid = i.value; }
    if (!vid && p && Array.isArray(p.variants) && p.variants[0]) vid = String(p.variants[0].id);
    if (vid) ctx.variantId = String(vid);
    return ctx;
  }

  // ── NON-SHOPIFY PROSPECTS: the photo on the page IS the garment ─────────────
  // Everything above assumes Shopify. currentHandle() reads /products/<handle>,
  // and widget-main.js's detectCurrentProduct() resolves the garment from the
  // synced catalog, ShopifyAnalytics, the /cart/add form's og:image, or JSON-LD —
  // every one of those paths is guarded on a /products/ URL. On a store built on
  // anything else (custom stacks, Magento, headless one-offs) they ALL return
  // nothing, and populateFeaturedAndQuickPicks falls back to the DEMO store's
  // configured featured item — which is why Andrew watched the dev store's blue
  // romper get tried on instead of the prospect's product (2026-07-28).
  //
  // The PDP swap died the same way, one layer down: elloPdpSwapOn() bails on
  // `getProductIdFromUrl(pathname) == null` BEFORE it ever looks at
  // pdpImageSelector, so picking a swap target changed nothing — the result
  // still rendered inside the popup.
  //
  // Fix: let the rep CLICK the product photo. That single click supplies both
  // missing halves — the garment sent to the AI, and the image the result lands
  // on — through the platform hooks widget-main.js ALREADY reads for SFCC
  // (ELLO_PLATFORM_PRODUCT / ELLO_PLATFORM_URL_HANDLE, live in the deployed
  // widget since 2026-07-24). No widget deploy needed: only this file changes.
  // (hostState / __hostPrev are declared up with the settings block.)

  // Host mode is for pages where the Shopify path cannot work at all. A rep can
  // force it (⚙ panel / __elloDemo.useThisPhoto) for the odd non-Shopify store
  // that still uses /products/ URLs and therefore fools currentHandle().
  function hostModeApplies() {
    return !currentHandle() || demoSettings.forceHostProduct === true;
  }

  // A real platform adapter (ello-sfcc.js) that already resolved this page's
  // product beats anything we can build from a click — don't ask for a pick.
  // Checks the LIVE global as well as our captured delegate: SFCC stores have no
  // /products/ URLs either, so before we've installed anything the live hook is
  // the only place that answer lives — and missing it would mean interrupting a
  // Boot Barn / PacSun demo to ask for a photo it already had.
  function platformProductResolved() {
    var fns = [];
    if (typeof window.ELLO_PLATFORM_PRODUCT === 'function' && window.ELLO_PLATFORM_PRODUCT !== hostProductHook) {
      fns.push(window.ELLO_PLATFORM_PRODUCT);
    }
    if (typeof __hostPrev.product === 'function') fns.push(__hostPrev.product);
    for (var i = 0; i < fns.length; i++) {
      try { var p = fns[i](); if (p && p.image_url) return true; } catch (e) {}
    }
    return false;
  }

  function elloDemoAbsUrl(u) {
    var s = String(u || '').trim();
    // data:/blob: are lazy-loader placeholders (the 1×1 transparent gif) or a
    // try-on result already painted onto the hero — never a garment.
    if (!s || s.indexOf('data:') === 0 || s.indexOf('blob:') === 0) return null;
    if (s.indexOf('//') === 0) return 'https:' + s;
    try { return new URL(s, window.location.href).href; } catch (e) { return null; }
  }
  // Biggest candidate in a srcset. The render engine reads this file, so pixels
  // matter: the browser may have painted a 400px rendition on a laptop while the
  // same srcset offers 2000px.
  function elloDemoSrcsetBest(ss) {
    var best = null, bestW = -1;
    String(ss || '').split(',').forEach(function (part) {
      var bits = part.trim().split(/\s+/);
      if (!bits[0]) return;
      var d = bits[1] || '';
      var mw = d.match(/^(\d+(?:\.\d+)?)w$/), mx = d.match(/^(\d+(?:\.\d+)?)x$/);
      var w = mw ? parseFloat(mw[1]) : (mx ? parseFloat(mx[1]) * 1000 : 0);
      if (w > bestW) { bestW = w; best = bits[0]; }
    });
    return best;
  }
  // The usable URL behind whatever the rep clicked: <img> (incl. <picture> and
  // every common lazy-load attribute) or an element painted with a CSS
  // background-image, which is how plenty of custom galleries render the hero.
  function elloDemoImgSrc(el) {
    if (!el) return null;
    var cands = [];
    try {
      if (el.tagName === 'IMG') {
        cands.push(elloDemoSrcsetBest(el.getAttribute('srcset') || el.getAttribute('data-srcset')));
        var pic = el.parentElement;
        if (pic && pic.tagName === 'PICTURE') {
          var srcs = pic.querySelectorAll('source[srcset]');
          for (var i = 0; i < srcs.length; i++) cands.push(elloDemoSrcsetBest(srcs[i].getAttribute('srcset')));
        }
        cands.push(el.currentSrc || null);
        ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-zoom-src', 'data-large_image', 'data-image'].forEach(function (a) {
          cands.push(el.getAttribute(a));
        });
      } else {
        // A wrapper around a real <img> answers best; a genuinely image-less
        // element falls back to whatever it's painted with.
        var inner = el.querySelector && el.querySelector('img');
        if (inner) { var innerSrc = elloDemoImgSrc(inner); if (innerSrc) return innerSrc; }
        var bg = window.getComputedStyle(el).backgroundImage || '';
        var m = bg.match(/url\((['"]?)(.*?)\1\)/);
        if (m) cands.push(m[2]);
      }
    } catch (e) {}
    for (var k = 0; k < cands.length; k++) {
      var abs = elloDemoAbsUrl(cands[k]);
      if (abs) return abs;
    }
    return null;
  }

  // The product's NAME drives the render prompt (build_tryon_prompt) and lets
  // widget-main upgrade "clothing" to shoes/accessories on its own, so it's
  // worth reading properly rather than defaulting to the tab title.
  function elloDemoPageTitle() {
    var t = null;
    try {
      var og = document.querySelector('meta[property="og:title"]');
      t = (og && og.getAttribute('content')) || null;
      if (!t) {
        var nodes = document.querySelectorAll('script[type="application/ld+json"]');
        for (var i = 0; i < nodes.length && !t; i++) {
          var d; try { d = JSON.parse(nodes[i].textContent || 'null'); } catch (e) { continue; }
          if (!d) continue;
          var list = Array.isArray(d) ? d : (Array.isArray(d['@graph']) ? d['@graph'] : [d]);
          for (var k = 0; k < list.length; k++) {
            var n = list[k]; if (!n || typeof n !== 'object') continue;
            var ty = n['@type']; var types = Array.isArray(ty) ? ty : [ty];
            if ((types.indexOf('Product') !== -1 || types.indexOf('ProductGroup') !== -1) && n.name) { t = String(n.name); break; }
          }
        }
      }
      if (!t) { var h1 = document.querySelector('h1'); t = h1 && (h1.textContent || '').trim(); }
      if (!t) t = (document.title || '').split(/[|–—·]/)[0];
    } catch (e) {}
    t = String(t || '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 120) || 'This product';
  }

  // A stable id for this page's product. It MUST be the same string
  // ELLO_PLATFORM_URL_HANDLE answers with, because widget-main.js's swap guard
  // compares elloSelectedGarment.id against it before it will touch the hero
  // (widget-main.js:7926). Derived from the path, so it survives re-renders.
  function elloDemoHostHandle() {
    var h = '';
    try {
      var parts = window.location.pathname.split('/').filter(Boolean);
      h = decodeURIComponent(parts[parts.length - 1] || '');
      h = h.replace(/\.(html?|php|aspx?)$/i, '');
    } catch (e) {}
    h = h.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return h || 'ello-demo-product';
  }
  function elloDemoPagePrice() {
    try {
      var m = document.querySelector('meta[property="product:price:amount"],meta[property="og:price:amount"]');
      var v = m && parseFloat(m.getAttribute('content'));
      if (v && !isNaN(v)) return v;
    } catch (e) {}
    return null;   // null → widget-main scrapes the price off the DOM itself
  }

  function buildHostProduct(src, handle) {
    var name = elloDemoPageTitle();
    return {
      id: handle,
      handle: handle,
      name: name,
      title: name,
      image_url: src,
      featured_image: { src: src },
      variants: [],
      // 'clothing' + isFallback is what lets elloResolveTryonProductType re-read
      // the title and promote the prompt to shoes/accessories by itself.
      category: 'clothing',
      product_url: window.location.href,
      price: elloDemoPagePrice(),
      isFallback: true,
      isPlatform: 'demo-host'
    };
  }

  // ── Platform hooks (the same two ello-sfcc.js registers) ────────────────────
  function hostProductHook() {
    if (hostState.product) return hostState.product;
    try { return (typeof __hostPrev.product === 'function') ? __hostPrev.product() : null; } catch (e) { return null; }
  }
  function hostUrlHandleHook(url) {
    if (hostState.product && hostState.handle) {
      try {
        var path = /^https?:/i.test(url) ? new URL(url).pathname : String(url).split(/[?#]/)[0];
        if (path === window.location.pathname) return hostState.handle;   // this page only
      } catch (e) {}
    }
    try { return (typeof __hostPrev.urlHandle === 'function') ? __hostPrev.urlHandle(url) : null; } catch (e) { return null; }
  }
  // (Re)install, keeping whatever was already there as the delegate. The SFCC
  // adapter is injected async and assigns these unconditionally, so it can land
  // AFTER us; re-asserting on the existing 1.5s tick keeps the rep's explicit
  // pick on top without ever hiding a real adapter's answer.
  function ensureHostHooks() {
    if (window.ELLO_PLATFORM_PRODUCT !== hostProductHook) {
      if (typeof window.ELLO_PLATFORM_PRODUCT === 'function') __hostPrev.product = window.ELLO_PLATFORM_PRODUCT;
      window.ELLO_PLATFORM_PRODUCT = hostProductHook;
    }
    if (window.ELLO_PLATFORM_URL_HANDLE !== hostUrlHandleHook) {
      if (typeof window.ELLO_PLATFORM_URL_HANDLE === 'function') __hostPrev.urlHandle = window.ELLO_PLATFORM_URL_HANDLE;
      window.ELLO_PLATFORM_URL_HANDLE = hostUrlHandleHook;
    }
  }

  // Point the widget's live state at the picked photo.
  function hostSyncWidgetGlobals() {
    if (!hostState.product) return;
    try {
      // Variant ids are Shopify-only and go stale the moment a rep moves to
      // another store; a leftover one would let elloApplyColorCorrectGarment
      // repaint the garment away from the photo just picked. The IMG global is
      // the one widget-main trusts in demo mode (widget-main.js:8888).
      window.__ELLO_DEMO_VARIANT_ID__ = null;
      window.ELLO_PRESELECTED_VARIANT_ID = null;
      window.__ELLO_DEMO_VARIANT_IMG__ = hostState.imgSrc || null;
      if (window.ELLO_INLINE_CTX) window.ELLO_INLINE_CTX.variantId = null;
    } catch (e) {}
    try {
      // The widget may already have latched the demo store's featured item for
      // this pageview (that IS the blue romper). Re-seed the selection so this
      // try-on — and the swap guard, which compares garment.id to the handle —
      // both resolve to the product on screen.
      var g = window.elloSelectedGarment;
      if (!g || g.id !== hostState.handle) {
        var seed = {};
        for (var k in hostState.product) {
          if (Object.prototype.hasOwnProperty.call(hostState.product, k)) seed[k] = hostState.product[k];
        }
        seed.selectedVariantId = null;
        seed.__elloBaseImg = hostState.imgSrc;
        window.elloSelectedGarment = seed;
      } else {
        g.image_url = hostState.imgSrc;
        g.__elloBaseImg = hostState.imgSrc;
      }
    } catch (e) {}
  }

  function adoptHostImage(el) {
    if (!hostModeApplies()) return null;      // real Shopify PDP — its own detection is better
    var src = elloDemoImgSrc(el);
    if (!src) return null;
    hostState.el = el;
    hostState.imgSrc = src;
    hostState.handle = elloDemoHostHandle();
    hostState.product = buildHostProduct(src, hostState.handle);
    ensureHostHooks();
    hostSyncWidgetGlobals();
    log('garment = the photo you picked:', hostState.product.title, src);
    if (el.tagName !== 'IMG') {
      log('heads up: that\'s a CSS background image, so the try-on will use it but the result lands on the auto-detected hero.');
    }
    return hostState.product;
  }

  function resetHostProduct() {
    hostState = { product: null, imgSrc: null, handle: null, el: null };
    try { window.__ELLO_DEMO_VARIANT_IMG__ = null; } catch (e) {}
  }

  // Re-resolve the picked photo for whatever page we're on NOW, so one pick per
  // store keeps working as the rep walks the catalog: the saved selector is the
  // same on every PDP of a template, only the src behind it changes. Also how a
  // color swatch click follows through to the garment on these stores — there's
  // no variant JSON to read, but the hero's src changes and we re-read it.
  function refreshHostProduct(opts) {
    if (!hostModeApplies()) { if (hostState.product) resetHostProduct(); return null; }
    // Never re-read the hero while a render is in flight — mid-swap it holds a
    // loading state, and afterwards the try-on RESULT itself.
    if (opts && opts.idle && window.__elloPdpSwapActive === true) return hostState.product;
    var el = null;
    var sel = (demoSettings.pdpSelector || '').trim();
    if (sel) {
      var node = null; try { node = document.querySelector(sel); } catch (e) {}
      if (node) el = (node.tagName === 'IMG') ? node : ((node.querySelector && node.querySelector('img')) || node);
    }
    if (!el && hostState.el && hostState.el.isConnected) el = hostState.el;
    var pageHandle = elloDemoHostHandle();
    if (!el) {
      // Walked to a page the saved pick doesn't resolve on → drop the stale
      // product rather than try on the LAST page's photo.
      if (hostState.product && hostState.handle !== pageHandle) resetHostProduct();
      return hostState.product;
    }
    var src = elloDemoImgSrc(el);
    if (!src) return hostState.product;
    if (hostState.product && hostState.imgSrc === src && hostState.handle === pageHandle) return hostState.product;
    return adoptHostImage(el);
  }

  // Does the rep still need to point at the product photo? Only when nothing
  // else on this page can answer: not a Shopify PDP, no platform adapter, and
  // no saved pick that resolves here.
  function hostPickNeeded() {
    if (!hostModeApplies()) return false;
    if (hostState.product) return false;
    if (platformProductResolved()) return false;
    return true;
  }

  // The click IS the upload: there's no product data to read on this store, so
  // ask for the one thing only a human can point at — then fire immediately.
  function promptHostPick() {
    log('this store isn\'t Shopify — click the product photo and it becomes the garment.');
    startPickImage(function (el) {
      if (!el) return;                     // Esc — nothing changed, no render spent
      if (!commitPickedImage(el)) {
        toast('Couldn\'t read that image — try clicking directly on the photo', 4200);
        return;
      }
      syncDemoVariant().then(function () { fireTryOn(currentProductCtx()); });
    }, 'This store isn’t Shopify — click the product photo to try it on');
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
    // Non-Shopify store with nothing to read: intercept BEFORE spending a render
    // on the demo store's fallback product, and ask for the photo instead.
    refreshHostProduct();
    if (hostPickNeeded()) { promptHostPick(); return; }
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
        // `innerText` forces a synchronous reflow on EVERY element it touches. A
        // React PDP has ~90 buttons (gymshark.com 2026-07-24), so sweeping them
        // with innerText once per mutation was a full layout storm per pass.
        // `textContent` needs no layout — pre-filter with it, and only pay for
        // innerText on the handful that could plausibly be the buy button.
        var raw = el.textContent || el.value || '';
        if (raw.length > 40 || !/add to (cart|bag|basket)/i.test(raw)) return;
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

  // ── React/Vue storefronts: don't get into a render war ───────────────────────
  // On a Liquid theme the PDP DOM is static, so "re-inject the button whenever
  // the DOM changes" is free. On a REACT storefront it is not: Gymshark is
  // Next.js and every one of its 100 <img> nodes is React-owned. Inserting our
  // button into a React-managed parent means React can strip it on its next
  // reconcile → our observer re-inserts → that's a fresh mutation → React
  // reconciles again. Each pass re-creates the gallery's <img> nodes, the
  // browser re-decodes them, and every image on the page flashes white. Moving
  // the cursor drives it because hover handlers push React state updates
  // (Andrew, gymshark.com 2026-07-24).
  //
  // Three brakes, escalating only as far as a given store forces us:
  //   1. Never react to our OWN writes (kills the self-sustaining half).
  //   2. Hard floor between placements + a burst detector (bounds the rest).
  //   3. If a store still strips the button, move it to a body-level host that
  //      the page's renderer does not own, positioned over the buy box. React
  //      cannot remove what it never rendered, so the loop cannot restart.
  var INJECT_MIN_GAP_MS = 350;        // never re-place more often than this
  var INJECT_BURST = 6;               // this many placements in…
  var INJECT_BURST_WINDOW_MS = 4000;  // …this window == the page is fighting us
  var __elloSelfMutating = false;
  var __injectAttempts = [];
  var __overlayMode = false;
  var __placedParent = null;                    // element the button was last inserted into
  var __retargetObserver = function () {};      // wired up by watchPdp

  // Mark a DOM write as OURS. MutationObserver callbacks are delivered as
  // microtasks at the end of the current task, so a macrotask (setTimeout 0)
  // clears the flag strictly AFTER the observer has seen our own records.
  function elloSelfMutate(fn) {
    __elloSelfMutating = true;
    try { return fn(); }
    finally { setTimeout(function () { __elloSelfMutating = false; }, 0); }
  }

  // Resolving the buy button walks every button on the page. Cache it and only
  // re-resolve when the cached node actually goes away or off-screen.
  var __atcCache = null;
  function elloCachedAtc() {
    if (__atcCache && __atcCache.isConnected && elloIsVisible(__atcCache)) return __atcCache;
    __atcCache = elloPickVisibleAtc();
    return __atcCache;
  }

  // The rep's hand-picked placement anchor (gear panel "Place on page"), when it
  // resolves on THIS page and is visible. Null falls back to the automatic
  // below-Add-to-Cart flow, so a selector from another template can't strand the
  // button off-screen or nowhere.
  function elloCustomBtnAnchor() {
    var sel = (demoSettings.btnAnchorSelector || '').trim();
    if (!sel) return null;
    var node; try { node = document.querySelector(sel); } catch (e) { return null; }
    if (!node || !elloIsVisible(node)) return null;
    return node;
  }
  // What the button visually keys off: the picked anchor beats the buy button.
  // Overlay mode tracks this same ref, so a custom-placed button that a React
  // storefront strips still re-pins under the PICKED spot, not under the ATC.
  function elloBtnPlacementRef() { return elloCustomBtnAnchor() || elloCachedAtc(); }

  function elloNoteInjection() {
    var now = Date.now();
    __injectAttempts.push(now);
    __injectAttempts = __injectAttempts.filter(function (t) { return now - t < INJECT_BURST_WINDOW_MS; });
    return __injectAttempts.length;
  }

  // ── Overlay placement (last resort, engages itself) ──────────────────────────
  // The button lives in a <div> appended to <body>, absolutely positioned in
  // document coordinates just under the store's own buy button. Visually it
  // still reads as part of the buy box; structurally it is outside the app's
  // component tree, so no reconcile can touch it.
  var __overlayRaf = null;
  var __overlayRectKey = '';
  function elloOverlayHost() {
    var host = document.getElementById('ello-demo-overlay-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'ello-demo-overlay-host';
      host.style.cssText = 'position:absolute;top:0;left:0;z-index:2147483000;';
      (document.body || document.documentElement).appendChild(host);
    }
    return host;
  }
  // Size and place the HOST, not the button. ensureInlineBtnStyles() pins the
  // button at `width:100% !important`, so sizing the button directly would lose
  // to it — inside a correctly-sized host that same rule does exactly what we
  // want, and the button keeps the native shape matchNativeButton gave it.
  function positionOverlayButton() {
    var btn = document.getElementById('ello-demo-inline-btn');
    var atc = elloBtnPlacementRef();
    if (!btn || !atc) return;
    var r = atc.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    var host = elloOverlayHost();
    host.style.left = (r.left + window.pageXOffset) + 'px';
    host.style.top = (r.bottom + window.pageYOffset + 10) + 'px';
    host.style.width = r.width + 'px';
    btn.style.margin = '0';
  }
  function startOverlayTracking() {
    if (__overlayRaf) return;
    var tick = function () {
      var atc = elloBtnPlacementRef();
      if (atc) {
        var r = atc.getBoundingClientRect();
        // Read every frame (cheap, one element); WRITE only when it actually
        // moved, so tracking never becomes the jank it exists to avoid.
        var key = Math.round(r.left) + ',' + Math.round(r.bottom) + ',' + Math.round(r.width);
        if (key !== __overlayRectKey) { __overlayRectKey = key; elloSelfMutate(positionOverlayButton); }
      }
      __overlayRaf = requestAnimationFrame(tick);
    };
    __overlayRaf = requestAnimationFrame(tick);
  }
  function enterOverlayMode() {
    if (__overlayMode) return;
    __overlayMode = true;
    log('this store re-renders our button away — switching to overlay placement (no more flicker).');
    var btn = document.getElementById('ello-demo-inline-btn');
    if (btn) elloSelfMutate(function () { elloOverlayHost().appendChild(btn); });
    elloSelfMutate(positionOverlayButton);
    startOverlayTracking();
  }

  // ── Native-looking inline "Try it on" button next to Add-to-Cart (PDP only) ──
  var __lastInjectAt = 0;
  var __injectRetry = null;
  function injectInlineButton() {
    if (!onPdp()) return;

    // CHEAP EXIT FIRST. This used to sit *below* the add-to-cart resolution, so
    // every observer pass paid for a full button sweep even when the button was
    // already sitting there perfectly. In overlay mode the tracker owns the
    // position, so a mounted button is always "placed".
    var existing = document.getElementById('ello-demo-inline-btn');
    if (existing && (__overlayMode ? existing.isConnected : existing.offsetParent !== null)) return;

    // Hard floor between placements. Without it a store that strips the button
    // gets us re-placing at frame rate.
    var now = Date.now();
    if (now - __lastInjectAt < INJECT_MIN_GAP_MS) {
      // Re-arm rather than drop. A dropped pass leaves a stripped button missing
      // until the 1.5s safety net comes round, which both looks bad on camera
      // and starves the burst detector so overlay mode never engages.
      if (!__injectRetry) {
        __injectRetry = setTimeout(function () {
          __injectRetry = null; injectInlineButton();
        }, INJECT_MIN_GAP_MS - (now - __lastInjectAt));
      }
      return;
    }
    __lastInjectAt = now;

    // Anchor on the MAIN visible add-to-cart button. Stores render SEVERAL
    // /cart/add controls (quick-add rec cards, a hidden sticky bar that pops in
    // on scroll, a mobile/desktop pair). The old code took the FIRST in DOM
    // order, which could be a hidden one (AYBL slate-blue 2026-07-06) or the
    // sticky bar (Steve Madden 2026-07-12); elloPickVisibleAtc now prefers the
    // real in-flow buy button and skips rec/quick-add blocks.
    var atc = elloCachedAtc();
    // The buy button exists → that's our first chance to read the store's color.
    if (atc) refreshBrandColor();
    var form = atc ? atc.closest('form[action*="/cart/add"]') : null;
    if (!form) {
      // No button anchor yet — fall back to a visible buy FORM, but never the
      // Algolia rec template or the sticky bar (same skip rules as the button).
      var forms = document.querySelectorAll('form[action*="/cart/add"]');
      for (var fi = 0; fi < forms.length; fi++) {
        if (elloIsVisible(forms[fi]) && !elloInSkipContainer(forms[fi]) && !elloInFixedBar(forms[fi])) { form = forms[fi]; break; }
      }
    }

    // The rep's picked placement overrides everything — including "no buy button
    // found at all", which is exactly when auto-placement has nowhere to go.
    var anchorEl = elloCustomBtnAnchor();
    if (!anchorEl && !atc && !form) return;                   // no anchor yet → watchPdp's observer retries
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
    // height) so it reads native — the brand color stays ours. With no buy
    // button found but a picked anchor that IS button-like, match the anchor.
    if (atc) matchNativeButton(btn, atc);
    else if (anchorEl && /^(BUTTON|A)$/.test(anchorEl.tagName)) matchNativeButton(btn, anchorEl);

    // Place it full-width BELOW the buy area. If the add-to-cart button sits in a
    // horizontal cluster (e.g. LA Apparel's Try + Add-to-Cart + wishlist row),
    // insert after the WHOLE row so we drop onto our own line instead of being
    // squeezed in beside it. A PICKED anchor skips the row-climb entirely — the
    // rep pointed at the exact element to sit under, so relocating to an
    // ancestor row would land it somewhere they didn't choose.
    var target = anchorEl || atc || form;
    if (!anchorEl) {
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
    }
    // Every DOM write below is flagged as ours, so watchPdp's observer ignores
    // the records it is about to receive for them and cannot re-enter.
    elloSelfMutate(function () {
      if (__overlayMode) {
        elloOverlayHost().appendChild(btn);
        positionOverlayButton();
      } else if (target && target.parentNode) {
        target.parentNode.insertBefore(btn, target.nextSibling);
      } else if (form) {
        form.appendChild(btn);
      }
      styleInlineButtons(window.ELLO_STORE_CONFIG);
    });

    // Point the observer at wherever the button actually ended up, so a strip is
    // seen immediately instead of waiting on the interval.
    __placedParent = btn.parentNode || null;
    __retargetObserver();

    // If we've had to re-place this many times in a few seconds, the store's own
    // renderer is removing it and inline placement will never settle. Move to a
    // host outside its component tree instead of trading writes with it forever.
    if (!__overlayMode && elloNoteInjection() >= INJECT_BURST) { enterOverlayMode(); return; }

    log('inline "Try it on" button injected' + (__overlayMode ? ' (overlay).' : '.'));
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
  // Selectors for DOM that is OURS. Mutations confined to these are noise we
  // generated (widget mount, settings panel, the button itself) and must never
  // schedule another placement pass.
  var ELLO_OWN_DOM = '#ello-demo-panel,#ello-demo-gear,#ello-demo-inline-btn,' +
    '#ello-demo-overlay-host,#ello-demo-pick-box,#ello-demo-pick-hint,' +
    '#virtual-tryon-widget-container,#virtualTryonWidget';

  // The buy box, not the whole page. Observing documentElement with
  // subtree:true on a React storefront delivers enormous record batches on
  // every hover-driven re-render — measured on gymshark.com (2026-07-24), just
  // attaching that observer and moving the cursor froze the renderer for 45s+,
  // while the identical interactions without it ran clean. A frozen main thread
  // can't decode or paint images, which is the white flicker. So we watch only
  // the container our button lives in.
  function elloObserveTarget() {
    // Watch where the button ACTUALLY landed. injectInlineButton walks up through
    // flex/grid button rows before inserting, so the real parent is often an
    // ancestor OR sibling of the buy box — watching the buy box alone missed the
    // removal entirely and left recovery to the 1.5s safety net.
    if (__placedParent && __placedParent.isConnected) return __placedParent;
    var atc = elloCachedAtc();
    // No anchor yet → observe NOTHING. Falling back to document.body here would
    // reintroduce exactly the page-wide observer this whole change removes; the
    // 1.5s interval below already covers "the buy box hasn't mounted yet".
    if (!atc) return null;
    return atc.closest('form,[class*="add-to-cart" i],[class*="add_to_cart" i],' +
                       '[class*="product-form" i],[class*="buybox" i],[class*="buy-box" i]') ||
           atc.parentElement || document.body;
  }

  function watchPdp() {
    try {
      var pending = null;
      var mo = new MutationObserver(function (recs) {
        if (__elloSelfMutating) return;         // our own writes — never re-enter
        var relevant = false;
        for (var i = 0; i < recs.length; i++) {
          var t = recs[i].target;
          try { if (t && t.closest && t.closest(ELLO_OWN_DOM)) continue; } catch (e) {}
          relevant = true; break;
        }
        if (!relevant || pending) return;
        // A timer, not requestAnimationFrame. rAF let a busy page schedule a
        // placement pass 60×/second; this puts a hard floor under it.
        pending = setTimeout(function () { pending = null; injectInlineButton(); }, INJECT_MIN_GAP_MS);
      });

      var target = null;
      var retarget = function () {
        var t = elloObserveTarget();
        if (!t || t === target) return;
        target = t;
        try { mo.disconnect(); } catch (e) {}
        mo.observe(t, { childList: true, subtree: true });
      };
      __retargetObserver = retarget;
      retarget();

      // Safety net for everything the narrow observer can no longer see: a buy
      // box that mounts late, SPA navigation, an anchor that moves. Cheap now —
      // injectInlineButton exits on a getElementById when the button is fine.
      setInterval(function () {
        retarget(); injectInlineButton();
        // Re-assert the platform hooks (a late ello-sfcc.js load overwrites
        // them) and re-read the hero — that's how a color-swatch click follows
        // through to the garment on a store with no variant JSON to read.
        if (hostState.product) ensureHostHooks();
        refreshHostProduct({ idle: true });
      }, 1500);
      window.addEventListener('popstate', function () {
        __atcCache = null; retarget(); injectInlineButton(); refreshHostProduct();
      });
    } catch (e) { /* no MutationObserver — the one-shot inject still ran */ }
  }

  // ── Tiny, auto-dismissing toast (won't sit in the recording) ────────────────
  function toast(msg, ms) {
    var hold = ms || 3200;
    try {
      var t = document.createElement('div');
      t.textContent = msg || ('Ello demo active · ' + (IS_LOCAL ? 'local' : 'cloud'));
      t.style.cssText = [
        'position:fixed', 'top:14px', 'left:50%', 'transform:translateX(-50%)',
        'z-index:2147483647', 'background:#111', 'color:#fff', 'font:600 12px/1 -apple-system,system-ui,sans-serif',
        'padding:9px 14px', 'border-radius:999px', 'box-shadow:0 6px 20px rgba(0,0,0,.28)',
        'opacity:0', 'transition:opacity .25s ease', 'pointer-events:none'
      ].join(';') + ';';
      document.body.appendChild(t);
      requestAnimationFrame(function () { t.style.opacity = '1'; });
      setTimeout(function () { t.style.opacity = '0'; }, hold);
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, hold + 400);
    } catch (e) {}
  }

  // ── Swap-target picker ("click the photo the try-on should replace") ─────────
  // Auto-detection covers stock themes, but a fully custom gallery (Gym King's
  // <pdp-carousel>/<thumbnail-carousel>) names nothing the widget recognizes and
  // the result can land on a thumbnail. Rather than chase every theme, let the
  // rep CLICK the right image once per store; the pick persists per-origin in
  // demoSettings and flows through cfg.pdpImageSelector (see applyDemoConfig).

  // 'div:nth-of-type(2) > img:nth-of-type(1)' from root (exclusive) down to el —
  // the last-resort spine when nothing on the way up has an id or unique class.
  function elloNthChain(root, el) {
    var parts = [], n = el;
    while (n && n !== root) {
      var i = 1, s = n;
      while ((s = s.previousElementSibling)) { if (s.tagName === n.tagName) i++; }
      parts.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
      n = n.parentElement;
      if (parts.length > 10) return null;   // absurdly deep — give up, too brittle anyway
    }
    return n === root ? parts.join(' > ') : null;
  }

  // Build a selector for the clicked element, preferring what survives a reload
  // and other PDPs on the same template: own id → own class(es) → an id / unique
  // class / unique custom-element ancestor + short spine → body-rooted spine.
  // Every candidate is verified (unique AND resolves to the clicked node) before
  // it wins; returns null only if nothing verifiable exists.
  function cssPathForEl(el) {
    var tag = (el.tagName || '').toLowerCase();
    function esc(s) { try { return CSS.escape(s); } catch (e) { return String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1'); } }
    function uniq(sel) {
      try { var n = document.querySelectorAll(sel); return (n.length === 1 && n[0] === el) ? sel : null; }
      catch (e) { return null; }
    }
    if (el.id) { var byId = uniq('#' + esc(el.id)); if (byId) return byId; }
    var cls = (typeof el.className === 'string') ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    for (var i = 0; i < cls.length; i++) { var byCls = uniq(tag + '.' + esc(cls[i])); if (byCls) return byCls; }
    if (cls.length > 1) { var byAll = uniq(tag + '.' + cls.map(esc).join('.')); if (byAll) return byAll; }
    var anc = el.parentElement, depth = 0;
    while (anc && anc !== document.body && depth < 6) {
      var base = null;
      if (anc.id) base = '#' + esc(anc.id);
      if (!base) {
        var ac = (typeof anc.className === 'string') ? anc.className.trim().split(/\s+/).filter(Boolean) : [];
        for (var j = 0; j < ac.length; j++) {
          try { if (document.querySelectorAll('.' + esc(ac[j])).length === 1) { base = '.' + esc(ac[j]); break; } } catch (e) {}
        }
      }
      // Custom elements (<pdp-carousel>) are often the cleanest unique anchor.
      if (!base && anc.tagName.indexOf('-') > 0) {
        try { if (document.querySelectorAll(anc.tagName.toLowerCase()).length === 1) base = anc.tagName.toLowerCase(); } catch (e) {}
      }
      if (base) {
        var spine = elloNthChain(anc, el);
        if (spine) { var scoped = uniq(base + ' > ' + spine); if (scoped) return scoped; }
      }
      anc = anc.parentElement; depth++;
    }
    var full = elloNthChain(document.body, el);
    return full ? uniq('body > ' + full) : null;
  }

  // Interactive pick mode: highlight the hovered target, click chooses it, Esc
  // cancels. Clicks are swallowed in capture phase for the whole session so a
  // stray click can't add-to-cart or navigate mid-pick. Uses elementsFromPoint
  // (not e.target) so an overlay ABOVE the target — cookie banners, hover veils —
  // can't hide it from the pick. `opts.match(list)` decides WHAT is pickable:
  // the image picker wants the first <img> in the stack, the button-placement
  // picker wants whatever solid element you're pointing at.
  function startPickElement(opts, onDone) {
    if (document.getElementById('ello-demo-pick-hint')) return;
    function mkEl(tag, css, html) { var e = document.createElement(tag); e.style.cssText = css; if (html != null) e.innerHTML = html; return e; }
    var box = mkEl('div', 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #2563eb;background:rgba(37,99,235,.14);border-radius:4px;display:none;');
    box.id = 'ello-demo-pick-box';
    var dim = mkEl('span', 'position:absolute;top:4px;left:4px;background:#2563eb;color:#fff;font:11px/1 -apple-system,sans-serif;padding:3px 6px;border-radius:3px;');
    box.appendChild(dim);
    var hint = mkEl('div', 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#111;color:#fff;font:12.5px/1.4 -apple-system,sans-serif;padding:9px 14px;border-radius:9px;box-shadow:0 6px 22px rgba(0,0,0,.35);', opts.hint + ' &nbsp;·&nbsp; Esc cancels');
    hint.id = 'ello-demo-pick-hint';
    (document.body || document.documentElement).appendChild(box);
    (document.body || document.documentElement).appendChild(hint);
    var cur = null;
    function targetAt(x, y) {
      var list; try { list = document.elementsFromPoint(x, y) || []; } catch (e) { list = []; }
      return opts.match(list);
    }
    function mv(e) {
      var t = targetAt(e.clientX, e.clientY);
      if (t === cur) return;
      cur = t;
      if (!t) { box.style.display = 'none'; return; }
      var r = t.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = (r.left - 2) + 'px'; box.style.top = (r.top - 2) + 'px';
      box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
      dim.textContent = Math.round(r.width) + ' × ' + Math.round(r.height);
    }
    function ck(e) {
      e.preventDefault(); e.stopPropagation();
      var t = targetAt(e.clientX, e.clientY);
      if (!t) return;                       // swallowed, keep picking
      cleanup(); onDone(t);
    }
    function kd(e) { if (e.key === 'Escape') { e.preventDefault(); cleanup(); onDone(null); } }
    function cleanup() {
      document.removeEventListener('mousemove', mv, true);
      document.removeEventListener('click', ck, true);
      document.removeEventListener('keydown', kd, true);
      try { box.remove(); hint.remove(); } catch (e) {}
    }
    document.addEventListener('mousemove', mv, true);
    document.addEventListener('click', ck, true);
    document.addEventListener('keydown', kd, true);
  }

  // The two pickers, built on startPickElement. The image picker takes the first
  // <img> in the hit stack; the placement picker takes the solid element under
  // the cursor, climbing out of inline leaves (text spans, svg icons) to a node
  // a button can sensibly be inserted after.
  function startPickImage(onDone, hint) {
    startPickElement({
      hint: hint || 'Click the photo the try-on should replace',
      match: function (list) {
        var bgFallback = null;
        for (var i = 0; i < list.length; i++) {
          var el = list[i];
          if (!el || !el.tagName) continue;
          if (el.closest && el.closest(ELLO_OWN_DOM)) return null;
          if (el.tagName === 'IMG') return el;
          // Custom storefronts routinely paint the hero as a CSS background on a
          // <div> — with no <img> anywhere in the stack the old picker had
          // nothing to highlight and the rep simply couldn't pick. Take the
          // topmost background-image element as the fallback, but only after
          // the whole stack has failed to produce a real <img>.
          if (!bgFallback) {
            try {
              var bg = window.getComputedStyle(el).backgroundImage || '';
              if (/url\(/.test(bg) && !/gradient/i.test(bg)) {
                var r = el.getBoundingClientRect();
                if (r.width >= 100 && r.height >= 100) bgFallback = el;
              }
            } catch (e) {}
          }
        }
        return bgFallback;
      }
    }, onDone);
  }
  function startPickButtonAnchor(onDone) {
    startPickElement({
      hint: 'Click what the “Try it on” button should sit under',
      match: function (list) {
        for (var i = 0; i < list.length; i++) {
          var el = list[i];
          if (!el || !el.tagName) continue;
          if (el.closest && el.closest(ELLO_OWN_DOM)) return null;
          if (el === document.body || el === document.documentElement) return null;
          // Full-viewport veils (cookie-consent overlays, modal backdrops) hit-test
          // first but are never what the rep is aiming at — look through them to
          // the element visually underneath. (Verified on Gym King: their
          // CookieYes div.cky-overlay covered every pick until skipped.)
          var vr; try { vr = el.getBoundingClientRect(); } catch (e) { vr = null; }
          if (vr && vr.width >= window.innerWidth * 0.95 && vr.height >= window.innerHeight * 0.95) continue;
          var cur = el, hops = 0;
          while (cur && hops < 4) {
            var inlineish = false;
            try {
              inlineish = (typeof SVGElement !== 'undefined' && cur instanceof SVGElement) ||
                          window.getComputedStyle(cur).display === 'inline';
            } catch (e) {}
            if (!inlineish || !cur.parentElement || cur.parentElement === document.body) break;
            cur = cur.parentElement; hops++;
          }
          return cur;
        }
        return null;
      }
    }, onDone);
  }

  // Shared commit for panel + console: selector-ize, persist, push live.
  // One click now sets BOTH halves — the image the result lands on, and (on
  // non-Shopify stores, where nothing else can answer) the garment itself.
  // Returns truthy when the click was usable; null only when we could neither
  // address the image nor read a URL out of it.
  function commitPickedImage(img) {
    // Garment first: it works even when no selector can be built, and it is the
    // half a try-on can't happen without. A gallery we can't address just falls
    // back to the widget's own hero detection for the swap.
    var host = adoptHostImage(img);
    var sel = img ? cssPathForEl(img) : null;
    if (!sel) {
      if (host) log('using that photo as the garment; couldn\'t build a selector for it, so the result lands on the auto-detected hero.');
      return host ? true : null;
    }
    demoSettings.pdpSelector = sel;
    // Picking a swap target obviously means "show the result on the PDP image".
    if (demoSettings.mode !== 'mirror') demoSettings.mode = 'mirror';
    saveSettings();
    applyDemoConfig(window.ELLO_STORE_CONFIG);
    panelSync();
    log('swap target picked:', sel);
    return sel;
  }

  // Same contract for the button-placement pick. Removes the current button and
  // re-places it immediately so the rep SEES it land while the panel is still
  // closed — the whole point of picking is instant visual confirmation.
  function commitPickedAnchor(el) {
    var sel = el ? cssPathForEl(el) : null;
    if (!sel) return null;
    demoSettings.btnAnchorSelector = sel;
    demoSettings.inlineButton = true;   // placing it obviously means "show it"
    saveSettings();
    var old = document.getElementById('ello-demo-inline-btn');
    if (old) elloSelfMutate(function () { try { old.remove(); } catch (e) {} });
    __lastInjectAt = 0;                 // skip the rate-limit window for this one placement
    injectInlineButton();
    applyDemoConfig(window.ELLO_STORE_CONFIG);
    panelSync();
    log('inline button anchored after:', sel);
    return sel;
  }
  // Back to automatic placement (shared by the panel's clear + console).
  function clearPickedAnchor() {
    demoSettings.btnAnchorSelector = '';
    saveSettings();
    var old = document.getElementById('ello-demo-inline-btn');
    if (old) elloSelfMutate(function () { try { old.remove(); } catch (e) {} });
    __lastInjectAt = 0;
    injectInlineButton();
    applyDemoConfig(window.ELLO_STORE_CONFIG);
    panelSync();
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

    // Swap target — which image on THIS store the mirror-mode result replaces.
    // One click per store beats hoping auto-detection understands their theme.
    panel.appendChild(mk('div', 'font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#888;margin:0 0 6px;', 'Try-on lands on'));
    var pickRow = mk('div', 'display:flex;align-items:center;gap:8px;');
    var pickBtn = mk('button', 'flex:1;padding:8px 10px;border:1px solid #ddd;border-radius:7px;background:#fafafa;color:#222;cursor:pointer;font:inherit;font-size:12px;font-weight:600;', 'Pick image on page');
    var pickClear = mk('button', 'border:none;background:none;color:#999;cursor:pointer;font-size:11px;text-decoration:underline;padding:0;display:none;', 'clear');
    pickRow.appendChild(pickBtn); pickRow.appendChild(pickClear);
    panel.appendChild(pickRow);
    var pickNote = mk('div', 'font-size:11.5px;line-height:1.35;color:#888;margin:4px 0 10px;');
    panel.appendChild(pickNote);
    pickBtn.onclick = function () {
      panel.style.display = 'none';        // get the panel out of the shot while aiming
      startPickImage(function (img) {
        panel.style.display = 'block';
        if (!img) { panelSync(); return; } // Esc — leave everything as it was
        if (!commitPickedImage(img)) {
          pickNote.textContent = '✗ Couldn’t read that image — try clicking directly on the photo.';
          pickNote.style.color = '#b42318';
        } else {
          panelSync();
        }
      }, hostModeApplies() ? 'Click the product photo — it becomes the garment AND the swap target' : null);
    };
    // Clearing the pick on a non-Shopify store also drops the garment it stood
    // in for, so the next try-on asks for a fresh photo instead of silently
    // reusing the last one.
    pickClear.onclick = function () { resetHostProduct(); setSetting('pdpSelector', ''); };

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

    // Button placement — the fallback for themes where auto (below Add-to-Cart)
    // finds nothing or lands in the wrong block: click exactly where it goes.
    panel.appendChild(mk('div', 'font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#888;margin:12px 0 6px;', 'Try-on button placement'));
    var bpRow = mk('div', 'display:flex;align-items:center;gap:8px;');
    var bpBtn = mk('button', 'flex:1;padding:8px 10px;border:1px solid #ddd;border-radius:7px;background:#fafafa;color:#222;cursor:pointer;font:inherit;font-size:12px;font-weight:600;', 'Place on page');
    var bpClear = mk('button', 'border:none;background:none;color:#999;cursor:pointer;font-size:11px;text-decoration:underline;padding:0;display:none;', 'clear');
    bpRow.appendChild(bpBtn); bpRow.appendChild(bpClear);
    panel.appendChild(bpRow);
    var bpNote = mk('div', 'font-size:11.5px;line-height:1.35;color:#888;margin:4px 0 0;');
    panel.appendChild(bpNote);
    bpBtn.onclick = function () {
      panel.style.display = 'none';      // out of the way while aiming
      startPickButtonAnchor(function (el) {
        panel.style.display = 'block';
        if (!el) { panelSync(); return; }
        if (!commitPickedAnchor(el)) {
          bpNote.textContent = '✗ Couldn’t lock onto that spot — try a bigger element.';
          bpNote.style.color = '#b42318';
        }
      });
    };
    bpClear.onclick = function () { clearPickedAnchor(); };

    // Upsell item — paste the product's URL off the store the rep is already
    // browsing. This is the whole point: a rep should never need a product id or
    // a console to script the Complete-the-Look offer in a recording.
    panel.appendChild(mk('div', 'font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#888;margin:12px 0 6px;', 'Upsell item'));
    var pairIn = document.createElement('input'); pairIn.type = 'text';
    pairIn.placeholder = 'Paste their product URL';
    pairIn.style.cssText = 'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #ddd;border-radius:7px;font:inherit;';
    var pairNoteRow = mk('div', 'display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:5px 0 2px;min-height:16px;');
    var pairNote = mk('div', 'font-size:11.5px;line-height:1.35;color:#888;flex:1;');
    var pairClear = mk('button', 'border:none;background:none;color:#999;cursor:pointer;font-size:11px;text-decoration:underline;padding:0;display:none;', 'clear');
    pairNoteRow.appendChild(pairNote); pairNoteRow.appendChild(pairClear);
    function setPairNote(msg, color) {
      pairNote.textContent = msg || '';
      pairNote.style.color = color || '#888';
      pairClear.style.display = demoSettings.ctlPairHandle ? '' : 'none';
    }
    // Each commit invalidates any in-flight lookup, so a fast second paste can't
    // be overwritten by the first one's slower response.
    var pairSeq = 0;
    function commitPair(raw) {
      var h = handleFromInput(raw);
      var seq = ++pairSeq;
      demoSettings.ctlPairHandle = h;
      // Pasting an upsell obviously means "show the upsell" — don't make a rep
      // find the toggle to make their own pin appear.
      if (h) demoSettings.completeTheLook = true;
      saveSettings(); applyCtlPair(); applyDemoConfig(window.ELLO_STORE_CONFIG); panelSync();
      if (!h) { setPairNote(''); return; }
      if (h === currentHandle()) { setPairNote('That’s the product you’re on — pick a different one.', '#b45309'); return; }
      setPairNote('Checking…');
      lookupPairProduct(h).then(function (info) {
        if (seq !== pairSeq) return;               // a newer paste already won
        if (info && info.title) setPairNote('✓ ' + info.title, '#15803d');
        else setPairNote('✗ No product at /products/' + h, '#b42318');
      });
    }
    pairIn.onchange = function () { commitPair(pairIn.value); };
    pairIn.onpaste = function () { setTimeout(function () { commitPair(pairIn.value); }, 0); };
    pairIn.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); commitPair(pairIn.value); } };
    pairClear.onclick = function () { pairIn.value = ''; commitPair(''); };
    panel.appendChild(pairIn); panel.appendChild(pairNoteRow);

    // Brand color — defaults to whatever we read off the store's own buy button.
    var colorRow = mk('div', 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0 0;');
    colorRow.appendChild(mk('span', 'color:#222;', 'Brand color'));
    var colorWrap = mk('div', 'display:flex;align-items:center;gap:8px;');
    var colorIn = document.createElement('input'); colorIn.type = 'color';
    colorIn.style.cssText = 'width:30px;height:24px;border:1px solid #ddd;border-radius:5px;background:none;cursor:pointer;padding:0;';
    colorIn.oninput = function () { setSetting('brandColor', colorIn.value); };
    var colorClear = mk('button', 'border:none;background:none;color:#999;cursor:pointer;font-size:11px;text-decoration:underline;', 'reset');
    colorClear.onclick = function () { setSetting('brandColor', ''); };
    colorWrap.appendChild(colorIn); colorWrap.appendChild(colorClear);
    colorRow.appendChild(colorWrap); panel.appendChild(colorRow);
    var colorNote = mk('div', 'font-size:11.5px;color:#888;margin:2px 0 2px;');
    panel.appendChild(colorNote);

    // Button text
    var textRow = mk('div', 'padding:4px 0 2px;');
    textRow.appendChild(mk('div', 'color:#222;margin-bottom:5px;', 'Button text'));
    var textIn = document.createElement('input'); textIn.type = 'text';
    textIn.style.cssText = 'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #ddd;border-radius:7px;font:inherit;';
    textIn.oninput = function () { setSetting('inlineText', textIn.value); };
    textRow.appendChild(textIn); panel.appendChild(textRow);

    var reset = mk('button', 'width:100%;margin-top:12px;padding:9px;border:1px solid #eee;border-radius:8px;background:#fafafa;color:#666;cursor:pointer;font:inherit;font-size:12px;', 'Reset to store defaults');
    reset.onclick = function () {
      demoSettings = Object.assign({}, DEMO_DEFAULTS);
      saveSettings();
      applyCtlPair();                 // clearing the pin must reach the widget too
      applyDemoConfig(window.ELLO_STORE_CONFIG);
      pairIn.value = ''; setPairNote('');
      panelSync();
    };
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
      var bs = (demoSettings.btnAnchorSelector || '').trim();
      bpClear.style.display = bs ? '' : 'none';
      if (!bs) {
        bpNote.textContent = 'Auto — sits under Add to Cart.';
        bpNote.style.color = '#888';
      } else {
        var anchorNode = null; try { anchorNode = document.querySelector(bs); } catch (e) {}
        if (anchorNode && elloIsVisible(anchorNode)) {
          bpNote.textContent = '✓ Sits under your picked spot on this store.';
          bpNote.style.color = '#15803d';
        } else {
          bpNote.textContent = '✗ Saved spot isn’t on this page — auto placement is used here.';
          bpNote.style.color = '#b45309';
        }
      }
      // On a non-Shopify store the pick is doing double duty (garment + swap
      // target), so the note has to say so — otherwise a rep reads "auto" and
      // never learns why the try-on used the demo store's product.
      var hostMode = hostModeApplies();
      pickBtn.textContent = hostMode ? 'Pick product photo on page' : 'Pick image on page';
      var ps = (demoSettings.pdpSelector || '').trim();
      pickClear.style.display = (ps || hostState.product) ? '' : 'none';
      if (!ps && !hostState.product) {
        pickNote.textContent = hostMode
          ? 'This store isn’t Shopify — pick the product photo so the try-on uses it instead of a demo product.'
          : 'Auto — widget detects the main photo.';
        pickNote.style.color = hostMode ? '#b45309' : '#888';
      } else {
        var pickedEl = null; try { pickedEl = ps ? document.querySelector(ps) : null; } catch (e) {}
        var pickedImg = pickedEl && (pickedEl.tagName === 'IMG' ? pickedEl : (pickedEl.querySelector && pickedEl.querySelector('img'))) || null;
        var sizeEl = pickedImg || (hostState.el && hostState.el.isConnected ? hostState.el : null);
        if (sizeEl) {
          var pr = sizeEl.getBoundingClientRect();
          var dims = ' (' + Math.round(pr.width) + '×' + Math.round(pr.height) + ')';
          pickNote.textContent = hostState.product
            ? '✓ Trying on this photo' + dims + ' — result lands right back on it.'
            : '✓ Picked' + dims + '. Next try-on lands there; reload to move a saved look.';
          pickNote.style.color = '#15803d';
        } else {
          pickNote.textContent = hostMode
            ? '✗ Saved pick isn’t on this page — pick the product photo again here.'
            : '✗ Saved pick isn’t on this page — auto detection is used here.';
          pickNote.style.color = '#b45309';
        }
      }
      colorIn.value = elloRgbToHex(effectiveBrandColor() || (demoOrig && demoOrig.ic) || '') || '#2563eb';
      colorNote.textContent = demoSettings.brandColor
        ? 'Custom — picked by hand.'
        : (detectedBrandColor ? 'Auto — matched to their Add to cart.' : 'Auto — no buy button found yet.');
      if (document.activeElement !== pairIn) pairIn.value = demoSettings.ctlPairHandle || '';
      pairClear.style.display = demoSettings.ctlPairHandle ? '' : 'none';
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
      var h = handleFromInput(handleOrUrl); // accepts a full product URL too
      demoSettings.ctlPairHandle = h; saveSettings(); applyCtlPair(); panelSync();
      log('Complete-the-Look pinned to', h || '(cleared)');
      return h;
    },
    clearPair: function () { demoSettings.ctlPairHandle = ''; saveSettings(); applyCtlPair(); panelSync(); log('Complete-the-Look pin cleared'); },
    pickImage: function () {   // same as the panel button: click the photo the try-on should replace
      startPickImage(function (img) {
        if (img && !commitPickedImage(img)) log('couldn’t read that image');
      });
    },
    clearPick: function () { resetHostProduct(); setSetting('pdpSelector', ''); log('swap target back to auto-detect'); },
    // Force the picked photo to BE the garment even on a /products/ URL — for a
    // non-Shopify store whose URLs happen to look Shopify-shaped, where the
    // automatic switch (no /products/ handle) never trips.
    useThisPhoto: function () {
      demoSettings.forceHostProduct = true;
      saveSettings();
      startPickImage(function (img) {
        if (img && !commitPickedImage(img)) log('couldn’t read that image');
      }, 'Click the product photo — it becomes the garment AND the swap target');
      return 'click the product photo';
    },
    // What the try-on will actually use on this page, and why.
    host: function () {
      return {
        active: !!hostState.product,
        pickNeeded: hostPickNeeded(),
        modeApplies: hostModeApplies(),
        forced: !!demoSettings.forceHostProduct,
        handle: hostState.handle,
        title: hostState.product && hostState.product.title,
        image: hostState.imgSrc,
        shopifyHandle: currentHandle(),
        platformAdapter: platformProductResolved()
      };
    },
    clearHost: function () {
      demoSettings.forceHostProduct = false; saveSettings();
      resetHostProduct(); panelSync();
      log('picked-photo garment cleared — back to the widget’s own detection');
    },
    placeButton: function () { // click the element the inline "Try it on" button should sit under
      startPickButtonAnchor(function (el) {
        if (el && !commitPickedAnchor(el)) log('couldn’t build a selector for that spot');
      });
    },
    clearButtonPlace: function () { clearPickedAnchor(); log('inline button back to auto placement'); },
    brandColor: function () { return { inUse: effectiveBrandColor(), detected: detectedBrandColor, manual: demoSettings.brandColor || null }; },
    // Where the inline button is mounted, and how hard this store fought for it.
    // `__elloDemo.overlay()` forces the React-safe placement without waiting for
    // the burst detector — handy if a store flickers for only a second or two.
    placement: function () {
      return {
        mode: __overlayMode ? 'overlay' : 'inline',
        mounted: !!document.getElementById('ello-demo-inline-btn'),
        replacementsInWindow: __injectAttempts.length,
        anchor: elloCachedAtc() || null
      };
    },
    overlay: function () { enterOverlayMode(); return 'overlay placement on'; },
    reset: function () {       // undo demo mode for this tab
      try { localStorage.removeItem('ello_dev_origin'); localStorage.removeItem(SETTINGS_KEY); } catch (e) {}
      resetHostProduct();
      window.__ELLO_DEMO__ = false;
      window.__ELLO_DEMO_BOOTED__ = false;
      var b = document.getElementById('ello-demo-inline-btn'); if (b) b.remove();
      var g = document.getElementById('ello-demo-gear'); if (g) g.remove();
      var p = document.getElementById('ello-demo-panel'); if (p) p.remove();
      log('demo reset — reload the page for a clean state.');
    }
  };

  // ── SFCC prospect stores: pull in the platform adapter ───────────────────────
  // Demandware-fingerprinted pages (Boot Barn, PacSun, Tillys, Ralph Lauren…)
  // have none of the Shopify product/cart hooks. ello-sfcc.js supplies platform
  // product detection (JSON-LD → SFRA Product-Variation → microdata) plus a
  // native Cart-AddProduct driver, and widget-main.js reads it through the
  // ELLO_PLATFORM_* hooks — so the SAME bookmarklet press now demos a real
  // add-to-cart into the prospect's own SFCC minicart.
  function isSfccProspect() {
    try {
      var html = document.documentElement.innerHTML;
      if (html.indexOf('/on/demandware.static/') !== -1) return true;
      if (html.indexOf('/on/demandware.store/') !== -1) return true;
      if (/(?:^|;\s*)dwanonymous_/.test(document.cookie) || /(?:^|;\s*)dwac_/.test(document.cookie)) return true;
    } catch (e) { }
    return false;
  }
  function injectSfccAdapter() {
    if (!isSfccProspect()) return;
    if (window.__elloSfccBooted || document.querySelector('script[src*="ello-sfcc"]')) return;
    var s = document.createElement('script');
    s.src = BASE + '/ello-sfcc.js?ello_demo=' + Date.now();
    s.setAttribute('data-store-slug', DEMO.slug);
    s.setAttribute('data-backend', BASE);
    (document.head || document.documentElement).appendChild(s);
    log('SFCC store detected — platform adapter injected.');
  }

  // ── Go ───────────────────────────────────────────────────────────────────────
  injectLoader();
  injectSfccAdapter();
  // A store picked once should never need picking again: the saved selector is
  // re-resolved on load (galleries lazy-load, hence the later passes), and only
  // if it still resolves nothing do we tell the rep this store needs a click.
  function hostBoot() {
    refreshHostProduct();
    setTimeout(refreshHostProduct, 1200);
    setTimeout(function () {
      refreshHostProduct();
      if (!hostPickNeeded()) return;
      toast('Not a Shopify store — hit “Try it on” and click the product photo', 5200);
      log('no product data on this page (not Shopify). Press "Try it on" — or ⚙ → Pick product photo — then click the product photo: it becomes the garment AND the image the result lands on.');
    }, 3000);
  }

  function onReady() { injectInlineButton(); watchPdp(); watchVariant(); buildSettingsPanel(); refreshBrandColor(); hostBoot(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
  toast();
  log('ready. Gear ⚙ (bottom-left) = settings (mode / upsell item / brand color). Console: window.__elloDemo (tryOn / open / set / pairWith / clearPair / brandColor / pickImage / useThisPhoto / host / reset)');
})();
