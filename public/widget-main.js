
// Generate and persist session ID for tracking (will be set after store config loads)
// The actual sessionId is now managed via localStorage below

// Debug logger — silenced in production. Flip window.__ELLO_DEBUG__ = true in
// your own browser to see verbose logs. console.warn / console.error stay live.
var elloLog = function () {
    if (typeof window !== 'undefined' && window.__ELLO_DEBUG__ === true) {
        console.log.apply(console, arguments);
    }
};

elloLog("✅ Ello Widget v2.5.0 - silent logs by default");

// Global activity flag to prevent ReferenceError
let hasUserActivity = false;

// Make initializeWidget globally accessible
window.initializeWidget = function () {
    detectDevice();
    tryonChatHistory = [];  // Initialize as array instead of undefined
    generalChatHistory = []; // Initialize as array instead of undefined

    // If store config not loaded yet (e.g., direct HTML load without loader), fetch it
    if (!window.ELLO_STORE_CONFIG) {
        const storeSlug = window.ELLO_STORE_SLUG || window.ELLO_STORE_ID || 'default_store';

        const url = `${SUPABASE_URL}/rest/v1/rpc/get_widget_config`;
        fetch(url, {
            method: 'POST',
            credentials: 'omit',
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ p_store_slug: storeSlug })
        })
            .then(response => {
                if (response.ok) {
                    return response.json();
                } else {
                    throw new Error('HTTP error! status: ' + response.status);
                }
            })
            .then(data => {
                if (data && data.length > 0) {
                    var storeConfig = data[0];
                    window.ELLO_STORE_CONFIG = {
                        storeSlug: storeSlug,
                        storeId: storeSlug, // Keep for backward compatibility
                        storeName: window.ELLO_STORE_NAME || 'default-name',
                        clothingPopulationType: storeConfig.clothing_population_type || 'supabase',
                        shopDomain: storeConfig.shop_domain || null,
                        storefrontToken: storeConfig.storefront_token || null,
                        widgetPrimaryColor: storeConfig.widget_primary_color || null,
                        widgetAccentColor: storeConfig.widget_accent_color || null,
                        minimizedColor: storeConfig.minimized_color || null,
                        featuredItemId: storeConfig.featured_item_id || null,
                        quickPicksIds: storeConfig.quick_picks_ids || null
                    };

                    // Now apply the colors and theme
                    applyWidgetThemeColors();
                    applyMinimizedWidgetColor();
                    applyWidgetPosition();
                } else {
                    console.warn('⚠️ Store not found in vto_stores, using default configuration');
                    window.ELLO_STORE_CONFIG = {
                        storeSlug: storeSlug,
                        storeId: storeSlug, // Keep for backward compatibility
                        storeName: window.ELLO_STORE_NAME || 'default-name',
                        clothingPopulationType: 'supabase',
                        widgetPrimaryColor: null,
                        widgetAccentColor: null,
                        minimizedColor: null,
                        featuredItemId: null,
                        quickPicksIds: null
                    };
                    applyWidgetThemeColors();
                    applyMinimizedWidgetColor();
                    applyWidgetPosition();
                }
            })
            .catch(error => {
                console.error('❌ Error fetching store configuration:', error);
                window.ELLO_STORE_CONFIG = {
                    storeSlug: storeSlug,
                    storeId: storeSlug, // Keep for backward compatibility
                    storeName: window.ELLO_STORE_NAME || 'default-name',
                    clothingPopulationType: 'supabase',
                    widgetPrimaryColor: null,
                    widgetAccentColor: null,
                    minimizedColor: null,
                    featuredItemId: null,
                    quickPicksIds: null
                };
                applyWidgetThemeColors();
                applyMinimizedWidgetColor();
                applyWidgetPosition();
            });
    } else {
    }

    // Load saved photo from storage on initialization
    loadSavedPhoto();

    // If visibility is gated, hide the widget immediately to prevent a flash on
    // non-clothing pages while the catalog loads. The gate flips it back on if
    // the current product is in the enabled catalog.
    applyWidgetVisibilityGate({ phase: 'pre-catalog' });

    // Load clothing data from Shopify
    loadClothingData().then(() => {
        applyWidgetVisibilityGate({ phase: 'post-catalog' });
    }).catch(error => {
        console.error('Initial clothing data load failed:', error);
        // Fail open — don't permanently hide the widget on a fetch error.
        applyWidgetVisibilityGate({ phase: 'error', failOpen: true });
    });

    // Apply theme colors
    applyWidgetThemeColors();

    // Apply minimized widget color
    // Wait a bit for store config to be available if it's still loading
    // Retry up to 3 times with increasing delays
    let retryCount = 0;
    const tryApplyColor = () => {
        if (window.ELLO_STORE_CONFIG) {
            applyMinimizedWidgetColor();
            applyWidgetPosition();
        } else if (retryCount < 3) {
            retryCount++;
            const delay = retryCount * 500; // 500ms, 1000ms, 1500ms
            setTimeout(tryApplyColor, delay);
        } else {
            console.warn('⚠️ Store config not available after retries, using default color');
            applyMinimizedWidgetColor(); // Still try (will use default)
            applyWidgetPosition();
        }
    };
    tryApplyColor();

    const widget = document.getElementById('virtualTryonWidget');
    if (widget) {
        widget.addEventListener('click', function (e) {
            if (this.classList.contains('widget-minimized') && !e.target.closest('.widget-toggle') && !e.target.closest('.btn')) {
                openWidget();
            }
        });
    } else {
        console.warn('virtualTryonWidget not found in DOM at initialization');
    }

    window.addEventListener('orientationchange', handleOrientationChange);
    window.addEventListener('resize', handleOrientationChange);
    preventZoom();

    if (isMobile) {
        document.addEventListener('touchstart', function () { }, { passive: true });
        const cameraControls = document.getElementById('cameraControls');
        if (cameraControls) {
            cameraControls.addEventListener('touchstart', function (e) {
                e.stopPropagation();
            }, { passive: true });
        }
    } else {
        // Initialize desktop-only preview triggers
        initializePreviewTriggers();
    }
}

// Keep the existing DOMContentLoaded for direct page loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.initializeWidget);
} else {
    // If document already loaded and no store ID set, set default for testing
    if (!window.ELLO_STORE_ID) {
        window.ELLO_STORE_ID = 'default_store';
        window.ELLO_STORE_NAME = 'default-name';
    }

    // If loading directly (not via loader), initialize immediately
    // Check if we're in a direct HTML load by looking for the widget container
    setTimeout(() => {
        if (document.getElementById('virtualTryonWidget') && !window.ELLO_STORE_CONFIG) {
            window.initializeWidget();
        }
    }, 100);
}
// Configuration
const WEBHOOK_URL = 'https://ancesoftware.app.n8n.cloud/webhook/virtual-tryon-production';

// Mobile detection
let isMobile = false;
let isTablet = false
let isIOS = false;
let isAndroid = false;

// Mobile scroll lock variables
let scrollLockTouchHandler = null;

// Preview State Variables
let previewShownThisSession = false;
let previewDismissedForever = false;
let previewScrollTimer = null;
let previewDelayTimer = null;
let hasUserInteractedWithPreview = false;
let isPreviewVisible = false;

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================

// Supabase Configuration — populated by widget-loader.js via /api/widget-config.
// Falls back to production values if loader hasn't set them (e.g. direct HTML load).
const _sbCfg = window.ELLO_SUPABASE_CONFIG || {};
const SUPABASE_URL = _sbCfg.supabaseUrl || 'https://rwmvgwnebnsqcyhhurti.supabase.co';
const SUPABASE_ANON_KEY = _sbCfg.supabaseAnonKey || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ3bXZnd25lYm5zcWN5aGh1cnRpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDg0MDc1MTgsImV4cCI6MjA2Mzk4MzUxOH0.OYTXiUBDN5IBlFYDHN3MyCwFUkSb8sgUOewBeSY01NY';
elloLog("[Ello Widget] SUPABASE_URL:", SUPABASE_URL);
elloLog("[Ello Widget] Config source:", _sbCfg.supabaseUrl ? "server (widget-config)" : "fallback (hardcoded)");



// Widget Configuration
const WIDGET_CONFIG = {
    MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB
    ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    MAX_MESSAGE_LENGTH: 1000,
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY: 1000
};

// Only the columns the widget actually reads — avoids serializing wide row data.
// Cuts each clothing_items request payload by roughly 70% vs SELECT *.
const CLOTHING_SELECT_COLUMNS = 'id,item_id,name,price,category,tags,color,image_url,product_url,data_source,active,shopify_product_id,variants';

// Legacy localStorage key — older versions of the widget cached the clothing
// list here. We removed caching so merchant changes appear instantly, but we
// proactively delete any leftover cache from returning visitors so they don't
// get stuck on a stale entry.
const LEGACY_CLOTHING_CACHE_KEY_PREFIX = 'ello_clothing_items_v1_';

// Improved Clothing Categories Configuration
const CLOTHING_CATEGORIES = {
    // Comprehensive clothing terms (more inclusive)
    clothingTerms: [
        // Tops
        'shirt', 'shirts', 'blouse', 'blouses', 't-shirt', 't-shirts', 'tshirt', 'tshirts',
        'top', 'tops', 'tank', 'tanks', 'tank-top', 'tank-tops', 'camisole', 'camisoles',
        'sweater', 'sweaters', 'pullover', 'pullovers', 'hoodie', 'hoodies', 'sweatshirt', 'sweatshirts',
        'cardigan', 'cardigans', 'vest', 'vests', 'waistcoat', 'waistcoats',
        'blazer', 'blazers', 'suit-jacket', 'suit-jackets', 'sport-shirt', 'sport-shirts',

        // Bottoms
        'pants', 'trousers', 'jeans', 'denim', 'shorts', 'short-pants', 'capri', 'capris',
        'skirt', 'skirts', 'mini-skirt', 'maxi-skirt', 'midi-skirt', 'pencil-skirt',
        'leggings', 'tights', 'yoga-pants', 'joggers', 'sweatpants', 'track-pants',

        // Dresses & One-pieces
        'dress', 'dresses', 'gown', 'gowns', 'maxi-dress', 'mini-dress', 'midi-dress',
        'romper', 'rompers', 'jumpsuit', 'jumpsuits', 'overall', 'overalls', 'dungarees',
        'bodysuit', 'bodysuits', 'unitard', 'unitards',

        // Outerwear
        'jacket', 'jackets', 'coat', 'coats', 'blazer', 'blazers', 'suit', 'suits',
        'cardigan', 'cardigans', 'sweater', 'sweaters', 'pullover', 'pullovers',
        'hoodie', 'hoodies', 'windbreaker', 'windbreakers', 'bomber', 'bombers',
        'trench-coat', 'trench-coats', 'pea-coat', 'pea-coats', 'parka', 'parkas',

        // Specialized clothing
        'kimono', 'kimonos', 'tunic', 'tunics', 'poncho', 'ponchos', 'cape', 'capes',
        'robe', 'robes', 'bathrobe', 'bathrobes', 'dressing-gown', 'dressing-gowns',
        'nightgown', 'nightgowns', 'pajamas', 'pyjamas', 'sleepwear', 'loungewear',
        'activewear', 'athletic-wear', 'sportswear', 'workout-clothes', 'gym-clothes',
        'swimwear', 'bikini', 'bikinis', 'swimsuit', 'swimsuits', 'bathing-suit',

        // General terms
        'clothing', 'apparel', 'garment', 'garments', 'attire', 'outfit', 'outfits',
        'wear', 'fashion', 'style', 'clothes', 'clothing-item'
    ],

    // Only exclude items that are DEFINITELY not clothing (more specific)
    excludedPatterns: [
        // Footwear - comprehensive patterns to catch all shoe types
        /^(shoes?|boots?|sandals?|sneakers?|heels?|flats?|loafers?|oxfords?|pumps?|stilettos?|wedges?|clogs?|mules?|slides?|flip-flops?)$/i, // Standalone
        /\b(shoes?|boots?|sandals?|sneakers?|heels?|flats?|loafers?|oxfords?|pumps?|stilettos?|wedges?|clogs?|mules?|slides?|flip-flops?)\b/i, // Anywhere as word
        /(running-shoes?|walking-shoes?|dress-shoes?|tennis-shoes?|basketball-shoes?|soccer-shoes?|hiking-boots?|work-boots?|combat-boots?)/i, // Compound footwear
        /\b(footwear|shoes|boots)\b/i, // Category terms

        // Accessories - more comprehensive patterns
        /^(jewelry|jewellery|necklace|bracelet|bracelets?|earrings?|ring|rings|pendant|pendants?|brooch|brooches?|pin|pins)$/i,
        /\b(jewelry|jewellery|necklace|bracelet|earrings?|ring|rings|pendant|brooch|pin)\b/i, // Match if these words appear anywhere
        /^(bags?|purse|purses|wallet|wallets|handbag|handbags|backpack|backpacks|tote|totes|clutch|clutches?)$/i,
        /\b(trucker-hat|trucker-hats?|baseball-cap|baseball-caps?|beanie|beanies?|fedora|fedoras?)\b/i, // Specific hat types
        /\b(hat|hats?|cap|caps?)\b.*\b(trucker|baseball|truck|snapback|dad|bucket|sun|panama|straw|beanie|fedora|beret|visor)\b/i, // Hat with modifier
        /\b(trucker|baseball|truck|snapback|dad|bucket|sun|panama|straw|beanie|fedora|beret|visor)\b.*\b(hat|hats?|cap|caps?)\b/i, // Modifier with hat
        /^(hat|hats?|cap|caps?|beanie|beanies?|fedora|fedoras?)$/i, // Standalone hat/cap
        /\bhats?\b/i, // Any occurrence of "hat" or "hats" (be aggressive about hats)
        /^(sunglasses?|glasses?|eyewear|watch|watches?|timepiece|timepieces?)$/i,
        /^(belt|belts?|scarf|scarves?|gloves?|mittens?)$/i,
        /\b(accessories|accessory|jewelry|jewellery)\b/i, // Match if category contains accessories

        // Underwear (only intimate wear)
        /^(underwear|lingerie|bra|bras?|panties?|boxers?|briefs?|thong|thongs?|g-string)$/i,
        /^(undershirt|undershirts?|undershirt|undershirts?|camisole|camisoles?)$/i,

        // Socks (only socks)
        /^(socks?|stockings?|hosiery|pantyhose)$/i,

        // Non-clothing items
        /^(perfume|fragrance|cosmetics?|makeup|skincare|beauty-products?)$/i,
        /^(books?|magazines?|electronics?|phones?|laptops?|tablets?)$/i,
        /^(furniture|home-decor|kitchen-items?|bathroom-items?)$/i
    ],

    // Categories that are ALWAYS clothing (fast track)
    alwaysClothing: [
        'tops', 'bottoms', 'dresses', 'outerwear', 'activewear', 'sleepwear',
        'swimwear', 'formal-wear', 'casual-wear', 'work-wear', 'maternity-wear',
        'plus-size', 'petite', 'tall', 'junior', 'mens', 'womens', 'unisex'
    ]
};

// ============================================================================
// DATA STORAGE
// ============================================================================

// ADD THESE FUNCTIONS HERE (BEFORE loadClothingData):

// Improved clothing detection function - more accurate and less aggressive
function isClothingItem(product) {
    const productType = (product.category || '').toLowerCase().trim();
    const productName = (product.name || '').toLowerCase().trim();
    const productTags = (product.tags || []).map(tag => tag.toLowerCase().trim());

    // 1. FAST TRACK: Check if category is definitely clothing
    if (CLOTHING_CATEGORIES.alwaysClothing.some(category =>
        productType.includes(category) ||
        productTags.some(tag => tag.includes(category)))) {
        return true;
    }

    // 2. EXCLUSION CHECK: Only exclude items that are DEFINITELY not clothing
    // Use regex patterns for more precise matching
    const fullText = `${productType} ${productName} ${productTags.join(' ')}`;

    for (const pattern of CLOTHING_CATEGORIES.excludedPatterns) {
        if (pattern.test(fullText)) {
            return false;
        }
    }

    // 3. INCLUSION CHECK: Look for clothing terms (more comprehensive)
    for (const clothingTerm of CLOTHING_CATEGORIES.clothingTerms) {
        if (productType.includes(clothingTerm) ||
            productName.includes(clothingTerm) ||
            productTags.some(tag => tag.includes(clothingTerm))) {
            return true;
        }
    }

    // 4. SIZE-BASED DETECTION: Check for clothing sizes
    if (hasClothingSizeVariants(product)) {
        return true;
    }

    // 5. SMART NAME ANALYSIS: For products with generic categories
    if (!productType || productType === 'product' || productType === '') {
        if (isLikelyClothingByName(productName)) {
            return true;
        }
    }

    // 6. CONTEXTUAL ANALYSIS: Check for clothing-related context
    if (hasClothingContext(product)) {
        return true;
    }

    // 7. CATEGORY-BASED EXCLUSION: Check if category explicitly indicates non-clothing
    const nonClothingCategories = ['accessories', 'accessory', 'jewelry', 'jewellery', 'footwear',
        'shoes', 'shoe', 'boots', 'boot', 'sandals', 'sandal',
        'bags', 'hats', 'hat', 'watches', 'watch', 'electronics', 'books',
        'furniture', 'home', 'beauty', 'cosmetics', 'makeup'];

    if (productType && nonClothingCategories.some(cat => productType.includes(cat))) {
        return false;
    }

    // 8. DEFAULT: Only include if category suggests clothing or we're truly uncertain
    // Be smarter - if category is empty or very generic, include it
    // If category suggests non-clothing, exclude it
    if (!productType || productType === 'product' || productType === '' || productType.includes('clothing') || productType.includes('apparel')) {
        return true; // Include if category is empty/generic/suggests clothing
    } else {
        return false; // Exclude if category exists but doesn't suggest clothing
    }
}

// Check if product has clothing-style size variants
function hasClothingSizeVariants(product) {
    // Check if product has typical clothing size options
    const clothingSizes = ['xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl',
        'small', 'medium', 'large', 'x-large',
        '0', '2', '4', '6', '8', '10', '12', '14', '16'];

    if (product.variants && product.variants.length > 1) {
        const sizes = product.variants
            .map(v => (v.size || v.title || '').toLowerCase())
            .filter(size => clothingSizes.includes(size));

        return sizes.length > 0;
    }

    return false;
}

// Enhanced function to detect clothing by name patterns
function isLikelyClothingByName(name) {
    // More comprehensive clothing indicators in names
    const clothingIndicators = [
        'wear', 'outfit', 'garment', 'attire', 'apparel', 'clothing', 'fashion',
        'style', 'look', 'ensemble', 'getup', 'costume', 'uniform', 'dress-up',
        'casual', 'formal', 'business', 'party', 'evening', 'daytime', 'work',
        'weekend', 'vacation', 'travel', 'date', 'wedding', 'cocktail', 'office'
    ];

    return clothingIndicators.some(indicator => name.includes(indicator));
}

// New function: Check for clothing-related context clues
function hasClothingContext(product) {
    const productName = (product.name || '').toLowerCase();
    const productTags = (product.tags || []).map(tag => tag.toLowerCase());
    const productType = (product.category || '').toLowerCase();

    // Check for clothing-related context clues
    const contextClues = [
        // Size indicators
        'size', 'sizing', 'fit', 'fitting', 'measurement', 'measurements',

        // Material indicators (common in clothing)
        'cotton', 'polyester', 'wool', 'silk', 'linen', 'denim', 'leather', 'suede',
        'cashmere', 'merino', 'spandex', 'elastane', 'viscose', 'rayon', 'modal',

        // Style indicators
        'vintage', 'retro', 'modern', 'classic', 'contemporary', 'trendy', 'stylish',
        'designer', 'brand', 'label', 'collection', 'line', 'series',

        // Occasion indicators
        'casual', 'formal', 'business', 'party', 'evening', 'daytime', 'work',
        'weekend', 'vacation', 'travel', 'date', 'wedding', 'cocktail', 'office',

        // Gender/size indicators
        'mens', 'womens', 'unisex', 'plus-size', 'petite', 'tall', 'junior',
        'maternity', 'pregnancy', 'nursing', 'postpartum'
    ];

    const fullText = `${productName} ${productTags.join(' ')} ${productType}`;

    // If it has multiple context clues, it's likely clothing
    const clueCount = contextClues.filter(clue => fullText.includes(clue)).length;

    if (clueCount >= 2) {
        return true;
    }

    // Check for specific clothing patterns
    const clothingPatterns = [
        /\b(shirt|dress|pants?|jacket|coat|sweater|hoodie|blouse|tank|vest|blazer|cardigan|romper|jumpsuit|leggings|tights|kimono|tunic|poncho|cape)\b/i,
        /\b(top|bottom|outerwear|activewear|sleepwear|swimwear|loungewear)\b/i,
        /\b(short-sleeve|long-sleeve|sleeveless|off-shoulder|halter|strapless)\b/i,
        /\b(high-waist|low-waist|mid-rise|skinny|straight|wide-leg|cropped)\b/i,
        /\b(maxi|mini|midi|pencil|a-line|wrap|shift|bodycon)\b/i
    ];

    return clothingPatterns.some(pattern => pattern.test(fullText));
}

// Dynamic clothing data from Supabase
let sampleClothing = [];
let _elloClothingDataLoaded = false; // Set to true once loadClothingData() completes

// ─── Lazy full-catalog state ───────────────────────────────────────────────
// sampleClothing only holds the small preview set (featured + quick picks +
// current product) after loadClothingData resolves. The FULL catalog — every
// enabled product on the store — is fetched lazily the first time the
// shopper engages with the widget (opens it OR searches). These flags + the
// in-flight promise prevent us from kicking off multiple parallel full-load
// requests if both triggers fire.
let _elloFullCatalogLoaded = false;
let _elloFullCatalogPromise = null;

/**
 * Fetches the small page-load payload: enabled-handles list + featured +
 * quick picks + current PDP product. Replaces the prior loadClothingFromShopify
 * / loadClothingFromSupabase call at page load.
 *
 * Side effects (matching what the prior full-catalog loaders did):
 *   - window.elloEnabledHandles  ← Set of enabled product handles
 *   - sampleClothing             ← [featured, ...quickPicks, currentProduct]
 *   - window.elloHiddenProductIds ← Set (empty until full catalog loads —
 *     the handles endpoint already filters hidden products server-side)
 */
async function loadHandlesAndPreview(storeConfig) {
    const baseUrl = window.ELLO_WIDGET_BASE_URL || '';
    const slug = storeConfig.storeSlug || storeConfig.storeId || window.ELLO_STORE_SLUG || window.ELLO_STORE_ID;
    const shop = storeConfig.shopDomain || storeConfig.storeName || window.ELLO_SHOP_DOMAIN;

    if (!slug && !shop) {
        console.warn('[Ello] loadHandlesAndPreview: no slug/shop — falling back to full catalog load');
        return loadFullCatalogNow(storeConfig);
    }

    // Pass either slug or shop — endpoints accept either.
    const params = new URLSearchParams();
    if (slug) params.set('store_slug', slug);
    if (shop) params.set('shop', shop);

    // Current PDP product handle (if any) so the preview endpoint can include
    // it. detectCurrentProduct relies on the current product being in
    // sampleClothing — without this, the visibility gate wouldn't find it.
    const currentHandle = getProductIdFromUrl(window.location.pathname);
    const previewParams = new URLSearchParams(params);
    if (currentHandle) previewParams.set('handle', currentHandle);

    const handlesUrl = `${baseUrl}/api/catalog-handles?${params.toString()}`;
    const previewUrl = `${baseUrl}/api/widget-preview?${previewParams.toString()}`;

    try {
        const [handlesRes, previewRes] = await Promise.all([
            fetch(handlesUrl, { credentials: 'omit' }),
            fetch(previewUrl, { credentials: 'omit' }),
        ]);

        // Handles → Set for O(1) elloIsProductEnabled lookups.
        if (handlesRes.ok) {
            const { handles } = await handlesRes.json();
            window.elloEnabledHandles = new Set(Array.isArray(handles) ? handles : []);
            elloLog(`[Ello] Loaded ${window.elloEnabledHandles.size} enabled handles`);
        } else {
            console.warn(`[Ello] catalog-handles ${handlesRes.status} — elloIsProductEnabled will fall back to sampleClothing`);
            window.elloEnabledHandles = new Set();
        }

        // Preview → sampleClothing (small array, fully-formed products).
        if (previewRes.ok) {
            const { featured, quickPicks, currentProduct } = await previewRes.json();
            const seenIds = new Set();
            const preview = [];
            const pushUnique = (p) => {
                if (!p || !p.id || seenIds.has(p.id)) return;
                seenIds.add(p.id);
                preview.push(p);
            };
            pushUnique(featured);
            (Array.isArray(quickPicks) ? quickPicks : []).forEach(pushUnique);
            pushUnique(currentProduct);
            sampleClothing = preview;
            elloLog(`[Ello] Loaded ${preview.length} preview products`);
        } else {
            console.warn(`[Ello] widget-preview ${previewRes.status} — sampleClothing left empty until full catalog loads`);
            sampleClothing = [];
        }

        // Blacklist gets populated when the full catalog loads via the
        // existing fetchHiddenProductIds path. The handles endpoint already
        // excludes hidden products server-side, so an empty set here is
        // correct for the preview phase.
        if (!(window.elloHiddenProductIds instanceof Set)) {
            window.elloHiddenProductIds = new Set();
        }
    } catch (err) {
        console.error('[Ello] loadHandlesAndPreview failed:', err);
        // Soft fallback: try the original full-catalog path so the widget
        // doesn't end up totally empty for the shopper.
        return loadFullCatalogNow(storeConfig);
    }
}

/**
 * Triggers the full catalog load (every enabled product, with images +
 * variants — what sampleClothing held under the old pre-Tier-2 behavior).
 * Used lazily on widget open and as a fallback if the small-payload endpoints
 * fail at page load. Idempotent — returns the in-flight promise if a load is
 * already running.
 */
function loadFullCatalogIfNeeded(storeConfig) {
    if (_elloFullCatalogLoaded) return Promise.resolve();
    if (_elloFullCatalogPromise) return _elloFullCatalogPromise;
    _elloFullCatalogPromise = loadFullCatalogNow(storeConfig).then(() => {
        _elloFullCatalogLoaded = true;
    }).catch((err) => {
        console.error('[Ello] Full catalog load failed:', err);
        _elloFullCatalogPromise = null; // Allow retry on next trigger.
    });
    return _elloFullCatalogPromise;
}

async function loadFullCatalogNow(storeConfig) {
    const cfg = storeConfig || window.ELLO_STORE_CONFIG || {};
    if ((cfg.clothingPopulationType || cfg.clothing_population_type) === 'supabase') {
        await loadClothingFromSupabase(cfg);
    } else {
        await loadClothingFromShopify(cfg);
    }
    // After the full catalog populates sampleClothing, repopulate
    // featured/quick picks from the now-richer pool (variety picks need it).
    if (widgetOpen && currentMode === 'tryon' && Array.isArray(sampleClothing) && sampleClothing.length > 0) {
        try { await populateFeaturedAndQuickPicks(); } catch (e) { console.warn('[Ello] populate refresh failed:', e); }
    }
}


// Load clothing data from active_clothing_items view
// Load clothing data based on store configuration
async function loadClothingData() {
    try {
        // Wait for store configuration to be available
        let storeConfig = window.ELLO_STORE_CONFIG;

        // If not available yet, wait a bit and try again
        if (!storeConfig) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            storeConfig = window.ELLO_STORE_CONFIG;
        }

        // Final fallback if still not available
        if (!storeConfig) {
            storeConfig = {
                storeId: window.ELLO_STORE_ID || 'default-store',
                storeName: window.ELLO_STORE_NAME || 'default-name',
                clothingPopulationType: 'supabase', // Changed default to supabase
                planName: 'STARTER'
            };
        }


        // ⚡️ CHECK FOR BOOTSTRAP DATA (PRIORITY WITH PROMISE)
        if (window.ELLO_BOOTSTRAP_PROMISE) {
            elloLog("⏳ Main: awaiting bootstrap promise...");

            // Create a timeout promise (e.g., 8 seconds) to prevent hanging
            const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 8000));

            try {
                // Race the bootstrap against the timeout
                const bootstrap = await Promise.race([window.ELLO_BOOTSTRAP_PROMISE, timeoutPromise]);

                if (bootstrap) {
                    let products = [];

                    // New Object Format: { store: {...}, blacklist: {...}, products: [...] }
                    if (bootstrap.store) {
                        elloLog("🚀 Main: synced store config from bootstrap:", bootstrap.store.clothing_population_type, "plan:", bootstrap.store.plan_code);
                        window.ELLO_STORE_CONFIG = {
                            ...window.ELLO_STORE_CONFIG,
                            ...bootstrap.store
                        };
                        storeConfig = window.ELLO_STORE_CONFIG;

                        // Free-plan branding footer ("Powered by Ello VTO")
                        if (bootstrap.store.plan_code === "ello_free") {
                            try { injectElloBranding(); } catch (e) { console.warn("branding inject failed", e); }
                        }
                    }

                    if (bootstrap.products && Array.isArray(bootstrap.products)) {
                        products = bootstrap.products;
                    } else if (Array.isArray(bootstrap)) {
                        // Legacy Array Format
                        products = bootstrap;
                    }

                    if (products && products.length > 0) {
                        elloLog("🚀 Main: using bootstrapped catalog:", products.length);

                        // Initialize Blacklists
                        window.elloHiddenProductIds = new Set();
                        if (bootstrap.blacklist?.hiddenProductIds) {
                            bootstrap.blacklist.hiddenProductIds.forEach(id => window.elloHiddenProductIds.add(String(id)));
                        }

                        // Fetch hidden IDs from Supabase so dashboard toggles take effect
                        // (bootstrap edge function does not return the blacklist from Supabase)
                        const bootstrapStoreSlug = storeConfig.storeSlug || storeConfig.storeId || window.ELLO_STORE_SLUG || window.ELLO_STORE_ID;
                        if (bootstrapStoreSlug) {
                            const supabaseHiddenIds = await fetchHiddenProductIds(bootstrapStoreSlug);
                            supabaseHiddenIds.forEach(id => window.elloHiddenProductIds.add(id));
                        }

                        // Normalize bootstrap products, filtering hidden ones.
                        // Use getProductId() to extract the numeric ID from the GID so it
                        // matches the numeric item_id stored in clothing_items.
                        sampleClothing = [];
                        products.forEach(p => {
                            const numericId = getProductId(p) || String(p.id);
                            if (p.active === false
                                || window.elloHiddenProductIds.has(numericId)
                                || window.elloHiddenProductIds.has(String(p.id))) return;

                            sampleClothing.push({
                                ...p,
                                name: p.title || p.name,
                                image_url: p.image || p.image_url,
                                price: typeof p.price === 'string' ? parseFloat(p.price) : (p.price || 0),
                                shopify_product_gid: p.shopify_product_id || p.id,
                                variants: p.variants || []
                            });
                        });

                        if (widgetOpen && currentMode === 'tryon') await populateFeaturedAndQuickPicks();
                        return;
                    }
                } else {
                    console.warn("⚠️ Bootstrap promise returned no data");
                }
            } catch (e) {
                console.error("❌ Error awaiting bootstrap promise:", e);
            }
        }

        // ─── PAGE LOAD: minimal fetch only ────────────────────────────────
        // Previously this fetched the entire Shopify catalog (~2.5 MB Brotli
        // for a 1,600-product store) on every page view, just so the inline
        // button could answer "is this product enabled?". Now we fetch two
        // small server endpoints in parallel:
        //   /api/catalog-handles   → ~10 KB list of enabled handles, powers
        //                            elloIsProductEnabled + smart-visibility
        //   /api/widget-preview    → ~30-80 KB featured + quick picks +
        //                            current PDP product, populates
        //                            sampleClothing so the widget opens
        //                            instantly to its initial view
        //
        // The full catalog (sampleClothing populated with EVERY product) is
        // deferred — loaded lazily when widgetOpen=true is set, or on the
        // first browse/search action. See loadFullCatalogIfNeeded below.
        await loadHandlesAndPreview(storeConfig);

        // If preview returned nothing useful, log it (but don't fail open).
        if (!sampleClothing || sampleClothing.length === 0) {
            console.warn('⚠️ Widget preview returned no products.');
        }

        // Refresh UI if widget is open AND we actually have data (prevents infinite loop with populateFeaturedAndQuickPicks)
        if (widgetOpen && currentMode === 'tryon' && sampleClothing.length > 0) {
            await populateFeaturedAndQuickPicks();
        }

    } catch (error) {
        console.error('❌ Error loading clothing data:', error);

        // Show user-friendly error message
        if (typeof showSuccessNotification === 'function') {
            showSuccessNotification('Connection Error', 'Unable to load products. Please check your configuration.', 5000);
        }

        // Leave empty - no fallback to mock data
        sampleClothing = [];
    } finally {
        _elloClothingDataLoaded = true;

        // ─── Public catalog-membership API ─────────────────────────────────
        // Used by the inline-button theme block to inverse-hide the button on
        // products that aren't in the merchant's try-on catalog. Returns:
        //   true  → product is enabled (button stays visible)
        //   false → product is disabled (button hides itself)
        //   null  → catalog not loaded yet (button stays visible — the
        //           inverse pattern means we'd rather show wrongly for ~1s
        //           than hide wrongly for the same window)
        // Match by handle. Backed by window.elloEnabledHandles (Set populated by
        // /api/catalog-handles in loadHandlesAndPreview), not by sampleClothing
        // — sampleClothing only holds the small preview set on page load, and
        // is filled with the full catalog only after the user opens the widget.
        // Falling back to sampleClothing keeps wardrobe re-matching working
        // even if the handles fetch fails for some reason.
        window.elloIsProductEnabled = function (handle) {
            if (!_elloClothingDataLoaded) return null;
            if (!handle) return null;
            if (window.elloEnabledHandles instanceof Set) {
                return window.elloEnabledHandles.has(handle);
            }
            return sampleClothing.some(function (item) { return item && item.id === handle; });
        };
        // Notify any listeners (currently the inline button block) that the
        // catalog has resolved and they can now run their membership check.
        try {
            window.dispatchEvent(new CustomEvent('ello:catalog-loaded', {
                detail: { count: sampleClothing.length }
            }));
        } catch (e) { /* CustomEvent not supported on ancient browsers — ignore */ }

        // ─── Belt-and-suspenders inline-button hide ──────────────────────
        // The inline-tryon-button theme block registers an `ello:catalog-loaded`
        // listener and hides itself if its product is disabled. Under the
        // Tier 2 fast-load model the catalog can resolve before the inline
        // block's script finishes its async-loader injection, which means the
        // block's listener can register AFTER our event fires and never hear
        // it. To eliminate that race we ALSO sweep the DOM here and hide any
        // inline buttons for products not in the enabled-handles set.
        // Idempotent with the block's own logic — both produce the same
        // outcome, so doing both is safe.
        try {
            if (window.elloEnabledHandles instanceof Set) {
                document.querySelectorAll('[data-ello-inline-btn]').forEach(function (btn) {
                    var handle = btn && btn.dataset && btn.dataset.productHandle;
                    if (handle && !window.elloEnabledHandles.has(handle)) {
                        btn.style.setProperty('display', 'none', 'important');
                    }
                });
            }
        } catch (e) { /* defensive sweep — never let this throw */ }
    }
}

// Helper function to convert GraphQL product to Shopify format
function convertGraphQLProductToShopifyFormat(graphQLProduct) {
    // Extract numeric ID from GraphQL ID (format: "gid://shopify/Product/123456")
    const extractId = (gid) => {
        if (!gid) return null;
        const parts = gid.split('/');
        return parts[parts.length - 1];
    };

    // Map selectedOptions to option1, option2, option3
    const mapVariantOptions = (selectedOptions) => {
        const options = { option1: null, option2: null, option3: null };
        if (!selectedOptions || !Array.isArray(selectedOptions)) return options;

        selectedOptions.forEach((opt, index) => {
            if (index === 0) options.option1 = opt.value;
            else if (index === 1) options.option2 = opt.value;
            else if (index === 2) options.option3 = opt.value;
        });
        return options;
    };

    return {
        id: extractId(graphQLProduct.id),
        handle: graphQLProduct.handle,
        title: graphQLProduct.title,
        product_type: graphQLProduct.productType || '',
        tags: graphQLProduct.tags || [],
        images: graphQLProduct.images?.edges?.map(img => ({
            src: img.node.url
        })) || [],
        // Preserve original Shopify GID for tracking
        shopify_product_gid: graphQLProduct.id || null,
        variants: graphQLProduct.variants?.edges?.map(v => {
            const variant = v.node;
            const options = mapVariantOptions(variant.selectedOptions);
            // Storefront API returns price as MoneyV2 object with amount field
            const price = variant.price?.amount ? parseFloat(variant.price.amount) : 0;
            return {
                id: extractId(variant.id),
                // Preserve original Shopify variant GID for tracking
                shopify_variant_gid: variant.id || null,
                price: price,
                title: variant.title,
                available: variant.availableForSale || false,
                option1: options.option1,
                option2: options.option2,
                option3: options.option3
            };
        }) || []
    };
}

