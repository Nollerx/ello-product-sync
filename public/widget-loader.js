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

    function __elloTryFlush() {
        if (typeof window.elloOpenTryOnFromInline !== 'function') return;
        while (window.__elloInlineQueue.length) {
            try { window.elloOpenTryOnFromInline(window.__elloInlineQueue.shift()); }
            catch (e) { console.error('[Ello] openTryOn from queue failed:', e); }
        }
    }

    // Adopt any pre-queue created by the inline-button block's shim. The shim
    // runs synchronously when the block renders — possibly before this script.
    if (window.Ello && Array.isArray(window.Ello.__elloPreQueue)) {
        window.__elloInlineQueue = window.__elloInlineQueue.concat(window.Ello.__elloPreQueue);
        window.Ello.__elloPreQueue.length = 0;
    } else if (Array.isArray(window.__elloPreQueue)) {
        window.__elloInlineQueue = window.__elloInlineQueue.concat(window.__elloPreQueue);
        window.__elloPreQueue.length = 0;
    }

    // Only install the real Ello API once — subsequent loader executions reuse
    // the first one's queue and forwarding function via window-level state.
    if (typeof window.Ello?.__drain !== 'function') {
        window.Ello = {
            openTryOn: function (ctx) {
                // Tag the surface so widget-main.js can attribute the event correctly
                // even if the caller forgot to pass source.
                if (ctx && !ctx.source) ctx.source = 'inline_button';
                // Check window-level binding at call time — survives multi-loader races.
                if (typeof window.elloOpenTryOnFromInline === 'function') {
                    window.elloOpenTryOnFromInline(ctx);
                } else {
                    window.__elloInlineQueue.push(ctx);
                    // User explicitly asked for try-on — don't wait for requestIdleCallback.
                    if (typeof window.__elloKickInitNow === 'function') {
                        window.__elloKickInitNow();
                    }
                }
            },
            __drain: __elloTryFlush,
            __queueDepth: function () { return window.__elloInlineQueue.length; }
        };
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

    // Derive WIDGET_BASE_URL from this script's own src — automatically matches
    // whichever Cloud Run (staging or production) served the file.
    let WIDGET_BASE_URL;
    const _loaderScript = document.currentScript;
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        WIDGET_BASE_URL = "http://localhost:5173";
        elloLog("🔧 Ello Widget: Running in Local Development Mode");
    } else if (_loaderScript && _loaderScript.src) {
        try {
            WIDGET_BASE_URL = new URL(_loaderScript.src).origin;
        } catch (e) {
            WIDGET_BASE_URL = "https://ello-vto-public-13593516897-u5htiuxfrq-uc.a.run.app";
        }
    } else {
        WIDGET_BASE_URL = "https://ello-vto-public-13593516897-u5htiuxfrq-uc.a.run.app";
    }
    elloLog("[Ello Loader] WIDGET_BASE_URL:", WIDGET_BASE_URL);
    window.ELLO_WIDGET_BASE_URL = WIDGET_BASE_URL;

    // Version string used to cache-bust widget-main.js across deploys.
    const WIDGET_VERSION = '2.7.4';
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
    const storeSlug = currentScript?.dataset?.storeSlug || currentScript?.dataset?.storeId || shop || 'default_store';
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

    // Fetch Supabase config from the server (env-aware — staging vs production auto-resolved)
    elloLog("[Ello Loader] Fetching supabase config from:", WIDGET_BASE_URL + "/api/widget-config");
    let supabaseConfigPromise = fetch(`${WIDGET_BASE_URL}/api/widget-config`, { credentials: 'omit' })
        .then(function (r) { return r.json(); })
        .then(function (cfg) {
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
            // Lead capture (email after Nth try-on) — off by default.
            leadCaptureEnabled: storeConfig.lead_capture_enabled === true,
            leadCaptureAfterN: storeConfig.lead_capture_after_n || 1
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
            floatingWidgetNonPdpEnabled: true
        };
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

            // Manually trigger initialization
            if (typeof window.initializeWidget === 'function') {
                window.initializeWidget();
            }

            // Drain any clicks the inline button queued before widget-main.js
            // was ready. window.elloOpenTryOnFromInline is defined inside
            // widget-main.js — it exists by this line.
            __elloTryFlush();

        } catch (error) {
            console.error("Virtual Try-On Widget failed to load:", error);
            container.innerHTML = '<p style="color: red;">Widget failed to load</p>';
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
