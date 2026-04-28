(function () {
    // Prevent duplicate initialization
    if (document.getElementById("virtual-tryon-widget-container")) {
        console.log("⚠️ Ello Widget already loaded - skipping duplicate initialization");
        return;
    }

    console.log("✅ Ello Widget Loader v2.2 - Environment-aware");

    // Derive WIDGET_BASE_URL from this script's own src — automatically matches
    // whichever Cloud Run (staging or production) served the file.
    let WIDGET_BASE_URL;
    const _loaderScript = document.currentScript;
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        WIDGET_BASE_URL = "http://localhost:5173";
        console.log("🔧 Ello Widget: Running in Local Development Mode");
    } else if (_loaderScript && _loaderScript.src) {
        try {
            WIDGET_BASE_URL = new URL(_loaderScript.src).origin;
        } catch (e) {
            WIDGET_BASE_URL = "https://ello-vto-public-13593516897-u5htiuxfrq-uc.a.run.app";
        }
    } else {
        WIDGET_BASE_URL = "https://ello-vto-public-13593516897-u5htiuxfrq-uc.a.run.app";
    }
    console.log("[Ello Loader] WIDGET_BASE_URL:", WIDGET_BASE_URL);
    window.ELLO_WIDGET_BASE_URL = WIDGET_BASE_URL;

    // Version for caching — update this when major changes occur to force refresh
    // Also acts as the localStorage cache version key (mismatch invalidates cached config)
    const WIDGET_VERSION = '2.4.5';
    const CONFIG_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

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
    console.log("[Ello Loader] Fetching supabase config from:", WIDGET_BASE_URL + "/api/widget-config");
    let supabaseConfigPromise = fetch(`${WIDGET_BASE_URL}/api/widget-config`, { credentials: 'omit' })
        .then(function (r) { return r.json(); })
        .then(function (cfg) {
            console.log("[Ello Loader] Supabase config loaded:", cfg.supabaseUrl);
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

    // ─── Store config cache (localStorage, 1hr TTL, stale-while-revalidate) ──
    // Cuts Supabase egress: cached page-loads skip the get_widget_config RPC entirely.
    // Version-keyed: bumping WIDGET_VERSION invalidates all cached configs.
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
            widgetVisibilityMode: storeConfig.widget_visibility_mode === 'smart' ? 'smart' : 'always'
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
            widgetVisibilityMode: 'always'
        };
    }

    function applyConfig(cfg) {
        window.ELLO_STORE_CONFIG = cfg;
        window.elloStoreConfig = {
            id: cfg.storeId,
            name: cfg.storeName,
            shopDomain: cfg.shopDomain,
        };
    }

    function getCachedConfigRow(cacheKey) {
        try {
            const raw = window.localStorage.getItem(cacheKey);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || parsed.v !== WIDGET_VERSION || !parsed.ts || !parsed.config) return null;
            return parsed;
        } catch (e) {
            return null;
        }
    }

    function setCachedConfigRow(cacheKey, configRow) {
        try {
            window.localStorage.setItem(cacheKey, JSON.stringify({
                v: WIDGET_VERSION,
                ts: Date.now(),
                config: configRow,
            }));
        } catch (e) {
            // Quota / private mode / disabled storage — silently skip
        }
    }

    // Create a promise to handle store configuration loading
    let storeConfigPromise = new Promise((resolve) => {
        function fetchStoreConfiguration() {
            supabaseConfigPromise.then(function (sbConfig) {
                let rpcBody = {};
                let cacheKeyId;
                const explicitSlug = currentScript?.dataset?.storeSlug || currentScript?.dataset?.storeId;

                if (explicitSlug) {
                    rpcBody = { p_store_slug: storeSlug };
                    cacheKeyId = storeSlug;
                } else if (shop) {
                    rpcBody = { p_shop_domain: shop };
                    cacheKeyId = shop;
                } else {
                    rpcBody = { p_store_slug: storeSlug };
                    cacheKeyId = storeSlug;
                }
                const cacheKey = 'ello_widget_config_' + cacheKeyId;

                // ── Cache check ─────────────────────────────────────────
                const cached = getCachedConfigRow(cacheKey);
                let resolved = false;
                if (cached) {
                    const ageMs = Date.now() - cached.ts;
                    applyConfig(buildConfigFromRow(cached.config));
                    resolve(window.ELLO_STORE_CONFIG);
                    resolved = true;
                    if (ageMs < CONFIG_CACHE_TTL_MS) {
                        console.log('[Ello Loader] Using cached config (fresh, age=' + Math.round(ageMs / 1000) + 's)');
                        return; // fresh — no network
                    }
                    console.log('[Ello Loader] Using cached config (stale, age=' + Math.round(ageMs / 1000) + 's), revalidating in background');
                }

                const url = `${sbConfig.supabaseUrl}/rest/v1/rpc/get_widget_config`;
                fetch(url, {
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
                        if (!response.ok) throw new Error('HTTP error! status: ' + response.status);
                        return response.json();
                    })
                    .then(function (data) {
                        if (data && data.length > 0) {
                            const row = data[0];
                            setCachedConfigRow(cacheKey, row);
                            if (!resolved) {
                                applyConfig(buildConfigFromRow(row));
                                resolve(window.ELLO_STORE_CONFIG);
                            }
                            // If already resolved from cache, the in-memory config stays as the
                            // cached version for this pageview; next pageview reads the fresh cache.
                        } else {
                            if (!resolved) {
                                applyConfig(buildDefaultConfig());
                                console.log('⚠️ Store not found in Supabase vto_stores, using default configuration:', window.ELLO_STORE_CONFIG);
                                resolve(window.ELLO_STORE_CONFIG);
                            }
                        }
                    })
                    .catch(function (error) {
                        console.error('❌ Error fetching store configuration:', error);
                        if (!resolved) {
                            applyConfig(buildDefaultConfig());
                            resolve(window.ELLO_STORE_CONFIG);
                        }
                    });
            });
        }

        fetchStoreConfiguration();
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
            console.log("Loader: bootstrapping for shop:", shop || shopDomain);
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

                // Smart visibility — on a PDP we can't yet know if the product is
                // in the catalog (catalog loads async), so born-hide. Off-PDP
                // pages (home, collections, cart) are safe to show immediately.
                if (cfg.widgetVisibilityMode === 'smart' && window.location.pathname.includes('/products/')) {
                    inlineStyles.push('display: none !important');
                }

                // Position — match the dashboard setting on first paint.
                if (cfg.widgetPosition === 'left') {
                    inlineStyles.push('left: 20px !important', 'right: auto !important', 'transform-origin: left bottom !important');
                }

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

        } catch (error) {
            console.error("Virtual Try-On Widget failed to load:", error);
            container.innerHTML = '<p style="color: red;">Widget failed to load</p>';
        }
    }

    // Defer initialization until the browser is idle to protect merchant LCP.
    // The widget is a floating button — it doesn't need to render before the page's
    // main content, so yielding to the browser here is safe.
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => initializeWidget(), { timeout: 3000 });
    } else {
        // Safari fallback — requestIdleCallback not supported
        setTimeout(initializeWidget, 0);
    }
})();
