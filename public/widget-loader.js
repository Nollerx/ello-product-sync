(function () {
    // Debug logger — silenced in production. Flip window.__ELLO_DEBUG__ = true in
    // your own browser to see verbose logs. console.warn / console.error stay live.
    var elloLog = function () {
        if (typeof window !== 'undefined' && window.__ELLO_DEBUG__ === true) {
            console.log.apply(console, arguments);
        }
    };

    // ─── window.Ello public API ─────────────────────────────────────────────
    // Multi-loader race protection: when both blocks (floating + inline) are
    // installed on the same page, two copies of THIS script can execute in
    // sequence. Each IIFE has its own closure with its own __elloInlineQueue +
    // __elloDrained. If we naively let the second IIFE overwrite window.Ello,
    // window.Ello.openTryOn closes over the SECOND IIFE's __elloDrained —
    // which never flips to true because widget-main.js's load callback fires
    // on the FIRST IIFE's __elloTryFlush.
    //
    // Fix: keep window.Ello shared across IIFE instances by attaching the
    // queue to window directly, and have openTryOn forward whenever
    // elloOpenTryOnFromInline exists on window (no closure-local "drained"
    // flag to get out of sync between loaders).
    window.__elloInlineQueue = window.__elloInlineQueue || [];

    // Route a queued context to the right widget-main.js entry point. Hub
    // intents (collection / wardrobe) go to elloOpenHubFromInline; everything
    // else is a try-on. Returns false when the matching handler isn't defined
    // yet, so the item stays queued until widget-main.js loads.
    function __elloDispatch(ctx) {
        if (ctx && ctx.__elloPanel) {
            if (typeof window.elloOpenPanelFromInline === 'function') {
                window.elloOpenPanelFromInline(ctx);
                return true;
            }
            return false;
        }
        if (ctx && ctx.__elloHubIntent) {
            if (typeof window.elloOpenHubFromInline === 'function') {
                window.elloOpenHubFromInline(ctx);
                return true;
            }
            return false;
        }
        if (typeof window.elloOpenTryOnFromInline === 'function') {
            window.elloOpenTryOnFromInline(ctx);
            return true;
        }
        return false;
    }

    function __elloTryFlush() {
        if (typeof window.elloOpenTryOnFromInline !== 'function' &&
            typeof window.elloOpenHubFromInline !== 'function' &&
            typeof window.elloOpenPanelFromInline !== 'function') return;
        var requeue = [];
        while (window.__elloInlineQueue.length) {
            var ctx = window.__elloInlineQueue.shift();
            try { if (!__elloDispatch(ctx)) requeue.push(ctx); }
            catch (e) { console.error('[Ello] open from queue failed:', e); }
        }
        if (requeue.length) {
            window.__elloInlineQueue.push.apply(window.__elloInlineQueue, requeue);
        }
    }

    // Adopt any pre-queue created by the inline-button block's shim. The shim
    // runs synchronously when the block renders — possibly before this script.
    // Adopt BOTH pre-queues (not else-if): the inline-button shim writes to
    // window.Ello.__elloPreQueue while the fitting-room block writes to
    // window.__elloPreQueue. When both blocks are installed, draining only one
    // would strand the other surface's early clicks.
    if (window.Ello && Array.isArray(window.Ello.__elloPreQueue)) {
        window.__elloInlineQueue = window.__elloInlineQueue.concat(window.Ello.__elloPreQueue);
        window.Ello.__elloPreQueue.length = 0;
    }
    if (Array.isArray(window.__elloPreQueue)) {
        window.__elloInlineQueue = window.__elloInlineQueue.concat(window.__elloPreQueue);
        window.__elloPreQueue.length = 0;
    }

    // Shared forwarder: dispatch immediately when the matching widget-main.js
    // handler exists; otherwise queue the click and kick init now so an
    // explicit shopper action never waits on requestIdleCallback. Reads
    // window-level handlers at call time, so it survives the multi-loader race.
    function __elloForward(ctx) {
        if (__elloDispatch(ctx)) return;
        window.__elloInlineQueue.push(ctx);
        if (typeof window.__elloKickInitNow === 'function') {
            window.__elloKickInitNow();
        }
    }

    // Only install the real Ello API once — subsequent loader executions reuse
    // the first one's queue and forwarding function via window-level state.
    if (typeof window.Ello?.__drain !== 'function') {
        window.Ello = {
            // Focused PDP try-on popup (the inline-button surface).
            openTryOn: function (ctx) {
                ctx = ctx || {};
                // Tag the surface so widget-main.js attributes the event correctly
                // even if the caller forgot to pass source.
                if (!ctx.source) ctx.source = 'inline_button';
                __elloForward(ctx);
            },
            // Launcher-less Fitting Room hub on the full try-on collection.
            openCollection: function (ctx) {
                ctx = ctx || {};
                ctx.__elloHubIntent = 'collection';
                if (!ctx.source) ctx.source = 'fitting_room_hub';
                __elloForward(ctx);
            },
            // Fitting Room hub opened straight to the shopper's saved looks.
            openWardrobe: function (ctx) {
                ctx = ctx || {};
                ctx.__elloHubIntent = 'wardrobe';
                if (!ctx.source) ctx.source = 'fitting_room_hub';
                __elloForward(ctx);
            },
            // Fitting Room — opens the FULL panel (home) so the shopper can change
            // their photo, browse, view their wardrobe and try on. The primary
            // entry point for the header link / nav menu.
            openFittingRoom: function (ctx) {
                ctx = ctx || {};
                ctx.__elloPanel = true;
                if (!ctx.source) ctx.source = 'fitting_room';
                __elloForward(ctx);
            },
            __drain: __elloTryFlush,
            __queueDepth: function () { return window.__elloInlineQueue.length; }
        };
    }

    // ─── Launcher-less hub triggers (nav link / data attribute fallback) ─────
    // The Fitting Room hub has no bottom-right bubble. The header app block
    // self-wires its own button, but on themes whose header can't take app
    // blocks, merchants instead add a plain nav menu link (href containing
    // "ello-fitting-room") or tag any element with data-ello-hub. We bind those
    // here so the hub works site-wide off a single menu link. Installed once
    // (survives the multi-loader race) with per-element dedupe.
    if (!window.__elloHubBindInstalled) {
        window.__elloHubBindInstalled = true;

        var __elloHubBind = function (el) {
            if (!el || el.getAttribute('data-ello-hub-bound') === '1') return;
            // A/B holdout shoppers must not see the merchant's hub nav link —
            // the panel is suppressed for them, so the link would be a dead
            // click (and a visible Ello surface contaminating the control arm).
            if (window.__elloAbState && window.__elloAbState.variant === 'holdout') {
                el.style.display = 'none';
                return;
            }
            el.setAttribute('data-ello-hub-bound', '1');
            el.addEventListener('click', function (e) {
                var which = (el.getAttribute('data-ello-hub') || '').toLowerCase();
                e.preventDefault();
                try {
                    // Default: open the FULL panel (everything reachable). The
                    // explicit data-ello-hub="wardrobe"/"collection" values still
                    // deep-link straight to those surfaces for anyone who wants it.
                    if (which === 'wardrobe') window.Ello.openWardrobe({ source: 'nav_link' });
                    else if (which === 'collection') window.Ello.openCollection({ source: 'nav_link' });
                    else window.Ello.openFittingRoom({ source: 'nav_link' });
                } catch (err) { console.error('[Ello] fitting room trigger failed:', err); }
            });
        };

        var __elloHubScan = function () {
            var tagged = document.querySelectorAll('[data-ello-hub]');
            for (var i = 0; i < tagged.length; i++) __elloHubBind(tagged[i]);
            // Convention: a normal Shopify nav menu link pointing at
            // "#ello-fitting-room" (or any href containing it) opens the FULL
            // Fitting Room panel (no data-ello-hub → openFittingRoom). A merchant
            // can deep-link instead by adding data-ello-hub="wardrobe"/"collection".
            var links = document.querySelectorAll('a[href*="ello-fitting-room"]');
            for (var j = 0; j < links.length; j++) {
                __elloHubBind(links[j]);
            }
        };

        var __elloHubStart = function () {
            __elloHubScan();
            // Re-scan on DOM changes (late headers, SPA nav), rAF-debounced so
            // repeated mutations stay cheap; per-element dedupe avoids re-binding.
            try {
                var raf = null;
                var mo = new MutationObserver(function () {
                    if (raf) return;
                    raf = requestAnimationFrame(function () { raf = null; __elloHubScan(); });
                });
                mo.observe(document.documentElement, { childList: true, subtree: true });
            } catch (e) { /* MutationObserver unsupported — initial scan still bound */ }
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', __elloHubStart);
        } else {
            __elloHubStart();
        }
        // Manual re-scan hook for themes that inject the trigger very late.
        if (window.Ello) window.Ello.bindHubTriggers = __elloHubScan;
    }

    // Prevent duplicate initialization (must come AFTER window.Ello setup
    // so a second loader script doesn't blow away the queue).
    if (document.getElementById("virtual-tryon-widget-container")) {
        elloLog("⚠️ Ello Widget already loaded - skipping duplicate initialization");
        // If widget-main.js already loaded in the first invocation, drain any
        // queue items that landed between then and now.
        __elloTryFlush();
        return;
    }

    elloLog("✅ Ello Widget Loader v2.7 - Three-surface placement (inline + floating + preview)");

    // ── Dev mode: run LOCAL widget code on a REAL store ──────────────────────
    // On any storefront, append to the URL once:
    //     ?ello_dev=1     → widget served from http://localhost:3000 (persisted
    //                       in this browser via localStorage)
    //     ?ello_dev=http://localhost:5173 → custom local origin
    //     ?ello_dev=0     → back to the deployed widget
    // With `npm run vite` running, EVERYTHING (widget-main.js, widget.html,
    // config, try-on API) comes from the local working tree — edit, refresh the
    // store page, see it. Origins are restricted to localhost so a crafted link
    // can never point another shopper's widget anywhere real; for everyone who
    // hasn't opted in, this whole block is a no-op.
    let ELLO_DEV_ORIGIN = null;
    try {
        const q = new URLSearchParams(window.location.search).get('ello_dev');
        if (q === '0' || q === 'off') localStorage.removeItem('ello_dev_origin');
        else if (q === '1') localStorage.setItem('ello_dev_origin', 'http://localhost:3000');
        else if (q && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(q)) localStorage.setItem('ello_dev_origin', q);
        ELLO_DEV_ORIGIN = localStorage.getItem('ello_dev_origin');
    } catch (e) { /* storage unavailable → dev mode simply stays off */ }

    // Ello Anywhere (non-Shopify host pages): a dynamically-injected copy of
    // this script has NO document.currentScript, so the embedding page may pass
    // config through a global set before injection (ello-anywhere.js does this).
    // Static script tags keep winning whenever their data-attributes exist.
    const AW_CFG = (typeof window.ELLO_ANYWHERE_CONFIG === 'object' && window.ELLO_ANYWHERE_CONFIG) || {};

    // Derive WIDGET_BASE_URL from this script's own src — automatically matches
    // whichever Cloud Run (staging or production) served the file.
    let WIDGET_BASE_URL;
    const _loaderScript = document.currentScript;
    if (ELLO_DEV_ORIGIN
        && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
        WIDGET_BASE_URL = ELLO_DEV_ORIGIN;
        // Always-on warn (not elloLog) so a forgotten dev mode can't hide.
        console.warn('[Ello] DEV MODE — widget + API served from ' + ELLO_DEV_ORIGIN
            + '. Append ?ello_dev=0 to any page URL to turn off.');
    } else if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        // Local dev: serve widget assets from THIS dev server's own origin
        // (whatever port it's on — 3000, 5173, …) so the dev harness works
        // without depending on a fixed port. Only ever runs locally; on a real
        // storefront the hostname is never localhost.
        WIDGET_BASE_URL = window.location.origin;
        elloLog("🔧 Ello Widget: Running in Local Development Mode @", WIDGET_BASE_URL);
    } else if (_loaderScript && _loaderScript.src) {
        try {
            WIDGET_BASE_URL = new URL(_loaderScript.src).origin;
        } catch (e) {
            WIDGET_BASE_URL = "https://ello-vto-public-13593516897-u5htiuxfrq-uc.a.run.app";
        }
    } else if (AW_CFG.backend) {
        // Anywhere dynamic injection: no currentScript, host page told us the origin.
        WIDGET_BASE_URL = AW_CFG.backend;
    } else {
        WIDGET_BASE_URL = "https://ello-vto-public-13593516897-u5htiuxfrq-uc.a.run.app";
    }
    elloLog("[Ello Loader] WIDGET_BASE_URL:", WIDGET_BASE_URL);
    window.ELLO_WIDGET_BASE_URL = WIDGET_BASE_URL;

    // Version string used to cache-bust widget-main.js across deploys.
    const WIDGET_VERSION = '2.8.9';
    // Legacy localStorage cache prefix — older versions stored config here.
    // We sweep any leftover entry on load so returning visitors see fresh config.
    const LEGACY_CONFIG_CACHE_PREFIX = 'ello_widget_config_';

    // Get store configuration from script tag or window context
    const currentScript = document.currentScript;

    // NEW: Robust Shop Detection
    // 1. Prefer window.Shopify.shop (most accurate for the current storefront)
    // 2. Fallback to data-shop attribute (legacy/embedded)
    const detectedShop = window.Shopify?.shop || currentScript?.dataset?.shop || null;
    const shop = detectedShop;

    // Use 'default_store' for testing when no script tag or store slug is provided
    // Support both storeSlug (new) and storeId (legacy) for backward compatibility

    // PRIORITIZE shop domain as the default "slug" if no explicit slug provided
    const storeSlug = currentScript?.dataset?.storeSlug || currentScript?.dataset?.storeId || AW_CFG.storeSlug || shop || 'default_store';
    const storeName = currentScript?.dataset?.storeName || 'default-name';
    const shopDomain = currentScript?.dataset?.shopDomain || shop || null; // keep old field working + new shop
    const storefrontToken = currentScript?.dataset?.storefrontToken || null;


    // Basic tracking config for try-on logging (used by widget-main.js)
    window.elloStoreConfig = {
        id: storeSlug,
        name: storeName,
        shopDomain: shopDomain || storeName || null,
    };

    // Legacy globals (backward compatibility)
    window.ELLO_STORE_SLUG = storeSlug;
    window.ELLO_STORE_ID = storeSlug; // Keep for backward compatibility
    window.ELLO_STORE_NAME = storeName;
    window.ELLO_SHOP = shop; // NEW: Strict shop domain for bootstrap/tracking

    // Mint the shopper session id + ello_session_id cookie NOW, at script parse
    // time — before any config fetch. The web pixel identifies shoppers ONLY by
    // this cookie, and Shopify hands it the current pageview's product_viewed
    // whether or not our config has resolved. Minting used to happen after the
    // config round-trip (inside elloAbApplyHoldout / widget-main), so on the
    // FIRST pageview of every fresh session the pixel found no cookie and
    // silently dropped the view — undercounting product views fleet-wide and
    // starving the A/B readout's product-page join. elloAbEnsureSessionId is
    // idempotent (reuses the existing 7-day id), so the later callers inside
    // the A/B path and widget-main are unaffected. (Function declarations
    // hoist, so calling it here, above its definition, is safe.)
    try { elloAbEnsureSessionId(storeSlug); } catch (e) { /* never break the page */ }

    // Fetch Supabase config from the server (env-aware — staging vs production auto-resolved)
    elloLog("[Ello Loader] Fetching supabase config from:", WIDGET_BASE_URL + "/api/widget-config");
    let supabaseConfigPromise = fetch(`${WIDGET_BASE_URL}/api/widget-config`, { credentials: 'omit' })
        .then(function (r) {
            if (!r.ok) throw new Error('widget-config HTTP ' + r.status);
            return r.json();
        })
        .then(function (cfg) {
            // Shape-check before trusting the response: an origin that answers
            // JSON but isn't the real app (dev-mode vite server, proxy, captive
            // portal) must not poison the config — undefined fields become
            // apikey: "undefined" on the legacy RPC and a guaranteed 401.
            // Throwing here routes to the hardcoded production fallback below.
            if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey) {
                throw new Error('widget-config response missing supabase fields');
            }
            elloLog("[Ello Loader] Supabase config loaded:", cfg.supabaseUrl);
            window.ELLO_SUPABASE_CONFIG = cfg;
            return cfg;
        })
        .catch(function (err) {
            console.error("[Ello Loader] Failed to fetch widget-config, using fallback:", err);
            // Fallback to production if config endpoint is unreachable
            var fallback = {
                supabaseUrl: 'https://rwmvgwnebnsqcyhhurti.supabase.co',
                supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ3bXZnd25lYm5zcWN5aGh1cnRpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDg0MDc1MTgsImV4cCI6MjA2Mzk4MzUxOH0.OYTXiUBDN5IBlFYDHN3MyCwFUkSb8sgUOewBeSY01NY'
            };
            window.ELLO_SUPABASE_CONFIG = fallback;
            return fallback;
        });

    // ─── Store config loading ───────────────────────────────────────────
    // Caching strategy (v2.6.0):
    //   1. Read localStorage synchronously — apply widget config instantly with
    //      zero network wait on repeat visits. Skipped on page reload and when
    //      ?ello_preview=1 is in the URL.
    //   2. Always background-fetch the resolved endpoint (/api/widget-config-resolved)
    //      which proxies the Supabase RPC and adds Cache-Control: max-age=30,
    //      stale-while-revalidate=300. Fresh data is persisted to localStorage
    //      for the next pageview.
    //   3. Page-reload detection (any of Ctrl+R / Cmd+R / hard refresh) bypasses
    //      localStorage AND adds a cache-bust query param so the merchant sees
    //      fresh config on refresh — this is the primary "merchant edited something"
    //      escape hatch.
    //   4. ?ello_preview=1 (used by dashboard "View store" link) triggers the same
    //      bypass for dashboard-driven previews.
    //   5. If the new resolved endpoint errors, falls back to the legacy direct
    //      Supabase RPC call (preserves previous behavior on infra failure).
    // Merchant changes propagate within ~30s for fresh shoppers and instantly on
    // any merchant-side refresh. DB load drops ~60% from amortized session reads.
    function buildConfigFromRow(storeConfig) {
        return {
            storeSlug: storeConfig.store_slug || storeSlug,
            storeId: storeConfig.store_slug || storeSlug,
            storeName: storeName,
            shopDomain: storeConfig.shop_domain || shopDomain || storeName,
            storefrontToken: storeConfig.storefront_token || storefrontToken || null,
            clothingPopulationType: storeConfig.clothing_population_type || 'supabase',
            widgetPrimaryColor: storeConfig.widget_primary_color || null,
            widgetAccentColor: storeConfig.widget_accent_color || null,
            minimizedColor: storeConfig.minimized_color || null,
            // Ops-level per-store style overrides (vto_stores.style_overrides
            // JSONB, no dashboard UI — set by support/Claude directly). Applied
            // by applyStyleOverrides() in widget-main. Null for every store
            // until support sets it.
            styleOverrides: (storeConfig.style_overrides && typeof storeConfig.style_overrides === 'object')
                ? storeConfig.style_overrides : null,
            featuredItemId: storeConfig.featured_item_id || null,
            quickPicksIds: storeConfig.quick_picks_ids || null,
            desktopPreviewEnabled: storeConfig.desktop_preview_enabled !== false,
            desktopPreviewDelay: storeConfig.preview_delay_seconds || 3,
            previewTheme: storeConfig.preview_theme || 'light',
            widgetPosition: storeConfig.widget_position === 'left' ? 'left' : 'right',
            widgetVisibilityMode: storeConfig.widget_visibility_mode === 'smart' ? 'smart' : 'always',
            // ─── Three-surface placement settings ───────────────────────────
            // inline_button_enabled is a hard kill switch — dashboard-side off
            // even hides the button when the merchant has dragged the block in.
            // The seven new columns originate in vto_stores via get_widget_config.
            inlineButtonEnabled: storeConfig.inline_button_enabled !== false,
            inlineButtonText: storeConfig.inline_button_text || 'Try On',
            inlineButtonColor: storeConfig.inline_button_color || null,
            inlineButtonTextColor: storeConfig.inline_button_text_color || null,
            inlineButtonHideWhenOos: storeConfig.inline_button_hide_when_oos === true,
            // Default-off on PDP for new installs (inline button handles PDPs).
            // Migration preserves true for any pre-existing merchant.
            floatingWidgetPdpEnabled: storeConfig.floating_widget_pdp_enabled === true,
            // Default-on off-PDP — bubble is still the discovery tool for home/collections.
            floatingWidgetNonPdpEnabled: storeConfig.floating_widget_non_pdp_enabled !== false,
            // Fitting Room hub on/off (dashboard kill switch) — on by default.
            // Mirrors inlineButtonEnabled: a merchant can disable the whole hub
            // from the dashboard without removing the theme block / nav link.
            fittingRoomEnabled: storeConfig.fitting_room_enabled !== false,
            // PDP image-swap hub mode (no-widget stores: inline button is the
            // sole entry, returning shoppers land on a home, try-on swaps the
            // PDP gallery image). Explicit opt-in, OFF by default so no existing
            // merchant changes. Enabled per-store from the dashboard.
            pdpImageSwapEnabled: storeConfig.pdp_image_swap_enabled === true,
            // Merchant/support CSS selector override for the swap's hero
            // targeting — a HINT the widget verifies (invalid/hidden/tiny →
            // automatic cascade). NULL for every store until support sets it.
            pdpImageSelector: (typeof storeConfig.pdp_image_selector === 'string' && storeConfig.pdp_image_selector.trim())
                ? storeConfig.pdp_image_selector.trim() : null,
            // Complete the Look (outfit-upsell styling rail) — gated ON TOP of
            // pdpImageSwapEnabled. Explicit opt-in, OFF by default.
            completeTheLookEnabled: storeConfig.complete_the_look_enabled === true,
            // CTL proof test: suppress the upsell for the merchant-chosen
            // holdout slice so the dashboard can report causal AOV lift.
            // OFF by default.
            ctlHoldoutEnabled: storeConfig.ctl_holdout_enabled === true,
            ctlHoldoutPercent: typeof storeConfig.ctl_holdout_percent === 'number' ? storeConfig.ctl_holdout_percent : 50,
            // Lead capture (email after Nth try-on) — off by default.
            leadCaptureEnabled: storeConfig.lead_capture_enabled === true,
            leadCaptureAfterN: storeConfig.lead_capture_after_n || 1,
            // Widget-wide A/B holdout (proof test) — OFF by default. When a
            // merchant starts an experiment from the dashboard, a slice of
            // shoppers (ab_holdout_percent) never sees ANY Ello surface while
            // both groups' conversions keep flowing through the pixel.
            abExperimentEnabled: storeConfig.ab_experiment_enabled === true,
            abExperimentId: storeConfig.ab_experiment_id || null,
            abHoldoutPercent: typeof storeConfig.ab_holdout_percent === 'number' ? storeConfig.ab_holdout_percent : 10
        };
    }

    function buildDefaultConfig() {
        return {
            storeSlug: storeSlug,
            storeId: storeSlug,
            storeName: storeName,
            shopDomain: shopDomain || storeName,
            storefrontToken: storefrontToken || null,
            clothingPopulationType: 'supabase',
            widgetPrimaryColor: null,
            widgetAccentColor: null,
            minimizedColor: null,
            styleOverrides: null,
            featuredItemId: null,
            quickPicksIds: null,
            desktopPreviewEnabled: true,
            desktopPreviewDelay: 3,
            previewTheme: 'light',
            widgetPosition: 'right',
            widgetVisibilityMode: 'always',
            // Three-surface defaults match the "new install" column in the plan.
            inlineButtonEnabled: true,
            inlineButtonText: 'Try On',
            inlineButtonColor: null,
            inlineButtonTextColor: null,
            inlineButtonHideWhenOos: false,
            floatingWidgetPdpEnabled: false,
            floatingWidgetNonPdpEnabled: true,
            fittingRoomEnabled: true,
            pdpImageSwapEnabled: false,
            pdpImageSelector: null,
            completeTheLookEnabled: false,
            ctlHoldoutEnabled: false,
            ctlHoldoutPercent: 50,
            abExperimentEnabled: false,
            abExperimentId: null,
            abHoldoutPercent: 10
        };
    }

    // ─── Widget-wide A/B holdout (proof test) ────────────────────────────────
    // When a merchant runs an experiment, shoppers are split deterministically:
    // hash(session_id + ':' + experiment_id) mod 100, holdout when the bucket is
    // below ab_holdout_percent. The hash is FNV-1a 32-bit and is mirrored
    // byte-for-byte by public.ello_ab_bucket() in Postgres, so the widget and
    // the dashboard report can never disagree about who was in which group.
    // (Deliberately NOT the CTL last-char-parity split — independent hashes keep
    // the two experiments unconfounded.)
    //
    // Holdout shoppers still get a session id + pixel cookie (so their views and
    // purchases keep flowing — without that the control group is unmeasurable),
    // and an exposure beacon records both groups' denominators. They just never
    // see any Ello surface: every kill switch in the config is forced off before
    // 'ello:config-resolved' fires, and initializeWidget() bails before any DOM
    // injection or widget-main.js load.
    //
    // Testing overrides (never logged as data): ?ello_ab=holdout / ?ello_ab=exposed
    // persist in localStorage; ?ello_ab=off clears. ?ello_preview=1 always sees
    // the widget and logs nothing.
    var ELLO_AB = { active: false, variant: null, bucket: null, experimentId: null, sessionId: null, override: null };
    window.__elloAbState = ELLO_AB;

    function elloAbFnvBucket(sessionIdStr, experimentIdStr) {
        var str = sessionIdStr + ':' + experimentIdStr;
        var h = 0x811c9dc5;
        for (var i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0) % 100;
    }

    function elloAbGenerateSessionId() {
        return 'session_' + Math.random().toString(36).substring(2, 11);
    }

    // Storage-blocked browsers used to mint a fresh id on EVERY pageview (the
    // catch below regenerated unconditionally), inflating exposure denominators
    // and flip-flopping the shopper between arms. The cookie mirror below is
    // written even when localStorage throws, so read it back before minting.
    function elloAbReadSessionCookie() {
        try {
            var m = document.cookie.match(/(?:^|;\s*)ello_session_id=([^;\s]+)/);
            if (m && /^[A-Za-z0-9_-]{8,64}$/.test(m[1])) return m[1];
            return null;
        } catch (e) { return null; }
    }

    // Mint or refresh the shopper session id — EXACT mirror of widget-main.js's
    // algorithm (same keys, same 7-day sliding window, same cookie mirror), so
    // whichever script runs first both use one id. widget-main.js reads the same
    // localStorage key and reuses it; for storage-blocked browsers it adopts
    // window.__elloLoaderSessionId instead of minting a second ephemeral id.
    function elloAbEnsureSessionId(slug) {
        var key = 'ello_session_id_' + slug;
        var tsKey = 'ello_session_ts_' + slug;
        var maxAgeSec = 7 * 24 * 60 * 60;
        var sid = null;
        try {
            var existing = window.localStorage.getItem(key);
            var lastActive = parseInt(window.localStorage.getItem(tsKey) || '0', 10);
            var now = Date.now();
            if (existing && now - lastActive < maxAgeSec * 1000) {
                sid = existing;
            } else {
                sid = elloAbGenerateSessionId();
                window.localStorage.setItem(key, sid);
            }
            window.localStorage.setItem(tsKey, now.toString());
        } catch (e) {
            sid = elloAbReadSessionCookie() || elloAbGenerateSessionId();
        }
        try {
            document.cookie = 'ello_session_id=' + sid + '; path=/; max-age=' + maxAgeSec + '; SameSite=Lax';
        } catch (e) { /* cookie blocked — pixel linkage falls back to cart attribute */ }
        window.__elloLoaderSessionId = sid;
        return sid;
    }

    function elloAbReadOverride() {
        try {
            var q = new URLSearchParams(window.location.search).get('ello_ab');
            if (q === 'off' || q === '0') { window.localStorage.removeItem('ello_ab_override'); return null; }
            if (q === 'exposed' || q === 'holdout') { window.localStorage.setItem('ello_ab_override', q); return q; }
            return window.localStorage.getItem('ello_ab_override');
        } catch (e) { return null; }
    }

    // Shared transport for the exposure beacons below — sendBeacon first
    // (survives navigation), keepalive fetch as the fallback.
    function elloAbSendBeacon(payload) {
        var url = WIDGET_BASE_URL + '/api/cart-purchase-event';
        var sent = false;
        if (navigator.sendBeacon) {
            try { sent = navigator.sendBeacon(url, new Blob([payload], { type: 'text/plain' })); } catch (e) { }
        }
        if (!sent) {
            fetch(url, {
                method: 'POST',
                credentials: 'omit',
                keepalive: true,
                headers: { 'Content-Type': 'text/plain' },
                body: payload
            }).catch(function () { });
        }
    }

    function elloAbLogExposure(state, cfg) {
        try {
            // Once per (experiment, session): marker stores the session id so a
            // rotated session re-fires; the server also dedupes on conflict.
            var marker = 'ello_ab_seen_' + state.experimentId;
            try { if (window.localStorage.getItem(marker) === state.sessionId) return; } catch (e) { }
            var onPdp = window.location.pathname.indexOf('/products/') !== -1;
            elloAbSendBeacon(JSON.stringify({
                event_type: 'ab_exposure',
                store_slug: cfg.storeSlug || storeSlug,
                session_id: state.sessionId,
                experiment_id: state.experimentId,
                variant: state.variant,
                bucket: state.bucket,
                page_type: onPdp ? 'product' : 'other',
                // page_type freezes at the session's FIRST pageview (usually
                // home/collections), so by itself it can't answer "did this
                // shopper ever reach a product page?". saw_pdp starts true for
                // product-page landings and is upgraded later for everyone
                // else by elloAbMarkPdpSeen below.
                saw_pdp: onPdp
            }));
            try {
                window.localStorage.setItem(marker, state.sessionId);
                if (onPdp) window.localStorage.setItem('ello_ab_pdp_' + state.experimentId, state.sessionId);
            } catch (e) { }
        } catch (e) { /* exposure logging must never break the page */ }
    }

    // Stamp saw_pdp=true on this session's exposure row the first time the
    // shopper reaches ANY product page. Without this second stamp the only
    // available test denominator is "every visitor session" (homepage bounces
    // included), whose conversion rate reads several times lower than the
    // merchant's own product-page rate and invites the wrong conclusion about
    // the widget. Fires for BOTH arms so the product-page comparison stays
    // symmetric; once per (experiment, session); the server upsert is
    // idempotent, so storage-blocked repeats are harmless.
    function elloAbMarkPdpSeen(state, cfg) {
        try {
            if (window.location.pathname.indexOf('/products/') === -1) return;
            var marker = 'ello_ab_pdp_' + state.experimentId;
            try { if (window.localStorage.getItem(marker) === state.sessionId) return; } catch (e) { /* storage blocked — server dedupes */ }
            elloAbSendBeacon(JSON.stringify({
                event_type: 'ab_exposure',
                store_slug: cfg.storeSlug || storeSlug,
                session_id: state.sessionId,
                experiment_id: state.experimentId,
                variant: state.variant,
                bucket: state.bucket,
                page_type: 'product',
                saw_pdp: true
            }));
            try { window.localStorage.setItem(marker, state.sessionId); } catch (e) { /* storage blocked — server dedupes */ }
        } catch (e) { /* pdp stamp must never break the page */ }
    }

    // Purchase attribution has two carriers: the ello_session_id cookie and the
    // ello_session_id cart attribute (the pixel falls back to the attribute when
    // the cookie is unreadable at checkout — 7-day expiry, cross-origin wallet
    // checkout, consent tools purging cookies). widget-main.js writes the
    // attribute after a try-on, but holdout shoppers never load widget-main, so
    // their purchases had ONLY the cookie: every cookie-loss purchase was
    // recovered in the exposed arm and silently dropped in the holdout arm,
    // overstating measured lift. During an experiment the loader writes the
    // SAME attribute for BOTH arms so recovery is symmetric. Once per session
    // (marker stores the sid so a rotated session re-writes); best-effort and
    // idempotent — writing to an empty cart is fine, Shopify carries the
    // attribute forward once items land.
    function elloAbWriteCartAttr(sid) {
        try {
            if (!sid || !window.Shopify) return;   // real storefronts only — dev harness mocks /cart
            // Marker = sid + write time. Re-write when the session rotates OR
            // hourly: checkout completes the cart and Shopify mints a fresh one
            // WITHOUT the attribute, and only exposed shoppers get re-writes
            // from widget-main — a permanent marker would quietly re-open the
            // asymmetry for repeat purchasers. ≤1 POST/hour/shopper.
            var marker = 'ello_cart_attr_' + storeSlug;
            try {
                var prev = (window.localStorage.getItem(marker) || '').split('|');
                if (prev[0] === sid && Date.now() - parseInt(prev[1] || '0', 10) < 3600000) return;
            } catch (e) { }
            fetch('/cart/update.js', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ attributes: { ello_session_id: sid } })
            }).then(function (res) {
                if (res && res.ok) {
                    try { window.localStorage.setItem(marker, sid + '|' + Date.now()); } catch (e) { }
                }
            }).catch(function () { /* retried next pageview */ });
        } catch (e) { /* attribution write must never break the page */ }
    }

    // Decide the shopper's variant and, for holdout, force every surface's kill
    // switch off IN the config object so the inline button, preview popup,
    // fitting-room hub and PDP swap all hide through their normal pathways.
    // Runs inside applyConfig — the single choke point for both the localStorage
    // fast path and the fresh fetch.
    function elloAbApplyHoldout(cfg) {
        if (!cfg || cfg.abExperimentEnabled !== true || !cfg.abExperimentId) return cfg;
        var isPreview = false;
        try { isPreview = new URLSearchParams(window.location.search).get('ello_preview') === '1'; } catch (e) { }
        var override = elloAbReadOverride();
        // CRITICAL: mint under the loader's script-tag slug (`storeSlug`), NOT
        // cfg.storeSlug. widget-main.js keys its session on window.ELLO_STORE_ID,
        // which THIS loader sets from the same `storeSlug` variable — the DB
        // row's store_slug can differ (e.g. 'ecmxv0-vh' vs the full
        // '*.myshopify.com' domain), and a key mismatch would mint two different
        // ids, overwrite the pixel cookie, and silently orphan every exposed-arm
        // purchase from its exposure row. Keep cfg.storeSlug for the beacon's
        // store_slug FIELD only (that must match the event tables).
        var sid = ELLO_AB.sessionId || elloAbEnsureSessionId(storeSlug);
        var bucket = elloAbFnvBucket(sid, cfg.abExperimentId);
        var pct = typeof cfg.abHoldoutPercent === 'number' ? cfg.abHoldoutPercent : 10;
        var variant = bucket < pct ? 'holdout' : 'exposed';
        if (override === 'exposed' || override === 'holdout') variant = override;
        if (isPreview) variant = 'exposed';
        ELLO_AB.active = true;
        ELLO_AB.variant = variant;
        ELLO_AB.bucket = bucket;
        ELLO_AB.experimentId = cfg.abExperimentId;
        ELLO_AB.sessionId = sid;
        ELLO_AB.override = override || (isPreview ? 'preview' : null);

        // Both arms, every path (including lateHoldout below): symmetric
        // purchase-attribution carrier for the pixel's cart-attribute fallback.
        elloAbWriteCartAttr(sid);

        // Late-arriving experiment config (cached config had no experiment, UI
        // already injected): don't half-hide the page and don't log a
        // contaminated holdout exposure — the next pageview decides cleanly.
        if (variant === 'holdout' && window.__elloAbUiInjected === true) {
            ELLO_AB.lateHoldout = true;
            return cfg;
        }

        // Overridden/preview sessions are excluded from the data entirely.
        if (!ELLO_AB.override) {
            elloAbLogExposure(ELLO_AB, cfg);
            elloAbMarkPdpSeen(ELLO_AB, cfg);
        }

        if (variant === 'holdout') {
            // Hub triggers bound before the config resolved are already
            // wired and visible — hide them now (new ones are hidden at
            // bind time in __elloHubBind).
            try {
                var hubEls = document.querySelectorAll('a[href*="ello-fitting-room"], [data-ello-hub]');
                for (var hubI = 0; hubI < hubEls.length; hubI++) hubEls[hubI].style.display = 'none';
            } catch (e) { /* hub hide must never break config apply */ }
            cfg.__elloAbHoldout = true;
            cfg.inlineButtonEnabled = false;
            cfg.floatingWidgetPdpEnabled = false;
            cfg.floatingWidgetNonPdpEnabled = false;
            cfg.fittingRoomEnabled = false;
            cfg.pdpImageSwapEnabled = false;
            cfg.completeTheLookEnabled = false;
            cfg.desktopPreviewEnabled = false;
        }
        return cfg;
    }

    function getMinimizedFirstPaintStyles(color) {
        if (!color || !/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(color.trim())) {
            return [];
        }

        let hex = color.trim().replace('#', '');
        if (hex.length === 3) {
            hex = hex.split('').map(function (char) { return char + char; }).join('');
        }

        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        const lighterR = Math.min(255, r + 30);
        const lighterG = Math.min(255, g + 30);
        const lighterB = Math.min(255, b + 30);
        const darkerR = Math.max(0, r - 20);
        const darkerG = Math.max(0, g - 20);
        const darkerB = Math.max(0, b - 20);
        const gradient = `linear-gradient(135deg, rgb(${darkerR}, ${darkerG}, ${darkerB}) 0%, rgb(${r}, ${g}, ${b}) 50%, rgb(${lighterR}, ${lighterG}, ${lighterB}) 100%)`;
        const brightness = (r * 299 + g * 587 + b * 114) / 1000;
        const textColor = brightness > 128 ? '#333' : '#fff';
        const textShadow = brightness > 128
            ? '0 2px 4px rgba(255,255,255,0.8)'
            : '0 2px 4px rgba(0,0,0,0.8)';

        return [
            `--minimized-bg: ${color.trim()}`,
            `--minimized-text-color: ${textColor}`,
            `--minimized-text-shadow: ${textShadow}`,
            `background: ${gradient} !important`
        ];
    }

    function applyConfig(cfg) {
        cfg = elloAbApplyHoldout(cfg);
        window.ELLO_STORE_CONFIG = cfg;
        window.elloStoreConfig = {
            id: cfg.storeId,
            name: cfg.storeName,
            shopDomain: cfg.shopDomain,
        };
        // Notify the inline-button block (and anything else listening) so it
        // can restyle from dashboard config now that ELLO_STORE_CONFIG is set.
        // Fires on every applyConfig — both the localStorage fast-path and the
        // fresh fetch — so the button updates instantly when merchant changes
        // settings and propagates within ~30s on the next pageview.
        try {
            window.dispatchEvent(new CustomEvent('ello:config-resolved', { detail: cfg }));
        } catch (e) {
            // CustomEvent constructor not supported in some legacy browsers —
            // the inline block has its own readiness polling as a backstop.
        }
    }

    // Sweep any leftover config cache from earlier widget versions so returning
    // visitors don't accidentally render stale colors/positions on first load
    // after the upgrade.
    function clearLegacyConfigCache(cacheKeyId) {
        try {
            window.localStorage.removeItem(LEGACY_CONFIG_CACHE_PREFIX + cacheKeyId);
        } catch (e) {
            // Private mode / disabled storage — nothing to clean up anyway
        }
    }

    // Create a promise to handle store configuration loading with smart caching
    let storeConfigPromise = new Promise((resolve) => {
        const cacheKeyId = shop || storeSlug;
        const SHOP_KEY = 'ello_config_' + cacheKeyId;

        // Sweep any leftover cache from earlier widget versions on every load.
        clearLegacyConfigCache(cacheKeyId);

        // ─── Detect when we should skip localStorage and force-fresh fetch ───
        // Page reload (Ctrl+R, Cmd+R, hard refresh Ctrl+Shift+R) → merchant likely
        // wants fresh data. ?ello_preview=1 → dashboard preview link, force-fresh.
        let isReload = false;
        try {
            const navEntries = performance.getEntriesByType?.('navigation');
            isReload = navEntries?.[0]?.type === 'reload';
        } catch (e) {
            // Legacy Performance.navigation API fallback for older browsers
            try { isReload = performance.navigation?.type === 1; } catch (_) {}
        }
        let isPreview = false;
        try {
            isPreview = new URLSearchParams(window.location.search).get('ello_preview') === '1';
        } catch (e) {}
        const shouldBypassCache = isReload || isPreview;
        elloLog('[Ello Loader] Cache strategy:', { isReload, isPreview, shouldBypassCache });

        // ─── Promise resolution guard — resolve exactly once ─────────────────
        let promiseResolved = false;
        function applyAndResolveOnce(row) {
            applyConfig(buildConfigFromRow(row));
            if (!promiseResolved) {
                promiseResolved = true;
                resolve(window.ELLO_STORE_CONFIG);
            }
        }

        function persistToLocalStorage(row, version) {
            try {
                window.localStorage.setItem(SHOP_KEY, JSON.stringify({
                    config: row,
                    version: version,
                    cachedAt: Date.now()
                }));
            } catch (e) {
                // Private mode / quota exceeded — non-fatal, just no persistence
            }
        }

        function buildResolvedUrl(cacheBust) {
            const params = new URLSearchParams();
            const explicitSlug = currentScript?.dataset?.storeSlug || currentScript?.dataset?.storeId;
            if (explicitSlug)      params.set('store_slug', storeSlug);
            else if (shop)         params.set('shop', shop);
            else                   params.set('store_slug', storeSlug);
            if (cacheBust)         params.set('_t', String(Date.now()));
            return `${WIDGET_BASE_URL}/api/widget-config-resolved?${params.toString()}`;
        }

        // ─── Fast path: apply localStorage instantly (if not reload/preview) ──
        let cachedVersion = -1;
        if (!shouldBypassCache) {
            try {
                const raw = window.localStorage.getItem(SHOP_KEY);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (parsed?.config) {
                        cachedVersion = Number(parsed.version) || 0;
                        elloLog('[Ello Loader] Using cached config v' + cachedVersion);
                        applyAndResolveOnce(parsed.config);
                    }
                }
            } catch (e) {
                elloLog('[Ello Loader] localStorage read failed:', e);
            }
        }

        // ─── Always background-fetch from the resolved endpoint ──────────────
        fetch(buildResolvedUrl(shouldBypassCache), {
            method: 'GET',
            credentials: 'omit',
            cache: shouldBypassCache ? 'reload' : 'default',
        })
            .then(function (r) {
                if (!r.ok) throw new Error('Resolved endpoint HTTP ' + r.status);
                return r.json();
            })
            .then(function (payload) {
                if (!payload || !payload.config) {
                    if (!promiseResolved) {
                        applyConfig(buildDefaultConfig());
                        elloLog('⚠️ Store not found, using default configuration');
                        promiseResolved = true;
                        resolve(window.ELLO_STORE_CONFIG);
                    }
                    return;
                }
                const freshVersion = Number(payload.version) || 0;
                if (cachedVersion === freshVersion) {
                    elloLog('[Ello Loader] Cache already current (v' + freshVersion + ')');
                    return;
                }
                elloLog('[Ello Loader] Persisting fresh config v' + freshVersion + ' (was v' + cachedVersion + ')');
                persistToLocalStorage(payload.config, freshVersion);
                applyAndResolveOnce(payload.config);
            })
            .catch(function (err) {
                console.warn('[Ello Loader] Resolved endpoint failed, using direct RPC fallback:', err);
                fetchStoreConfigurationLegacy();
            });

        // ─── Legacy fallback: direct Supabase RPC (preserves prior behavior) ──
        // Only invoked if the new resolved endpoint errors. Mirrors the original
        // implementation so any Cloud Run outage still lets widgets boot.
        function fetchStoreConfigurationLegacy() {
            supabaseConfigPromise.then(function (sbConfig) {
                let rpcBody = {};
                const explicitSlug = currentScript?.dataset?.storeSlug || currentScript?.dataset?.storeId;
                if (explicitSlug)      rpcBody = { p_store_slug: storeSlug };
                else if (shop)         rpcBody = { p_shop_domain: shop };
                else                   rpcBody = { p_store_slug: storeSlug };

                fetch(`${sbConfig.supabaseUrl}/rest/v1/rpc/get_widget_config`, {
                    method: 'POST',
                    credentials: 'omit',
                    headers: {
                        'apikey': sbConfig.supabaseAnonKey,
                        'Authorization': 'Bearer ' + sbConfig.supabaseAnonKey,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(rpcBody)
                })
                    .then(function (response) {
                        if (!response.ok) throw new Error('Legacy RPC HTTP ' + response.status);
                        return response.json();
                    })
                    .then(function (data) {
                        if (data && data.length > 0) {
                            const row = data[0];
                            const version = Number(row.config_version) || 0;
                            persistToLocalStorage(row, version);
                            applyAndResolveOnce(row);
                        } else if (!promiseResolved) {
                            applyConfig(buildDefaultConfig());
                            elloLog('⚠️ Store not found via legacy RPC, using default configuration');
                            promiseResolved = true;
                            resolve(window.ELLO_STORE_CONFIG);
                        }
                    })
                    .catch(function (error) {
                        console.error('❌ Both resolved endpoint and legacy RPC failed:', error);
                        if (!promiseResolved) {
                            applyConfig(buildDefaultConfig());
                            promiseResolved = true;
                            resolve(window.ELLO_STORE_CONFIG);
                        }
                    });
            });
        }
    });

    // Helper to call widget-bootstrap edge function
    async function fetchBootstrap(shop) {
        if (!shop) return null;
        try {
            const res = await fetch(
                `${WIDGET_BASE_URL}/bootstrap`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ shop })
                }
            );
            if (!res.ok) {
                const text = await res.text().catch(() => "");
                console.warn(`Bootstrap fetch failed ${res.status}: ${text}`);
                return null;
            }
            return await res.json();
        } catch (e) {
            console.warn("Bootstrap fetch error:", e);
            return null;
        }
    }

    // Create container
    const container = document.createElement('div');
    container.id = "virtual-tryon-widget-container";
    document.body.appendChild(container);

    // Function to load and execute script (async to avoid blocking the main thread)
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.onload = resolve;
            script.onerror = reject;
            document.body.appendChild(script);
        });
    }

    // Main initialization function that waits for store config
    async function initializeWidget() {
        try {
            // Start fetching HTML immediately (in parallel with store config)
            const htmlPromise = fetch(`${WIDGET_BASE_URL}/widget.html?v=${WIDGET_VERSION}`, {
                method: 'GET',
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                }
            }).then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                return response.text();
            });

            // Run bootstrap in parallel
            // pass strict shop if available, else fall back to legacy shopDomain
            elloLog("Loader: bootstrapping for shop:", shop || shopDomain);
            const bootstrapPromise = fetchBootstrap(shop || shopDomain).catch((e) => {
                console.warn("⚠️ bootstrap failed (continuing legacy)", e);
                return null;
            });

            // Expose promise for widget-main.js to consume
            window.ELLO_BOOTSTRAP_PROMISE = bootstrapPromise;

            // Only wait for store config + HTML — bootstrap runs in background.
            // widget-main.js consumes bootstrap via window.ELLO_BOOTSTRAP_PROMISE
            // so there's no reason to block the initial DOM injection on it.
            const [storeConfig, html] = await Promise.all([
                storeConfigPromise,
                htmlPromise
            ]);

            // A/B holdout: this shopper is in the control group — no Ello UI at
            // all this pageview. Session id + pixel cookie + exposure beacon
            // were already handled in applyConfig, so their conversions still
            // count; we simply never inject DOM or load widget-main.js.
            if (storeConfig && storeConfig.__elloAbHoldout === true) {
                // Exception: the inline button's 1500ms force-reveal can race a
                // slow cold-visit config fetch, so a holdout shopper may have
                // already CLICKED Try On before the decision landed. A queued
                // click with no widget would be swallowed forever — a visibly
                // broken button on the merchant's PDP. Serving the shopper wins
                // over experiment purity: load the widget for this rare
                // contaminated pageview (their exposure row slightly dilutes
                // holdout; the effect is conservative — it shrinks lift, never
                // inflates it).
                if (window.__elloInlineQueue && window.__elloInlineQueue.length > 0) {
                    console.warn('[Ello] holdout shopper clicked before config resolved — serving widget to honor the click');
                } else {
                    elloLog('[Ello Loader] A/B holdout — widget suppressed for this shopper');
                    return;
                }
            }
            window.__elloAbUiInjected = true;

            // Merge bootstrap data when it resolves (non-blocking)
            bootstrapPromise.then(bootstrapData => {
                if (bootstrapData?.store?.storefront_token && !window.ELLO_STORE_CONFIG?.storefrontToken) {
                    window.ELLO_STORE_CONFIG = window.ELLO_STORE_CONFIG || {};
                    window.ELLO_STORE_CONFIG.storefrontToken = bootstrapData.store.storefront_token;
                    if (!window.ELLO_STORE_CONFIG.clothingPopulationType || window.ELLO_STORE_CONFIG.clothingPopulationType === 'supabase') {
                        window.ELLO_STORE_CONFIG.clothingPopulationType = bootstrapData.store.clothing_population_type || 'shopify';
                    }
                }
            });

            // Parse the HTML
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            // Extract styles from head
            const styles = doc.querySelectorAll('style');
            let styleContent = '';
            styles.forEach(style => {
                styleContent += style.innerHTML + '\n';
            });

            // Create and inject style element
            if (styleContent) {
                const styleElement = document.createElement('style');
                styleElement.innerHTML = styleContent;
                document.head.appendChild(styleElement);
            }

            // Inject link elements — make stylesheets non-render-blocking to protect merchant LCP
            const links = doc.querySelectorAll('link[rel="stylesheet"], link[rel="preconnect"], link[rel="icon"], link[rel="preload"]');
            links.forEach(link => {
                const linkElement = document.createElement('link');
                Array.from(link.attributes).forEach(attr => {
                    linkElement.setAttribute(attr.name, attr.value);
                });
                // Force external stylesheets to load async (media swap trick)
                if (link.getAttribute('rel') === 'stylesheet' && !link.getAttribute('media')) {
                    linkElement.setAttribute('media', 'print');
                    linkElement.onload = function() { this.media = 'all'; };
                }
                document.head.appendChild(linkElement);
            });

            // Remove script tags from body
            const scripts = doc.querySelectorAll('script');
            scripts.forEach(script => script.remove());

            // Fix image paths to use hosted URL
            const images = doc.querySelectorAll('img[id="goodExampleImage"], img[id="badExampleImage"]');
            images.forEach(img => {
                const currentSrc = img.getAttribute('src');
                // If it's a relative path (doesn't start with http:// or https://), make it absolute
                if (currentSrc && !currentSrc.startsWith('http://') && !currentSrc.startsWith('https://')) {
                    img.setAttribute('src', `${WIDGET_BASE_URL}/${currentSrc}`);
                }
            });

            // FOUC guards — modify the parsed widget element BEFORE injection so
            // it paints in its final position/visibility on the very first frame.
            // Without this, the widget renders with default CSS (right side, visible)
            // for one frame, then widget-main.js's JS hooks shift it — the "flash"
            // merchants reported on left-positioned + smart-mode stores.
            const widgetEl = doc.getElementById('virtualTryonWidget');
            if (widgetEl && window.ELLO_STORE_CONFIG) {
                const cfg = window.ELLO_STORE_CONFIG;
                const inlineStyles = [];
                const onPdp = window.location.pathname.includes('/products/');

                // Three-surface placement: respect the per-page-type kill switches.
                // PDP-off / non-PDP-off both hide the bubble on first paint so the
                // shopper never sees it flicker in before JS reads the config.
                if (onPdp && cfg.floatingWidgetPdpEnabled === false) {
                    inlineStyles.push('display: none !important');
                } else if (!onPdp && cfg.floatingWidgetNonPdpEnabled === false) {
                    inlineStyles.push('display: none !important');
                } else if (cfg.widgetVisibilityMode === 'smart' && onPdp) {
                    // Legacy smart-visibility (kept for back-compat) — born-hide
                    // on PDP until the catalog loads and confirms the product is
                    // enabled. Only runs when floating PDP itself is on.
                    inlineStyles.push('display: none !important');
                }

                // Position — match the dashboard setting on first paint.
                if (cfg.widgetPosition === 'left') {
                    inlineStyles.push('left: 20px !important', 'right: auto !important', 'transform-origin: left bottom !important');
                }

                inlineStyles.push.apply(inlineStyles, getMinimizedFirstPaintStyles(cfg.minimizedColor));

                if (inlineStyles.length) {
                    widgetEl.setAttribute('style', inlineStyles.join('; ') + ';');
                }
            }

            // Get the body content
            const bodyContent = doc.body.innerHTML;

            // Inject the HTML
            container.innerHTML = bodyContent;

            // Now load the script - also using version instead of timestamp
            await loadScript(`${WIDGET_BASE_URL}/widget-main.js?v=${WIDGET_VERSION}`);

            // Manually trigger initialization. Prefer the Ello-prefixed name —
            // the bare `initializeWidget` may belong to the theme or another
            // app, and calling (or having widget-main.js overwrite) it broke
            // merchant pages. Bare-name fallback covers a cached older
            // widget-main.js that only defines the legacy global.
            if (typeof window.__elloInitializeWidget === 'function') {
                window.__elloInitializeWidget();
            } else if (typeof window.initializeWidget === 'function') {
                window.initializeWidget();
            }

            // Drain any clicks the inline button queued before widget-main.js
            // was ready. window.elloOpenTryOnFromInline is defined inside
            // widget-main.js — it exists by this line.
            __elloTryFlush();

        } catch (error) {
            // Fail invisibly: never paint our failure onto the merchant's live page.
            // On any load/init error, log for us and hide the container so the
            // shopper's PDP is left exactly as if the widget were not installed.
            console.error("Virtual Try-On Widget failed to load:", error);
            try {
                container.innerHTML = '';
                container.style.display = 'none';
            } catch (_) { /* container may not exist yet — nothing to clean up */ }
        }
    }

    // Defer initialization until the browser is idle to protect merchant LCP.
    // The widget is a floating button — it doesn't need to render before the page's
    // main content, so yielding to the browser here is safe.
    //
    // __elloKickInitNow lets the inline button short-circuit this wait when a
    // shopper has explicitly clicked Try On — no point yielding to idle when
    // the user is already waiting on us. Idempotent; safe to call multiple times.
    let __initStarted = false;
    let __idleHandle = null;
    function __elloStartInit() {
        if (__initStarted) return;
        __initStarted = true;
        if (__idleHandle != null && typeof cancelIdleCallback === 'function') {
            try { cancelIdleCallback(__idleHandle); } catch (e) { /* noop */ }
        }
        initializeWidget();
    }
    window.__elloKickInitNow = __elloStartInit;

    if (typeof requestIdleCallback === 'function') {
        __idleHandle = requestIdleCallback(__elloStartInit, { timeout: 3000 });
    } else {
        // Safari fallback — requestIdleCallback not supported
        setTimeout(__elloStartInit, 0);
    }
})();
