/**
 * Ello SFCC v0.1 — Salesforce B2C Commerce (Demandware) adapter for the Ello
 * VTO widget. Extends the Ello Anywhere pattern with SFCC-native product
 * detection and add-to-cart, so ONE widget codebase serves Shopify and SFCC.
 *
 * Install (host page <head>, order matters — loader first). This is the whole
 * merchant-side integration; the production cartridge (int_ello) just renders
 * these two tags from an SFRA template hook:
 *
 *   <script src="https://widget.ellotryon.com/widget-loader.js" data-store-slug="YOUR_SLUG" defer></script>
 *   <script src="https://widget.ellotryon.com/ello-sfcc.js"    data-store-slug="YOUR_SLUG" defer></script>
 *
 * What it does on an SFCC PDP, in order:
 *   1. PRODUCT — builds the widget's product object from the page itself:
 *        a. schema.org JSON-LD ProductGroup/Product (PacSun, Tillys, Coach…)
 *        b. SFRA DOM contract: .product-detail[data-pid] + the site's own
 *           credential-free Product-Variation endpoint (variation matrix,
 *           per-color images, price, availability) — works on stock SFRA with
 *           ZERO brand-side setup ("Method 7")
 *        c. schema.org microdata (SiteGenesis-era sites, e.g. Boot Barn)
 *      and registers it through the widget's platform hooks
 *      (ELLO_PLATFORM_PRODUCT / ELLO_PLATFORM_PRODUCT_JSON / ELLO_PLATFORM_URL_HANDLE).
 *   2. CART — registers ELLO_CART_HOOK with an SFRA driver: same-origin POST to
 *      Cart-AddProduct (pid + quantity, form-encoded), then re-fires the site's
 *      own jQuery minicart events so the brand's cart UI updates natively.
 *      Sizes carry lazy "sfccvar:" ids (a Product-Variation URL) resolved to the
 *      real variant pid at add time.
 *   3. TRIGGERS — same contract as Ello Anywhere: any [data-ello-tryon] element
 *      opens the try-on (delegated, capture-phase); window.ElloSFCC.open() for
 *      programmatic opens; corner launcher stays hidden unless data-floating="on".
 *   4. ATTRIBUTION — SFCC checkout is SAME-ORIGIN, so the ello_session_id
 *      cookie/localStorage survives to the confirmation page by itself. On that
 *      page (cartridge include or tag manager) call:
 *        window.ElloSFCC.trackOrder({ orderId, total, subtotal, currency,
 *          items: [{ productId, variantId, quantity, linePrice, title }] })
 *      which posts the same payload shape as the Shopify web pixel.
 *
 * Explicitly NOT here yet (Phase B+): Complete-the-Look on SFCC (needs SCAPI
 * recommendations via the Ello proxy), SiteGenesis add-to-cart (form replay,
 * per-brand), server-side order polling. ELLO_NO_SHOPIFY_CART keeps the CTL
 * rail + View-cart button suppressed meanwhile.
 */