// Load clothing from Shopify using Storefront GraphQL API (unlimited products)
async function loadClothingFromShopify(storeConfig) {
    // Get Shopify credentials from store config
    const shopDomain = storeConfig.shopDomain || storeConfig.storeName || 'm8ir6h-8k.myshopify.com';
    const storefrontToken = storeConfig.storefrontToken;
    const storeId = storeConfig.storeId || 'default-store';

    // Get store slug for Supabase query
    const storeSlug = storeConfig.storeSlug || storeConfig.storeId || window.ELLO_STORE_SLUG || window.ELLO_STORE_ID || 'default_store';

    // Check if we have Storefront API credentials
    if (!storefrontToken) {
        console.warn('⚠️ Storefront token not provided. Falling back to products.json method (limited to 250 products).');
        // Fall back to old products.json method
        return await loadClothingFromShopifyLegacy(storeConfig);
    }

    // Fetch hidden product IDs from Supabase
    const hiddenIds = await fetchHiddenProductIds(storeSlug);


    // Normalize shop domain (ensure it includes .myshopify.com)
    let normalizedDomain = shopDomain;
    if (!normalizedDomain.includes('.')) {
        normalizedDomain = `${normalizedDomain}.myshopify.com`;
    } else if (!normalizedDomain.includes('myshopify.com')) {
        normalizedDomain = `${normalizedDomain.replace(/\.(com|net|org)$/, '')}.myshopify.com`;
    }

    const graphqlEndpoint = `https://${normalizedDomain}/api/2024-01/graphql.json`;

    // GraphQL query to fetch all products with cursor-based pagination
    const PRODUCTS_QUERY = `
        query GetProducts($cursor: String) {
            products(first: 250, after: $cursor) {
                pageInfo {
                    hasNextPage
                    endCursor
                }
                edges {
                    node {
                        id
                        title
                        handle
                        productType
                        tags
                        images(first: 5) {
                            edges {
                                node {
                                    url
                                }
                            }
                        }
                        variants(first: 100) {
                            edges {
                                node {
                                    id
                                    price {
                                        amount
                                    }
                                    title
                                    availableForSale
                                    selectedOptions {
                                        name
                                        value
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    `;

    let allGraphQLProducts = [];
    let cursor = null;
    let pageCount = 0;
    let hasMoreProducts = true;


    // Fetch products using cursor-based pagination
    // Safety cap: 20 × 250 = 5,000 products max to prevent infinite loops
    const MAX_PAGES = 20;

    while (hasMoreProducts && pageCount < MAX_PAGES) {
        try {
            pageCount++;
            const variables = cursor ? { cursor } : {};


            const response = await fetch(graphqlEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Storefront-Access-Token': storefrontToken
                },
                body: JSON.stringify({
                    query: PRODUCTS_QUERY,
                    variables: variables
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`❌ GraphQL request failed (status ${response.status}):`, errorText);
                throw new Error(`GraphQL API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Check for GraphQL errors
            if (data.errors) {
                console.error('❌ GraphQL errors:', data.errors);
                throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
            }

            if (!data.data || !data.data.products) {
                console.error('❌ Invalid GraphQL response format:', data);
                throw new Error('Invalid GraphQL response format');
            }

            const products = data.data.products;
            const pageProducts = products.edges || [];


            if (pageProducts.length === 0) {
                hasMoreProducts = false;
                break;
            }

            // Convert GraphQL products to Shopify format and add to array
            const convertedProducts = pageProducts.map(edge => convertGraphQLProductToShopifyFormat(edge.node));
            allGraphQLProducts = allGraphQLProducts.concat(convertedProducts);

            // Check if there are more pages
            const pageInfo = products.pageInfo;
            if (pageInfo && pageInfo.hasNextPage && pageInfo.endCursor) {
                cursor = pageInfo.endCursor;
                // If we reached max pages but there are more products, log a warning
                if (pageCount >= MAX_PAGES) {
                    console.warn(`⚠️ Reached pagination safety cap (${MAX_PAGES} pages, ${allGraphQLProducts.length} products). Some items may not be visible.`);
                }
            } else {
                hasMoreProducts = false;
            }

        } catch (error) {
            console.error(`❌ Error fetching page ${pageCount}:`, error);
            // If first page fails, try legacy method; otherwise stop pagination
            if (pageCount === 1) {
                console.warn('⚠️ GraphQL API failed on first page. Falling back to products.json method...');
                return await loadClothingFromShopifyLegacy(storeConfig);
            }
            hasMoreProducts = false;
        }
    }


    elloLog(`[Ello Widget] Fetched ${allGraphQLProducts.length} products across ${pageCount} page(s) from Shopify Storefront API`);

    // Remove any potential duplicates
    const uniqueProducts = [];
    const seenIds = new Set();
    const seenHandles = new Set();

    for (const product of allGraphQLProducts) {
        const key = product.id || product.handle;
        if (key && !seenIds.has(key) && !seenHandles.has(product.handle)) {
            seenIds.add(key);
            seenHandles.add(product.handle);
            uniqueProducts.push(product);
        } else if (!key) {
            // Products without IDs should still be included
            uniqueProducts.push(product);
        }
    }

    if (uniqueProducts.length !== allGraphQLProducts.length) {
    }

    const allProducts = uniqueProducts;

    // If no products found, leave empty (no fallback)
    if (allProducts.length === 0) {
        console.warn('⚠️ No products found in Shopify store.');
        sampleClothing = [];
        return;
    }

    // Convert Shopify products to widget format
    const convertedProducts = allProducts
        .filter(product => product && product.handle && product.title)
        .map(product => {
            const firstVariant = product.variants?.[0] || {};
            const firstImage = product.images?.[0] || {};

            // Use normalized domain for product URL
            const productDomain = normalizedDomain || shopDomain;

            return {
                id: product.handle,
                name: product.title,
                price: parseFloat(firstVariant.price || 0),
                category: product.product_type?.toLowerCase() || 'clothing',
                tags: product.tags || [],
                color: getColorFromProduct(product),
                image_url: firstImage.src || '',
                product_url: `https://${productDomain}/products/${product.handle}`,
                shopify_product_id: product.id,
                // Preserve Shopify GID for tracking (from GraphQL conversion)
                shopify_product_gid: product.shopify_product_gid || null,
                data_source: 'shopify',
                variants: (product.variants || []).map(variant => ({
                    id: variant.id,
                    // Preserve Shopify variant GID for tracking (from GraphQL conversion)
                    shopify_variant_gid: variant.shopify_variant_gid || null,
                    title: variant.title,
                    price: parseFloat(variant.price || 0),
                    available: variant.available || false,
                    size: variant.option1,
                    color: variant.option2,
                    option3: variant.option3
                }))
            };
        });

    // Filter out hidden products (active=false in Supabase)
    const visibleProducts = convertedProducts.filter(product => {
        const productId = getProductId(product);
        return productId && !hiddenIds.has(productId);
    });

    // Expose blacklist globally so the preview eligibility check can use it
    window.elloHiddenProductIds = hiddenIds;

    // FILTER REMOVED: All products allowed (dashboard controlled)
    sampleClothing = visibleProducts;


    // If no clothing items found, leave empty (no fallback)
    if (sampleClothing.length === 0) {
        console.warn('⚠️ No clothing items found in Shopify.');
    }
}

// Legacy function: Load clothing from Shopify using products.json (limited to 250 products)
// This is used as a fallback when Storefront API credentials are not available
async function loadClothingFromShopifyLegacy(storeConfig) {
    let shopifyStoreId = storeConfig.storeName || 'm8ir6h-8k';
    const storeId = storeConfig.storeId || 'default-store';

    // Get store slug for Supabase query
    const storeSlug = storeConfig.storeSlug || storeConfig.storeId || window.ELLO_STORE_SLUG || window.ELLO_STORE_ID || 'default_store';

    // 🛠 RESCUE: If storeName is default/missing but we have a shopDomain, try to extract the handle from it
    if ((!shopifyStoreId || shopifyStoreId === 'default-name' || shopifyStoreId.includes('default')) && storeConfig.shopDomain) {
        // Extract 'vengeance-designs-3336' from 'vengeance-designs-3336.myshopify.com'
        const extractedHandle = storeConfig.shopDomain.replace('.myshopify.com', '').replace('https://', '').split(/[/?#]/)[0];
        if (extractedHandle && extractedHandle !== 'default-name') {
            elloLog("🛠 [LEGACY] Extracted shop handle from domain:", extractedHandle);
            shopifyStoreId = extractedHandle;
        }
    }

    // 🛑 STOP: If storeName is still invalid/default, do not attempt legacy fallback (causes 404 spam)
    if (!shopifyStoreId || shopifyStoreId === 'default-name' || shopifyStoreId.includes('default')) {
        console.warn('⚠️ [LEGACY] Invalid store name, skipping legacy fallback to prevent errors:', shopifyStoreId);
        return;
    }

    // Fetch hidden product IDs from Supabase
    const hiddenIds = await fetchHiddenProductIds(storeSlug);

    // Try multiple approaches to access Shopify store
    const possibleBaseUrls = [
        `https://${shopifyStoreId}.myshopify.com`,
        `https://${shopifyStoreId.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase()}.myshopify.com`,
        `https://${shopifyStoreId.replace(/\s+/g, '-')}.myshopify.com`,
        `https://${shopifyStoreId.replace(/\s+/g, '')}.myshopify.com`
    ];

    let baseUrl = null;
    let lastError = null;

    // Find working base URL
    for (const url of possibleBaseUrls) {
        try {
            const testUrl = `${url}/products.json?limit=1`;
            const response = await fetch(testUrl, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                }
            });

            if (response.ok) {
                baseUrl = url;
                break;
            } else {
            }
        } catch (error) {
            lastError = error;
        }
    }

    if (!baseUrl) {
        console.error('❌ [LEGACY] All Shopify URLs failed. Last error:', lastError);
        console.warn('⚠️ [LEGACY] No products found.');
        sampleClothing = [];
        return;
    }

    // Fetch products with pagination (limited to 250 per page)
    let allProducts = [];
    let pageCount = 0;
    let hasMoreProducts = true;
    let sinceId = null;
    const limit = 250;


    while (hasMoreProducts && pageCount < 10) { // Limit to 10 pages (2500 products max)
        try {
            pageCount++;
            let url = `${baseUrl}/products.json?limit=${limit}`;

            if (sinceId) {
                url += `&since_id=${sinceId}`;
            }


            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                }
            });

            if (!response.ok) {
                hasMoreProducts = false;
                break;
            }

            const data = await response.json();

            if (!data.products || !Array.isArray(data.products)) {
                hasMoreProducts = false;
                break;
            }

            const pageProducts = data.products;

            if (pageProducts.length === 0) {
                hasMoreProducts = false;
                break;
            }

            allProducts = allProducts.concat(pageProducts);

            if (pageProducts.length < limit) {
                hasMoreProducts = false;
            } else {
                const lastProduct = pageProducts[pageProducts.length - 1];
                if (lastProduct && lastProduct.id) {
                    const newSinceId = lastProduct.id;
                    if (sinceId && newSinceId === sinceId) {
                        hasMoreProducts = false;
                        break;
                    }
                    sinceId = newSinceId;
                } else {
                    hasMoreProducts = false;
                    break;
                }
            }

        } catch (error) {
            console.error(`🛍️ [LEGACY] Error fetching page ${pageCount}:`, error);
            hasMoreProducts = false;
        }
    }


    if (allProducts.length === 0) {
        console.warn('⚠️ [LEGACY] No products found.');
        sampleClothing = [];
        return;
    }

    // Convert Shopify products to widget format (same as GraphQL version)
    const convertedProducts = allProducts
        .filter(product => product && product.handle && product.title)
        .map(product => {
            const firstVariant = product.variants?.[0] || {};
            const firstImage = product.images?.[0] || {};

            return {
                id: product.handle,
                name: product.title,
                price: parseFloat(firstVariant.price || 0),
                category: product.product_type?.toLowerCase() || 'clothing',
                tags: product.tags || [],
                color: getColorFromProduct(product),
                image_url: firstImage.src || '',
                product_url: `https://${shopifyStoreId}.myshopify.com/products/${product.handle}`,
                shopify_product_id: product.id,
                // Legacy products.json API doesn't provide GIDs, set to null
                shopify_product_gid: null,
                data_source: 'shopify',
                variants: (product.variants || []).map(variant => ({
                    id: variant.id,
                    // Legacy products.json API doesn't provide variant GIDs, set to null
                    shopify_variant_gid: null,
                    title: variant.title,
                    price: parseFloat(variant.price || 0),
                    available: variant.available || false,
                    size: variant.option1,
                    color: variant.option2,
                    option3: variant.option3
                }))
            };
        });

    // Filter out hidden products (active=false in Supabase)
    const visibleProducts = convertedProducts.filter(product => {
        const productId = getProductId(product);
        return productId && !hiddenIds.has(productId);
    });

    // Expose blacklist globally so the preview eligibility check can use it
    window.elloHiddenProductIds = hiddenIds;

    // FILTER REMOVED: All products allowed (dashboard controlled)
    sampleClothing = visibleProducts;


    if (sampleClothing.length === 0) {
        console.warn('⚠️ [LEGACY] No clothing items found.');
    }
}

// Paginated PostgREST fetch helper.
// Uses Range headers (1,000 rows per page) and a safety cap to prevent infinite loops.
async function fetchAllPages(url, headers, maxPages = 20) {
    const PAGE = 1000;
    let from = 0;
    let all = [];
    let pageCount = 0;
    while (pageCount < maxPages) {
        pageCount++;
        const res = await fetch(url, {
            credentials: 'omit',
            headers: {
                ...headers,
                'Range': `${from}-${from + PAGE - 1}`,
                'Range-Unit': 'items'
            }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const batch = await res.json();
        if (!Array.isArray(batch)) throw new Error('Expected array from PostgREST');
        all.push(...batch);
        if (batch.length < PAGE) break;
        from += PAGE;
    }
    return all;
}

// Fetch hidden product IDs from Supabase (products with active=false)
async function fetchHiddenProductIds(storeSlug) {
    // Use store_slug (preferred) or fall back to storeId for backward compatibility
    const slug = storeSlug || window.ELLO_STORE_SLUG || window.ELLO_STORE_ID || 'default_store';

    try {
        // Query clothing_items table: WHERE store_id = store_slug AND data_source = 'shopify' AND active = false
        const url = `${SUPABASE_URL}/rest/v1/clothing_items?store_id=eq.${slug}&data_source=eq.shopify&active=eq.false&select=item_id`;

        const reqHeaders = {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
        };

        const data = await fetchAllPages(url, reqHeaders);
        elloLog(`Ello: loaded ${data.length} hidden overrides`);

        // Extract item_id values into a Set that holds BOTH the raw value and the
        // numeric portion, because clothing_items stores full GIDs
        // ("gid://shopify/Product/123") but getProductId() returns just "123".
        const hiddenIds = new Set();
        data.forEach(item => {
            const id = String(item.item_id || '').trim();
            if (!id) return;
            hiddenIds.add(id); // full GID as stored
            if (id.startsWith('gid://')) {
                const numeric = id.split('/').pop();
                if (numeric) hiddenIds.add(numeric); // numeric portion for getProductId() match
            } else {
                hiddenIds.add(`gid://shopify/Product/${id}`); // full GID for bootstrap path match
            }
        });

        if (hiddenIds.size > 0) {
            elloLog(`🔒 Filtering out ${hiddenIds.size} hidden product(s) from Supabase`);
        }

        return hiddenIds;
    } catch (error) {
        console.error('❌ Error fetching hidden product IDs from Supabase:', error);
        // Fail open - return empty Set so all products are shown
        return new Set();
    }
}

// Helper function to extract product ID from Shopify product (handles GID and numeric formats)
function getProductId(product) {
    if (!product) return null;

    // Try shopify_product_gid first (GID format: "gid://shopify/Product/123456")
    if (product.shopify_product_gid) {
        const parts = product.shopify_product_gid.split('/');
        const id = parts[parts.length - 1];
        return id ? String(id) : null;
    }

    // Try shopify_product_id (could be numeric or string)
    if (product.shopify_product_id) {
        const id = product.shopify_product_id;
        // If it's a GID format, extract the numeric part
        if (typeof id === 'string' && id.includes('/')) {
            const parts = id.split('/');
            return parts[parts.length - 1] || null;
        }
        return String(id);
    }

    // Try id field (could be GID format)
    if (product.id) {
        const id = product.id;
        if (typeof id === 'string' && id.includes('/')) {
            const parts = id.split('/');
            return parts[parts.length - 1] || null;
        }
        return String(id);
    }

    return null;
}

// Clear any leftover cached clothing data from older widget versions.
// Returning visitors might have a stale entry from when caching was enabled —
// removing it ensures they always see fresh data on their next pageview.
function clearLegacyClothingCache(storeSlug) {
    try {
        window.localStorage.removeItem(LEGACY_CLOTHING_CACHE_KEY_PREFIX + storeSlug);
    } catch (e) {
        // Private mode / disabled storage — nothing to clean up anyway
    }
}

// Convert raw Supabase rows into sampleClothing + populate hidden-product blacklist.
// Identical logic to what loadClothingFromSupabase used to do inline — extracted
// so it can run for both cached and freshly-fetched data.
function processClothingRows(data) {
    // Initialize hidden products blacklist (Global)
    window.elloHiddenProductIds = new Set();
    window.elloHiddenTitles = new Set();
    window.elloHiddenHandles = new Set();

    // Convert Supabase products to widget format
    const allProducts = data
        .filter(item => {
            const isValid = item && item.name && item.image_url;
            if (!isValid) {
            }
            return isValid;
        })
        .map(item => {
            const converted = {
                id: item.item_id || item.id || `supabase_${item.name.toLowerCase().replace(/\s+/g, '_')}`,
                name: item.name,
                price: parseFloat(item.price || 0),
                category: item.category?.toLowerCase() || 'clothing',
                tags: item.tags || [],
                color: item.color || 'multicolor',
                image_url: item.image_url,
                product_url: item.product_url || '#',
                // Supabase products don't have Shopify GIDs, set to null
                shopify_product_gid: null,
                // Preserve original data_source from database ('manual' or 'shopify')
                data_source: item.data_source || 'supabase',
                active: item.active !== false, // Default to true if missing
                shopify_product_id: item.shopify_product_id || null, // Ensure field exists
                variants: (item.variants || [{
                    id: item.item_id || item.id,
                    title: 'Default',
                    price: parseFloat(item.price || 0),
                    available: true,
                    size: 'M'
                }]).map(variant => ({
                    ...variant,
                    // Supabase variants don't have Shopify GIDs, set to null
                    shopify_variant_gid: null
                }))
            };
            return converted;
        });

    // FILTER TO ONLY CLOTHING ITEMS & POPULATE BLACKLIST
    sampleClothing = allProducts.filter(product => {
        // Check if hidden (active === false)
        if (!product.active) {
            // Add to blacklist (IDs)
            if (product.id) window.elloHiddenProductIds.add(String(product.id));

            // Add Clean Shopify ID (remove gid://)
            if (product.shopify_product_id) {
                const cleanId = String(product.shopify_product_id).split('/').pop();
                window.elloHiddenProductIds.add(cleanId);
                window.elloHiddenProductIds.add(String(product.shopify_product_id)); // Add full version too
            }

            // Add Title (Lowercase)
            if (product.name) window.elloHiddenTitles.add(product.name.trim().toLowerCase());

            // Add Handle (from URL or Name)
            if (product.product_url && product.product_url !== '#') {
                // Extract handle from URL (e.g. /products/my-handle)
                const handle = product.product_url.split('/').pop().split('?')[0];
                if (handle) window.elloHiddenHandles.add(handle.toLowerCase());
            } else if (product.name) {
                // Fallback: Slugify name
                const slug = product.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
                window.elloHiddenHandles.add(slug);
            }

            // Do not include in sampleClothing
            return false;
        }

        const isClothing = isClothingItem(product);
        if (!isClothing) {
        }
        return isClothing;
    });

    // If no items found, leave empty (no fallback)
    if (sampleClothing.length === 0) {
        console.warn('⚠️ No clothing items found in Supabase.');
    }
}

// Load clothing from Supabase. No client-side caching — every pageview fetches
// fresh so merchant changes appear instantly. Egress savings come from the
// `select=` clause restricting the response to the columns the widget actually
// reads (avoids serializing wide row data).
async function loadClothingFromSupabase(storeConfig) {
    // Use store_slug (preferred) or fall back to storeId for backward compatibility
    const storeSlug = storeConfig.storeSlug || storeConfig.storeId || 'default_store';

    // Sweep any leftover cache from earlier widget versions so returning visitors
    // don't accidentally render stale data on first load after the upgrade.
    clearLegacyClothingCache(storeSlug);

    // Query clothing_items table: WHERE store_id = store_slug ORDER BY created_at DESC
    // 'active=eq.true' is intentionally NOT applied — we need hidden items for the blacklist.
    const url = `${SUPABASE_URL}/rest/v1/clothing_items?store_id=eq.${storeSlug}&order=created_at.desc&select=${CLOTHING_SELECT_COLUMNS}`;

    const reqHeaders = {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
    };

    try {
        // Paginate through all results (PostgREST caps at 1,000 per response)
        const data = await fetchAllPages(url, reqHeaders);
        elloLog(`Ello: loaded ${data.length} clothing items from Supabase`);
        processClothingRows(data);
    } catch (error) {
        console.error('❌ Error loading from Supabase:', error);
        // Leave empty on error - no fallback to mock data
        sampleClothing = [];
    }
}

// Utility function for retry logic
async function fetchWithRetry(url, options, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(url, options);
            return response;
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // Exponential backoff
        }
    }
}


// Helper function to extract product ID from URL
function getProductIdFromUrl(url) {
    if (!url) return null;
    try {
        const matches = url.match(/\/products\/([^\/\?]+)/);
        return matches ? matches[1] : null;
    } catch (e) { return null; }
}

// 🎯 UPDATED detectCurrentProduct FUNCTION:
function detectCurrentProduct() {
    let product = null;

    // Method 1: Check URL for product handle (most reliable)
    const urlPath = window.location.pathname;
    const productHandle = getProductIdFromUrl(urlPath);

    if (productHandle) {
        // Find matching product in our loaded data
        product = sampleClothing.find(item => item.id === productHandle);
        // if (product) return product; // Don't return yet, let it fall through to price check
    }

    if (!product) {
        // Method 2: Check Shopify analytics object
        if (window.ShopifyAnalytics && window.ShopifyAnalytics.meta && window.ShopifyAnalytics.meta.product) {
            const productId = window.ShopifyAnalytics.meta.product.id; // Number or String
            // Match by shopify_product_id (loose comparison for string/number)
            product = sampleClothing.find(item => item.shopify_product_id == productId);
            if (product) { /* Found */ }
        }
    }

    if (!product) {
        // Method 3: Look for JSON-LD structured data
        const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (let script of jsonLdScripts) {
            try {
                const jsonData = JSON.parse(script.textContent);
                // Check for Product type (could be array or single object)
                const data = Array.isArray(jsonData) ? jsonData.find(d => d['@type'] === 'Product') : jsonData;

                if (data && data['@type'] === 'Product' && data.url) {
                    const urlHandle = getProductIdFromUrl(data.url) || data.url.split('/').pop().split('?')[0];
                    product = sampleClothing.find(item => item.id === urlHandle);
                    if (product) break; // Break loop if found
                }
            } catch (e) {
                // JSON parsing failed, continue
            }
        }
    }

    if (!product) {
        // Method 4 (Fallback): Check for "Add to Cart" form but ONLY if URL looks like a product page
        // This prevents false positives on generic pages or quick-view modals on collections
        const isProductUrl = window.location.pathname.includes('/products/'); // Strict URL check
        const addToCartForm = document.querySelector('form[action*="/cart/add"]');

        // Guardrail: Only use fallback if we are STRICTLY on a product URL path
        if (isProductUrl && addToCartForm && !product) {
            // We are likely on a product page. 
            // As a last resort, try to construct a valid product object from standard meta tags.
            // This is important for the fallback "preview never shows" risk.
            const ogTitle = document.querySelector('meta[property="og:title"]')?.content;
            const ogImage = document.querySelector('meta[property="og:image"]')?.content;

            // Guardrail: Ensure og:image is not a generic placeholder (not perfect, but helpful)
            // And strictly require both title and image
            if (ogTitle && ogImage) {
                // Construct temporary product
                product = {
                    id: productHandle || 'unknown-product', // fallback ID
                    name: ogTitle,
                    title: ogTitle, // Add title for compatibility
                    image_url: ogImage,
                    variants: [],
                    category: 'clothing',
                    product_url: window.location.href,
                    isFallback: true
                };
            }
        }
    } // Close if (!product) block

    if (!product) {
        // Method 5: Check by Title (existing logic, refactored)
        const productTitleSelectors = [
            '.product-title', '.product__title', 'h1.product-single__title',
            '.product-form__title', '.product__heading', '[data-product-title]'
        ];

        for (let selector of productTitleSelectors) {
            const titleElement = document.querySelector(selector);
            if (titleElement) {
                const title = titleElement.textContent.trim();
                product = sampleClothing.find(item => {
                    const itemName = (item.name || item.title || "").toLowerCase();
                    const pageTitle = title.toLowerCase();
                    return itemName === pageTitle ||
                        pageTitle.includes(itemName) ||
                        itemName.includes(pageTitle);
                });
                if (product) break; // Found
            }
        }
    } // Close if (!product) block

    // Helper: Scrape price from page
    function scrapePrice() {
        const priceSelectors = [
            '.price', '.product-price', '.product__price',
            '[data-product-price]', '.price-item--regular', '.price-item--sale',
            '#ProductPrice', '.money'
        ];

        for (let sel of priceSelectors) {
            const els = document.querySelectorAll(sel);
            for (let el of els) {
                // Look for something that looks like money (e.g., $55.00, 55.00 USD)
                const text = el.innerText.trim();
                if (/[\d,]+\.\d{2}/.test(text) || /\$\d+/.test(text)) {
                    // Extract numeric value
                    const num = parseFloat(text.replace(/[^0-9.]/g, ''));
                    if (!isNaN(num) && num > 0) return num;
                }
            }
        }
        return null;
    }

    // Attempt to update price if product found
    if (product) {
        const livePrice = scrapePrice();
        if (livePrice) {
            elloLog(`[Ello VTO] Updated price for ${product.name} from DOM: $${livePrice}`);
            product.price = livePrice;
            // Also update variants prices if they exist and are default/zero
            if (product.variants) {
                product.variants.forEach(v => {
                    if (!v.price || v.price === 0) v.price = livePrice;
                });
            }
        }
        return product;
    }

    return null;
}

// Helper function to extract color from product data
function getColorFromProduct(product) {
    // Check product tags for colors
    const colors = ['red', 'blue', 'green', 'black', 'white', 'pink', 'yellow', 'purple', 'orange', 'brown', 'gray', 'navy', 'beige'];

    // Check tags first
    if (product.tags && Array.isArray(product.tags)) {
        for (let tag of product.tags) {
            if (typeof tag === 'string') {
                for (let color of colors) {
                    if (tag.toLowerCase().includes(color)) {
                        return color;
                    }
                }
            }
        }
    }

    // Check product title
    const title = (product.title || product.name || "").toLowerCase();
    for (let color of colors) {
        if (title.includes(color)) {
            return color;
        }
    }

    // Check variants for color options
    if (product.variants && product.variants[0] && product.variants[0].option2) {
        const option2 = product.variants[0].option2.toLowerCase();
        for (let color of colors) {
            if (option2.includes(color)) {
                return color;
            }
        }
    }

    // Default fallback
    return 'multicolor';
}

// State
let widgetOpen = false;
let currentMode = 'tryon';
let selectedClothing = null;
let userPhoto = null;
let userPhotoFileId = null;
const PHOTO_BODY_REJECTION_MESSAGE = "Hey, you have to upload another one because there was no body detected in this image.";
let activePhotoValidationId = null;
let activePhotoValidationStatus = 'idle';
let lastRejectedPhotoValidationId = null;

// Storage keys for photo persistence
const USER_PHOTO_STORAGE_KEY = 'vtow_user_photo';
const USER_PHOTO_FILE_ID_STORAGE_KEY = 'vtow_user_photo_file_id';

// Compress image to reduce storage size
function compressImage(imageDataUrl, maxWidth = 800, quality = 0.7) {
    return new Promise((resolve) => {
        try {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                // Calculate new dimensions
                if (width > maxWidth) {
                    height = (height * maxWidth) / width;
                    width = maxWidth;
                }

                canvas.width = width;
                canvas.height = height;

                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                // Convert to compressed JPEG
                const compressed = canvas.toDataURL('image/jpeg', quality);
                resolve(compressed);
            };
            img.onerror = () => {
                // If compression fails, return original
                resolve(imageDataUrl);
            };
            img.src = imageDataUrl;
        } catch (error) {
            resolve(imageDataUrl);
        }
    });
}

// Clean up old storage data to free space
function cleanupStorage() {
    try {
        // Clear old wardrobe items (keep only last 8 for performance)
        const wardrobe = getWardrobe();
        if (wardrobe.length > 8) {
            // Sort by timestamp and keep only most recent 8
            wardrobe.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            const cleanedWardrobe = wardrobe.slice(0, 8);
            saveWardrobe(cleanedWardrobe).catch(err => console.error('Error cleaning wardrobe:', err));
        }

        // Clear any other large localStorage items if needed
        const keysToCheck = ['vtow_user_photo', 'virtual_tryon_wardrobe'];
        for (const key of keysToCheck) {
            try {
                const item = localStorage.getItem(key) || sessionStorage.getItem(key);
                if (item && item.length > 1000000) { // If item is > 1MB
                    if (key === 'vtow_user_photo') {
                        localStorage.removeItem(key);
                    } else {
                        sessionStorage.removeItem(key);
                    }
                }
            } catch (e) {
                // Ignore errors during cleanup
            }
        }
    } catch (error) {
    }
}

// Load saved photo from localStorage
function loadSavedPhoto() {
    try {
        const savedPhoto = localStorage.getItem(USER_PHOTO_STORAGE_KEY);
        const savedFileId = localStorage.getItem(USER_PHOTO_FILE_ID_STORAGE_KEY);

        if (savedPhoto) {
            userPhoto = savedPhoto;
            userPhotoFileId = savedFileId || 'photo_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            activePhotoValidationId = userPhotoFileId;
            activePhotoValidationStatus = 'valid';
            lastRejectedPhotoValidationId = null;

            // Update both Full Widget and Preview UI
            updatePhotoPreview(savedPhoto);
            updatePreviewUserPhoto(savedPhoto);

            // Also update window.elloUserImageUrl for the API
            window.elloUserImageUrl = savedPhoto;
            return true;
        }
    } catch (error) {
        console.error('Error loading saved photo:', error);
    }
    return false;
}

// Debounce timer for photo saves
let photoSaveTimer = null;

// Save photo to localStorage with compression (non-blocking)
async function savePhotoToStorage(photoData, fileId) {
    return new Promise((resolve) => {
        // Clear any pending save
        if (photoSaveTimer) {
            clearTimeout(photoSaveTimer);
        }

        // Defer save to avoid blocking main thread
        photoSaveTimer = setTimeout(async () => {
            try {
                if (photoData) {
                    // Compress image before storing (reduced size for better performance)
                    const compressed = await compressImage(photoData, 700, 0.65);

                    // Use requestIdleCallback for non-blocking write
                    const saveToStorage = () => {
                        try {
                            localStorage.setItem(USER_PHOTO_STORAGE_KEY, compressed);
                            if (fileId) {
                                localStorage.setItem(USER_PHOTO_FILE_ID_STORAGE_KEY, fileId);
                            }
                            resolve();
                        } catch (error) {
                            if (error.name === 'QuotaExceededError') {
                                console.warn('Storage quota exceeded, cleaning up...');
                                cleanupStorage();
                                // Try again with more compression (async, non-blocking)
                                compressImage(photoData, 500, 0.55).then(moreCompressed => {
                                    setTimeout(() => {
                                        try {
                                            localStorage.setItem(USER_PHOTO_STORAGE_KEY, moreCompressed);
                                            if (fileId) {
                                                localStorage.setItem(USER_PHOTO_FILE_ID_STORAGE_KEY, fileId);
                                            }
                                        } catch (retryError) {
                                            console.warn('Still exceeded quota after cleanup. Photo not saved.');
                                        }
                                        resolve();
                                    }, 0);
                                });
                            } else {
                                console.error('Error saving photo:', error);
                                resolve();
                            }
                        }
                    };

                    if (window.requestIdleCallback) {
                        requestIdleCallback(saveToStorage, { timeout: 500 });
                    } else {
                        setTimeout(saveToStorage, 0);
                    }
                } else {
                    // Clear storage if photo is null (non-blocking)
                    const clearStorage = () => {
                        try {
                            localStorage.removeItem(USER_PHOTO_STORAGE_KEY);
                            localStorage.removeItem(USER_PHOTO_FILE_ID_STORAGE_KEY);
                        } catch (e) {
                            // Ignore errors
                        }
                        resolve();
                    };
                    if (window.requestIdleCallback) {
                        requestIdleCallback(clearStorage, { timeout: 100 });
                    } else {
                        setTimeout(clearStorage, 0);
                    }
                }
            } catch (error) {
                console.error('Error saving photo to storage:', error);
                if (error.name === 'QuotaExceededError') {
                    console.warn('Storage quota exceeded. Photo not saved.');
                }
                resolve();
            }
        }, 200); // 200ms debounce for photo saves
    });
}

// Clear saved photo from storage
function clearSavedPhoto() {
    try {
        localStorage.removeItem(USER_PHOTO_STORAGE_KEY);
        localStorage.removeItem(USER_PHOTO_FILE_ID_STORAGE_KEY);
    } catch (error) {
        console.error('Error clearing saved photo:', error);
    }
}

function resetActivePhotoValidation() {
    activePhotoValidationId = null;
    activePhotoValidationStatus = 'idle';
}

function isActivePhotoValidation(photoId) {
    return photoId && photoId === activePhotoValidationId && photoId === userPhotoFileId;
}

function clearPreviewUserPhoto() {
    const previewTile = document.getElementById('previewUploadTile');
    const previewImg = document.getElementById('previewUserPhoto');
    const previewTryBtn = document.getElementById('previewTryBtn');
    const previewAnalysisOverlay = document.getElementById('previewAnalysisOverlay');

    if (previewImg) {
        previewImg.removeAttribute('src');
    }
    if (previewTile) {
        previewTile.classList.remove('has-photo');
    }
    if (previewTryBtn) {
        previewTryBtn.disabled = true;
        previewTryBtn.style.cursor = '';
    }
    if (previewAnalysisOverlay) {
        previewAnalysisOverlay.style.display = 'none';
    }
}

function rejectActivePhotoAfterBodyCheck(photoId) {
    if (!isActivePhotoValidation(photoId)) {
        return;
    }

    activePhotoValidationStatus = 'invalid';
    lastRejectedPhotoValidationId = photoId;
    resetPhotoUploadArea();
    resetPreviewUI();
    clearPreviewUserPhoto();
    clearSavedPhoto();
    showError(PHOTO_BODY_REJECTION_MESSAGE);

    if (dedupeWindow('photo_upload_fail_no_body', 2000)) {
        trackEvent('photo_upload_fail', {
            reason: 'no_body_detected',
            error: PHOTO_BODY_REJECTION_MESSAGE,
            after_upload: true,
        });
    }

    showSuccessNotification('Upload Another Photo', PHOTO_BODY_REJECTION_MESSAGE, 6000, true);
}

function runBackgroundBodyValidation(imageDataUrl, photoId) {
    // The photo is already saved at upload time. This pass only downgrades:
    // a hard rejection clears the persisted copy and warns; anything else leaves it saved.
    detectBodyInImage(imageDataUrl).then((bodyResult) => {
        if (!isActivePhotoValidation(photoId)) {
            return;
        }

        if (bodyResult && bodyResult.state === 'reject') {
            rejectActivePhotoAfterBodyCheck(photoId);
            return;
        }

        activePhotoValidationStatus = 'valid';

        if (bodyResult && bodyResult.state === 'warning' && bodyResult.message) {
            showSuccessNotification('Quality Tips', bodyResult.message, 4000, false);
        }
    }).catch((error) => {
        elloLog('Background body validation error:', error);
        if (!isActivePhotoValidation(photoId)) {
            return;
        }
        activePhotoValidationStatus = 'valid';
    });
}
// Generate or retrieve persistent sessionId from localStorage (per store)
// This ensures rate limiting works across tabs/windows for the same browser
const ELLO_STORE_SLUG_FOR_KEY = window.ELLO_STORE_ID || window.ELLO_STORE_SLUG || 'default_store';
const ELLO_SESSION_KEY = `ello_session_id_${ELLO_STORE_SLUG_FOR_KEY}`;
const ELLO_SESSION_TS_KEY = `ello_session_ts_${ELLO_STORE_SLUG_FOR_KEY}`;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

let sessionId = null;

try {
    const existing = window.localStorage.getItem(ELLO_SESSION_KEY);
    const lastActive = parseInt(window.localStorage.getItem(ELLO_SESSION_TS_KEY) || '0', 10);
    const now = Date.now();

    // Rotate session if older than 30 mins OR if no existing session
    if (existing && now - lastActive < SESSION_TIMEOUT_MS) {
        sessionId = existing;
    } else {
        sessionId = generateSessionId();
        window.localStorage.setItem(ELLO_SESSION_KEY, sessionId);
    }
    // Update timestamp on every load
    window.localStorage.setItem(ELLO_SESSION_TS_KEY, now.toString());
} catch (e) {
    console.warn('⚠️ localStorage blocked, using ephemeral session ID:', e);
    sessionId = generateSessionId();
}

// Write session_id to a cookie so the Web Pixel can read it (pixels can't access localStorage).
// 7-day lifetime captures delayed purchases — user tries on Monday, buys Thursday.
try {
    document.cookie = `ello_session_id=${sessionId}; path=/; max-age=604800; SameSite=Lax`;
} catch (e) { }
elloLog("[Ello Widget] Session ID:", sessionId);

/**
 * Updates the session activity timestamp to prevent premature rotation
 */
function updateSessionActivity() {
    try {
        window.localStorage.setItem(ELLO_SESSION_TS_KEY, Date.now().toString());
    } catch (e) { }
}

// Sync with window.ELLO_SESSION_ID for backward compatibility
window.ELLO_SESSION_ID = sessionId;
let filteredClothing = [...sampleClothing];
let userEmail = null;
let tryonChatHistory = [];
let generalChatHistory = [];
let currentTryOnId = null;
let currentFeaturedItem = null;
let isTryOnProcessing = false; // Track if try-on is currently processing
let isRateLimited = false; // Track if user has hit rate limit
let browserCurrentPage = 1; // Current page in browser

// --- Analytics State & Context ---
const WIDGET_VERSION = '2.4.0';
let widgetViewId = null;
let introViewId = null;
let introShownAt = null;
let introActionFired = false;
let isFirstTimeIntro = false;
let uploadAttemptId = null;
let hadMeaningfulAction = false;

/**
 * Marks that a user has performed a meaningful action (not a bounce)
 */
function markMeaningfulAction() {
    hadMeaningfulAction = true;
    updateSessionActivity();
}

// Deduplication maps
const trackDedupeMap = new Map();

function dedupeOnce(key) {
    if (trackDedupeMap.has(key)) return false;
    trackDedupeMap.set(key, Date.now());
    return true;
}

function dedupeWindow(key, windowMs = 2000) {
    const now = Date.now();
    const last = trackDedupeMap.get(key);
    if (last && now - last < windowMs) return false;
    trackDedupeMap.set(key, now);
    return true;
}

function generateIntroViewId() {
    return `${window.ELLO_SESSION_ID}-${Date.now()}`;
}

