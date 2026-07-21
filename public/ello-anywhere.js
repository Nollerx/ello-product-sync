/**
 * Ello Anywhere v1 — run the Ello try-on on pages Shopify doesn't serve
 * (custom storefronts, landing pages, headless builds).
 *
 * Install (host page <head>, order matters — loader first):
 *
 *   <script src="https://widget.ellotryon.com/widget-loader.js" data-store-slug="YOUR_SLUG" defer></script>
 *   <script src="https://widget.ellotryon.com/ello-anywhere.js"  data-store-slug="YOUR_SLUG" defer></script>
 *
 * Then mark any clickable element with the product's Shopify handle:
 *
 *   <a href="https://your-store.com/products/HANDLE" data-ello-tryon="HANDLE">Try me on virtually ✨</a>
 *
 * Keep the href — it is the no-JS fallback; when this script is alive the
 * click is intercepted and the try-on opens in place instead of navigating.
 *
 * Purchase attribution (REQUIRED for attributed-revenue tracking): wherever the
 * host page builds its Shopify checkout permalink, wrap it:
 *
 *   url = window.ElloAnywhere ? window.ElloAnywhere.checkoutUrl(url) : url;
 *
 * Optional — route the widget's Add-to-Cart into the host page's own cart:
 *
 *   window.ElloAnywhere.setCartHandler(function (item) {
 *     // item = { variantId, productId, productHandle, title, quantity }
 *     myCartAdd(item);          // may return a Promise
 *   });
 *
 * Optional — corner launcher bubble on the host page: off by default; opt in
 * with data-floating="on" on this script tag.
 *
 * Design notes:
 * - Click binding is DELEGATED (document-level, capture phase) so host-page
 *   re-renders never orphan a button. No MutationObserver, no polling.
 * - A/B holdout shoppers (widget-wide proof test) get their [data-ello-tryon]
 *   controls hidden so the experiment stays clean on non-Shopify surfaces too;
 *   with the href fallback intact those shoppers just navigate like before.
 * - window.ELLO_NO_SHOPIFY_CART tells widget-main.js there is no /cart/add.js
 *   here: it suppresses the Complete-the-Look rail and the View-cart button,
 *   and routes Add-to-Cart through setCartHandler when one is registered.
 */