(function () {
    'use strict';
    if (window.__elloSfccBooted) return;
    window.__elloSfccBooted = true;

    var script = document.currentScript;
    var ds = (script && script.dataset) || {};
    var pre = (typeof window.ELLO_SFCC_CONFIG === 'object' && window.ELLO_SFCC_CONFIG) || {};

    var storeSlug = ds.storeSlug || pre.storeSlug || null;
    var backend = ds.backend || pre.backend || null;
    if (!backend && script && script.src) {
        try { backend = new URL(script.src).origin; } catch (e) { /* fall through */ }
    }
    if (!backend) backend = 'https://widget.ellotryon.com';
    var floatingOn = (ds.floating || pre.floating) === 'on';

    if (!storeSlug) {
        console.error('[ElloSFCC] data-store-slug is required — widget not started.');
        return;
    }

    function log() {
        if (!window.__ELLO_DEBUG__) return;
        try {
            var a = ['%c[ElloSFCC]', 'color:#0ea5e9;font-weight:700'];
            for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
            console.log.apply(console, a);
        } catch (e) { }
    }

    // Widget-main.js reads this to route cart behavior off Shopify: suppresses
    // the Complete-the-Look rail + View-cart button and sends Add-to-Cart
    // through ELLO_CART_HOOK (our SFRA driver below).
    window.ELLO_NO_SHOPIFY_CART = true;

    // The loader falls back to this when injected dynamically (no currentScript).
    window.ELLO_ANYWHERE_CONFIG = { storeSlug: storeSlug, backend: backend, floating: floatingOn ? 'on' : 'off' };

    // ── SFCC fingerprint + site/locale discovery ────────────────────────────
    // /on/demandware.store/Sites-<site>-Site/<locale>/<Controller>-<Action> URLs
    // survive even behind pretty SEO URLs (forms/AJAX still post to them).
    var DW_STORE_RE = /\/on\/demandware\.store\/Sites-([^/]+)-Site\/([^/"'\s\\]+)\//;
    function siteInfo() {
        try {
            var html = document.documentElement.innerHTML;
            var m = html.match(DW_STORE_RE);
            if (m) return { siteId: m[1], locale: m[2] };
        } catch (e) { }
        return null;
    }
    function isSfccPage() {
        try {
            if (siteInfo()) return true;
            if (document.documentElement.innerHTML.indexOf('/on/demandware.static/') !== -1) return true;
            if (/(?:^|;\s*)dwanonymous_/.test(document.cookie) || /(?:^|;\s*)dwac_/.test(document.cookie)) return true;
        } catch (e) { }
        return false;
    }

    // ── State ───────────────────────────────────────────────────────────────
    var state = {
        handle: null,        // stable product key: SFRA master data-pid, else LD id/slug
        widgetProduct: null, // shape detectCurrentProduct() returns
        productJson: null,   // shape /products/<handle>.js returns (options + variants)
        atcUrl: null,        // Cart-AddProduct endpoint
        source: null,        // 'jsonld' | 'sfra' | 'microdata'
        building: null       // in-flight build promise (dedupe)
    };

    // ── Small helpers ───────────────────────────────────────────────────────
    function absUrl(u) {
        try { return new URL(u, window.location.href).toString(); } catch (e) { return u; }
    }
    function decodeEntities(s) {
        return String(s || '').replace(/&amp;/g, '&').replace(/&#x2F;/g, '/').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    }
    function guessCategory(name) {
        var n = String(name || '').toLowerCase();
        if (/\b(shoe|boot|sneaker|loafer|sandal|heel|trainer|cleat)s?\b/.test(n)) return 'shoes';
        if (/\b(hat|cap|beanie|fedora)s?\b/.test(n)) return 'hat';
        if (/\b(bag|tote|backpack|purse|handbag|crossbody)s?\b/.test(n)) return 'bag';
        if (/\b(sunglasses|glasses|eyewear)\b/.test(n)) return 'glasses';
        return 'clothing';
    }
    function optionNames(variants) {
        var hasSize = variants.some(function (v) { return v.option1 != null; });
        var hasColor = variants.some(function (v) { return v.option2 != null; });
        var names = [];
        if (hasSize) names.push('Size');
        if (hasColor) names.push('Color');
        return names;
    }

    // ── Product source (a): schema.org JSON-LD ──────────────────────────────
    // Self-contained parser (the widget's own LD parser is URL-gated to
    // Shopify's /products/ paths; SFCC PDPs live on arbitrary SEO URLs).
    function ldNodes() {
        var out = [];
        try {
            document.querySelectorAll('script[type="application/ld+json"]').forEach(function (s) {
                var d; try { d = JSON.parse(s.textContent || 'null'); } catch (e) { return; }
                if (!d) return;
                var list = Array.isArray(d) ? d : (Array.isArray(d['@graph']) ? d['@graph'] : [d]);
                list.forEach(function (n) { if (n && typeof n === 'object') out.push(n); });
            });
        } catch (e) { }
        return out;
    }
    function ldTypeIs(node, t) {
        var ty = node && node['@type'];
        return ty === t || (Array.isArray(ty) && ty.indexOf(t) !== -1);
    }
    function ldImage(img) {
        if (!img) return null;
        if (Array.isArray(img)) img = img[0];
        if (img && typeof img === 'object') img = img.url || img.contentUrl || img['@id'] || null;
        return (typeof img === 'string' && img) ? img : null;
    }
    function ldVariant(v) {
        var color = v.color || v.Color || null;
        var size = v.size || v.Size || null;
        var offer = v.offers; if (Array.isArray(offer)) offer = offer[0];
        var available = !offer || /InStock|LimitedAvailability|PreOrder|BackOrder/i.test(String((offer && offer.availability) || 'InStock'));
        var img = ldImage(v.image);
        // On SFCC the variant sku is normally the orderable pid itself — verify
        // per brand in the pilot sandbox (plan §4 checklist).
        var id = v.sku || v.gtin || (offer && offer.sku) || ('ld:' + [color, size].filter(Boolean).join('/'));
        return {
            id: String(id),
            title: [size, color].filter(Boolean).join(' / ') || (v.name != null ? String(v.name) : ''),
            option1: size != null ? String(size) : null,
            option2: color != null ? String(color) : null,
            available: available,
            featured_image: img ? { src: absUrl(img) } : null,
            price: (offer && offer.price != null) ? offer.price : null
        };
    }
    function buildFromJsonLd() {
        var nodes = ldNodes();
        var node = null;
        for (var i = 0; i < nodes.length; i++) {
            if (ldTypeIs(nodes[i], 'ProductGroup') || ldTypeIs(nodes[i], 'Product')) { node = nodes[i]; break; }
        }
        if (!node) return null;
        var hv = node.hasVariant;
        var variants = (Array.isArray(hv) && hv.length) ? hv.map(ldVariant) : [ldVariant(node)];
        variants = variants.filter(function (v) { return v.featured_image || v.option1 || v.option2 || v.id; });
        var img = ldImage(node.image) ||
            (variants.find(function (v) { return v.available && v.featured_image; }) || {}).featured_image;
        if (img && img.src) img = img.src;
        if (!img) {
            var og = document.querySelector('meta[property="og:image"]');
            img = og && og.content;
        }
        if (!img) return null;

        var name = (node.name != null ? String(node.name) : null) ||
            ((document.querySelector('meta[property="og:title"]') || {}).content) || 'Product';
        var handle = (node.productGroupID != null ? String(node.productGroupID) : null) ||
            (node.sku != null ? String(node.sku) : null) ||
            window.location.pathname.split('/').filter(Boolean).pop() || 'sfcc-product';
        return finishBuild('jsonld', handle, name, absUrl(img), variants, null);
    }

    // ── Product source (b): SFRA DOM + Product-Variation ("Method 7") ───────
    function sfraContainer() {
        return document.querySelector('.product-detail[data-pid]') ||
            document.querySelector('[data-pid].product-wrapper') ||
            document.querySelector('[data-pid][itemtype*="Product"]');
    }
    // Any variation-attribute control on a stock SFRA PDP carries a
    // Product-Variation URL (swatch data-url / select option values).
    function findVariationUrls() {
        var urls = [];
        try {
            var container = sfraContainer() || document;
            var html = container.innerHTML || '';
            var re = /(?:https?:\/\/[^"'\s\\]+|\/[^"'\s\\]+)Product-Variation[^"'\s\\]*/g;
            var m;
            while ((m = re.exec(html)) && urls.length < 200) {
                var u = decodeEntities(m[0]);
                if (urls.indexOf(u) === -1) urls.push(u);
            }
        } catch (e) { }
        return urls;
    }
    function fetchVariation(url) {
        return fetch(absUrl(url), { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .catch(function () { return null; });
    }
    function pvProduct(j) { return (j && (j.product || (j.data && j.data.product))) || null; }
    function pvImage(p) {
        try {
            var groups = p.images || {};
            var list = groups.large || groups.hiRes || groups.medium || groups.small || [];
            if (list && list.length) return list[0].url || list[0].absURL || null;
        } catch (e) { }
        return null;
    }
    function pvPrice(p) {
        try { return (p.price && p.price.sales && p.price.sales.value) != null ? p.price.sales.value : null; } catch (e) { return null; }
    }
    function pvAttr(p, idRe) {
        var attrs = (p && p.variationAttributes) || [];
        for (var i = 0; i < attrs.length; i++) {
            var id = String(attrs[i].attributeId || attrs[i].id || '');
            if (idRe.test(id)) return attrs[i];
        }
        return null;
    }
    function buildFromSfra() {
        var container = sfraContainer();
        if (!container) return Promise.resolve(null);
        var masterPid = container.getAttribute('data-pid');
        var urls = findVariationUrls();
        if (!urls.length) return Promise.resolve(null);
        // Prefer a URL from the SELECTED swatch so the fetched state mirrors the
        // shopper's current color; else take the first control we found.
        var selected = null;
        try {
            var selEl = container.querySelector('.selected [data-url*="Product-Variation"], [data-url*="Product-Variation"].selected, [aria-checked="true"][data-url*="Product-Variation"], option[selected][value*="Product-Variation"]');
            if (selEl) selected = decodeEntities(selEl.getAttribute('data-url') || selEl.getAttribute('value') || '');
        } catch (e) { }
        var seedUrl = selected || urls[0];

        return fetchVariation(seedUrl).then(function (j) {
            var p = pvProduct(j);
            if (!p) return null;
            var name = p.productName || p.name ||
                ((document.querySelector('meta[property="og:title"]') || {}).content) || 'Product';
            var img = pvImage(p);
            if (img) img = absUrl(img); else {
                var og = document.querySelector('meta[property="og:image"]');
                img = (og && og.content) || null;
            }
            if (!img) return null;

            var colorAttr = pvAttr(p, /color|colour/i);
            var sizeAttr = pvAttr(p, /size|length|waist/i);
            var currentColor = null;
            if (colorAttr) {
                var cv = (colorAttr.values || []).find(function (v) { return v.selected; }) || null;
                currentColor = cv ? (cv.displayValue || cv.id) : null;
            }
            var variants = [];
            if (sizeAttr && (sizeAttr.values || []).length) {
                // Lazy variant ids: each size's Product-Variation URL resolves to
                // the real variant pid at add time (sfccvar: prefix, see cart hook).
                (sizeAttr.values || []).forEach(function (v) {
                    if (!v || v.id == null) return;
                    var vurl = v.url ? decodeEntities(v.url) : null;
                    variants.push({
                        id: vurl ? ('sfccvar:' + encodeURIComponent(absUrl(vurl))) : String(v.id),
                        title: [v.displayValue || v.id, currentColor].filter(Boolean).join(' / '),
                        option1: String(v.displayValue || v.id),
                        option2: currentColor,
                        available: v.selectable !== false,
                        featured_image: { src: img },
                        price: pvPrice(p)
                    });
                });
            }
            if (!variants.length) {
                variants.push({
                    id: String(p.id || masterPid),
                    title: name,
                    option1: null,
                    option2: currentColor,
                    available: p.available !== false,
                    featured_image: { src: img },
                    price: pvPrice(p)
                });
            }
            // Fully-resolved combo already on screen → remember its direct pid so
            // no-size products (or preselected sizes) add without any extra fetch.
            var directPid = (p.productType === 'variant' || p.readyToOrder === true) ? (p.id || null) : null;
            return finishBuild('sfra', String(masterPid || p.id), name, img, variants, {
                directPid: directPid,
                price: pvPrice(p)
            });
        });
    }

    // ── Product source (c): schema.org microdata (SiteGenesis, e.g. Boot Barn) ──
    function buildFromMicrodata() {
        var scope = document.querySelector('[itemtype*="schema.org/Product" i]');
        if (!scope) return null;
        var get = function (prop) {
            var el = scope.querySelector('[itemprop="' + prop + '"]');
            if (!el) return null;
            return el.getAttribute('content') || el.getAttribute('src') || el.getAttribute('href') || (el.textContent || '').trim() || null;
        };
        var name = get('name') || ((document.querySelector('meta[property="og:title"]') || {}).content);
        var img = get('image') || ((document.querySelector('meta[property="og:image"]') || {}).content);
        if (!name || !img) return null;
        var pidEl = document.querySelector('[data-pid]');
        var handle = (pidEl && pidEl.getAttribute('data-pid')) ||
            get('sku') || get('productID') ||
            window.location.pathname.split('/').filter(Boolean).pop() || 'sfcc-product';
        var price = parseFloat(String(get('price') || '').replace(/[^0-9.]/g, '')) || null;
        var variants = [{
            id: String(handle), title: String(name), option1: null, option2: null,
            available: true, featured_image: { src: absUrl(img) }, price: price
        }];
        return finishBuild('microdata', String(handle), String(name), absUrl(img), variants, { price: price });
    }

    // ── Assemble the two shapes the widget hooks consume ────────────────────
    function finishBuild(source, handle, name, imageUrl, variants, extra) {
        extra = extra || {};
        state.source = source;
        state.handle = handle;
        state.productJson = {
            id: handle,
            handle: handle,
            title: name,
            options: optionNames(variants),
            variants: variants,
            featured_image: { src: imageUrl },
            images: [imageUrl],
            __sfcc: true,
            __directPid: extra.directPid || null
        };
        state.widgetProduct = {
            id: handle,
            name: name,
            title: name,
            image_url: imageUrl,
            variants: variants,
            featured_image: { src: imageUrl },
            category: guessCategory(name),
            product_url: window.location.href,
            price: extra.price != null ? extra.price : (variants[0] && variants[0].price) || null,
            isFallback: true,
            isPlatform: 'sfcc'
        };
        log('product built via ' + source + ':', name, '(' + variants.length + ' variants)', state.widgetProduct);
        return state.widgetProduct;
    }

    function buildProduct(force) {
        if (state.building) return state.building;
        if (state.widgetProduct && !force) return Promise.resolve(state.widgetProduct);
        state.building = Promise.resolve()
            .then(function () { return buildFromJsonLd(); })
            .then(function (p) { return p || buildFromSfra(); })
            .then(function (p) { return p || buildFromMicrodata(); })
            .catch(function (e) { log('build failed', e); return null; })
            .then(function (p) {
                state.building = null;
                // Saved-look persistence: with the handle known, repaint a saved
                // try-on onto this PDP's hero (mirror-mode parity with Shopify's
                // page-load restore). Retry once — widget-main may still be loading.
                if (p && state.handle) {
                    if (typeof window.elloPdpRestoreForHost === 'function') window.elloPdpRestoreForHost();
                    else setTimeout(function () {
                        if (typeof window.elloPdpRestoreForHost === 'function') window.elloPdpRestoreForHost();
                    }, 2500);
                }
                return p;
            });
        return state.building;
    }

    // ── Widget platform hooks ───────────────────────────────────────────────
    window.ELLO_PLATFORM_PRODUCT = function () { return state.widgetProduct; };
    window.ELLO_PLATFORM_PRODUCT_JSON = function (handle) {
        if (state.productJson && (!handle || String(handle) === String(state.handle))) {
            return Promise.resolve(state.productJson);
        }
        return buildProduct(false).then(function () { return state.productJson; });
    };
    window.ELLO_PLATFORM_URL_HANDLE = function (url) {
        // Conservative: only answer for THIS page (color-correct + previews all
        // key off the current PDP). Foreign URLs return null so Shopify parsing
        // and CTL links behave as before.
        if (!state.handle) return null;
        try {
            var path = /^https?:/i.test(url) ? new URL(url).pathname : String(url).split(/[?#]/)[0];
            if (path === window.location.pathname) return state.handle;
        } catch (e) { }
        return null;
    };

    // ── SFRA add-to-cart driver ─────────────────────────────────────────────
    function atcUrl() {
        if (state.atcUrl) return state.atcUrl;
        var input = document.querySelector('input.add-to-cart-url, .add-to-cart-url');
        var v = input && (input.value || input.getAttribute('value'));
        if (v) { state.atcUrl = absUrl(decodeEntities(v)); return state.atcUrl; }
        var si = siteInfo();
        if (si) {
            state.atcUrl = window.location.origin + '/on/demandware.store/Sites-' + si.siteId + '-Site/' + si.locale + '/Cart-AddProduct';
            return state.atcUrl;
        }
        return null;
    }
    function resolveVariantPid(variantId) {
        var v = String(variantId || '');
        if (v.indexOf('sfccvar:') === 0) {
            var pvUrl = decodeURIComponent(v.slice(8));
            return fetchVariation(pvUrl).then(function (j) {
                var p = pvProduct(j);
                var pid = p && (p.productType === 'variant' || p.readyToOrder === true || !p.variationAttributes) ? p.id : (p && p.id);
                if (!pid) throw new Error('Could not resolve the selected size to a purchasable item.');
                return String(pid);
            });
        }
        return Promise.resolve(v);
    }
    function refreshMinicart(data) {
        var q = data && (data.quantityTotal != null ? data.quantityTotal
            : (data.cart && (data.cart.numItems != null ? data.cart.numItems : (data.cart.items && data.cart.items.length))));
        // Re-fire the site's OWN events through the site's OWN jQuery — custom
        // events only reach handlers registered via the same jQuery instance.
        try {
            var $ = window.jQuery || window.$;
            if ($ && $.fn && $.fn.trigger) {
                $('.minicart').trigger('count:update', data);
                $('body').trigger('product:afterAddToCart', data);
            }
        } catch (e) { }
        try {
            if (q != null) {
                var badge = document.querySelector('.minicart .minicart-quantity, .minicart-quantity');
                if (badge) badge.textContent = q;
            }
        } catch (e) { }
        // Let the brand's analytics see the add exactly like a native one.
        try { if (data && typeof data.reportingURL === 'string') fetch(data.reportingURL, { credentials: 'same-origin' }); } catch (e) { }
    }
    function sfccAddToCart(item) {
        var url = atcUrl();
        if (!url) return Promise.reject(new Error('No SFCC add-to-cart endpoint found on this page.'));
        return resolveVariantPid(item.variantId).then(function (pid) {
            var post = function (extraFields) {
                var body = new URLSearchParams();
                body.set('pid', pid);
                body.set('quantity', String(item.quantity || 1));
                if (extraFields) Object.keys(extraFields).forEach(function (k) { body.set(k, extraFields[k]); });
                return fetch(url, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: body.toString()
                }).then(function (res) {
                    return res.text().then(function (t) {
                        var data = null; try { data = JSON.parse(t); } catch (e) { }
                        return { res: res, data: data };
                    });
                });
            };
            return post(null).then(function (r) {
                var failed = !r.res.ok || !r.data || r.data.error === true || (r.data.csrfError != null);
                if (failed) {
                    // Stock SFRA has no CSRF on Cart-AddProduct; a hardened build
                    // might — scrape a token off an on-page form and retry once.
                    var tok = document.querySelector('input[name="csrf_token"]');
                    if (tok && tok.value) {
                        return post({ csrf_token: tok.value }).then(function (r2) {
                            if (!r2.res.ok || !r2.data || r2.data.error === true) {
                                throw new Error((r2.data && (r2.data.message || r2.data.errorMessage)) || 'Add to cart failed (HTTP ' + r2.res.status + ')');
                            }
                            refreshMinicart(r2.data);
                            return r2.data;
                        });
                    }
                    throw new Error((r.data && (r.data.message || r.data.errorMessage)) || 'Add to cart failed (HTTP ' + r.res.status + ')');
                }
                refreshMinicart(r.data);
                log('added to cart:', pid, 'pliUUID:', r.data && r.data.pliUUID);
                return r.data;
            });
        });
    }
    window.ELLO_CART_HOOK = function (item) { return sfccAddToCart(item || {}); };

    // ── Session + attribution ───────────────────────────────────────────────
    function sessionId() {
        try {
            var m = document.cookie.match(/(?:^|;\s*)ello_session_id=([^;\s]+)/);
            if (m) return decodeURIComponent(m[1]);
        } catch (e) { }
        return window.__elloLoaderSessionId || null;
    }
    // Confirmation-page order beacon — same payload shape as the Shopify web
    // pixel's checkout_completed event, so the backend pipeline is untouched.
    // SFCC checkout is same-origin: the session cookie is simply still there.
    function trackOrder(o) {
        o = o || {};
        var sid = sessionId();
        if (!sid) { log('trackOrder: no ello_session_id — nothing to attribute'); return false; }
        var items = (o.items || o.line_items || []).map(function (i) {
            return {
                product_id: i.productId || i.product_id || null,
                variant_id: i.variantId || i.variant_id || i.sku || null,
                quantity: i.quantity || 1,
                line_price: i.linePrice != null ? String(i.linePrice) : (i.line_price != null ? String(i.line_price) : null),
                title: i.title || null
            };
        });
        var payload = {
            event_type: 'purchase',
            session_id: sid,
            store_slug: storeSlug,
            order_id: o.orderId || o.order_id || null,
            total_price: o.total != null ? String(o.total) : null,
            subtotal_price: o.subtotal != null ? String(o.subtotal) : null,
            currency: o.currency || null,
            line_items: items
        };
        try {
            fetch(backend + '/api/cart-purchase-event', {
                method: 'POST',
                keepalive: true,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).catch(function () { });
        } catch (e) { return false; }
        log('order tracked:', payload.order_id);
        return true;
    }

    // ── Loader bootstrap + open API (Ello Anywhere contract) ────────────────
    if (!floatingOn) {
        var chrome = document.createElement('style');
        chrome.id = 'ello-sfcc-chrome';
        chrome.textContent =
            '#virtualTryonWidget.widget-minimized{display:none !important;}' +
            '#previewWidget{display:none !important;}';
        (document.head || document.documentElement).appendChild(chrome);
    }
    function ensureLoader() {
        if (window.ELLO_STORE_SLUG) return;
        if (document.querySelector('script[src*="widget-loader"]')) return;
        var s = document.createElement('script');
        s.src = backend + '/widget-loader.js';
        s.async = true;
        try { s.dataset.storeSlug = storeSlug; } catch (e) { }
        (document.head || document.documentElement).appendChild(s);
    }
    function isHoldout() {
        return !!(window.__elloAbState && window.__elloAbState.variant === 'holdout');
    }
    function open(arg) {
        if (isHoldout()) return;
        var ctx = typeof arg === 'string' ? { productHandle: arg } : (arg || {});
        buildProduct(false).then(function () {
            var payload = {
                source: ctx.source || 'sfcc_button',
                productHandle: ctx.productHandle || state.handle || null,
                productId: ctx.productId || state.handle || null,
                variantId: ctx.variantId || null
            };
            if (window.Ello && typeof window.Ello.openTryOn === 'function') {
                window.Ello.openTryOn(payload);
            } else {
                (window.__elloPreQueue = window.__elloPreQueue || []).push(payload);
                ensureLoader();
            }
        });
    }
    document.addEventListener('click', function (e) {
        var t = e.target;
        var el = t && t.closest ? t.closest('[data-ello-tryon]') : null;
        if (!el) return;
        if (isHoldout()) return;
        e.preventDefault();
        e.stopPropagation();
        var h = el.getAttribute('data-ello-tryon');
        open({
            productHandle: (h && h !== '1' && h !== 'true') ? h : null,
            variantId: el.getAttribute('data-ello-variant') || null,
            source: 'sfcc_button'
        });
    }, true);
    var gateTries = 0;
    (function holdoutGate() {
        if (isHoldout()) {
            if (!document.getElementById('ello-sfcc-holdout')) {
                var st = document.createElement('style');
                st.id = 'ello-sfcc-holdout';
                st.textContent = '[data-ello-tryon]{display:none !important;}';
                (document.head || document.documentElement).appendChild(st);
            }
            return;
        }
        if (++gateTries < 24) setTimeout(holdoutGate, 500);
    })();

    // ── Keep the product in sync with the host page's variation UI ──────────
    // SFRA re-renders the PDP buy box on color/size selection (AJAX partial) and
    // headless fronts soft-navigate. Rebuild (debounced) on those signals.
    var rebuildTimer = null;
    function scheduleRebuild() {
        if (rebuildTimer) return;
        rebuildTimer = setTimeout(function () {
            rebuildTimer = null;
            state.widgetProduct = null;
            state.productJson = null;
            buildProduct(true);
        }, 350);
    }
    document.addEventListener('change', function (e) {
        var t = e.target;
        if (t && (t.matches && (t.matches('select') || t.matches('input[type="radio"]')))) scheduleRebuild();
    }, true);
    document.addEventListener('click', function (e) {
        var t = e.target;
        if (t && t.closest && t.closest('[data-url*="Product-Variation"], .color-attribute, .swatch, [class*="swatch"]')) scheduleRebuild();
    }, true);
    window.addEventListener('popstate', scheduleRebuild);

    // ── Public API ──────────────────────────────────────────────────────────
    window.ElloSFCC = {
        version: '0.1.0',
        storeSlug: storeSlug,
        open: open,
        trackOrder: trackOrder,
        sessionId: sessionId,
        addToCart: sfccAddToCart,          // direct driver access (tests, host code)
        rebuild: function () { return buildProduct(true); },
        setCartHandler: function (fn) {     // host override still wins (composable)
            if (typeof fn === 'function') window.ELLO_CART_HOOK = fn;
        },
        debug: function () {
            return {
                sfcc: isSfccPage(), site: siteInfo(), source: state.source,
                handle: state.handle, atcUrl: atcUrl(),
                product: state.widgetProduct, productJson: state.productJson
            };
        }
    };

    // ── Boot ────────────────────────────────────────────────────────────────
    ensureLoader();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { buildProduct(false); });
    } else {
        buildProduct(false);
    }
    log('booted · slug:', storeSlug, '· sfcc page:', isSfccPage());
})();
