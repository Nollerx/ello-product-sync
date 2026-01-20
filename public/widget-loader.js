(function () {
    // Prevent duplicate initialization
    if (document.getElementById("virtual-tryon-widget-container")) {
        console.log("⚠️ Ello Widget already loaded - skipping duplicate initialization");
        return;
    }

    console.log("✅ Ello Widget Loader v2.1 - Duplicate check added");

    let WIDGET_BASE_URL = "https://ello-vto-public-13593516897.us-central1.run.app";

    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        WIDGET_BASE_URL = "http://localhost:8000";
        console.log("🔧 Ello Widget: Running in Local Development Mode");
    }

    // Get store configuration from script tag
    const currentScript = document.currentScript;
    // Use 'default_store' for testing when no script tag or store slug is provided
    // Support both storeSlug (new) and storeId (legacy) for backward compatibility
    const shop = currentScript?.dataset?.shop || null; // NEW: Should be primary identifier
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

    // Create a promise to handle store configuration loading
    let storeConfigPromise = new Promise((resolve) => {
        // Fetch store configuration from Supabase vto_stores table
        function fetchStoreConfiguration() {
            // DYNAMIC QUERY CONSTRUCTION:
            // 1. If we have an EXPLICIT store slug/id, search by 'store_slug' (most specific)
            // 2. Else if we have a 'shop' domain, search by 'shop_domain'
            // 3. Fallback to store_slug (default)
            let queryParam = '';

            // Check for explicit slug in dataset (ignoring the fallbacks applied to the variable 'storeSlug')
            const explicitSlug = currentScript?.dataset?.storeSlug || currentScript?.dataset?.storeId;

            if (explicitSlug) {
                queryParam = `store_slug=eq.${encodeURIComponent(storeSlug)}`;
                console.log("🔍 Ello Loader: Fetching config by explicit Store Slug:", storeSlug);
            } else if (shop) {
                queryParam = `shop_domain=eq.${encodeURIComponent(shop)}`;
                console.log("🔍 Ello Loader: Fetching config by Shop Domain:", shop);
            } else {
                queryParam = `store_slug=eq.${encodeURIComponent(storeSlug)}`;
                console.log("🔍 Ello Loader: Fetching config by Default Slug:", storeSlug);
            }

            const url = `https://rwmvgwnebnsqcyhhurti.supabase.co/rest/v1/vto_stores?${queryParam}&select=widget_primary_color,widget_accent_color,minimized_color,featured_item_id,quick_picks_ids,clothing_population_type,desktop_preview_enabled,preview_delay_seconds,preview_theme,store_slug,shop_domain`;
            fetch(url, {
                headers: {
                    'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ3bXZnd25lYm5zcWN5aGh1cnRpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDg0MDc1MTgsImV4cCI6MjA2Mzk4MzUxOH0.OYTXiUBDN5IBlFYDHN3MyCwFUkSb8sgUOewBeSY01NY',
                    'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ3bXZnd25lYm5zcWN5aGh1cnRpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDg0MDc1MTgsImV4cCI6MjA2Mzk4MzUxOH0.OYTXiUBDN5IBlFYDHN3MyCwFUkSb8sgUOewBeSY01NY'
                }
            })
                .then(function (response) {
                    if (response.ok) {
                        return response.json();
                    } else {
                        throw new Error('HTTP error! status: ' + response.status);
                    }
                })
                .then(function (data) {
                    if (data && data.length > 0) {
                        var storeConfig = data[0];
                        window.ELLO_STORE_CONFIG = {
                            storeSlug: storeConfig.store_slug || storeSlug, // Use DB slug if found, else local fallback
                            storeId: storeConfig.store_slug || storeSlug, // Keep for backward compatibility
                            storeName: storeName, // Keep the original script tag value for Shopify
                            shopDomain: storeConfig.shop_domain || shopDomain || storeName, // Use DB domain if found
                            storefrontToken: storefrontToken || null,
                            clothingPopulationType: storeConfig.clothing_population_type || 'supabase',
                            widgetPrimaryColor: storeConfig.widget_primary_color || null,
                            widgetAccentColor: storeConfig.widget_accent_color || null,
                            minimizedColor: storeConfig.minimized_color || null,
                            featuredItemId: storeConfig.featured_item_id || null,
                            minimizedColor: storeConfig.minimized_color || null,
                            featuredItemId: storeConfig.featured_item_id || null,
                            quickPicksIds: storeConfig.quick_picks_ids || null,
                            desktopPreviewEnabled: storeConfig.desktop_preview_enabled !== false, // Default to true if undefined
                            desktopPreviewDelay: storeConfig.preview_delay_seconds || 3, // Default to 3 seconds
                            previewTheme: storeConfig.preview_theme || 'light'
                        };

                        // Sync tracking object with final config
                        window.elloStoreConfig = {
                            id: window.ELLO_STORE_CONFIG.storeId,
                            name: window.ELLO_STORE_CONFIG.storeName,
                            shopDomain: window.ELLO_STORE_CONFIG.shopDomain,
                        };
                    } else {
                        // Fallback to default configuration
                        window.ELLO_STORE_CONFIG = {
                            storeSlug: storeSlug,
                            storeId: storeSlug, // Keep for backward compatibility
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
                            desktopPreviewDelay: 3
                        };
                        console.log('⚠️ Store not found in Supabase vto_stores, using default configuration:', window.ELLO_STORE_CONFIG);

                        // Sync tracking object with fallback config
                        window.elloStoreConfig = {
                            id: window.ELLO_STORE_CONFIG.storeId,
                            name: window.ELLO_STORE_CONFIG.storeName,
                            shopDomain: window.ELLO_STORE_CONFIG.shopDomain,
                        };
                    }
                    resolve(window.ELLO_STORE_CONFIG);
                })
                .catch(function (error) {
                    console.error('❌ Error fetching store configuration:', error);
                    // Fallback to default configuration
                    window.ELLO_STORE_CONFIG = {
                        storeSlug: storeSlug,
                        storeId: storeSlug, // Keep for backward compatibility
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
                        previewTheme: 'light'
                    };
                    resolve(window.ELLO_STORE_CONFIG);
                });
        }

        // Start fetching store configuration
        fetchStoreConfiguration();
    });

    // Helper to call widget-bootstrap edge function
    async function fetchBootstrap(shop) {
        if (!shop) return null;
        try {
            const res = await fetch(
                "https://ello-vto-13593516897.us-central1.run.app/bootstrap",
                {
                    method: "POST",
                    mode: "cors", // Explicitly request CORS
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

    // Function to load and execute script
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            script.onerror = reject;
            document.body.appendChild(script);
        });
    }

    // Main initialization function that waits for store config
    async function initializeWidget() {
        try {
            // Version for caching - update this when major changes occur to force refresh
            const WIDGET_VERSION = '2.3.7';

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

            // Wait for store configuration AND HTML to be ready
            // We do NOT await bootstrap here anymore, so the widget can render UI immediately
            // widget-main.js will await the bootstrap promise
            const [storeConfig, html] = await Promise.all([
                storeConfigPromise,
                htmlPromise
            ]);

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

            // Inject link elements (e.g., external stylesheets, fonts)
            const links = doc.querySelectorAll('link[rel="stylesheet"], link[rel="preconnect"], link[rel="icon"], link[rel="preload"]');
            links.forEach(link => {
                const linkElement = document.createElement('link');
                Array.from(link.attributes).forEach(attr => {
                    linkElement.setAttribute(attr.name, attr.value);
                });
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

    // Start the initialization process
    initializeWidget();
})();