(function () {
    'use strict';
    if (window.__elloAnywhereBooted) return;
    window.__elloAnywhereBooted = true;

    var script = document.currentScript;
    var ds = (script && script.dataset) || {};
    var pre = (typeof window.ELLO_ANYWHERE_CONFIG === 'object' && window.ELLO_ANYWHERE_CONFIG) || {};

    var storeSlug = ds.storeSlug || pre.storeSlug || null;
    var backend = ds.backend || pre.backend || null;
    if (!backend && script && script.src) {
        try { backend = new URL(script.src).origin; } catch (e) { /* fall through */ }
    }
    if (!backend) backend = 'https://widget.ellotryon.com';
    var floatingOn = (ds.floating || pre.floating) === 'on';

    if (!storeSlug) {
        console.error('[ElloAnywhere] data-store-slug is required — widget not started.');
        return;
    }

    // Widget-main.js reads this to route cart behavior on non-Shopify pages.
    window.ELLO_NO_SHOPIFY_CART = true;

    // Re-publish resolved config: if this script was itself injected dynamically
    // (no currentScript on the loader either), the loader falls back to this.
    window.ELLO_ANYWHERE_CONFIG = { storeSlug: storeSlug, backend: backend, floating: floatingOn ? 'on' : 'off' };

    // ── Keep Shopify-surface chrome off the host page unless opted in ──────
    // Hides only the MINIMIZED corner launcher + the desktop preview popup;
    // the opened panel (which our buttons launch) is unaffected.
    if (!floatingOn) {
        var chrome = document.createElement('style');
        chrome.id = 'ello-anywhere-chrome';
        chrome.textContent =
            '#virtualTryonWidget.widget-minimized{display:none !important;}' +
            '#previewWidget{display:none !important;}';
        (document.head || document.documentElement).appendChild(chrome);
    }

    // ── Session + loader plumbing ───────────────────────────────────────────
    function sessionId() {
        try {
            var m = document.cookie.match(/(?:^|;\s*)ello_session_id=([^;\s]+)/);
            if (m) return decodeURIComponent(m[1]);
        } catch (e) { /* cookie unreadable */ }
        return window.__elloLoaderSessionId || null;
    }

    function ensureLoader() {
        // A static loader tag (the recommended install) or an already-booted
        // loader wins; otherwise inject one. The loader itself is safe under
        // multiple copies, this just avoids the pointless second fetch.
        if (window.ELLO_STORE_SLUG) return;
        if (document.querySelector('script[src*="widget-loader"]')) return;
        var s = document.createElement('script');
        s.src = backend + '/widget-loader.js';
        s.async = true;
        try { s.dataset.storeSlug = storeSlug; } catch (e) { /* dataset always writable in practice */ }
        (document.head || document.documentElement).appendChild(s);
    }

    function isHoldout() {
        return !!(window.__elloAbState && window.__elloAbState.variant === 'holdout');
    }

    // ── Open API ────────────────────────────────────────────────────────────
    function open(arg) {
        if (isHoldout()) return;   // proof-test integrity: holdout sees no Ello surface
        var ctx = typeof arg === 'string' ? { productHandle: arg } : (arg || {});
        var payload = {
            source: ctx.source || 'anywhere_button',
            productHandle: ctx.productHandle || null,
            productId: ctx.productId || null,
            variantId: ctx.variantId || null
        };
        if (window.Ello && typeof window.Ello.openTryOn === 'function') {
            window.Ello.openTryOn(payload);
        } else {
            // widget-loader.js adopts window.__elloPreQueue on boot — clicks
            // that race the loader are replayed, never dropped.
            (window.__elloPreQueue = window.__elloPreQueue || []).push(payload);
            ensureLoader();
        }
    }

    // ── Checkout permalink decoration (purchase attribution carrier) ────────
    // Shopify cart permalinks accept ?attributes[key]=value; the Ello web pixel
    // reads checkout.attributes.ello_session_id as its cookie fallback, which is
    // the ONLY carrier that survives the cross-domain hop from a host page to
    // the Shopify checkout.
    function checkoutUrl(url) {
        var sid = sessionId();
        if (!url || !sid) return url;
        try {
            var u = new URL(url, window.location.href);
            u.searchParams.set('attributes[ello_session_id]', sid);
            return u.toString();
        } catch (e) {
            var sep = url.indexOf('?') === -1 ? '?' : '&';
            return url + sep + 'attributes%5Bello_session_id%5D=' + encodeURIComponent(sid);
        }
    }

    // ── Delegated click binding ─────────────────────────────────────────────
    document.addEventListener('click', function (e) {
        var t = e.target;
        var el = t && t.closest ? t.closest('[data-ello-tryon]') : null;
        if (!el) return;
        if (isHoldout()) return;   // let the href fallback navigate normally
        e.preventDefault();
        e.stopPropagation();
        open({
            productHandle: el.getAttribute('data-ello-tryon') || null,
            variantId: el.getAttribute('data-ello-variant') || null,
            source: 'anywhere_button'
        });
    }, true);

    // ── Holdout gate ────────────────────────────────────────────────────────
    // __elloAbState resolves asynchronously after the loader fetches config, so
    // poll briefly; exposed shoppers converge in one or two ticks. Buttons stay
    // visible until holdout is CONFIRMED — the reverse (hidden until exposed)
    // would flash-hide the surface for 90% of shoppers.
    var gateTries = 0;
    (function holdoutGate() {
        if (isHoldout()) {
            if (!document.getElementById('ello-anywhere-holdout')) {
                var st = document.createElement('style');
                st.id = 'ello-anywhere-holdout';
                st.textContent = '[data-ello-tryon]{display:none !important;}';
                (document.head || document.documentElement).appendChild(st);
            }
            return;
        }
        if (++gateTries < 24) setTimeout(holdoutGate, 500);
    })();

    // ── Public API ──────────────────────────────────────────────────────────
    window.ElloAnywhere = {
        version: '1.0.0',
        storeSlug: storeSlug,
        open: open,
        checkoutUrl: checkoutUrl,
        sessionId: sessionId,
        setCartHandler: function (fn) {
            if (typeof fn === 'function') window.ELLO_CART_HOOK = fn;
        }
    };

    ensureLoader();
})();