// Classify the current page into a structured context. Doing this client-side
// (rather than re-parsing pathname downstream) gives a single, consistent tag
// the dashboard can group on instead of trying to derive page type from raw
// URLs. `type` is the field to slice on; the rest is for debugging / drilldown.
//
// Possible `type` values:
//   home              — store root
//   pdp_clothing      — /products/<handle>, product is in the enabled catalog
//   pdp_other         — /products/<handle>, product NOT in the enabled catalog (the "wrong-page bounce" surface)
//   pdp_unknown       — /products/<handle>, catalog hasn't loaded yet (rare; race condition)
//   collection        — /collections/<handle>
//   collection_all    — /collections/all
//   cart              — /cart
//   search            — /search
//   page              — /pages/<handle> (CMS pages)
//   blog              — /blogs/...
//   account           — /account...
//   other             — anything we don't recognize
function getPageContext() {
    const path = window.location.pathname || '/';
    let type = 'other';
    let handle = null;
    let inCatalog = null;

    if (path === '/' || path === '') {
        type = 'home';
    } else if (path.includes('/products/')) {
        handle = path.split('/products/')[1].split(/[/?#]/)[0] || null;
        if (_elloClothingDataLoaded && Array.isArray(sampleClothing)) {
            // Match by handle, falling back to extracting handle from product_url.
            // Items loaded from clothing_items (Supabase) only have product_url —
            // no top-level handle field — so a strict p.handle === handle check
            // misses every match and tags real catalog items as pdp_other.
            const match = handle ? sampleClothing.find(p => {
                if (!p) return false;
                if (p.handle && p.handle === handle) return true;
                const url = p.product_url || p.url;
                if (url) {
                    const urlHandle = url.split('/products/')[1]?.split(/[/?#]/)[0];
                    if (urlHandle && urlHandle === handle) return true;
                }
                return false;
            }) : null;
            inCatalog = !!match;
            type = inCatalog ? 'pdp_clothing' : 'pdp_other';
        } else {
            type = 'pdp_unknown';
        }
    } else if (path.includes('/collections/')) {
        handle = path.split('/collections/')[1].split(/[/?#]/)[0] || null;
        type = handle === 'all' ? 'collection_all' : 'collection';
    } else if (path === '/cart' || path.startsWith('/cart')) {
        type = 'cart';
    } else if (path.startsWith('/search')) {
        type = 'search';
    } else if (path.includes('/pages/')) {
        type = 'page';
        handle = path.split('/pages/')[1].split(/[/?#]/)[0] || null;
    } else if (path.includes('/blogs/')) {
        type = 'blog';
    } else if (path.startsWith('/account')) {
        type = 'account';
    }

    return {
        type,
        handle,
        in_catalog: inCatalog,
        path,
        url: window.location.href
    };
}

async function trackEvent(eventName, eventData = {}) {
    const storeSlug = window.ELLO_STORE_CONFIG?.storeSlug || window.ELLO_STORE_SLUG || window.ELLO_STORE_ID || 'default_store';
    const storeId = window.ELLO_STORE_ID || storeSlug;
    const pageContext = getPageContext();

    const payload = {
        p_event_name: eventName,
        p_store_id: storeId,
        p_store_slug: storeSlug,
        p_session_id: window.ELLO_SESSION_ID,
        p_widget_view_id: widgetViewId,
        p_intro_view_id: introViewId,
        p_device: isMobile ? 'mobile' : 'desktop',
        p_page_path: pageContext.path + (window.location.search || ''),
        p_is_first_time: isFirstTimeIntro,
        p_widget_version: WIDGET_VERSION,
        p_event_data: {
            ...eventData,
            upload_attempt_id: uploadAttemptId,
            page: pageContext
        }
    };

    // Use fetch with keepalive for reliability (replaces sendBeacon due to CORS credential issues)
    fetch(`${SUPABASE_URL}/rest/v1/rpc/record_widget_event`, {
        method: 'POST',
        keepalive: true,
        credentials: 'omit', // Required for CORS when origin is * 
        headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    }).catch(err => console.warn('Event tracking failed:', err));
}

async function trackWidgetOpen() {
    // Single source of truth: trackEvent('widget_open') writes a row to
    // widget_events with full pageContext in event_data.page (auto-extracted
    // to page_type/handle/in_catalog columns by record_widget_event RPC).
    // The legacy recordWidgetOpenRPC() call was removed — it wrote a duplicate
    // widget_open row without page context, inflating the "unknown" bucket
    // in get_widget_funnel_by_page and doubling widget_events write volume.
    await trackEvent('widget_open');
}

// NOTE: Client-side record_tryon_event has been intentionally removed.
// The server-side /tryon proxy (Cloud Run) is the single source of truth for
// billing — it calls record_tryon_event via checkAndRecordUsage() exactly once
// per try-on request. Having the client also call it was causing duplicate rows
// in tryon_events (same session_id + product_id, 0.6–5s apart).
// Dynamic responsive page size
function getResponsivePageSize() {
    const width = window.innerWidth;
    if (width < 480) return 6;   // Mobile: 2 cols x 3 rows
    if (width < 768) return 8;   // Tablet: 2 cols x 4 rows
    if (width < 1200) return 12; // Laptop: 4 cols x 3 rows
    return 16;                   // Desktop: 4 cols x 4 rows
}

let browserItemsPerPage = getResponsivePageSize();

// Update page size on resize (debounced to avoid long tasks / INP regression)
let _resizeTimer = 0;
window.addEventListener('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
        const newSize = getResponsivePageSize();
        if (newSize !== browserItemsPerPage) {
            browserItemsPerPage = newSize;
            const modal = document.getElementById('clothingBrowserModal');
            if (modal && modal.classList.contains('active')) {
                updateBrowserDisplay();
            }
        }
    }, 150);
});

function detectDevice() {
    const userAgent = navigator.userAgent.toLowerCase();
    const viewport = window.innerWidth;

    const mobileUserAgents = /android|webos|iphone|ipod|blackberry|iemobile|opera mini/i.test(userAgent);
    const ipadUserAgent = /ipad/i.test(userAgent);
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const isFinePointer = window.matchMedia('(pointer: fine)').matches;

    // Enhanced mobile detection: treat touch devices without fine pointers as mobile/tablet
    isMobile = (mobileUserAgents && !ipadUserAgent) && isTouchDevice && viewport <= 768;
    isTablet = (ipadUserAgent || (/android/i.test(userAgent) && viewport > 768)) && isTouchDevice;

    // Override isMobile for preview logic purposes if pointer is coarse
    if (!isFinePointer && isTouchDevice) {
        // Treat as mobile for preview purposes (this flag is used by triggers)
        // However, since triggers check (pointer: fine) directly, we don't strictly need to force isMobile = true here
        // unless other mobile logic depends on it. For now, leave as is or set isMobile = true if desired.
        // Let's safe-guard:
        // isMobile = true; 
    }

    isIOS = /iphone|ipad|ipod/i.test(userAgent);
    isAndroid = /android/i.test(userAgent);

    if (isMobile) {
        document.body.classList.add('is-mobile');
    } else {
        document.body.classList.remove('is-mobile');
    }

    const cameraControls = document.getElementById('cameraControls');
    if (cameraControls) {
        if (isMobile) {
            cameraControls.classList.add('mobile');
            cameraControls.style.display = 'flex';
        } else {
            cameraControls.classList.remove('mobile');
            cameraControls.style.display = 'none';
        }
    }
}

function generateSessionId() {
    return 'session_' + Math.random().toString(36).substr(2, 9);
}

function generateTryOnId() {
    return 'tryon_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function takePicture() {
    if (!isMobile) {
        alert('Camera is only available on mobile devices');
        return;
    }

    if (dedupeWindow('photo_upload_start', 2000)) {
        uploadAttemptId = `${window.ELLO_SESSION_ID}-${Date.now()}`;
        trackEvent('photo_upload_start', { method: 'camera' });
    }

    // Show best practices modal if not dismissed
    if (checkShouldShowBestPractices()) {
        pendingPhotoAction = proceedWithTakePicture;
        showBestPracticesModal();
        return;
    }

    proceedWithTakePicture();
}

function proceedWithTakePicture() {
    try {
        const cameraInput = document.getElementById('cameraInput');

        if (isIOS) {
            const newCameraInput = document.createElement('input');
            newCameraInput.type = 'file';
            newCameraInput.accept = 'image/*';
            newCameraInput.capture = 'environment';
            newCameraInput.style.display = 'none';
            newCameraInput.onchange = handlePhotoUpload;

            document.body.appendChild(newCameraInput);

            setTimeout(() => {
                newCameraInput.click();
                setTimeout(() => {
                    if (newCameraInput.parentNode) {
                        newCameraInput.parentNode.removeChild(newCameraInput);
                    }
                }, 1000);
            }, 100);
        } else {
            cameraInput.value = '';
            setTimeout(() => {
                cameraInput.click();
            }, 100);
        }

    } catch (error) {
        console.error('Error taking picture:', error);
        alert('Unable to access camera. Please try selecting from gallery instead.');
    }
}

function chooseFromGallery() {
    if (!isMobile) {
        handlePhotoUploadClick();
        return;
    }

    if (dedupeWindow('photo_upload_start', 2000)) {
        uploadAttemptId = `${window.ELLO_SESSION_ID}-${Date.now()}`;
        trackEvent('photo_upload_start', { method: 'gallery' });
    }

    // Show best practices modal if not dismissed
    if (checkShouldShowBestPractices()) {
        pendingPhotoAction = proceedWithChooseFromGallery;
        showBestPracticesModal();
        return;
    }

    proceedWithChooseFromGallery();
}

function proceedWithChooseFromGallery() {
    try {
        const photoInput = document.getElementById('photoInput');

        if (isIOS) {
            const newPhotoInput = document.createElement('input');
            newPhotoInput.type = 'file';
            newPhotoInput.accept = 'image/*';
            newPhotoInput.style.display = 'none';
            newPhotoInput.onchange = handlePhotoUpload;

            document.body.appendChild(newPhotoInput);

            setTimeout(() => {
                newPhotoInput.click();
                setTimeout(() => {
                    if (newPhotoInput.parentNode) {
                        newPhotoInput.parentNode.removeChild(newPhotoInput);
                    }
                }, 1000);
            }, 100);
        } else {
            photoInput.value = '';
            setTimeout(() => {
                photoInput.click();
            }, 100);
        }

    } catch (error) {
        console.error('Error choosing from gallery:', error);
        alert('Unable to access photo gallery. Please try again.');
    }
}

// Best Practices Modal Functions
function checkShouldShowBestPractices() {
    try {
        const dismissed = localStorage.getItem('vtow_best_practices_dismissed');
        return dismissed !== 'true';
    } catch (error) {
        console.error('Error checking best practices preference:', error);
        return true; // Default to showing if we can't check
    }
}

function dismissBestPractices(dontShowAgain) {
    try {
        if (dontShowAgain) {
            localStorage.setItem('vtow_best_practices_dismissed', 'true');
        }
    } catch (error) {
        console.error('Error saving best practices preference:', error);
    }
}

function showBestPracticesModal() {
    const modal = document.getElementById('bestPracticesModal');
    const backdrop = document.getElementById('bestPracticesBackdrop');

    if (modal && backdrop) {
        modal.classList.add('active');
        backdrop.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
}

function closeBestPracticesModal(skipPendingAction = false) {
    const modal = document.getElementById('bestPracticesModal');
    const backdrop = document.getElementById('bestPracticesBackdrop');

    if (modal && backdrop) {
        modal.classList.remove('active');
        backdrop.classList.remove('active');
        document.body.style.overflow = '';

        // Execute pending photo action if any (when closing via backdrop/close button, not Got It)
        // Execute pending photo action if any (when closing via backdrop/close button, not Got It)
        // BUG FIX: Don't automatically execute action when closing. Only explicit affirmative action should trigger it.
        if (!skipPendingAction && pendingPhotoAction) {
            // Clear it without executing
            pendingPhotoAction = null;
        }
    }
}

let pendingPhotoAction = null; // Track pending photo action after modal close

function handleBestPracticesDismiss() {
    const dontShowAgain = document.getElementById('dontShowAgainCheckbox');
    dismissBestPractices(dontShowAgain?.checked || false);

    // Clear pending action before closing (we'll execute it manually)
    const action = pendingPhotoAction;
    pendingPhotoAction = null;

    closeBestPracticesModal(true); // Skip pending action execution in close

    // Execute pending photo action if any
    if (action) {
        setTimeout(() => {
            action();
        }, 300);
    }
}

function handleBestPracticesUpload() {
    const dontShowAgain = document.getElementById('dontShowAgainCheckbox');
    dismissBestPractices(dontShowAgain?.checked || false);

    // Close the modal
    closeBestPracticesModal(true);

    // Execute pending photo action if it exists (from gallery, camera button, or photo change)
    const action = pendingPhotoAction;
    pendingPhotoAction = null;

    // Trigger photo upload after a short delay to allow modal to close
    setTimeout(() => {
        if (action) {
            // Execute the pending action (proceedWithChooseFromGallery, proceedWithTakePicture, or handlePhotoUploadClick)
            action();
        } else {
            // Fallback to default behavior - trigger file picker directly
            const photoInput = document.getElementById('photoInput');
            if (photoInput) {
                photoInput.value = '';

                if (isIOS) {
                    const newPhotoInput = document.createElement('input');
                    newPhotoInput.type = 'file';
                    newPhotoInput.accept = 'image/*';
                    newPhotoInput.style.display = 'none';
                    newPhotoInput.onchange = handlePhotoUpload;

                    document.body.appendChild(newPhotoInput);

                    setTimeout(() => {
                        newPhotoInput.click();
                        setTimeout(() => {
                            if (newPhotoInput.parentNode) {
                                newPhotoInput.parentNode.removeChild(newPhotoInput);
                            }
                        }, 1000);
                    }, 100);
                } else {
                    setTimeout(() => {
                        photoInput.click();
                    }, 100);
                }
            }
        }
    }, 300);
}

function handlePhotoUploadClick() {
    // Track intro CTA click before process starts
    if (isFirstTimeIntro && introShownAt && !introActionFired) {
        introActionFired = true;
        markMeaningfulAction(); // User explicitly chose a path
        const timeToAct = Date.now() - introShownAt;
        trackEvent('intro_cta_click', { cta: 'use_my_photo', time_to_action_ms: timeToAct });
    }

    if (dedupeWindow('photo_upload_start', 2000)) {
        uploadAttemptId = `${window.ELLO_SESSION_ID}-${Date.now()}`;
        trackEvent('photo_upload_start', { method: 'file_picker' });
    }

    // Show best practices modal if not dismissed
    if (checkShouldShowBestPractices()) {
        // Set up pending action to trigger file picker (works for both mobile and desktop)
        pendingPhotoAction = () => {
            const photoInput = document.getElementById('photoInput');
            if (photoInput) {
                // Reset the input value to allow selecting the same file again if needed
                photoInput.value = '';

                if (isIOS) {
                    // On iOS, create a new input element
                    const newPhotoInput = document.createElement('input');
                    newPhotoInput.type = 'file';
                    newPhotoInput.accept = 'image/*';
                    newPhotoInput.style.display = 'none';
                    newPhotoInput.onchange = handlePhotoUpload;

                    document.body.appendChild(newPhotoInput);

                    setTimeout(() => {
                        newPhotoInput.click();
                        setTimeout(() => {
                            if (newPhotoInput.parentNode) {
                                newPhotoInput.parentNode.removeChild(newPhotoInput);
                            }
                        }, 1000);
                    }, 100);
                } else {
                    // On Android/Desktop, use the existing input
                    setTimeout(() => {
                        photoInput.click();
                    }, 100);
                }
            }
        };
        showBestPracticesModal();
        return;
    }

    // If modal was dismissed, proceed normally
    if (isMobile) {
        // On mobile, trigger file picker directly
        const photoInput = document.getElementById('photoInput');
        if (photoInput) {
            photoInput.value = '';
            if (isIOS) {
                const newPhotoInput = document.createElement('input');
                newPhotoInput.type = 'file';
                newPhotoInput.accept = 'image/*';
                newPhotoInput.style.display = 'none';
                newPhotoInput.onchange = handlePhotoUpload;

                document.body.appendChild(newPhotoInput);

                setTimeout(() => {
                    newPhotoInput.click();
                    setTimeout(() => {
                        if (newPhotoInput.parentNode) {
                            newPhotoInput.parentNode.removeChild(newPhotoInput);
                        }
                    }, 1000);
                }, 100);
            } else {
                setTimeout(() => {
                    photoInput.click();
                }, 100);
            }
        }
    } else {
        // On desktop, trigger file input click
        const photoInput = document.getElementById('photoInput');
        if (photoInput) {
            photoInput.value = '';
            photoInput.click();
        }
    }
}

/**
 * Lock body scroll on mobile to prevent background scrolling when widget is open
 */
function lockBodyScroll() {
    if (!isMobile) return;

    // Avoid `position: fixed` on <body>: on iOS Safari it forces the address
    // bar to re-expand, flickering the page when the widget opens. The
    // non-passive touchmove handler below is what blocks background scroll on iOS.
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';

    // Prevent touch scrolling on body (but allow it in widget)
    scrollLockTouchHandler = function (e) {
        // Allow scrolling within the widget container
        const widget = document.getElementById('virtualTryonWidget');
        const widgetContainer = document.getElementById('virtual-tryon-widget-container');
        const target = e.target;

        // Check if touch is inside widget or its container
        if (widget && (widget.contains(target) || widget === target)) {
            return; // Allow touch events in widget
        }
        if (widgetContainer && (widgetContainer.contains(target) || widgetContainer === target)) {
            return; // Allow touch events in container
        }

        // Prevent all other touch scrolling
        e.preventDefault();
    };

    document.addEventListener('touchmove', scrollLockTouchHandler, { passive: false });
}

/**
 * Unlock body scroll on mobile and restore scroll position
 */
function unlockBodyScroll() {
    if (!isMobile) return;

    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';

    // Remove touch handler
    if (scrollLockTouchHandler) {
        document.removeEventListener('touchmove', scrollLockTouchHandler);
        scrollLockTouchHandler = null;
    }
}

function openWidget() {
    // Reset analytics state for this widget view
    hadMeaningfulAction = false;

    // Default surface attribution — if no upstream caller set this (e.g., the
    // bubble click handler at initializeWidget time, or any future entry path),
    // fall back to 'floating_widget'. The inline button and preview popup both
    // set this BEFORE calling openWidget(), so this fallback only fires for the
    // floating bubble path.
    if (!window.ELLO_PENDING_ENTRY_SOURCE) {
        window.ELLO_PENDING_ENTRY_SOURCE = 'floating_widget';
    }

    // If opening full widget, close preview if it's open (use temporary dismiss so it user preference isn't permanent)
    if (isPreviewVisible) {
        dismissPreview(true);
        // Manual open is a meaningful interaction, so we mark it engaged (stops permanent dismissal logic if they close later)
        previewEngaged = true;
    }

    const widget = document.getElementById('virtualTryonWidget');

    // Inline mode — focused PDP experience. CSS hides featured/quick-picks/
    // wardrobe sections and centers the selected product. Class is added on
    // every open (in case the merchant alternates between surfaces) and
    // removed on closeWidget(). Stylesheet is injected lazily on first use.
    if (window.ELLO_INLINE_MODE) {
        widget.classList.add('inline-mode');
        ensureInlineModeStyles();
    } else {
        widget.classList.remove('inline-mode');
    }

    // Mobile animation handling
    if (isMobile) {
        // Remove any existing animation classes
        widget.classList.remove('is-animating-open', 'is-animating-close');

        // Clear inline minimized background to prevent 'flashing' during expansion
        widget.style.background = '';

        // Synchronize minimization removal with animation start
        widget.classList.remove('widget-minimized');
        widget.classList.add('is-animating-open');

        // Clean up animation class when done
        const handleAnimationEnd = () => {
            widget.classList.remove('is-animating-open');
            widget.removeEventListener('animationend', handleAnimationEnd);
        };
        widget.addEventListener('animationend', handleAnimationEnd, { once: true });
    } else {
        widget.classList.remove('widget-minimized');
    }
    widgetOpen = true;

    // ─── Tier 2: lazy full-catalog load on first widget engagement ───────
    // Page load only fetches the small handles list + featured/quick picks
    // preview (~50 KB). The full catalog (every enabled product, full image
    // + variant data — what search/browse depends on) is fetched HERE, the
    // first time the shopper actually opens the widget. Fire-and-forget —
    // populateFeaturedAndQuickPicks below uses sampleClothing's current
    // state; when the full catalog resolves it refreshes the view from the
    // richer pool. Idempotent: subsequent opens no-op.
    loadFullCatalogIfNeeded(window.ELLO_STORE_CONFIG || {});

    // Reset widget view context
    widgetViewId = Date.now();

    // Check for First-Run Overlay (Sets isFirstTimeIntro)
    checkOnboarding();

    // Track widget open event (Now includes accurate is_first_time)
    trackWidgetOpen();

    // Lock body scroll on mobile
    lockBodyScroll();

    loadChatHistory();

    // Try to load saved photo from storage if not already loaded
    if (!userPhoto) {
        loadSavedPhoto();
    }

    // Restore photo preview if userPhoto exists
    if (userPhoto) {
        updatePhotoPreview(userPhoto);
    } else {
        // Reset upload area if no photo exists
        resetPhotoUploadArea();
    }

    if (currentMode === 'tryon') {
        populateFeaturedAndQuickPicks();
        setTimeout(() => {
            const currentProduct = detectCurrentProduct();
            if (currentProduct) {
                selectedClothing = currentProduct.id;
                const featuredContainer = document.getElementById('featuredItem');
                if (featuredContainer) featuredContainer.classList.add('selected');

                if (window.ELLO_INLINE_MODE) {
                    // Inline mode: the featured-section is hidden by CSS, so we
                    // need the dedicated #selectedClothingPreview to be the
                    // visible "what you're trying on" indicator. Populate its
                    // image from elloSelectedGarment (set by populate above) or
                    // fall back to currentProduct.image_url so it never renders
                    // blank — the bug Andrew screenshotted.
                    setupInlineModeProductPreview(currentProduct);
                } else {
                    // Normal floating-widget UX: featured-section IS visible and
                    // already shows the product, so suppress the duplicate.
                    updateSelectedClothingPreview(null);
                }

                updateTryOnButton();

                // ─── Auto-fire path A: returning user (saved photo exists) ───
                // If the inline-button click set ELLO_AUTO_FIRE and we already
                // have a userPhoto loaded from localStorage by loadSavedPhoto()
                // above, skip the redundant "Try On" button click and go
                // straight to the try-on call. Loading bar appears immediately,
                // result follows — the one-tap magic moment for repeat shoppers.
                // If no saved photo: don't auto-fire here. The startTryOn()
                // call below would re-open the file picker, but we want the
                // picker to fire only via the Try On button or via the
                // first-time auto-fire hook in the upload handler. So we let
                // ELLO_AUTO_FIRE stay set and the upload-success handler picks
                // it up after the user picks their photo.
                if (window.ELLO_AUTO_FIRE && userPhoto && window.elloUserImageUrl) {
                    window.ELLO_AUTO_FIRE = false;
                    setTimeout(() => { window.startTryOn && window.startTryOn(); }, 50);
                }
            }

            // Update wardrobe button count
            updateWardrobeButton();

            // 🎯 Focus management - focus on first interactive element
            const firstFocusableElement = widget.querySelector('button, input, select, [tabindex]:not([tabindex="-1"])');
            if (firstFocusableElement) {
                firstFocusableElement.focus();
            }
        }, 100);
    }
}

/**
 * Closes the widget and resets all states
 * Handles cleanup of UI elements and user data
 */
function closeWidget() {
    const widget = document.getElementById('virtualTryonWidget');
    if (!widget) {
        console.error('Widget element not found');
        return;
    }

    // Dedupe close event per widget view
    if (dedupeOnce(`widget_close_${widgetViewId}`)) {
        trackEvent('widget_close', { had_meaningful_action: hadMeaningfulAction });
    }

    // Clear inline-mode state. If the shopper re-opens via the floating
    // bubble next, we want them to land in the full browse UX — not in the
    // focused PDP experience that was tied to the previous inline click.
    if (window.ELLO_INLINE_MODE) {
        window.ELLO_INLINE_MODE = false;
        window.ELLO_INLINE_CTX = null;
        window.ELLO_AUTO_FIRE = false; // cancel any pending auto-fire
        widget.classList.remove('inline-mode');
    }

    // Always tear down result-stage CTAs and success state on close, since
    // they're rendered in every mode now. Re-opening mid-load was producing
    // a duplicate (small) Add-to-Cart button because stale markup survived.
    widget.classList.remove('inline-mode-result-ready', 'inline-mode-cart-success');
    const staleCtas = document.getElementById('ello-inline-result-ctas');
    if (staleCtas) staleCtas.remove();
    const staleSuccess = document.getElementById('ello-inline-cart-success');
    if (staleSuccess) staleSuccess.remove();
    const staleBuy = document.querySelector('.buy-now-container');
    if (staleBuy) staleBuy.remove();
    const staleAttr = document.querySelector('.tryon-attribution');
    if (staleAttr) staleAttr.remove();

    // Apply the minimized visual state — adds the .widget-minimized class
    // and re-applies the saved/default minimized background color.
    const applyMinimizedVisual = () => {
        widget.classList.add('widget-minimized');
        const savedGradient = widget.getAttribute('data-minimized-gradient');
        if (savedGradient) {
            widget.style.background = savedGradient;
        } else {
            applyMinimizedWidgetColor();
        }
    };

    // Mobile animation handling — fade the full panel out first, then swap
    // to the minimized button. Doing both at once causes the widget to
    // visibly "melt" from full-screen down to 64×64 mid-fade.
    if (isMobile) {
        widget.classList.remove('is-animating-open', 'is-animating-close');
        widget.classList.add('is-animating-close');

        const handleAnimationEnd = () => {
            widget.classList.remove('is-animating-close');
            applyMinimizedVisual();
            widget.removeEventListener('animationend', handleAnimationEnd);
        };
        widget.addEventListener('animationend', handleAnimationEnd, { once: true });
    } else {
        applyMinimizedVisual();
    }

    widgetOpen = false;
    currentMode = 'tryon';

    // Unlock body scroll on mobile
    unlockBodyScroll();

    // Reset mode buttons
    document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
    const firstModeBtn = document.querySelector('.mode-btn');
    if (firstModeBtn) firstModeBtn.classList.add('active');

    // Show try-on content, hide chat
    const tryonContent = document.getElementById('tryonContent');
    const inputArea = document.querySelector('.input-area');
    const chatContainer = document.getElementById('chatContainer');

    if (tryonContent) tryonContent.style.display = 'block';
    if (inputArea) inputArea.classList.remove('chat-mode');
    if (chatContainer) chatContainer.style.display = 'none';

    // Reset clothing selection only — the user's photo must persist across close/open
    // so they don't have to re-upload every time the panel is minimized.
    // Photo is cleared on rejection or explicit reset, never on close.
    selectedClothing = null;

    // Clear clothing selections in UI
    document.querySelectorAll('.quick-pick-item').forEach(item => {
        item.classList.remove('selected');
    });

    updateTryOnButton();

    // 🎯 Focus management - return focus to page when widget closes
    const widgetToggle = document.querySelector('.widget-toggle');
    if (widgetToggle) {
        widgetToggle.focus();
    }
}

/**
 * Resets the photo upload area to its initial state
 */
function resetPhotoUploadArea() {
    // Reset internal state
    userPhoto = null;
    userPhotoFileId = null;
    window.elloUserImageUrl = null;
    resetActivePhotoValidation();
    clearSavedPhoto();
    if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('userPhoto');
        localStorage.removeItem('userPhotoFileId');
    }

    // Update UI elements
    const optionsContainer = document.getElementById('uploadOptionsContainer');
    const workspace = document.getElementById('tryOnWorkspace');
    const photoContainer = document.getElementById('activeUserPhotoContainer');
    const activePhoto = document.getElementById('activeUserPhoto');

    if (optionsContainer) optionsContainer.style.display = 'block';
    if (workspace) workspace.classList.remove('visible');
    if (photoContainer) photoContainer.style.display = 'none';
    if (activePhoto) activePhoto.src = '';
    clearPreviewUserPhoto();

    // Show photo instruction again
    const instruction = document.querySelector('.photo-instruction');
    if (instruction) instruction.style.display = 'block';

    // Hide loader if active
    const activeLoader = document.getElementById('activePhotoLoader');
    if (activeLoader) {
        activeLoader.style.display = 'none';
    }

    // Clear try-on result if any
    const resultSection = document.getElementById('resultSection');
    const resultImage = document.getElementById('ello-tryon-result-image');
    const tryonResult = document.getElementById('ello-tryon-result');

    if (resultSection) resultSection.style.display = 'none';
    if (tryonResult) tryonResult.style.display = 'none';
    if (resultImage) resultImage.src = '';

    updateTryOnButton();
}

/**
 * Model Browser Functionality
 */
function openModelBrowser() {
    // Track intro CTA click if this is the first action
    if (isFirstTimeIntro && introShownAt && !introActionFired) {
        introActionFired = true;
        markMeaningfulAction(); // User explicitly chose a path
        const timeToAct = Date.now() - introShownAt;
        trackEvent('intro_cta_click', { cta: 'use_model', time_to_action_ms: timeToAct });
    }

    // Dedupe once per session
    if (dedupeOnce(`model_browse_open_${window.ELLO_SESSION_ID}`)) {
        trackEvent('model_browse_open');
    }
    const modal = document.getElementById('modelBrowserModal');
    if (modal) {
        modal.classList.add('active');
        populateModelBrowser();
    }
}

function closeModelBrowser() {
    const modal = document.getElementById('modelBrowserModal');
    if (modal) {
        modal.classList.remove('active');
    }
}

const SAMPLE_MODELS = [
    {
        "id": "model_1",
        "name": "Model 1",
        "url": "assets/models/model_1.jpg",
        "base64": "data:image/jpeg;base64,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"
    },
    {
        "id": "model_2",
        "name": "Model 2",
        "url": "assets/models/model_2.jpg",
        "base64": "data:image/jpeg;base64,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"
    },
    {
        "id": "model_3",
        "name": "Model 3",
        "url": "assets/models/model_3.jpg",
        "base64": "data:image/jpeg;base64,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"
    },
    {
        "id": "model_4",
        "name": "Model 4",
        "url": "assets/models/model_4.jpg",
        "base64": "data:image/jpeg;base64,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"
    },
    {
        "id": "model_5",
        "name": "Model 5",
        "url": "assets/models/model_5.jpg",
        "base64": "data:image/jpeg;base64,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"
    },
    {
        "id": "model_6",
        "name": "Model 6",
        "url": "assets/models/model_6.jpg",
        "base64": "data:image/jpeg;base64,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"
    },
    {
        "id": "model_7",
        "name": "Model 7",
        "url": "assets/models/model_7.jpg",
        "base64": "data:image/jpeg;base64,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"
    }
];

function populateModelBrowser() {
    elloLog("👉 Populating Model Browser...");
    const grid = document.getElementById('modelBrowserGrid');
    if (!grid) {
        console.error("❌ modelBrowserGrid not found");
        return;
    }

    grid.innerHTML = '';
    SAMPLE_MODELS.forEach(model => {
        const card = document.createElement('div');
        card.className = 'browser-clothing-card';
        card.onclick = () => selectModel(model.id);
        card.innerHTML = `
            <div class="browser-image-wrap">
                <img src="${model.base64}" alt="${model.name}" onload="this.classList.add('loaded')">
            </div>
        `;
        grid.appendChild(card);
    });
}



async function selectModel(modelId) {
    if (dedupeWindow(`model_selected_${modelId}`, 2000)) {
        trackEvent('model_selected', { model_id: modelId, source: 'sample' });
    }
    markMeaningfulAction(); // Actually picking a model is meaningful
    const model = SAMPLE_MODELS.find(m => m.id === modelId);
    if (!model) return;

    elloLog("✅ Selected Model:", model.name);

    // Use the embedded base64 data directly
    const base64 = model.base64;

    if (base64) {
        // Show visual preview immediately
        updatePhotoPreview(base64);

        // Update global photo state with base64
        userPhoto = base64;
        window.elloUserImageUrl = base64;
        userPhotoFileId = 'model_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        activePhotoValidationId = userPhotoFileId;
        activePhotoValidationStatus = 'valid';
        lastRejectedPhotoValidationId = null;

        // Close the browser modal
        closeModelBrowser();

        // Update UI state
        const tryOnBtn = document.getElementById('tryOnBtn');
        if (tryOnBtn) {
            tryOnBtn.classList.remove('processing');
            // Ensure button text is reset if it was stuck
            if (tryOnBtn.innerText === 'Preparing Model...') {
                tryOnBtn.innerHTML = 'Try On';
            }
        }
        updateTryOnButton();

        elloLog("✅ Model prepared (embedded base64)");
    } else {
        console.error("❌ Model missing base64 data");
        alert("Unable to load model. Please try another.");
    }
}


function switchMode(mode) {
    currentMode = mode;

    document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
    event.target.classList.add('active');

    const tryonContent = document.getElementById('tryonContent');
    const inputArea = document.querySelector('.input-area');
    const chatContainer = document.getElementById('chatContainer');

    if (mode === 'tryon') {
        tryonContent.style.display = 'block';
        inputArea.classList.remove('chat-mode');
        chatContainer.style.display = 'none';
        populateFeaturedAndQuickPicks();
    } else {
        tryonContent.style.display = 'none';
        inputArea.classList.add('chat-mode');
        chatContainer.style.display = 'flex';
    }

    loadChatHistory();
}

// Fetch custom curation from Supabase via get_widget_config RPC
async function fetchCustomCuration(storeSlug) {
    try {
        const url = `${SUPABASE_URL}/rest/v1/rpc/get_widget_config`;
        const response = await fetch(url, {
            method: 'POST',
            credentials: 'omit',
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ p_store_slug: storeSlug })
        });

        if (response.ok) {
            const data = await response.json();
            if (data && data.length > 0 && (data[0].featured_item_id || (data[0].quick_picks_ids && data[0].quick_picks_ids.length > 0))) {
                return {
                    featuredItemId: data[0].featured_item_id || null,
                    quickPicksIds: data[0].quick_picks_ids || null
                };
            }
        }
    } catch (error) {
        console.warn('Failed to fetch custom curation:', error);
    }
    return null;
}

// Helper function: Robust ID matching (handles both numeric IDs and full GIDs)
function findClothingByRobustId(clothingArray, searchId) {
    if (!searchId) return null;

    return clothingArray.find(item => {
        const idStr = String(searchId);
        const itemShopifyId = item.shopify_product_id ? String(item.shopify_product_id) : null;
        const itemGid = item.shopify_product_gid ? String(item.shopify_product_gid) : (item.id && String(item.id).startsWith('gid://') ? String(item.id) : null);
        const itemId = String(item.id);

        // 1. Direct match (loose)
        if (item.id == searchId) return true;

        // 2. GID match logic (Handle both full GIDs and numeric suffixes)
        // If searching with a GID
        if (idStr.startsWith('gid://')) {
            if (itemGid && itemGid === idStr) return true;
            if (itemId === idStr) return true;
            if (itemShopifyId && idStr.endsWith(`/${itemShopifyId}`)) return true;
        }
        // If searching with a numeric ID
        else {
            if (itemShopifyId && itemShopifyId === idStr) return true;
            if (itemGid && itemGid.endsWith(`/${idStr}`)) return true;
            // Fallback for when item.id is a GID but looking for numeric
            if (itemId.endsWith(`/${idStr}`)) return true;
        }

        // 3. Reversed Check (Just in case)
        if (String(item.id).endsWith(`/${idStr}`)) return true;
        if (idStr.endsWith(`/${item.id}`)) return true;

        // 4. Handle match (fallback)
        if (item.handle && (item.handle === idStr || item.handle === idStr.toLowerCase())) return true;

        return false;
    });
}

// Helper function: Check if a product is hidden (blacklisted)
function isProductHidden(product) {
    if (!product) return false;

    // 1. Check ID (and GID variations)
    if (product.id) {
        const idStr = String(product.id);
        const cleanId = idStr.split('/').pop();
        if (window.elloHiddenProductIds && (window.elloHiddenProductIds.has(idStr) || window.elloHiddenProductIds.has(cleanId))) {
            elloLog(`[Ello Debug] Hidden by ID: ${idStr}`);
            return true;
        }
    }

    // 2. Check Title
    if (product.name || product.title) {
        const name = (product.name || product.title).toLowerCase().trim();
        if (window.elloHiddenTitles && window.elloHiddenTitles.has(name)) {
            elloLog(`[Ello Debug] Hidden by Title: ${name}`);
            return true;
        }
    }

    // 3. Check Handle (from URL or handle property)
    let handle = product.handle;
    if (!handle && (product.url || product.product_url)) {
        const url = product.url || product.product_url;
        handle = url.split('/').pop().split('?')[0];
    }
    if (handle) {
        const cleanHandle = handle.toLowerCase();
        if (window.elloHiddenHandles && window.elloHiddenHandles.has(cleanHandle)) {
            elloLog(`[Ello Debug] Hidden by Handle: ${cleanHandle}`);
            return true;
        }
    }

    return false;
}

// 🔄 REPLACE YOUR EXISTING populateFeaturedAndQuickPicks() FUNCTION WITH THIS:
async function populateFeaturedAndQuickPicks() {
    if (sampleClothing.length === 0) {
        await loadClothingData();
    }

    if (sampleClothing.length === 0) {
        return; // No items available
    }

    // Get store config and custom curation
    const storeConfig = window.ELLO_STORE_CONFIG || {};
    const storeSlug = storeConfig.storeSlug || storeConfig.storeId || window.ELLO_STORE_SLUG || window.ELLO_STORE_ID || 'default_store';

    // Try to get custom curation from store config first, otherwise fetch it
    let customCuration = null;
    if (storeConfig.featuredItemId || (storeConfig.quickPicksIds && storeConfig.quickPicksIds.length > 0)) {
        customCuration = {
            featuredItemId: storeConfig.featuredItemId || null,
            quickPicksIds: storeConfig.quickPicksIds || null
        };
    } else {
        customCuration = await fetchCustomCuration(storeSlug);
    }

    // Priority 1: Current product page detection (highest priority)
    const currentProduct = detectCurrentProduct();
    let featuredItem = null;
    let quickPicks = [];
    let badgeText = 'Trending';

    // 🛡️ CRITICAL UPDATE: Check blacklist before promoting current product
    if (currentProduct && !isProductHidden(currentProduct)) {
        // Fallback: Scrape price from common Shopify selectors if meta price was missing/zero
        if (!currentProduct.price) {
            const priceSelectors = ['.price', '.product-price', '.product__price', '[data-price]'];
            for (const sel of priceSelectors) {
                const el = document.querySelector(sel);
                if (el) {
                    const txt = el.textContent.trim().replace(/[^0-9.]/g, ''); // Extract numbers
                    if (txt) {
                        currentProduct.price = parseFloat(txt);
                        break;
                    }
                }
            }
            // If still no price, default to something or leave as 0
            if (!currentProduct.price) currentProduct.price = 0;
        }

        // Use current product as featured item (highest priority)
        featuredItem = currentProduct;
        // Ensure name and price are from the current product (page source of truth)
        featuredItem.name = currentProduct.name;
        featuredItem.price = currentProduct.price;
        badgeText = 'This Item';

        // 🎯 CRITICAL FIX: Auto-select this item immediately so "Try On" works
        selectedClothing = currentProduct.id;
        window.elloSelectedGarment = {
            image_url: currentProduct.image_url,
            ...currentProduct,
            selectedVariantId: currentProduct.variants?.[0]?.shopify_variant_gid || null
        };
        // Mark visually as selected (will be rendered momentarily)
        setTimeout(() => {
            const featuredContainer = document.getElementById('featuredItem');
            if (featuredContainer) featuredContainer.classList.add('selected');
            updateTryOnButton();
        }, 50);

        // For quick picks: use custom quick_picks_ids if set, otherwise use variety-based
        if (customCuration && customCuration.quickPicksIds && customCuration.quickPicksIds.length > 0) {
            // Use robust ID matching for quick picks, filter out current product
            quickPicks = customCuration.quickPicksIds
                .map(id => findClothingByRobustId(sampleClothing, id))
                .filter(item => item != null && item.id !== currentProduct.id)
                .slice(0, 6);

            // If we have less than 6, fill with variety-based items
            if (quickPicks.length < 6) {
                const varietyPicks = getVarietyBasedQuickPicks(sampleClothing, currentProduct.id, quickPicks.map(q => q.id));
                quickPicks = [...quickPicks, ...varietyPicks].slice(0, 6);
            }
        } else {
            // Use variety-based quick picks
            quickPicks = getVarietyBasedQuickPicks(sampleClothing, currentProduct.id, []);
        }
    } else {
        if (currentProduct && isProductHidden(currentProduct)) {
            elloLog("🚫 Current Page Product is HIDDEN. Falling back to Featured/Trending.");
        }
        // Priority 2: Custom featured item (if no current product)
        if (customCuration && customCuration.featuredItemId) {
            // Use robust ID matching to handle both numeric IDs and full GIDs
            const customFeatured = findClothingByRobustId(sampleClothing, customCuration.featuredItemId);
            if (customFeatured) {
                featuredItem = customFeatured;
                badgeText = 'Featured';
            } else {
                console.warn('⚠️ Custom featured item ID not found in sampleClothing:', customCuration.featuredItemId);
                // Fallback to Variety Based (Trending)
                featuredItem = getVarietyBasedFeatured(sampleClothing);
                badgeText = 'Trending';
            }
        }

        // Priority 3: Variety-based selection (fallback if no current product and no custom featured)
        if (!featuredItem) {
            featuredItem = getVarietyBasedFeatured(sampleClothing);
            badgeText = 'Trending';
        }

        // For quick picks: use custom quick_picks_ids if set, otherwise use variety-based
        if (customCuration && customCuration.quickPicksIds && customCuration.quickPicksIds.length > 0) {
            // Use robust ID matching for quick picks, filter out the featured item
            quickPicks = customCuration.quickPicksIds
                .map(id => findClothingByRobustId(sampleClothing, id))
                .filter(item => item != null && item.id !== featuredItem.id)
                .slice(0, 6);

            // If we have less than 6, fill with variety-based items
            if (quickPicks.length < 6) {
                const varietyPicks = getVarietyBasedQuickPicks(sampleClothing, featuredItem.id, quickPicks.map(q => q.id));
                quickPicks = [...quickPicks, ...varietyPicks].slice(0, 6);
            }
        } else {
            // Use variety-based quick picks
            quickPicks = getVarietyBasedQuickPicks(sampleClothing, featuredItem.id, []);
        }
    }

    // Populate featured item section
    const featuredContainer = document.getElementById('featuredItem');
    featuredContainer.innerHTML = `
        <div class="featured-content">
            <img src="${featuredItem.image_url}" alt="${featuredItem.name}" class="featured-image" loading="lazy" decoding="async">
            <div class="featured-info">
                <div class="featured-name">${featuredItem.name}</div>
                <div class="featured-price">$${(Number(featuredItem.price) || 0).toFixed(2)}</div>
                <div class="featured-badge">${badgeText}</div>
            </div>
        </div>
    `;

    // Ensure featured image loads and content stays visible
    const featuredImg = featuredContainer.querySelector('.featured-image');
    if (featuredImg) {
        featuredImg.onload = function () {
            this.classList.add('loaded');
            // Ensure container stays visible
            featuredContainer.style.visibility = 'visible';
            featuredContainer.style.opacity = '1';
        };
        featuredImg.onerror = function () {
            // Fallback if image fails to load
            this.style.display = 'none';
            featuredContainer.style.visibility = 'visible';
            featuredContainer.style.opacity = '1';
        };
        // If already loaded (cached)
        if (featuredImg.complete) {
            featuredImg.classList.add('loaded');
        }
    }

    // Populate quick picks (up to 6 items)
    const quickPicksGrid = document.getElementById('quickPicksGrid');
    if (!quickPicksGrid) {
        console.error('❌ quickPicksGrid element not found!');
        return;
    }

    let quickPicksHTML = '';
    quickPicks.forEach(item => {
        if (!item || !item.id || !item.name) {
            console.warn('⚠️ Invalid quick pick item:', item);
            return;
        }
        quickPicksHTML += `
            <div class="quick-pick-item" onclick="selectClothing('${item.id}')">
                <img src="${item.image_url || ''}" alt="${item.name}" class="quick-pick-image" loading="lazy" decoding="async">
                <div class="quick-pick-name">${item.name}</div>
                <div class="quick-pick-price">$${item.price ? item.price.toFixed(2) : '0.00'}</div>
            </div>
        `;
    });

    quickPicksGrid.innerHTML = quickPicksHTML;

    // Ensure quick pick images load and content stays visible
    const quickPickImages = quickPicksGrid.querySelectorAll('.quick-pick-image');
    quickPickImages.forEach(img => {
        img.onload = function () {
            this.classList.add('loaded');
            // Ensure parent stays visible
            const parent = this.closest('.quick-pick-item');
            if (parent) {
                parent.style.visibility = 'visible';
                parent.style.opacity = '1';
            }
        };
        img.onerror = function () {
            // Fallback if image fails
            this.style.display = 'none';
            const parent = this.closest('.quick-pick-item');
            if (parent) {
                parent.style.visibility = 'visible';
                parent.style.opacity = '1';
            }
        };
        // If already loaded (cached)
        if (img.complete) {
            img.classList.add('loaded');
        }
    });

    // Ensure quick picks grid is visible
    quickPicksGrid.style.visibility = 'visible';
    quickPicksGrid.style.opacity = '1';

    currentFeaturedItem = featuredItem;

    // Auto-select the featured item to prevent "Select garment first" error
    if (currentFeaturedItem) {
        selectFeaturedClothing();
    }
}

// Helper function to get variety-based featured item
function getVarietyBasedFeatured(clothingArray) {
    const categories = ['dress', 'shirt', 'pants', 'jacket', 'shorts'];
    const varietyItems = [];

    categories.forEach(category => {
        const categoryItem = clothingArray.find(item => item.category === category);
        if (categoryItem) {
            varietyItems.push(categoryItem);
        }
    });

    while (varietyItems.length < 7 && varietyItems.length < clothingArray.length) {
        const remainingItems = clothingArray.filter(item => !varietyItems.includes(item));
        if (remainingItems.length > 0) {
            varietyItems.push(remainingItems[0]);
        } else {
            break;
        }
    }

    return varietyItems[0] || clothingArray[0];
}

// Helper function to get variety-based quick picks
function getVarietyBasedQuickPicks(clothingArray, excludeId, excludeIds = []) {
    const allExcludeIds = [excludeId, ...excludeIds].filter(id => id != null);
    let quickPicksPool = clothingArray.filter(item => !allExcludeIds.includes(item.id));

    const categories = ['dress', 'shirt', 'pants', 'jacket', 'shorts'];
    const varietyItems = [];

    categories.forEach(category => {
        const categoryItem = quickPicksPool.find(item => item.category === category && !varietyItems.includes(item));
        if (categoryItem) {
            varietyItems.push(categoryItem);
        }
    });

    while (varietyItems.length < 6 && varietyItems.length < quickPicksPool.length) {
        const remainingItems = quickPicksPool.filter(item => !varietyItems.includes(item));
        if (remainingItems.length > 0) {
            varietyItems.push(remainingItems[0]);
        } else {
            break;
        }
    }

    return varietyItems.slice(0, 6);
}

function selectFeaturedClothing() {
    if (!currentFeaturedItem) return;
    selectedClothing = currentFeaturedItem.id;

    // Set window state variable
    const clothing = sampleClothing.find(item => String(item.id) === String(currentFeaturedItem.id) || String(item.email_id) === String(currentFeaturedItem.id) || String(item.shopify_product_id) === String(currentFeaturedItem.id));
    if (clothing) {
        // Update price from active view if available (e.g. if we are on PDP and price changed)
        clothing.price = currentFeaturedItem.price || clothing.price;

        // Track selected variant ID (use first variant if available, otherwise null)
        const selectedVariantId = clothing.variants?.[0]?.shopify_variant_gid || null;
        window.elloSelectedGarment = {
            image_url: clothing.image_url,
            ...clothing,
            selectedVariantId: selectedVariantId
        };
    }

    // Clear other selections
    document.querySelectorAll('.quick-pick-item').forEach(item => {
        item.classList.remove('selected');
    });
    // Highlight featured item
    const featuredContainer = document.getElementById('featuredItem');
    featuredContainer.classList.add('selected');

    // Don't show preview - item is already visible in featured section
    updateSelectedClothingPreview(null);

    updateTryOnButton();
}

function updateSelectedClothingPreview(clothingId) {
    const preview = document.getElementById('selectedClothingPreview');
    const previewImage = document.getElementById('selectedClothingImage');

    if (!clothingId) {
        // Hide preview if no clothing selected
        if (preview) {
            preview.style.display = 'none';
        }
        return;
    }

    // Find clothing in sampleClothing array
    const clothing = sampleClothing.find(item => item.id === clothingId);

    if (!clothing) {
        console.warn('Clothing not found for preview:', clothingId);
        if (preview) {
            preview.style.display = 'none';
        }
        return;
    }

    // Update preview with clothing data
    if (previewImage && clothing.image_url) {
        previewImage.src = clothing.image_url;
        previewImage.alt = clothing.name || 'Selected clothing';
    }

    // Show preview
    if (preview) {
        preview.style.display = 'flex';
    }
}

function clearSelectedClothing() {
    selectedClothing = null;

    // Clear preview
    updateSelectedClothingPreview(null);

    // Clear all visual selections
    document.querySelectorAll('.featured-item, .quick-pick-item, .browser-clothing-card').forEach(item => {
        item.classList.remove('selected');
    });

    updateTryOnButton();
}

function selectClothing(clothingId) {
    selectedClothing = clothingId;

    // Set window state variable
    const clothing = sampleClothing.find(item => item.id === clothingId);
    if (clothing) {
        // Update price from active view if available (e.g. if we are on PDP and price changed)
        if (currentFeaturedItem && (String(clothing.id) === String(currentFeaturedItem.id) || String(clothing.shopify_product_id) === String(currentFeaturedItem.id))) {
            clothing.price = currentFeaturedItem.price || clothing.price;
        }
        // Track selected variant ID (use first variant if available, otherwise null)
        const selectedVariantId = clothing.variants?.[0]?.shopify_variant_gid || null;
        window.elloSelectedGarment = {
            image_url: clothing.image_url,
            ...clothing,
            selectedVariantId: selectedVariantId
        };
    }

    // Clear featured selection
    const featuredContainer = document.getElementById('featuredItem');
    featuredContainer.classList.remove('selected');

    // Clear other quick pick selections
    document.querySelectorAll('.quick-pick-item').forEach(item => {
        item.classList.remove('selected');
    });

    // Highlight selected item
    event.target.closest('.quick-pick-item').classList.add('selected');

    // Don't show preview - item is already visible in quick picks
    updateSelectedClothingPreview(null);

    updateTryOnButton();
}

function resetSelection() {
    selectedClothing = null;
    userPhoto = null;
    userPhotoFileId = null;
    window.elloUserImageUrl = null;
    resetActivePhotoValidation();

    // Clear saved photo from storage when resetting
    clearSavedPhoto();


    // Clear all selections
    document.querySelectorAll('.featured-item, .quick-pick-item').forEach(item => {
        item.classList.remove('selected');
    });

    // Clear preview
    updateSelectedClothingPreview(null);

    // Reset photo preview
    const preview = document.getElementById('photoPreview');
    const uploadArea = document.querySelector('.photo-upload');
    const changeText = document.getElementById('changePhotoText');
    const uploadIcon = uploadArea?.querySelector('.upload-icon');
    const uploadText = uploadArea?.querySelector('.upload-text:not(#changePhotoText)');

    if (preview) preview.style.display = 'none';
    if (uploadArea) uploadArea.classList.remove('has-photo');
    if (changeText) changeText.style.display = 'none';

    // Show the upload elements again
    if (uploadIcon) uploadIcon.style.display = 'block';
    if (uploadText) {
        uploadText.style.display = 'block';
        uploadText.textContent = isMobile ? 'Tap to upload full body image' : 'Click to upload full body image';
    }

    // Hide result section
    const resultSection = document.getElementById('resultSection');
    resultSection.style.display = 'none';

    updateTryOnButton();
}

function updateTryOnButton() {
    updateWorkspaceSeparator();
    const btn = document.getElementById('tryOnBtn');
    if (!btn) return;

    // Determine state
    // Determine state
    const isReady = userPhoto && selectedClothing;
    // Enable button if we need to upload a photo (act as trigger), otherwise disable if not ready (e.g. need garment)
    const isDisabled = isTryOnProcessing || isRateLimited || (userPhoto && !selectedClothing);

    btn.disabled = isDisabled;

    // Update button text and styling based on state
    if (isTryOnProcessing) {
        btn.innerHTML = '<span class="spinner-small"></span>Processing...';
        btn.classList.add('processing');
        btn.classList.remove('rate-limited');
        btn.title = "Processing your try-on...";
    } else if (isRateLimited) {
        btn.innerHTML = '<span>🚫</span>Daily Limit Reached';
        btn.classList.add('rate-limited');
        btn.classList.remove('processing');
        btn.title = "You've reached the daily limit of 15 try-ons.";
    } else {
        // Normal state handling
        btn.classList.remove('processing', 'rate-limited');
        btn.title = "";

        if (!userPhoto) {
            btn.innerHTML = '<span>📷</span>Upload Photo';
        } else if (!selectedClothing) {
            btn.innerHTML = '<span>👕</span>Select Garment';
        } else {
            btn.innerHTML = '<span>✨</span>Try On';
        }
    }

    // 🎯 VISUAL FIX: Force explicit colors for disabled state to prevent "white on white"
    if (isDisabled) {
        btn.style.opacity = '1'; // Keep opacity high for readability
        btn.style.backgroundColor = '#222222'; // Dark background
        btn.style.color = '#ffffff'; // White text
        btn.style.borderColor = '#444444';
    } else {
        // Reset to theme colors (remove inline overrides to let CSS take over)
        btn.style.opacity = '';
        btn.style.backgroundColor = '';
        btn.style.color = '';
        btn.style.borderColor = '';
    }
}

function updateWorkspaceSeparator() {
    const separator = document.getElementById('tryOnPlusSeparator');
    const preview = document.getElementById('selectedClothingPreview');
    if (!separator) return;

    // Only show separator if BOTH the User Photo and the Selected Clothing PREVIEW are visible.
    // This ensures it doesn't show for Quick Picks (where preview is hidden).
    const isPreviewVisible = preview && preview.style.display !== 'none';

    if (userPhoto && isPreviewVisible) {
        separator.style.display = 'flex';
    } else {
        separator.style.display = 'none';
    }
}

function loadChatHistory() {
    const container = document.getElementById('chatContainer');
    const history = currentMode === 'tryon' ? tryonChatHistory : generalChatHistory;

    if (currentMode !== 'chat') {
        return;
    }

    container.innerHTML = '';
    history.forEach(msg => {
        const messageEl = document.createElement('div');
        messageEl.className = `message ${msg.type}-message`;
        messageEl.textContent = msg.content;
        container.appendChild(messageEl);
    });

    container.scrollTop = container.scrollHeight;

    if (history.length === 0 && currentMode === 'chat') {
        addBotMessage("Hi! I'm your personal fashion assistant. Ask me anything about style, trends, or fashion advice! ✨");
    }
}

function addMessage(content, type) {
    const container = document.getElementById('chatContainer');
    const messageEl = document.createElement('div');
    messageEl.className = `message ${type}-message`;
    messageEl.textContent = content;
    container.appendChild(messageEl);
    container.scrollTop = container.scrollHeight;

    const history = currentMode === 'tryon' ? tryonChatHistory : generalChatHistory;
    history.push({ content, type });
}

function addUserMessage(content) {
    addMessage(content, 'user');
}

function addBotMessage(content) {
    addMessage(content, 'bot');
}

function handleKeyPress(event) {
    if (event.key === 'Enter') {
        sendMessage();
    }
}

async function sendMessage() {
    const input = document.getElementById('messageInput');
    if (!input) {
        console.error('Message input element not found');
        return;
    }

    const message = input.value.trim();

    // Input validation
    if (!message) {
        return;
    }

    if (message.length > 1000) {
        showSuccessNotification('Message Too Long', 'Please keep messages under 1000 characters.', 3000);
        return;
    }

    // Add user message and clear input
    addUserMessage(message);
    input.value = '';

    // Disable input during processing
    input.disabled = true;
    const sendButton = document.querySelector('.send-button');
    if (sendButton) sendButton.disabled = true;

    try {
        if (currentMode === 'chat') {
            await handleChatMessage(message);
        } else {
            // Simulate processing delay for try-on mode
            setTimeout(() => {
                handleTryOnMessage(message);
                enableMessageInput();
            }, 1000);
        }
    } catch (error) {
        console.error('Error sending message:', error);
        addBotMessage("Sorry, I'm having trouble processing your message. Please try again.");
        enableMessageInput();
    }
}

async function handleChatMessage(message) {
    try {
        const webhookData = {
            mode: 'chat',
            sessionId: sessionId,
            userEmail: userEmail,
            message: message,
            deviceInfo: {
                isMobile: isMobile,
                isTablet: isTablet,
                isIOS: isIOS,
                isAndroid: isAndroid,
                viewport: {
                    width: window.innerWidth,
                    height: window.innerHeight
                }
            },
            timestamp: new Date().toISOString()
        };

        // Use retry logic for API calls
        const response = await fetchWithRetry(WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(webhookData)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const result = await response.json();

        // Extract bot response with multiple fallback patterns
        const botResponse = extractBotResponse(result);

        if (botResponse) {
            addBotMessage(botResponse);
        } else {
            console.warn('No valid response format found:', result);
            handleGeneralMessage(message);
        }

    } catch (error) {
        console.error('Chat webhook error:', error);
        addBotMessage("I'm having trouble connecting right now. Please try again in a moment.");
        handleGeneralMessage(message);
    } finally {
        enableMessageInput();
    }
}

function extractBotResponse(result) {
    // Try multiple response patterns
    const patterns = [
        result?.[0]?.output?.response,
        result?.output?.response,
        result?.response,
        result?.reply,
        result?.message,
        result?.text
    ];

    for (const response of patterns) {
        if (response && typeof response === 'string' && response.trim()) {
            return response.trim();
        }
    }

    return null;
}

function enableMessageInput() {
    const input = document.getElementById('messageInput');
    const sendButton = document.querySelector('.send-button');

    if (input) input.disabled = false;
    if (sendButton) sendButton.disabled = false;
}

function handleTryOnMessage(message) {
    if (message.toLowerCase().includes('photo') || message.toLowerCase().includes('picture')) {
        if (isMobile) {
            addBotMessage("Please use the camera buttons to take a picture or select from your gallery! 📸");
        } else {
            addBotMessage("Please use the photo upload area to add your picture! 📸");
        }
    } else if (message.toLowerCase().includes('clothes') || message.toLowerCase().includes('outfit')) {
        addBotMessage("Great! Check out our featured item or quick picks, or browse our full collection! 👗");
    } else {
        addBotMessage("I'm here to help you try on clothes virtually! Upload a photo and pick an item to get started. ✨");
    }
}

function handleGeneralMessage(message) {
    const responses = [
        "That's a great question about fashion! Trends are always evolving. 💫",
        "I love helping with style choices! What's your favorite color to wear? 🎨",
        "Fashion is all about expressing yourself! What look are you going for? ✨",
        "Style tip: Confidence is your best accessory! 💪"
    ];

    const randomResponse = responses[Math.floor(Math.random() * responses.length)];
    addBotMessage(randomResponse);
}

async function handlePhotoUpload(event) {
    const file = event.target.files[0];
    if (!file) {
        return;
    }

    // Basic file validation first
    const validationResult = validateImageFile(file);
    if (!validationResult.isValid) {
        if (dedupeWindow('photo_upload_fail_validation', 2000)) {
            trackEvent('photo_upload_fail', { reason: 'invalid_type', error: validationResult.error });
        }
        showSuccessNotification('Invalid File', validationResult.error, 4000, true);
        return;
    }

    // Show loading state
    const uploadArea = document.querySelector('.photo-upload');
    if (uploadArea) {
        uploadArea.classList.add('uploading');
    }

    const reader = new FileReader();

    reader.onload = async function (e) {
        try {
            const imageDataUrl = e.target.result;
            const photoId = 'photo_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            userPhoto = imageDataUrl;
            window.elloUserImageUrl = imageDataUrl;
            userPhotoFileId = photoId;
            activePhotoValidationId = photoId;
            activePhotoValidationStatus = 'pending';
            lastRejectedPhotoValidationId = null;

            clearError?.();
            updatePhotoPreview(imageDataUrl);
            updatePreviewUserPhoto(imageDataUrl);
            updateTryOnButton();

            const activeLoader = document.getElementById('activePhotoLoader');
            if (activeLoader) {
                activeLoader.style.display = 'none';
            }
            const previewAnalysisOverlay = document.getElementById('previewAnalysisOverlay');
            if (previewAnalysisOverlay) {
                previewAnalysisOverlay.style.display = 'none';
            }
            if (uploadArea) uploadArea.classList.remove('uploading'); // Clear uploading state without resetting preview

            // Haptic feedback on mobile
            if (isMobile && navigator.vibrate) {
                navigator.vibrate(50);
            }

            if (dedupeWindow('photo_upload_success', 2000)) {
                trackEvent('photo_upload_success', { method: 'file_picker' });
            }
            markMeaningfulAction(); // Successfully uploading a photo is meaningful

            showSuccessNotification('Photo Uploaded', 'Your photo has been uploaded successfully!', 2000);

            // Persist immediately so the photo survives reloads and pending background validation.
            // Rejection (no body detected) clears it via rejectActivePhotoAfterBodyCheck → clearSavedPhoto.
            savePhotoToStorage(imageDataUrl, photoId).catch(error => {
                console.error('Error saving uploaded photo:', error);
            });

            // ─── Auto-fire path B: first-time user just picked their photo ───
            // The inline button set ELLO_AUTO_FIRE before opening the popup.
            // Now that upload is complete and userPhoto/elloUserImageUrl are
            // populated, fire startTryOn() so the shopper goes straight to the
            // loading bar without having to click a second "Try On" button.
            // Quality validation (called below in .then) runs in parallel and
            // does NOT gate the try-on — Andrew's call: if validation rejects
            // the photo, the error surfaces in the result panel rather than
            // making the shopper wait on a spinner that might feel hung.
            if (window.ELLO_AUTO_FIRE) {
                window.ELLO_AUTO_FIRE = false;
                setTimeout(() => { window.startTryOn && window.startTryOn(); }, 100);
            }

            validateImageQuality(imageDataUrl, {
                includeFaceDetection: false,
                includeBodyDetection: false,
            }).then((qualityResult) => {
                if (!isActivePhotoValidation(photoId)) {
                    return;
                }

                if (!qualityResult.isValid) {
                    resetPhotoUploadArea();

                    if (dedupeWindow('photo_upload_fail_quality', 2000)) {
                        trackEvent('photo_upload_fail', {
                            reason: 'quality_fail',
                            error: qualityResult.error,
                            after_upload: true,
                        });
                    }

                    showSuccessNotification('Image Quality Issue', qualityResult.error, 5000, true);
                    return;
                }

                if (qualityResult.warnings && qualityResult.warnings.length > 0) {
                    const warningMessage = qualityResult.warnings.join(' ');
                    showSuccessNotification('Quality Tips', warningMessage, 4000, false);
                }
            }).catch(error => {
                elloLog('Image quality validation error:', error);
            });

            runBackgroundBodyValidation(imageDataUrl, photoId);

        } catch (error) {
            console.error('Error processing uploaded image:', error);
            if (dedupeWindow('photo_upload_fail_unknown', 2000)) {
                trackEvent('photo_upload_fail', { reason: 'unknown', error: error.message });
            }
            showSuccessNotification('Upload Error', 'Failed to process the image. Please try again.', 4000);
        } finally {
            // Hide loader
            const activeLoader = document.getElementById('activePhotoLoader');
            if (activeLoader) {
                activeLoader.style.display = 'none';
            }
            const previewAnalysisOverlay = document.getElementById('previewAnalysisOverlay');
            if (previewAnalysisOverlay) {
                previewAnalysisOverlay.style.display = 'none';
            }
            if (uploadArea) {
                uploadArea.classList.remove('uploading');
            }
        }
    };

    reader.onerror = function (error) {
        console.error('Error reading file:', error);
        if (dedupeWindow('photo_upload_fail_reader', 2000)) {
            trackEvent('photo_upload_fail', { reason: 'read_error' });
        }
        showSuccessNotification('File Error', 'Error reading the image file. Please try again.', 4000);
        if (uploadArea) {
            uploadArea.classList.remove('uploading');
        }
    };

    reader.readAsDataURL(file);
}

// Image Quality Analysis Functions
async function analyzeImageQuality(imageSrc) {
    return new Promise((resolve) => {
        const img = new Image();
        // Only set crossOrigin for external URLs, not data URLs
        if (!imageSrc.startsWith('data:')) {
            img.crossOrigin = 'anonymous';
        }

        img.onload = function () {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = img.width;
            canvas.height = img.height;

            ctx.drawImage(img, 0, 0);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const pixels = imageData.data;

            // Calculate aspect ratio
            const aspectRatio = canvas.width / canvas.height;
            const isPortrait = canvas.height > canvas.width;
            const widthHeightRatio = canvas.width / canvas.height;

            // Calculate brightness and contrast
            let sumLuminance = 0;
            let sumSquaredDiff = 0;
            const pixelCount = pixels.length / 4;

            for (let i = 0; i < pixels.length; i += 4) {
                const r = pixels[i];
                const g = pixels[i + 1];
                const b = pixels[i + 2];
                // Calculate luminance using relative luminance formula
                const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
                sumLuminance += luminance;
            }

            const averageBrightness = sumLuminance / pixelCount;

            // Calculate contrast (standard deviation of luminance)
            for (let i = 0; i < pixels.length; i += 4) {
                const r = pixels[i];
                const g = pixels[i + 1];
                const b = pixels[i + 2];
                const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
                const diff = luminance - averageBrightness;
                sumSquaredDiff += diff * diff;
            }

            const contrast = Math.sqrt(sumSquaredDiff / pixelCount);

            resolve({
                width: canvas.width,
                height: canvas.height,
                aspectRatio: aspectRatio,
                isPortrait: isPortrait,
                widthHeightRatio: widthHeightRatio,
                brightness: averageBrightness,
                contrast: contrast
            });
        };

        img.onerror = function () {
            resolve(null);
        };

        img.src = imageSrc;
    });
}

// Optional face detection using Face-API.js
let faceApiLoaded = false;
let faceApiLoading = false;

async function loadFaceApi() {
    if (faceApiLoaded || faceApiLoading) return faceApiLoaded;

    faceApiLoading = true;
    try {
        // Check if Face-API.js is available
        if (typeof faceapi === 'undefined') {
            // Try to load from CDN
            await new Promise((resolve) => {
                try {
                    const script = document.createElement('script');
                    script.src = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@latest/dist/face-api.min.js';
                    script.onload = () => {
                        // Wait for faceapi to be available and TensorFlow to be ready
                        setTimeout(async () => {
                            try {
                                // Check if faceapi is now available
                                if (typeof faceapi === 'undefined') {
                                    faceApiLoading = false;
                                    faceApiLoaded = false;
                                    resolve();
                                    return;
                                }

                                // Wait for TensorFlow to be ready (face-api uses TensorFlow internally)
                                if (typeof tf !== 'undefined' && tf.ready) {
                                    try {
                                        await tf.ready();
                                    } catch (tfError) {
                                    }
                                }

                                // Try to load the model
                                if (faceapi && faceapi.nets && faceapi.nets.tinyFaceDetector) {
                                    await faceapi.nets.tinyFaceDetector.loadFromUri('https://cdn.jsdelivr.net/npm/@vladmandic/face-api@latest/model');
                                    faceApiLoaded = true;
                                } else {
                                    faceApiLoaded = false;
                                }
                            } catch (e) {
                                faceApiLoaded = false;
                            }
                            faceApiLoading = false;
                            resolve();
                        }, 1500);
                    };
                    script.onerror = () => {
                        faceApiLoading = false;
                        faceApiLoaded = false;
                        resolve(); // Don't reject, graceful fallback
                    };
                    document.head.appendChild(script);
                } catch (err) {
                    faceApiLoading = false;
                    faceApiLoaded = false;
                    resolve();
                }
            });
        } else {
            // Face-API is already available, try to load the model
            try {
                // Wait for TensorFlow to be ready
                if (typeof tf !== 'undefined' && tf.ready) {
                    await tf.ready();
                }

                if (faceapi && faceapi.nets && faceapi.nets.tinyFaceDetector) {
                    // Check if model is already loaded
                    try {
                        await faceapi.nets.tinyFaceDetector.loadFromUri('https://cdn.jsdelivr.net/npm/@vladmandic/face-api@latest/model');
                        faceApiLoaded = true;
                    } catch (loadError) {
                        // Model might already be loaded, check if we can use it
                        if (loadError.message && loadError.message.includes('already loaded')) {
                            faceApiLoaded = true;
                        } else {
                            throw loadError;
                        }
                    }
                } else {
                    faceApiLoaded = false;
                }
            } catch (e) {
                faceApiLoaded = false;
            }
            faceApiLoading = false;
        }
    } catch (error) {
        faceApiLoading = false;
        faceApiLoaded = false;
    }

    return faceApiLoaded;
}

async function detectFaceInImage(imageSrc) {
    if (!faceApiLoaded) {
        await loadFaceApi();
    }

    if (!faceApiLoaded || typeof faceapi === 'undefined') {
        return { detected: false, warning: null }; // Silent fail - don't show warning if not available
    }

    // Additional safety check for faceapi methods
    if (!faceapi || !faceapi.detectAllFaces || !faceapi.TinyFaceDetectorOptions || !faceapi.fetchImage) {
        return { detected: false, warning: null };
    }

    try {
        // Handle data URLs and regular URLs
        let img;
        if (imageSrc.startsWith('data:')) {
            // For data URLs, create an image element
            img = new Image();
            img.src = imageSrc;
            await new Promise((resolve, reject) => {
                try {
                    let resolved = false;
                    const timeoutId = setTimeout(() => {
                        if (!resolved && img.complete === false) {
                            resolved = true;
                            reject(new Error('Image load timeout'));
                        }
                    }, 10000);

                    img.onload = () => {
                        if (!resolved) {
                            resolved = true;
                            clearTimeout(timeoutId);
                            resolve();
                        }
                    };
                    img.onerror = () => {
                        if (!resolved) {
                            resolved = true;
                            clearTimeout(timeoutId);
                            elloLog('Image load error in face detection');
                            reject(new Error('Image failed to load'));
                        }
                    };
                } catch (err) {
                    reject(err);
                }
            });
        } else {
            try {
                img = await faceapi.fetchImage(imageSrc);
            } catch (fetchError) {
                return { detected: false, warning: null };
            }
        }

        if (!img) {
            return { detected: false, warning: null };
        }

        const detections = await faceapi.detectAllFaces(img, new faceapi.TinyFaceDetectorOptions());

        return {
            detected: detections.length > 0,
            count: detections.length,
            warning: detections.length === 0 ? 'No face detected. For best results, use a photo with your face clearly visible.' : null
        };
    } catch (error) {
        elloLog('Face detection error:', error);
        return { detected: false, warning: null }; // Silent fail
    }
}

// Body detection using TensorFlow.js MoveNet
let tfLoaded = false;
let tfLoading = false;
let movenetModel = null;

async function loadTensorFlow() {
    // Check if TensorFlow.js is already loaded (possibly by Face-API.js)
    if (typeof tf !== 'undefined') {
        // Wait for TensorFlow to be ready
        try {
            if (tf.ready) {
                await tf.ready();
            }
            tfLoaded = true;
            return true;
        } catch (error) {
            tfLoaded = false;
            return false;
        }
    }

    if (tfLoaded || tfLoading) return tfLoaded;

    tfLoading = true;
    try {
        // Load TensorFlow.js from CDN only if not already present
        await new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.10.0/dist/tf.min.js';
            script.onload = async () => {
                try {
                    // Double-check it loaded and wait for it to be ready
                    if (typeof tf !== 'undefined') {
                        if (tf.ready) {
                            await tf.ready();
                        }
                        tfLoaded = true;
                    } else {
                        tfLoaded = false;
                    }
                } catch (error) {
                    tfLoaded = false;
                }
                tfLoading = false;
                resolve();
            };
            script.onerror = () => {
                tfLoading = false;
                tfLoaded = false;
                resolve(); // Don't reject, graceful fallback
            };
            document.head.appendChild(script);
        });
    } catch (error) {
        tfLoading = false;
        tfLoaded = false;
    }

    return tfLoaded;
}

async function loadMoveNetModel() {
    if (!tfLoaded) {
        await loadTensorFlow();
    }

    if (!tfLoaded || typeof tf === 'undefined') {
        return null;
    }

    // Ensure TensorFlow is ready before loading models
    try {
        if (tf.ready) {
            await tf.ready();
        }
    } catch (error) {
        elloLog('TensorFlow ready check failed in loadMoveNetModel:', error);
        return null;
    }

    if (movenetModel) {
        return movenetModel;
    }

    try {
        // Load pose-detection library first (most reliable approach)
        if (typeof poseDetection === 'undefined') {
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2.1.0/dist/pose-detection.min.js';
                script.onload = () => {
                    // Wait a bit for poseDetection to be available
                    setTimeout(resolve, 500);
                };
                script.onerror = () => {
                    elloLog('Pose-detection library failed to load');
                    resolve(); // Don't reject, just continue
                };
                document.head.appendChild(script);
            });
        }

        // Use pose-detection library to create MoveNet detector
        if (typeof poseDetection !== 'undefined' && poseDetection.createDetector) {
            const detector = await poseDetection.createDetector(
                poseDetection.SupportedModels.MoveNet,
                {
                    modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
                }
            );
            // Store the detector as the model
            movenetModel = detector;
            elloLog('✅ MoveNet detector loaded successfully via pose-detection library');
            return movenetModel;
        } else {
            elloLog('⚠️ pose-detection library not available after loading');
            return null;
        }
    } catch (error) {
        elloLog('MoveNet loading failed:', error);
        return null;
    }

    return null;
}

async function detectBodyInImage(imageSrc) {
    // Check if TensorFlow is available (may be loaded by Face-API.js)
    if (typeof tf === 'undefined') {
        await loadTensorFlow();
    } else {
        // Wait for TensorFlow to be ready
        try {
            if (tf.ready) {
                await tf.ready();
            }
        } catch (error) {
            elloLog('TensorFlow ready check failed in detectBodyInImage:', error);
        }
        tfLoaded = true; // Mark as loaded if it's already available
    }

    if (typeof tf === 'undefined') {
        // Silent fail - don't block upload if TensorFlow isn't available
        return { detected: false, state: null, warning: null, message: null };
    }

    try {
        const model = await loadMoveNetModel();
        if (!model) {
            // Silent fail - don't block upload if model can't load
            return { detected: false, state: null, warning: null, message: null };
        }

        // Load and preprocess image
        const img = new Image();
        // Only set crossOrigin for external URLs, not data URLs
        if (!imageSrc.startsWith('data:')) {
            img.crossOrigin = 'anonymous';
        }
        img.src = imageSrc;

        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
        });

        // Check if model is a pose-detection detector (has estimatePoses method)
        if (model && typeof model.estimatePoses === 'function') {
            // Use pose-detection API
            const poses = await model.estimatePoses(img);
            if (!poses || poses.length === 0) {
                // No poses detected - reject
                return {
                    detected: false,
                    state: 'reject',
                    message: 'No body detected in photo. Please upload a full-body photo with you standing clearly visible.',
                    warning: null
                };
            }

            // Process keypoints from pose-detection library
            // pose-detection returns keypoints as array of objects with {x, y, name, score}
            const keypoints = poses[0].keypoints;

            if (!keypoints || keypoints.length === 0) {
                return {
                    detected: false,
                    state: 'reject',
                    message: 'No body detected in photo. Please upload a full-body photo with you standing clearly visible.',
                    warning: null
                };
            }

            // Extract key body keypoints by name
            // MoveNet keypoint names in pose-detection: 'left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'
            // Also handle variations like 'LEFT_SHOULDER', 'leftShoulder', etc.
            let leftShoulder = 0, rightShoulder = 0, leftHip = 0, rightHip = 0;

            for (const kp of keypoints) {
                const name = (kp.name || '').toLowerCase().replace(/[_\s]/g, '');
                const score = kp.score || 0;

                // Match shoulders and hips by checking for key terms
                if (name.includes('left') && name.includes('shoulder')) {
                    leftShoulder = score;
                } else if (name.includes('right') && name.includes('shoulder')) {
                    rightShoulder = score;
                } else if (name.includes('left') && name.includes('hip')) {
                    leftHip = score;
                } else if (name.includes('right') && name.includes('hip')) {
                    rightHip = score;
                }
            }

            // Debug: log all keypoint names to help troubleshoot
            elloLog('Available keypoints:', keypoints.map(kp => ({ name: kp.name, score: kp.score })));

            // Configuration: Confidence thresholds
            const SHOULDER_CONFIDENCE_THRESHOLD = 0.5;
            const HIP_CONFIDENCE_THRESHOLD = 0.5;

            // Calculate average confidence of all keypoints
            const allScores = keypoints.map(kp => kp.score || 0);
            const avgConfidence = allScores.reduce((sum, score) => sum + score, 0) / allScores.length;
            const REJECT_AVG_CONFIDENCE_THRESHOLD = 0.2;

            // Check for body structure detection
            const hasBothShoulders = leftShoulder > SHOULDER_CONFIDENCE_THRESHOLD && rightShoulder > SHOULDER_CONFIDENCE_THRESHOLD;
            const hasBothHips = leftHip > HIP_CONFIDENCE_THRESHOLD && rightHip > HIP_CONFIDENCE_THRESHOLD;
            const hasAnyShoulder = leftShoulder > SHOULDER_CONFIDENCE_THRESHOLD || rightShoulder > SHOULDER_CONFIDENCE_THRESHOLD;
            const hasAnyHip = leftHip > HIP_CONFIDENCE_THRESHOLD || rightHip > HIP_CONFIDENCE_THRESHOLD;

            // Three-tier detection system:
            // 1. REJECT: No body detected (no shoulders AND no hips, or very low average confidence)
            // 2. WARNING: Partial body (shoulders OR hips, but not both)
            // 3. SUCCESS: Full body (both shoulders AND hips detected)

            let state, message, detected;

            if ((!hasAnyShoulder && !hasAnyHip) || avgConfidence < REJECT_AVG_CONFIDENCE_THRESHOLD) {
                // REJECT: No body detected
                state = 'reject';
                detected = false;
                message = 'No body detected in photo. Please upload a full-body photo with you standing clearly visible.';
            } else if (hasBothShoulders && hasBothHips) {
                // SUCCESS: Full body detected
                state = 'success';
                detected = true;
                message = null; // No message needed for success
            } else {
                // WARNING: Partial body (shoulders OR hips, but not both)
                state = 'warning';
                detected = true; // Still allow upload, just warn
                if (hasAnyShoulder && !hasAnyHip) {
                    message = 'Only upper body detected. For best try-on results, include your full body (shoulders to hips) in the photo.';
                } else if (hasAnyHip && !hasAnyShoulder) {
                    message = 'Only lower body detected. For best try-on results, include your full body (shoulders to hips) in the photo.';
                } else {
                    message = 'Partial body detected. For best try-on results, use a full-body photo with both your shoulders and hips clearly visible.';
                }
            }

            const detectedKeypoints = [leftShoulder, rightShoulder, leftHip, rightHip].filter(conf => conf > 0.5).length;

            elloLog('Body detection details (pose-detection):', {
                leftShoulder,
                rightShoulder,
                leftHip,
                rightHip,
                avgConfidence,
                hasBothShoulders,
                hasBothHips,
                state,
                detected
            });

            return {
                detected: detected,
                state: state,
                keypointCount: detectedKeypoints,
                message: message,
                warning: state === 'warning' ? message : (state === 'reject' ? message : null)
            };
        }

        // Otherwise, use TensorFlow graph model
        // Resize image for MoveNet (model expects 192x192)
        const tensor = tf.browser.fromPixels(img);
        const resized = tf.image.resizeBilinear(tensor, [192, 192]);
        const expanded = resized.expandDims(0);

        // MoveNet expects uint8 [0, 255] range, not normalized
        // Cast to int32 as the model signature requires
        const int32Tensor = expanded.cast('int32');

        // Clean up intermediate tensors (expanded is now part of int32Tensor)
        tensor.dispose();
        resized.dispose();
        expanded.dispose();

        // Run inference - MoveNet expects input shape [1, 192, 192, 3] with int32 dtype
        // Use execute() instead of executeAsync() as suggested by the warning
        const predictions = model.execute(int32Tensor);

        // Clean up input tensor after execution
        int32Tensor.dispose();

        // MoveNet output shape can vary - get the data
        // Get the raw array data
        let keypointsArray;
        try {
            keypointsArray = await predictions.array();
            // Dispose of predictions tensor after extracting data
            if (predictions && predictions.dispose) {
                predictions.dispose();
            }
        } catch (e) {
            elloLog('Error getting array from predictions:', e);
            // Dispose of predictions tensor even on error
            if (predictions && predictions.dispose) {
                predictions.dispose();
            }
            return { detected: false, warning: null };
        }

        // Handle different output shapes - flatten to get the keypoints
        let keypoints = null;

        try {
            // MoveNet can return different shapes depending on the model version
            // Common formats: [1, 17, 3], [1, 1, 17, 3], or [17, 3]
            if (!Array.isArray(keypointsArray)) {
                elloLog('Output is not an array, type:', typeof keypointsArray);
                return { detected: false, warning: null };
            }

            // Deep flatten to find the actual keypoints array [17, 3]
            let current = keypointsArray;
            let depth = 0;
            const maxDepth = 5;

            while (depth < maxDepth && Array.isArray(current)) {
                if (current.length === 17 && Array.isArray(current[0]) && current[0].length >= 3) {
                    // Found it! This is [17, 3]
                    keypoints = current;
                    break;
                } else if (current.length === 1 && Array.isArray(current[0])) {
                    // Unwrap one level
                    current = current[0];
                    depth++;
                } else if (current.length > 0 && Array.isArray(current[0]) && Array.isArray(current[0][0])) {
                    // Multi-level nested, try first element
                    current = current[0];
                    depth++;
                } else {
                    // Unknown structure, try to use as-is if it has 17 elements
                    if (current.length >= 17) {
                        keypoints = current;
                    }
                    break;
                }
            }

            if (!keypoints) {
                // Fallback: try common access patterns
                if (keypointsArray[0]?.[0]?.length === 3 && keypointsArray[0][0].length >= 17) {
                    keypoints = keypointsArray[0][0];
                } else if (keypointsArray[0]?.length >= 17) {
                    keypoints = keypointsArray[0];
                } else if (keypointsArray.length >= 17) {
                    keypoints = keypointsArray;
                }
            }

            if (!keypoints) {
                elloLog('Failed to extract keypoints from MoveNet output');
                return { detected: false, warning: null };
            }
        } catch (e) {
            elloLog('Error extracting keypoints structure:', e);
            return { detected: false, warning: null };
        }

        // Note: Tensors are already disposed above, predictions was disposed after array extraction

        // MoveNet returns 17 keypoints with [y, x, confidence] format
        // Important keypoints for body detection: shoulders, hips
        // Keypoint indices: 0=nose, 5=left shoulder, 6=right shoulder, 11=left hip, 12=right hip
        const keypointConfidences = [];

        // Ensure we have valid keypoints array BEFORE trying to access it
        if (!keypoints || !Array.isArray(keypoints) || keypoints.length < 17) {
            // Silent fail - don't block upload if we can't analyze
            return { detected: false, state: null, warning: null, message: null };
        }

        // Extract confidences - handle different possible structures
        for (let i = 0; i < 17; i++) {
            try {
                if (keypoints[i] && Array.isArray(keypoints[i]) && keypoints[i].length >= 3) {
                    // Standard format: [y, x, confidence]
                    const confidence = keypoints[i][2];
                    keypointConfidences.push(confidence || 0);
                } else if (typeof keypoints[i] === 'object' && keypoints[i] !== null) {
                    // Maybe it's an object format
                    const confidence = keypoints[i].score || keypoints[i].confidence || 0;
                    keypointConfidences.push(confidence);
                } else {
                    // Unknown format, use 0
                    keypointConfidences.push(0);
                }
            } catch (e) {
                elloLog(`Error extracting keypoint ${i}:`, e, keypoints[i]);
                keypointConfidences.push(0);
            }
        }

        // Configuration: Confidence thresholds
        const SHOULDER_CONFIDENCE_THRESHOLD = 0.5;
        const HIP_CONFIDENCE_THRESHOLD = 0.5;
        const REJECT_AVG_CONFIDENCE_THRESHOLD = 0.2;

        // Extract key body keypoints
        const leftShoulder = keypointConfidences[5];  // index 5
        const rightShoulder = keypointConfidences[6]; // index 6
        const leftHip = keypointConfidences[11];      // index 11
        const rightHip = keypointConfidences[12];     // index 12

        // Calculate average confidence of all keypoints - if too low, likely no body
        const avgConfidence = keypointConfidences.reduce((sum, conf) => sum + conf, 0) / keypointConfidences.length;

        // Check for body structure detection
        const hasBothShoulders = leftShoulder > SHOULDER_CONFIDENCE_THRESHOLD && rightShoulder > SHOULDER_CONFIDENCE_THRESHOLD;
        const hasBothHips = leftHip > HIP_CONFIDENCE_THRESHOLD && rightHip > HIP_CONFIDENCE_THRESHOLD;
        const hasAnyShoulder = leftShoulder > SHOULDER_CONFIDENCE_THRESHOLD || rightShoulder > SHOULDER_CONFIDENCE_THRESHOLD;
        const hasAnyHip = leftHip > HIP_CONFIDENCE_THRESHOLD || rightHip > HIP_CONFIDENCE_THRESHOLD;

        // Three-tier detection system:
        // 1. REJECT: No body detected (no shoulders AND no hips, or very low average confidence)
        // 2. WARNING: Partial body (shoulders OR hips, but not both)
        // 3. SUCCESS: Full body (both shoulders AND hips detected)

        let state, message, detected;

        if ((!hasAnyShoulder && !hasAnyHip) || avgConfidence < REJECT_AVG_CONFIDENCE_THRESHOLD) {
            // REJECT: No body detected
            state = 'reject';
            detected = false;
            message = 'No body detected in photo. Please upload a full-body photo with you standing clearly visible.';
        } else if (hasBothShoulders && hasBothHips) {
            // SUCCESS: Full body detected
            state = 'success';
            detected = true;
            message = null; // No message needed for success
        } else {
            // WARNING: Partial body (shoulders OR hips, but not both)
            state = 'warning';
            detected = true; // Still allow upload, just warn
            if (hasAnyShoulder && !hasAnyHip) {
                message = 'Only upper body detected. For best try-on results, include your full body (shoulders to hips) in the photo.';
            } else if (hasAnyHip && !hasAnyShoulder) {
                message = 'Only lower body detected. For best try-on results, include your full body (shoulders to hips) in the photo.';
            } else {
                message = 'Partial body detected. For best try-on results, use a full-body photo with both your shoulders and hips clearly visible.';
            }
        }

        const detectedKeypoints = [leftShoulder, rightShoulder, leftHip, rightHip].filter(conf => conf > 0.5).length;

        elloLog('Body detection details:', {
            leftShoulder,
            rightShoulder,
            leftHip,
            rightHip,
            avgConfidence,
            hasBothShoulders,
            hasBothHips,
            state,
            detected
        });

        return {
            detected: detected,
            state: state,
            keypointCount: detectedKeypoints,
            message: message,
            warning: state === 'warning' ? message : (state === 'reject' ? message : null)
        };
    } catch (error) {
        elloLog('Body detection error:', error);
        // On error, don't block - gracefully fail (silent fail)
        return { detected: false, state: null, warning: null, message: null };
    }
}

function validateImageFile(file) {
    const maxSize = 10 * 1024 * 1024; // 10MB
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

    if (!file) {
        return { isValid: false, error: 'No file selected.' };
    }

    if (!allowedTypes.includes(file.type)) {
        return {
            isValid: false,
            error: 'Please select a valid image file (JPEG, PNG, WebP, or GIF).'
        };
    }

    if (file.size > maxSize) {
        return {
            isValid: false,
            error: 'Image file is too large. Please choose a file smaller than 10MB.'
        };
    }

    return { isValid: true };
}

// Enhanced validation with quality checks
async function validateImageQuality(imageSrc, options = {}) {
    const includeFaceDetection = options.includeFaceDetection !== false;
    const includeBodyDetection = options.includeBodyDetection !== false;
    const warnings = [];
    const errors = [];

    // Analyze image quality
    const analysis = await analyzeImageQuality(imageSrc);

    if (!analysis) {
        return {
            isValid: false,
            error: 'Failed to analyze image. Please try a different image.',
            warnings: []
        };
    }

    // Check minimum resolution - relaxed to allow more images
    const MIN_RESOLUTION = 300;
    if (analysis.width < MIN_RESOLUTION || analysis.height < MIN_RESOLUTION) {
        warnings.push(`Image resolution is on the lower side. For best results, use an image at least ${MIN_RESOLUTION}x${MIN_RESOLUTION} pixels.`);
    }

    // Check aspect ratio (portrait orientation) - warning only, not blocking
    if (!analysis.isPortrait) {
        warnings.push('Portrait orientation is recommended for best try-on results. Landscape photos may not work as well.');
    } else {
        // Check width/height ratio (should be between 0.5 and 0.8)
        if (analysis.widthHeightRatio < 0.5 || analysis.widthHeightRatio > 0.8) {
            warnings.push('Image aspect ratio is not ideal. For best results, use a full-body portrait photo.');
        }
    }

    // Check brightness
    if (analysis.brightness < 0.15) {
        errors.push('Image is too dark. Please use a photo with better lighting.');
    } else if (analysis.brightness > 0.9) {
        errors.push('Image is too bright. Please use a photo with more balanced lighting.');
    } else if (analysis.brightness < 0.25 || analysis.brightness > 0.8) {
        warnings.push('Lighting could be improved for better results.');
    }

    // Check contrast
    if (analysis.contrast < 0.05) {
        errors.push('Image has insufficient contrast. Please use a clearer, more defined photo.');
    } else if (analysis.contrast < 0.1) {
        warnings.push('Image contrast is low. Better contrast will improve try-on results.');
    }

    if (includeFaceDetection) {
        const faceResult = await detectFaceInImage(imageSrc);
        if (faceResult.warning && !faceResult.detected) {
            warnings.push(faceResult.warning);
        }
    }

    if (includeBodyDetection) {
        const bodyResult = await detectBodyInImage(imageSrc);

        if (bodyResult && bodyResult.state) {
            if (bodyResult.state === 'reject') {
                errors.push(bodyResult.message || 'No body detected in photo. Please upload a full-body photo with you standing clearly visible.');
            } else if (bodyResult.state === 'warning') {
                warnings.push(bodyResult.message || 'Partial body detected. For best try-on results, use a full-body photo with both your shoulders and hips clearly visible.');
            }
        }
    }

    return {
        isValid: errors.length === 0,
        error: errors.length > 0 ? errors.join(' ') : null,
        warnings: warnings,
        analysis: analysis
    };
}

function updatePhotoPreview(imageData) {
    const optionsContainer = document.getElementById('uploadOptionsContainer');
    const workspace = document.getElementById('tryOnWorkspace');
    const photoContainer = document.getElementById('activeUserPhotoContainer');
    const activePhoto = document.getElementById('activeUserPhoto');

    // Hide general analyzing overlays if they exist
    const analysisOverlay = document.getElementById('photoAnalysisOverlay');
    if (analysisOverlay) {
        analysisOverlay.style.display = 'none';
    }
    const previewOverlay = document.getElementById('previewAnalysisOverlay');
    if (previewOverlay) {
        previewOverlay.style.display = 'none';
    }

    if (optionsContainer) optionsContainer.style.display = 'none';
    if (workspace) workspace.classList.add('visible');
    if (photoContainer) photoContainer.style.display = 'flex';

    // Hide photo instruction once image is uploaded
    const instruction = document.querySelector('.photo-instruction');
    if (instruction) instruction.style.display = 'none';

    if (activePhoto) {
        activePhoto.src = imageData;
        activePhoto.style.opacity = '1';
    }

    updateTryOnButton();
}

function openClothingBrowser() {
    const modal = document.getElementById('clothingBrowserModal');
    const backdrop = document.getElementById('modalBackdrop');

    modal.classList.add('active');
    backdrop.classList.add('active');
    document.body.style.overflow = 'hidden';

    // Reset pagination
    browserCurrentPage = 1;
    filteredClothing = [...sampleClothing];

    elloLog('Opening clothing browser, sampleClothing length:', sampleClothing.length);
    renderBrowserGrid();
}

function closeClothingBrowser() {
    const modal = document.getElementById('clothingBrowserModal');
    const backdrop = document.getElementById('modalBackdrop');

    modal.classList.remove('active');
    backdrop.classList.remove('active');

    if (!widgetOpen || !isMobile) {
        document.body.style.overflow = '';
    }
}

function renderBrowserGrid() {
    const grid = document.getElementById('browserGrid');

    elloLog('renderBrowserGrid called, sampleClothing length:', sampleClothing.length);
    elloLog('Grid element found:', !!grid);

    if (!grid) {
        console.error('Browser grid element not found!');
        return;
    }

    // Tier 2: under the new loading model sampleClothing only holds the small
    // preview (~7 items) at page load. The full catalog is fetched lazily on
    // widget open. The browser/search view needs the full catalog to feel
    // populated, so wait on it here before rendering. The trigger was already
    // fired in openWidget — this just blocks on the in-flight promise.
    if (!_elloFullCatalogLoaded && _elloFullCatalogPromise) {
        elloLog('Browse view waiting on full catalog…');
        grid.innerHTML = '<div style="text-align: center; padding: 40px; color: #666;">Loading products…</div>';
        _elloFullCatalogPromise.then(() => {
            filteredClothing = [...sampleClothing];
            renderBrowserGrid();
        });
        return;
    }

    // Check if clothing data is loaded
    if (!sampleClothing || sampleClothing.length === 0) {
        elloLog('No clothing data available, loading...');
        grid.innerHTML = '<div style="text-align: center; padding: 40px; color: #666;">Loading products...</div>';
        // Fall back to a full load if neither page-load preview nor widget-open
        // lazy load populated anything (e.g. both fetches failed).
        loadFullCatalogIfNeeded(window.ELLO_STORE_CONFIG || {}).then(() => {
            elloLog('Data loaded, re-rendering grid...');
            filteredClothing = [...sampleClothing];
            renderBrowserGrid();
        });
        return;
    }

    // Reset filtered clothing if needed
    if (filteredClothing.length === 0 || filteredClothing.length === sampleClothing.length) {
        filteredClothing = [...sampleClothing];
    }

    // Use updateBrowserDisplay to handle pagination
    updateBrowserDisplay();
}

function selectClothingFromBrowser(clothingId) {
    selectedClothing = clothingId;

    // Set window state variable
    const clothing = sampleClothing.find(item => item.id === clothingId);
    if (clothing) {
        // Track selected variant ID (use first variant if available, otherwise null)
        const selectedVariantId = clothing.variants?.[0]?.shopify_variant_gid || null;
        window.elloSelectedGarment = {
            image_url: clothing.image_url,
            ...clothing,
            selectedVariantId: selectedVariantId
        };
    }

    document.querySelectorAll('.browser-clothing-card').forEach(card => {
        card.classList.remove('selected');
    });

    event.target.closest('.browser-clothing-card').classList.add('selected');

    // Update preview
    updateSelectedClothingPreview(clothingId);

    closeClothingBrowser();

    // updateTryOnButton handles the button state
    updateTryOnButton();

    // Scroll to the preview to ensure user sees their selection
    const preview = document.getElementById('selectedClothingPreview');
    if (preview) {
        // Ensure it's visible (updateSelectedClothingPreview sets display:block, but just in case)
        preview.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function handleBrowserSearch() {
    const searchTerm = document.getElementById('browserSearch').value.toLowerCase().trim();

    // Reset to page 1 when searching
    browserCurrentPage = 1;

    if (searchTerm === '') {
        filteredClothing = [...sampleClothing];
    } else {
        filteredClothing = sampleClothing.filter(item => {
            const matchesName = item.name.toLowerCase().includes(searchTerm);
            const matchesCategory = item.category.toLowerCase().includes(searchTerm);
            const matchesColor = item.color.toLowerCase().includes(searchTerm);

            return matchesName || matchesCategory || matchesColor;
        });
    }

    updateBrowserDisplay();
}

function updateBrowserDisplay() {
    const grid = document.getElementById('browserGrid');
    const noResults = document.getElementById('noResultsMessage');
    const resultsCount = document.getElementById('searchResultsCount');

    grid.innerHTML = '';

    if (filteredClothing.length === 0) {
        grid.style.display = 'none';
        noResults.style.display = 'block';
        resultsCount.textContent = '';
        updatePaginationControls(0);
    } else {
        grid.style.display = 'grid';
        noResults.style.display = 'none';

        // Filter out items without images
        const itemsWithImages = filteredClothing.filter(item => {
            return item && item.image_url && item.image_url.trim() !== '' &&
                !item.image_url.includes('placeholder') &&
                !item.image_url.includes('data:image/svg');
        });

        // Calculate pagination with filtered items
        const totalPages = Math.ceil(itemsWithImages.length / browserItemsPerPage);
        const startIndex = (browserCurrentPage - 1) * browserItemsPerPage;
        const endIndex = startIndex + browserItemsPerPage;
        const itemsForCurrentPage = itemsWithImages.slice(startIndex, endIndex);

        // Update results count
        resultsCount.textContent = `Showing ${startIndex + 1}-${Math.min(endIndex, itemsWithImages.length)} of ${itemsWithImages.length} items`;

        // Render only items for current page
        itemsForCurrentPage.forEach(item => {
            const isSelected = selectedClothing === item.id;
            const selectedClass = isSelected ? 'selected' : '';

            const cardElement = document.createElement('div');
            cardElement.className = `browser-clothing-card ${selectedClass}`;
            cardElement.onclick = () => selectClothingFromBrowser(item.id);

            const safeName = (item.name || '').replace(/\"/g, '&quot;');
            // Add onload handler for fade-in effect
            const imgHtml = `<img src="${item.image_url}" alt="${safeName}" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.onerror=null;this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22300%22 height=%22400%22 viewBox=%220 0 300 400%22%3E%3Crect width=%22300%22 height=%22400%22 fill=%22%23f0f0f0%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 fill=%22%23999%22 font-family=%22Arial%22 font-size=%2214%22%3ENo Image%3C/text%3E%3C/svg%3E'">`;

            cardElement.innerHTML = `
                <div class="browser-image-wrap">${imgHtml}</div>
                <div class="browser-card-name">${safeName}</div>
            `;

            grid.appendChild(cardElement);
        });

        // Update pagination controls
        updatePaginationControls(totalPages);
    }
}

// Pagination navigation functions
function goToBrowserPage(page) {
    const totalPages = Math.ceil(filteredClothing.length / browserItemsPerPage);

    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;

    browserCurrentPage = page;
    updateBrowserDisplay();

    // Scroll to top of grid
    const grid = document.getElementById('browserGrid');
    if (grid) {
        grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function nextBrowserPage() {
    const totalPages = Math.ceil(filteredClothing.length / browserItemsPerPage);
    if (browserCurrentPage < totalPages) {
        goToBrowserPage(browserCurrentPage + 1);
    }
}

function prevBrowserPage() {
    if (browserCurrentPage > 1) {
        goToBrowserPage(browserCurrentPage - 1);
    }
}

function updatePaginationControls(totalPages) {
    const paginationContainer = document.getElementById('browserPagination');
    if (!paginationContainer) return;

    if (totalPages <= 1) {
        paginationContainer.style.display = 'none';
        return;
    }

    paginationContainer.style.display = 'flex';

    // Build pagination HTML
    let paginationHTML = '';

    // Previous button
    paginationHTML += `
        <button class="pagination-btn" onclick="prevBrowserPage()" ${browserCurrentPage === 1 ? 'disabled' : ''}>
            ← Previous
        </button>
    `;

    // Page numbers
    const maxVisiblePages = 5;
    let startPage = Math.max(1, browserCurrentPage - Math.floor(maxVisiblePages / 2));
    let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);

    if (endPage - startPage < maxVisiblePages - 1) {
        startPage = Math.max(1, endPage - maxVisiblePages + 1);
    }

    if (startPage > 1) {
        paginationHTML += `<button class="pagination-btn" onclick="goToBrowserPage(1)">1</button>`;
        if (startPage > 2) {
            paginationHTML += `<span class="pagination-ellipsis">...</span>`;
        }
    }

    for (let i = startPage; i <= endPage; i++) {
        paginationHTML += `
            <button class="pagination-btn ${i === browserCurrentPage ? 'active' : ''}" onclick="goToBrowserPage(${i})">
                ${i}
            </button>
        `;
    }

    if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
            paginationHTML += `<span class="pagination-ellipsis">...</span>`;
        }
        paginationHTML += `<button class="pagination-btn" onclick="goToBrowserPage(${totalPages})">${totalPages}</button>`;
    }

    // Next button
    paginationHTML += `
        <button class="pagination-btn" onclick="nextBrowserPage()" ${browserCurrentPage === totalPages ? 'disabled' : ''}>
            Next →
        </button>
    `;

    paginationContainer.innerHTML = paginationHTML;
}

// Ello Try-On API helper function
async function callElloTryOn(personImageUrl, productImageUrl) {
    // Extract tracking fields
    const storeSlug = window.ELLO_STORE_CONFIG?.storeSlug || window.ELLO_STORE_SLUG || window.ELLO_STORE_ID;
    const garment = window.elloSelectedGarment;

    // Normalize Product ID to GID format
    let productId = garment?.shopify_product_gid || garment?.shopify_product_id || garment?.id || null;
    if (productId && /^\d+$/.test(String(productId))) {
        productId = `gid://shopify/Product/${productId}`;
    }

    const variantId = garment?.selectedVariantId || garment?.variants?.[0]?.shopify_variant_gid || null;
    const sessionId = window.ELLO_SESSION_ID || null;

    // Validate required field
    if (!storeSlug) {
        console.error("Ello: storeSlug is required but missing. Cannot call /tryon API.");
        throw new Error("Store slug is required for try-on API call");
    }

    // Surface attribution — which UI fired this try-on. Set by:
    //   • elloOpenTryOnFromInline → 'inline_button'
    //   • preview-popup CTA → 'preview_popup'
    //   • openWidget() (everything else) → 'floating_widget'
    // We consume-and-clear here so a subsequent try-on without a fresh open
    // doesn't get mis-attributed to the last surface.
    const entrySource = window.ELLO_PENDING_ENTRY_SOURCE || 'floating_widget';
    window.ELLO_PENDING_ENTRY_SOURCE = null;

    const payload = {
        personImageUrl,
        productImageUrl,
        modelName: "tryon-v1.6",
        storeSlug,
        productId: productId || null,
        variantId: variantId || null,
        sessionId: sessionId || null,
        pageContext: getPageContext(),
        entrySource,
    };


    // Derive backend URL from WIDGET_BASE_URL (set by loader from script src).
    // Staging widget → staging /tryon proxy → ML service.
    // Production widget → production /tryon proxy → ML service.
    const _tryonBase = window.ELLO_WIDGET_BASE_URL || "https://ello-shopify-app-13593516897.us-central1.run.app";
    elloLog("[Ello Widget] callElloTryOn ->", _tryonBase + "/tryon", "store:", storeSlug);

    const res = await fetch(
        _tryonBase + "/tryon",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        }
    );

    if (!res.ok) {
        // Try to parse error response
        let errorData = {};
        let errorMessage = '';
        try {
            errorData = await res.json();
            errorMessage = errorData.message || errorData.error || JSON.stringify(errorData);
        } catch (parseError) {
            // If JSON parsing fails, try to get text
            try {
                errorMessage = await res.text();
            } catch (textError) {
                errorMessage = `HTTP error! status: ${res.status}`;
            }
        }

        // Free-plan monthly limit reached (ello_free plan — 10 try-ons/month)
        if (res.status === 403 && (errorData.error === 'MONTHLY_LIMIT_REACHED' || (errorMessage && errorMessage.toUpperCase().includes('MONTHLY_LIMIT_REACHED')))) {
            throw new Error("MONTHLY_LIMIT_REACHED");
        }

        // Handle overage blocking errors (backend's record_tryon_event throws OVERAGE_BLOCKED)
        if (errorMessage && errorMessage.toUpperCase().includes('OVERAGE_BLOCKED')) {
            throw new Error("OVERAGE_BLOCKED");
        }

        // Handle rate limit errors (429) specifically
        if (res.status === 429) {
            handleRateLimitError(errorData);
            throw new Error("RATE_LIMIT_EXCEEDED"); // Special error to prevent further processing
        }

        // Handle other errors
        console.error("Ello API error", res.status, errorMessage);
        throw new Error("Ello API error: " + res.status);
    }

    const data = await res.json();

    // Handle different response formats
    let imageB64 = data?.imageB64 || data?.image_b64 || data?.image || "";

    // Check for output array format: {output: ["<base64>"]}
    if (!imageB64 && data?.output && Array.isArray(data.output) && data.output.length > 0) {
        imageB64 = data.output[0];
    }

    if (!imageB64) {
        throw new Error("Ello API: missing imageB64 in response");
    }

    // Ensure it is a data URL
    if (!imageB64.startsWith("data:image")) {
        imageB64 = "data:image/png;base64," + imageB64;
    }

    return imageB64;
}

// Helper function to show/hide loader
function showLoader(show) {
    const el = document.getElementById("ello-tryon-loader");
    if (!el) {
        console.warn("Ello: loader element not found");
        return;
    }
    el.style.display = show ? "flex" : "none";
}

const TRYON_LOADING_STATUS = "Applying the outfit...";

const TRYON_LOADING_TIPS = [
    "Use a clear, well-lit photo for best results.",
    "Stand facing the camera when possible.",
    "Avoid baggy layers over the outfit area.",
    "Full-body photos usually work better than close crops.",
    "Results may vary based on pose, lighting, and product angle."
];

const tryOnLoadingIntervals = {};

function getTryOnLoadingRoot(surface) {
    return document.getElementById(surface === 'preview' ? 'previewProgressOverlay' : 'tryOnLoadingBar');
}

function setTryOnLoadingImage(img, src) {
    if (!img) return;

    if (src) {
        img.src = src;
        img.style.visibility = 'visible';
    } else {
        img.removeAttribute('src');
        img.style.visibility = 'hidden';
    }
}

function refreshTryOnLoadingImages(root) {
    if (!root) return;

    const garment = window.elloSelectedGarment || {};
    const productImageUrl = garment.image_url || document.getElementById('previewProductImg')?.src || '';
    const personImageUrl = window.elloUserImageUrl || userPhoto || '';

    setTryOnLoadingImage(root.querySelector('[data-loading-product]'), productImageUrl);
    setTryOnLoadingImage(root.querySelector('[data-loading-person]'), personImageUrl);
}

function updateTryOnLoadingCopy(root, index) {
    if (!root) return;

    const stepEl = root.querySelector('[data-loading-step]');
    const tipEl = root.querySelector('[data-loading-tip]');

    if (stepEl) {
        stepEl.textContent = TRYON_LOADING_STATUS;
    }
    if (tipEl) {
        tipEl.textContent = TRYON_LOADING_TIPS[index % TRYON_LOADING_TIPS.length];
    }
}

function updateTryOnLoadingProgress(root, percent) {
    if (!root) return;

    const boundedPercent = Math.max(0, Math.min(100, Math.round(percent)));
    const progressEl = root.querySelector('[data-loading-progress]');
    const percentEl = root.querySelector('[data-loading-percent]');

    if (progressEl) {
        progressEl.style.width = `${boundedPercent}%`;
    }
    if (percentEl) {
        percentEl.textContent = `${boundedPercent}%`;
    }
}

function startTryOnLoadingState(surface) {
    const root = getTryOnLoadingRoot(surface);
    if (!root) return;

    stopTryOnLoadingState(surface);
    refreshTryOnLoadingImages(root);
    updateTryOnLoadingCopy(root, 0);
    updateTryOnLoadingProgress(root, 8);

    let index = 0;
    let lastTipUpdate = 0;
    const startTime = Date.now();
    const estimatedDuration = surface === 'preview' ? 12000 : 15000;

    tryOnLoadingIntervals[surface] = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / estimatedDuration, 0.95);
        const eased = 1 - Math.pow(1 - progress, 3);
        updateTryOnLoadingProgress(root, 8 + eased * 84);
        refreshTryOnLoadingImages(root);

        if (elapsed - lastTipUpdate >= 2600) {
            index += 1;
            lastTipUpdate = elapsed;
            updateTryOnLoadingCopy(root, index);
        }
    }, 120);
}

function stopTryOnLoadingState(surface) {
    if (tryOnLoadingIntervals[surface]) {
        clearInterval(tryOnLoadingIntervals[surface]);
        delete tryOnLoadingIntervals[surface];
    }
}

function showLoadingBar(show) {
    const container = document.getElementById("tryOnLoadingBar");
    const widget = document.getElementById("virtualTryonWidget");

    if (!container) {
        return;
    }

    if (show) {
        if (widget) {
            widget.classList.add('tryon-loading-active');
        }
        container.style.display = "flex";
        container.style.setProperty('display', 'flex', 'important');
        startTryOnLoadingState('full');
    } else {
        stopTryOnLoadingState('full');
        if (widget) {
            widget.classList.remove('tryon-loading-active');
        }
        container.style.setProperty('display', 'none', 'important');
    }
}

function completeLoadingBar() {
    const container = document.getElementById("tryOnLoadingBar");
    updateTryOnLoadingCopy(container, TRYON_LOADING_TIPS.length - 1);
    updateTryOnLoadingProgress(container, 100);
    stopTryOnLoadingState('full');
}

// Helper function to show error messages
function showError(message) {
    const el = document.getElementById("ello-tryon-error");
    if (!el) {
        console.warn("Error element not found, cannot display error message");
        return;
    }
    el.textContent = message || "";
    el.style.display = message ? "block" : "none";

    // Ensure resultSection is visible if error is being shown
    if (message) {
        const resultSection = document.getElementById("resultSection");
        if (resultSection && resultSection.style.display === "none") {
            resultSection.style.display = "block";
        }
    }
}

function clearError() {
    const el = document.getElementById("ello-tryon-error");
    if (el) {
        el.textContent = "";
        el.style.display = "none";
        el.classList.remove("rate-limit-error");
    }
    // Clear rate limit state when error is cleared
    isRateLimited = false;
    if (typeof updateTryOnButton === "function") {
        updateTryOnButton();
    }
}

// Free-plan (ello_free) monthly limit reached. Keep the widget mounted but swap
// the content area for an upgrade prompt so the page stays functional.
function showFreeLimitReached() {
    const container = document.getElementById("ello-limit-reached");
    if (container) {
        container.style.display = "flex";
        const resultSection = document.getElementById("resultSection");
        if (resultSection) resultSection.style.display = "none";
        return;
    }
    // Fallback: reuse showError if the dedicated container is missing
    showError("Monthly try-on limit reached. Upgrade to continue.");
}

// Inject "Powered by Ello VTO" branding for ello_free merchants. Idempotent.
// Renders as a hyperlink to the Shopify App Store listing and adapts its text
// color to whatever background it ends up sitting on (merchant-chosen widget
// colors, dark/light themes, etc.) via WCAG luminance sampling.
function injectElloBranding() {
    if (document.getElementById("ello-branding-footer")) return;
    const widget = document.getElementById("virtualTryonWidget");
    if (!widget) return;
    const footer = document.createElement("div");
    footer.id = "ello-branding-footer";
    footer.className = "ello-branding";
    const link = document.createElement("a");
    link.href = "https://apps.shopify.com/ello";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Powered by Ello VTO";
    footer.appendChild(link);
    widget.appendChild(footer);

    // Adaptive contrast — compute now and re-run when the widget's appearance
    // changes (theme toggle, merchant color update, resize/layout shift).
    applyBrandingContrast(footer);
    const reapply = () => applyBrandingContrast(footer);
    window.addEventListener("resize", reapply);
    if (typeof MutationObserver !== "undefined") {
        const mo = new MutationObserver(reapply);
        mo.observe(widget, { attributes: true, attributeFilter: ["class", "style"] });
    }
}

// Walk up from `el` until we hit an ancestor with a non-transparent
// background, then pick foreground colors that contrast against it.
function applyBrandingContrast(el) {
    const rgb = getEffectiveBackgroundColor(el);
    if (!rgb) return;
    const [r, g, b] = rgb;
    const toLin = (c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    const luminance = 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
    const isDarkBg = luminance < 0.5;
    const baseColor = isDarkBg ? "rgba(255,255,255,0.88)" : "rgba(0,0,0,0.78)";
    const hoverColor = isDarkBg ? "#ffffff" : "#000000";
    const shadow = isDarkBg
        ? "0 1px 2px rgba(0,0,0,0.45)"
        : "0 1px 2px rgba(255,255,255,0.65)";
    el.style.color = baseColor;
    el.style.textShadow = shadow;
    const link = el.querySelector("a");
    if (link) {
        link.style.color = baseColor;
        link.style.textShadow = shadow;
        link.onmouseenter = () => { link.style.color = hoverColor; };
        link.onmouseleave = () => { link.style.color = baseColor; };
    }
}

function getEffectiveBackgroundColor(el) {
    let node = el;
    while (node && node.nodeType === 1) {
        const bg = window.getComputedStyle(node).backgroundColor;
        const m = bg && bg.match(/rgba?\(([^)]+)\)/);
        if (m) {
            const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
            const alpha = parts.length === 4 ? parts[3] : 1;
            if (alpha > 0.1) return [parts[0], parts[1], parts[2]];
        }
        node = node.parentElement;
    }
    // Fallback: assume a light page background.
    return [255, 255, 255];
}

// Handle rate limit errors from the API
function handleRateLimitError(errorResponse) {
    console.warn("Rate limit exceeded:", errorResponse);

    // Set rate limit state
    isRateLimited = true;

    // Extract error message from response
    let errorMessage = errorResponse?.message ||
        "You've reached the daily limit of 15 try-ons for this store. Please try again in a few hours.";

    // Show rate limit error message
    showRateLimitError(errorMessage);

    // Update button state
    if (typeof updateTryOnButton === "function") {
        updateTryOnButton();
    }
}

// Show rate limit specific error message
function showRateLimitError(message) {
    const el = document.getElementById("ello-tryon-error");
    if (!el) return;

    // Set error message
    el.textContent = message || "";
    el.style.display = message ? "block" : "none";

    // Add rate limit specific styling if needed
    el.classList.add("rate-limit-error");
}


/**
 * Scroll to show the loading bar when Try On is clicked
 */
function scrollToLoadingBar() {
    const loadingBar = document.getElementById("tryOnLoadingBar");
    const tryonContent = document.getElementById('tryonContent');

    if (!loadingBar || !tryonContent) return;

    // Wait a moment for the bar to be visible
    setTimeout(() => {
        const containerRect = tryonContent.getBoundingClientRect();
        const barRect = loadingBar.getBoundingClientRect();
        const scrollOffset = barRect.top - containerRect.top + tryonContent.scrollTop - 20; // 20px padding from top

        // Smooth scroll to loading bar
        tryonContent.scrollTo({
            top: scrollOffset,
            behavior: 'smooth'
        });
    }, 50);
}

/**
 * Smoothly scroll to the result section with premium, smooth animation
 */
function smoothScrollToResult(resultSection) {
    if (!resultSection) return;

    // Find the scrollable container (tryon-content)
    const tryonContent = document.getElementById('tryonContent');
    if (!tryonContent) return;

    // Calculate the position to scroll to
    const containerRect = tryonContent.getBoundingClientRect();
    const resultRect = resultSection.getBoundingClientRect();

    // ALIGN TOP LOGIC:
    // Scroll so the top of the result image hits the top of the viewport (with a little padding)
    const centerOffset = (resultRect.top - containerRect.top) + tryonContent.scrollTop - 20;

    // Ensure we don't scroll past top
    const scrollOffset = Math.max(0, centerOffset);

    // Smooth scroll with premium easing
    const startScroll = tryonContent.scrollTop;
    const distance = Math.abs(scrollOffset - startScroll);

    // Dynamic duration based on distance for smoother feel
    // Base duration + distance-based adjustment (max 1200ms for very long scrolls)
    const baseDuration = 600;
    const distanceMultiplier = Math.min(distance / 500, 1); // Cap at 1x for distances > 500px
    const duration = baseDuration + (distanceMultiplier * 400); // 600-1000ms range

    const startTime = performance.now();
    let lastFrameTime = startTime;

    // Store rafId in outer scope to allow cancellation
    let rafId = null;

    // Premium easing function - easeOutQuart for smooth, elegant deceleration
    function easeOutQuart(t) {
        return 1 - Math.pow(1 - t, 4);
    }

    function animateScroll(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);

        // Use easeOutQuart for premium smooth deceleration
        const eased = easeOutQuart(progress);

        // Smooth interpolation
        const currentScroll = startScroll + (scrollOffset - startScroll) * eased;
        tryonContent.scrollTop = currentScroll;

        // Track frame timing for smoothness
        lastFrameTime = currentTime;

        if (progress < 1) {
            rafId = requestAnimationFrame(animateScroll);
        } else {
            // Ensure we end exactly at target (prevent rounding errors)
            tryonContent.scrollTop = scrollOffset;
            rafId = null;
        }
    }

    // Cancel any existing scroll animation if one is running
    // (This would require storing rafId globally, but for now we'll just start fresh)

    // Start animation on next frame for smoother start
    rafId = requestAnimationFrame(animateScroll);
}

// Try-on function - handles the complete try-on flow
// Make it globally accessible
// Public API for the inline-button theme block (and any other external caller).
// Sets attribution + optional variant pre-selection, then opens the existing
// popup IN INLINE MODE — a focused PDP-aware variant of the popup that hides
// browse/wardrobe/quick-picks and surfaces only: the selected product, the
// photo upload, and the Try On CTA. After try-on completes, the result CTAs
// become Add-to-Cart instead of "try another item."
//
// Inline mode is mutually exclusive with the floating-widget's full browse
// UX — same popup DOM, different CSS class. The class is added here via
// ELLO_INLINE_MODE flag and removed on closeWidget().
window.elloOpenTryOnFromInline = function (ctx) {
    if (ctx && ctx.variantId) {
        window.ELLO_PRESELECTED_VARIANT_ID = String(ctx.variantId);
    }
    // Tag surface BEFORE openWidget so the fallback inside openWidget doesn't
    // overwrite it with 'floating_widget'.
    window.ELLO_PENDING_ENTRY_SOURCE = (ctx && ctx.source) || 'inline_button';

    // Inline mode flag — consumed by openWidget(), closeWidget(), and the
    // result-render path in startTryOn(). Cleared in closeWidget() so the next
    // floating-widget open returns to the full browse UX.
    window.ELLO_INLINE_MODE = true;

    // Stash product context so Add-to-Cart has everything it needs without
    // re-deriving from DOM. productId is for /cart/add.js (Shopify's AJAX
    // cart endpoint); variantId may get replaced by the size picker.
    window.ELLO_INLINE_CTX = {
        productHandle: ctx && ctx.productHandle || null,
        productId:     ctx && ctx.productId     || null,
        variantId:     ctx && ctx.variantId     || null
    };

    // Auto-fire try-on without a second button click.
    //   - Returning user (saved photo): openWidget() detects this and fires
    //     startTryOn() immediately after setup → straight to loading bar.
    //   - First-time user: the file-picker upload handler detects this and
    //     fires startTryOn() immediately after upload completes → consent
    //     modal + picker is the only user-facing interaction.
    // Photo VALIDATION runs in parallel and never blocks the try-on call;
    // rejected photos surface as an error after the try-on attempt.
    window.ELLO_AUTO_FIRE = true;

    if (typeof openWidget === 'function') {
        openWidget();
    } else {
        console.warn('[Ello] openWidget not yet defined — inline click dropped');
    }
};

// ─── Inline-mode helpers ────────────────────────────────────────────────────
// All four functions below are exclusive to the inline-button surface. The
// floating widget never reaches them because window.ELLO_INLINE_MODE stays
// false when openWidget() is called from the bubble click path.

// Populates the existing #selectedClothingPreview element with the PDP
// product's image so the inline-mode layout shows what they're trying on.
// Forces the workspace + plus separator visible so the two-card layout
// (Your Photo + Product) reads correctly even before they've uploaded.
function setupInlineModeProductPreview(currentProduct) {
    const preview = document.getElementById('selectedClothingPreview');
    const previewImage = document.getElementById('selectedClothingImage');
    const workspace = document.getElementById('tryOnWorkspace');
    const plusSep = document.getElementById('tryOnPlusSeparator');

    // Resolve image url: prefer the rich elloSelectedGarment populated by
    // populateFeaturedAndQuickPicks; fall back to detectCurrentProduct's
    // image_url. One of the two is almost always populated on a PDP.
    const imageUrl =
        (window.elloSelectedGarment && window.elloSelectedGarment.image_url) ||
        (currentProduct && currentProduct.image_url) ||
        null;

    const productName =
        (window.elloSelectedGarment && (window.elloSelectedGarment.name || window.elloSelectedGarment.title)) ||
        (currentProduct && (currentProduct.title || currentProduct.name)) ||
        'this item';

    if (previewImage && imageUrl) {
        previewImage.src = imageUrl;
        previewImage.alt = productName;
    }
    if (preview) preview.style.display = 'flex';
    if (workspace) workspace.classList.add('visible');
    if (plusSep)   plusSep.style.display = 'flex';

    // Stash for the result-stage CTAs (Add-to-Cart button price label etc.)
    window.ELLO_INLINE_PRODUCT_NAME = productName;
}

// Lazily injects the inline-mode stylesheet on first open. Idempotent — we
// keep a flag on document.head so subsequent opens skip the work.
function ensureInlineModeStyles() {
    if (document.getElementById('ello-inline-mode-styles')) return;
    const style = document.createElement('style');
    style.id = 'ello-inline-mode-styles';
    style.textContent = `
        /* ─── Hide all browse/discover UI — inline mode is one-product focused ── */
        .virtual-tryon-widget.inline-mode .featured-section,
        .virtual-tryon-widget.inline-mode .quick-picks-section,
        .virtual-tryon-widget.inline-mode .browse-all-btn,
        .virtual-tryon-widget.inline-mode .wardrobe-btn,
        .virtual-tryon-widget.inline-mode #firstRunOverlay,
        .virtual-tryon-widget.inline-mode .onboarding-strip,
        .virtual-tryon-widget.inline-mode .mode-tabs,
        .virtual-tryon-widget.inline-mode .selected-clothing-remove,
        .virtual-tryon-widget.inline-mode .section-title { display: none !important; }

        /* ─── Workspace: two equal cards with centered "+" between them ───── */
        .virtual-tryon-widget.inline-mode .try-on-workspace {
            display: flex !important;
            flex-direction: row;
            align-items: center;
            justify-content: center;
            gap: 20px;
            padding: 24px 20px 16px;
            width: 100%;
            box-sizing: border-box;
        }
        .virtual-tryon-widget.inline-mode .active-user-photo-container,
        .virtual-tryon-widget.inline-mode .selected-clothing-preview {
            flex: 1 1 0;
            max-width: 200px;
            min-width: 0;
            margin: 0;
        }
        /* Force the photo container visible in inline mode even when there's
           no uploaded photo yet — we'll style it as the "Upload your photo"
           drop-target via the upload card instead of leaving an empty hole. */
        .virtual-tryon-widget.inline-mode .selected-clothing-preview {
            display: flex !important;
        }

        /* ─── Card styling: matched aspect ratio, soft shadow, clean ─────── */
        .virtual-tryon-widget.inline-mode .active-photo-wrapper,
        .virtual-tryon-widget.inline-mode .selected-clothing-image-container {
            position: relative;
            width: 100%;
            aspect-ratio: 3 / 4;
            border-radius: 12px;
            overflow: hidden;
            background: #f8f8f8;
            box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06);
        }
        .virtual-tryon-widget.inline-mode .active-user-photo,
        .virtual-tryon-widget.inline-mode .selected-clothing-image {
            width: 100%;
            height: 100%;
            object-fit: cover;
            display: block;
        }

        /* "Change photo" button — smaller, less obtrusive */
        .virtual-tryon-widget.inline-mode .change-photo-btn {
            position: absolute;
            bottom: 8px;
            left: 50%;
            transform: translateX(-50%);
            padding: 6px 12px;
            border-radius: 999px;
            background: rgba(0,0,0,0.75);
            color: #fff;
            border: none;
            font: inherit;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            backdrop-filter: blur(4px);
        }

        /* ─── Plus separator: clean, centered, more visible ────────────────── */
        .virtual-tryon-widget.inline-mode .plus-separator {
            display: flex !important;
            align-items: center;
            justify-content: center;
            width: 32px;
            height: 32px;
            border-radius: 50%;
            background: #f1f1f1;
            color: #666;
            font-size: 18px;
            font-weight: 400;
            flex-shrink: 0;
            padding: 0;
        }

        /* ─── Header: simpler, less "branded" ─────────────────────────────── */
        .virtual-tryon-widget.inline-mode .widget-header h2,
        .virtual-tryon-widget.inline-mode .widget-title { font-size: 15px; }

        /* ─── Pre-upload state: hide "Use a model" — inline is upload-only ── */
        .virtual-tryon-widget.inline-mode #useModelCard { display: none !important; }

        /* ─── Photo upload area — when no user photo yet, this is the CTA ── */
        /* Grow to fill the available vertical space inside the widget body and
           center its content. Without this, the cards hug the top of the
           section and leave a tall white gap below. */
        .virtual-tryon-widget.inline-mode .photo-section {
            margin-top: 0 !important;
            padding: 16px 20px !important;
            flex: 1 1 auto !important;
            display: flex !important;
            flex-direction: column !important;
            justify-content: center !important;
            align-items: stretch !important;
        }
        /* Single row: [upload card] [+] [product card]. Sized to fit the 420px
           desktop popup — 150px cards + 8px gap + 24px plus + 8px gap = 340px,
           fits cleanly inside the ~380px usable popup width. */
        .virtual-tryon-widget.inline-mode .photo-section-content {
            display: flex !important;
            flex-direction: row !important;
            align-items: center !important;
            justify-content: center !important;
            gap: 8px !important;
            max-width: 100% !important;
            margin: 0 auto !important;
            padding: 12px 4px !important;
            box-sizing: border-box !important;
        }
        /* Upload-options column = exactly 150px, no shrink, no grow. */
        .virtual-tryon-widget.inline-mode .upload-options-container {
            flex: 0 0 150px !important;
            width: 150px !important;
            min-width: 150px !important;
            max-width: 150px !important;
            margin: 0 !important;
            display: block !important;
        }
        .virtual-tryon-widget.inline-mode .upload-options-grid {
            display: block !important;
            grid-template-columns: none !important;
            gap: 0 !important;
            width: 150px !important;
            margin: 0 !important;
        }
        /* The lone upload card — fixed 150x200 (3:4), styled as a clear CTA. */
        .virtual-tryon-widget.inline-mode #uploadPhotoCard {
            width: 150px !important;
            height: 200px !important;
            min-height: 0 !important;
            box-sizing: border-box !important;
            border: 2px dashed #3B63D4 !important;
            background: #f5f7ff !important;
            border-radius: 12px !important;
            margin: 0 !important;
            padding: 14px 12px !important;
            display: flex !important;
            flex-direction: column !important;
            align-items: center !important;
            justify-content: center !important;
            text-align: center !important;
            gap: 6px !important;
            cursor: pointer !important;
            overflow: hidden !important;
            transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease !important;
            box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(59,99,212,0.08) !important;
        }
        .virtual-tryon-widget.inline-mode #uploadPhotoCard:hover {
            transform: translateY(-2px) !important;
            background: #eef2ff !important;
            box-shadow: 0 6px 18px rgba(59,99,212,0.18) !important;
        }
        .virtual-tryon-widget.inline-mode #uploadPhotoCard .option-icon-wrapper {
            width: auto !important;
            height: auto !important;
            margin: 0 !important;
            background: transparent !important;
        }
        .virtual-tryon-widget.inline-mode #uploadPhotoCard .option-icon {
            font-size: 26px !important;
            line-height: 1 !important;
        }
        .virtual-tryon-widget.inline-mode #uploadPhotoCard .option-title {
            margin: 4px 0 0 !important;
            font-size: 13px !important;
            font-weight: 600 !important;
            color: #0B1220 !important;
            line-height: 1.25 !important;
        }
        .virtual-tryon-widget.inline-mode #uploadPhotoCard .option-subtitle {
            margin: 0 !important;
            font-size: 11px !important;
            color: #6b7280 !important;
            line-height: 1.3 !important;
            max-width: 120px !important;
        }
        .virtual-tryon-widget.inline-mode #uploadPhotoCard .option-btn {
            margin-top: 4px !important;
            padding: 7px 10px !important;
            background: #3B63D4 !important;
            color: #fff !important;
            border: none !important;
            border-radius: 6px !important;
            font: inherit !important;
            font-size: 11px !important;
            font-weight: 600 !important;
            cursor: pointer !important;
            white-space: nowrap !important;
            width: auto !important;
        }
        /* Hide the "Recommended" pill */
        .virtual-tryon-widget.inline-mode #uploadPhotoCard .recommended-badge {
            display: none !important;
        }
        /* Workspace = the right side: just the [+] [product card] inline. */
        .virtual-tryon-widget.inline-mode .photo-section-content .try-on-workspace {
            display: flex !important;
            flex-direction: row !important;
            align-items: center !important;
            justify-content: center !important;
            flex: 0 0 auto !important;
            width: auto !important;
            max-width: none !important;
            margin: 0 !important;
            padding: 0 !important;
            gap: 8px !important;
        }
        /* Product preview card = same 150x200 as the upload card. */
        .virtual-tryon-widget.inline-mode .photo-section-content .selected-clothing-preview {
            flex: 0 0 150px !important;
            width: 150px !important;
            min-width: 150px !important;
            max-width: 150px !important;
            margin: 0 !important;
        }
        .virtual-tryon-widget.inline-mode .photo-section-content .selected-clothing-image-container {
            width: 150px !important;
            height: 200px !important;
            aspect-ratio: auto !important;
        }
        /* Plus separator sized smaller so the row fits cleanly */
        .virtual-tryon-widget.inline-mode .photo-section-content .plus-separator {
            width: 24px !important;
            height: 24px !important;
            font-size: 14px !important;
            flex-shrink: 0 !important;
        }
        /* Mobile — popup is calc(100vw - 40px), so on a 390px phone the popup
           is ~350px wide. Usable inside padding = ~310px. 140px cards × 2 +
           6px gap + 20px plus + 6px gap = 312px. Tight but fits. */
        @media (max-width: 480px) {
            .virtual-tryon-widget.inline-mode .photo-section-content {
                gap: 6px !important;
                padding: 10px 2px !important;
                max-width: 100% !important;
            }
            .virtual-tryon-widget.inline-mode .upload-options-container {
                flex: 0 0 140px !important;
                width: 140px !important;
                min-width: 140px !important;
                max-width: 140px !important;
            }
            .virtual-tryon-widget.inline-mode .upload-options-grid { width: 140px !important; }
            .virtual-tryon-widget.inline-mode #uploadPhotoCard {
                width: 140px !important;
                height: 187px !important;
                padding: 10px 8px !important;
                gap: 4px !important;
            }
            .virtual-tryon-widget.inline-mode #uploadPhotoCard .option-icon { font-size: 24px !important; }
            .virtual-tryon-widget.inline-mode #uploadPhotoCard .option-title { font-size: 12px !important; }
            .virtual-tryon-widget.inline-mode #uploadPhotoCard .option-subtitle { font-size: 10px !important; max-width: 110px !important; }
            .virtual-tryon-widget.inline-mode #uploadPhotoCard .option-btn { padding: 6px 10px !important; font-size: 11px !important; }
            .virtual-tryon-widget.inline-mode .photo-section-content .try-on-workspace { gap: 6px !important; }
            .virtual-tryon-widget.inline-mode .photo-section-content .selected-clothing-preview {
                flex: 0 0 140px !important;
                width: 140px !important;
                min-width: 140px !important;
                max-width: 140px !important;
            }
            .virtual-tryon-widget.inline-mode .photo-section-content .selected-clothing-image-container {
                width: 140px !important;
                height: 187px !important;
            }
            .virtual-tryon-widget.inline-mode .photo-section-content .plus-separator {
                width: 20px !important;
                height: 20px !important;
                font-size: 13px !important;
            }
        }

        /* ─── Action buttons row — single full-width primary CTA ──────────── */
        /* Hide the Close button in inline mode — the top-right × is the only
           exit. Reducing exit affordances keeps the shopper in the flow. */
        .virtual-tryon-widget.inline-mode .action-buttons {
            padding: 12px 16px 16px;
            gap: 0;
        }
        .virtual-tryon-widget.inline-mode .action-buttons .btn-secondary {
            display: none !important;
        }
        .virtual-tryon-widget.inline-mode .action-buttons .btn-primary {
            flex: 1 1 auto !important;
            width: 100% !important;
        }

        /* When result is ready, hide the default action-buttons row.
           Inline-mode CTAs render inside #resultSection instead. */
        .virtual-tryon-widget.inline-mode.inline-mode-result-ready .action-buttons { display: none !important; }
        /* Also hide the workspace once result is showing — full focus on the result image */
        .virtual-tryon-widget.inline-mode.inline-mode-result-ready .try-on-workspace,
        .virtual-tryon-widget.inline-mode.inline-mode-result-ready .photo-section { display: none !important; }

        /* Inline-mode result section: tighten padding and let the image breathe
           a bit larger — buttons stack below so we have vertical room. */
        .virtual-tryon-widget.inline-mode #resultSection {
            padding: 8px 12px 0 !important;
        }
        .virtual-tryon-widget.inline-mode .tryon-result-container {
            padding: 0 !important;
        }
        .virtual-tryon-widget.inline-mode .tryon-result-image {
            max-height: 460px !important;
            max-width: 360px !important;
            border-radius: 10px;
        }
        @media (max-width: 480px) {
            .virtual-tryon-widget.inline-mode .tryon-result-image {
                max-height: 420px !important;
                max-width: 100% !important;
            }
        }

    `;
    document.head.appendChild(style);
}

// Styles for the result-stage CTA stack (Add-to-Cart + optional Try-another
// + attribution). Must be injected for every entry point — inline button,
// widget preview, AND the floating widget — so the CTAs never render naked.
// Separate from ensureInlineModeStyles because that one only runs in inline mode.
function ensureResultCtasStyles() {
    if (document.getElementById('ello-result-ctas-styles')) return;
    const style = document.createElement('style');
    style.id = 'ello-result-ctas-styles';
    style.textContent = `
        #ello-inline-result-ctas {
            display: flex; flex-direction: column; gap: 8px;
            margin-top: 10px; padding: 0 12px 12px;
            max-width: 420px; margin-left: auto; margin-right: auto;
        }
        #ello-inline-result-ctas .ello-inline-attribution {
            text-align: center;
            font-size: 11px;
            color: #9ca3af;
            letter-spacing: 0.02em;
            margin: 0 0 4px;
        }
        #ello-inline-result-ctas .ello-inline-attribution a {
            color: #6b7280;
            text-decoration: none;
            font-weight: 500;
        }
        #ello-inline-result-ctas .ello-inline-attribution a:hover {
            color: #111;
            text-decoration: underline;
        }
        #ello-inline-result-ctas .ello-inline-btn-row {
            display: flex;
            flex-direction: column;
            gap: 8px;
            width: 100%;
        }
        #ello-inline-result-ctas .ello-inline-btn {
            box-sizing: border-box; width: 100%;
            padding: 13px 20px; border: none; border-radius: 6px;
            font: inherit; font-weight: 600; font-size: 15px;
            cursor: pointer; transition: opacity 0.15s;
        }
        #ello-inline-result-ctas .ello-inline-btn-primary {
            background: #000; color: #fff;
        }
        #ello-inline-result-ctas .ello-inline-btn-secondary {
            background: transparent; color: #000; border: 1px solid #d1d5db;
        }
        #ello-inline-result-ctas .ello-inline-btn:disabled { opacity: 0.6; cursor: wait; }
        #ello-inline-cart-error {
            margin-top: 8px; padding: 10px 12px; border-radius: 6px;
            background: #fef2f2; color: #b91c1c; font-size: 14px; text-align: center;
        }
        #ello-inline-cart-success {
            display: flex; flex-direction: column; gap: 8px; align-items: center;
            margin-top: 16px; padding: 16px;
        }
        #ello-inline-cart-success .success-check {
            font-size: 20px; color: #059669; font-weight: 600;
        }
    `;
    document.head.appendChild(style);
}

// Called from startTryOn() success path. Renders the result-stage CTA stack
// (Add-to-Cart + Try-another-photo) and the single "powered by Ello.services"
// attribution for every entry point — inline button, widget preview, and the
// floating widget. The .inline-mode-result-ready class is reused for styling
// regardless of mode so we don't fork the CSS.
function renderInlineModeResultCtas() {
    const widget = document.getElementById('virtualTryonWidget');
    if (widget) widget.classList.add('inline-mode-result-ready');

    const resultSection = document.getElementById('resultSection');
    if (!resultSection) return;

    ensureResultCtasStyles();

    // Idempotent — remove any prior CTAs before injecting.
    const existing = document.getElementById('ello-inline-result-ctas');
    if (existing) existing.remove();

    const ctas = document.createElement('div');
    ctas.id = 'ello-inline-result-ctas';

    // Try another photo only makes sense in inline-button mode — the
    // floating widget already has its own TRY ON button in the action row,
    // so a second "Try another photo" button would just be a duplicate.
    const showTryAnother = !!window.ELLO_INLINE_MODE;

    const priceLabel = derivePriceLabel();
    ctas.innerHTML = `
        <div class="ello-inline-attribution">
            powered by <a href="https://apps.shopify.com/ello" target="_blank" rel="noopener noreferrer">Ello.services</a>
        </div>
        <div class="ello-inline-btn-row">
            <button class="ello-inline-btn ello-inline-btn-primary" id="ello-inline-add-to-cart-btn">
                Add to Cart${priceLabel}
            </button>
            ${showTryAnother ? `
            <button class="ello-inline-btn ello-inline-btn-secondary" id="ello-inline-try-another-btn">
                Try another photo
            </button>` : ''}
        </div>
        <div id="ello-inline-cart-error" style="display:none;"></div>
    `;
    resultSection.appendChild(ctas);

    document.getElementById('ello-inline-add-to-cart-btn').addEventListener('click', addToCartFromTryOn);
    const tryAnotherBtn = document.getElementById('ello-inline-try-another-btn');
    if (tryAnotherBtn) {
        tryAnotherBtn.addEventListener('click', function () {
            // Reset to upload-photo state without closing the popup
            const photoInput = document.getElementById('photoInput');
            if (photoInput) photoInput.value = '';
            if (typeof resetPhotoUploadArea === 'function') resetPhotoUploadArea();
            const rs = document.getElementById('resultSection');
            if (rs) rs.style.display = 'none';
            const w = document.getElementById('virtualTryonWidget');
            if (w) w.classList.remove('inline-mode-result-ready');
            ctas.remove();
        });
    }
}

function derivePriceLabel() {
    try {
        const meta = window.ShopifyAnalytics && window.ShopifyAnalytics.meta;
        const variantId = window.ELLO_INLINE_CTX && window.ELLO_INLINE_CTX.variantId;
        if (meta && Array.isArray(meta.product?.variants) && variantId) {
            const vid = String(variantId).replace(/^gid:\/\/shopify\/ProductVariant\//, '');
            const v = meta.product.variants.find(x => String(x.id) === vid);
            if (v && typeof v.price === 'number') {
                const dollars = (v.price / 100).toFixed(2);
                const currency = meta.currency || '$';
                const symbol = currency === 'USD' ? '$' : (currency + ' ');
                return ` — ${symbol}${dollars}`;
            }
        }
        // Widget / preview fallback: pull from the currently selected garment.
        const garment = window.elloSelectedGarment;
        if (garment && garment.price != null) {
            const raw = typeof garment.price === 'number' ? garment.price : parseFloat(garment.price);
            if (!isNaN(raw)) {
                return ` — $${raw.toFixed(2)}`;
            }
        }
    } catch (e) { /* fall through to no-label */ }
    return '';
}

// Add-to-Cart: handles single-variant directly, multi-variant via the existing
// showSizeSelector picker. Calls Shopify's standard /cart/add.js endpoint —
// works on every Shopify theme.
async function addToCartFromTryOn() {
    const btn = document.getElementById('ello-inline-add-to-cart-btn');
    const errEl = document.getElementById('ello-inline-cart-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

    try {
        if (btn) { btn.disabled = true; btn.textContent = 'Adding...'; }

        let variantId = window.ELLO_INLINE_CTX && window.ELLO_INLINE_CTX.variantId;

        // Multi-variant: prompt with size picker. Single-variant: use as-is.
        // window.elloSelectedGarment is populated by populateFeaturedAndQuickPicks
        // during openWidget — it has the variants[] array we need.
        const garment = window.elloSelectedGarment;
        if (garment && Array.isArray(garment.variants) && garment.variants.length > 1) {
            // Don't carry over the PDP-selected variant — let the shopper pick freshly.
            window.ELLO_PRESELECTED_VARIANT_ID = null;
            variantId = await showSizeSelector(garment);
        } else if (!variantId && garment) {
            // Widget / preview path: no inline context, so fall back to the
            // garment's selected (single) variant.
            variantId = garment.selectedVariantId
                || (garment.variants && garment.variants[0] && (garment.variants[0].shopify_variant_gid || garment.variants[0].id))
                || null;
        }

        if (!variantId) {
            throw new Error('No variant selected');
        }

        // Normalize: strip GID prefix if present — /cart/add.js wants the number.
        const numericId = String(variantId).replace(/^gid:\/\/shopify\/ProductVariant\//, '');

        const res = await fetch('/cart/add.js', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ id: numericId, quantity: 1 })
        });

        if (!res.ok) {
            // 422 = item not available (sold out, etc.). Shopify returns
            // { description: "...", message: "..." } with a human message.
            const errBody = await res.json().catch(() => ({}));
            const msg = errBody.description || errBody.message || `Couldn't add to cart (HTTP ${res.status})`;
            throw new Error(msg);
        }

        // Track the successful add-to-cart attribution.
        try {
            trackEvent && trackEvent('inline_add_to_cart', {
                variant_id: numericId,
                product_id: window.ELLO_INLINE_CTX && window.ELLO_INLINE_CTX.productId
            });
        } catch (e) { /* analytics is non-critical */ }

        showCartSuccessState();
    } catch (err) {
        console.error('[Ello] Add to cart failed:', err);
        if (errEl) {
            errEl.textContent = err.message || "Sorry, something went wrong adding this to your cart.";
            errEl.style.display = 'block';
        }
        if (btn) { btn.disabled = false; btn.textContent = `Add to Cart${derivePriceLabel()}`; }
    }
}

// Replaces the Add-to-Cart CTAs with the post-purchase success state:
// ✓ message + Continue shopping (close popup) + View cart (navigate).
function showCartSuccessState() {
    const widget = document.getElementById('virtualTryonWidget');
    if (widget) widget.classList.add('inline-mode-cart-success');

    const ctas = document.getElementById('ello-inline-result-ctas');
    if (ctas) ctas.remove();

    const resultSection = document.getElementById('resultSection');
    if (!resultSection) return;

    const success = document.createElement('div');
    success.id = 'ello-inline-cart-success';
    success.innerHTML = `
        <div class="success-check">✓ Added to cart</div>
        <button class="ello-inline-btn ello-inline-btn-secondary" id="ello-inline-continue-btn"
                style="box-sizing:border-box;width:100%;padding:14px 20px;border:1px solid #d1d5db;border-radius:6px;background:transparent;color:#000;font:inherit;font-weight:600;font-size:15px;cursor:pointer;">
            Continue shopping
        </button>
        <button class="ello-inline-btn ello-inline-btn-primary" id="ello-inline-view-cart-btn"
                style="box-sizing:border-box;width:100%;padding:14px 20px;border:none;border-radius:6px;background:#000;color:#fff;font:inherit;font-weight:600;font-size:15px;cursor:pointer;">
            View cart
        </button>
    `;
    resultSection.appendChild(success);

    document.getElementById('ello-inline-continue-btn').addEventListener('click', function () {
        closeWidget();
    });
    document.getElementById('ello-inline-view-cart-btn').addEventListener('click', function () {
        // Use top-level location so we escape any embedded iframe context.
        try { window.top.location.href = '/cart'; }
        catch (e) { window.location.href = '/cart'; }
    });
}

window.startTryOn = async function startTryOn() {
    // Prevent duplicate calls if already processing (check and set atomically)
    if (isTryOnProcessing) {
        return;
    }
    // Set flag immediately to prevent race conditions from rapid clicks
    isTryOnProcessing = true;
    markMeaningfulAction(); // Start of try-on is a meaningful action

    // Double-Lock: Ensure we don't track twice in rapid succession (1.5s debounce)
    const now = Date.now();
    if (window._lastTryOnTimestamp && (now - window._lastTryOnTimestamp < 1500)) {
        console.warn("⚠️ TryOn ignored: Duplicate click detected within 1.5s");
        isTryOnProcessing = false;
        return;
    }
    window._lastTryOnTimestamp = now;
    updateTryOnButton();

    // Show loading bar
    showLoadingBar(true);

    // Scroll to show the loading bar immediately
    scrollToLoadingBar();

    clearError?.();
    // Clear rate limit state when starting new try-on (in case limit was reset)
    isRateLimited = false;

    const personImageUrl = window.elloUserImageUrl;
    const tryOnPhotoValidationId = activePhotoValidationId;
    const garment = window.elloSelectedGarment;
    const productImageUrl = garment?.image_url;

    if (!personImageUrl) {
        // Trigger upload prompt instead of error
        isTryOnProcessing = false;
        updateTryOnButton();
        showLoadingBar(false);
        const uploadInput = document.getElementById('photoInput');
        if (uploadInput) {
            // Route through the best-practices/consent modal so the user can't reach
            // the file picker via this path without seeing the ToS/Privacy disclosure.
            const triggerFilePicker = () => uploadInput.click();
            if (checkShouldShowBestPractices()) {
                pendingPhotoAction = triggerFilePicker;
                showBestPracticesModal();
            } else {
                triggerFilePicker();
            }
        } else {
            showError("Please upload a photo first.");
        }
        return;
    }
    if (activePhotoValidationStatus === 'invalid') {
        isTryOnProcessing = false;
        updateTryOnButton();
        showLoadingBar(false);
        showError(PHOTO_BODY_REJECTION_MESSAGE);
        return;
    }
    if (!productImageUrl) {
        isTryOnProcessing = false;
        updateTryOnButton();
        showLoadingBar(false);
        showError("Please select a garment first.");
        return;
    }

    // Keep resultSection hidden until image is ready (no blank space)
    const resultSection = document.getElementById("resultSection");
    if (resultSection) {
        resultSection.style.display = "none"; // Keep hidden until image is ready
        // Hide result panel if it exists
        const resultPanel = document.getElementById("ello-tryon-result");
        if (resultPanel) {
            resultPanel.style.display = "none";
        }
        // Hide error if visible
        const errorEl = document.getElementById("ello-tryon-error");
        if (errorEl) {
            errorEl.style.display = "none";
        }
    }

    // Don't show the inline loader text - we have the premium loading bar instead
    // showLoader(true);

    try {
        // Proceed with try-on - backend will check overage blocking via record_tryon_event
        const imageB64 = await callElloTryOn(personImageUrl, productImageUrl);

        if (tryOnPhotoValidationId && tryOnPhotoValidationId === lastRejectedPhotoValidationId) {
            throw new Error("PHOTO_VALIDATION_FAILED");
        }

        if (personImageUrl !== window.elloUserImageUrl) {
            throw new Error("PHOTO_CHANGED_DURING_TRYON");
        }

        if (activePhotoValidationStatus === 'invalid') {
            throw new Error("PHOTO_VALIDATION_FAILED");
        }

        // Usage is already recorded by the server /tryon proxy before the ML call.
        // Do not fire a second client-side success RPC here or usage will double-count.

        // Complete and hide loading bar
        completeLoadingBar();
        showLoadingBar(false);

        // Hide loader (not needed since we use the premium loading bar)
        showLoader(false);

        // Now show the resultSection and prepare to display the image
        if (resultSection) {
            resultSection.style.display = "block";
        }

        // Inline mode: swap the default action row for Add-to-Cart + Try-another.
        // Safe to call even if the surface isn't inline — the function no-ops
        // when ELLO_INLINE_MODE is false.
        renderInlineModeResultCtas();

        // Try to find elements
        let resultImg = document.getElementById("ello-tryon-result-image");
        let resultPanel = document.getElementById("ello-tryon-result");

        // If result panel doesn't exist, create it
        if (!resultPanel && resultSection) {
            resultPanel = document.createElement("div");
            resultPanel.id = "ello-tryon-result";
            resultPanel.className = "tryon-result-container";
            resultPanel.style.display = "none";
            resultSection.appendChild(resultPanel);
        }

        // If result image doesn't exist, create it
        if (!resultImg && resultPanel) {
            resultImg = document.createElement("img");
            resultImg.id = "ello-tryon-result-image";
            resultImg.className = "tryon-result-image";
            resultImg.alt = "Try-on result";
            resultPanel.appendChild(resultImg);
        }

        // Set the image source and show the result
        if (resultImg) {
            // Start with image hidden for fade-in effect
            resultImg.style.opacity = "0";
            resultImg.style.transform = "translateY(20px)";

            resultImg.src = imageB64;

            // Wait for image to load, then animate and scroll
            resultImg.onload = function () {
                // Trigger fade-in animation with smoother timing
                requestAnimationFrame(() => {
                    resultImg.style.transition = "opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1), transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)";
                    resultImg.style.opacity = "1";
                    resultImg.style.transform = "translateY(0)";
                });

                // Auto-scroll to result once image is loaded
                setTimeout(() => {
                    smoothScrollToResult(resultSection);
                }, 200);
            };
        }

        // Show the result panel
        if (resultPanel) {
            resultPanel.style.display = "flex";
        }

        // Result-stage Add-to-Cart + attribution are owned by
        // renderInlineModeResultCtas() above for every entry point (inline
        // button, widget preview, floating widget). Any lingering legacy
        // markup (e.g. from a previous successful try-on on an older bundle)
        // is purged here so we never render two buttons or two attributions.
        if (resultPanel) {
            const legacyBuyBtn = resultPanel.querySelector('.buy-now-container');
            if (legacyBuyBtn) legacyBuyBtn.remove();
            const legacyAttribution = resultPanel.querySelector('.tryon-attribution');
            if (legacyAttribution) legacyAttribution.remove();
        }

        // Auto-save to wardrobe after successful try-on
        if (garment && imageB64 && activePhotoValidationStatus !== 'pending') {
            const tryOnId = 'tryon_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            // Call async function properly
            autoSaveToWardrobe(garment, imageB64, tryOnId).catch(err => {
                console.error('Error auto-saving to wardrobe:', err);
            });
        }

        if (typeof openTryOnResult === "function") {
            openTryOnResult();
        }

        if (window._previewTryOnProcessing) {
            trackPreviewEvent('tryon_completed');
        }

    } catch (err) {
        if (window._previewTryOnProcessing) {
            trackPreviewEvent('tryon_failed', { reason: err?.message || 'unknown' });
        }
        // NOTE: Do NOT record try-on events client-side. The server /tryon proxy
        // is the single source of truth for billing via checkAndRecordUsage().
        // Failed renders are implicitly not recorded (server only records on request-in).

        // Free-plan monthly limit reached — show upgrade message, keep widget mounted
        if (err.message === "MONTHLY_LIMIT_REACHED") {
            showFreeLimitReached();
            return;
        }

        // Handle overage blocking
        if (err.message === "OVERAGE_BLOCKED") {
            // Show resultSection so error message is visible
            const resultSection = document.getElementById("resultSection");
            if (resultSection) {
                resultSection.style.display = "block";
            }
            showError("Virtual try-ons are temporarily unavailable. Please check back later!");
            return;
        }

        if (err.message === "PHOTO_VALIDATION_FAILED") {
            showError(PHOTO_BODY_REJECTION_MESSAGE);
            return;
        }

        if (err.message === "PHOTO_CHANGED_DURING_TRYON") {
            showError("Your photo changed. Please try on again.");
            return;
        }

        // Don't show generic error if it's a rate limit error (already handled)
        if (err.message !== "RATE_LIMIT_EXCEEDED") {
            showError("Something went wrong generating your try-on. Please try again.");
        }
        // Rate limit errors are already handled by handleRateLimitError()
    } finally {
        // Hide loader (not needed since we use the premium loading bar)
        showLoader(false);
        // Hide loading bar if still showing
        showLoadingBar(false);
        // Reset processing state and update button
        isTryOnProcessing = false;
        updateTryOnButton();
    }
}

// Retry try-on function for error handling
function retryTryOn() {
    elloLog('Retrying try-on request...');
    startTryOn();
}

// Wire Try On button event listener - retry until widget is injected
(function initElloTryOnButton() {
    let isWired = false; // Prevent multiple initializations

    function wireButton() {
        try {
            // If already wired, don't wire again
            if (isWired) {
                return;
            }

            const btn = document.getElementById("tryOnBtn");
            if (!btn) {
                // Widget not injected yet, retry after a short delay
                setTimeout(wireButton, 100);
                return;
            }

            // Mark as wired to prevent duplicate initializations
            isWired = true;

            // Remove any existing listeners to avoid duplicates
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
            // Add the event listener
            newBtn.addEventListener("click", () => {
                startTryOn();
            });
        } catch (err) {
            console.error("Ello: failed to init Try On button", err);
            isWired = false; // Reset on error so it can retry
        }
    }
    wireButton();
})();

// Improved Size Selector Function
function showSizeSelector(clothing) {
    return new Promise((resolve) => {
        elloLog('showSizeSelector called with:', clothing);

        // Inline-button shortcut: if the shopper already picked a size on the
        // PDP (and the inline block pushed it through window.Ello.openTryOn),
        // skip the picker and resolve to that variant directly. Matched loosely
        // because Shopify variant IDs may be returned as number or string and
        // may or may not be GID-prefixed depending on the theme.
        const preselected = window.ELLO_PRESELECTED_VARIANT_ID;
        if (preselected && Array.isArray(clothing.variants)) {
            const target = String(preselected).replace(/^gid:\/\/shopify\/ProductVariant\//, '');
            const match = clothing.variants.find((v) => {
                const candidates = [v.id, v.shopify_variant_id, v.shopify_variant_gid];
                return candidates.some((c) => {
                    if (c == null) return false;
                    const stripped = String(c).replace(/^gid:\/\/shopify\/ProductVariant\//, '');
                    return stripped === target;
                });
            });
            // Single-use — clear regardless of match so a later try-on (e.g.,
            // via floating bubble) shows the picker normally.
            window.ELLO_PRESELECTED_VARIANT_ID = null;
            if (match && match.available !== false) {
                elloLog('[Ello VTO] showSizeSelector: preselected variant matched, skipping picker', match.id);
                resolve(match.id);
                return;
            }
        }

        // Get unique sizes from variants - try multiple methods
        const availableSizes = [];

        clothing.variants.forEach(variant => {
            elloLog('Processing variant:', variant);

            let sizeValue = null;

            // Method 1: Check option1 (usually size)
            if (variant.option1 && variant.option1 !== 'Default Title') {
                sizeValue = variant.option1;
            }
            // Method 2: Check size field
            else if (variant.size && variant.size !== 'Default Title') {
                sizeValue = variant.size;
            }
            // Method 3: Check variant title
            else if (variant.title && variant.title !== 'Default Title') {
                sizeValue = variant.title;
            }
            // Method 4: Extract size from title if it contains known sizes
            else if (variant.title) {
                const knownSizes = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
                const foundSize = knownSizes.find(size =>
                    variant.title.toUpperCase().includes(size)
                );
                if (foundSize) {
                    sizeValue = foundSize;
                }
            }

            elloLog('Extracted size value:', sizeValue);

            if (sizeValue && variant.available && !availableSizes.some(s => s.size === sizeValue)) {
                availableSizes.push({
                    size: sizeValue,
                    variantId: variant.id,
                    price: variant.price
                });
            }
        });

        elloLog('Available sizes found:', availableSizes);

        // If no sizes found, just use first available variant
        if (availableSizes.length === 0) {
            elloLog('No sizes detected, using first available variant');
            const firstAvailable = clothing.variants.find(v => v.available) || clothing.variants[0];
            if (firstAvailable) {
                resolve(firstAvailable.id);
                return;
            }
        }

        // If only one size, use it directly
        if (availableSizes.length === 1) {
            elloLog('Only one size available, using directly');
            resolve(availableSizes[0].variantId);
            return;
        }

        // Create popup HTML (rest of your existing popup code...)
        const popup = document.createElement('div');
        popup.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    height: 100dvh;
    background: rgba(0,0,0,0.6);
    z-index: 30000;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(4px);
`;

        popup.innerHTML = `
    <div style="
        background: white;
        padding: 24px;
        border-radius: 8px;
        max-width: 350px;
        width: 90%;
        box-shadow: 0 25px 80px rgba(0,0,0,0.2);
        border: 1px solid #e0e0e0;
    ">
        <div style="text-align: center; margin-bottom: 20px;">
            <h3 style="
                margin: 0 0 8px 0;
                font-size: 18px;
                font-weight: 700;
                color: #333;
                text-transform: uppercase;
                letter-spacing: 1px;
            ">Select Size</h3>
            <p style="
                margin: 0;
                color: #666;
                font-size: 14px;
            ">${clothing.name}</p>
        </div>
        
        <div class="size-grid" style="
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 8px;
            margin-bottom: 20px;
        ">
            ${availableSizes.map(sizeOption => `
                <button class="size-btn" data-variant-id="${sizeOption.variantId}" style="
                    padding: 12px 8px;
                    border: 1px solid #e0e0e0;
                    background: #f8f8f8;
                    cursor: pointer;
                    border-radius: 6px;
                    font-weight: 600;
                    font-size: 14px;
                    color: #333;
                    transition: all 0.3s ease;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                ">
                    ${sizeOption.size}
                </button>
            `).join('')}
        </div>
        
        <div style="display: flex; gap: 12px;">
            <button id="cancelSize" style="
                flex: 1;
                padding: 12px;
                background: #f0f0f0;
                border: 1px solid #e0e0e0;
                border-radius: 6px;
                cursor: pointer;
                font-weight: 600;
                color: #666;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                font-size: 13px;
            ">Cancel</button>
            <button id="confirmSize" style="
                flex: 1;
                padding: 12px;
                background: #333;
                color: white;
                border: 1px solid #333;
                border-radius: 6px;
                cursor: pointer;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                font-size: 13px;
                opacity: 0.5;
            " disabled>Add to Cart</button>
        </div>
    </div>
`;

        document.body.appendChild(popup);

        let selectedVariantId = null;

        // Handle size selection
        popup.querySelectorAll('.size-btn').forEach(btn => {
            btn.onclick = () => {
                // Reset all buttons
                popup.querySelectorAll('.size-btn').forEach(b => {
                    b.style.background = '#f8f8f8';
                    b.style.color = '#333';
                    b.style.borderColor = '#e0e0e0';
                });

                // Highlight selected button
                btn.style.background = '#333';
                btn.style.color = 'white';
                btn.style.borderColor = '#333';

                selectedVariantId = btn.dataset.variantId;

                // Enable confirm button
                const confirmBtn = popup.querySelector('#confirmSize');
                confirmBtn.disabled = false;
                confirmBtn.style.opacity = '1';
            };
        });

        // Handle confirm
        popup.querySelector('#confirmSize').onclick = () => {
            document.body.removeChild(popup);
            resolve(selectedVariantId);
        };

        // Handle cancel
        popup.querySelector('#cancelSize').onclick = () => {
            document.body.removeChild(popup);
            resolve(null);
        };

        // Handle backdrop click
        popup.onclick = (e) => {
            if (e.target === popup) {
                document.body.removeChild(popup);
                resolve(null);
            }
        };
    });
}

// Custom Notification Function
function showSuccessNotification(title, subtitle, duration = 4000, isError = false) {
    // Remove any existing notification
    const existing = document.querySelector('.custom-notification');
    if (existing) {
        existing.remove();
    }

    // Create notification element
    const notification = document.createElement('div');
    notification.className = 'custom-notification' + (isError ? ' error' : '');

    notification.innerHTML = `
<div class="notification-icon">
    ${isError ? '✗' : '✓'}
</div>
<div class="notification-content">
    <div class="notification-title">${title}</div>
    <div class="notification-subtitle">${subtitle}</div>
</div>
<button class="notification-close" onclick="hideNotification(this.parentElement)">
    ×
</button>
<div class="notification-progress"></div>
`;

    document.body.appendChild(notification);

    // Trigger show animation
    setTimeout(() => {
        notification.classList.add('show');
    }, 10);

    // Auto-hide after duration
    setTimeout(() => {
        hideNotification(notification);
    }, duration);
}

function hideNotification(notification) {
    if (!notification) return;

    notification.classList.add('hide');
    notification.classList.remove('show');

    setTimeout(() => {
        if (notification.parentElement) {
            notification.parentElement.removeChild(notification);
        }
    }, 400);
}

// Function to update cart display after adding items
async function updateCartDisplay() {
    try {
        // Fetch the latest cart data
        const cartResponse = await fetch('/cart.js');
        const cartData = await cartResponse.json();

        elloLog('Updated cart data:', cartData);

        // Update cart counter (try multiple common selectors)
        const cartCounters = [
            '.cart-count',
            '.cart-counter',
            '.cart-item-count',
            '[data-cart-count]',
            '.header__cart-count',
            '.cart-link__bubble',
            '.cart__count',
            '#cart-count',
            '.cart-count-bubble'
        ];

        cartCounters.forEach(selector => {
            const counter = document.querySelector(selector);
            if (counter) {
                counter.textContent = cartData.item_count;
                counter.innerHTML = cartData.item_count;
                // Also try setting attributes
                counter.setAttribute('data-count', cartData.item_count);
            }
        });

        // Trigger cart update events that themes might listen for
        const cartUpdateEvents = [
            'cart:updated',
            'cart:refresh',
            'cart:change',
            'cartUpdated',
            'ajaxCart:updated'
        ];

        cartUpdateEvents.forEach(eventName => {
            document.dispatchEvent(new CustomEvent(eventName, {
                detail: { cart: cartData }
            }));

            // Also try on window
            window.dispatchEvent(new CustomEvent(eventName, {
                detail: { cart: cartData }
            }));
        });

        // If there's a global cart object, update it
        if (window.cart) {
            window.cart = cartData;
        }
        if (window.theme && window.theme.cart) {
            window.theme.cart = cartData;
        }

        // Force update any cart drawers/popups
        const cartDrawers = [
            '.cart-drawer',
            '.mini-cart',
            '.cart-popup',
            '[data-cart-drawer]'
        ];

        cartDrawers.forEach(selector => {
            const drawer = document.querySelector(selector);
            if (drawer && drawer.classList.contains('active')) {
                // If cart drawer is open, you might want to refresh it
                // This depends on your theme's implementation
            }
        });

        elloLog('✅ Cart display updated successfully');

    } catch (error) {
        console.error('❌ Error updating cart display:', error);
        // Don't throw error - the item was still added successfully
    }
}

async function handleBuyNow(clothingId, tryonResultUrl, tryOnId, buyBtnElement = null) {
    const buyBtn = buyBtnElement || (typeof event !== 'undefined' && event ? event.target.closest('.buy-now-btn') : null);

    // Robust finding logic: Match ID, then GID suffix, then shopify_product_id
    const clothing = sampleClothing.find(item => {
        const idStr = String(clothingId);
        // 1. Direct match (loose)
        if (item.id == clothingId) return true;
        // 2. GID match (if item.id is GID and clothingId is numeric)
        if (String(item.id).endsWith(`/${idStr}`)) return true;
        // 3. Reversed GID match
        if (idStr.endsWith(`/${item.id}`)) return true;
        // 4. Shopify Product ID match
        if (item.shopify_product_id && item.shopify_product_id == clothingId) return true;
        // 5. Handle match (fallback)
        if (item.handle && (item.handle === idStr || item.handle === idStr.toLowerCase())) return true;

        return false;
    });

    elloLog('handleBuyNow called for:', clothing);

    if (!clothing) {
        alert('Item not found. Please try again.');
        return;
    }

    // LAZY LOAD VARIANTS if missing
    if (!clothing.variants || clothing.variants.length === 0) {
        if (clothing.handle) {
            elloLog(`[Ello] Variants missing for ${clothing.handle} in BuyNow, lazy loading...`);
            try {
                const productRes = await fetch(`/products/${clothing.handle}.js`);
                if (productRes.ok) {
                    const productData = await productRes.json();
                    clothing.variants = productData.variants.map(v => ({
                        id: v.id,
                        shopify_variant_gid: `gid://shopify/ProductVariant/${v.id}`,
                        title: v.title,
                        price: (v.price / 100).toFixed(2),
                        size: v.title
                    }));
                }
            } catch (e) {
                console.error("Lazy load failed", e);
            }
        }
    }

    if (!clothing.variants || clothing.variants.length === 0) {
        alert('Product details not available (variants missing).');
        return;
    }

    buyBtn.classList.add('loading');
    buyBtn.disabled = true;

    try {
        let variantToAdd = null;

        // Size selection logic
        if (clothing.variants.length === 1) {
            variantToAdd = clothing.variants[0];
        } else {
            buyBtn.classList.remove('loading');
            buyBtn.disabled = false;

            const selectedVariantId = await showSizeSelector(clothing);
            if (!selectedVariantId) return;

            variantToAdd = clothing.variants.find(v => v.id == selectedVariantId);
            if (!variantToAdd) {
                alert('Selected size not found. Please try again.');
                return;
            }

            buyBtn.classList.add('loading');
            buyBtn.disabled = true;
        }

        let success = false;
        // Handle different data sources
        // Default to Shopify if we have variants and a handle, even if data_source is missing
        if (clothing.data_source === 'shopify' || (!clothing.data_source && clothing.handle && clothing.variants)) {
            success = await handleShopifyPurchase(clothing, variantToAdd, tryonResultUrl, tryOnId);
        } else if (clothing.data_source === 'supabase') {
            success = await handleSupabasePurchase(clothing, variantToAdd, tryonResultUrl, tryOnId);
        } else {
            // Fallback for demo data or unknown sources
            success = await handleDemoPurchase(clothing, variantToAdd, tryonResultUrl, tryOnId);
        }

        if (success) {
            buyBtn.classList.remove('loading');
            const span = buyBtn.querySelector('span');
            if (span) {
                span.textContent = '✓ Added';
            } else {
                buyBtn.textContent = '✓ Added';
            }
            // Keep it disabled!
        } else {
            buyBtn.classList.remove('loading');
            buyBtn.disabled = false;
        }

    } catch (error) {
        console.error('❌ Purchase error:', error);
        alert('❌ Purchase error: ' + error.message);
        buyBtn.classList.remove('loading');
        buyBtn.disabled = false;
    }
}

// Handle Shopify purchases
async function handleShopifyPurchase(clothing, variantToAdd, tryonResultUrl, tryOnId) {
    try {
        // Add to Shopify cart
        const cartResponse = await fetch('/cart/add.js', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                id: variantToAdd.id,
                quantity: 1
            })
        });

        if (cartResponse.ok) {
            const cartResult = await cartResponse.json();
            elloLog('✅ Successfully added to Shopify cart:', cartResult);

            // Pass session_id as a cart attribute so it flows into checkout order attributes.
            // This is a fallback for the Web Pixel's checkout_completed attribution.
            if (window.ELLO_SESSION_ID) {
                fetch('/cart/update.js', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ attributes: { ello_session_id: window.ELLO_SESSION_ID } })
                }).catch(() => {});
            }

            // Show success notification
            const sizeText = variantToAdd.size || variantToAdd.title || '';
            const sizeDisplay = sizeText ? `Size ${sizeText}` : '';
            showSuccessNotification(
                'Added to Cart!',
                `${clothing.name} ${sizeDisplay ? `• ${sizeDisplay}` : ''}`
            );

            // Update cart display
            await updateCartDisplay();

            // Send analytics tracking
            await sendAnalyticsTracking('shopify_add_to_cart', clothing, variantToAdd, tryonResultUrl, tryOnId, cartResult);

            // Track cart event (non-blocking)
            trackCartEvent(clothing, variantToAdd, 1);
            return true;

        } else {
            const errorText = await cartResponse.text();
            console.error('❌ Shopify cart error:', errorText);
            alert(`❌ Failed to add to cart. Error: ${cartResponse.status}`);
            return false;
        }
    } catch (error) {
        console.error('❌ Shopify purchase error:', error);
        throw error;
    }
}

// Handle Supabase purchases
async function handleSupabasePurchase(clothing, variantToAdd, tryonResultUrl, tryOnId) {
    try {
        // For Supabase products, we'll redirect to the product URL or show a custom purchase flow
        if (clothing.product_url && clothing.product_url !== '#') {
            // Redirect to product page
            window.open(clothing.product_url, '_blank');
            showSuccessNotification(
                'Product Page Opened',
                `${clothing.name} - Check the new tab to complete your purchase`
            );
        } else {
            // Show custom purchase modal or form
            showCustomPurchaseModal(clothing, variantToAdd);
        }

        // Track cart event (non-blocking)
        trackCartEvent(clothing, variantToAdd, 1);

        // Send analytics tracking
        await sendAnalyticsTracking('supabase_purchase_intent', clothing, variantToAdd, tryonResultUrl, tryOnId);
        return true;

    } catch (error) {
        console.error('❌ Supabase purchase error:', error);
        throw error;
    }
}

// Handle demo purchases
async function handleDemoPurchase(clothing, variantToAdd, tryonResultUrl, tryOnId) {
    try {
        // For demo products, show a message
        showSuccessNotification(
            'Demo Product',
            `${clothing.name} is a demo product. Contact us to set up real products.`
        );

        // Send analytics tracking
        await sendAnalyticsTracking('demo_purchase_intent', clothing, variantToAdd, tryonResultUrl, tryOnId);
        return true;

    } catch (error) {
        console.error('❌ Demo purchase error:', error);
        throw error;
    }
}

// Track widget open event (non-blocking)
// Redefined at top of file using trackEvent('widget_open')

// Track cart event (non-blocking)
async function trackCartEvent(clothing, variantToAdd, quantity = 1) {
    try {
        const storeSlug = window.ELLO_STORE_CONFIG?.storeSlug || window.ELLO_STORE_SLUG || window.ELLO_STORE_ID || 'default_store';
        const sessionId = window.ELLO_SESSION_ID || null;

        // Extract product ID (prefer Shopify IDs, fallback to clothing.id)
        const productId = clothing.shopify_product_gid || clothing.shopify_product_id || clothing.id;

        // Extract variant ID (prefer Shopify GID, fallback to variant.id)
        const variantId = variantToAdd.shopify_variant_gid || variantToAdd.id;

        // Call RPC function via fetch (fire and forget - don't await)
        fetch(`${SUPABASE_URL}/rest/v1/rpc/record_cart_event`, {
            method: 'POST',
            keepalive: true,
            credentials: 'omit', // Required for CORS
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                p_store_slug: storeSlug,
                p_product_id: productId,
                p_variant_id: variantId,
                p_session_id: sessionId,
                p_quantity: quantity
            })
        }).catch(err => console.warn('Cart tracking failed:', err));
    } catch (error) {
        console.warn('Cart tracking error:', error);
    }
}

// Send analytics tracking
async function sendAnalyticsTracking(conversionType, clothing, variantToAdd, tryonResultUrl, tryOnId, cartResult = null) {
    try {
        const conversionData = {
            mode: 'conversion',
            tryOnId: tryOnId,
            sessionId: sessionId,
            storeId: window.ELLO_STORE_ID || 'default_store',
            conversionType: conversionType,
            revenueAmount: variantToAdd.price,
            selectedClothing: {
                id: clothing.id,
                name: clothing.name,
                price: variantToAdd.price.toFixed(2),
                category: clothing.category,
                color: clothing.color,
                image_url: clothing.image_url,
                variant_id: variantToAdd.id,
                size: variantToAdd.size || variantToAdd.title,
                data_source: clothing.data_source
            },
            tryonResultUrl: tryonResultUrl,
            shopifyCartResult: cartResult,
            deviceInfo: {
                isMobile: isMobile,
                isTablet: isTablet,
                isIOS: isIOS,
                isAndroid: isAndroid,
                viewport: {
                    width: window.innerWidth,
                    height: window.innerHeight
                }
            },
            timestamp: new Date().toISOString()
        };

        // Send analytics webhook (don't block on this)
        fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(conversionData)
        }).then(response => {
            if (response.ok) {
                elloLog('✅ Analytics tracked successfully');
            } else {
                elloLog('⚠️ Analytics tracking failed, but purchase succeeded');
            }
        }).catch(error => {
            elloLog('⚠️ Analytics tracking error:', error);
        });

    } catch (webhookError) {
        elloLog('⚠️ Webhook tracking failed:', webhookError);
    }
}

// Show custom purchase modal for Supabase products
function showCustomPurchaseModal(clothing, variantToAdd) {
    // Create a simple modal for custom purchase flow
    const modal = document.createElement('div');
    modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    height: 100dvh;
    background: rgba(0,0,0,0.6);
    z-index: 30000;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(4px);
`;

    modal.innerHTML = `
    <div style="
        background: white;
        padding: 24px;
        border-radius: 8px;
        max-width: 400px;
        width: 90%;
        box-shadow: 0 25px 80px rgba(0,0,0,0.2);
        border: 1px solid #e0e0e0;
    ">
        <div style="text-align: center; margin-bottom: 20px;">
            <h3 style="
                margin: 0 0 8px 0;
                font-size: 18px;
                font-weight: 700;
                color: #333;
            ">Purchase ${clothing.name}</h3>
            <p style="
                margin: 0;
                color: #666;
                font-size: 14px;
            ">$${variantToAdd.price.toFixed(2)}</p>
        </div>
        
        <div style="margin-bottom: 20px;">
            <p style="color: #666; font-size: 14px; text-align: center;">
                This product is managed by your store. Please contact the store owner to complete your purchase.
            </p>
        </div>
        
        <div style="display: flex; gap: 12px;">
            <button id="closeModal" style="
                flex: 1;
                padding: 12px;
                background: #f0f0f0;
                border: 1px solid #e0e0e0;
                border-radius: 6px;
                cursor: pointer;
                font-weight: 600;
                color: #666;
            ">Close</button>
            <button id="contactStore" style="
                flex: 1;
                padding: 12px;
                background: #333;
                color: white;
                border: 1px solid #333;
                border-radius: 6px;
                cursor: pointer;
                font-weight: 600;
            ">Contact Store</button>
        </div>
    </div>
`;

    document.body.appendChild(modal);

    // Handle modal interactions
    modal.querySelector('#closeModal').onclick = () => {
        document.body.removeChild(modal);
    };

    modal.querySelector('#contactStore').onclick = () => {
        // You can customize this to open email, contact form, etc.
        window.open('mailto:contact@store.com?subject=Purchase Inquiry: ' + clothing.name, '_blank');
        document.body.removeChild(modal);
    };

    // Handle backdrop click
    modal.onclick = (e) => {
        if (e.target === modal) {
            document.body.removeChild(modal);
        }
    };
}

function openImageModal(imageSrc) {
    const modal = document.getElementById('imageModal');
    const modalImage = document.getElementById('modalImage');
    modalImage.src = imageSrc;
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeImageModal(event) {
    if (event && event.target !== event.currentTarget && !event.target.classList.contains('modal-close')) {
        return;
    }

    const modal = document.getElementById('imageModal');
    modal.classList.remove('active');
    modal.classList.remove('wardrobe-view');

    // Clean up wardrobe modal info
    const modalContent = modal.querySelector('.modal-content');
    const wardrobeInfo = modalContent.querySelector('.wardrobe-modal-info');
    if (wardrobeInfo) {
        wardrobeInfo.remove();
    }

    if (!widgetOpen || !isMobile) {
        document.body.style.overflow = '';
    } else if (isMobile && widgetOpen) {
        document.body.style.overflow = 'hidden';
    }
}

function handleOrientationChange() {
    if (isMobile) {
        setTimeout(() => {
            detectDevice();

            if (widgetOpen) {
                const widget = document.getElementById('virtualTryonWidget');
                widget.style.display = 'none';
                widget.offsetHeight;
                widget.style.display = 'flex';
            }
        }, 100);
    }
}

function preventZoom() {
    if (isMobile) {
        // Scope double-tap prevention to the widget only — never block
        // touch events on the merchant's page (hurts INP).
        const widgetEl = document.getElementById('virtualTryonWidget');
        if (!widgetEl) return;
        let lastTouchEnd = 0;
        widgetEl.addEventListener('touchend', function (event) {
            const now = Date.now();
            if (now - lastTouchEnd <= 300) {
                event.preventDefault();
            }
            lastTouchEnd = now;
        }, { passive: false });
    }
}

/**
 * Enhanced keyboard navigation
 * - Enter key: Triggers Try On button when widget is open
 * - Escape key: Closes widget, modals, and browsers
 */
document.addEventListener('keydown', function (event) {
    // Escape key - close widget, modals, and browsers
    if (event.key === 'Escape') {
        // Close image modal if open
        const imageModal = document.getElementById('imageModal');
        if (imageModal && imageModal.classList.contains('active')) {
            closeImageModal(event);
            return;
        }

        // Close wardrobe modal if open
        const wardrobeModal = document.getElementById('wardrobeModal');
        if (wardrobeModal && wardrobeModal.classList.contains('active')) {
            closeWardrobe();
            return;
        }

        // Close clothing browser if open
        const clothingBrowser = document.getElementById('clothingBrowserModal');
        if (clothingBrowser && clothingBrowser.classList.contains('active')) {
            closeClothingBrowser();
            return;
        }

        // Close main widget if open
        if (widgetOpen) {
            closeWidget();
            return;
        }
    }

    // Enter key - trigger Try On button when widget is open (but not when typing in message input)
    if (event.key === 'Enter' && widgetOpen) {
        const activeElement = document.activeElement;
        const messageInput = document.getElementById('messageInput');
        const tryOnBtn = document.getElementById('tryOnBtn');

        // Don't trigger Try On if user is typing in message input
        if (activeElement === messageInput) {
            return; // Let the message input handle Enter key
        }
        // Only trigger if Try On button is enabled
        if (tryOnBtn && !tryOnBtn.disabled) {
            event.preventDefault();
            startTryOn();
        } else {
            // Prevent Enter from doing anything else if Try On is disabled or processing
            event.preventDefault();
            return;
        }
    }
});

if (isMobile) {
    window.addEventListener('popstate', function (event) {
        if (widgetOpen) {
            closeWidget();
            event.preventDefault();
        }
    });
}

// THEME: Apply white theme (simplified - no color detection)
function applyWidgetThemeColors() {
    const widget = document.getElementById('virtualTryonWidget');
    if (!widget) {
        console.warn('⚠️ Widget element not found for theme color application');
        return;
    }

    // Just ensure white theme is applied
    widget.classList.remove('theme-cream', 'theme-black');
    widget.classList.add('theme-white');

    // Remove data-theme attribute if it exists
    widget.removeAttribute('data-theme');
}

/**
 * Apply minimized widget color from store configuration
 * Reads the minimized_color from window.ELLO_STORE_CONFIG and applies it
 * Falls back to default gradient if color is not set
 */
function applyMinimizedWidgetColor() {
    const widget = document.getElementById('virtualTryonWidget');
    if (!widget) {
        console.warn('⚠️ Widget element not found for color application');
        return;
    }

    // Get color from store configuration
    const storeConfig = window.ELLO_STORE_CONFIG;
    let minimizedColor = null;


    if (storeConfig && storeConfig.minimizedColor) {
        minimizedColor = storeConfig.minimizedColor.trim();

        // Validate hex color format
        const hexColorRegex = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
        if (!hexColorRegex.test(minimizedColor)) {
            console.warn('❌ Invalid hex color format:', minimizedColor);
            minimizedColor = null;
        } else {
        }
    } else {
        elloLog('ℹ️ No minimized color found in store config. storeConfig:', storeConfig);
        if (!storeConfig) {
            elloLog('⚠️ Store config not loaded yet. Color will use default.');
        }
    }

    // Apply color if valid, otherwise use default gradient
    if (minimizedColor) {
        // Convert hex to RGB for better gradient effect
        let hex = minimizedColor.replace('#', '');

        // Handle 3-character hex codes (e.g., #FFF -> #FFFFFF)
        if (hex.length === 3) {
            hex = hex.split('').map(char => char + char).join('');
        }

        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);


        // Create a subtle gradient from the base color
        const lighterR = Math.min(255, r + 30);
        const lighterG = Math.min(255, g + 30);
        const lighterB = Math.min(255, b + 30);
        const darkerR = Math.max(0, r - 20);
        const darkerG = Math.max(0, g - 20);
        const darkerB = Math.max(0, b - 20);

        const gradient = `linear-gradient(135deg, rgb(${darkerR}, ${darkerG}, ${darkerB}) 0%, rgb(${r}, ${g}, ${b}) 50%, rgb(${lighterR}, ${lighterG}, ${lighterB}) 100%)`;

        // Store the gradient in a data attribute for when widget is minimized
        widget.setAttribute('data-minimized-gradient', gradient);

        // Apply as inline style (will override CSS when minimized)
        widget.style.setProperty('--minimized-bg', minimizedColor);

        // Always apply to minimized state (CSS handles visibility)
        const isMinimized = widget.classList.contains('widget-minimized');
        if (isMinimized) {
            widget.style.background = gradient;
        } else {
            elloLog('ℹ️ Widget not minimized yet, gradient will apply when minimized');
        }

        // Determine text color based on brightness for contrast
        const brightness = (r * 299 + g * 587 + b * 114) / 1000;
        const textColor = brightness > 128 ? '#333' : '#fff';
        const textShadow = brightness > 128
            ? '0 2px 4px rgba(255,255,255,0.8)'
            : '0 2px 4px rgba(0,0,0,0.8)';

        // Update text color and shadow via CSS variables
        widget.style.setProperty('--minimized-text-color', textColor);
        widget.style.setProperty('--minimized-text-shadow', textShadow);

    } else {
        // Remove inline styles to use default CSS gradient
        widget.style.removeProperty('--minimized-bg');
        widget.style.removeProperty('--minimized-text-color');
        widget.style.removeProperty('--minimized-text-shadow');
        widget.removeAttribute('data-minimized-gradient');

        const isMinimized = widget.classList.contains('widget-minimized');
        if (isMinimized) {
            widget.style.background = '';
        }
    }
}

/**
 * Apply widget corner position (left or right) from store configuration.
 * Inline styles override the CSS rules in widget-template.html (which hard-code
 * `right: 20px; left: auto`) including their media-query variants because
 * inline styles win against rules of equal specificity from a stylesheet.
 */
function applyWidgetPosition() {
    const widget = document.getElementById('virtualTryonWidget');
    if (!widget) return;

    const position = window.ELLO_STORE_CONFIG?.widgetPosition === 'left' ? 'left' : 'right';

    if (position === 'left') {
        widget.style.setProperty('left', '20px', 'important');
        widget.style.setProperty('right', 'auto', 'important');
        widget.style.setProperty('transform-origin', 'left bottom', 'important');
    } else {
        widget.style.setProperty('right', '20px', 'important');
        widget.style.setProperty('left', 'auto', 'important');
        widget.style.setProperty('transform-origin', 'right bottom', 'important');
    }
}

// ============================================================================
// WARDROBE FUNCTIONALITY
// ============================================================================

// Wardrobe storage key
const WARDROBE_STORAGE_KEY = 'virtual_tryon_wardrobe';

// Get wardrobe count for display
function getWardrobeCount() {
    const wardrobe = getWardrobe();
    return wardrobe.length;
}

// Get wardrobe from localStorage (must persist across navigation/tab suspension,
// same as USER_PHOTO_STORAGE_KEY — sessionStorage gets wiped on mobile and
// strands the "Your Photo" tile + results even though the photo itself survives).
function getWardrobe() {
    try {
        const legacy = sessionStorage.getItem(WARDROBE_STORAGE_KEY);
        if (legacy && !localStorage.getItem(WARDROBE_STORAGE_KEY)) {
            localStorage.setItem(WARDROBE_STORAGE_KEY, legacy);
            sessionStorage.removeItem(WARDROBE_STORAGE_KEY);
        }
        const stored = localStorage.getItem(WARDROBE_STORAGE_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch (error) {
        console.error('Error reading wardrobe from localStorage:', error);
        return [];
    }
}

// Debounce timer for wardrobe saves to avoid blocking
let wardrobeSaveTimer = null;

// Save wardrobe to sessionStorage with size management (non-blocking)
async function saveWardrobe(wardrobe) {
    return new Promise((resolve) => {
        // Clear any pending save
        if (wardrobeSaveTimer) {
            clearTimeout(wardrobeSaveTimer);
        }

        // Defer save to next event loop to avoid blocking main thread
        wardrobeSaveTimer = setTimeout(async () => {
            try {
                // Compress any large base64 images that weren't already compressed
                const cleanedWardrobe = await Promise.all(wardrobe.map(async (item) => {
                    const cleaned = { ...item };
                    // Remove original photo URL - not needed in wardrobe
                    if (cleaned.originalPhotoUrl && cleaned.originalPhotoUrl.startsWith('data:')) {
                        delete cleaned.originalPhotoUrl;
                    }
                    // Compress result image if it's still too large (over 150KB for better performance)
                    if (cleaned.resultImageUrl && cleaned.resultImageUrl.startsWith('data:') && cleaned.resultImageUrl.length > 150000) {
                        try {
                            cleaned.resultImageUrl = await compressImage(cleaned.resultImageUrl, 350, 0.55);
                            elloLog('✅ Further compressed result image:', Math.round(cleaned.resultImageUrl.length / 1024) + 'KB');
                        } catch (error) {
                            console.warn('Failed to compress result image:', error);
                        }
                    }
                    // Remove base64 clothing images - we have the URL
                    if (cleaned.clothingImageUrl && cleaned.clothingImageUrl.startsWith('data:')) {
                        delete cleaned.clothingImageUrl;
                    }
                    return cleaned;
                }));

                // Sort by timestamp (newest first) before limiting
                cleanedWardrobe.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

                // Limit wardrobe to 8 items max (reduced for better performance)
                const limitedWardrobe = cleanedWardrobe.slice(0, 8);

                const wardrobeString = JSON.stringify(limitedWardrobe);

                // Check size before saving - use 1.5MB limit for better performance
                if (wardrobeString.length > 1500000) { // 1.5MB limit
                    console.warn('Wardrobe too large, removing oldest items...');
                    // Remove oldest items until under limit
                    let trimmed = [...limitedWardrobe];
                    while (JSON.stringify(trimmed).length > 1500000 && trimmed.length > 0) {
                        trimmed.pop(); // Remove oldest (last in sorted array)
                    }
                    // Use requestIdleCallback if available for non-blocking write
                    const saveToStorage = () => {
                        try {
                            localStorage.setItem(WARDROBE_STORAGE_KEY, JSON.stringify(trimmed));
                            elloLog('✅ Saved wardrobe (trimmed to', trimmed.length, 'items)');
                            resolve();
                        } catch (e) {
                            console.error('Error saving trimmed wardrobe:', e);
                            resolve();
                        }
                    };
                    if (window.requestIdleCallback) {
                        requestIdleCallback(saveToStorage, { timeout: 1000 });
                    } else {
                        setTimeout(saveToStorage, 0);
                    }
                } else {
                    // Use requestIdleCallback if available for non-blocking write
                    const saveToStorage = () => {
                        try {
                            localStorage.setItem(WARDROBE_STORAGE_KEY, wardrobeString);
                            elloLog('✅ Saved wardrobe (' + limitedWardrobe.length + ' items, ' + Math.round(wardrobeString.length / 1024) + 'KB)');
                            resolve();
                        } catch (e) {
                            console.error('Error saving wardrobe:', e);
                            resolve();
                        }
                    };
                    if (window.requestIdleCallback) {
                        requestIdleCallback(saveToStorage, { timeout: 1000 });
                    } else {
                        setTimeout(saveToStorage, 0);
                    }
                }
            } catch (error) {
                console.error('Error saving wardrobe to sessionStorage:', error);
                if (error.name === 'QuotaExceededError') {
                    console.warn('Wardrobe quota exceeded, cleaning up...');
                    // Remove oldest items - keep only last 5
                    const sortedWardrobe = [...wardrobe].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
                    const cleaned = sortedWardrobe.slice(0, 5); // Keep only last 5
                    try {
                        // Compress images more aggressively for emergency cleanup
                        const ultraCleaned = await Promise.all(cleaned.map(async (item) => {
                            const ultra = { ...item };
                            if (ultra.resultImageUrl && ultra.resultImageUrl.startsWith('data:')) {
                                try {
                                    ultra.resultImageUrl = await compressImage(ultra.resultImageUrl, 300, 0.5);
                                } catch (e) {
                                    // If compression fails, remove image
                                    ultra.resultImageUrl = 'data:image/placeholder;base64,removed';
                                }
                            }
                            delete ultra.originalPhotoUrl;
                            delete ultra.clothingImageUrl;
                            return ultra;
                        }));
                        const saveToStorage = () => {
                            try {
                                localStorage.setItem(WARDROBE_STORAGE_KEY, JSON.stringify(ultraCleaned));
                                elloLog('✅ Saved wardrobe after cleanup (5 items, heavily compressed)');
                            } catch (e) {
                                console.warn('Still exceeded quota. Wardrobe not saved.');
                            }
                            resolve();
                        };
                        if (window.requestIdleCallback) {
                            requestIdleCallback(saveToStorage, { timeout: 1000 });
                        } else {
                            setTimeout(saveToStorage, 0);
                        }
                    } catch (retryError) {
                        console.warn('Still exceeded quota. Wardrobe not saved.');
                        resolve();
                    }
                } else {
                    resolve();
                }
            }
        }, 100); // 100ms debounce - batches rapid saves
    });
}

// Add item to wardrobe
async function addToWardrobe(clothing, resultImageUrl, tryOnId) {
    const wardrobe = getWardrobe();

    // Check if item already exists (by clothing ID)
    const existingIndex = wardrobe.findIndex(item => item.clothingId === clothing.id);

    // Compress the result image before storing (400px width, 0.6 quality for good balance)
    let compressedResultImage = resultImageUrl;
    if (resultImageUrl && resultImageUrl.startsWith('data:')) {
        try {
            compressedResultImage = await compressImage(resultImageUrl, 400, 0.6);
            elloLog('✅ Compressed result image for wardrobe:', Math.round(compressedResultImage.length / 1024) + 'KB');
        } catch (error) {
            console.warn('Failed to compress image, using original:', error);
        }
    }

    // Compress the original user photo for outfit building (needed for backend API)
    // Store at lower quality since it's just for try-on, not display
    let compressedOriginalPhoto = null;
    if (userPhoto && userPhoto.startsWith('data:')) {
        try {
            // Compress original photo more aggressively (500px width, 0.7 quality) for outfit building
            compressedOriginalPhoto = await compressImage(userPhoto, 500, 0.7);
            elloLog('✅ Compressed original photo for outfit building:', Math.round(compressedOriginalPhoto.length / 1024) + 'KB');
        } catch (error) {
            console.warn('Failed to compress original photo, using original:', error);
            compressedOriginalPhoto = userPhoto;
        }
    } else if (userPhoto) {
        compressedOriginalPhoto = userPhoto;
    }

    const wardrobeItem = {
        id: tryOnId,
        clothingId: clothing.id,
        clothingName: clothing.name,
        clothingPrice: clothing.price,
        clothingCategory: clothing.category,
        clothingColor: clothing.color,
        clothingImageUrl: clothing.image_url, // This should be a URL, not base64
        resultImageUrl: compressedResultImage, // Compressed result image
        originalPhotoUrl: compressedOriginalPhoto, // Store original user photo (compressed) for outfit building
        timestamp: new Date().toISOString(),
        sessionId: sessionId
    };

    if (existingIndex !== -1) {
        // Update existing item
        wardrobe[existingIndex] = wardrobeItem;
    } else {
        // Add new item
        wardrobe.push(wardrobeItem);
    }

    await saveWardrobe(wardrobe);
    updateWardrobeButton();

    elloLog('✅ Added to wardrobe:', clothing.name);
}

// Add original photo to wardrobe (for outfit building)
async function addOriginalPhotoToWardrobe() {
    if (!userPhoto) return;

    const wardrobe = getWardrobe();
    const originalPhotoId = 'original_photo_' + Date.now();

    // Check if original photo already exists
    const existingOriginal = wardrobe.find(item => item.id.startsWith('original_photo_'));

    if (!existingOriginal) {
        const originalPhotoItem = {
            id: originalPhotoId,
            clothingId: 'original_photo',
            clothingName: 'Your Photo',
            clothingPrice: 0,
            clothingCategory: 'photo',
            clothingColor: 'original',
            // Don't store full base64 - reference that it's in localStorage instead
            clothingImageUrl: 'stored_in_localStorage', // Reference only
            resultImageUrl: 'stored_in_localStorage', // Reference only
            // originalPhotoUrl removed to save space
            timestamp: new Date().toISOString(),
            sessionId: sessionId,
            isOriginalPhoto: true
        };

        wardrobe.push(originalPhotoItem);
        await saveWardrobe(wardrobe);
        updateWardrobeButton();

        elloLog('✅ Added original photo to wardrobe (reference only)');
    }
}

// Remove item from wardrobe
async function removeFromWardrobe(tryOnId) {
    const wardrobe = getWardrobe();
    const filteredWardrobe = wardrobe.filter(item => item.id !== tryOnId);
    await saveWardrobe(filteredWardrobe);
    updateWardrobeButton();

    elloLog('🗑️ Removed from wardrobe:', tryOnId);
}

// Update wardrobe button count
function updateWardrobeButton() {
    const wardrobeBtn = document.querySelector('.wardrobe-btn');
    if (wardrobeBtn) {
        const count = getWardrobeCount();
        const countSpan = wardrobeBtn.querySelector('span:last-child');
        if (countSpan) {
            countSpan.textContent = `(${count})`;
        }
    }
}

// Open wardrobe modal
function openWardrobe() {
    const modal = document.getElementById('wardrobeModal');
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';

    renderWardrobeGrid();
}

// Close wardrobe modal
function closeWardrobe() {
    const modal = document.getElementById('wardrobeModal');
    modal.classList.remove('active');

    if (!widgetOpen || !isMobile) {
        document.body.style.overflow = '';
    }
}

// Render wardrobe grid
function renderWardrobeGrid() {
    const grid = document.getElementById('wardrobeGrid');
    const empty = document.getElementById('wardrobeEmpty');
    const wardrobe = getWardrobe();

    if (wardrobe.length === 0) {
        grid.style.display = 'none';
        empty.style.display = 'block';
        return;
    }

    grid.style.display = 'grid';
    empty.style.display = 'none';

    let gridHTML = '';
    wardrobe.forEach(item => {
        const isOriginalPhoto = item.isOriginalPhoto;
        const displayName = isOriginalPhoto ? 'Your Photo' : item.clothingName;
        const displayPrice = isOriginalPhoto ? '' : `$${Number(item.clothingPrice).toFixed(2)}`;

        // Get the image source - load from localStorage if it's a reference
        let imageSrc = item.resultImageUrl;
        if (isOriginalPhoto && (imageSrc === 'stored_in_localStorage' || !imageSrc)) {
            // Load original photo from localStorage
            const savedPhoto = localStorage.getItem(USER_PHOTO_STORAGE_KEY);
            imageSrc = savedPhoto || imageSrc;
        }

        gridHTML += `
            <div class="wardrobe-item ${isOriginalPhoto ? 'original-photo-item' : ''}" data-tryon-id="${item.id}">
                <img src="${imageSrc}" alt="${displayName}" loading="lazy" onclick="enlargeWardrobeImage('${imageSrc}', '${displayName}', '${item.id}')">
                <div class="wardrobe-item-name">${displayName}</div>
                ${displayPrice ? `<div class="wardrobe-item-price">${displayPrice}</div>` : ''}
                <div class="wardrobe-item-actions">
                    ${!isOriginalPhoto ? `
                        <button class="wardrobe-action-btn wardrobe-add-outfit-btn" onclick="addToOutfit('${item.id}')" title="Add this item to your outfit">
                            <span>👕</span>
                            <span>Add to Outfit</span>
                        </button>
                        <button class="wardrobe-action-btn wardrobe-add-cart-btn" onclick="addWardrobeItemToCart('${item.id}')" title="Add this item to your cart">
                            <span>🛒</span>
                            <span>Add to Cart</span>
                        </button>
                    ` : `
                        <button class="wardrobe-action-btn wardrobe-use-photo-btn" onclick="useOriginalPhoto('${item.id}')" title="Use this photo for try-on">
                            <span>📸</span>
                            <span>Use Photo</span>
                        </button>
                    `}
                </div>
            </div>
        `;
    });

    grid.innerHTML = gridHTML;
}

// Enlarge wardrobe image
function enlargeWardrobeImage(imageSrc, itemName, tryOnId) {
    const modal = document.getElementById('imageModal');
    const modalImage = document.getElementById('modalImage');

    // Get wardrobe item details
    const wardrobe = getWardrobe();
    const item = wardrobe.find(w => w.id === tryOnId);

    // Load image from localStorage if it's a reference
    let actualImageSrc = imageSrc;
    if (item && item.isOriginalPhoto && (imageSrc === 'stored_in_localStorage' || !imageSrc)) {
        const savedPhoto = localStorage.getItem(USER_PHOTO_STORAGE_KEY);
        actualImageSrc = savedPhoto || imageSrc;
    }

    modalImage.src = actualImageSrc;
    modalImage.alt = `Try-on result: ${itemName}`;

    // Add wardrobe-specific styling to modal
    modal.classList.add('wardrobe-view');
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';

    // Add wardrobe item info to modal
    const modalContent = modal.querySelector('.modal-content');
    if (!modalContent.querySelector('.wardrobe-modal-info')) {
        const infoDiv = document.createElement('div');
        infoDiv.className = 'wardrobe-modal-info';

        let infoHTML = `
            <h3>${itemName}</h3>
            <p>Your virtual try-on result</p>
        `;

        if (item) {
            infoHTML += `
                <div class="wardrobe-modal-details">
                    <div class="wardrobe-original-item">
                        <img src="${item.clothingImageUrl}" alt="Original ${item.clothingName}" class="wardrobe-original-image">
                        <span class="wardrobe-price">$${item.clothingPrice.toFixed(2)}</span>
                    </div>
                </div>
            `;
        }

        infoDiv.innerHTML = infoHTML;
        modalContent.appendChild(infoDiv);
    }
}

// Add item to outfit (use previous try-on result as new base photo for layering)
function addToOutfit(tryOnId) {
    const wardrobe = getWardrobe();
    const item = wardrobe.find(w => w.id === tryOnId);

    if (!item) {
        console.error('Wardrobe item not found:', tryOnId);
        return;
    }

    // For outfit building: Use the PREVIOUS try-on RESULT (with garment already on) as the base
    // This allows layering multiple garments to build a complete outfit
    // The result is base64, which the API accepts
    if (item.resultImageUrl && item.resultImageUrl.startsWith('data:image')) {
        // Use the try-on result (person with garment) as the new base photo
        userPhoto = item.resultImageUrl;
        // CRITICAL: Also update window.elloUserImageUrl so the API receives the base64 image
        window.elloUserImageUrl = item.resultImageUrl;
        elloLog('✅ Updated window.elloUserImageUrl to use try-on result (base64)');
    } else if (item.originalPhotoUrl && item.originalPhotoUrl.startsWith('data:image')) {
        // Fallback: if result not available, use original photo (first item in outfit)
        userPhoto = item.originalPhotoUrl;
        window.elloUserImageUrl = item.originalPhotoUrl;
        elloLog('⚠️ Result image not available, using original photo as fallback');
    } else {
        console.warn('⚠️ No valid image found in wardrobe item, cannot add to outfit');
        showError('Unable to add to outfit: image not available. Please try again.');
        return;
    }

    userPhotoFileId = 'outfit_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    activePhotoValidationId = userPhotoFileId;
    activePhotoValidationStatus = 'valid';
    lastRejectedPhotoValidationId = null;

    // Update photo preview to show the previous try-on result (with garment already on)
    // This shows the user their current outfit state, ready for the next garment
    updatePhotoPreview(userPhoto);

    // Close wardrobe modal
    closeWardrobe();

    // Show notification
    showSuccessNotification('Added to Outfit', `${item.clothingName} added to your outfit! Now try on another item to layer on top.`, 4000);

    // Update try-on button
    updateTryOnButton();

}

// Use original photo for try-on
function useOriginalPhoto(tryOnId) {
    const wardrobe = getWardrobe();
    const item = wardrobe.find(w => w.id === tryOnId);

    if (!item) {
        console.error('Wardrobe item not found:', tryOnId);
        return;
    }

    // Use the original photo for try-on
    // Get photo from localStorage if it's an original photo item, otherwise use resultImageUrl
    if (item.isOriginalPhoto) {
        // For original photos, load from localStorage
        const savedPhoto = localStorage.getItem(USER_PHOTO_STORAGE_KEY);
        if (savedPhoto) {
            userPhoto = savedPhoto;
            window.elloUserImageUrl = savedPhoto; // Update API image URL
            userPhotoFileId = 'original_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            updatePhotoPreview(savedPhoto);
        } else {
            console.warn('Original photo not found in localStorage');
            return;
        }
    } else if (item.resultImageUrl && !item.resultImageUrl.startsWith('stored_in_')) {
        // Use result image if available (but not if it's just a reference)
        userPhoto = item.resultImageUrl;
        window.elloUserImageUrl = item.resultImageUrl; // Update API image URL
        userPhotoFileId = 'wardrobe_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        updatePhotoPreview(item.resultImageUrl);
    } else if (item.originalPhotoUrl && !item.originalPhotoUrl.startsWith('stored_in_')) {
        // Fallback to originalPhotoUrl if it exists and is not a reference
        userPhoto = item.originalPhotoUrl;
        window.elloUserImageUrl = item.originalPhotoUrl; // Update API image URL
        userPhotoFileId = 'original_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        updatePhotoPreview(item.originalPhotoUrl);
    } else {
        console.warn('No photo available for this wardrobe item');
        return;
    }

    activePhotoValidationId = userPhotoFileId;
    activePhotoValidationStatus = 'valid';
    lastRejectedPhotoValidationId = null;

    // Close wardrobe modal
    closeWardrobe();

    // Show notification
    showSuccessNotification('Photo Loaded', 'Your original photo is ready for try-on!', 3000);

    // Update try-on button
    updateTryOnButton();

}

// Select wardrobe item for re-try
function selectWardrobeItem(tryOnId) {
    const wardrobe = getWardrobe();
    const item = wardrobe.find(w => w.id === tryOnId);

    if (!item) {
        console.error('Wardrobe item not found:', tryOnId);
        return;
    }

    // Find the clothing in sampleClothing
    const clothing = sampleClothing.find(c => c.id === item.clothingId);
    if (!clothing) {
        console.error('Clothing not found in sampleClothing:', item.clothingId);
        return;
    }

    // Set as selected clothing
    selectedClothing = item.clothingId;

    // Set window state variable
    // Track selected variant ID (use first variant if available, otherwise null)
    const selectedVariantId = clothing.variants?.[0]?.shopify_variant_gid || null;
    window.elloSelectedGarment = {
        image_url: clothing.image_url,
        ...clothing,
        selectedVariantId: selectedVariantId
    };

    // Close wardrobe modal
    closeWardrobe();

    // Update UI to show selected item
    document.querySelectorAll('.quick-pick-item').forEach(item => {
        item.classList.remove('selected');
    });

    document.querySelectorAll('.featured-item').forEach(item => {
        item.classList.remove('selected');
    });

    // Highlight the selected item in quick picks or featured
    const quickPickItem = document.querySelector(`[onclick*="${item.clothingId}"]`);
    if (quickPickItem) {
        quickPickItem.classList.add('selected');
    }

    // Don't show preview - wardrobe item selection updates visible quick picks/featured
    updateSelectedClothingPreview(null);

    // Update try-on button
    updateTryOnButton();

    // Show notification
    showSuccessNotification('Item Selected', `${clothing.name} selected for try-on!`);

    elloLog('✅ Selected wardrobe item:', clothing.name);
}

// Auto-save successful try-ons to wardrobe
async function autoSaveToWardrobe(clothing, resultImageUrl, tryOnId) {
    if (resultImageUrl && !resultImageUrl.includes('placeholder')) {
        await addToWardrobe(clothing, resultImageUrl, tryOnId);
        await addOriginalPhotoToWardrobe(); // Also save original photo if not already saved
        showSuccessNotification('Saved to Wardrobe', `${clothing.name} has been saved to your wardrobe!`);
    }
}

// Add wardrobe item to cart
async function addWardrobeItemToCart(tryOnId) {
    const wardrobe = getWardrobe();
    const item = wardrobe.find(w => w.id === tryOnId);

    if (!item) {
        console.error('Wardrobe item not found:', tryOnId);
        return;
    }

    // Find the original clothing data
    // Find the original clothing data (Robust match)
    const clothing = sampleClothing.find(c => {
        const idStr = String(item.clothingId);
        if (c.id == item.clothingId) return true;
        if (String(c.id).endsWith(`/${idStr}`)) return true;
        if (idStr.endsWith(`/${c.id}`)) return true;
        if (c.shopify_product_id && c.shopify_product_id == item.clothingId) return true;
        if (c.handle && (c.handle === idStr || c.handle === idStr.toLowerCase())) return true;
        return false;
    });

    if (!clothing) {
        console.error('Original clothing data not found for wardrobe item:', item.clothingId);
        alert('Item not found. Please try again.');
        return;
    }

    // LAZY LOAD VARIANTS if missing
    if (!clothing.variants || clothing.variants.length === 0) {
        if (clothing.handle) {
            elloLog(`[Ello] Variants missing for ${clothing.handle}, lazy loading...`);
            try {
                const productRes = await fetch(`/products/${clothing.handle}.js`);
                if (productRes.ok) {
                    const productData = await productRes.json();
                    clothing.variants = productData.variants.map(v => ({
                        id: v.id,
                        shopify_variant_gid: `gid://shopify/ProductVariant/${v.id}`,
                        title: v.title,
                        price: (v.price / 100).toFixed(2),
                        size: v.title
                    }));
                }
            } catch (e) {
                console.error("Lazy load failed", e);
            }
        }
    }

    if (!clothing.variants || clothing.variants.length === 0) {
        alert('Product variants not found or failed to load.');
        return;
    }

    try {
        let variantToAdd = null;

        // Size selection logic
        if (clothing.variants.length === 1) {
            variantToAdd = clothing.variants[0];
        } else {
            const selectedVariantId = await showSizeSelector(clothing);
            if (!selectedVariantId) return;

            variantToAdd = clothing.variants.find(v => v.id == selectedVariantId);
            if (!variantToAdd) {
                alert('Selected size not found. Please try again.');
                return;
            }
        }

        // Add to Shopify cart
        const cartResponse = await fetch('/cart/add.js', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                id: variantToAdd.id,
                quantity: 1
            })
        });

        if (cartResponse.ok) {
            const cartResult = await cartResponse.json();
            elloLog('✅ Successfully added wardrobe item to cart:', cartResult);

            // Show success notification
            const sizeText = variantToAdd.size || variantToAdd.title || '';
            const sizeDisplay = sizeText ? `Size ${sizeText}` : '';
            showSuccessNotification(
                'Added to Cart!',
                `${item.clothingName} ${sizeDisplay ? `• ${sizeDisplay}` : ''}`
            );

            // Update cart display
            await updateCartDisplay();

            // Track cart event (non-blocking)
            trackCartEvent(clothing, variantToAdd, 1);

            // Send webhook for analytics tracking
            try {
                const conversionData = {
                    mode: 'conversion',
                    tryOnId: tryOnId,
                    sessionId: sessionId,
                    storeId: window.ELLO_STORE_ID || 'default_store',
                    conversionType: 'wardrobe_add_to_cart',
                    revenueAmount: variantToAdd.price,
                    selectedClothing: {
                        id: clothing.id,
                        name: clothing.name,
                        price: variantToAdd.price.toFixed(2),
                        category: clothing.category,
                        color: clothing.color,
                        image_url: clothing.image_url,
                        variant_id: variantToAdd.id,
                        size: variantToAdd.size || variantToAdd.title
                    },
                    tryonResultUrl: item.resultImageUrl,
                    shopifyCartResult: cartResult,
                    deviceInfo: {
                        isMobile: isMobile,
                        isTablet: isTablet,
                        isIOS: isIOS,
                        isAndroid: isAndroid,
                        viewport: {
                            width: window.innerWidth,
                            height: window.innerHeight
                        }
                    },
                    timestamp: new Date().toISOString()
                };

                // Send analytics webhook (don't block on this)
                fetch(WEBHOOK_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(conversionData)
                }).then(response => {
                    if (response.ok) {
                        elloLog('✅ Wardrobe analytics tracked successfully');
                    } else {
                        elloLog('⚠️ Wardrobe analytics tracking failed, but cart add succeeded');
                    }
                }).catch(error => {
                    elloLog('⚠️ Wardrobe analytics tracking error:', error);
                });

            } catch (webhookError) {
                elloLog('⚠️ Wardrobe webhook tracking failed:', webhookError);
            }

        } else {
            const errorText = await cartResponse.text();
            console.error('❌ Shopify cart error:', errorText);
            alert(`❌ Failed to add to cart. Error: ${cartResponse.status}`);
        }

    } catch (error) {
        console.error('❌ Network error:', error);
        alert('❌ Network error: ' + error.message);
    }
}



// ============================================================================
// PREVIEW / MINI TRY-ON STATE LOGIC
// ============================================================================

// State for Preview Logic
let checkPreviewInterval = null;
let previewEngaged = false; // "Meaningful interaction" tracking

// Analytics Helper for Preview Events
function trackPreviewEvent(eventName, data = {}) {
    try {
        const storeSlug = window.ELLO_STORE_CONFIG?.storeSlug || window.ELLO_STORE_SLUG || window.ELLO_STORE_ID;
        if (!storeSlug) return;

        // Normalize Product ID
        let normalizedProductId = data.productId || window.elloSelectedGarment?.shopify_product_gid || window.elloSelectedGarment?.id || null;
        if (normalizedProductId && /^\d+$/.test(String(normalizedProductId))) {
            normalizedProductId = `gid://shopify/Product/${normalizedProductId}`;
        }

        const payload = {
            storeSlug: storeSlug,
            eventName: eventName,
            sessionId: window.ELLO_SESSION_ID || sessionId || null,
            productId: normalizedProductId,
            metadata: data
        };

        // Post preview events to the Python /track-preview-event endpoint,
        // which resolves the store_slug and inserts into vto_preview_events.
        // (A prior refactor pointed this at a Supabase RPC that didn't exist,
        //  so events silently 404'd — keep this URL until the RPC is created.)
        let baseUrl = "https://ello-vto-13593516897-13593516897.us-central1.run.app";
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            baseUrl = "http://localhost:8000";
        }

        fetch(`${baseUrl}/track-preview-event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            keepalive: true
        }).catch((e) => {
            console.warn('[Ello] Preview analytics error:', e);
        });

    } catch (e) { }
}

function stopIdleWatcher() {
    if (checkPreviewInterval) {
        clearInterval(checkPreviewInterval);
        checkPreviewInterval = null;
    }
    if (previewDelayTimer) {
        clearTimeout(previewDelayTimer);
        previewDelayTimer = null;
    }
}

function initializePreviewTriggers() {
    elloLog('[Ello VTO] Initializing Preview Triggers...');
    // 0. Kill Switch (Dashboard Config)
    const config = window.ELLO_STORE_CONFIG || {};
    if (config.desktopPreviewEnabled === false) {
        elloLog('[Ello VTO] Preview disabled by kill-switch.');
        return;
    }

    // 1. Desktop & Pointer Gate
    const isFinePointer = window.matchMedia('(pointer: fine)').matches;
    // Relaxed width check for testing/laptops.
    if ((isMobile || window.innerWidth < 768 || !isFinePointer) && !window.forceShowPreview) {
        elloLog('[Ello VTO] Preview disabled by device check:', { isMobile, width: window.innerWidth, isFinePointer });
        return;
    }

    elloLog('[Ello VTO] Preview Triggers Active.');

    // 2. Setup SPA/Route Listeners (Reset logic)
    setupHistoryListeners();

    // 3. Initial Check (Reset timers)
    resetPreviewTimers();
}

// Expose for testing
window.resetPreviewTimers = resetPreviewTimers;
window.forceShowPreview = checkPreviewEligibilityAndShow; // Expose for specific debugging


function setupHistoryListeners() {
    // Monkey-patch pushState and replaceState to detect SPA navigation
    const wrapHistory = (type) => {
        const original = history[type];
        return function () {
            const result = original.apply(this, arguments);
            // Trigger custom event
            const e = new Event(type);
            e.arguments = arguments;
            window.dispatchEvent(e);
            return result;
        };
    };

    // Check if already patched to avoid recursion loops if re-initialized
    if (!history.pushState.isElloPatched) {
        history.pushState = wrapHistory('pushState');
        history.pushState.isElloPatched = true;
        history.replaceState = wrapHistory('replaceState');
    }

    // Listen for all history changes
    window.addEventListener('popstate', handleRouteChanged);
    window.addEventListener('pushState', handleRouteChanged);
    window.addEventListener('replaceState', handleRouteChanged);
}

function handleRouteChanged() {
    // Hide preview if open
    dismissPreview(true); // temporary dismiss (force close now, but allow re-open on new page)

    // Reset engagement state for new page
    previewEngaged = false;

    // Stop strict polling immediately
    stopIdleWatcher();

    // Reset timers for the new page
    resetPreviewTimers();
}

// let previewDelayTimer = null; // Removed duplicate
// let hasUserActivity = false; // Removed duplicate

function resetPreviewTimers() {
    // Clear existing
    if (previewDelayTimer) clearTimeout(previewDelayTimer);

    // Initial check for session/dismissal state
    const storeId = window.ELLO_STORE_ID || 'default_store';
    try {
        previewDismissedForever = localStorage.getItem(`ello_${storeId}_preview_dismissed`) === 'true';
        // Removed session check to allow re-pop on new pages
        // previewShownThisSession = sessionStorage.getItem(`ello_${storeId}_preview_shown_session`) === 'true';
    } catch (e) { }

    if (previewDismissedForever) return;

    // Determine delay (default 3s, clamp between 1s and 60s)
    let delaySeconds = 3;
    if (window.ELLO_STORE_CONFIG && window.ELLO_STORE_CONFIG.desktopPreviewDelay) {
        delaySeconds = parseInt(window.ELLO_STORE_CONFIG.desktopPreviewDelay, 10);
        if (isNaN(delaySeconds)) delaySeconds = 3;
    }
    // Safety clamp
    if (delaySeconds < 1) delaySeconds = 1;
    if (delaySeconds > 60) delaySeconds = 60;

    elloLog(`[Ello VTO] Starting Preview Timer (${delaySeconds}s delay)...`);

    // Setup User Activity Listeners (One-time)
    const markActivityAndCheck = () => {
        hasUserActivity = true;
    };

    window.addEventListener('mousemove', markActivityAndCheck, { once: true });
    window.addEventListener('click', markActivityAndCheck, { once: true });
    window.addEventListener('scroll', markActivityAndCheck, { once: true });

    // 1. Configurable Delay
    // We want it to pop up "while they are active", just not instantly on load.
    previewDelayTimer = setTimeout(() => {
        elloLog('[Ello VTO] Timer finished. Checking activity...');
        attemptShowPreview();
    }, delaySeconds * 1000);
}

function attemptShowPreview() {
    // If user has already interacted, show immediately.
    if (hasUserActivity) {
        checkPreviewEligibilityAndShow();
    } else {
        // If not yet active, wait for the FIRST interaction, then show (almost) immediately.
        elloLog('[Ello VTO] User not active yet. Waiting for interaction...');
        const showOnInteraction = () => {
            hasUserActivity = true; // Ensure flag is set
            // Small buffer so it doesn't feel jumpy on the exact millisecond of mouse entry
            setTimeout(checkPreviewEligibilityAndShow, 500);
        };
        window.addEventListener('mousemove', showOnInteraction, { once: true });
        window.addEventListener('click', showOnInteraction, { once: true });
        window.addEventListener('scroll', showOnInteraction, { once: true });
    }
}

// Resolve the active visibility mode from the merchant's dashboard setting
// (vto_stores.widget_visibility_mode → ELLO_STORE_CONFIG.widgetVisibilityMode).
function getWidgetVisibilityMode() {
    const fromConfig = window.ELLO_STORE_CONFIG && window.ELLO_STORE_CONFIG.widgetVisibilityMode;
    const mode = (fromConfig || 'always').toString().toLowerCase();
    return mode === 'smart' ? 'smart' : 'always';
}

// Show or hide the floating widget. In Smart mode, the only place we hide is a
// product detail page whose product is NOT in the enabled catalog (e.g. the
// merchant sells stickers/pins alongside clothing — those PDPs would otherwise
// trigger try-on attempts and tank engagement metrics). Everywhere else — home,
// collection pages, cart, search, content — the widget shows normally so it
// stays visible as a discovery surface.
//
// Uses setProperty(..., 'important') because .widget-minimized { display: flex !important }
// in widget-template.html would otherwise win over a plain inline style, leaving the
// widget visible on load and only disappearing once the user clicks (which strips the
// widget-minimized class).
function applyWidgetVisibilityGate(opts) {
    opts = opts || {};
    const widget = document.getElementById('virtualTryonWidget');
    if (!widget) return;

    const show = () => widget.style.removeProperty('display');
    const hide = () => widget.style.setProperty('display', 'none', 'important');

    // ─── Three-surface placement: per-page-type kill switches ───────────────
    // These run FIRST so the merchant's dashboard setting always wins. The
    // smart-visibility logic below only kicks in for pages that pass these.
    const cfg = window.ELLO_STORE_CONFIG || {};
    const onProductPage = window.location.pathname.includes('/products/');

    if (onProductPage && cfg.floatingWidgetPdpEnabled === false) {
        hide();
        return;
    }
    if (!onProductPage && cfg.floatingWidgetNonPdpEnabled === false) {
        hide();
        return;
    }

    // failOpen short-circuit — used by callers that need the widget visible
    // regardless of mode (e.g., after a confirmed click on the bubble itself).
    if (opts.failOpen) {
        show();
        return;
    }

    const mode = getWidgetVisibilityMode();
    if (mode === 'always') {
        show();
        return;
    }

    // Smart mode — anything that isn't a /products/<handle> page is fine to show on.
    if (!onProductPage) {
        show();
        return;
    }

    // On a PDP — keep hidden until the catalog has loaded so we can make an
    // accurate call. Once loaded, only show if this product is in the catalog.
    if (opts.phase === 'pre-catalog' || !_elloClothingDataLoaded) {
        hide();
        return;
    }

    // ─── Hard gate via enabled-handles set ───────────────────────────────
    // sampleClothing only holds the small preview set under the Tier 2
    // loading model, so detectCurrentProduct's Method 5 fuzzy title match
    // can false-positive against featured/quick-pick products with similar
    // names. The enabled-handles set is the authoritative answer for
    // "is THIS URL's product in the catalog?" — check it first.
    if (window.elloEnabledHandles instanceof Set) {
        const currentHandle = getProductIdFromUrl(window.location.pathname);
        if (currentHandle && !window.elloEnabledHandles.has(currentHandle)) {
            hide();
            elloLog('[Ello VTO] Smart visibility: handle not in enabled set — hiding widget.', currentHandle);
            return;
        }
    }

    const currentProduct = detectCurrentProduct();
    if (currentProduct && !currentProduct.isFallback) {
        show();
        elloLog('[Ello VTO] Smart visibility: enabled product detected — showing widget for', currentProduct.title || currentProduct.name);
    } else {
        hide();
        elloLog('[Ello VTO] Smart visibility: product not in enabled catalog — hiding widget.');
    }
}

async function checkPreviewEligibilityAndShow() {
    const storeId = window.ELLO_STORE_ID || 'default_store';
    elloLog('[Ello VTO] Checking preview eligibility...');

    // Check Global Toggle
    if (window.ELLO_STORE_CONFIG && window.ELLO_STORE_CONFIG.desktopPreviewEnabled === false) {
        elloLog('[Ello VTO] Preview blocked: Disabled in configuration.');
        return;
    }

    // Check if main widget is already open
    if (widgetOpen) {
        elloLog('[Ello VTO] Preview blocked: Main widget is already open.');
        return;
    }

    // Re-check simple conditions
    try {
        /*
        if (sessionStorage.getItem(`ello_${storeId}_preview_shown_session`) === 'true') {
             elloLog('[Ello VTO] Preview blocked: Already shown this session.');
             return;
        }
        */
        if (localStorage.getItem(`ello_${storeId}_preview_dismissed`) === 'true') {
            elloLog('[Ello VTO] Preview blocked: Permanently dismissed.');
            return;
        }
    } catch (e) { }

    // Relaxed width check for testing
    const isFinePointer = window.matchMedia('(pointer: fine)').matches;
    if ((isMobile || window.innerWidth < 768 || !isFinePointer) && !window.forceShowPreview) {
        elloLog('[Ello VTO] Preview blocked: Device check failed', { width: window.innerWidth, isMobile, isFinePointer });
        return;
    }

    // Wait for clothing data (and its blacklist) to finish loading before checking.
    // This prevents the preview from showing before the blacklist is populated.
    if (!_elloClothingDataLoaded) {
        elloLog('[Ello VTO] Waiting for clothing data to load before preview check...');
        const maxWait = 15000; // 15s max
        const start = Date.now();
        while (!_elloClothingDataLoaded && Date.now() - start < maxWait) {
            await new Promise(r => setTimeout(r, 250));
        }
        if (!_elloClothingDataLoaded) {
            console.warn('[Ello VTO] Preview blocked: Clothing data did not load in time.');
            return;
        }
    }

    // Hard gate via enabled-handles set — same rationale as in
    // applyWidgetVisibilityGate. detectCurrentProduct's fuzzy title match
    // (Method 5) can false-positive against the small Tier 2 preview set;
    // the handles list is the authoritative "is this product enabled?" check.
    if (window.elloEnabledHandles instanceof Set) {
        const currentHandle = getProductIdFromUrl(window.location.pathname);
        if (currentHandle && !window.elloEnabledHandles.has(currentHandle)) {
            elloLog('[Ello VTO] Preview blocked: handle not in enabled set —', currentHandle);
            return;
        }
    }

    // Detect the current product on this page.
    // detectCurrentProduct() searches sampleClothing by handle, Shopify ID, JSON-LD, and title.
    // If the product isn't in sampleClothing it returns null (or a fallback with isFallback: true).
    const currentProduct = detectCurrentProduct();

    // Only show the preview if the product is actually in the widget catalog (sampleClothing).
    // This is a positive check — it catches hidden items, non-clothing, un-synced products, etc.
    // in one simple gate instead of maintaining separate blacklists.
    if (!currentProduct || currentProduct.isFallback) {
        elloLog('[Ello VTO] Preview blocked: Product not in widget catalog.',
            currentProduct ? (currentProduct.name || currentProduct.title) : '(no product detected)');
        return;
    }

    elloLog('[Ello VTO] Eligibility Passed! Showing preview for:', currentProduct.title || currentProduct.name);
    // Show it!
    await showPreview(currentProduct);
}

async function showPreview(product) {
    const previewWidget = document.getElementById('previewWidget');
    if (!previewWidget) return;

    const storeId = window.ELLO_STORE_ID || 'default_store';

    // Update session flag immediately
    // previewShownThisSession = true;
    // try { sessionStorage.setItem(`ello_${storeId}_preview_shown_session`, 'true'); } catch (e) { }

    // Populate Data
    const img = document.getElementById('previewProductImg');
    if (img) img.src = product.image_url;

    // Check if we already have a user photo populated
    if (userPhoto) {
        updatePreviewUserPhoto(userPhoto);
    }

    // Apply Theme
    if (window.ELLO_STORE_CONFIG?.previewTheme === 'dark') {
        previewWidget.classList.add('theme-dark');
    } else {
        previewWidget.classList.remove('theme-dark');
    }

    // Show UI
    previewWidget.style.display = 'flex';
    void previewWidget.offsetWidth;
    previewWidget.classList.add('active');
    isPreviewVisible = true;
    previewEngaged = false; // Reset engagement tracker

    // Only track preview_shown if we haven't tracked it for this product in this session
    // Or at least debounce it (e.g., if shown in last 5 seconds, ignore)
    const lastPreviewTime = window._lastPreviewShownTime || 0;
    const now = Date.now();
    if (now - lastPreviewTime > 2000) {
        trackPreviewEvent('preview_shown', { productId: product.id, hasSavedPhoto: !!window.elloUserImageUrl });
        window._lastPreviewShownTime = now;
    }

    // Auto-select this product in the background
    selectedClothing = product.id;
    window.elloSelectedGarment = {
        image_url: product.image_url,
        ...product,
        selectedVariantId: product.variants?.[0]?.shopify_variant_gid || null
    };
}

// Temporary dismiss (e.g. navigation) vs User dismiss
function dismissPreview(temporary = false) {
    const previewWidget = document.getElementById('previewWidget');
    if (previewWidget) {
        previewWidget.classList.remove('active');
        setTimeout(() => {
            previewWidget.style.display = 'none';
        }, 400);
    }
    isPreviewVisible = false;

    // Safety: Stop any watchers
    stopIdleWatcher();

    // If this is a user dismissal (not temporary nav/open full)
    // AND they haven't engaged, dismiss forever.
    if (!temporary && !previewEngaged && !widgetOpen) {
        trackPreviewEvent('preview_dismissed_forever');
        const storeId = window.ELLO_STORE_ID || 'default_store';
        try { localStorage.setItem(`ello_${storeId}_preview_dismissed`, 'true'); } catch (e) { }
    } else {
        const now = Date.now();
        const lastHiddenTime = window._lastPreviewHiddenTime || 0;

        // Only track if meaningful time has passed or it's a different event type
        if (now - lastHiddenTime > 1000) {
            trackPreviewEvent('preview_hidden', { temporary });
            window._lastPreviewHiddenTime = now;
        }
    }
}

// Handler for the "Add photo" tile in preview
window.handlePreviewUploadClick = function () {
    previewEngaged = true; // Mark as engaged
    trackPreviewEvent('upload_clicked');

    // Helper that actually opens the file picker.
    // Wrapped so we can route through the best-practices/consent modal first.
    const triggerFilePicker = () => {
        const photoInput = document.getElementById('photoInput');
        if (photoInput) {
            // Stop propagation to prevent bubbling up to the minimized widget container (which would open it)
            const stopProp = (e) => e.stopPropagation();
            photoInput.addEventListener('click', stopProp, { once: true });
            photoInput.click();
        }
    };

    // Show best-practices modal (which contains ToS/Privacy consent) if not yet dismissed.
    // Clicking "Continue" in the modal both records consent and triggers the file picker.
    if (checkShouldShowBestPractices()) {
        pendingPhotoAction = triggerFilePicker;
        showBestPracticesModal();
        return;
    }

    triggerFilePicker();
}

// Global update function called by handlePhotoUpload
function updatePreviewUserPhoto(photoDataUrl) {
    const previewTile = document.getElementById('previewUploadTile');
    const previewImg = document.getElementById('previewUserPhoto');
    const tryBtn = document.getElementById('previewTryBtn');

    if (previewTile && previewImg && tryBtn) {
        previewImg.src = photoDataUrl;
        previewTile.classList.add('has-photo');
        tryBtn.disabled = false;

        // If we updated the photo, that counts as interaction too potentially?
        // Usually yes, but verify context.
        // If this came from a manual upload (not loadSavedPhoto), mark active.
        if (window.event && window.event.type === 'change') {
            previewEngaged = true;
            trackPreviewEvent('photo_uploaded');
        }
    }
}

// Helper to reset UI state
function resetPreviewUI() {
    const overlay = document.getElementById('previewProgressOverlay');
    const previewWidget = document.getElementById('previewWidget');
    const btn = document.getElementById('previewTryBtn');

    stopTryOnLoadingState('preview');
    if (previewWidget) {
        previewWidget.classList.remove('preview-loading');
    }
    if (overlay) overlay.style.setProperty('display', 'none', 'important');
    if (btn) {
        btn.textContent = 'GENERATE MY LOOK';
        btn.disabled = !userPhoto;
        btn.style.cursor = userPhoto ? 'pointer' : '';
    }
}

window.handlePreviewTryOn = async function () {
    // Prevent duplicate clicks immediately
    if (isTryOnProcessing || window._previewTryOnProcessing) {
        return;
    }
    window._previewTryOnProcessing = true; // Local lock for preview specifically

    // Surface attribution — every preview-popup-driven try-on tags here.
    // Consumed and cleared inside callElloTryOn so a later non-preview try-on
    // isn't mis-attributed.
    window.ELLO_PENDING_ENTRY_SOURCE = 'preview_popup';

    previewEngaged = true; // Mark as engaged
    trackPreviewEvent('tryon_clicked', { hasSavedPhoto: !!window.elloUserImageUrl });

    const overlay = document.getElementById('previewProgressOverlay');
    const previewWidget = document.getElementById('previewWidget');

    if (overlay) {
        if (previewWidget) {
            previewWidget.classList.add('preview-loading');
        }
        overlay.style.display = 'flex';
        overlay.style.setProperty('display', 'flex', 'important'); // FORCE visibility
        overlay.style.setProperty('z-index', '2147483647', 'important'); // FORCE TOP
        startTryOnLoadingState('preview');
        void overlay.offsetWidth;
    }

    startTryOn().catch(e => {
        console.error("Preview generation failed:", e);
        window._previewTryOnProcessing = false; // Release lock on error
        return false;
    });

    const previewStartedAt = Date.now();
    const intervalTime = 100;

    const progressInterval = setInterval(() => {
        if (!isTryOnProcessing && Date.now() - previewStartedAt > 1200) {
            clearInterval(progressInterval);
            finishPreviewTransition();
        }
    }, intervalTime);

    function finishPreviewTransition() {
        if (overlay) {
            updateTryOnLoadingCopy(overlay, TRYON_LOADING_TIPS.length - 1);
            updateTryOnLoadingProgress(overlay, 100);
        }
        stopTryOnLoadingState('preview');

        setTimeout(() => {
            if (previewWidget) {
                previewWidget.classList.remove('preview-loading');
            }
            dismissPreview(true); // Close preview
            openWidget(); // Open full widget

            window._previewTryOnProcessing = false; // Release lock

            // Force scroll to result ensuring DOM is ready
            setTimeout(() => {
                const resultSection = document.getElementById('resultSection');
                if (resultSection) {
                    smoothScrollToResult(resultSection);
                }
            }, 300);

            // Reset preview UI for next time (after it's hidden)
            setTimeout(resetPreviewUI, 500);
        }, 600);
    }
}

// ============================================================================
// FIRST-RUN OVERLAY LOGIC
// ============================================================================

function checkOnboarding() {
    const overlay = document.getElementById('firstRunOverlay');
    if (!overlay) return;

    const storeSlug = window.ELLO_STORE_CONFIG?.storeSlug || window.ELLO_STORE_SLUG || window.ELLO_STORE_ID || 'default_store';
    const ONBOARDING_KEY = `ello_intro_seen:${storeSlug}`;

    // Check if user has already onboarded
    const onboardingComplete = localStorage.getItem(ONBOARDING_KEY) === 'true';

    // If NOT complete, show overlay
    if (!onboardingComplete) {
        isFirstTimeIntro = true;
        introViewId = generateIntroViewId();
        introShownAt = Date.now();
        introActionFired = false;

        // Make sure it's visible
        overlay.style.display = 'flex';
        // Small delay to allow display:flex to apply before adding active class for opacity transition
        setTimeout(() => {
            overlay.classList.add('active');
        }, 10);

        // Bind events
        const demoBtn = document.getElementById('froDemoBtn');
        const realBtn = document.getElementById('froRealBtn');
        const dismissBtn = document.getElementById('froDismissBtn');

        if (demoBtn) demoBtn.onclick = useModelFlow;
        if (realBtn) realBtn.onclick = useMyPhotoFlow;
        if (dismissBtn) dismissBtn.onclick = dismissIntroFlow;
    } else {
        // Ensure it's hidden if complete
        overlay.style.display = 'none';
        overlay.classList.remove('active');
    }
}

function dismissIntroFlow() {
    if (introActionFired) return;
    introActionFired = true;

    // Track dismissal BEFORE closing (since closeWidget resets view context)
    const timeToAction = Date.now() - introShownAt;
    trackEvent('intro_dismiss', {
        time_to_action_ms: timeToAction,
        dismiss_type: 'x_button'
    });

    completeOnboarding();

    // Cleanly dismiss overlay state
    dismissOverlay();

    // Close the whole widget entirely as requested
    closeWidget();
}

function useMyPhotoFlow() {
    if (introActionFired) return;
    introActionFired = true;

    completeOnboarding();
    dismissOverlay();

    const timeToAction = Date.now() - introShownAt;
    trackEvent('intro_cta_click', { cta: 'use_my_photo', time_to_action_ms: timeToAction });

    // Save selection state and scroll
    window.selectedSource = 'user';
    setTimeout(() => {
        smoothScrollToSelection('photo');
    }, 450);
}

function useModelFlow() {
    if (introActionFired) return;
    introActionFired = true;

    completeOnboarding();
    dismissOverlay();

    const timeToAction = Date.now() - introShownAt;
    trackEvent('intro_cta_click', { cta: 'use_model', time_to_action_ms: timeToAction });

    // Save selection state and scroll
    window.selectedSource = 'model';
    setTimeout(() => {
        smoothScrollToSelection('model');
    }, 450);
}

// Update completeOnboarding to use new key
function completeOnboarding() {
    const storeSlug = window.ELLO_STORE_CONFIG?.storeSlug || window.ELLO_STORE_SLUG || window.ELLO_STORE_ID || 'default_store';
    localStorage.setItem(`ello_intro_seen:${storeSlug}`, 'true');
}

function dismissOverlay() {
    const overlay = document.getElementById('firstRunOverlay');
    if (overlay) {
        overlay.classList.remove('active');
        setTimeout(() => {
            overlay.style.display = 'none';
        }, 400); // Match CSS transition
    }
}

function smoothScrollToSelection(type) {
    const target = document.getElementById('uploadOptionsContainer');
    const modelCard = document.getElementById('useModelCard');
    const photoCard = document.getElementById('uploadPhotoCard');
    const scrollContainer = document.getElementById('tryonContent');

    if (!target || !scrollContainer) return;

    // Surgical scroll: calculate exact position relative to the scroll container's viewport
    const rect = target.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();
    const currentScroll = scrollContainer.scrollTop;

    // Calculate the target scroll position (centering the section slightly)
    const targetScroll = currentScroll + (rect.top - containerRect.top) - 40;

    scrollContainer.scrollTo({
        top: Math.max(0, targetScroll),
        behavior: 'smooth'
    });

    // Apply distinct visual feedback based on the chosen path
    if (type === 'model' && modelCard && photoCard) {
        modelCard.classList.add('selection-highlight-model');
        photoCard.classList.add('selection-muted');
        setTimeout(() => {
            modelCard.classList.remove('selection-highlight-model');
            photoCard.classList.remove('selection-muted');
        }, 1800);
    } else if (type === 'photo' && photoCard && modelCard) {
        photoCard.classList.add('selection-highlight-user');
        modelCard.classList.add('selection-muted');
        setTimeout(() => {
            photoCard.classList.remove('selection-highlight-user');
            modelCard.classList.remove('selection-muted');
        }, 1800);
    }
}

// End of file cleanup - redundant definitions removed
