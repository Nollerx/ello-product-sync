// Entire file runs inside an IIFE. widget-main.js used to execute at the top
// level of the page, where its ~85 top-level let/const declarations could
// collide with a theme's or another app's globals — one shared name (e.g.
// `isAndroid`, `isMobile`, `sessionId`) and whichever classic script parsed
// second died entirely with 'Identifier has already been declared', taking
// either the widget or the merchant's theme feature down with it. Everything
// the page needs is exported explicitly on window (Ello API, __elloWidget
// handler namespace, __elloInitializeWidget).
(function () {

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

// Make initializeWidget globally accessible under an Ello-prefixed name.
// `initializeWidget` is a name a theme or another app can plausibly own —
// clobbering it broke merchant pages, so the prefixed name is canonical.
// The bare alias is only set when nobody else has claimed it, purely so
// older cached copies of widget-loader.js (which call the bare name) keep
// working until their CDN cache expires.
window.__elloInitializeWidget = function () {
    detectDevice();
    // Footwear PDPs get feet-oriented upload copy (the template ships the
    // clothing "full body" wording). After detectDevice so isMobile is set.
    elloApplyFootwearUploadCopy();
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
                        styleOverrides: (storeConfig.style_overrides && typeof storeConfig.style_overrides === 'object')
                            ? storeConfig.style_overrides : null,
                        featuredItemId: storeConfig.featured_item_id || null,
                        quickPicksIds: storeConfig.quick_picks_ids || null,
                        leadCaptureEnabled: storeConfig.lead_capture_enabled === true,
                        leadCaptureAfterN: storeConfig.lead_capture_after_n || 1
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

// Back-compat alias for cached widget-loader.js copies that still call the
// bare name. Never overwrite an existing global — if a theme or another app
// defined `initializeWidget` first, it keeps it (new loaders use the
// prefixed name, so the widget still boots).
if (typeof window.initializeWidget !== 'function') {
    window.initializeWidget = window.__elloInitializeWidget;
}

// Keep the existing DOMContentLoaded for direct page loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.__elloInitializeWidget);
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
            window.__elloInitializeWidget();
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
let savedScrollY = 0;          // page offset captured at lock time, restored on unlock
let bodyScrollLocked = false;  // guards against double lock/unlock desyncing savedScrollY

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
const CLOTHING_SELECT_COLUMNS = 'id,item_id,name,price,category,tags,color,image_url,image_override_url,product_url,data_source,active,shopify_product_id,variants';

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
            // FAIL OPEN, not closed. elloIsProductEnabled treats ANY Set as the
            // authoritative allowlist, so assigning an empty Set here would
            // disable try-on on EVERY product store-wide on a transient 500.
            // Leaving elloEnabledHandles unset makes the membership check fall
            // back to sampleClothing and skips the inline-button hide sweep —
            // so a blip degrades gracefully instead of killing the widget.
            console.warn(`[Ello] catalog-handles ${handlesRes.status} — leaving handles unset (fail open); try-on stays available instead of being disabled store-wide`);
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

        // Load per-product try-on image overrides before any catalog path runs,
        // so the override map is ready when detectCurrentProduct() resolves the
        // garment at try-on time. Tiny query (only products that HAVE an override).
        await loadImageOverrides(
            storeConfig.storeSlug || storeConfig.storeId ||
            window.ELLO_STORE_SLUG || window.ELLO_STORE_ID
        );


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

        // Persistence: repaint this shopper's saved try-on onto the hero if they
        // already tried this product on (hero-swap stores). Fire-and-forget — it
        // awaits the wardrobe internally and never blocks the catalog load.
        elloMaybeRestorePdpSwap();

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
                // Merchant-selected try-on image takes priority; falls back to the
                // featured image (image_url) when no override is set. NULL override
                // => identical to previous behavior, so this is fully backward-compatible.
                image_url: item.image_override_url || item.image_url,
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
// ─── Per-product try-on image overrides ──────────────────────────────────────
// Merchants can pick which product image the try-on renders from (dashboard →
// clothing_items.image_override_url). The PDP try-on garment can come from several
// data sources (bootstrap edge fn, /api/widget-preview, full clothing_items load),
// and the two fast paths fetch the featured image straight from Shopify and never
// read clothing_items. So we load a small map of overrides once and apply it at the
// single chokepoint every try-on passes through: detectCurrentProduct().
// Keyed by BOTH the full GID and the numeric id so it matches whatever id form a
// product object happens to carry. NULL/empty override => no entry => featured image.
window.elloImageOverrides = window.elloImageOverrides || null;

async function loadImageOverrides(storeSlug) {
    if (!storeSlug) return;
    try {
        const url = `${SUPABASE_URL}/rest/v1/clothing_items?store_id=eq.${encodeURIComponent(storeSlug)}&image_override_url=not.is.null&select=item_id,image_override_url`;
        const res = await fetch(url, {
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            },
        });
        if (!res.ok) return;
        const rows = await res.json();
        const map = new Map();
        (rows || []).forEach(r => {
            if (!r || !r.image_override_url) return;
            const gid = String(r.item_id);
            map.set(gid, r.image_override_url);
            const numeric = gid.split('/').pop();
            if (numeric) map.set(numeric, r.image_override_url);
        });
        window.elloImageOverrides = map;
        elloLog(`Ello: loaded ${map.size} image-override keys`);
    } catch (e) {
        // Non-fatal — without the map, try-on simply falls back to the featured image.
        console.warn('[Ello] image override load failed:', e);
    }
}

// Resolve a product's try-on image: if the merchant chose an override for it,
// swap product.image_url to that. Safe no-op when no map / no match.
function applyImageOverride(product) {
    const map = window.elloImageOverrides;
    if (!product || !map || map.size === 0) return product;
    const candidates = [
        product.shopify_product_id,
        product.shopify_product_gid,
        product.id,
        (typeof getProductId === 'function' ? getProductId(product) : null),
    ].filter(Boolean).map(String);
    for (const key of candidates) {
        const ov = map.get(key);
        if (ov) {
            product.image_url = ov;
            break;
        }
    }
    return product;
}

// ============================================================================
// FOOTWEAR PDP CONTEXT (shoe try-on support)
// ============================================================================
// Footwear is filtered OUT of sampleClothing by isClothingItem, so a shoe PDP
// can never be recognized through the catalog. These helpers detect "the
// shopper is on a footwear product page" from page-level signals instead, so
// the upload UX, the body check, and the /tryon productType can adapt.
// PDP-only by design: browse/cross-sell rails stay clothing-only.

// Mirrors the ELLO_DEMO_BUCKETS 'footwear' word set, plus common shoe styles.
var ELLO_FOOTWEAR_KEYWORDS = [
    'shoe', 'shoes', 'sneaker', 'sneakers', 'boot', 'boots', 'heel', 'heels',
    'sandal', 'sandals', 'loafer', 'loafers', 'slipper', 'slippers', 'trainer',
    'trainers', 'cleat', 'cleats', 'mule', 'mules', 'slide', 'slides',
    'flip flop', 'flip-flop', 'flip flops', 'clog', 'clogs', 'footwear',
    'oxford', 'oxfords', 'pump', 'pumps', 'stiletto', 'stilettos', 'wedge',
    'wedges', 'espadrille', 'moccasin'
];
// Apparel that CONTAINS a footwear substring but isn't footwear — a "bootcut
// jean" must never read as a boot. Conservative: a false negative just means
// today's clothing behavior, so err toward NOT flagging.
var ELLO_FOOTWEAR_FALSE_POSITIVES = ['boot cut', 'bootcut', 'boot-cut', 'board short', 'boardshort', 'bootleg'];

// Apparel words that VETO a footwear match anywhere in the text. "Oxford
// Shirt", "Trainer Jacket", "Slide Shorts", "Waist Trainer", "Boot Socks" are
// all clothing despite containing a footwear word. Veto beats footwear BY
// DESIGN: a missed shoe PDP just keeps today's clothing behavior, while a
// false footwear flip would relax the body check and rewrite the upload copy
// on an apparel product (adversarial review finding, 2026-07-12).
var ELLO_FOOTWEAR_APPAREL_VETO = [
    'shirt', 'shirts', 'tee', 'tees', 't-shirt', 't-shirts', 'tshirt', 'tshirts',
    'blouse', 'polo', 'tank', 'jacket', 'jackets', 'coat', 'coats', 'hoodie',
    'hoodies', 'sweater', 'sweaters', 'sweatshirt', 'sweatshirts', 'cardigan',
    'vest', 'shorts', 'pant', 'pants', 'jean', 'jeans', 'denim', 'legging',
    'leggings', 'jogger', 'joggers', 'sweatpants', 'chino', 'chinos', 'trouser',
    'trousers', 'skirt', 'skirts', 'sock', 'socks', 'hosiery', 'tights',
    'stocking', 'stockings', 'bra', 'bralette', 'shapewear', 'waist', 'bodysuit',
    'romper', 'jumpsuit', 'cover', 'pajama', 'pajamas', 'pyjama', 'pyjamas',
    'robe', 'underwear', 'brief', 'briefs', 'boxer', 'boxers', 'camisole',
    'corset', 'gown', 'gowns', 'dress', 'dresses'
];

function elloTextIsFootwear(text) {
    if (!text) return false;
    var t = ' ' + String(text).toLowerCase() + ' ';
    for (var i = 0; i < ELLO_FOOTWEAR_FALSE_POSITIVES.length; i++) {
        if (t.indexOf(ELLO_FOOTWEAR_FALSE_POSITIVES[i]) !== -1) return false;
    }
    // "Dress shoes" / "dress boots" ARE footwear — consume the bigram so the
    // standalone 'dress' veto below can't kill them ("Wedge Dress" still vetoes).
    t = t.replace(/dress(es)?[\s-]+(shoe|boot|sandal|pump|loafer|heel|sneaker|flat)(s?)/g, '$2$3');
    for (var k = 0; k < ELLO_FOOTWEAR_APPAREL_VETO.length; k++) {
        var v = ELLO_FOOTWEAR_APPAREL_VETO[k].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp('(^|[^a-z])' + v + '([^a-z]|$)').test(t)) return false;
    }
    for (var j = 0; j < ELLO_FOOTWEAR_KEYWORDS.length; j++) {
        var w = ELLO_FOOTWEAR_KEYWORDS[j].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp('(^|[^a-z])' + w + '([^a-z]|$)').test(t)) return true;
    }
    return false;
}

// True when the CURRENT PDP product is footwear. Type-first (Shopify
// product_type is usually clean — "Shoes", "Sneakers"; titles are noisy).
// Only a TRUE result is cached: the signals arrive over time (analytics meta,
// elloSelectedGarment), so an early false answer must stay re-checkable.
// The cache is PATH-KEYED: SPA/AJAX navigation changes location.pathname, so
// a sneaker→dress client-side nav self-invalidates on the next call — no
// dependency on the preview feature's history listeners (which are gated off
// on mobile / preview-disabled stores).
// Kill switch: style_overrides {"footwear_tryon_enabled": false} (wired in
// applyStyleOverrides — 1 SQL, no redeploy) or window.ELLO_FOOTWEAR_TRYON =
// false from the console / a theme snippet. Checked BEFORE the cache read so
// flipping it off wins even after the context latched true.
var __elloFootwearContext = null;
var __elloFootwearContextPath = null;
function elloIsFootwearContext() {
    if (window.ELLO_FOOTWEAR_TRYON === false) return false;
    if (__elloFootwearContext === true && __elloFootwearContextPath === window.location.pathname) return true;
    var result = false;
    try {
        // 1. Shopify analytics meta — present on most PDPs, independent of sampleClothing.
        var metaType = window.ShopifyAnalytics && window.ShopifyAnalytics.meta &&
            window.ShopifyAnalytics.meta.product && window.ShopifyAnalytics.meta.product.type;
        if (elloTextIsFootwear(metaType)) result = true;

        // 2. The selected garment — but ONLY when it demonstrably IS the current
        //    page's product. elloSelectedGarment survives SPA navigation, so a
        //    shoe garment from the previous page must not vouch for this one.
        if (!result && window.elloSelectedGarment && elloGarmentMatchesCurrentPage(window.elloSelectedGarment)) {
            var g = window.elloSelectedGarment;
            var gtags = Array.isArray(g.tags) ? g.tags.join(' ') : (g.tags || '');
            if (elloTextIsFootwear([g.category, g.product_type, g.name, g.title, gtags].join(' '))) result = true;
        }

        // 3. og:title fallback (same last resort detectCurrentProduct uses).
        if (!result) {
            var ogTitleEl = document.querySelector('meta[property="og:title"]');
            if (ogTitleEl && elloTextIsFootwear(ogTitleEl.getAttribute('content'))) result = true;
        }
    } catch (e) { /* never let detection throw */ }
    if (result) {
        __elloFootwearContext = true;
        __elloFootwearContextPath = window.location.pathname;
    }
    return result;
}

// Does this garment belong to the page we're on right now? Matches by handle
// (catalog garments use the handle as id) or by the product_url the og-fallback
// stamps at detect time. Conservative: unknown → false (the garment then simply
// doesn't vouch for page-level footwear context; signals 1 and 3 still can).
function elloGarmentMatchesCurrentPage(g) {
    try {
        var path = window.location.pathname;
        var handle = (typeof getProductIdFromUrl === 'function' ? getProductIdFromUrl(path) : null);
        if (handle && (g.id === handle || g.handle === handle)) return true;
        if (g.product_url) {
            var gp = String(g.product_url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
            if (gp && gp === path) return true;
        }
    } catch (e) { /* fall through */ }
    return false;
}

// productType for the /tryon payload. Belt-and-suspenders over the og-fallback
// fix in detectCurrentProduct, scoped to isFallback ONLY: og-fallback garments
// are the one case with lost type metadata, and they ARE the page product, so
// the page's ShopifyAnalytics type belongs to them by construction. Catalog /
// browse-rail garments always carry their real Shopify type and must NEVER be
// relabeled from page-level signals (adversarial review finding: an "Oxford
// Shirt" picked from the rail on a sneaker PDP was previously sent as the
// page's "Sneakers" type).
function elloResolveTryonProductType(garment) {
    var resolved = garment?.category || garment?.product_type || null;
    if (window.ELLO_FOOTWEAR_TRYON === false) return resolved;
    if (!garment || garment.isFallback !== true) return resolved;
    if (!resolved || resolved === 'clothing' || resolved === 'apparel') {
        try {
            var gTags = Array.isArray(garment.tags) ? garment.tags.join(' ') : '';
            if (elloTextIsFootwear([garment.name, garment.title, gTags].filter(Boolean).join(' '))) {
                resolved = (window.ShopifyAnalytics && window.ShopifyAnalytics.meta &&
                    window.ShopifyAnalytics.meta.product && window.ShopifyAnalytics.meta.product.type) || 'shoes';
            }
        } catch (e) { /* fall through with the original value */ }
    }
    return resolved;
}

// Apply the upload copy for the CURRENT context — footwear gets feet-oriented
// wording, everything else gets (or gets BACK) the stock clothing copy. Two-way
// on purpose: SPA route changes (sneaker PDP → dress PDP) and late-arriving
// signals (consent-gated ShopifyAnalytics) must both converge on the right
// copy, so this is safe to call repeatedly. Null-safe — never breaks init.
function elloApplyFootwearUploadCopy() {
    try {
        var fw = elloIsFootwearContext();
        var instruction = document.querySelector('.photo-instruction');
        if (instruction) {
            instruction.textContent = fw
                ? 'Upload a photo with your feet visible to get started'
                : 'Upload full body image to get started';
        }
        var uploadArea = document.querySelector('.photo-upload');
        var uploadText = uploadArea && uploadArea.querySelector('.upload-text:not(#changePhotoText)');
        if (uploadText) {
            uploadText.textContent = fw
                ? (isMobile ? 'Tap to upload a photo with your feet visible' : 'Click to upload a photo with your feet visible')
                : (isMobile ? 'Tap to upload full body image' : 'Click to upload full body image');
        }
    } catch (e) { /* copy tweak must never break init */ }
}

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
                // Real Shopify product type when available — footwear PDPs ALWAYS
                // land on this fallback (isClothingItem filters shoes out of
                // sampleClothing), and a hardcoded 'clothing' here used to reach
                // the engine as productType, downgrading its prompt from "a pair
                // of shoes" to a generic "a garment".
                var ogMetaType = (window.ShopifyAnalytics && window.ShopifyAnalytics.meta &&
                    window.ShopifyAnalytics.meta.product && window.ShopifyAnalytics.meta.product.type) || '';
                // Construct temporary product
                product = {
                    id: productHandle || 'unknown-product', // fallback ID
                    name: ogTitle,
                    title: ogTitle, // Add title for compatibility
                    image_url: ogImage,
                    variants: [],
                    category: (ogMetaType || 'clothing').toLowerCase(),
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
        // Apply the merchant's chosen try-on image (if any) before the garment is used.
        return applyImageOverride(product);
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
        // NOTE: the wardrobe is deliberately NOT trimmed here anymore — it
        // lives uncapped in IndexedDB and a shopper's try-ons must never
        // disappear. Only transient localStorage payloads get cleaned below.

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
    // Footwear PDPs are exempt from the hard rejection — MoveNet keys on
    // shoulders+hips, so a legs-and-feet close-up (exactly what shoes need)
    // reads as "no body" and would wrongly clear the photo.
    var footwear = elloIsFootwearContext();
    detectBodyInImage(imageDataUrl).then((bodyResult) => {
        if (!isActivePhotoValidation(photoId)) {
            return;
        }

        if (bodyResult && bodyResult.state === 'reject') {
            if (footwear) {
                // Feet/legs close-ups have no torso to detect — accept, don't clear.
                activePhotoValidationStatus = 'valid';
                showSuccessNotification('Quality Tips',
                    'For shoes, make sure your feet are fully in the photo.', 4000, false);
                return;
            }
            rejectActivePhotoAfterBodyCheck(photoId);
            return;
        }

        activePhotoValidationStatus = 'valid';

        if (bodyResult && bodyResult.state === 'warning' && bodyResult.message) {
            // The stock warning copy says "shoulders to hips" — wrong ask for
            // footwear, where feet-in-frame is what actually matters.
            var msg = footwear ? 'For best results, keep your feet fully in frame.' : bodyResult.message;
            showSuccessNotification('Quality Tips', msg, 4000, false);
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
// Attribution window. This id ties a try-on to a later purchase — the join is
// tryon_events.session_id ↔ purchase_events.session_id, and the Web Pixel reads
// the id from the cookie below at checkout. It MUST survive as long as that
// cookie or a shopper who tries on Monday and buys Thursday goes UNCREDITED.
// So the localStorage lifetime and the cookie max-age are one constant, and the
// window SLIDES: any visit refreshes it, so an active shopper never rotates
// mid-consideration. (Was 30 min, which silently minted a fresh id — and
// overwrote the 7-day cookie — on the return visit, destroying attribution for
// every delayed purchase. That was Ello's own commission leaking.)
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;         // 7 days
const SESSION_TIMEOUT_MS = SESSION_MAX_AGE_SECONDS * 1000; // keep in lockstep with the cookie

let sessionId = null;

try {
    const existing = window.localStorage.getItem(ELLO_SESSION_KEY);
    const lastActive = parseInt(window.localStorage.getItem(ELLO_SESSION_TS_KEY) || '0', 10);
    const now = Date.now();

    // Reuse the existing id while it's inside the sliding attribution window;
    // only mint a new one after a full window of inactivity (or first ever visit).
    if (existing && now - lastActive < SESSION_TIMEOUT_MS) {
        sessionId = existing;
    } else {
        sessionId = generateSessionId();
        window.localStorage.setItem(ELLO_SESSION_KEY, sessionId);
    }
    // Slide the window forward on every load.
    window.localStorage.setItem(ELLO_SESSION_TS_KEY, now.toString());
} catch (e) {
    console.warn('⚠️ localStorage blocked, using ephemeral session ID:', e);
    // Adopt the loader's ephemeral id when it minted one (A/B experiments mint
    // in widget-loader.js) — two independent ephemeral ids would break the
    // exposure ↔ try-on ↔ purchase joins for storage-blocked browsers.
    sessionId = window.__elloLoaderSessionId || generateSessionId();
}

// Mirror the id into a cookie the Web Pixel can read (pixels can't touch
// localStorage). Same lifetime as the localStorage window above, refreshed on
// every load so it slides in lockstep — the cookie can never outlive or
// undercut the id it carries.
try {
    document.cookie = `ello_session_id=${sessionId}; path=/; max-age=${SESSION_MAX_AGE_SECONDS}; SameSite=Lax`;
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

// Persist the attribution id as a CART attribute so it rides through to
// checkout.attributes even when the shopper never touches an Ello button —
// e.g. they try on with Ello, then add to cart with the THEME'S native button,
// or check out through a cart-based wallet flow. The cookie is the primary
// carrier; this is the belt-and-suspenders that survives cookie loss/rotation
// across devices sharing a cart. Best-effort and idempotent: writing it to an
// empty cart is fine — Shopify carries the attribute forward once items land,
// and re-writing the same value is a no-op. Skipped in the local dev harness
// (its /cart/update.js is a mock) to avoid noise.
var __elloCartAttrWritten = false;
function elloWriteSessionCartAttr() {
    try {
        if (!window.ELLO_SESSION_ID) return;
        if (__elloCartAttrWritten) return;         // once per page is plenty
        __elloCartAttrWritten = true;
        fetch('/cart/update.js', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ attributes: { ello_session_id: window.ELLO_SESSION_ID } })
        }).catch(function () { __elloCartAttrWritten = false; });  // allow a later retry
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
let browserCategoryFilter = 'all'; // active category-chip filter in the collection browser

// --- Analytics State & Context ---
const WIDGET_VERSION = '2.4.1';
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

    // NOTE: we intentionally do NOT touch document.body's classList here.
    // Earlier versions added/removed a generic `is-mobile` class on the
    // merchant's <body> — a name plenty of themes use for their own state,
    // so toggling it could break theme CSS/JS. Nothing in the widget ever
    // read the class (the isMobile JS variable is the source of truth).

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

            // Don't remove the input on a fixed timer — the native iOS picker
            // often stays open >1s while the shopper browses albums, and detaching
            // it mid-pick dropped the change event so the confirmed photo silently
            // vanished. Leave it attached (hidden, harmless, GC'd on page reload).
            setTimeout(() => { newCameraInput.click(); }, 100);
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

            // See proceedWithTakePicture: never remove on a fixed timer (it dropped
            // slow iOS picks). Leave the input attached — hidden + harmless.
            setTimeout(() => { newPhotoInput.click(); }, 100);
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
// 2026-07-13 (Andrew): the tips/consent modal no longer gates the upload flow —
// it forced every first upload through an interstitial and sat inside the
// 22s-median post-CTA gauntlet (31% CTA→upload loss). ToS/Privacy consent moved
// to a passive notice at the upload entry points ("By uploading a photo, you
// agree…"), and the tips content stays available behind the opt-in "Tips for
// the best results" link (openPhotoTips). Returning false keeps every former
// gate site on its direct-to-picker branch; flip this back to the localStorage
// check to restore the forced modal.
function checkShouldShowBestPractices() {
    return false;
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

// Opt-in entry to the tips modal (the "Tips for the best results" link). The
// modal never opens on its own anymore, so this is its only trigger — tracked
// so we can see how many shoppers are actually curious.
function openPhotoTips(source) {
    trackEvent('photo_tips_open', { source: source || 'unknown' });
    showBestPracticesModal();
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

                    // Never remove on a fixed timer (dropped slow iOS picks); leave
                    // the throwaway input attached — hidden + harmless.
                    setTimeout(() => { newPhotoInput.click(); }, 100);
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

                    // Never remove on a fixed timer (dropped slow iOS picks); leave
                    // the throwaway input attached — hidden + harmless.
                    setTimeout(() => { newPhotoInput.click(); }, 100);
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

                // Never remove on a fixed timer (dropped slow iOS picks); leave the
                // throwaway input attached — hidden + harmless.
                setTimeout(() => { newPhotoInput.click(); }, 100);
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
    if (bodyScrollLocked) return; // already locked by an outer open — don't re-capture scrollY
    bodyScrollLocked = true;

    // Freeze the page at its current offset with position:fixed on <body> — the
    // only technique iOS Safari reliably honors (overflow:hidden / the touchmove
    // guard alone let in-widget gestures scroll-chain to the background). We set
    // top:-savedScrollY so the page does NOT visually move (a real jump is what
    // snaps the iOS address bar / flickers the widget); window.scrollTo restores
    // the exact offset on unlock.
    savedScrollY = window.scrollY || window.pageYOffset || 0;
    const lb = document.body;
    lb.style.position = 'fixed';
    lb.style.top = '-' + savedScrollY + 'px';
    lb.style.left = '0';
    lb.style.right = '0';
    lb.style.width = '100%';
    lb.style.overflow = 'hidden';

    // Belt-and-suspenders: still block any touchmove that lands OUTSIDE the widget
    // so the frozen page can't be nudged. In-widget scrollers keep working;
    // .tryon-content sets overscroll-behavior:contain to stop edge-chaining.
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
    if (!bodyScrollLocked) return;
    bodyScrollLocked = false;

    // Un-freeze the body and restore the exact scroll offset the page was at.
    const ub = document.body;
    ub.style.position = '';
    ub.style.top = '';
    ub.style.left = '';
    ub.style.right = '';
    ub.style.width = '';
    ub.style.overflow = '';

    // Remove touch handler
    if (scrollLockTouchHandler) {
        document.removeEventListener('touchmove', scrollLockTouchHandler);
        scrollLockTouchHandler = null;
    }

    window.scrollTo(0, savedScrollY);
}

// Inline auto-fire fast path: when a returning shopper clicks the inline
// "Try It On" button and already has a saved photo, we go straight to the
// try-on call without any manual interaction. To avoid a flash of the
// upload/workspace screen (and a blank product card in the loading overlay),
// this resolves the PDP garment synchronously, seeds elloSelectedGarment, and
// starts the garment image fetch BEFORE the loading overlay is shown.
//
// Returns true only when a usable garment image was resolved — the caller uses
// this to decide whether it's safe to paint the loading overlay immediately
// (if no product resolves, the auto-fire in openWidget's setTimeout would never
// fire startTryOn, so we must not leave a stuck loading overlay on screen).
function primeInlineLoadingGarment() {
    const currentProduct = detectCurrentProduct();
    const garmentUrl = currentProduct && currentProduct.image_url;
    if (!garmentUrl) return false;

    // Seed elloSelectedGarment if it isn't already populated with a usable
    // image. Mirrors the exact shape populateFeaturedAndQuickPicks() sets so
    // startTryOn() and Add-to-Cart see consistent data; the async populate path
    // enriches this (variants, price) moments later.
    if (!window.elloSelectedGarment || !window.elloSelectedGarment.image_url) {
        selectedClothing = currentProduct.id;
        window.elloSelectedGarment = {
            image_url: garmentUrl,
            ...currentProduct,
            selectedVariantId: currentProduct.variants?.[0]?.shopify_variant_gid || null
        };
    }

    // Paint both cards onto the loading overlay now (it's still hidden) so the
    // garment image fetch is already in flight by the time the overlay appears.
    const root = document.getElementById('tryOnLoadingBar');
    if (root) {
        setTryOnLoadingImage(root.querySelector('[data-loading-product]'), window.elloSelectedGarment.image_url);
        setTryOnLoadingImage(root.querySelector('[data-loading-person]'), window.elloUserImageUrl || userPhoto || '');
    }
    return true;
}

// Clears any leftover result-stage UI so RE-opening the panel (e.g. tapping the
// inline "Try it on" again while a previous result is still on screen) starts
// from a clean workspace instead of stacking the new view on top of the old
// result — the overlap bug. Mirrors closeWidget's teardown, plus hides the
// previous result image/section. Idempotent: a no-op on a first/clean open.
function resetInlineResultState() {
    const widget = document.getElementById('virtualTryonWidget');
    if (widget) widget.classList.remove('inline-mode-result-ready', 'inline-mode-cart-success');
    ['ello-inline-result-ctas', 'ello-inline-cart-success', 'ello-tryon-result'].forEach(function (id) {
        const el = document.getElementById(id);
        if (el) el.remove();
    });
    document.querySelectorAll('.buy-now-container, .tryon-attribution').forEach(function (el) { el.remove(); });
    const resultSection = document.getElementById('resultSection');
    if (resultSection) resultSection.style.display = 'none';
}

function openWidget() {
    // Reset analytics state for this widget view
    hadMeaningfulAction = false;

    // Re-resolve the upload copy for the CURRENT page. Detection signals can
    // arrive after init (consent-gated analytics) and SPA navigation swaps the
    // product under us — every open is the reliable moment to converge, and
    // this works even on stores where the preview history listeners are gated
    // off. Cheap and idempotent.
    elloApplyFootwearUploadCopy();

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
    // Defensive guard: on an unfamiliar theme the shell may be absent or
    // injected late. Bail loudly instead of throwing on widget.classList below,
    // so a launcher-less open (inline button / fitting-room hub) fails safe.
    if (!widget) {
        console.warn('[Ello] try-on shell (#virtualTryonWidget) not found — open aborted');
        return;
    }

    // Start every open from a clean slate — clears any result/CTAs left over
    // from a previous try-on so re-opening (inline "Try it on" again) never
    // stacks the new workspace on top of the old result.
    resetInlineResultState();

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
    // Hub mode keeps the focused PDP layout but un-hides Browse Full Collection +
    // Wardrobe (the doors the floating widget already has) — see the CSS override
    // in ensureInlineModeStyles().
    widget.classList.toggle('ello-pdp-hub', elloPdpHubModeOn() || window.ELLO_FOCUSED_MODE === true);
    // Launcher-less open (inline "Try On" button, Fitting Room full panel, or a
    // hub deep-link) — clear the floating-bubble kill-switch display:none so the
    // panel opens even when the merchant has the bubble turned off (the default
    // for the launcher-less setup). Without this the click is a silent no-op on
    // every store with the floating widget disabled.
    if (window.ELLO_INLINE_MODE || window.ELLO_LAUNCHERLESS || (typeof __elloPdpSwap !== 'undefined' && __elloPdpSwap && __elloPdpSwap.hidWidget)) {
        widget.style.removeProperty('display');
        if (typeof __elloPdpSwap !== 'undefined' && __elloPdpSwap) __elloPdpSwap.hidWidget = false;
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

    // ─── Inline auto-fire fast path (returning shopper, photo already saved) ──
    // This open is going straight to try-on (see auto-fire path A below), so
    // paint the full-cover loading overlay NOW — before the upload/workspace
    // screen ever renders — so the shopper never sees a flash of the "Change
    // Photo / Try On" UI. primeInlineLoadingGarment() also seeds the garment so
    // the product card isn't blank when the overlay appears. Only do this once
    // we've confirmed a garment resolved; otherwise the setTimeout auto-fire
    // below wouldn't run and we'd be left with a stuck loading overlay.
    if (window.ELLO_INLINE_MODE && window.ELLO_AUTO_FIRE && userPhoto && window.elloUserImageUrl && !elloPdpHubModeOn()) {
        if (primeInlineLoadingGarment()) {
            showLoadingBar(true);
        }
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
                    if (elloPdpHubModeOn()) {
                        // Hub mode: a returning shopper (saved photo) lands on the
                        // home — their photo + the product + a "Try it on" button —
                        // instead of auto-firing. They may want to browse, check
                        // their wardrobe, or change their photo first. First-time
                        // shoppers (no saved photo) still auto-fire after upload via
                        // the upload handler (path B), keeping the one-tap magic.
                        window.ELLO_AUTO_FIRE = false;
                    } else {
                        window.ELLO_AUTO_FIRE = false;
                        setTimeout(() => { typeof startTryOn === 'function' && startTryOn(); }, 50);
                    }
                }
            }

            // Update wardrobe button count
            updateWardrobeButton();

            // 🎯 Focus management - focus on first interactive element.
            // Skip in hub mode: the panel opens behind the Collection/Wardrobe
            // modal, so focusing the panel would steal focus from the modal.
            if (!window.ELLO_HUB_MODE) {
                const firstFocusableElement = widget.querySelector('button, input, select, [tabindex]:not([tabindex="-1"])');
                if (firstFocusableElement) {
                    firstFocusableElement.focus();
                }
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

    // Capture inline-mode before we clear it below — the minimize path needs
    // to know whether this open came from the inline button to decide if the
    // bubble should reappear or stay hidden (see applyMinimizedVisual).
    const wasInlineMode = window.ELLO_INLINE_MODE === true;
    // Any launcher-less open (inline button, Fitting Room full panel, hub) must
    // re-hide the bubble on close so a bubble-off store is left clean.
    const wasLauncherless = wasInlineMode || window.ELLO_LAUNCHERLESS === true;
    window.ELLO_LAUNCHERLESS = false;

    // Clear inline-mode state. If the shopper re-opens via the floating
    // bubble next, we want them to land in the full browse UX — not in the
    // focused PDP experience that was tied to the previous inline click.
    if (window.ELLO_INLINE_MODE) {
        window.ELLO_INLINE_MODE = false;
        window.ELLO_INLINE_CTX = null;
        window.ELLO_AUTO_FIRE = false; // cancel any pending auto-fire
        widget.classList.remove('inline-mode');
    }

    // Clear fitting-room hub state so the next open isn't treated as a hub
    // session, and strip the hub switch from the modal headers so a later
    // floating-widget open of those modals is clean.
    if (typeof elloTeardownHubChrome === 'function') elloTeardownHubChrome();
    window.ELLO_HUB_MODE = false;
    window.ELLO_FOCUSED_MODE = false;
    window.__elloHubKeepOpen = false;

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
        // If this open came from the inline button on a store where the
        // floating bubble is disabled for this page type, don't strand a
        // minimized bubble in the corner — re-hide so closing inline try-on
        // returns the page to its bubble-less state. Inline !important beats
        // .widget-minimized's display:flex !important.
        if (wasLauncherless) {
            const cfg = window.ELLO_STORE_CONFIG || {};
            const onPdp = window.location.pathname.includes('/products/');
            const floatingOff =
                (onPdp && cfg.floatingWidgetPdpEnabled === false) ||
                (!onPdp && cfg.floatingWidgetNonPdpEnabled === false);
            if (floatingOff) widget.style.setProperty('display', 'none', 'important');
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

    // Photo cleared → allow the upload cards to show again (removes the hide
    // added by updatePhotoPreview).
    var elloWidgetEl2 = document.getElementById('virtualTryonWidget');
    if (elloWidgetEl2) elloWidgetEl2.classList.remove('has-user-photo');

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

// The 7 sample-model photos used to be inlined here as base64 (~400KB, ~65% of
// widget-main.js) and downloaded on EVERY product-page view. They now live in a
// separate chunk (model-images.js) loaded on demand the first time a shopper opens
// the model browser. Thumbnails render straight from the asset URL (an <img> needs
// no CORS); the base64 is only needed for the /tryon payload, so we fetch the chunk
// lazily and read window.__elloModelImages[id] at selection time.
let _elloModelImagesPromise = null;
function elloModelAssetUrl(relPath) {
    const base = String(window.ELLO_WIDGET_BASE_URL || '').replace(/\/+$/, '');
    const rel = String(relPath || '').replace(/^\/+/, '');
    return base ? base + '/' + rel : rel;
}
function ensureModelImagesLoaded() {
    if (window.__elloModelImages) return Promise.resolve(window.__elloModelImages);
    if (_elloModelImagesPromise) return _elloModelImagesPromise;
    _elloModelImagesPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        // Script tags load cross-origin without CORS, so this works from any merchant
        // domain even though the front door serves assets without ACAO headers.
        s.src = elloModelAssetUrl('model-images.js') + '?v=' + WIDGET_VERSION;
        s.async = true;
        s.onload = () => resolve(window.__elloModelImages || {});
        s.onerror = () => { _elloModelImagesPromise = null; reject(new Error('model-images load failed')); };
        document.head.appendChild(s);
    });
    return _elloModelImagesPromise;
}

const SAMPLE_MODELS = [
    {
        "id": "model_1",
        "name": "Model 1",
        "url": "assets/models/model_1.jpg",
        "gender": "male",
    },
    {
        "id": "model_2",
        "name": "Model 2",
        "url": "assets/models/model_2.jpg",
        "gender": "female",
    },
    {
        "id": "model_3",
        "name": "Model 3",
        "url": "assets/models/model_3.jpg",
        "gender": "male",
    },
    {
        "id": "model_4",
        "name": "Model 4",
        "url": "assets/models/model_4.jpg",
        "gender": "female",
    },
    {
        "id": "model_5",
        "name": "Model 5",
        "url": "assets/models/model_5.jpg",
        "gender": "male",
    },
    {
        "id": "model_6",
        "name": "Model 6",
        "url": "assets/models/model_6.jpg",
        "gender": "male",
    },
    {
        "id": "model_7",
        "name": "Model 7",
        "url": "assets/models/model_7.jpg",
        "gender": "female",
    }
];

/**
 * Sample models visible to this store's shoppers. style_overrides
 * {"sample_model_gender": "female"} (or "male") restricts the model browser
 * to that gender — single-gender stores don't want the other half of the
 * roster. Absent/unknown values (or a filter that would empty the grid)
 * show everyone.
 */
function elloVisibleSampleModels() {
    var so = window.ELLO_STORE_CONFIG && window.ELLO_STORE_CONFIG.styleOverrides;
    var g = so && so.sample_model_gender;
    if (g !== 'female' && g !== 'male') return SAMPLE_MODELS;
    var filtered = SAMPLE_MODELS.filter(function (m) { return m.gender === g; });
    return filtered.length ? filtered : SAMPLE_MODELS;
}

function populateModelBrowser() {
    elloLog("👉 Populating Model Browser...");
    const grid = document.getElementById('modelBrowserGrid');
    if (!grid) {
        console.error("❌ modelBrowserGrid not found");
        return;
    }

    grid.innerHTML = '';
    // Start fetching the base64 chunk now (fire-and-forget) so it's ready by the time
    // the shopper actually picks a model. Thumbnails don't need it — they load from URL.
    ensureModelImagesLoaded().catch(() => {});
    elloVisibleSampleModels().forEach(model => {
        const card = document.createElement('div');
        card.className = 'browser-clothing-card';
        card.onclick = () => selectModel(model.id);
        card.innerHTML = `
            <div class="browser-image-wrap">
                <img src="${elloModelAssetUrl(model.url)}" alt="${model.name}" loading="lazy" onload="this.classList.add('loaded')">
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

    // The base64 needed for the /tryon payload lives in the lazily-loaded
    // model-images chunk now. Show the URL as an instant preview, then resolve the
    // base64 (usually already cached from the prefetch on model-browser open).
    updatePhotoPreview(elloModelAssetUrl(model.url));
    let base64 = null;
    try {
        const images = await ensureModelImagesLoaded();
        base64 = images && images[model.id];
    } catch (e) {
        console.error("❌ Model images failed to load", e);
    }

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

        // Focused view: repaint the stage so the chosen model lands on the
        // "You" card and the copy flips off "Add photo" — mirrors the
        // photo-upload hook (no-op outside focused mode).
        if (typeof elloSetupFocusedExtras === 'function') elloSetupFocusedExtras();

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
            <div class="quick-pick-item" onclick="__elloWidget.selectClothing('${item.id}')">
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
        uploadText.textContent = elloIsFootwearContext()
            ? (isMobile ? 'Tap to upload a photo with your feet visible' : 'Click to upload a photo with your feet visible')
            : (isMobile ? 'Tap to upload full body image' : 'Click to upload full body image');
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
        btn.innerHTML = '<span>🚫</span>Try-On Limit Reached';
        btn.classList.add('rate-limited');
        btn.classList.remove('processing');
        btn.title = "You've reached this store's try-on limit.";
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

            // Focused view: repaint the stage so the fresh photo lands on the
            // "You" card and the copy flips from "Add photo" to "Change photo"
            // (no-op outside focused mode).
            if (typeof elloSetupFocusedExtras === 'function') elloSetupFocusedExtras();

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
                setTimeout(() => { typeof startTryOn === 'function' && startTryOn(); }, 100);
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
            // Use the image's true intrinsic dimensions for aspect-ratio checks.
            const naturalWidth = img.naturalWidth || img.width;
            const naturalHeight = img.naturalHeight || img.height;

            // Downscale to a small thumbnail before reading pixels. We only need
            // average brightness/contrast, which a thumbnail measures just as well.
            // Drawing the full-resolution photo onto a canvas hits iOS Safari's
            // canvas-area limit (~16.7M px), which silently returns an all-zero
            // (black) pixel buffer — producing false "too dark" / "insufficient
            // contrast" errors on large phone photos. Capping the canvas size
            // avoids that limit entirely and makes the result deterministic.
            const MAX_ANALYSIS_DIM = 512;
            const scale = Math.min(1, MAX_ANALYSIS_DIM / Math.max(naturalWidth, naturalHeight));
            const sampleWidth = Math.max(1, Math.round(naturalWidth * scale));
            const sampleHeight = Math.max(1, Math.round(naturalHeight * scale));

            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = sampleWidth;
            canvas.height = sampleHeight;

            ctx.drawImage(img, 0, 0, sampleWidth, sampleHeight);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const pixels = imageData.data;

            // Calculate aspect ratio from the true intrinsic dimensions.
            const aspectRatio = naturalWidth / naturalHeight;
            const isPortrait = naturalHeight > naturalWidth;
            const widthHeightRatio = naturalWidth / naturalHeight;

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
                width: naturalWidth,
                height: naturalHeight,
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
        // Couldn't read the pixels back (transient canvas/decode failure on
        // mobile — the classic "fails first attempt, works second"). Don't block
        // the upload: accept the photo and let the try-on proceed. Body detection
        // (run separately) is the real backstop for unusable photos.
        return {
            isValid: true,
            error: null,
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

    // Brightness and contrast are advisory only — they NEVER reject a photo.
    // The canvas pixel readback misfires on mobile (decode races, iOS canvas
    // limits) and returns a false all-black buffer, which used to flag well-lit
    // photos as "too dark" / "insufficient contrast" and reset the upload. Andrew's
    // call: accept the photo and start the try-on. Surface only gentle tips.
    if (analysis.brightness < 0.25 || analysis.brightness > 0.8) {
        warnings.push('Lighting could be improved for better results.');
    }

    if (analysis.contrast < 0.1) {
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

    // A photo exists → mark the widget so the inline-mode CSS hides the upload
    // cards entirely (inline mode forces them display:block !important, which
    // otherwise overrides the inline style above — that's the "Add your photo"
    // card showing next to the photo they already uploaded).
    var elloWidgetEl = document.getElementById('virtualTryonWidget');
    if (elloWidgetEl) elloWidgetEl.classList.add('has-user-photo');

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
    // In the Fitting Room hub, match the Wardrobe surface — no dark page
    // blackout behind the panel. Standalone (non-hub) use keeps the dimmer.
    if (window.ELLO_HUB_MODE) {
        backdrop.classList.remove('active');
    } else {
        backdrop.classList.add('active');
    }
    document.body.style.overflow = 'hidden';

    // Reset pagination + filters
    browserCurrentPage = 1;
    browserCategoryFilter = 'all';
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

    // Fitting-room hub: the collection IS the hub's main surface, so dismissing
    // it closes the whole hub (and re-hides any bubble). Suppressed while
    // switching tabs (elloHubSwitch) or picking an item to try on
    // (selectClothingFromBrowser), which set __elloHubKeepOpen.
    if (window.ELLO_HUB_MODE && !window.__elloHubKeepOpen) {
        closeWidget();
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

    // Build the category chips from the loaded catalog, then apply the active
    // category + search filters and render the grid.
    elloRenderCategoryChips();
    applyBrowserFilters();
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

    document.querySelectorAll('.epc-card').forEach(card => {
        card.classList.remove('is-selected');
    });

    const __clickedCard = event && event.target && event.target.closest('.epc-card');
    if (__clickedCard) __clickedCard.classList.add('is-selected');

    // Update preview
    updateSelectedClothingPreview(clothingId);

    // In hub mode, picking a garment should advance into try-on, NOT close the
    // whole hub. Guard the close so closeClothingBrowser() doesn't full-close.
    window.__elloHubKeepOpen = true;
    closeClothingBrowser();
    window.__elloHubKeepOpen = false;

    // updateTryOnButton handles the button state
    updateTryOnButton();

    // Scroll to the preview to ensure user sees their selection
    const preview = document.getElementById('selectedClothingPreview');
    if (preview) {
        // Ensure it's visible (updateSelectedClothingPreview sets display:block, but just in case)
        preview.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// Debounced so filtering a large catalog doesn't re-run on every keystroke.
let __epcSearchTimer = null;
function handleBrowserSearch() {
    clearTimeout(__epcSearchTimer);
    __epcSearchTimer = setTimeout(__epcRunSearch, 160);
}

function __epcRunSearch() {
    // The search box and the active category chip apply together.
    applyBrowserFilters();
}

// ── Category filter chips ───────────────────────────────────────────────────
// Map each product into a clean shopping bucket from its type / tags / name so a
// thousands-product catalog is browsable by category instead of one endless wall.
// Best-effort keyword buckets (first match wins; order minimizes overlap). Quality
// rides on the merchant's product data — anything unmatched lands in "Other".
const ELLO_BROWSE_BUCKETS = [
    { key: 'dresses',     label: 'Dresses',     kw: ['dress', 'gown', 'romper', 'jumpsuit', 'frock', 'bodycon'] },
    { key: 'outerwear',   label: 'Outerwear',   kw: ['jacket', 'coat', 'blazer', 'parka', 'trench', 'windbreaker', 'poncho', 'overcoat', 'puffer'] },
    { key: 'shoes',       label: 'Shoes',       kw: ['shoe', 'sneaker', 'boot', 'sandal', 'heel', 'loafer', 'footwear', 'slipper'] },
    { key: 'accessories', label: 'Accessories', kw: ['hat', 'cap', 'beanie', 'beret', 'bag', 'purse', 'tote', 'backpack', 'scarf', 'belt', 'glove', 'sunglass', 'glasses', 'jewel', 'necklace', 'earring', 'bracelet', 'watch', 'sock', 'headband'] },
    { key: 'swim',        label: 'Swim',        kw: ['swim', 'bikini', 'bathing', 'trunks'] },
    { key: 'bottoms',     label: 'Bottoms',     kw: ['pant', 'trouser', 'jean', 'denim', 'legging', 'shorts', 'skirt', 'jogger', 'sweatpant', 'chino', 'culotte', 'cargo', 'slacks'] },
    { key: 'tops',        label: 'Tops',        kw: ['top', 'tee', 't-shirt', 'tshirt', 'shirt', 'blouse', 'tank', 'cami', 'sweater', 'sweatshirt', 'hoodie', 'jumper', 'pullover', 'knit', 'cardigan', 'crop', 'bodysuit', 'polo', 'henley', 'turtleneck'] }
];

function elloProductBucket(item) {
    if (!item) return 'other';
    const hay = ((item.category || '') + ' ' + (item.name || '') + ' ' + ((item.tags || []).join(' '))).toLowerCase();
    for (let i = 0; i < ELLO_BROWSE_BUCKETS.length; i++) {
        const kws = ELLO_BROWSE_BUCKETS[i].kw;
        for (let j = 0; j < kws.length; j++) {
            if (hay.indexOf(kws[j]) !== -1) return ELLO_BROWSE_BUCKETS[i].key;
        }
    }
    return 'other';
}

// ─── Complete the Look: complementary recommender (Increment 1) ──────────────
// V1 = MERCHANT-CURATED ONLY. Reads the merchant's hand-picked complementary
// products from Shopify's free Search & Discovery app via the native AJAX
// recommendations endpoint. No algorithm guesses pairings — a bad auto-pick can
// suppress AOV and cheapen the brand. No curation → returns [] → no rail.
//
// Returns a ranked (curation-order) array of try-on-able, GID-resolvable,
// in-stock items in sampleClothing shape. Async + non-blocking: callers prefetch
// it during the first try-on's generation and must tolerate [].
async function elloPickComplementary(garmentA, limit) {
    limit = limit || 10;
    var aId = garmentA && (garmentA.shopify_product_id || garmentA.shopify_product_gid || garmentA.id);
    // The AJAX endpoint needs the numeric Shopify product id; a handle won't resolve.
    var numericA = aId ? String(aId).replace(/^gid:\/\/shopify\/Product\//, '') : '';

    // DEMO ONLY (sales screen-recordings on a prospect store): the tried-on
    // garment often comes from detectCurrentProduct's og-tag fallback, which
    // carries no numeric Shopify product id — so the recommender can't run. When
    // the demo bookmarklet is active (__ELLO_DEMO__), recover the id from the live
    // PDP. Never runs for a real shopper on a real install.
    if (!/^\d+$/.test(numericA) && window.__ELLO_DEMO__ === true) {
        numericA = await elloDemoResolveNumericProductId(garmentA);
    }
    if (!/^\d+$/.test(numericA)) return [];

    // Respect locale-prefixed roots (/en-us/…) when Shopify exposes them.
    var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
    var base = root.charAt(root.length - 1) === '/' ? root : root + '/';

    // 0) DEMO ONLY: an explicit pinned pairing (window.__ELLO_DEMO_CTL_HANDLE__,
    //    set via __elloDemo.pairWith('<handle>')). Lets Andrew script the exact
    //    "try on the whole set" outfit in a recording (top → its matching shorts)
    //    instead of relying on the category guess. Highest priority; skipped if it
    //    points at the tried-on product itself.
    if (window.__ELLO_DEMO__ === true && window.__ELLO_DEMO_CTL_HANDLE__) {
        var pinned = await elloDemoPinnedComplementary(base, garmentA);
        if (pinned.length) return pinned;
    }

    // 1) Merchant-curated complementary (Search & Discovery). The only source on
    //    a real install — a hand-picked pairing is on-brand and intended.
    var out = await elloFetchRecommendations(base, 'complementary', numericA, limit);

    // 2) DEMO-ONLY graceful fallback. A prospect store has no curated pairings,
    //    so complementary returns [] and Complete the Look would never render in a
    //    demo. Instead of grabbing "related" items (which are almost always the SAME
    //    kind — a shirt next to another shirt, which never reads as an outfit), we
    //    classify the tried-on garment and pick a COMPLEMENTARY category from the
    //    store's own catalog (top→bottom, dress→jacket/shoes, accessory→top, …).
    //    Gated on __ELLO_DEMO__ so a real shopper on a real store NEVER sees an
    //    un-curated auto-pick (the whole reason V1 is curated-only: a bad auto-
    //    pairing cheapens the brand).
    if (!out.length && window.__ELLO_DEMO__ === true) {
        out = await elloDemoComplementaryByCategory(base, garmentA, numericA, limit);
    }
    return out;
}

// Fetch + map + gate the Shopify AJAX recommendations endpoint for one intent
// ('complementary' | 'related'). Shared by the curated path and the demo fallback.
async function elloFetchRecommendations(base, intent, numericId, limit) {
    var url = base + 'recommendations/products.json?intent=' + encodeURIComponent(intent) +
              '&limit=' + encodeURIComponent(limit) + '&product_id=' + encodeURIComponent(numericId);
    try {
        var res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) return [];
        var data = await res.json();
        return elloFilterRecProducts((data && data.products) || [], numericId);
    } catch (e) {
        return []; // network / parse failure → no rail, never breaks the try-on
    }
}

// Map a list of AJAX-recommendations products to try-on-able sampleClothing items,
// applying the same gates the curated path always used: in stock, GID-resolvable
// (attribution needs it), layer-able clothing, and not the tried-on product itself.
function elloFilterRecProducts(products, excludeNumericId) {
    var out = [];
    for (var i = 0; i < products.length; i++) {
        var p = products[i];
        if (!p || !p.handle) continue;
        if (excludeNumericId && String(p.id) === String(excludeNumericId)) continue;
        // Stock: use the endpoint's fresh availability, not the in-memory copy.
        var available = (p.available !== false) &&
            (Array.isArray(p.variants) ? p.variants.some(function (v) { return v.available !== false; }) : true);
        if (!available) continue;
        var item = elloMapRecToItem(p);
        if (!item) continue;
        // Attribution-critical: a handle-only item never matches the pixel GID.
        if (!(item.shopify_product_gid || item.shopify_product_id)) continue;
        // Must be layer-able clothing (same gate the rest of the widget uses).
        if (!isClothingItem(item)) continue;
        out.push(item);
    }
    return out;
}

// DEMO-ONLY: resolve the current PDP product's numeric Shopify id from live page
// data when the garment lacks one (the og-tag fallback path). Tries the analytics
// meta object first (synchronous, present on most Shopify PDPs), then the product
// JSON. Never runs for a real shopper — gated by the caller on __ELLO_DEMO__.
async function elloDemoResolveNumericProductId(garmentA) {
    try {
        var metaId = window.ShopifyAnalytics && window.ShopifyAnalytics.meta &&
                     window.ShopifyAnalytics.meta.product && window.ShopifyAnalytics.meta.product.id;
        if (metaId && /^\d+$/.test(String(metaId))) return String(metaId);
    } catch (e) {}
    try {
        var handle = (garmentA && (garmentA.handle || garmentA.id)) ||
                     (typeof getProductIdFromUrl === 'function' ? getProductIdFromUrl(window.location.pathname) : null);
        if (handle) {
            var json = await elloFetchProductJson(handle);
            if (json && json.id && /^\d+$/.test(String(json.id))) return String(json.id);
        }
    } catch (e) {}
    return '';
}

// DEMO-ONLY outfit pairing. Given the tried-on garment's category, prefer an item
// from a COMPLEMENTARY category so the rail reads like an outfit, not a duplicate.
// e.g. a top pairs with a bottom first; a dress pairs with outerwear/shoes; an
// accessory pairs with a top. Never runs for a real shopper.
var ELLO_DEMO_PAIRING = {
    top:       ['bottom', 'footwear', 'outerwear', 'accessory'],
    bottom:    ['top', 'footwear', 'outerwear', 'accessory'],
    dress:     ['outerwear', 'footwear', 'accessory'],
    outerwear: ['top', 'bottom', 'footwear'],
    footwear:  ['bottom', 'top', 'dress'],
    accessory: ['top', 'bottom', 'dress'],
    // Unclassified is most often a top, so complement with a bottom first and put
    // top LAST — never answer a mystery top with another top.
    other:     ['bottom', 'footwear', 'accessory', 'dress', 'outerwear', 'top']
};

// Keyword sets checked IN THIS ORDER so compound names resolve sensibly:
// "dress shirt"→top (via 'shirt', before 'dress'), "bikini bottom"→bottom.
var ELLO_DEMO_BUCKETS = [
    ['footwear',  ['shoe', 'shoes', 'sneaker', 'sneakers', 'boot', 'boots', 'heel', 'heels', 'sandal', 'sandals', 'loafer', 'loafers', 'slipper', 'slippers', 'trainer', 'trainers', 'cleat', 'cleats', 'mule', 'mules', 'slide', 'slides', 'flip flop', 'flip-flop', 'flip flops', 'clog', 'clogs', 'footwear']],
    ['accessory', ['hat', 'cap', 'caps', 'beanie', 'visor', 'bag', 'bags', 'backpack', 'purse', 'tote', 'clutch', 'wallet', 'scarf', 'scarves', 'belt', 'belts', 'sunglasses', 'glasses', 'watch', 'watches', 'jewelry', 'necklace', 'bracelet', 'earring', 'earrings', 'glove', 'gloves', 'sock', 'socks', 'headband', 'bandana', 'mitten', 'mittens', 'scrunchie', 'keychain']],
    ['outerwear', ['jacket', 'jackets', 'coat', 'coats', 'blazer', 'parka', 'windbreaker', 'bomber', 'puffer', 'trench', 'overcoat', 'raincoat', 'anorak', 'poncho', 'cardigan', 'vest', 'shacket', 'peacoat', 'pea coat', 'gilet', 'overshirt']],
    ['bottom',    ['pant', 'pants', 'trouser', 'trousers', 'jean', 'jeans', 'denim', 'short', 'shorts', 'skirt', 'skirts', 'skort', 'legging', 'leggings', 'jogger', 'joggers', 'sweatpant', 'sweatpants', 'sweatshort', 'cargo', 'cargos', 'chino', 'chinos', 'culotte', 'culottes', 'capri', 'capris', 'brief', 'briefs', 'boxer', 'boxers', 'bottom', 'bottoms', 'tights', 'biker short', 'bike short', 'board short', 'boardshort', 'wide leg', 'wide-leg', 'flare', 'bootcut', 'palazzo', 'slacks']],
    ['top',       ['shirt', 'shirts', 'tee', 'tees', 't-shirt', 'tshirt', 'tank', 'tanks', 'top', 'tops', 'sweater', 'sweaters', 'hoodie', 'hoodies', 'sweatshirt', 'blouse', 'polo', 'jersey', 'crop', 'cami', 'camisole', 'bra', 'bralette', 'tube', 'turtleneck', 'henley', 'pullover', 'longsleeve', 'long sleeve', 'long-sleeve', 'quarter zip', 'quarter-zip', 'quarterzip', '1/4 zip', 'half zip', 'half-zip', 'zip-up', 'zip up', 'fleece', 'crewneck', 'crew neck', 'mockneck', 'mock neck', 'flannel', 'raglan', 'thermal', 'baselayer', 'base layer', 'compression', 'rashguard', 'rash guard', 'muscle tee', 'corset', 'bustier', 'peplum']],
    ['dress',     ['dress', 'dresses', 'gown', 'gowns', 'romper', 'rompers', 'jumpsuit', 'jumpsuits', 'bodysuit', 'overalls', 'unitard', 'leotard', 'onesie', 'kaftan', 'sundress']]
];

// Classify a product/garment into an outfit slot. Reads name + type + tags with
// WORD-BOUNDARY matching so "spring" can't match "ring", "laptop" can't match "top".
function elloDemoCategoryBucket(x) {
    if (!x) return 'other';
    var name = (x.name || x.title || '').toLowerCase();
    var type = (x.category || x.type || x.product_type || '').toLowerCase();
    var tags = Array.isArray(x.tags) ? x.tags.join(' ').toLowerCase() : String(x.tags || '').toLowerCase();
    var text = ' ' + name + ' ' + type + ' ' + tags + ' ';
    for (var i = 0; i < ELLO_DEMO_BUCKETS.length; i++) {
        var bucket = ELLO_DEMO_BUCKETS[i][0], words = ELLO_DEMO_BUCKETS[i][1];
        for (var j = 0; j < words.length; j++) {
            var w = words[j].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp('(^|[^a-z])' + w + '([^a-z]|$)').test(text)) return bucket;
        }
    }
    return 'other';
}

// Fetch + normalize the store's product list to the recommendations shape (cents
// prices, `type`, `featured_image`) so elloMapRecToItem can consume it.
async function elloDemoFetchCatalog(base) {
    try {
        var res = await fetch(base + 'products.json?limit=250', { headers: { 'Accept': 'application/json' } });
        if (!res.ok) return [];
        var data = await res.json();
        var products = (data && Array.isArray(data.products)) ? data.products : [];
        return products.map(function (p) {
            var variants = (Array.isArray(p.variants) ? p.variants : []).map(function (v) {
                return { id: v.id, title: v.title, price: Math.round(parseFloat(v.price || '0') * 100), available: v.available !== false };
            });
            var img = (Array.isArray(p.images) && p.images[0] && (p.images[0].src || p.images[0])) || '';
            return {
                id: p.id, handle: p.handle, title: p.title, type: p.product_type,
                tags: Array.isArray(p.tags) ? p.tags : [],
                price: variants[0] ? variants[0].price : 0,
                featured_image: img, images: img ? [img] : [],
                available: variants.some(function (v) { return v.available; }),
                variants: variants
            };
        });
    } catch (e) { return []; }
}

async function elloDemoComplementaryByCategory(base, garmentA, excludeNumericId, limit) {
    var products = await elloDemoFetchCatalog(base);
    if (!products.length) return [];

    // Try-on-able clothing pool (same gates as the curated path), tagged by bucket.
    var pool = [];
    for (var i = 0; i < products.length; i++) {
        var p = products[i];
        if (excludeNumericId && String(p.id) === String(excludeNumericId)) continue;
        var available = (p.available !== false) &&
            (Array.isArray(p.variants) ? p.variants.some(function (v) { return v.available !== false; }) : true);
        if (!available) continue;
        var item = elloMapRecToItem(p);
        if (!item) continue;
        if (!(item.shopify_product_gid || item.shopify_product_id)) continue;
        if (!isClothingItem(item)) continue;
        item.__bucket = elloDemoCategoryBucket(item);
        pool.push(item);
    }
    if (!pool.length) return [];

    var baseBucket = elloDemoCategoryBucket(garmentA);
    var targets = ELLO_DEMO_PAIRING[baseBucket] || ELLO_DEMO_PAIRING.other;

    // Walk the pairing priority: first complementary category with stock wins.
    for (var t = 0; t < targets.length; t++) {
        var tgt = targets[t];
        var picks = pool.filter(function (it) { return it.__bucket === tgt; });
        if (picks.length) return picks.slice(0, limit);
    }
    // No preferred category in stock → anything that isn't the SAME kind as the base.
    var different = pool.filter(function (it) { return it.__bucket !== baseBucket; });
    if (different.length) return different.slice(0, limit);
    return pool.slice(0, limit);
}

// Map a recommendations/products.json product to the widget's sampleClothing
// shape. Prefer an existing in-memory entry (full widget metadata); else build
// one from the endpoint response (it carries handle/type/tags/images/variants).
function elloMapRecToItem(p) {
    if (!p || !p.handle) return null;
    var existing = (typeof sampleClothing !== 'undefined' && Array.isArray(sampleClothing))
        ? sampleClothing.find(function (c) {
            return c.id === p.handle ||
                   c.handle === p.handle ||
                   (c.shopify_product_id != null && String(c.shopify_product_id) === String(p.id));
        })
        : null;
    if (existing) return existing;

    // AJAX product JSON prices are in CENTS (integers) — mirror the
    // /products/{handle}.js lazy-load (widget-main.js:9516). Variant price is a
    // dollars STRING to match that shape; item price is a Number for display.
    var variants = (Array.isArray(p.variants) ? p.variants : []).map(function (v) {
        return {
            id: v.id,
            shopify_variant_gid: 'gid://shopify/ProductVariant/' + v.id,
            title: v.title,
            price: (Number(v.price) / 100).toFixed(2),
            size: v.title,
            available: v.available !== false
        };
    });
    var img = p.featured_image || (Array.isArray(p.images) && p.images[0]) || '';
    return {
        id: p.handle,
        handle: p.handle,
        name: p.title,
        price: isNaN(Number(p.price)) ? 0 : Number(p.price) / 100,
        category: (p.type || '').toLowerCase() || 'clothing',
        tags: Array.isArray(p.tags) ? p.tags : [],
        color: '',
        image_url: typeof img === 'string' ? img : (img && img.src) || '',
        product_url: '/products/' + p.handle,
        shopify_product_id: p.id,
        shopify_product_gid: 'gid://shopify/Product/' + p.id,
        data_source: 'shopify_recommendations',
        variants: variants
    };
}

// DEMO-ONLY: build the complementary item from an explicitly pinned handle
// (set via __elloDemo.pairWith('<handle>') → window.__ELLO_DEMO_CTL_HANDLE__).
// Fetches /products/<handle>.js, maps it, and returns it as the single offer —
// bypassing the category heuristic so a recording shows the EXACT set Andrew
// intends. Requires in-stock + a resolvable GID (attribution); the deliberate
// pin skips the isClothingItem category gate (Andrew picked it on purpose).
async function elloDemoPinnedComplementary(base, garmentA) {
    try {
        var handle = String(window.__ELLO_DEMO_CTL_HANDLE__ || '').trim().replace(/^\/+|\/+$/g, '');
        if (!handle) return [];
        // Never suggest the item they're already trying on.
        var aHandle = garmentA && (garmentA.handle || garmentA.id);
        if (aHandle && String(aHandle) === handle) return [];
        var res = await fetch(base + 'products/' + encodeURIComponent(handle) + '.js', { headers: { 'Accept': 'application/json' } });
        if (!res.ok) return [];
        var p = await res.json();
        if (!p || !p.handle) return [];
        var available = (p.available !== false) &&
            (Array.isArray(p.variants) ? p.variants.some(function (v) { return v.available !== false; }) : true);
        if (!available) return [];
        var item = elloMapRecToItem(p);
        if (!item) return [];
        // Server /tryon fetches the garment image, so a protocol-relative
        // //cdn.shopify.com URL (what /products/{handle}.js returns) must be
        // absolutized or the fetch has no scheme.
        if (item.image_url && item.image_url.indexOf('//') === 0) item.image_url = 'https:' + item.image_url;
        if (!(item.shopify_product_gid || item.shopify_product_id)) return [];
        return [item];
    } catch (e) {
        return []; // never break the try-on over a pin
    }
}

// Exposed for dev-console verification (Increment 1).
window.elloPickComplementary = elloPickComplementary;

// ─── Complete the Look: in-widget styling rail (Increment 2) ─────────────────
// Renders INSIDE the widget popup's result view (#resultSection), under the
// result image + the inline CTAs — NOT injected into the merchant's theme. Stays
// fully within Ello's chrome so it works across themes and stays on-brand.
// On-brand: the "Try on" chip + accents pull the merchant's configured colors.
function elloEnsureCtlStyles() {
    if (document.getElementById('ello-ctl-styles')) return;
    var c = window.ELLO_STORE_CONFIG || {};
    var primary = c.inlineButtonColor || c.widgetPrimaryColor || '#111111';
    var primaryText = c.inlineButtonTextColor || '#ffffff';
    var accent = c.widgetAccentColor || primary;
    var fontStack = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
    var s = document.createElement('style');
    s.id = 'ello-ctl-styles';
    s.textContent =
        '#ello-ctl-rail{max-width:420px;margin:6px auto 2px;padding:14px 12px 2px;border-top:1px solid #ededed;animation:elloCtlIn .35s ease both;}' +
        '@keyframes elloCtlIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}' +
        '#ello-ctl-rail .ello-ctl-head{display:flex;align-items:baseline;justify-content:space-between;margin:0 0 10px;}' +
        '#ello-ctl-rail .ello-ctl-title{font:600 14px/1 ' + fontStack + ';color:#111;display:flex;align-items:center;gap:6px;}' +
        '#ello-ctl-rail .ello-ctl-title svg{color:' + accent + ';}' +
        '#ello-ctl-rail .ello-ctl-sub{font:500 11px/1 ' + fontStack + ';color:#9a9a9a;letter-spacing:.02em;}' +
        '#ello-ctl-rail .ello-ctl-card{display:flex;gap:12px;align-items:center;border:1px solid #ececec;border-radius:12px;padding:10px;background:#fff;}' +
        '#ello-ctl-rail .ello-ctl-thumb{width:60px;height:80px;border-radius:8px;object-fit:contain;background:#f4f4f4;flex:0 0 auto;}' +
        '#ello-ctl-rail .ello-ctl-info{flex:1 1 auto;min-width:0;}' +
        '#ello-ctl-rail .ello-ctl-name{font:600 13px/1.3 ' + fontStack + ';color:#111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        '#ello-ctl-rail .ello-ctl-price{font:500 13px/1.3 ' + fontStack + ';color:#555;margin-top:2px;}' +
        '#ello-ctl-rail .ello-ctl-try{flex:0 0 auto;border:none;border-radius:999px;padding:9px 15px;font:600 13px/1 ' + fontStack + ';cursor:pointer;background:' + primary + ';color:' + primaryText + ';display:flex;align-items:center;gap:5px;transition:opacity .15s;}' +
        '#ello-ctl-rail .ello-ctl-try:hover{opacity:.88;}' +
        '#ello-ctl-rail .ello-ctl-try:disabled{opacity:.55;cursor:wait;}' +
        // "Both" state: two thumbs + a full-width Add-both button (mirrors the
        // hero panel's morph so both surfaces feel like one feature).
        '#ello-ctl-rail .ello-ctl-thumbs{display:flex;gap:6px;flex:0 0 auto;}' +
        '#ello-ctl-rail .ello-ctl-thumbs img{width:44px;height:58px;border-radius:7px;object-fit:contain;background:#f4f4f4;}' +
        '#ello-ctl-rail .ello-ctl-add{box-sizing:border-box;width:100%;margin-top:10px;border:none;border-radius:10px;padding:12px;font:600 14px/1 ' + fontStack + ';cursor:pointer;background:' + primary + ';color:' + primaryText + ';display:flex;align-items:center;justify-content:center;gap:7px;transition:opacity .15s;}' +
        '#ello-ctl-rail .ello-ctl-add:hover{opacity:.9;}' +
        '#ello-ctl-rail .ello-ctl-add:disabled{opacity:.6;cursor:wait;}' +
        '#ello-ctl-rail .ello-ctl-msg{margin-top:8px;font:500 12px/1.4 ' + fontStack + ';text-align:center;display:none;}' +
        '#ello-ctl-rail .ello-ctl-msg.err{color:#b91c1c;display:block;}' +
        '#ello-ctl-rail .ello-ctl-link{display:block;width:100%;margin-top:8px;text-align:center;font:600 13px/1 ' + fontStack + ';color:#111;background:transparent;border:1px solid #d8d8d8;border-radius:10px;padding:11px;cursor:pointer;}';
    document.head.appendChild(s);
}

// ─── Complete the Look: image peek (shared by rail + hero card) ──────────────
// The offer thumb stays deliberately small so the card never crowds the result
// the shopper is looking at. Visibility comes from three layers instead:
// (1) a right-sized Shopify CDN rendition shown UN-cropped (contain, not
// cover — a 46×60 cover-crop of a full-body product shot reads as "fabric",
// not "the jeans"), (2) a hover preview that fades in on pointer devices,
// (3) a tap-to-view lightbox on every device.

// Size a Shopify CDN image via its width param (3× the display size keeps
// retina thumbs sharp). Non-Shopify URLs (Supabase overrides, og-scrapes)
// pass through untouched. Never mutates item.image_url — variant
// color-matching (elloResolveCartVariantForItem) reads the original object.
function elloCtlImgUrl(url, px) {
    try {
        var u = String(url || '');
        if (!u) return u;
        if (!/\/\/cdn\.shopify\.com\//.test(u) && u.indexOf('/cdn/shop/') === -1) return u;
        u = u.replace(/([?&])width=\d+&?/, '$1').replace(/[?&]$/, '');
        return u + (u.indexOf('?') === -1 ? '?' : '&') + 'width=' + px;
    } catch (e) { return url; }
}

function elloEnsureCtlPeekStyles() {
    if (document.getElementById('ello-ctl-peek-styles')) return;
    var f = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
    var s = document.createElement('style');
    s.id = 'ello-ctl-peek-styles';
    s.textContent =
        '.ello-ctl-peekable{cursor:zoom-in;}' +
        // Hover preview: pointer devices only. Pure fade-and-lift, and never
        // interactive (pointer-events:none) so it can't trap the cursor.
        '#ello-ctl-hoverpeek{position:fixed;z-index:2147483647;pointer-events:none;opacity:0;transform:translateY(6px) scale(.98);transition:opacity .22s cubic-bezier(.2,.8,.2,1),transform .22s cubic-bezier(.2,.8,.2,1);will-change:opacity,transform;}' +
        '#ello-ctl-hoverpeek.on{opacity:1;transform:none;}' +
        '#ello-ctl-hoverpeek .ecp-card{width:212px;background:#fff;border:1px solid rgba(0,0,0,.06);border-radius:14px;padding:8px;box-shadow:0 4px 10px rgba(0,0,0,.06),0 18px 44px rgba(0,0,0,.16);}' +
        '#ello-ctl-hoverpeek .ecp-img{display:block;width:100%;height:250px;object-fit:contain;border-radius:9px;background:#f7f7f5;}' +
        '#ello-ctl-hoverpeek .ecp-cap{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:8px 3px 2px;}' +
        '#ello-ctl-hoverpeek .ecp-name{font:600 12px/1.3 ' + f + ';color:#111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        '#ello-ctl-hoverpeek .ecp-price{font:500 12px/1.3 ' + f + ';color:#666;flex:0 0 auto;}' +
        // Tap-to-view lightbox: frosted scrim + one quiet card. Tap anywhere
        // (or Esc) dismisses.
        '#ello-ctl-lightbox{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:22px;background:rgba(17,17,17,.45);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);opacity:0;transition:opacity .24s ease;cursor:zoom-out;}' +
        '#ello-ctl-lightbox.on{opacity:1;}' +
        '#ello-ctl-lightbox .ecl-card{position:relative;width:min(400px,92vw);background:#fff;border-radius:18px;padding:10px 10px 12px;box-shadow:0 30px 90px rgba(0,0,0,.35);transform:translateY(10px) scale(.97);transition:transform .24s cubic-bezier(.2,.8,.2,1);}' +
        '#ello-ctl-lightbox.on .ecl-card{transform:none;}' +
        '#ello-ctl-lightbox .ecl-img{display:block;width:100%;max-height:min(62vh,540px);object-fit:contain;border-radius:12px;background:#f7f7f5;}' +
        '#ello-ctl-lightbox .ecl-cap{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:10px 6px 0;}' +
        '#ello-ctl-lightbox .ecl-name{font:600 14px/1.35 ' + f + ';color:#111;}' +
        '#ello-ctl-lightbox .ecl-price{font:500 14px/1.35 ' + f + ';color:#666;flex:0 0 auto;}' +
        '#ello-ctl-lightbox .ecl-x{position:absolute;top:-13px;right:-13px;width:32px;height:32px;border:none;border-radius:50%;background:#fff;color:#111;box-shadow:0 4px 14px rgba(0,0,0,.22);display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;}' +
        '@media (max-width:640px){#ello-ctl-lightbox .ecl-x{top:6px;right:6px;background:rgba(255,255,255,.92);box-shadow:0 2px 8px rgba(0,0,0,.15);}}';
    document.head.appendChild(s);
}

var __elloCtlPeek = { hover: null, box: null, esc: null, hideScroll: null, prevOverflow: '' };

function elloCtlCanHover() {
    try { return window.matchMedia('(hover: hover) and (pointer: fine)').matches; } catch (e) { return false; }
}

function elloCtlShowHoverPeek(thumbEl, item) {
    try {
        if (!elloCtlCanHover() || !thumbEl || !item || __elloCtlPeek.box) return;
        elloEnsureCtlPeekStyles();
        var pop = __elloCtlPeek.hover;
        if (!pop) {
            pop = document.createElement('div');
            pop.id = 'ello-ctl-hoverpeek';
            pop.innerHTML = '<div class="ecp-card"><img class="ecp-img" alt="" decoding="async"><div class="ecp-cap"><span class="ecp-name"></span><span class="ecp-price"></span></div></div>';
            __elloCtlPeek.hover = pop;
        }
        pop.querySelector('.ecp-img').src = elloCtlImgUrl(item.image_url, 480);
        pop.querySelector('.ecp-name').textContent = item.name || '';
        pop.querySelector('.ecp-price').textContent = elloCtlNum(item.price) > 0 ? elloCtlMoney(item.price) : '';
        if (!pop.parentNode) document.body.appendChild(pop);
        pop.classList.remove('on');
        elloCtlPlaceHoverPeek(pop, thumbEl);
        requestAnimationFrame(function () { pop.classList.add('on'); });
        // Scrolling moves the anchor under a fixed pop — RE-ANCHOR rather than
        // hide: themes fire ambient scroll events constantly (capture-phase
        // catches inner scrollers too), and a hide-on-any-scroll kills the pop
        // the instant it appears. rAF-throttled; hides only when the thumb
        // actually leaves the viewport.
        var ticking = false;
        var onScroll = function () {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(function () {
                ticking = false;
                if (!pop.parentNode || !pop.classList.contains('on')) return;
                var tr = thumbEl.getBoundingClientRect();
                if (!tr.width || tr.bottom < 0 || tr.top > window.innerHeight) { elloCtlHideHoverPeek(); return; }
                elloCtlPlaceHoverPeek(pop, thumbEl);
            });
        };
        __elloCtlPeek.hideScroll = onScroll;
        window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    } catch (e) {}
}

// Position the pop above the thumb, clamped to the viewport; flip below when
// tight. offsetWidth/Height (not getBoundingClientRect) — the pop may be in
// its pre-fade scale(.98) state, which would shave the gap.
function elloCtlPlaceHoverPeek(pop, thumbEl) {
    var r = thumbEl.getBoundingClientRect();
    var pw = pop.offsetWidth, ph = pop.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), vw - pw - 8);
    var top = r.top - ph - 12;
    if (top < 8) top = Math.min(r.bottom + 12, vh - ph - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
}

function elloCtlHideHoverPeek() {
    if (__elloCtlPeek.hideScroll) {
        window.removeEventListener('scroll', __elloCtlPeek.hideScroll, { capture: true });
        __elloCtlPeek.hideScroll = null;
    }
    var pop = __elloCtlPeek.hover;
    if (!pop || !pop.parentNode) return;
    pop.classList.remove('on');
    setTimeout(function () { if (pop.parentNode && !pop.classList.contains('on')) pop.remove(); }, 240);
}

function elloCtlOpenPeekLightbox(item) {
    try {
        if (!item || !item.image_url) return;
        elloEnsureCtlPeekStyles();
        elloCtlHideHoverPeek();
        elloCtlClosePeekLightbox(true);          // instant, in case one is mid-fade
        var xIcon = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"></path></svg>';
        var box = document.createElement('div');
        box.id = 'ello-ctl-lightbox';
        box.innerHTML =
            '<div class="ecl-card">' +
                '<button type="button" class="ecl-x" aria-label="Close">' + xIcon + '</button>' +
                '<img class="ecl-img" alt="" decoding="async">' +
                '<div class="ecl-cap"><span class="ecl-name"></span><span class="ecl-price"></span></div>' +
            '</div>';
        box.querySelector('.ecl-img').src = elloCtlImgUrl(item.image_url, 1080);
        box.querySelector('.ecl-name').textContent = item.name || '';
        box.querySelector('.ecl-price').textContent = elloCtlNum(item.price) > 0 ? elloCtlMoney(item.price) : '';
        box.addEventListener('click', function () { elloCtlClosePeekLightbox(); });
        document.body.appendChild(box);
        __elloCtlPeek.box = box;
        __elloCtlPeek.prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        var esc = function (e) { if (e.key === 'Escape') elloCtlClosePeekLightbox(); };
        __elloCtlPeek.esc = esc;
        document.addEventListener('keydown', esc);
        requestAnimationFrame(function () { box.classList.add('on'); });
        try { if (typeof trackEvent === 'function') trackEvent('complete_the_look_peek', {}); } catch (e2) {}
    } catch (e) {}
}

function elloCtlClosePeekLightbox(instant) {
    if (__elloCtlPeek.esc) { document.removeEventListener('keydown', __elloCtlPeek.esc); __elloCtlPeek.esc = null; }
    var box = __elloCtlPeek.box;
    if (!box) return;
    __elloCtlPeek.box = null;
    document.body.style.overflow = __elloCtlPeek.prevOverflow || '';
    if (instant) { box.remove(); return; }
    box.classList.remove('on');
    setTimeout(function () { box.remove(); }, 260);
}

// Wire a rendered thumb: zoom-in cursor, hover preview (pointer devices),
// tap-to-view lightbox (every device). The click never bubbles — on the hero
// card an ancestor tap would reach the theme's click-to-zoom.
function elloCtlAttachPeek(imgEl, item) {
    if (!imgEl || !item || !item.image_url) return;
    elloEnsureCtlPeekStyles();
    imgEl.classList.add('ello-ctl-peekable');
    var open = function () { elloCtlOpenPeekLightbox(item); };
    imgEl.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        open();
    });
    // On the hero card the tap shield swallows in-panel clicks and re-invokes
    // the hit element's __elloTap directly — without this ref the thumb is
    // click-dead on shielded themes.
    imgEl.__elloTap = open;
    imgEl.addEventListener('mouseenter', function () { elloCtlShowHoverPeek(imgEl, item); });
    imgEl.addEventListener('mouseleave', elloCtlHideHoverPeek);
}

// In-widget upsell state (Scenario A) — mirrors __elloCtlB on the hero path.
// Snapshotted when the offer rail renders so the layer + add-both steps can't
// drift if the shopper changes product selection mid-flow.
var __elloCtlA = {
    garmentA: null, itemB: null, priceA: 0,
    triedOnVariantA: null, lastResultB64: null, layered: false
};

// Build + mount the rail for garmentA (the just-tried-on product). V1 surfaces
// ONE merchant-curated complementary item (cap=1). Async + best-effort: any
// failure or empty curation leaves NO rail and never disturbs the result.
// The "Try on" chip layers the item onto the current result (same re-base
// mechanic as addToOutfit), then the rail morphs to "Add both to cart".
async function elloRenderCompleteTheLook(garmentA) {
    try {
        if (!elloCompleteTheLookOn()) return;
        var resultSection = document.getElementById('resultSection');
        if (!resultSection) return;

        var items = await elloPickComplementary(garmentA, 10);
        if (!items || !items.length) return;   // no curation → no rail (intended)

        elloEnsureCtlStyles();
        elloTeardownCompleteTheLook();          // idempotent re-render

        var item = items[0];                    // cap=1 for V1
        var price = Number(item.price);
        var priceStr = isNaN(price) ? '' : '$' + price.toFixed(2);
        var sparkle = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"></path></svg>';
        var plus = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"></path></svg>';

        var rail = document.createElement('div');
        rail.id = 'ello-ctl-rail';
        rail.innerHTML =
            '<div class="ello-ctl-head">' +
                '<span class="ello-ctl-title">' + sparkle + 'Complete the look</span>' +
                '<span class="ello-ctl-sub">styled to go with this</span>' +
            '</div>' +
            '<div class="ello-ctl-card">' +
                '<img class="ello-ctl-thumb" src="' + elloCtlImgUrl(item.image_url || '', 240) + '" alt="" loading="lazy" decoding="async">' +
                '<div class="ello-ctl-info">' +
                    '<div class="ello-ctl-name"></div>' +
                    '<div class="ello-ctl-price"></div>' +
                '</div>' +
                '<button type="button" class="ello-ctl-try" id="ello-ctl-try-btn">' + plus + '<span>Try on</span></button>' +
            '</div>';
        // Set name/price as text (never innerHTML) so merchant product names can't inject markup.
        rail.querySelector('.ello-ctl-name').textContent = item.name || 'Complementary item';
        rail.querySelector('.ello-ctl-price').textContent = priceStr;
        elloCtlAttachPeek(rail.querySelector('.ello-ctl-thumb'), item);

        // Sit the rail ABOVE the Add-to-Cart CTAs (offer seen before the final buy).
        var ctas = document.getElementById('ello-inline-result-ctas');
        if (ctas && ctas.parentNode === resultSection) resultSection.insertBefore(rail, ctas);
        else resultSection.appendChild(rail);

        // Snapshot everything the layer + add-both steps need, frozen now so a
        // later selection change can't drift them, then arm the chip.
        __elloCtlA.garmentA = garmentA || null;
        __elloCtlA.triedOnVariantA = window.__elloTriedOnVariant || null;
        __elloCtlA.priceA = elloCtlNum(garmentA && garmentA.price);
        // Backfill A's price when the catalog price is missing (unsynced demo
        // stores) so the two-piece "Add both" total isn't understated. Resolves
        // before the shopper can tap "Try on" and reach the rail-both state.
        if (!(__elloCtlA.priceA > 0)) {
            elloResolveCtlPriceA(__elloCtlA.garmentA, __elloCtlA.triedOnVariantA, garmentA && garmentA.id)
                .then(function (p) { if (p > 0) __elloCtlA.priceA = p; });
        }
        __elloCtlA.itemB = item;
        __elloCtlA.layered = false;
        var tryBtn = rail.querySelector('#ello-ctl-try-btn');
        if (tryBtn) tryBtn.addEventListener('click', elloCtlLayerInWidget);
    } catch (e) {
        // Never let the upsell break the result the shopper is looking at.
        try { elloTeardownCompleteTheLook(); } catch (e2) {}
    }
}

function elloTeardownCompleteTheLook() {
    var r = document.getElementById('ello-ctl-rail');
    if (r) r.remove();
}

// Tap "Try on" in the rail → layer item B onto the current result (re-base on
// the photo already wearing A, exactly like addToOutfit) and re-run the try-on.
// The success path sees __elloCtlLayeringInWidget and morphs the rail.
function elloCtlLayerInWidget() {
    try {
        if (isTryOnProcessing) return;
        var base = __elloCtlA.lastResultB64;
        if (!base || !__elloCtlA.itemB) return;

        var btn = document.getElementById('ello-ctl-try-btn');
        if (btn) { btn.disabled = true; btn.innerHTML = '<span>Styling…</span>'; }

        window.__elloCtlLayeringInWidget = true;
        // Attribution: upsell try-on — tagged for the dashboard's proof layer.
        window.ELLO_PENDING_ENTRY_SOURCE = 'complete_the_look';
        // Beat the 1.5s duplicate-click debounce — this layer tap is intentional.
        window._lastTryOnTimestamp = 0;
        // Re-base on the previous result (person already wearing A).
        userPhoto = base;
        window.elloUserImageUrl = base;
        userPhotoFileId = 'ctla_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        activePhotoValidationId = userPhotoFileId;
        activePhotoValidationStatus = 'valid';
        lastRejectedPhotoValidationId = null;
        // The base render wears garment A — the layered save is an A+B outfit.
        if (__elloCtlA.garmentA) elloSetOutfitBase([__elloCtlA.garmentA]);
        // Layer garment B on top.
        window.elloSelectedGarment = __elloCtlA.itemB;

        startTryOn();
    } catch (e) {
        window.__elloCtlLayeringInWidget = false;
        try { if (__elloCtlA.garmentA) elloRenderCompleteTheLook(__elloCtlA.garmentA); } catch (e2) {}
    }
}

// Both state: "Your look · 2 pieces" + two thumbs + "Add both to cart · $total".
function elloRenderCtlRailBoth() {
    try {
        var resultSection = document.getElementById('resultSection');
        var A = __elloCtlA.garmentA, item = __elloCtlA.itemB;
        if (!resultSection || !A || !item) return;
        elloEnsureCtlStyles();
        elloTeardownCompleteTheLook();

        var total = elloCtlNum(__elloCtlA.priceA) + elloCtlNum(item.price);
        var rail = document.createElement('div');
        rail.id = 'ello-ctl-rail';
        rail.innerHTML =
            '<div class="ello-ctl-head">' +
                '<span class="ello-ctl-title">' + ELLO_CTL_SPARK + 'Your look · 2 pieces</span>' +
            '</div>' +
            '<div class="ello-ctl-card">' +
                '<div class="ello-ctl-thumbs">' +
                    '<img src="' + elloCtlImgUrl(A.image_url || '', 240) + '" alt="">' +
                    '<img src="' + elloCtlImgUrl(item.image_url || '', 240) + '" alt="">' +
                '</div>' +
                '<div class="ello-ctl-info">' +
                    '<div class="ello-ctl-name"></div>' +
                    '<div class="ello-ctl-price"></div>' +
                '</div>' +
            '</div>' +
            '<button type="button" class="ello-ctl-add" id="ello-ctl-add-btn">' + ELLO_CTL_BAG + '<span id="ello-ctl-add-lbl"></span></button>' +
            '<div class="ello-ctl-msg" id="ello-ctl-msg"></div>';
        rail.querySelector('.ello-ctl-name').textContent = (A.name || 'This item') + ' + ' + (item.name || 'the look');
        rail.querySelector('.ello-ctl-price').textContent = elloCtlMoney(total);
        var railThumbs = rail.querySelectorAll('.ello-ctl-thumbs img');
        if (railThumbs[0]) elloCtlAttachPeek(railThumbs[0], A);
        if (railThumbs[1]) elloCtlAttachPeek(railThumbs[1], item);
        rail.querySelector('#ello-ctl-add-lbl').textContent = 'Add both to cart · ' + elloCtlMoney(total);

        var ctas = document.getElementById('ello-inline-result-ctas');
        if (ctas && ctas.parentNode === resultSection) resultSection.insertBefore(rail, ctas);
        else resultSection.appendChild(rail);

        var addBtn = rail.querySelector('#ello-ctl-add-btn');
        if (addBtn) addBtn.addEventListener('click', elloAddOutfitToCartInWidget);
    } catch (e) { /* never break the result view */ }
}

function elloCtlRailError(msg) {
    var el = document.getElementById('ello-ctl-msg');
    if (el) { el.className = 'ello-ctl-msg err'; el.textContent = msg; }
}

// One-tap "Add both to cart" from the in-widget rail. Same money path as the
// hero panel (elloAddOutfitToCartB): resolve A with the frozen tried-on color
// hint + B fresh, dedupe A against the live cart, ONE multi-line /cart/add.js,
// track both lines, write the session cart attribute for attribution.
async function elloAddOutfitToCartInWidget() {
    var addBtn = document.getElementById('ello-ctl-add-btn');
    var lbl = document.getElementById('ello-ctl-add-lbl');
    var item = __elloCtlA.itemB, A = __elloCtlA.garmentA;
    if (!item) return;
    var restoreLbl = lbl ? lbl.textContent : '';
    if (addBtn) addBtn.disabled = true;
    if (lbl) lbl.textContent = 'Adding…';
    var msg = document.getElementById('ello-ctl-msg'); if (msg) msg.className = 'ello-ctl-msg';

    try {
        var vaRes = await elloCtlResolveVariantId(A, __elloCtlA.triedOnVariantA && __elloCtlA.triedOnVariantA.id);
        if (vaRes.cancelled) { if (addBtn) addBtn.disabled = false; if (lbl) lbl.textContent = restoreLbl; return; }
        var vbRes = await elloCtlResolveVariantId(item, null);
        if (vbRes.cancelled) { if (addBtn) addBtn.disabled = false; if (lbl) lbl.textContent = restoreLbl; return; }
        if (vbRes.soldOut) throw new Error((item.name || 'That piece') + ' is sold out.');

        var vA = vaRes.id || null;
        var vB = vbRes.id;

        var addedLine = false;
        if (vA) {
            try {
                var cart = await fetch('/cart.js', { headers: { 'Accept': 'application/json' } }).then(function (r) { return r.ok ? r.json() : null; });
                if (cart && Array.isArray(cart.items)) {
                    addedLine = cart.items.some(function (li) { return String(li.id) === String(vA) || String(li.variant_id) === String(vA); });
                }
            } catch (e) { /* if /cart.js fails, fall through and add both */ }
        }

        var items = [];
        if (vA && !addedLine) items.push({ id: vA, quantity: 1 });
        items.push({ id: vB, quantity: 1 });

        var res = await fetch('/cart/add.js', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ items: items })
        });
        if (!res.ok) {
            var eb = await res.json().catch(function () { return {}; });
            throw new Error(eb.description || eb.message || ("Couldn't add to cart (HTTP " + res.status + ")"));
        }

        try {
            if (vA && !addedLine && typeof trackEvent === 'function') trackEvent('inline_add_to_cart', { variant_id: vA });
            if (typeof trackEvent === 'function') trackEvent('inline_add_to_cart', { variant_id: vB });
            if (typeof trackEvent === 'function') trackEvent('complete_the_look_add', { variant_id: vB });
        } catch (e) {}
        try {
            if (window.ELLO_SESSION_ID) {
                await fetch('/cart/update.js', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ attributes: { ello_session_id: window.ELLO_SESSION_ID } })
                });
            }
        } catch (e) {}

        try { await elloRefreshThemeCart(); } catch (e) {}

        // Success state in the rail, and restore A as the page's selection.
        var rail = document.getElementById('ello-ctl-rail');
        if (rail) {
            rail.innerHTML =
                '<div class="ello-ctl-head" style="justify-content:center;color:#0a7d34;font-weight:var(--ello-fw-600, 600);">✓&nbsp;<span>Added to cart</span></div>' +
                '<button type="button" class="ello-ctl-link" id="ello-ctl-viewcart">View cart</button>';
            var vc = rail.querySelector('#ello-ctl-viewcart');
            if (vc) vc.addEventListener('click', function () {
                try { window.top.location.href = '/cart'; } catch (e) { window.location.href = '/cart'; }
            });
        }
        if (A) window.elloSelectedGarment = A;
    } catch (err) {
        if (addBtn) addBtn.disabled = false;
        if (lbl) lbl.textContent = restoreLbl;
        elloCtlRailError(err && err.message ? err.message : "Sorry, something went wrong adding to cart.");
    }
}

window.elloRenderCompleteTheLook = elloRenderCompleteTheLook;
window.elloCtlAttachPeek = elloCtlAttachPeek;
window.elloCtlOpenPeekLightbox = elloCtlOpenPeekLightbox;

// Apply the active category chip + the search box together, then re-render.
function applyBrowserFilters() {
    const input = document.getElementById('browserSearch');
    const q = (input ? input.value : '').toLowerCase().trim();
    const cat = browserCategoryFilter || 'all';
    filteredClothing = (sampleClothing || []).filter(item => {
        if (cat !== 'all' && elloProductBucket(item) !== cat) return false;
        if (q) {
            const hay = ((item.name || '') + ' ' + (item.category || '') + ' ' + (item.color || '') + ' ' + ((item.tags || []).join(' '))).toLowerCase();
            if (hay.indexOf(q) === -1) return false;
        }
        return true;
    });
    browserCurrentPage = 1;
    updateBrowserDisplay();
}

// Build the chip row from the buckets actually present in the catalog. Hidden
// when there's only one category (a filter bar of one is just clutter).
function elloRenderCategoryChips() {
    const bar = document.getElementById('epcCategoryBar');
    if (!bar) return;
    const counts = {};
    (sampleClothing || []).forEach(it => { const b = elloProductBucket(it); counts[b] = (counts[b] || 0) + 1; });
    const chips = [{ key: 'all', label: 'All' }];
    ELLO_BROWSE_BUCKETS.forEach(b => { if (counts[b.key]) chips.push({ key: b.key, label: b.label }); });
    if (counts.other) chips.push({ key: 'other', label: 'Other' });

    // If the active filter's bucket vanished (catalog changed), reset to All.
    if (!chips.some(c => c.key === browserCategoryFilter)) browserCategoryFilter = 'all';

    if (chips.length <= 2) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
    bar.style.display = '';
    bar.innerHTML = chips.map(c =>
        '<button type="button" class="epc-chip' + (browserCategoryFilter === c.key ? ' active' : '') + '" data-cat="' + c.key + '">' + c.label + '</button>'
    ).join('');
    Array.prototype.forEach.call(bar.querySelectorAll('.epc-chip'), btn => {
        btn.addEventListener('click', () => {
            browserCategoryFilter = btn.getAttribute('data-cat');
            Array.prototype.forEach.call(bar.querySelectorAll('.epc-chip'), b => b.classList.toggle('active', b === btn));
            applyBrowserFilters();
        });
    });
}

// ── Modern collection rendering ────────────────────────────────────────────

// ── Modern collection rendering ────────────────────────────────────────────
// Image-forward cards + infinite scroll: a catalog with thousands of products
// only ever builds a few hundred lightweight DOM nodes, and native lazy-loaded
// images mean only what's near the viewport actually downloads. Replaces the
// old page-by-page renderer (pagination controls are hidden).
const EPC_CHUNK = 30;
let __epcItems = [];
let __epcIndex = 0;
let __epcObserver = null;

function __epcScrollRoot() {
    const grid = document.getElementById('browserGrid');
    return grid ? grid.closest('.browser-body') : null;
}

function __epcBuildCard(item) {
    const card = document.createElement('div');
    // No persistent selected ring in the grid — clicking opens try-on right
    // away, and pre-highlighting the current product just read as a stray border.
    card.className = 'epc-card';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.dataset.id = item.id;
    card.onclick = () => selectClothingFromBrowser(item.id);

    const safeName = (item.name || '').replace(/"/g, '&quot;');
    // Price can arrive as a number or a string ("$38.00"), on the item or its
    // first variant — normalize all of those to a clean number.
    let rawPrice = item.price;
    if ((rawPrice == null || Number(rawPrice) <= 0) && item.variants && item.variants[0]) {
        rawPrice = item.variants[0].price;
    }
    const priceNum = Number(String(rawPrice == null ? '' : rawPrice).replace(/[^0-9.]/g, ''));
    const priceHtml = (isFinite(priceNum) && priceNum > 0)
        ? `<div class="epc-price">$${priceNum.toFixed(2)}</div>` : '';
    const fallback = "this.onerror=null;this.style.opacity=1;this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22300%22 height=%22400%22%3E%3Crect width=%22300%22 height=%22400%22 fill=%22%23eceef0%22/%3E%3C/svg%3E';this.parentNode.classList.add('epc-ready')";

    card.innerHTML =
        '<div class="epc-media">' +
            `<img class="epc-img" src="${item.image_url}" alt="${safeName}" loading="lazy" decoding="async" ` +
            `onload="this.classList.add('is-loaded');this.parentNode.classList.add('epc-ready')" ` +
            `onerror="${fallback}">` +
        '</div>' +
        `<div class="epc-info"><div class="epc-name">${safeName}</div>${priceHtml}</div>`;
    return card;
}

function __epcAppendChunk() {
    const grid = document.getElementById('browserGrid');
    if (!grid) return;
    const end = Math.min(__epcIndex + EPC_CHUNK, __epcItems.length);
    const frag = document.createDocumentFragment();
    for (let i = __epcIndex; i < end; i++) frag.appendChild(__epcBuildCard(__epcItems[i]));
    grid.appendChild(frag);
    __epcIndex = end;
    if (__epcIndex >= __epcItems.length) __epcDisconnect();
}

function __epcDisconnect() {
    if (__epcObserver) { __epcObserver.disconnect(); __epcObserver = null; }
    const s = document.getElementById('epcSentinel');
    if (s) s.style.display = 'none';
}

function __epcFillIfNeeded() {
    const root = __epcScrollRoot();
    let guard = 0;
    while (__epcIndex < __epcItems.length && root &&
           root.scrollHeight <= root.clientHeight + 800 && guard < 60) {
        __epcAppendChunk();
        guard++;
    }
}

function __epcEnsureObserver() {
    const grid = document.getElementById('browserGrid');
    const root = __epcScrollRoot();
    if (!grid || !root) return;
    let sentinel = document.getElementById('epcSentinel');
    if (!sentinel) {
        sentinel = document.createElement('div');
        sentinel.id = 'epcSentinel';
        sentinel.style.cssText = 'width:100%;height:1px;flex:none;';
    }
    sentinel.style.display = 'block';
    if (grid.nextSibling !== sentinel) grid.parentNode.insertBefore(sentinel, grid.nextSibling);
    if (__epcObserver) __epcObserver.disconnect();
    if (__epcIndex >= __epcItems.length) { sentinel.style.display = 'none'; return; }
    __epcObserver = new IntersectionObserver(function (entries) {
        for (const e of entries) {
            if (e.isIntersecting) { __epcAppendChunk(); __epcFillIfNeeded(); }
        }
    }, { root: root, rootMargin: '700px 0px' });
    __epcObserver.observe(sentinel);
}

function updateBrowserDisplay() {
    const grid = document.getElementById('browserGrid');
    const noResults = document.getElementById('noResultsMessage');
    const resultsCount = document.getElementById('searchResultsCount');
    const pagination = document.getElementById('browserPagination');
    if (!grid) return;

    // Infinite scroll replaces the old page-by-page controls.
    if (pagination) pagination.style.display = 'none';

    __epcDisconnect();
    __epcIndex = 0;
    grid.innerHTML = '';

    // Only show items that actually have a usable image.
    __epcItems = (filteredClothing || []).filter(item =>
        item && item.image_url && item.image_url.trim() !== '' &&
        !item.image_url.includes('placeholder') &&
        !item.image_url.includes('data:image/svg'));

    if (__epcItems.length === 0) {
        grid.style.display = 'none';
        if (noResults) noResults.style.display = 'block';
        if (resultsCount) resultsCount.textContent = '';
        return;
    }

    grid.style.display = 'grid';
    if (noResults) noResults.style.display = 'none';
    if (resultsCount) resultsCount.textContent =
        __epcItems.length + (__epcItems.length === 1 ? ' item' : ' items');

    __epcAppendChunk();      // first chunk
    __epcEnsureObserver();   // wire up infinite scroll
    __epcFillIfNeeded();     // top up if the first screen isn't full
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
        <button class="pagination-btn" onclick="__elloWidget.prevBrowserPage()" ${browserCurrentPage === 1 ? 'disabled' : ''}>
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
        paginationHTML += `<button class="pagination-btn" onclick="__elloWidget.goToBrowserPage(1)">1</button>`;
        if (startPage > 2) {
            paginationHTML += `<span class="pagination-ellipsis">...</span>`;
        }
    }

    for (let i = startPage; i <= endPage; i++) {
        paginationHTML += `
            <button class="pagination-btn ${i === browserCurrentPage ? 'active' : ''}" onclick="__elloWidget.goToBrowserPage(${i})">
                ${i}
            </button>
        `;
    }

    if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
            paginationHTML += `<span class="pagination-ellipsis">...</span>`;
        }
        paginationHTML += `<button class="pagination-btn" onclick="__elloWidget.goToBrowserPage(${totalPages})">${totalPages}</button>`;
    }

    // Next button
    paginationHTML += `
        <button class="pagination-btn" onclick="__elloWidget.nextBrowserPage()" ${browserCurrentPage === totalPages ? 'disabled' : ''}>
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

    // Shopify image URLs are often protocol-relative (//cdn.shopify.com/...); the
    // /tryon backend 422s on a non-absolute productImageUrl. Normalize to https
    // here (the single API choke point) so every source is covered. data: URIs
    // (uploaded photos) pass through unchanged.
    productImageUrl = elloAbsImageUrl(productImageUrl);
    personImageUrl = elloAbsImageUrl(personImageUrl);

    // Compress the person photo before sending. A raw phone upload can be 3–10MB of
    // base64 that the 512Mi front-door proxy buffers in memory (OOM risk under
    // concurrency). The render engine downscales anyway, so 1280px/0.85 preserves
    // try-on quality while cutting the payload ~10x. Only touches data: URIs (uploads
    // and sample models); hosted product URLs are untouched. compressImage returns the
    // original on any failure, so this can never block a try-on.
    if (typeof personImageUrl === "string" && personImageUrl.startsWith("data:")) {
        personImageUrl = await compressImage(personImageUrl, 1280, 0.85);
    }

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
        // Product context so the engine knows which item is for sale (e.g. transfer
        // the shirt, not a necklace the model is also wearing). All optional.
        productTitle: garment?.name || garment?.title || null,
        productType: elloResolveTryonProductType(garment),
        productTags: garment?.tags || null,
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

// Footwear variant — the clothing tips ("full-body photos beat close crops")
// steer shoppers AWAY from the framing shoes need. Same length keeps the
// rotation cadence identical.
const ELLO_FOOTWEAR_LOADING_TIPS = [
    "Use a clear, well-lit photo for best results.",
    "Stand so your feet and shoes are fully in the shot.",
    "Avoid long hems covering your ankles.",
    "A straight-on angle of your feet works best.",
    "Results may vary based on pose, lighting, and product angle."
];

function elloActiveTryonTips() {
    return elloIsFootwearContext() ? ELLO_FOOTWEAR_LOADING_TIPS : TRYON_LOADING_TIPS;
}

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
        const tips = elloActiveTryonTips();
        tipEl.textContent = tips[index % tips.length];
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
    updateTryOnLoadingCopy(container, elloActiveTryonTips().length - 1);
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

    // Extract error message from response (server message includes the
    // merchant-configured limit, e.g. "15 per day"; this is just a fallback)
    let errorMessage = errorResponse?.message ||
        "You've reached this store's try-on limit. Please come back later.";

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

// ─── No-widget store detection ──────────────────────────────────────────────
// A "no-widget" store has the floating bubble turned off on every page type, so
// the inline Try-on button is the only entry. There, the button opens the FULL
// widget panel (same as clicking the bubble: featured, quick picks, wardrobe,
// the normal photo flow) — see elloOpenTryOnFromInline. (Andrew 2026-06-28.)
function elloIsNoWidgetStore() {
    var c = window.ELLO_STORE_CONFIG || {};
    return c.floatingWidgetPdpEnabled === false && c.floatingWidgetNonPdpEnabled === false;
}

// ─── PDP image-swap experiment — DISABLED 2026-06-28 ────────────────────────
// Andrew's call: the Try-on button should open the normal full widget, not the
// focused swap experience (the swap caused the dotted upload card, the stuck
// loading bar, and a 422 on protocol-relative product URLs). The swap code stays
// in the file but NEVER runs while this is false — every hub gate below returns
// false, so openWidget/startTryOn/onboarding all take the normal widget path.
// Flip ELLO_PDP_SWAP_ENABLED to true to bring the swap flow back.
var ELLO_PDP_SWAP_ENABLED = false;

// Test override for the PDP swap (?ello_pdp_swap=1 / =0). SESSION-scoped on
// purpose: the old localStorage version latched swap mode PERMANENTLY into any
// browser that ever opened a test link — Atlas Apparel's desktop kept painting
// the hero card weeks after testing (2026-07-04). sessionStorage survives
// navigation within the tab (the demo still flows) but dies with it, and the
// legacy localStorage key is scrubbed here so latched browsers self-heal on
// their next visit.
function elloPdpSwapOverrideOn() {
    var on = false;
    try {
        try { window.localStorage.removeItem('ello_pdp_swap'); } catch (e) {}
        var p = new URLSearchParams(window.location.search).get('ello_pdp_swap');
        if (p === '1') { window.sessionStorage.setItem('ello_pdp_swap', '1'); on = true; }
        else if (p === '0') { window.sessionStorage.removeItem('ello_pdp_swap'); }
        else if (window.sessionStorage.getItem('ello_pdp_swap') === '1') on = true;
    } catch (e) { /* private mode / storage disabled — override stays off */ }
    return on;
}

function elloPdpHubModeOn() {
    if (!ELLO_PDP_SWAP_ENABLED) return false;
    var c = window.ELLO_STORE_CONFIG || {};
    if (c.pdpImageSwapEnabled === true) return true;
    return elloPdpSwapOverrideOn();
}

// ─── PDP image-swap (the "mirror") — standalone, independent of the hub UI ──
// Andrew 2026-06-30: the merchant toggle "Show the try-on result on the product
// photo" (pdpImageSwapEnabled) should do EXACTLY one thing — drop the finished
// try-on onto the page's hero image — WITHOUT pulling in the focused "hub"
// workspace that caused the dotted upload card / stuck bar on 2026-06-28. So the
// swap gates on THIS function (merchant config only), not on elloPdpHubModeOn()
// or the dead ELLO_PDP_SWAP_ENABLED master switch. Hub mode stays off; the swap
// stands alone. Fires only when: we're on a product page AND the merchant turned
// it on (or the ?ello_pdp_swap=1 test override) AND the garment being tried on IS
// this product (so we never paste a different item onto this product's photo —
// cross-product try-ons keep the normal in-panel result).
function elloPdpSwapOn() {
    // CTL Scenario-B layering pass: the selected garment is item B (not the page
    // product), which would fail the garment-guard below and misroute the layer
    // to the in-widget path. Keep the layer on the hero.
    if (window.__elloCtlLayeringInB) return true;
    var handle = null;
    try { handle = getProductIdFromUrl(window.location.pathname); } catch (e) {}
    if (!handle) return false;                         // not a PDP — nothing to mirror

    var enabled = (window.ELLO_STORE_CONFIG || {}).pdpImageSwapEnabled === true;
    if (!enabled) enabled = elloPdpSwapOverrideOn();   // test override (any store, pre-toggle)
    if (!enabled) return false;

    var g = window.elloSelectedGarment;
    if (!g || g.id !== handle) return false;           // only mirror THIS product
    return true;
}

// ─── Complete the Look (outfit-upsell styling rail) ─────────────────────────
// The rail renders INSIDE the widget popup's result view (NOT injected into the
// merchant theme), so it stands on its own flag — independent of the PDP image
// swap and the dead hub mode. When CTL is on, the try-on shows the in-widget
// result + rail and SKIPS the PDP swap (see startTryOn), keeping the whole
// upsell inside Ello's chrome. Explicit opt-in, default OFF → every existing
// merchant is byte-for-byte unchanged.
// Deterministic 50/50 proof-test bucket, derived from the ello session id's
// last-character parity. The dashboard RPC computes the SAME bucket in SQL
// (ascii(right(session_id, 1)) % 2), so no extra event data is needed and the
// widget and the report can never disagree about who saw the upsell. No
// session id → 'treatment' (fail-open: show the upsell).
function elloCtlHoldoutBucket() {
    try {
        var sid = window.ELLO_SESSION_ID;
        if (!sid || typeof sid !== 'string' || !sid.length) return 'treatment';
        return (sid.charCodeAt(sid.length - 1) % 2 === 0) ? 'treatment' : 'holdout';
    } catch (e) { return 'treatment'; }
}

function elloCompleteTheLookOn() {
    var c = window.ELLO_STORE_CONFIG || {};
    // Test override — trial the rail on ANY live store, and demo it reliably
    // even while a holdout test is running: ?ello_ctl=1 persists to
    // localStorage (survives navigation); ?ello_ctl=0 turns it back off.
    try {
        var p = new URLSearchParams(window.location.search).get('ello_ctl');
        if (p === '1') { window.localStorage.setItem('ello_ctl', '1'); }
        if (p === '0') { window.localStorage.removeItem('ello_ctl'); return false; }
        if (window.localStorage.getItem('ello_ctl') === '1') return true;
    } catch (e) { /* private mode / storage disabled — fall through */ }
    if (c.completeTheLookEnabled !== true) return false;
    // 50/50 PROOF TEST: while the merchant runs a holdout, half the shoppers
    // never see the upsell (they still try on and buy). The AOV gap between
    // the halves is the causal lift number the dashboard reports.
    if (c.ctlHoldoutEnabled === true && elloCtlHoldoutBucket() === 'holdout') return false;
    return true;
}

// Returning shopper on a no-widget store, viewing a try-on-able product → the
// HYBRID focused view. True only when: bubble off everywhere + a saved photo
// exists + the current product resolves. (Andrew 2026-06-28.)
function elloShouldFocusReturning() {
    if (!elloIsNoWidgetStore()) return false;
    var hasPhoto = !!(userPhoto || window.elloUserImageUrl);
    if (!hasPhoto) { try { hasPhoto = !!localStorage.getItem(USER_PHOTO_STORAGE_KEY); } catch (e) {} }
    if (!hasPhoto) return false;
    try { return !!detectCurrentProduct(); } catch (e) { return false; }
}

// The hybrid focused view: inline two-card workspace (their photo + the current
// product) + Browse all + Wardrobe, NO quick-picks/featured, and NO auto-fire —
// they tap "Try it on" themselves. The middle ground between the full widget and
// the one-tap auto-fire.
window.elloOpenFocusedReturning = function (ctx) {
    window.ELLO_PENDING_ENTRY_SOURCE = (ctx && ctx.source) || 'inline_button';
    window.ELLO_INLINE_MODE = true;       // two-card workspace (hides featured/quick-picks)
    window.ELLO_HUB_MODE = false;
    window.ELLO_AUTO_FIRE = false;         // no auto-fire — show the Try it on button
    window.ELLO_FOCUSED_MODE = true;       // un-hides Browse all + Wardrobe (ello-pdp-hub CSS)
    window.ELLO_LAUNCHERLESS = true;
    window.ELLO_INLINE_CTX = {
        productHandle: (ctx && ctx.productHandle) || null,
        productId:     (ctx && ctx.productId)     || null,
        variantId:     (ctx && ctx.variantId)     || null
    };
    if (ctx && ctx.variantId) window.ELLO_PRESELECTED_VARIANT_ID = String(ctx.variantId);
    try { loadFullCatalogIfNeeded(window.ELLO_STORE_CONFIG || {}); } catch (e) { /* non-fatal */ }
    if (typeof openWidget === 'function') {
        openWidget();
        // Paint the focused layout in the SAME tick openWidget shows the panel so
        // the shopper never sees the base two-card workspace flash before the
        // header + Browse/Wardrobe cards. ensureFocusedStyles() (which hides the
        // base workspace) lands before the browser's next paint → no FOUC. The
        // retries below only backfill the product image/name + wardrobe count once
        // the async catalog/state resolves; the STRUCTURE is already on screen.
        elloSetupFocusedExtras();
        setTimeout(elloSetupFocusedExtras, 260);
        setTimeout(elloSetupFocusedExtras, 750);
    } else {
        console.warn('[Ello] openWidget not yet defined — focused open dropped');
    }
};

// Focused-view polish: force the two cards equal-size, add labels + a short
// header, and inject a clean Browse / Wardrobe row (wardrobe emphasized). The
// real browse/wardrobe buttons live inside the hidden quick-picks section, so we
// inject our own row instead. All idempotent.
function ensureFocusedStyles() {
    if (document.getElementById('ello-focused-styles')) return;
    var s = document.createElement('style');
    s.id = 'ello-focused-styles';
    s.textContent =
        // Hide the original two-card workspace — we render our own clean stage so
        // the cards are guaranteed equal (the inherited card chain has too many
        // conflicting width/height rules across base + media queries to wrangle).
        '.virtual-tryon-widget.inline-mode.ello-pdp-hub .photo-section-content .try-on-workspace{display:none !important;}' +
        // The focused view IS the whole body — our head/stage/doors replace the
        // base sections. The base .photo-section is empty here (upload cards + base
        // workspace are unused) but mobile CSS forces it display:block + flex:1, so
        // it grows into dead scroll space below the cards. Hide it (the result view
        // already does this) — the Try On button lives in .action-buttons, OUTSIDE
        // #tryonContent, so it stays. Then top-anchor the body so there's no
        // centered float and nothing to scroll to.
        '.virtual-tryon-widget.inline-mode.ello-pdp-hub .photo-section{display:none !important;}' +
        // ID-prefixed duplicates: the template's mobile "ensure visible" block
        // carries ID specificity and beat the two class-only hides above on
        // phones — the base workspace + upload section rendered under the
        // focused stage (the "whole widget below the doors" bug, 2026-07-13).
        '#virtual-tryon-widget-container .virtual-tryon-widget.inline-mode.ello-pdp-hub .photo-section-content .try-on-workspace{display:none !important;}' +
        '#virtual-tryon-widget-container .virtual-tryon-widget.inline-mode.ello-pdp-hub .photo-section{display:none !important;}' +
        '.virtual-tryon-widget.inline-mode.ello-pdp-hub:not(.inline-mode-result-ready) .tryon-content{justify-content:flex-start !important;}' +
        '.ello-focus-wrap{width:100%;box-sizing:border-box;}' +
        '.ello-focus-stage{display:grid;grid-template-columns:minmax(0,1fr) 24px minmax(0,1fr);align-items:start;gap:8px;width:100%;box-sizing:border-box;padding:18px 18px 4px;}' +
        '.ello-focus-cell{min-width:0;}' +
        '.ello-focus-img{position:relative;width:100%;aspect-ratio:3/4;border-radius:14px;background:#f1f1f1 center/cover no-repeat;box-shadow:0 1px 3px rgba(0,0,0,.05),0 6px 16px rgba(0,0,0,.07);}' +
        '.ello-focus-plus{align-self:center;text-align:center;color:#c4c4c4;font-size:20px;line-height:1;}' +
        '.ello-focus-cap{text-align:center;font-size:12px;font-weight:var(--ello-fw-600, 600);color:#555;margin-top:8px;line-height:1.3;}' +
        '.ello-focus-change{position:absolute;left:50%;bottom:8px;transform:translateX(-50%);background:rgba(17,17,17,.78);color:#fff;border:none;border-radius:999px;font:inherit;font-size:11px;font-weight:var(--ello-fw-500, 500);padding:5px 12px;cursor:pointer;white-space:nowrap;}' +
        '.ello-focus-head{text-align:center;font-size:14px;font-weight:var(--ello-fw-600, 600);color:#2f2f2f;letter-spacing:-.01em;line-height:1.4;padding:28px 22px 4px;}' +
        // Browse / Wardrobe stacked as full-width rows. We reuse the opened hub's
        // own .browse-all-btn / .wardrobe-btn card styling (icon + label + sub),
        // so this returning view stays in lockstep with the hub. Just need the
        // container to flow as a block (each card is width:100%) instead of a row.
        '.ello-focus-doors{display:block;padding:6px 20px 16px;}' +
        '.ello-focus-doors .browse-all-btn{margin-top:0;}' +
        // Desktop only: the panel is a fixed 420x650 (it can't grow like the mobile
        // sheet), so the same content overflowed and scrolled. Shrink the cards +
        // tighten spacing so the focused view fits the fixed panel with no scroll.
        // Scoped to the focused returning view (not the result view, not the normal
        // full widget which legitimately scrolls).
        '@media (min-width:769px){' +
            '.virtual-tryon-widget.inline-mode.ello-pdp-hub:not(.inline-mode-result-ready) .ello-focus-stage{grid-template-columns:minmax(0,150px) 24px minmax(0,150px);justify-content:center;gap:8px;padding:10px 18px 2px;}' +
            '.virtual-tryon-widget.inline-mode.ello-pdp-hub:not(.inline-mode-result-ready) .ello-focus-img{aspect-ratio:auto;height:196px;}' +
            '.virtual-tryon-widget.inline-mode.ello-pdp-hub:not(.inline-mode-result-ready) .ello-focus-head{padding:14px 22px 2px;font-size:13px;line-height:1.35;}' +
            '.virtual-tryon-widget.inline-mode.ello-pdp-hub:not(.inline-mode-result-ready) .ello-focus-cap{margin-top:6px;}' +
            '.virtual-tryon-widget.inline-mode.ello-pdp-hub:not(.inline-mode-result-ready) .ello-focus-doors{padding:4px 20px 10px;}' +
        '}';
    document.head.appendChild(s);
}

function elloSetupFocusedExtras() {
    var widget = document.getElementById('virtualTryonWidget');
    if (!widget || window.ELLO_FOCUSED_MODE !== true) return;
    ensureFocusedStyles();

    var workspace = widget.querySelector('.try-on-workspace');
    if (!workspace) return;
    // Insert into a full-width block/stretch container — NOT .photo-section-content
    // (a flex-row that shrinks the stage to its content).
    var host = widget.querySelector('#tryonContent') || widget.querySelector('.tryon-content') || workspace.parentElement;

    // Resolve the photo + product image srcs (product loads async with catalog).
    var photoSrc = window.elloUserImageUrl
        || (typeof userPhoto !== 'undefined' && userPhoto)
        || (widget.querySelector('#activeUserPhoto') && widget.querySelector('#activeUserPhoto').getAttribute('src'))
        || '';
    var prodImgEl = widget.querySelector('#selectedClothingImage') || widget.querySelector('.selected-clothing-image');
    var productSrc = (prodImgEl && prodImgEl.getAttribute('src'))
        || (window.elloSelectedGarment && window.elloSelectedGarment.image_url)
        || '';
    var productName = window.ELLO_INLINE_PRODUCT_NAME
        || (window.elloSelectedGarment && (window.elloSelectedGarment.name || window.elloSelectedGarment.title))
        || 'This item';

    // Build our own clean two-card stage once; refresh the images every call.
    var stage = widget.querySelector('.ello-focus-stage');
    if (!stage) {
        stage = document.createElement('div');
        stage.className = 'ello-focus-stage';
        stage.innerHTML =
            '<div class="ello-focus-cell"><div class="ello-focus-img" data-img="photo"><button type="button" class="ello-focus-change">Change photo</button></div><div class="ello-focus-cap">You</div></div>' +
            '<div class="ello-focus-plus">+</div>' +
            '<div class="ello-focus-cell"><div class="ello-focus-img" data-img="product"></div><div class="ello-focus-cap" data-cap="product">This item</div></div>';
        host.insertBefore(stage, host.firstChild);
        stage.querySelector('.ello-focus-change').addEventListener('click', function () { if (typeof handlePhotoUploadClick === 'function') handlePhotoUploadClick(); });
        // First-timer fallback: with no photo yet, the whole empty card opens
        // the picker (the chip alone is a small target). With a photo present
        // the card is inert — the chip stays the only tap target.
        stage.querySelector('[data-img="photo"]').addEventListener('click', function (e) {
            if (e.target && e.target.closest('.ello-focus-change')) return;
            var hasPhoto = !!(window.elloUserImageUrl || (typeof userPhoto !== 'undefined' && userPhoto));
            if (!hasPhoto && typeof handlePhotoUploadClick === 'function') handlePhotoUploadClick();
        });
    }
    var pImg = stage.querySelector('[data-img="photo"]'); if (pImg && photoSrc) pImg.style.backgroundImage = 'url("' + photoSrc + '")';
    var qImg = stage.querySelector('[data-img="product"]'); if (qImg && productSrc) qImg.style.backgroundImage = 'url("' + productSrc + '")';
    var cap = stage.querySelector('[data-cap="product"]'); if (cap) cap.textContent = productName;

    // The stage serves first-timers now too (the always-focused routing above):
    // no photo yet → the chip reads "Add photo" and the header invites the
    // upload instead of the welcome-back line. Refreshed every call so the
    // copy flips the moment an upload lands.
    var chip = stage.querySelector('.ello-focus-change');
    if (chip) chip.textContent = photoSrc ? 'Change photo' : 'Add photo';

    // Short header line above the stage.
    var head = widget.querySelector('.ello-focus-head');
    if (host && !head) {
        head = document.createElement('div'); head.className = 'ello-focus-head';
        host.insertBefore(head, stage);
    }
    if (head) {
        head.textContent = photoSrc
            ? 'Hey — want to use this photo again? Just hit Try On below.'
            : 'Add one photo to see it on you.';
    }

    // Browse / Wardrobe stacked rich cards, injected right after the stage. These
    // reuse the opened hub's own .browse-all-btn / .wardrobe-btn markup + classes
    // (icon + label + sub, wardrobe shows the saved-look count) so the returning
    // view matches the full hub exactly instead of a bespoke two-up row.
    if (host && !widget.querySelector('.ello-focus-doors')) {
        var GRID = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';
        var WARD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 6.6V5.4a2 2 0 1 1 2-2"/><path d="M12 6.6 4.2 13.2a1 1 0 0 0 .65 1.8h14.3a1 1 0 0 0 .65-1.8L12 6.6z"/></svg>';
        var CHEV = '<svg class="rb-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>';
        var wardCount = (typeof getWardrobeCount === 'function') ? getWardrobeCount() : 0;
        var doors = document.createElement('div'); doors.className = 'ello-focus-doors';
        doors.innerHTML =
            '<button type="button" class="browse-all-btn" data-act="browse">' +
                '<span class="rb-ico">' + GRID + '</span>' +
                '<span class="rb-text"><span class="rb-label">Browse Full Collection</span><span class="rb-sub">See every item in the shop</span></span>' +
                CHEV +
            '</button>' +
            '<button type="button" class="wardrobe-btn" data-act="wardrobe">' +
                '<span class="rb-ico rb-ico-dark">' + WARD + '</span>' +
                '<span class="rb-text"><span class="rb-label">My Wardrobe</span><span class="rb-sub">Your saved try-ons</span></span>' +
                '<span class="wardrobe-count">' + wardCount + '</span>' +
            '</button>';
        host.insertBefore(doors, stage.nextSibling);
        doors.querySelector('[data-act="wardrobe"]').addEventListener('click', function () { if (typeof openWardrobe === 'function') openWardrobe(); });
        doors.querySelector('[data-act="browse"]').addEventListener('click', function () { if (typeof openClothingBrowser === 'function') openClothingBrowser(); });
    }

    // Refresh the saved-look count every call — the doors build once, but with the
    // synchronous first paint getWardrobeCount() may read before wardrobe state
    // has loaded; the 260/750 retries backfill the real number.
    var wcSpan = widget.querySelector('.ello-focus-doors .wardrobe-count');
    if (wcSpan && typeof getWardrobeCount === 'function') wcSpan.textContent = getWardrobeCount();
}

window.elloOpenTryOnFromInline = function (ctx) {
    // No-widget store (bubble off everywhere): the PDP Try-on button ALWAYS
    // opens the hybrid focused view — photo + product + Browse/Wardrobe doors —
    // never the full widget home. (Andrew 2026-07-13: shoppers without a saved
    // photo, or clicks racing the catalog load, fell through to the full panel
    // and got Featured Today + the whole scrollable home on swap stores like
    // ello-dev-store.) First-timers get the intro overlay on top; Use My Photo
    // goes straight to the picker in focused mode, and the stage's empty photo
    // card is the fallback upload affordance. The full panel home remains
    // reachable via the Fitting Room header/nav entries, just not this button.
    if (elloIsNoWidgetStore()) {
        window.elloOpenFocusedReturning(ctx);
        return;
    }
    // Widget stores (bubble ON): keep the focused auto-fire below — intended, the
    // inline button is the fast one-tap try-on when the bubble's on the page.

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

// ─── Fitting-room hub (launcher-less browse + wardrobe) ─────────────────────
// The hub reuses the existing Browse Collection + Wardrobe modals, opened
// WITHOUT the bottom-right bubble. window.Ello.openCollection / openWardrobe
// (in widget-loader.js) forward here. We run in ELLO_INLINE_MODE so openWidget()
// clears the bubble's display:none kill switch and closeWidget() re-hides it —
// the focused panel behind the modal stays invisible to the shopper, while the
// full-screen modal IS the hub surface. ELLO_HUB_MODE changes the modal-close
// semantics so dismissing the hub fully closes the panel (no stranded bubble).

// The two modal headers the hub decorates with a Collection/Wardrobe switch.
var ELLO_HUB_HEADERS = [
    { modal: 'clothingBrowserModal', header: '.browser-header', title: '.browser-title' },
    { modal: 'wardrobeModal',        header: '.wardrobe-header', title: '.wardrobe-title' }
];

function elloEnsureHubSwitchStyles() {
    if (document.getElementById('ello-hub-switch-styles')) return;
    var style = document.createElement('style');
    style.id = 'ello-hub-switch-styles';
    style.textContent =
        '.ello-hub-switch{display:inline-flex;gap:2px;background:rgba(0,0,0,0.06);border-radius:999px;padding:3px;}' +
        '.ello-hub-switch button{border:none;background:transparent;cursor:pointer;font:inherit;font-size:13px;font-weight:var(--ello-fw-500, 500);padding:6px 14px;border-radius:999px;color:#555;line-height:1;transition:background .15s,color .15s;}' +
        '.ello-hub-switch button.active{background:#fff;color:#111;box-shadow:0 1px 2px rgba(0,0,0,0.12);}';
    document.head.appendChild(style);
}

// Inject (idempotently) the Collection/Wardrobe segmented switch into both
// modal headers and reflect which surface is active. Hub mode only.
function elloEnsureHubChrome(active) {
    if (!window.ELLO_HUB_MODE) return;
    elloEnsureHubSwitchStyles();
    ELLO_HUB_HEADERS.forEach(function (h) {
        var modalEl = document.getElementById(h.modal);
        if (!modalEl) return;
        var header = modalEl.querySelector(h.header);
        if (!header) return;
        // Hide the static title — the segmented switch is the hub's nav.
        var titleEl = header.querySelector(h.title);
        if (titleEl) titleEl.style.display = 'none';
        var sw = header.querySelector('.ello-hub-switch');
        if (!sw) {
            sw = document.createElement('div');
            sw.className = 'ello-hub-switch';
            sw.innerHTML =
                '<button type="button" data-hub="collection">Collection</button>' +
                '<button type="button" data-hub="wardrobe">Wardrobe</button>';
            sw.querySelector('[data-hub="collection"]').addEventListener('click', function () { elloHubSwitch('collection'); });
            sw.querySelector('[data-hub="wardrobe"]').addEventListener('click', function () { elloHubSwitch('wardrobe'); });
            header.insertBefore(sw, header.firstChild);
        }
        sw.querySelectorAll('button').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-hub') === active);
        });
    });
}

// Remove the hub switch + restore titles so a later NON-hub open of these
// modals (via the floating widget) is clean. Called from closeWidget().
function elloTeardownHubChrome() {
    ELLO_HUB_HEADERS.forEach(function (h) {
        var modalEl = document.getElementById(h.modal);
        if (!modalEl) return;
        var header = modalEl.querySelector(h.header);
        if (!header) return;
        var sw = header.querySelector('.ello-hub-switch');
        if (sw) sw.remove();
        var titleEl = header.querySelector(h.title);
        if (titleEl) titleEl.style.display = '';
    });
}

// Switch between the two hub surfaces without closing the hub. __elloHubKeepOpen
// suppresses the full-close in closeClothingBrowser/closeWardrobe during the swap.
function elloHubSwitch(target) {
    if (!window.ELLO_HUB_MODE) return;
    window.__elloHubKeepOpen = true;
    try {
        if (target === 'wardrobe') {
            closeClothingBrowser();
            openWardrobe();
        } else {
            closeWardrobe();
            openClothingBrowser();
        }
    } finally {
        window.__elloHubKeepOpen = false;
    }
    elloEnsureHubChrome(target);
}

// Public hub entry point — forwarded from window.Ello.openCollection /
// openWardrobe. Mirrors elloOpenTryOnFromInline's state-setup + delegation.
// Fitting Room — opens the FULL try-on panel launcher-less (no persistent corner
// bubble). Unlike the hub deep-links below, this lands the shopper on the panel's
// HOME so EVERYTHING is reachable: change photo, the try-on workspace, Browse Full
// Collection, My Wardrobe, featured + quick picks. This is the primary entry the
// "Fitting Room" header link / nav menu uses.
window.elloOpenPanelFromInline = function (ctx) {
    if (window.ELLO_STORE_CONFIG && window.ELLO_STORE_CONFIG.fittingRoomEnabled === false) {
        return;
    }
    window.ELLO_PENDING_ENTRY_SOURCE = (ctx && ctx.source) || 'fitting_room';
    // Full panel — NOT the focused inline/PDP view, and NOT the stripped hub that
    // trapped the shopper in a single modal. Land on the home.
    window.ELLO_INLINE_MODE = false;
    window.ELLO_HUB_MODE = false;
    window.ELLO_AUTO_FIRE = false;
    window.ELLO_INLINE_CTX = null;
    window.ELLO_LAUNCHERLESS = true;   // launcher-less open/close (re-hides the bubble)
    try { loadFullCatalogIfNeeded(window.ELLO_STORE_CONFIG || {}); } catch (e) { /* non-fatal */ }
    if (typeof openWidget !== 'function') {
        console.warn('[Ello] openWidget not yet defined — Fitting Room open dropped');
        return;
    }
    openWidget();
};

window.elloOpenHubFromInline = function (ctx) {
    // Dashboard kill switch — if the merchant turned the Fitting Room hub OFF,
    // every entry point (block button, nav link, programmatic) becomes a no-op.
    // The block hides its own button too; this guards the nav-link / programmatic
    // paths that we can't hide from the merchant's theme.
    if (window.ELLO_STORE_CONFIG && window.ELLO_STORE_CONFIG.fittingRoomEnabled === false) {
        return;
    }
    var intent = (ctx && ctx.__elloHubIntent) || 'collection';
    window.ELLO_PENDING_ENTRY_SOURCE = (ctx && ctx.source) || 'fitting_room_hub';

    window.ELLO_INLINE_MODE = true;   // keeps the floating bubble hidden
    window.ELLO_HUB_MODE = true;      // hub close/switch semantics
    window.ELLO_AUTO_FIRE = false;    // never auto-fire a try-on from the hub
    window.ELLO_INLINE_CTX = { productHandle: null, productId: null, variantId: null };

    // Warm the full catalog so the Browse grid isn't empty (idempotent —
    // openWidget triggers it too; renderBrowserGrid also waits on the promise).
    try { loadFullCatalogIfNeeded(window.ELLO_STORE_CONFIG || {}); } catch (e) { /* non-fatal */ }

    if (typeof openWidget !== 'function') {
        console.warn('[Ello] openWidget not yet defined — hub open dropped');
        return;
    }
    openWidget();

    // Open the requested hub surface on top of the (hidden) panel.
    if (intent === 'wardrobe') {
        openWardrobe();
        elloEnsureHubChrome('wardrobe');
    } else {
        openClothingBrowser();
        elloEnsureHubChrome('collection');
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

// ─── PDP image-swap (hub mode) ──────────────────────────────────────────────
// The conversion climax for no-widget stores: a successful try-on replaces the
// PDP's main gallery image with the result so the shopper buys while looking at
// themselves. The original collapses to a corner thumbnail (tap to toggle back).
// Every theme-DOM touch is hardened with a selector cascade + size/visibility
// checks; if no gallery image resolves we fall back to the in-panel result, so
// this can never break a try-on. All gated behind elloPdpSwapOn().
var __elloPdpSwap = { imgEl: null, originalSrc: null, originalSrcset: null, originalSizes: null, pictureSources: null, lazyAttrs: null, loadingEl: null, thumbEl: null, swapped: false, progressTimer: null, progress: 0, hidWidget: false };

// Strip Shopify size suffixes (_800x, _400x400, _x600) + query (?v=, ?width=)
// so the variant's featured_image URL matches the (resized) <img> the theme
// actually rendered. Compares by base filename.
// Normalize an image URL to absolute https. Shopify returns protocol-relative
// (//cdn.shopify.com/...) and sometimes root-relative URLs; the /tryon backend
// requires an absolute https URL or it 422s on productImageUrl. data:/blob:
// URIs (uploaded photos) pass through untouched.
function elloAbsImageUrl(u) {
    if (!u || typeof u !== 'string') return u;
    if (u.indexOf('data:') === 0 || u.indexOf('blob:') === 0) return u;
    if (u.indexOf('//') === 0) return 'https:' + u;
    if (/^https?:\/\//i.test(u)) return u;
    if (u.charAt(0) === '/') { try { return location.origin + u; } catch (e) { return u; } }
    return u;
}

function elloImageBaseName(url) {
    try {
        var u = String(url).split('?')[0];
        var file = u.substring(u.lastIndexOf('/') + 1);
        file = file.replace(/_(\d+x\d*|x\d+)(?=\.[a-z0-9]+$)/i, '');
        return file.toLowerCase();
    } catch (e) { return ''; }
}

// Resolve the product's main-media container so the swap targets the HERO image,
// not a thumbnail, a zoom/lightbox clone, a swatch, or a related/recently-viewed
// image elsewhere on the page. Returns null if none resolves (caller then scans
// the whole document, still applying the exclusions below).
function elloPdpScopeRoot() {
    var sel = ['[data-section-type="product"]', '.shopify-section.product',
               '.product-single', '.product__info-wrapper', '.product',
               'main#MainContent', 'main[role="main"]', 'main'];
    for (var i = 0; i < sel.length; i++) {
        var root; try { root = document.querySelector(sel[i]); } catch (e) { root = null; }
        if (root) return root;
    }
    return null;
}

// True if the <img> sits in a thumbnail rail, a zoom/lightbox clone, a swatch, or
// a related/recently-viewed block — anything we must NOT replace with the result.
function elloPdpImgExcluded(el) {
    try {
        if (el.closest('.thumbnail-list, .product__media-toggle, .product__thumbnail, .product-single__thumbnails, [data-thumbnail], .product__media--zoom, .zoomImg, .drift-zoom-pane, .swatch, [data-swatch], .product-recommendations, .related-products, [data-recently-viewed], .recently-viewed')) return true;
        // [data-zoom] marks a zoom CLONE only on a container/ancestor. Many
        // themes (LA Apparel's Dawn) put data-zoom on the hero <img> ITSELF as
        // its hi-res source — that img is exactly the one we want, so a
        // self-match must not exclude it.
        var z = el.closest('[data-zoom]');
        return !!(z && z !== el);
    } catch (e) { return false; }
}

// Find the PDP hero <img> within `root`. If preferSrc is supplied (the selected
// color's featured_image), match the on-page <img> with the same base filename —
// theme-agnostic AND color-correct. Otherwise fall back to the first reasonably
// large, on-screen product image from the selector cascade. Skips excluded nodes.
function elloFindPdpImageIn(root, preferSrc) {
    if (!root) return null;
    if (preferSrc) {
        var want = elloImageBaseName(preferSrc);
        if (want) {
            var imgs = root.querySelectorAll('img');
            for (var k = 0; k < imgs.length; k++) {
                var im = imgs[k];
                if (elloPdpImgExcluded(im)) continue;
                var s = im.currentSrc || im.getAttribute('src') || '';
                if (s && elloImageBaseName(s) === want) {
                    var rr; try { rr = im.getBoundingClientRect(); } catch (e) { rr = null; }
                    if (rr && rr.width >= 100 && rr.height >= 100 && im.offsetParent !== null) return im;
                }
            }
        }
    }
    var selectors = [
        '#pdp-main-image',
        '.product__media img', '.product-media img', 'product-media img',
        '.product-single__photo img', '.product__main-photos img',
        '.product-gallery__image img', '.product__media-item img',
        '[data-product-single-media-wrapper] img', '[data-media-type="image"] img',
        '.product__media-list img', '.product-image-main img', '.product__photo img'
    ];
    for (var i = 0; i < selectors.length; i++) {
        var nodes;
        try { nodes = root.querySelectorAll(selectors[i]); } catch (e) { continue; }
        for (var j = 0; j < nodes.length; j++) {
            var el = nodes[j];
            if (!el || el.tagName !== 'IMG') continue;
            if (elloPdpImgExcluded(el)) continue;
            var r;
            try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
            if (r && r.width >= 140 && r.height >= 140 && el.offsetParent !== null) {
                return el;
            }
        }
    }
    return null;
}

// Merchant/support override (dashboard "Product image selector" field, plumbed
// via pdp_image_selector → pdpImageSelector). The escape hatch for themes that
// defeat the automatic cascade: support pastes a selector, no widget deploy.
// Treated as a HINT, not gospel — an invalid selector, no match, a non-image
// target with no <img> inside, or a hidden/tiny image all return null so the
// cascade below still decides. Deliberately skips elloPdpImgExcluded: pointing
// at something the exclusion list would veto is exactly what an explicit
// override is for.
function elloMerchantPdpImage() {
    var sel = (window.ELLO_STORE_CONFIG || {}).pdpImageSelector;
    if (!sel || typeof sel !== 'string') return null;
    var node;
    try { node = document.querySelector(sel); } catch (e) { return null; }   // invalid selector
    if (!node) return null;
    var img = (node.tagName === 'IMG') ? node : node.querySelector('img');
    if (!img) return null;
    var r; try { r = img.getBoundingClientRect(); } catch (e) { r = null; }
    if (r && r.width >= 100 && r.height >= 100 && img.offsetParent !== null) return img;
    return null;
}

// Three-pass: the merchant's explicit selector wins when it verifies, then the
// scoped product container (so we can't grab a thumbnail, zoom clone, or a
// related-products image), then a document-wide scan that STILL applies the
// exclusions — so coverage is never worse than the old unscoped search, but
// mis-targeting is far less likely.
function elloFindPdpImage(preferSrc) {
    return elloMerchantPdpImage()
        || elloFindPdpImageIn(elloPdpScopeRoot(), preferSrc)
        || elloFindPdpImageIn(document, preferSrc);
}

// ─── Color-correct garment (multi-variant PDPs) ─────────────────────────────
// LA Apparel-style products have many colors; each Shopify variant carries its
// own featured_image. We read the SELECTED variant's image and use it both as
// the garment sent to the AI (so the shopper tries on the EXACT color they
// picked) and as the swap target. Reads /products/{handle}.js (cached per
// handle). All best-effort — any failure falls back to the catalog image.
var __elloProductJsonCache = {};
function elloFetchProductJson(handle) {
    if (!handle) return Promise.resolve(null);
    if (__elloProductJsonCache[handle]) return Promise.resolve(__elloProductJsonCache[handle]);
    return fetch('/products/' + encodeURIComponent(handle) + '.js', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (j) __elloProductJsonCache[handle] = j; return j; })
        .catch(function () { return null; });
}

// Override the current product's garment image with the SELECTED variant's image
// so the shopper tries on the exact color they picked. The catalog stores one
// color-blind image per product; the live PDP's ?variant= (kept in sync by the
// theme) is the source of truth for the chosen color. Only touches the garment
// when it IS the current product; all best-effort (keeps the catalog image on
// any miss). Runs in the normal widget flow — independent of the swap.
async function elloApplyColorCorrectGarment() {
    try {
        var garment = window.elloSelectedGarment;
        if (!garment) return;
        var handle = (typeof getProductIdFromUrl === 'function') ? getProductIdFromUrl(window.location.pathname) : null;
        if (!handle || garment.id !== handle) return; // only the current PDP product
        var variantId = null;
        // DEMO: the demo engine resolves the selected color robustly — including
        // themes that don't sync ?variant= or the add-to-cart form (it matches the
        // checked option swatches against the product's variants) — and publishes
        // it here. Trust it first so the try-on always uses the color on screen.
        if (window.__ELLO_DEMO__ === true && window.__ELLO_DEMO_VARIANT_ID__) variantId = String(window.__ELLO_DEMO_VARIANT_ID__);
        try { if (!variantId) variantId = new URLSearchParams(window.location.search).get('variant'); } catch (e) {}
        // The theme's live product form always carries the selected variant in
        // input[name=id] — covers pickers that don't sync ?variant= to the URL.
        if (!variantId) {
            try {
                var vInput = document.querySelector('form[action*="/cart/add"] [name="id"]');
                if (vInput && vInput.value && /^\d+$/.test(String(vInput.value))) variantId = vInput.value;
            } catch (e) {}
        }
        if (!variantId) variantId = window.ELLO_PRESELECTED_VARIANT_ID
            || (window.ELLO_INLINE_CTX && window.ELLO_INLINE_CTX.variantId) || null;
        if (!variantId) return;
        var json = await elloFetchProductJson(handle);
        if (!json || !Array.isArray(json.variants)) return;
        var want = String(variantId).replace(/^gid:\/\/shopify\/ProductVariant\//, '');
        var v = json.variants.find(function (x) { return String(x.id) === want; });
        if (!v) return;
        // Remember exactly what they tried on, so Add-to-Cart only asks for size.
        window.__elloTriedOnVariant = v;
        window.__elloTriedOnHandle = handle;
        var src = (v.featured_image && v.featured_image.src)
            || (v.featured_media && v.featured_media.preview_image && v.featured_media.preview_image.src)
            || null;
        if (src) garment.image_url = elloAbsImageUrl(src);
    } catch (e) { /* keep the catalog image on any failure */ }
}

function elloResolveSelectedVariantImage() {
    var ctx = window.ELLO_INLINE_CTX || {};
    var handle = ctx.productHandle;
    if (!handle) return Promise.resolve(null);
    return elloFetchProductJson(handle).then(function (json) {
        if (!json || !Array.isArray(json.variants)) return null;
        // DEMO: prefer the demo engine's robustly-resolved selected color (works on
        // themes that don't sync ?variant= or the add-to-cart form).
        var vid = (window.__ELLO_DEMO__ === true && window.__ELLO_DEMO_VARIANT_ID__) ? String(window.__ELLO_DEMO_VARIANT_ID__) : ctx.variantId;
        if (!vid) { try { vid = new URLSearchParams(location.search).get('variant'); } catch (e) {} }
        // Live form input as the last word — covers pickers that don't sync
        // ?variant= and a stale ctx captured before a color change.
        if (!vid) {
            try {
                var vIn = document.querySelector('form[action*="/cart/add"] [name="id"]');
                if (vIn && vIn.value && /^\d+$/.test(String(vIn.value))) vid = vIn.value;
            } catch (e) {}
        }
        var variant = null;
        if (vid) {
            var want = String(vid).replace(/^gid:\/\/shopify\/ProductVariant\//, '');
            variant = json.variants.find(function (v) { return String(v.id) === want; });
        }
        if (!variant) variant = json.variants.find(function (v) { return v.available; }) || json.variants[0];
        if (!variant) return null;
        var src = (variant.featured_image && variant.featured_image.src) ||
                  (variant.featured_media && variant.featured_media.preview_image && variant.featured_media.preview_image.src) ||
                  (json.featured_image && (json.featured_image.src || json.featured_image)) || null;
        if (!src) return null;
        return { src: elloAbsImageUrl(src), color: variant.option1 || null, variantId: variant.id };
    }).catch(function () { return null; });
}

function elloEnsurePdpSwapStyles() {
    if (document.getElementById('ello-pdp-swap-styles')) return;
    var s = document.createElement('style');
    s.id = 'ello-pdp-swap-styles';
    s.textContent =
        // Shared corner card (loading + toggle), pinned top-right of the PDP image.
        // Geometry is !important: OS 2.0 themes (Dawn base.css) blanket-stretch
        // every direct child of the media wrapper (.media > :not(.zoom):not(...)
        // → position:absolute;width:100%;height:100%), which inflated this 78px
        // card into a hero-covering white box on Atlas Apparel (2026-07-04).
        // That selector's specificity beats any single class, so only !important
        // keeps the card card-sized there.
        '.ello-pdp-card{position:absolute !important;top:12px !important;right:12px !important;left:auto !important;bottom:auto !important;width:78px !important;height:auto !important;max-width:78px !important;margin:0 !important;transform:none !important;z-index:7;border:none;padding:0;border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 4px 16px rgba(0,0,0,.28);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}' +
        // object-fit needs !important too: theme media rules (e.g. `.media img
        // {object-fit:contain}`) otherwise win and letterbox the thumb with
        // white bars from the card background (Andrew 2026-07-13).
        '.ello-pdp-card img{width:100% !important;height:96px !important;position:static !important;object-fit:cover !important;display:block;background:#f3f3f3;}' +
        // Loading: a determinate bar that fills smoothly + a % readout.
        '.ello-pdp-card .ello-pdp-bar{height:5px;background:#e7e7e7;}' +
        '.ello-pdp-card .ello-pdp-bar>i{display:block;height:100%;width:0;background:#111;border-radius:0 3px 3px 0;transition:width .4s cubic-bezier(.4,0,.2,1);}' +
        '.ello-pdp-card .ello-pdp-pct{display:block;text-align:center;font-size:11px;font-weight:var(--ello-fw-600, 600);line-height:1.4;padding:4px 2px;color:#111;background:#fff;}' +
        // Toggle variant: just the photo + a small swap badge (no text), reads as a button.
        'button.ello-pdp-card{cursor:pointer;-webkit-appearance:none;appearance:none;transition:transform .12s ease,box-shadow .12s ease;}' +
        'button.ello-pdp-card:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(0,0,0,.32);}' +
        'button.ello-pdp-card:active{transform:scale(.97);}' +
        '.ello-pdp-swapbadge{position:absolute;bottom:6px;right:6px;width:22px;height:22px;border-radius:50%;background:rgba(17,17,17,.82);color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.35);pointer-events:none;}' +
        '.ello-pdp-swapbadge svg{width:13px;height:13px;}';
    document.head.appendChild(s);
}

// Anchor overlays to the image's wrapper (make it positioned if it's static).
function elloPdpAnchor(imgEl) {
    var wrap = imgEl.parentElement || imgEl;
    try {
        var pos = window.getComputedStyle(wrap).position;
        if (pos === 'static' || !pos) wrap.style.position = 'relative';
    } catch (e) {}
    return wrap;
}

// Theme galleries fight our hero overlays two ways: (1) a full-cover zoom
// trigger can paint ABOVE them (mobile sliders add transforms → stacking
// context → no z-index we set can win), stealing the tap outright; (2) the
// zoom can be wired via CAPTURE-phase delegation (Horizon) or pointer events,
// which fire BEFORE our buttons' own listeners can stopPropagation — so the
// zoom opened IN ADDITION to our action. This shield owns the whole region:
// a WINDOW-level capture listener (window capture runs before any theme
// listener anywhere, regardless of registration order) hit-tests every
// pointer/click event against our live overlays, swallows everything in
// bounds, and drives our UI directly via each button's __elloTap handler.
// Events targeting our own higher surfaces (size picker, widget, modals) or
// an OPEN dialog pass through untouched.
var __elloPdpShieldOn = false;
function elloInstallPdpTapShield() {
    if (__elloPdpShieldOn) return;
    __elloPdpShieldOn = true;
    ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click'].forEach(function (type) {
        window.addEventListener(type, function (ev) {
            var pt = (ev.changedTouches && ev.changedTouches[0]) || ev;
            var x = pt.clientX, y = pt.clientY;
            if (typeof x !== 'number' || (x === 0 && y === 0)) return;   // keyboard activation
            var thumb = __elloPdpSwap.thumbEl, loading = __elloPdpSwap.loadingEl;
            var panel = (typeof __elloCtlB !== 'undefined' && __elloCtlB) ? __elloCtlB.panelEl : null;
            function hit(el) {
                if (!el || !el.isConnected) return false;
                var r = el.getBoundingClientRect();
                return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
            }
            var region = hit(thumb) ? thumb : (hit(loading) ? loading : (hit(panel) ? panel : null));
            if (!region) {
                // A tap elsewhere on a swapped hero is (likely) the theme zoom
                // opening — after it mounts, repaint its hi-res clone with the
                // shopper's result so zooming "them" shows THEM.
                if (type === 'click' && __elloPdpSwap.swapped && __elloPdpSwap.resultUrl) {
                    setTimeout(elloSyncZoomDialogs, 150);
                    setTimeout(elloSyncZoomDialogs, 500);
                }
                return;
            }
            // Our own surfaces above the hero + open dialogs keep their events.
            var t = ev.target;
            if (t instanceof Node && t.nodeType === 1) {
                try {
                    if (t.closest('#virtualTryonWidget, #ello-sz-overlay, #ello-ctl-lightbox, .clothing-browser-modal, .modal-backdrop, dialog[open], [aria-modal="true"]')) return;
                } catch (e) {}
            }
            // The tap is ours alone — the theme never sees ANY event of it.
            ev.stopImmediatePropagation();
            if (type !== 'click') return;   // act exactly once, on the final click
            ev.preventDefault();
            if (region === thumb) { elloPdpSwapToggle(); return; }
            if (region === panel) {
                // Peekable thumbs ride the same __elloTap dispatch as buttons.
                var btns = panel.querySelectorAll('button, .ello-ctl-peekable');
                for (var i = 0; i < btns.length; i++) {
                    if (!btns[i].disabled && hit(btns[i])) {
                        var fn = btns[i].__elloTap;
                        if (fn) { try { fn(); } catch (e) {} }
                        return;
                    }
                }
            }
            // loading card / panel body: swallowed.
        }, true);
    });
}

// Hide the panel + pin a loading card to the PDP image: a thumbnail of the
// SHOPPER'S photo + a progress bar that smoothly builds with a % readout, so it
// reads as "we're putting YOU in this." The product image stays as the main
// photo behind it. Returns false when no PDP image resolves (caller keeps the
// in-panel flow).
function elloBeginPdpSwapLoading() {
    // On a CTL layering pass, reuse the SAME hero element verbatim — re-resolving
    // by item B's image could grab a different gallery <img> and trip the
    // stale-stash reset below, destroying the true-photo restore.
    var img = (window.__elloCtlLayeringInB && __elloPdpSwap.imgEl)
        ? __elloPdpSwap.imgEl
        : elloFindPdpImage(window.elloSelectedGarment && window.elloSelectedGarment.image_url);
    if (!img) return false;
    elloEnsurePdpSwapStyles();
    // New swap session targeting a DIFFERENT image than a still-live previous
    // swap: drop the stale stash so the new image's originals are captured fresh
    // (same image + live swap keeps its true originals).
    if (__elloPdpSwap.imgEl && __elloPdpSwap.imgEl !== img && __elloPdpSwap.swapped) {
        __elloPdpSwap.swapped = false;
        __elloPdpSwap.originalSrc = null;
        __elloPdpSwap.originalSrcset = null;
        __elloPdpSwap.originalSizes = null;
        __elloPdpSwap.pictureSources = null;
        __elloPdpSwap.lazyAttrs = null;
    }
    __elloPdpSwap.imgEl = img;

    var widget = document.getElementById('virtualTryonWidget');
    if (widget) {
        widget.classList.add('widget-minimized');
        widget.style.setProperty('display', 'none', 'important');
        __elloPdpSwap.hidWidget = true;   // so the next openWidget un-hides it even on a floating-bubble store
    }
    try { if (typeof unlockBodyScroll === 'function') unlockBodyScroll(); } catch (e) {}

    var wrap = elloPdpAnchor(img);
    if (__elloPdpSwap.loadingEl) { try { __elloPdpSwap.loadingEl.remove(); } catch (e) {} }
    if (__elloPdpSwap.thumbEl) { try { __elloPdpSwap.thumbEl.remove(); } catch (e) {} __elloPdpSwap.thumbEl = null; }

    var myPhoto = window.elloUserImageUrl || (typeof userPhoto !== 'undefined' && userPhoto) || '';
    var card = document.createElement('div');
    card.className = 'ello-pdp-card';
    card.innerHTML =
        (myPhoto ? '<img src="' + myPhoto + '" alt="Your photo">' : '') +
        '<div class="ello-pdp-bar"><i></i></div>' +
        '<span class="ello-pdp-pct">0%</span>';
    // Swallow taps: on Dawn-family themes the zoom trigger (modal-opener) is an
    // ANCESTOR of the hero img, so a tap on this card would bubble up and open
    // the zoom dialog mid-render.
    card.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); });
    wrap.appendChild(card);
    __elloPdpSwap.loadingEl = card;

    // Smoothly building progress with a % readout. Eases toward ~92% over the
    // typical try-on time; elloFinishPdpSwap snaps it to 100% when the result
    // lands (real render time is variable, so we can't show a true %).
    __elloPdpSwap.progress = 0;
    if (__elloPdpSwap.progressTimer) { clearInterval(__elloPdpSwap.progressTimer); }
    var fillEl = card.querySelector('.ello-pdp-bar > i');
    var pctEl = card.querySelector('.ello-pdp-pct');
    __elloPdpSwap.progressTimer = setInterval(function () {
        var p = __elloPdpSwap.progress;
        p += Math.max(0.35, (96 - p) * 0.04);   // ease-out toward ~93% over ~8s
        if (p > 93) p = 93;
        __elloPdpSwap.progress = p;
        if (fillEl) fillEl.style.width = p.toFixed(1) + '%';
        if (pctEl) pctEl.textContent = Math.round(p) + '%';
    }, 320);

    // Top-align the hero (with a small allowance for sticky theme headers) —
    // centering left tall mobile heroes half cut off; the shopper should see
    // the WHOLE image while their try-on renders (Andrew 2026-07-03).
    try {
        var hr = img.getBoundingClientRect();
        var top = (window.pageYOffset || document.documentElement.scrollTop || 0) + hr.top - 64;
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    } catch (e) {}
    elloInstallPdpTapShield();
    return true;
}

// "Swap" affordance icon for the toggle thumbnail.
var ELLO_SWAP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4 3 8l4 4"/><path d="M3 8h13a4 4 0 0 1 4 4"/><path d="m17 20 4-4-4-4"/><path d="M21 16H8a4 4 0 0 1-4-4"/></svg>';

// ─── Aspect-fit compositing (Andrew 2026-07-09) ─────────────────────────────
// The theme sizes the hero box from the ORIGINAL product image's ratio (Liquid
// bakes a padding-top % / aspect-ratio into the media wrapper at render time),
// and usually paints the img with object-fit:cover — so a portrait result
// dropped into a square box gets the shopper's head/feet CROPPED (Atlas
// Apparel, 2026-07-09). We don't fight the theme's geometry: instead the
// result is drawn onto a canvas of the box's EXACT shape — full person
// contained + centered, a blurred copy of the same photo filling the leftover
// space (the Instagram-letterbox look). The theme then renders it exactly like
// it renders the product photo, so no theme CSS is touched and no layout can
// shift. Resolves with the RAW result on ratio-match (nothing to fix) or ANY
// failure (zero-size box, CORS-tainted canvas, decode error, timeout) — this
// can never break a try-on. The raw render stays the source of truth for the
// wardrobe, zoom dialogs, and CTL layering.
function elloComposeHeroResult(resultUrl, imgEl) {
    return new Promise(function (resolve) {
        var settled = false;
        function done(u) { if (!settled) { settled = true; resolve(u); } }
        var guard = setTimeout(function () { done(resultUrl); }, 2500);
        try {
            // The hero still shows the product photo at call time — its box IS
            // the shape the theme will keep rendering. Hidden/unlaid-out hero
            // (slider slide) → fall back to the current image's natural ratio,
            // which is what the theme derived the box from anyway. On the
            // page-load restore the product image may not have LOADED yet
            // (rect collapsed + naturalWidth 0) — wait for its load before
            // measuring instead of giving up, still under the 2.5s guard.
            var begin = function () {
            var boxW = 0, boxH = 0;
            try { var r = imgEl.getBoundingClientRect(); boxW = r.width; boxH = r.height; } catch (e) {}
            if ((boxW < 40 || boxH < 40) && imgEl.naturalWidth > 0 && imgEl.naturalHeight > 0) {
                boxW = imgEl.naturalWidth; boxH = imgEl.naturalHeight;
            }
            if (boxW < 40 || boxH < 40) { clearTimeout(guard); done(resultUrl); return; }
            var boxRatio = boxW / boxH;

            var probe = new Image();
            // Remote results need CORS-clean pixels or toDataURL throws; data:
            // URLs (the normal render path) are always clean.
            if (/^https?:/i.test(resultUrl)) probe.crossOrigin = 'anonymous';
            probe.onload = function () {
                try {
                    var iw = probe.naturalWidth, ih = probe.naturalHeight;
                    if (!iw || !ih) { clearTimeout(guard); done(resultUrl); return; }
                    // Already (nearly) the box's shape — the theme shows it
                    // whole without help.
                    if (Math.abs(iw / ih - boxRatio) / boxRatio <= 0.04) { clearTimeout(guard); done(resultUrl); return; }

                    // Canvas at the box's ratio, sized so the contained person
                    // keeps ~1:1 source pixels (never upscaled), capped for
                    // memory.
                    var cw, ch, MAX = 1600;
                    if (iw / ih <= boxRatio) { ch = ih; cw = Math.round(ih * boxRatio); }
                    else { cw = iw; ch = Math.round(iw / boxRatio); }
                    var k = Math.min(1, MAX / Math.max(cw, ch));
                    cw = Math.max(2, Math.round(cw * k)); ch = Math.max(2, Math.round(ch * k));
                    var canvas = document.createElement('canvas');
                    canvas.width = cw; canvas.height = ch;
                    var ctx = canvas.getContext('2d');

                    // Fill: the result itself, scaled-to-cover and blurred.
                    // Oversized 12% so blur never bleeds transparent edges in.
                    var cover = Math.max(cw / iw, ch / ih) * 1.12;
                    var bw = iw * cover, bh = ih * cover;
                    var bx = (cw - bw) / 2, by = (ch - bh) / 2;
                    var blurred = false;
                    try {
                        // ctx.filter is missing on older Safari — feature-test
                        // by reading the value back.
                        ctx.filter = 'blur(' + Math.max(24, Math.round(Math.max(cw, ch) * 0.05)) + 'px)';
                        if (String(ctx.filter).indexOf('blur') !== -1) {
                            ctx.drawImage(probe, bx, by, bw, bh);
                            blurred = true;
                        }
                        ctx.filter = 'none';
                    } catch (e) {}
                    if (!blurred) {
                        // Fake the blur: round-trip through a tiny canvas and
                        // let bilinear smoothing soften the upscale.
                        var t = document.createElement('canvas');
                        t.width = Math.max(2, Math.round(cw / 20));
                        t.height = Math.max(2, Math.round(ch / 20));
                        var tc = t.getContext('2d');
                        var tcv = Math.max(t.width / iw, t.height / ih) * 1.12;
                        tc.drawImage(probe, (t.width - iw * tcv) / 2, (t.height - ih * tcv) / 2, iw * tcv, ih * tcv);
                        ctx.imageSmoothingEnabled = true;
                        ctx.drawImage(t, bx, by, bw, bh);
                    }

                    // The person, whole, centered, with a soft shadow so the
                    // seam against the fill reads intentional.
                    var fit = Math.min(cw / iw, ch / ih);
                    var fw = iw * fit, fh = ih * fit;
                    ctx.shadowColor = 'rgba(0,0,0,0.35)';
                    ctx.shadowBlur = Math.round(Math.max(cw, ch) * 0.03);
                    ctx.drawImage(probe, (cw - fw) / 2, (ch - fh) / 2, fw, fh);
                    ctx.shadowBlur = 0;

                    var out = canvas.toDataURL('image/jpeg', 0.9);   // throws if tainted → catch → raw
                    clearTimeout(guard);
                    done(out && out.length > 256 ? out : resultUrl);
                } catch (e) { clearTimeout(guard); done(resultUrl); }
            };
            probe.onerror = function () { clearTimeout(guard); done(resultUrl); };
            probe.src = resultUrl;
            };   // end begin()

            if (imgEl.complete === false) {
                var onEnd = function () {
                    imgEl.removeEventListener('load', onEnd);
                    imgEl.removeEventListener('error', onEnd);
                    try { begin(); } catch (e) { clearTimeout(guard); done(resultUrl); }
                };
                imgEl.addEventListener('load', onEnd);
                imgEl.addEventListener('error', onEnd);
            } else {
                begin();
            }
        } catch (e) { clearTimeout(guard); done(resultUrl); }
    });
}

// Re-shape the hero composite when the box's shape ACTUALLY changed since the
// composite was built (phone rotation, responsive breakpoint) — otherwise the
// old composite gets cover-cropped by the new box. lastBoxRatio is stamped at
// compose-KICKOFF (the shape the composite was built for), so this check stays
// truthful even when the rotation happened while the original photo was showing
// or mid-render. Ratio-gated (>4% drift) so mobile scroll resizes (URL-bar
// collapse) never trigger a re-render; the stale-raw guard drops the repaint if
// a newer render or a toggle-to-original landed while composing. Called from
// the debounced resize listener, the reveal, and toggle-back-to-result.
function elloPdpMaybeRecompose() {
    try {
        var s = __elloPdpSwap, img = s.imgEl;
        if (!img || !img.isConnected || !s.swapped || s.showingResult === false || !s.resultRawUrl) return;
        var r = img.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) return;
        var ratio = r.width / r.height;
        if (s.lastBoxRatio && Math.abs(ratio - s.lastBoxRatio) / s.lastBoxRatio <= 0.04) return;
        var raw = s.resultRawUrl;
        s.lastBoxRatio = ratio;
        elloComposeHeroResult(raw, img).then(function (heroUrl) {
            if (__elloPdpSwap.resultRawUrl !== raw || __elloPdpSwap.showingResult === false) return;
            __elloPdpSwap.resultUrl = heroUrl;
            img.removeAttribute('srcset'); img.removeAttribute('sizes');
            img.src = heroUrl;
        });
    } catch (e) { /* best-effort — worst case the composite stays box-cropped */ }
}

var __elloPdpResizeOn = false;
function elloInstallPdpResizeRecompose() {
    if (__elloPdpResizeOn) return;
    __elloPdpResizeOn = true;
    var timer = null;
    var handler = function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(elloPdpMaybeRecompose, 300);
    };
    window.addEventListener('resize', handler);
    window.addEventListener('orientationchange', handler);
}

// Snap the loading bar to 100%, then AUTO-replace the main PDP image with the
// result (the shopper sees themselves with no click) and drop a clean toggle
// thumbnail — just the original photo + a small swap badge (no text labels).
function elloFinishPdpSwap(resultUrl, opts) {
    // instant=true (used by the load-time restore) paints the saved result with
    // no loading-bar beat and no fade — the shopper who returns to the page
    // should just SEE themselves already in it, not watch it re-render.
    var instant = !!(opts && opts.instant);
    var img = __elloPdpSwap.imgEl;
    if (!img) return;
    if (__elloPdpSwap.progressTimer) { clearInterval(__elloPdpSwap.progressTimer); __elloPdpSwap.progressTimer = null; }

    // Complete the bar to 100% so the build finishes cleanly before the reveal.
    var card = __elloPdpSwap.loadingEl;
    if (card) {
        var f = card.querySelector('.ello-pdp-bar > i'); if (f) f.style.width = '100%';
        var pc = card.querySelector('.ello-pdp-pct'); if (pc) pc.textContent = '100%';
    }

    if (!__elloPdpSwap.swapped) {
        __elloPdpSwap.originalSrc = img.getAttribute('src');
        __elloPdpSwap.originalSrcset = img.getAttribute('srcset');
        __elloPdpSwap.originalSizes = img.getAttribute('sizes');
        // <picture><source srcset> out-resolves the <img> src on OS 2.0 themes
        // (Dawn/Refresh/Sense), which would make the swap INVISIBLE. Stash + blank
        // every sibling <source> srcset; restored verbatim on abort/toggle-back.
        __elloPdpSwap.pictureSources = [];
        try {
            var pic = img.parentElement;
            if (pic && pic.tagName === 'PICTURE') {
                var srcs = pic.querySelectorAll('source');
                for (var si = 0; si < srcs.length; si++) {
                    __elloPdpSwap.pictureSources.push({ el: srcs[si], srcset: srcs[si].getAttribute('srcset') });
                    srcs[si].removeAttribute('srcset');
                }
            }
        } catch (e) {}
        // A theme lazy-loader (data-src/data-srcset + IntersectionObserver, native
        // loading=lazy) can re-assert the original src after we swap. Stash + blank
        // those attrs; restored verbatim on abort.
        __elloPdpSwap.lazyAttrs = {};
        try {
            ['data-src', 'data-srcset', 'data-original', 'data-lazy', 'data-lazy-src', 'loading'].forEach(function (a) {
                if (img.hasAttribute(a)) { __elloPdpSwap.lazyAttrs[a] = img.getAttribute(a); img.removeAttribute(a); }
            });
        } catch (e) {}
    }
    // Shape the result to the hero box (blur-fill letterbox) so the shopper is
    // never cropped by the theme's fixed-ratio media wrapper. Kicked off now so
    // it runs during the 100%-beat below; resolves with the raw result on any
    // failure, so the reveal never stalls on it beyond the 2.5s guard. Stamp
    // the box shape this composite is being built for — the recompose gate
    // compares against it.
    try {
        var br0 = img.getBoundingClientRect();
        if (br0.width > 40 && br0.height > 40) __elloPdpSwap.lastBoxRatio = br0.width / br0.height;
    } catch (e) {}
    var composeP = elloComposeHeroResult(resultUrl, img);

    // Themes often set srcset/sizes which would override src — clear them so the
    // result actually paints.
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');

    var doReveal = function (heroUrl) {
        if (__elloPdpSwap.loadingEl) { try { __elloPdpSwap.loadingEl.remove(); } catch (e) {} __elloPdpSwap.loadingEl = null; }
        // Auto-replace the main image with the result — no click required.
        if (instant) {
            img.src = heroUrl; img.style.opacity = '1';
        } else {
            img.style.transition = 'opacity .35s ease';
            img.style.opacity = '0';
            setTimeout(function () { img.src = heroUrl; img.style.opacity = '1'; }, 120);
        }
        __elloPdpSwap.swapped = true;

        var wrap = elloPdpAnchor(img);
        if (__elloPdpSwap.thumbEl) { try { __elloPdpSwap.thumbEl.remove(); } catch (e) {} }
        var thumb = document.createElement('button');
        thumb.type = 'button';
        thumb.className = 'ello-pdp-card';
        thumb.setAttribute('aria-label', 'Tap to switch between your try-on and the original photo');
        // Just the photo + a small swap badge (no text). Start: main = result,
        // thumb shows the original. resultUrl = what the hero paints (the
        // box-shaped composite); resultRawUrl = the untouched render, for the
        // zoom dialogs / thumb preview / CTL rebase comparisons.
        __elloPdpSwap.resultUrl = heroUrl;
        __elloPdpSwap.resultRawUrl = resultUrl;
        __elloPdpSwap.showingResult = true;
        elloInstallPdpResizeRecompose();
        // Rotation DURING the render: the composite was built for the pre-
        // rotation box — recheck now that it's on screen.
        setTimeout(elloPdpMaybeRecompose, 60);
        thumb.innerHTML =
            '<img src="' + (__elloPdpSwap.originalSrc || '') + '" alt="">' +
            '<div class="ello-pdp-swapbadge">' + ELLO_SWAP_ICON + '</div>';
        thumb.addEventListener('click', function (ev) {
            // Never let the tap continue to a theme click-to-zoom handler.
            try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
            elloPdpSwapToggle();
        });
        wrap.appendChild(thumb);
        __elloPdpSwap.thumbEl = thumb;
        elloInstallPdpTapShield();
    };
    var reveal = function () { composeP.then(doReveal); };
    if (instant) {
        reveal();
    } else {
        // Brief beat so the shopper sees 100% before the reveal.
        setTimeout(reveal, 280);
    }
}

// Flip the hero between the try-on result and the original product photo.
// Module-scope (not a closure on the thumb) so the tap shield can invoke it
// when a theme zoom overlay steals the physical tap.
function elloPdpSwapToggle() {
    var img = __elloPdpSwap.imgEl, thumb = __elloPdpSwap.thumbEl, resultUrl = __elloPdpSwap.resultUrl;
    if (!img || !thumb || !resultUrl) return;
    __elloPdpSwap.showingResult = !__elloPdpSwap.showingResult;
    var tImg = thumb.querySelector('img');
    if (__elloPdpSwap.showingResult) {
        img.removeAttribute('srcset'); img.removeAttribute('sizes');
        if (__elloPdpSwap.pictureSources) {
            for (var fi = 0; fi < __elloPdpSwap.pictureSources.length; fi++) {
                var fps = __elloPdpSwap.pictureSources[fi];
                if (fps && fps.el) { try { fps.el.removeAttribute('srcset'); } catch (e) {} }
            }
        }
        if (__elloPdpSwap.lazyAttrs) {
            for (var fla in __elloPdpSwap.lazyAttrs) {
                if (Object.prototype.hasOwnProperty.call(__elloPdpSwap.lazyAttrs, fla)) {
                    try { img.removeAttribute(fla); } catch (e) {}
                }
            }
        }
        img.src = resultUrl;
        if (tImg) tImg.src = __elloPdpSwap.originalSrc || '';
        // If the box changed shape while the original was showing (rotation),
        // the composite we just painted was built for the old shape — recheck.
        setTimeout(elloPdpMaybeRecompose, 60);
    } else {
        if (__elloPdpSwap.originalSrcset) img.setAttribute('srcset', __elloPdpSwap.originalSrcset);
        if (__elloPdpSwap.originalSizes) img.setAttribute('sizes', __elloPdpSwap.originalSizes);
        if (__elloPdpSwap.pictureSources) {
            for (var bi = 0; bi < __elloPdpSwap.pictureSources.length; bi++) {
                var bps = __elloPdpSwap.pictureSources[bi];
                if (bps && bps.el && bps.srcset != null) { try { bps.el.setAttribute('srcset', bps.srcset); } catch (e) {} }
            }
        }
        if (__elloPdpSwap.lazyAttrs) {
            for (var bla in __elloPdpSwap.lazyAttrs) {
                if (Object.prototype.hasOwnProperty.call(__elloPdpSwap.lazyAttrs, bla)) {
                    try { img.setAttribute(bla, __elloPdpSwap.lazyAttrs[bla]); } catch (e) {}
                }
            }
        }
        img.src = __elloPdpSwap.originalSrc || img.src;
        // The 78px thumb paints cover-cropped — the RAW render reads cleaner
        // there than the letterboxed composite (whose blur bands would show).
        if (tImg) tImg.src = __elloPdpSwap.resultRawUrl || resultUrl;
    }
    // Keep any open/persisted zoom modal in step with what the hero shows.
    try { elloSyncZoomDialogs(); } catch (e) {}
}

// Repaint the hero's RESULT with a different render (A-only vs the outfit)
// while keeping the flip-thumb machinery consistent: resultUrl is what the
// thumb toggles back to, so whichever look is selected becomes "them".
function elloCtlSetHeroResult(b64) {
    if (!b64) return;
    __elloPdpSwap.resultRawUrl = b64;
    var img = __elloPdpSwap.imgEl, thumb = __elloPdpSwap.thumbEl;
    if (!img) { __elloPdpSwap.resultUrl = b64; return; }
    // Same blur-fill letterbox as the main reveal, so flipping A-only ↔ outfit
    // never re-crops the shopper. The raw-url guard drops a stale compose if a
    // newer render landed while this one was drawing.
    try {
        var brc = img.getBoundingClientRect();
        if (brc.width > 40 && brc.height > 40) __elloPdpSwap.lastBoxRatio = brc.width / brc.height;
    } catch (e) {}
    elloComposeHeroResult(b64, img).then(function (heroUrl) {
        if (__elloPdpSwap.resultRawUrl !== b64) return;
        __elloPdpSwap.resultUrl = heroUrl;
        if (__elloPdpSwap.showingResult !== false) {
            img.removeAttribute('srcset'); img.removeAttribute('sizes');
            img.src = heroUrl;
        }
    });
    if (__elloPdpSwap.showingResult === false && thumb) {
        // Hero is currently flipped to the product photo — the thumb is the
        // one previewing the result, so it takes the new render instead.
        var t = thumb.querySelector('img');
        if (t) t.src = b64;
    }
}

// Theme zoom should show THEM while the hero is swapped (Andrew 2026-07-03:
// zooming your own photo and getting the product shot back "just looks
// weird"). Zoom dialogs clone their own hi-res image, so after one opens we
// find the clone that matches the ORIGINAL hero file and paint the current
// result over it — and restore our edits whenever the hero is flipped back
// or a new sync runs. Best-effort across Dawn/Horizon-family modals.
function elloSyncZoomDialogs() {
    try {
        var s = __elloPdpSwap;
        if (!s.imgEl) return;
        // Undo whatever a previous sync painted before deciding fresh.
        if (s.zoomSwaps) {
            for (var i = 0; i < s.zoomSwaps.length; i++) {
                var z = s.zoomSwaps[i];
                try {
                    if (z.srcset != null) z.el.setAttribute('srcset', z.srcset); else z.el.removeAttribute('srcset');
                    z.el.src = z.src;
                } catch (e) {}
            }
        }
        s.zoomSwaps = [];
        if (!s.swapped || s.showingResult === false || !s.resultUrl) return;
        var want = elloImageBaseName(s.originalSrc || '');
        if (!want) return;
        var roots;
        try { roots = document.querySelectorAll('dialog[open], [aria-modal="true"], .product-media-modal[open], product-modal[open]'); } catch (e) { return; }
        for (var r = 0; r < roots.length; r++) {
            var imgs = roots[r].querySelectorAll('img');
            for (var k = 0; k < imgs.length; k++) {
                var im = imgs[k];
                var src = im.currentSrc || im.getAttribute('src') || '';
                if (src && elloImageBaseName(src) === want) {
                    s.zoomSwaps.push({ el: im, src: im.getAttribute('src'), srcset: im.getAttribute('srcset') });
                    im.removeAttribute('srcset'); im.removeAttribute('sizes');
                    // Zoom modals size to the image freely — give them the RAW
                    // render (full person, no letterbox fill).
                    im.src = s.resultRawUrl || s.resultUrl;
                }
            }
        }
    } catch (e) { /* best-effort — worst case the zoom shows the product photo */ }
}

// Restore the original image + re-show the panel. Used on try-on error/abort so
// the in-panel error message is visible and the page isn't left half-swapped.
function elloAbortPdpSwap() {
    if (__elloPdpSwap.progressTimer) { clearInterval(__elloPdpSwap.progressTimer); __elloPdpSwap.progressTimer = null; }
    if (__elloPdpSwap.loadingEl) { try { __elloPdpSwap.loadingEl.remove(); } catch (e) {} __elloPdpSwap.loadingEl = null; }
    if (__elloPdpSwap.thumbEl) { try { __elloPdpSwap.thumbEl.remove(); } catch (e) {} __elloPdpSwap.thumbEl = null; }
    var img = __elloPdpSwap.imgEl;
    if (img && __elloPdpSwap.swapped) {
        if (__elloPdpSwap.originalSrcset) img.setAttribute('srcset', __elloPdpSwap.originalSrcset);
        if (__elloPdpSwap.originalSizes) img.setAttribute('sizes', __elloPdpSwap.originalSizes);
        if (__elloPdpSwap.pictureSources) {
            for (var ri = 0; ri < __elloPdpSwap.pictureSources.length; ri++) {
                var ps = __elloPdpSwap.pictureSources[ri];
                if (ps && ps.el && ps.srcset != null) { try { ps.el.setAttribute('srcset', ps.srcset); } catch (e) {} }
            }
        }
        if (__elloPdpSwap.lazyAttrs) {
            for (var la in __elloPdpSwap.lazyAttrs) {
                if (Object.prototype.hasOwnProperty.call(__elloPdpSwap.lazyAttrs, la)) {
                    try { img.setAttribute(la, __elloPdpSwap.lazyAttrs[la]); } catch (e) {}
                }
            }
        }
        if (__elloPdpSwap.originalSrc) img.src = __elloPdpSwap.originalSrc;
    }
    __elloPdpSwap.swapped = false;
    window.__elloPdpSwapActive = false;
    window.__elloCtlLayeringInB = false;
    try { elloTeardownCtlPdpPanel(); } catch (e) {}
    var widget = document.getElementById('virtualTryonWidget');
    if (widget) { widget.classList.remove('widget-minimized'); widget.style.removeProperty('display'); }
}

// PDP-swap PERSISTENCE. On page load, if this store shows the try-on on the hero
// AND this shopper already tried THIS product on, paint their saved result back
// onto the hero right away — so leaving the page and coming back keeps their
// look without a trip to the wardrobe. Best-effort; a miss just leaves the
// normal product photo, and it never blocks page load.
async function elloMaybeRestorePdpSwap() {
    try {
        // Gate 1: a PDP on a hero-swap store. elloPdpSwapOn() also requires a
        // selected garment (not set at load), so we check the enable flag + the
        // ?ello_pdp_swap session override directly here.
        var handle = null;
        try { handle = getProductIdFromUrl(window.location.pathname); } catch (e) {}
        if (!handle) return;
        var enabled = (window.ELLO_STORE_CONFIG || {}).pdpImageSwapEnabled === true;
        if (!enabled) enabled = elloPdpSwapOverrideOn();
        if (!enabled) return;
        if (__elloPdpSwap.swapped) return;   // a live try-on already swapped the hero this pageview

        // Gate 2: the saved result for THIS product. Prefer the FULL-RES cache
        // (crisp at hero size); fall back to the wardrobe's compressed copy only
        // for try-ons saved before the full-res cache existed. Both are keyed by
        // the product handle (wardrobe: clothingId === handle).
        await __elloWardrobeReady;
        var full = await elloGetPdpFullResult(handle);   // { result, garment, variant, outfit?, itemB? } or null
        // If the shopper layered a second piece last time, the OUTFIT is the
        // look they left with — restore that image, not just item A.
        var hasOutfit = !!(full && typeof full.outfit === 'string' &&
            full.outfit.indexOf('data:image') === 0 && full.itemB);
        var resultUrl = hasOutfit ? full.outfit : (full && full.result);
        if (!resultUrl) {
            var wardrobe = getWardrobe();
            if (Array.isArray(wardrobe) && wardrobe.length) {
                var match = null;
                for (var i = 0; i < wardrobe.length; i++) {
                    var w = wardrobe[i];
                    if (w && w.clothingId === handle
                        && typeof w.resultImageUrl === 'string'
                        && w.resultImageUrl.indexOf('data:image') === 0) {
                        if (!match || new Date(w.timestamp || 0) > new Date(match.timestamp || 0)) match = w;
                    }
                }
                if (match) resultUrl = match.resultImageUrl;
            }
        }
        if (!resultUrl) return;

        var img = elloFindPdpImage();
        if (!img) return;
        elloEnsurePdpSwapStyles();
        __elloPdpSwap.imgEl = img;
        __elloPdpSwap.lastResultB64 = resultUrl;   // lets CTL "Try it on too" rebase on it
        elloFinishPdpSwap(resultUrl, { instant: true });

        // Bring the Complete-the-Look upsell back too, so a return visit keeps
        // the whole experience — offer card riding the hero — not just the photo.
        // Prefer the stored garment (carries the numeric product id the
        // complementary fetch needs + the tried-on color for "Add both"); fall
        // back to the in-memory current product. Best-effort — a miss just
        // restores the photo alone, exactly as before.
        try {
            if (elloCompleteTheLookOn()) {
                var garmentA = (full && full.garment) ||
                    (Array.isArray(sampleClothing) ? sampleClothing.find(function (c) { return c && c.id === handle; }) : null);
                if (garmentA) {
                    if (full && full.variant) window.__elloTriedOnVariant = full.variant;
                    if (hasOutfit) {
                        // They left wearing BOTH pieces — come back to the
                        // two-piece panel ("Add both"), not a fresh offer.
                        // Base render rides along so deselecting B can revert
                        // the hero to item A alone, same as the live flow.
                        elloRestoreCtlOutfitPanel(garmentA, full.itemB, full.variant || null,
                            (typeof full.result === 'string' && full.result.indexOf('data:image') === 0) ? full.result : null,
                            full.outfit);
                    } else {
                        elloMountCtlPdpPanel(garmentA);
                    }
                }
            }
        } catch (e) { /* upsell restore is best-effort; the photo is already back */ }
    } catch (e) { /* best-effort — a failure just leaves the product photo untouched */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// Complete the Look — Scenario B (hero-swap stores): the result lives on the
// PDP hero image, so the upsell lives in a compact on-brand card BELOW the hero
// (never covering the shopper). Tap "Try it on too" → layer the complementary
// item onto the hero-of-them → the hero shows BOTH → the card morphs into a
// one-tap "Add both to cart · $total". Gated behind completeTheLookEnabled.
// ═══════════════════════════════════════════════════════════════════════════
var __elloCtlB = {
    panelEl: null, wrapEl: null, itemB: null, garmentA: null, priceA: 0,
    triedOnVariantA: null, triedOnHandleA: null, layered: false, resolvedVB: null,
    userPhotoB64: null
};

// The shopper's TRUE photo, for the two-piece card's zero-selection state
// ("take it all back off" → the mirror shows THEM, not a render they just
// excluded). userPhoto/elloUserImageUrl are re-based onto renders during CTL
// layer passes, so this prefers the value stashed at panel mount — before any
// re-base — then the persisted upload. Null when unavailable (model photos in
// a fresh context); callers fall back to the item-A render.
function elloCtlOriginalUserPhoto() {
    if (__elloCtlB.userPhotoB64) return __elloCtlB.userPhotoB64;
    try {
        var p = localStorage.getItem(USER_PHOTO_STORAGE_KEY);
        if (p && p.indexOf('data:image') === 0) return p;
    } catch (e) {}
    return null;
}

// Stash the un-re-based photo onto __elloCtlB — call ONLY at moments userPhoto
// is still the true photo (offer mount, outfit restore, pre-re-base).
function elloCtlStashUserPhoto() {
    if (__elloCtlB.userPhotoB64) return;
    var p = userPhoto || window.elloUserImageUrl || null;
    if (typeof p === 'string' && p.indexOf('data:image') === 0) __elloCtlB.userPhotoB64 = p;
}

function elloCtlNum(v) { var n = (typeof v === 'number') ? v : parseFloat(v); return isNaN(n) ? 0 : n; }

// One currency symbol, in priority order: Shopify Analytics meta → global → '$'.
function elloCtlCurrency() {
    try {
        var c = (window.ShopifyAnalytics && window.ShopifyAnalytics.meta && window.ShopifyAnalytics.meta.currency)
            || (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || 'USD';
        return c === 'USD' ? '$' : (c + ' ');
    } catch (e) { return '$'; }
}
function elloCtlMoney(n) { return elloCtlCurrency() + elloCtlNum(n).toFixed(2); }

// Item A's price in DOLLARS, resolved robustly. The catalog price
// (garmentA.price) is reliable on a synced store, but the demo bookmarklet runs
// on stores Ello never synced — there detectCurrentProduct() falls back to
// og-tag scraping and can miss the price entirely, leaving garmentA.price at 0
// (the "Add to cart · $0.00" bug). Fall back to the tried-on variant (resolved
// from /products/{handle}.js, whose prices are integer CENTS), then to a fresh
// fetch of that same endpoint. Returns 0 only when every source fails.
async function elloResolveCtlPriceA(garmentA, triedOnVariantA, handleA) {
    var p = elloCtlNum(garmentA && garmentA.price);
    if (p > 0) return p;
    // AJAX product/variant JSON prices are integer CENTS → convert to dollars.
    var vp = triedOnVariantA && triedOnVariantA.price;
    if (vp != null && elloCtlNum(vp) > 0) return elloCtlNum(vp) / 100;
    var handle = handleA || (garmentA && (garmentA.handle || garmentA.id));
    if (handle) {
        try {
            var json = await elloFetchProductJson(handle);
            var vs = (json && Array.isArray(json.variants)) ? json.variants : [];
            var want = triedOnVariantA && triedOnVariantA.id;
            var v = (want && vs.find(function (x) { return String(x.id) === String(want); }))
                || vs.find(function (x) { return x && x.available !== false; }) || vs[0];
            if (v && v.price != null && elloCtlNum(v.price) > 0) return elloCtlNum(v.price) / 100;
        } catch (e) {}
    }
    return 0;
}

function elloEnsureCtlPdpStyles() {
    if (document.getElementById('ello-ctl-pdp-styles')) return;
    var c = window.ELLO_STORE_CONFIG || {};
    var primary = c.inlineButtonColor || c.widgetPrimaryColor || '#111111';
    var primaryText = c.inlineButtonTextColor || '#ffffff';
    var accent = c.widgetAccentColor || primary;
    var f = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
    var s = document.createElement('style');
    s.id = 'ello-ctl-pdp-styles';
    s.textContent =
        // Overlay pinned to the BOTTOM of the hero photo (Andrew 2026-07-01:
        // every theme has a hero; sidebars vary). Absolute + z-index 8 floats it
        // above the theme's full-cover zoom button (Horizon uses --layer-flat≈1,
        // our own toggle thumb uses 7), and an absolutely-positioned box is
        // immune to gallery grid stretch rules. Frosted white so the photo
        // still reads underneath.
        // Flush with the hero's bottom edge (Andrew 2026-07-03: no photo strip
        // peeking under the card — it should read as connected to the page
        // below). Bottom-sheet shape: square bottom, rounded top corners.
        // Geometry hardened with !important: some themes (Dawn/Horizon-family +
        // this "media--transparent" grid) style EVERY direct child of the media
        // wrapper with `.media > * { inset:0; height:100%; width:100% }` to make
        // images fill the square cell. Our card is a direct child of that
        // wrapper, so without these overrides it inflates to the full cell
        // height (373×560 on LA Apparel — Andrew 2026-07-06). An id selector
        // (0-1-0-0) outranks the theme's `.media > *` even when both are
        // !important, so top:auto/height:auto/width:auto win and the card
        // collapses back to a content-sized bottom sheet.
        '#ello-ctl-pdp-panel{box-sizing:border-box !important;position:absolute !important;left:0 !important;right:0 !important;bottom:0 !important;top:auto !important;width:auto !important;height:auto !important;z-index:8;max-width:520px;margin:0 auto;padding:12px 13px;border:1px solid rgba(0,0,0,.06);border-bottom:none;border-radius:14px 14px 0 0;background:rgba(255,255,255,.96);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);box-shadow:0 6px 24px rgba(0,0,0,.16);font-family:' + f + ';animation:elloCtlBIn .3s ease both;text-align:left;}' +
        '@keyframes elloCtlBIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}' +
        '#ello-ctl-pdp-panel .ectl-head{display:flex;align-items:center;gap:6px;margin:0 0 9px;font:600 13px/1 ' + f + ';color:#111;}' +
        '#ello-ctl-pdp-panel .ectl-head svg{color:' + accent + ';flex:0 0 auto;}' +
        '#ello-ctl-pdp-panel .ectl-row{display:flex;gap:11px;align-items:center;}' +
        '#ello-ctl-pdp-panel .ectl-thumb{width:46px;height:60px;border-radius:7px;object-fit:contain;background:#f1efe9;flex:0 0 auto;}' +
        '#ello-ctl-pdp-panel .ectl-info{flex:1 1 auto;min-width:0;}' +
        '#ello-ctl-pdp-panel .ectl-name{font:600 12px/1.3 ' + f + ';color:#111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        '#ello-ctl-pdp-panel .ectl-price{font:500 12px/1.3 ' + f + ';color:#666;margin-top:1px;}' +
        '#ello-ctl-pdp-panel .ectl-btn{flex:0 0 auto;border:none;border-radius:999px;padding:9px 15px;font:600 12px/1 ' + f + ';cursor:pointer;background:' + primary + ';color:' + primaryText + ';display:flex;align-items:center;gap:5px;transition:opacity .15s;}' +
        '#ello-ctl-pdp-panel .ectl-btn:hover{opacity:.88;}' +
        '#ello-ctl-pdp-panel .ectl-btn:disabled{opacity:.55;cursor:wait;}' +
        // Two-piece state: one slim row — selectable thumbs + adaptive add button.
        '#ello-ctl-pdp-panel .ectl-brow{display:flex;align-items:center;gap:8px;}' +
        '#ello-ctl-pdp-panel .ectl-pick{position:relative;flex:0 0 auto;border:none;background:none;padding:0;cursor:pointer;-webkit-appearance:none;appearance:none;}' +
        '#ello-ctl-pdp-panel .ectl-pick img{width:40px;height:52px;border-radius:7px;object-fit:contain;background:#f1efe9;display:block;border:2px solid ' + primary + ';transition:opacity .15s,border-color .15s;}' +
        '#ello-ctl-pdp-panel .ectl-pick .ectl-tick{position:absolute;top:-5px;right:-5px;width:16px;height:16px;border-radius:50%;background:' + primary + ';color:' + primaryText + ';display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.25);}' +
        '#ello-ctl-pdp-panel .ectl-pick .ectl-tick svg{width:9px;height:9px;}' +
        '#ello-ctl-pdp-panel .ectl-pick:not(.is-on) img{opacity:.4;border-color:#d8d8d8;}' +
        '#ello-ctl-pdp-panel .ectl-pick:not(.is-on) .ectl-tick{display:none;}' +
        '#ello-ctl-pdp-panel .ectl-add{box-sizing:border-box;flex:1 1 auto;min-width:0;border:none;border-radius:999px;padding:10px 12px;font:600 12px/1 ' + f + ';cursor:pointer;background:' + primary + ';color:' + primaryText + ';display:flex;align-items:center;justify-content:center;gap:6px;transition:opacity .15s;white-space:nowrap;}' +
        '#ello-ctl-pdp-panel .ectl-add:hover{opacity:.9;}' +
        '#ello-ctl-pdp-panel .ectl-add:disabled{opacity:.6;cursor:wait;}' +
        '#ello-ctl-pdp-panel .ectl-msg{margin-top:8px;font:500 12px/1.4 ' + f + ';text-align:center;}' +
        '#ello-ctl-pdp-panel .ectl-msg.err{color:#b91c1c;}' +
        '#ello-ctl-pdp-panel .ectl-link{display:block;width:100%;margin-top:8px;text-align:center;font:600 13px/1 ' + f + ';color:#111;background:transparent;border:1px solid #d8d8d8;border-radius:10px;padding:11px;cursor:pointer;}' +
        // MOBILE: the hero is small and the shopper has to SEE the garment (a
        // dress hem was disappearing behind the card — Andrew 2026-07-03). Hug
        // the bottom edge tighter and compress every row so the card obscures
        // as little of the image as possible.
        '@media (max-width:640px){' +
            '#ello-ctl-pdp-panel{left:0;right:0;bottom:0;padding:7px 9px;border-radius:11px 11px 0 0;}' +
            '#ello-ctl-pdp-panel .ectl-head{margin:0 0 5px;font-size:11px;gap:5px;}' +
            '#ello-ctl-pdp-panel .ectl-head svg{width:12px;height:12px;}' +
            '#ello-ctl-pdp-panel .ectl-row{gap:8px;}' +
            '#ello-ctl-pdp-panel .ectl-thumb{width:32px;height:42px;border-radius:6px;}' +
            '#ello-ctl-pdp-panel .ectl-name{font-size:11px;}' +
            '#ello-ctl-pdp-panel .ectl-price{font-size:11px;margin-top:0;}' +
            '#ello-ctl-pdp-panel .ectl-btn{padding:8px 12px;font-size:11px;}' +
            '#ello-ctl-pdp-panel .ectl-pick img{width:34px;height:44px;}' +
            '#ello-ctl-pdp-panel .ectl-add{padding:9px 10px;font-size:11px;}' +
            '#ello-ctl-pdp-panel .ectl-msg{margin-top:6px;font-size:11px;}' +
            '#ello-ctl-pdp-panel .ectl-link{margin-top:6px;padding:9px;font-size:12px;}' +
        '}';
    document.head.appendChild(s);
}

var ELLO_CTL_SPARK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"></path></svg>';
var ELLO_CTL_PLUS = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"></path></svg>';
var ELLO_CTL_BAG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.4"></circle><circle cx="17.5" cy="20" r="1.4"></circle><path d="M2.5 3.5h2.3l2.2 11.1a1.4 1.4 0 0 0 1.37 1.1h8.1a1.4 1.4 0 0 0 1.36-1.07L21 7.5H6.2"></path></svg>';
var ELLO_CTL_TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5 9.5 18 20 6.5"></path></svg>';

// Called from the hero-swap success path (base pass). Snapshot A, fetch the
// curated complementary item, and mount the offer card BELOW the hero. No-op if
// off / no hero / no curation.
async function elloMountCtlPdpPanel(garmentA) {
    try {
        if (!elloCompleteTheLookOn()) return;
        var img = __elloPdpSwap.imgEl;
        if (!img) return;                                   // no hero → no panel
        // Snapshot everything A's cart-add needs, frozen at the A try-on so a
        // later color change / the layer pass can't drift it.
        __elloCtlB.garmentA = garmentA || window.elloSelectedGarment || null;
        __elloCtlB.triedOnVariantA = window.__elloTriedOnVariant || null;
        elloCtlStashUserPhoto();   // userPhoto is still the true photo here (pre-layer)
        __elloCtlB.triedOnHandleA = window.__elloTriedOnHandle || (__elloCtlB.garmentA && __elloCtlB.garmentA.id) || null;
        // Resolve A's price robustly — a missing catalog price (unsynced demo /
        // bookmarklet stores) is what showed "Add to cart · $0.00".
        __elloCtlB.priceA = await elloResolveCtlPriceA(__elloCtlB.garmentA, __elloCtlB.triedOnVariantA, __elloCtlB.triedOnHandleA);
        __elloCtlB.layered = false;
        __elloCtlB.resolvedVB = null;

        var items = await elloPickComplementary(__elloCtlB.garmentA, 10);
        if (!items || !items.length) return;                // no curation → no card
        __elloCtlB.itemB = items[0];

        elloEnsureCtlPdpStyles();
        elloTeardownCtlPdpPanel();

        var panel = document.createElement('div');
        panel.id = 'ello-ctl-pdp-panel';
        // Card taps must never reach a theme's click-to-zoom (some themes bind
        // it on the media CONTAINER, an ancestor of this card).
        panel.addEventListener('click', function (ev) { ev.stopPropagation(); });
        __elloCtlB.panelEl = panel;
        elloRenderCtlOffer();
        elloInstallPdpTapShield();

        // Pin the card INSIDE the hero, riding its bottom edge — the one spot
        // every theme guarantees, and exactly where the shopper is already
        // looking (they're looking at themselves). Same anchor wrapper the
        // loading card / flip-back thumb use; the overlay styling (absolute,
        // z-index above the theme's zoom cover) makes it clickable and immune
        // to gallery layout rules on any theme.
        var wrap = elloPdpAnchor(img);
        __elloCtlB.wrapEl = wrap;
        if (!wrap) return;
        wrap.appendChild(panel);
    } catch (e) { try { elloTeardownCtlPdpPanel(); } catch (e2) {} }
}

// Offer state: "Complete the look" + the item + "Try it on too".
function elloRenderCtlOffer() {
    var panel = __elloCtlB.panelEl, item = __elloCtlB.itemB;
    if (!panel || !item) return;
    panel.innerHTML =
        '<div class="ectl-head">' + ELLO_CTL_SPARK + '<span>Complete the look</span></div>' +
        '<div class="ectl-row">' +
            '<img class="ectl-thumb" src="' + elloCtlImgUrl(item.image_url || '', 240) + '" alt="" loading="lazy" decoding="async">' +
            '<div class="ectl-info"><div class="ectl-name"></div><div class="ectl-price"></div></div>' +
            '<button type="button" class="ectl-btn" id="ectl-try-btn">' + ELLO_CTL_PLUS + '<span>Try it on too</span></button>' +
        '</div>';
    panel.querySelector('.ectl-name').textContent = item.name || 'Complementary item';
    panel.querySelector('.ectl-price').textContent = elloCtlMoney(item.price);
    elloCtlAttachPeek(panel.querySelector('.ectl-thumb'), item);
    var btn = panel.querySelector('#ectl-try-btn');
    if (btn) { btn.addEventListener('click', elloCtlLayerInB); btn.__elloTap = elloCtlLayerInB; }
}

// Tap "Try it on too" → layer item B onto the hero-of-them (reusing the
// addToOutfit re-base mechanic), repainting the SAME hero element with both.
function elloCtlLayerInB() {
    try {
        if (isTryOnProcessing) return;
        var base = __elloPdpSwap.lastResultB64;
        if (!base || !__elloCtlB.itemB) return;

        var btn = __elloCtlB.panelEl && __elloCtlB.panelEl.querySelector('#ectl-try-btn');
        if (btn) { btn.disabled = true; btn.innerHTML = ELLO_CTL_PLUS + '<span>Styling…</span>'; }

        // Keep the A-only render: deselecting B in the two-piece card reverts
        // the hero to this image (visual "take the pants back off").
        __elloCtlB.baseResultB64 = base;
        // Attribution: this try-on came from the upsell — the dashboard's
        // proof layer segments AOV by exactly this tag.
        window.ELLO_PENDING_ENTRY_SOURCE = 'complete_the_look';
        // Route this pass to the hero swap even though the garment is now B.
        window.__elloCtlLayeringInB = true;
        // Beat the 1.5s duplicate-click debounce — this layer tap is intentional.
        window._lastTryOnTimestamp = 0;
        // Last chance to capture the true photo before the re-base overwrites it.
        elloCtlStashUserPhoto();
        // Re-base on the previous result (person already wearing A), like addToOutfit.
        userPhoto = base;
        window.elloUserImageUrl = base;
        userPhotoFileId = 'ctlb_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        activePhotoValidationId = userPhotoFileId;
        activePhotoValidationStatus = 'valid';
        lastRejectedPhotoValidationId = null;
        // The base render wears garment A — the layered save is an A+B outfit.
        if (__elloCtlB.garmentA) elloSetOutfitBase([__elloCtlB.garmentA]);
        // Layer garment B on top.
        window.elloSelectedGarment = __elloCtlB.itemB;

        startTryOn();
    } catch (e) {
        window.__elloCtlLayeringInB = false;
        elloRenderCtlOffer();   // reset the button so it never sticks on "Styling…"
        elloCtlPanelError("Couldn't add that piece. Try again.");
    }
}

// Both state: one slim row — two selectable thumbs + an adaptive add button.
// No headline, no item names (Andrew 2026-07-03: the shopper KNOWS what
// they're wearing — don't crowd the hero). Tapping a thumb includes/excludes
// that piece, so a shopper can add just one of the two; the button label and
// total follow the selection.
function elloRenderCtlBoth(resultB64) {
    var panel = __elloCtlB.panelEl, item = __elloCtlB.itemB, A = __elloCtlB.garmentA;
    if (!panel || !item) return;
    if (resultB64) __elloCtlB.outfitResultB64 = resultB64;   // combined A+B render
    __elloCtlB.sel = { a: true, b: true };
    panel.innerHTML =
        '<div class="ectl-brow">' +
            '<button type="button" class="ectl-pick" data-pick="a"><img alt=""><span class="ectl-tick">' + ELLO_CTL_TICK + '</span></button>' +
            '<button type="button" class="ectl-pick" data-pick="b"><img alt=""><span class="ectl-tick">' + ELLO_CTL_TICK + '</span></button>' +
            '<button type="button" class="ectl-add" id="ectl-add-btn">' + ELLO_CTL_BAG + '<span id="ectl-add-lbl"></span></button>' +
        '</div>' +
        '<div class="ectl-msg" id="ectl-msg" style="display:none;"></div>';
    var pickA = panel.querySelector('[data-pick="a"]');
    var pickB = panel.querySelector('[data-pick="b"]');
    pickA.querySelector('img').src = elloCtlImgUrl((A && A.image_url) || '', 160);
    pickB.querySelector('img').src = elloCtlImgUrl(item.image_url || '', 160);
    pickA.setAttribute('aria-label', 'Include ' + ((A && A.name) || 'the first item'));
    pickB.setAttribute('aria-label', 'Include ' + (item.name || 'the second item'));
    function refresh() {
        var s = __elloCtlB.sel;
        pickA.classList.toggle('is-on', !!s.a);
        pickB.classList.toggle('is-on', !!s.b);
        var addBtn = panel.querySelector('#ectl-add-btn');
        var lbl = panel.querySelector('#ectl-add-lbl');
        var n = (s.a ? 1 : 0) + (s.b ? 1 : 0);
        var total = (s.a ? elloCtlNum(__elloCtlB.priceA) : 0) + (s.b ? elloCtlNum(item.price) : 0);
        if (addBtn) addBtn.disabled = n === 0;
        if (lbl) lbl.textContent = n === 0 ? 'Select an item'
            : (n === 2 ? 'Add both · ' + elloCtlMoney(total) : 'Add to cart · ' + elloCtlMoney(total));
        // Live mirror customization (Andrew 2026-07-03): dropping the layered
        // piece (B) reverts the hero to the item-A-only render; re-adding it
        // brings the outfit back. Deselecting A keeps the outfit on the hero —
        // a "just B" body was never rendered, so there's nothing truer to show.
        // Skipped while the layer pass's reveal is still in flight.
        if (!__elloPdpSwap.loadingEl) {
            // Zero pieces selected → the mirror empties too (Andrew 2026-07-13):
            // show the shopper's ORIGINAL photo, not a render they just took
            // off. Falls back to the item-A render when the true photo isn't
            // retrievable (model photo in a fresh context).
            var want;
            if (!s.a && !s.b) want = elloCtlOriginalUserPhoto() || __elloCtlB.baseResultB64 || null;
            else if (!s.b && __elloCtlB.baseResultB64) want = __elloCtlB.baseResultB64;
            else want = __elloCtlB.outfitResultB64 || null;
            // Compare against the RAW render — the hero itself may hold the
            // box-shaped composite of it, which would never string-match.
            if (want && want !== (__elloPdpSwap.resultRawUrl || __elloPdpSwap.resultUrl)) elloCtlSetHeroResult(want);
        }
    }
    var tapA = function () { __elloCtlB.sel.a = !__elloCtlB.sel.a; refresh(); };
    var tapB = function () { __elloCtlB.sel.b = !__elloCtlB.sel.b; refresh(); };
    pickA.addEventListener('click', tapA); pickA.__elloTap = tapA;
    pickB.addEventListener('click', tapB); pickB.__elloTap = tapB;
    refresh();
    var addBtn = panel.querySelector('#ectl-add-btn');
    if (addBtn) { addBtn.addEventListener('click', elloAddOutfitToCartB); addBtn.__elloTap = elloAddOutfitToCartB; }
}

function elloCtlPanelError(msg) {
    var panel = __elloCtlB.panelEl; if (!panel) return;
    var el = panel.querySelector('#ectl-msg');
    if (!el) { el = document.createElement('div'); el.id = 'ectl-msg'; el.className = 'ectl-msg'; panel.appendChild(el); }
    el.className = 'ectl-msg err'; el.textContent = msg; el.style.display = 'block';
}

// Resolve a cart-ready variant for an item: prefers a hinted variant (A's
// tried-on color), detects a size axis and asks ONLY for size, aborts on sold
// out. Returns { directVariantId } or { sizes, ... } (for the picker) or null.
async function elloResolveCartVariantForItem(item, preferVariantId) {
    var handle = item && (item.handle || item.id);
    var json = handle ? await elloFetchProductJson(handle) : null;
    if (!json || !Array.isArray(json.variants) || !json.variants.length) {
        var vs = (item && Array.isArray(item.variants)) ? item.variants : [];
        var av = vs.filter(function (v) { return v && v.available !== false; });
        var pick = av[0] || vs[0];
        return pick ? { directVariantId: pick.id } : null;
    }
    var V = null;
    if (preferVariantId) {
        var want = String(preferVariantId).replace(/^gid:\/\/shopify\/ProductVariant\//, '');
        V = json.variants.find(function (x) { return String(x.id) === want; });
    }
    if (!V && item && item.image_url) {
        // Color-match the variant to the image the shopper actually SAW (the
        // offer thumb + layered render use item.image_url). Without this,
        // "first available" could silently add a DIFFERENT color than the one
        // rendered on a many-color product (LA Apparel: 58 colors).
        var wantImg = elloImageBaseName(item.image_url);
        if (wantImg) {
            V = json.variants.find(function (x) {
                return x.available && x.featured_image && x.featured_image.src &&
                       elloImageBaseName(x.featured_image.src) === wantImg;
            }) || null;
        }
    }
    if (!V) V = json.variants.find(function (x) { return x.available; }) || json.variants[0];
    if (!V) return null;
    var optNames = (json.options || []).map(function (o) { return (typeof o === 'string') ? o : ((o && o.name) || ''); });
    var sizeIdx = -1;
    for (var i = 0; i < optNames.length; i++) { if (/size/i.test(optNames[i])) { sizeIdx = i; break; } }
    if (sizeIdx === -1) return { directVariantId: V.id };
    var sizeKey = 'option' + (sizeIdx + 1);
    var sizes = json.variants.filter(function (x) {
        for (var k = 0; k < optNames.length; k++) { if (k === sizeIdx) continue; if (x['option' + (k + 1)] !== V['option' + (k + 1)]) return false; }
        return true;
    }).map(function (x) { return { label: x[sizeKey], variantId: x.id, available: x.available !== false }; });
    if (sizes.length <= 1) return { directVariantId: V.id };
    var availSizes = sizes.filter(function (s) { return s.available; });
    if (!availSizes.length) return null;                    // whole color sold out
    var colorLabel = optNames.map(function (n, k) { return k !== sizeIdx ? V['option' + (k + 1)] : null; }).filter(Boolean).join(' · ');
    var image = (V.featured_image && V.featured_image.src) ? elloAbsImageUrl(V.featured_image.src) : (item.image_url || null);
    return { sizes: sizes, colorLabel: colorLabel, image: image, title: json.title || (item && item.name) || '' };
}

// Resolve → numeric variant id (shows the size picker only when needed).
// Returns { id } , { soldOut:true } , or { cancelled:true }.
async function elloCtlResolveVariantId(item, preferVariantId) {
    var r = await elloResolveCartVariantForItem(item, preferVariantId);
    if (!r) return { soldOut: true };
    if (r.directVariantId) return { id: String(r.directVariantId).replace(/^gid:\/\/shopify\/ProductVariant\//, '') };
    if (r.sizes && r.sizes.length) {
        var vid = await elloShowSizePicker(r);
        if (!vid) return { cancelled: true };
        return { id: String(vid).replace(/^gid:\/\/shopify\/ProductVariant\//, '') };
    }
    return { soldOut: true };
}

// One-tap "Add both to cart" from the hero panel. Resolves A (frozen tried-on
// color) + B variants, dedupes A against the live cart (theme ATC may have
// already added it), adds via ONE multi-line /cart/add.js, preserves attribution.
async function elloAddOutfitToCartB() {
    var panel = __elloCtlB.panelEl;
    var addBtn = panel && panel.querySelector('#ectl-add-btn');
    var lbl = panel && panel.querySelector('#ectl-add-lbl');
    var item = __elloCtlB.itemB, A = __elloCtlB.garmentA;
    if (!item) return;
    var restoreLbl = lbl ? lbl.textContent : '';
    if (addBtn) { addBtn.disabled = true; }
    if (lbl) { lbl.textContent = 'Adding…'; }
    var msg = panel && panel.querySelector('#ectl-msg'); if (msg) msg.style.display = 'none';

    try {
        // Only resolve what the shopper left selected — never pop a size picker
        // for a piece they excluded.
        var sel = __elloCtlB.sel || { a: true, b: true };
        var vA = null, vB = null;
        if (sel.a && A) {
            // A: use the frozen tried-on variant as the color hint.
            var vaRes = await elloCtlResolveVariantId(A, __elloCtlB.triedOnVariantA && __elloCtlB.triedOnVariantA.id);
            if (vaRes.cancelled) { if (addBtn) addBtn.disabled = false; if (lbl) lbl.textContent = restoreLbl; return; }
            // A sold out only blocks the add when it's the ONLY piece selected;
            // alongside B we keep the old behavior and still add B.
            if (vaRes.soldOut && !sel.b) throw new Error(((A && A.name) || 'This item') + ' is sold out.');
            vA = vaRes.id || null;
        }
        if (sel.b) {
            // B: resolve from its own product.
            var vbRes = await elloCtlResolveVariantId(item, null);
            if (vbRes.cancelled) { if (addBtn) addBtn.disabled = false; if (lbl) lbl.textContent = restoreLbl; return; }
            if (vbRes.soldOut) throw new Error((item.name || 'That piece') + ' is sold out.');
            vB = vbRes.id;
        }

        // Dedupe A against the live cart so it never lands twice (theme ATC path).
        var addedLine = false;
        if (vA) {
            try {
                var cart = await fetch('/cart.js', { headers: { 'Accept': 'application/json' } }).then(function (r) { return r.ok ? r.json() : null; });
                if (cart && Array.isArray(cart.items)) {
                    addedLine = cart.items.some(function (li) { return String(li.id) === String(vA) || String(li.variant_id) === String(vA); });
                }
            } catch (e) { /* if /cart.js fails, fall through and add both */ }
        }

        var items = [];
        if (vA && !addedLine) items.push({ id: vA, quantity: 1 });
        if (vB) items.push({ id: vB, quantity: 1 });
        // Nothing left to add (only A selected and the theme ATC already put it
        // in the cart) — it IS in the cart, so show success.
        if (!items.length) {
            elloRenderCtlSuccess();
            if (A) window.elloSelectedGarment = A;
            return;
        }

        var res = await fetch('/cart/add.js', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ items: items })
        });
        if (!res.ok) {
            var eb = await res.json().catch(function () { return {}; });
            throw new Error(eb.description || eb.message || ("Couldn't add to cart (HTTP " + res.status + ")"));
        }

        // Attribution: track the added lines + write the session cart attribute
        // (the Web Pixel JOIN needs it on the native-ATC hero path). Best-effort.
        try {
            if (vA && !addedLine && typeof trackEvent === 'function') trackEvent('inline_add_to_cart', { variant_id: vA });
            if (vB && typeof trackEvent === 'function') trackEvent('inline_add_to_cart', { variant_id: vB });
            if (vB && typeof trackEvent === 'function') trackEvent('complete_the_look_add', { variant_id: vB });
        } catch (e) {}
        try {
            if (window.ELLO_SESSION_ID) {
                await fetch('/cart/update.js', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ attributes: { ello_session_id: window.ELLO_SESSION_ID } })
                });
            }
        } catch (e) {}

        try { await elloRefreshThemeCart(); } catch (e) { /* no reload — would wipe the hero */ }

        elloRenderCtlSuccess();
        // Restore the page's selected garment to A for consistency.
        if (A) window.elloSelectedGarment = A;
    } catch (err) {
        if (addBtn) addBtn.disabled = false;
        if (lbl) lbl.textContent = restoreLbl;
        elloCtlPanelError(err && err.message ? err.message : "Sorry, something went wrong adding to cart.");
    }
}

function elloRenderCtlSuccess() {
    var panel = __elloCtlB.panelEl; if (!panel) return;
    panel.innerHTML =
        '<div class="ectl-head" style="justify-content:center;color:#0a7d34;">✓&nbsp;<span>Added to cart</span></div>' +
        '<button type="button" class="ectl-link" id="ectl-viewcart">View cart</button>';
    var vc = panel.querySelector('#ectl-viewcart');
    if (vc) {
        var goCart = function () {
            try { window.top.location.href = '/cart'; } catch (e) { window.location.href = '/cart'; }
        };
        vc.addEventListener('click', goCart);
        vc.__elloTap = goCart;
    }
}

// Soft-abort a failed LAYER pass: keep item A on the hero (do NOT call
// elloAbortPdpSwap, which restores the true product photo), just drop the
// loading card and reset the offer card so the shopper can retry.
function elloCtlAbortLayer() {
    if (__elloPdpSwap.progressTimer) { clearInterval(__elloPdpSwap.progressTimer); __elloPdpSwap.progressTimer = null; }
    if (__elloPdpSwap.loadingEl) { try { __elloPdpSwap.loadingEl.remove(); } catch (e) {} __elloPdpSwap.loadingEl = null; }
    window.__elloCtlLayeringInB = false;
    window.__elloPdpSwapActive = false;
    if (__elloCtlB.garmentA) window.elloSelectedGarment = __elloCtlB.garmentA;
    try { elloRenderCtlOffer(); } catch (e) {}
    elloCtlPanelError("Couldn't add that piece. Please try again.");
}

function elloTeardownCtlPdpPanel() {
    if (__elloCtlB.panelEl) { try { __elloCtlB.panelEl.remove(); } catch (e) {} }
    var stray = document.getElementById('ello-ctl-pdp-panel');
    if (stray) { try { stray.remove(); } catch (e) {} }
    __elloCtlB.panelEl = null;
    __elloCtlB.layered = false;
}

// Return-visit restore of a LAYERED look: rebuild the panel straight into the
// two-piece "Add both" state from the cached garment A + item B — no
// recommender fetch, no offer step (the shopper already accepted the offer
// last visit). Mirrors elloMountCtlPdpPanel's mounting exactly.
function elloRestoreCtlOutfitPanel(garmentA, itemB, variantA, baseB64, outfitB64) {
    try {
        var img = __elloPdpSwap.imgEl;
        if (!img || !garmentA || !itemB) return;
        elloEnsureCtlPdpStyles();
        elloTeardownCtlPdpPanel();   // before state setup — teardown resets .layered
        __elloCtlB.baseResultB64 = baseB64 || null;
        __elloCtlB.outfitResultB64 = outfitB64 || null;
        __elloCtlB.garmentA = garmentA;
        __elloCtlB.priceA = elloCtlNum(garmentA.price);
        __elloCtlB.triedOnVariantA = variantA || null;
        __elloCtlB.triedOnHandleA = garmentA.id || null;
        __elloCtlB.itemB = itemB;
        __elloCtlB.layered = true;
        __elloCtlB.resolvedVB = null;
        elloCtlStashUserPhoto();   // page just loaded — userPhoto is un-re-based
        var panel = document.createElement('div');
        panel.id = 'ello-ctl-pdp-panel';
        panel.addEventListener('click', function (ev) { ev.stopPropagation(); });
        __elloCtlB.panelEl = panel;
        elloRenderCtlBoth(null);
        var wrap = elloPdpAnchor(img);
        __elloCtlB.wrapEl = wrap;
        if (wrap) wrap.appendChild(panel);
        elloInstallPdpTapShield();
        // Backfill a missing catalog price (unsynced demo stores) and repaint the
        // total once resolved — the two-piece panel renders synchronously above.
        if (!(__elloCtlB.priceA > 0)) {
            elloResolveCtlPriceA(garmentA, variantA, garmentA.id).then(function (p) {
                if (p > 0 && __elloCtlB.panelEl) { __elloCtlB.priceA = p; elloRenderCtlBoth(__elloCtlB.outfitResultB64); }
            });
        }
    } catch (e) { try { elloTeardownCtlPdpPanel(); } catch (e2) {} }
}

window.elloMountCtlPdpPanel = elloMountCtlPdpPanel;

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
        .virtual-tryon-widget.inline-mode .mode-tabs,
        .virtual-tryon-widget.inline-mode .selected-clothing-remove,
        .virtual-tryon-widget.inline-mode .section-title { display: none !important; }

        /* Hub mode (pdpImageSwapEnabled): keep the focused PDP layout but bring
           back Browse Full Collection + Wardrobe so the shopper can still reach
           the full catalog and their saved looks. More specific than the rule
           above, so it wins. */
        .virtual-tryon-widget.inline-mode.ello-pdp-hub .browse-all-btn,
        .virtual-tryon-widget.inline-mode.ello-pdp-hub .wardrobe-btn { display: flex !important; }

        /* ID-prefixed duplicates of the hide + restore pair above. The template
           carries ID-specificity !important rules (e.g. the mobile "ensure all
           content sections are visible" block) that outranked the class-only
           hides on phones — the full browse home leaked under inline/focused
           views. Matching the container ID makes the hide win everywhere; the
           restore stays one class more specific so hub/focused keep their
           Browse + Wardrobe doors. */
        #virtual-tryon-widget-container .virtual-tryon-widget.inline-mode .featured-section,
        #virtual-tryon-widget-container .virtual-tryon-widget.inline-mode .quick-picks-section { display: none !important; }
        #virtual-tryon-widget-container .virtual-tryon-widget.inline-mode.ello-pdp-hub .browse-all-btn,
        #virtual-tryon-widget-container .virtual-tryon-widget.inline-mode.ello-pdp-hub .wardrobe-btn { display: flex !important; }

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
            font-weight: var(--ello-fw-500, 500);
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
        /* Hub mode brings the model option back (secondary to "your photo") so
           the no-photo workspace, if ever reached, still offers both choices. */
        .virtual-tryon-widget.inline-mode.ello-pdp-hub #useModelCard { display: flex !important; }

        /* Photo already uploaded → hide the upload cards entirely. Inline mode
           forces .upload-options-container display:block !important, so we need a
           more specific selector to win. Fixes the "Add your photo" card showing
           next to the photo the shopper already gave us. */
        .virtual-tryon-widget.inline-mode.has-user-photo .upload-options-container { display: none !important; }

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
        /* Pre-upload only: let the content wrapper fill the panel + center the
           workspace, so the cards sit in the MIDDLE instead of hugging the top
           over a tall white void. The result view (.inline-mode-result-ready)
           keeps its normal top-anchored flow. */
        .virtual-tryon-widget.inline-mode:not(.inline-mode-result-ready) .tryon-content {
            flex: 1 1 auto !important;
            display: flex !important;
            flex-direction: column !important;
            justify-content: center !important;
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
            font-weight: var(--ello-fw-600, 600) !important;
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
            font-weight: var(--ello-fw-600, 600) !important;
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
            font-weight: var(--ello-fw-500, 500);
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
            font: inherit; font-weight: var(--ello-fw-600, 600); font-size: 15px;
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
            font-size: 20px; color: #059669; font-weight: var(--ello-fw-600, 600);
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

    // "Try on more" only makes sense in inline-button mode — it hands the
    // shopper from the focused PDP experience to the full widget (featured,
    // quick picks, wardrobe). The floating widget is already the full widget.
    const showTryMore = !!window.ELLO_INLINE_MODE;

    const priceLabel = derivePriceLabel();
    ctas.innerHTML = `
        <div class="ello-inline-attribution">
            powered by <a href="https://apps.shopify.com/ello" target="_blank" rel="noopener noreferrer">Ello.services</a>
        </div>
        <div class="ello-inline-btn-row">
            <button class="ello-inline-btn ello-inline-btn-primary" id="ello-inline-add-to-cart-btn">
                Add to Cart${priceLabel}
            </button>
            ${showTryMore ? `
            <button class="ello-inline-btn ello-inline-btn-secondary" id="ello-inline-try-more-btn">
                Try on more
            </button>` : ''}
        </div>
        <div id="ello-inline-cart-error" style="display:none;"></div>
    `;
    resultSection.appendChild(ctas);

    document.getElementById('ello-inline-add-to-cart-btn').addEventListener('click', addToCartFromTryOn);
    const tryMoreBtn = document.getElementById('ello-inline-try-more-btn');
    if (tryMoreBtn) {
        tryMoreBtn.addEventListener('click', function () {
            // Hand off from the focused inline experience to the full widget —
            // featured item, quick picks, browse, and wardrobe. The shopper's
            // photo stays loaded; they can still change it from there if they
            // want, but we don't push them to.
            window.ELLO_INLINE_MODE = false;
            window.ELLO_AUTO_FIRE = false;
            window.ELLO_INLINE_CTX = null;
            const rs = document.getElementById('resultSection');
            if (rs) rs.style.display = 'none';
            const w = document.getElementById('virtualTryonWidget');
            if (w) {
                w.classList.remove('inline-mode', 'inline-mode-result-ready');
                w.scrollTop = 0;
            }
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

// ─── Theme cart UI refresh (theme-agnostic, best-effort + guaranteed) ───────
// Shopify adds the item server-side via /cart/add.js, but the MERCHANT's theme
// owns the cart icon + drawer and has no idea a third-party widget just added
// something — so its count/drawer go stale until a reload. We update it IN PLACE
// (a full reload would destroy the try-on result the shopper is looking at):
//   1. Re-render the standard cart sections (Shopify Section Rendering API) and
//      swap them in — how Dawn + the whole OS 2.0 theme family update their cart.
//   2. Patch common cart-count selectors directly from /cart.js — the universal
//      fallback that works even on themes whose sections we don't match.
//   3. Dispatch the cart events themes commonly listen for.
// Whatever we can't reach still leaves the in-widget "View cart" button as a
// 100%-reliable path. Call after ANY successful /cart/add.js.

// Standard cart section ids across Dawn and the vast majority of OS 2.0 themes.
// Sections that don't exist are simply omitted from Shopify's response.
var ELLO_CART_SECTION_IDS = [
    'cart-icon-bubble', 'cart-live-region-text', 'cart-drawer',
    'cart-notification', 'cart-notification-product',
    'main-cart-items', 'main-cart-footer', 'header'
];

function elloApplyCartSections(sections) {
    if (!sections || typeof sections !== 'object') return;
    var parser = new DOMParser();
    Object.keys(sections).forEach(function (id) {
        var html = sections[id];
        if (typeof html !== 'string' || !html) return;
        // Themes mount these either as a full section (#shopify-section-<id>) or
        // as a bare snippet container (#<id>, e.g. Dawn's #cart-icon-bubble).
        var live = document.getElementById('shopify-section-' + id) || document.getElementById(id);
        if (!live) return;
        try {
            var doc = parser.parseFromString(html, 'text/html');
            var src = doc.getElementById('shopify-section-' + id) || doc.getElementById(id) || doc.body;
            if (src) live.innerHTML = src.innerHTML;
        } catch (e) { /* skip this section */ }
    });
}

function elloUpdateCartCount(count) {
    if (typeof count !== 'number') return;
    var sels = [
        '.cart-count-bubble', '.cart-count', '#CartCount', '#cart-icon-bubble .cart-count-bubble',
        '[data-cart-count]', '.cart-link__bubble', '.header__cart-count',
        '.site-header__cart-count', '.cart-counter', '.js-cart-count',
        '.cart-item-count', '.cart-count-badge', '.cart-qty'
    ];
    var nodes;
    try { nodes = document.querySelectorAll(sels.join(',')); } catch (e) { return; }
    nodes.forEach(function (n) {
        if (n.hasAttribute && n.hasAttribute('data-cart-count')) n.setAttribute('data-cart-count', String(count));
        // Set the number on the deepest count-only text node so we don't wipe
        // sibling markup (icons, aria-hidden spans) that themes nest in the bubble.
        var span = n.querySelector && (n.querySelector('span[aria-hidden="true"]') || n.querySelector('span'));
        if (span && /^\s*\d*\s*$/.test(span.textContent)) span.textContent = String(count);
        else if (/^\s*\d*\s*$/.test(n.textContent)) n.textContent = String(count);
        if (count > 0) {
            // Themes hide an empty bubble — reveal it now that there's an item.
            if (n.classList) n.classList.remove('hidden', 'is-empty', 'cart-count-bubble--hidden', 'visually-hidden');
            if (n.hasAttribute && n.hasAttribute('hidden')) n.removeAttribute('hidden');
        }
    });
}

function elloDispatchCartEvents(cart) {
    function fire(name, detail) {
        try { document.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: detail })); } catch (e) {}
    }
    // Cross-theme conventions (different theme families listen to different names).
    fire('cart:refresh', { source: 'ello' });
    fire('cart:updated', { cart: cart });
    fire('cart:build', { cart: cart });
    fire('ajaxProduct:added', { cart: cart });
    // Dawn pub/sub — themes subscribe to PUB_SUB_EVENTS.cartUpdate.
    try {
        if (typeof window.publish === 'function' && window.PUB_SUB_EVENTS && window.PUB_SUB_EVENTS.cartUpdate) {
            window.publish(window.PUB_SUB_EVENTS.cartUpdate, { source: 'ello', cartData: cart });
        }
    } catch (e) {}
    // Legacy jQuery themes.
    try { if (window.jQuery) window.jQuery(document).trigger('cart.requestComplete', cart); } catch (e) {}
}

async function elloRefreshThemeCart() {
    // 1. Re-render the standard cart sections and swap them in.
    try {
        var sr = await fetch(window.location.pathname + '?sections=' + ELLO_CART_SECTION_IDS.join(','), {
            headers: { 'Accept': 'application/json' }, credentials: 'same-origin'
        });
        if (sr.ok) {
            var sections = await sr.json().catch(function () { return null; });
            if (sections) elloApplyCartSections(sections);
        }
    } catch (e) { /* section rendering unsupported — count + events still run */ }

    // 2. Authoritative count from /cart.js, patched into common bubble selectors.
    var cart = null;
    try {
        var cr = await fetch('/cart.js', { headers: { 'Accept': 'application/json' }, credentials: 'same-origin' });
        if (cr.ok) cart = await cr.json();
    } catch (e) {}
    if (cart) elloUpdateCartCount(cart.item_count);

    // 3. Tell theme JS the cart changed.
    elloDispatchCartEvents(cart);

    return cart;
}

// Resolve which variant to add to cart from a try-on. We already know the
// variant (color/version) the shopper tried on, so we only ask for SIZE within
// that color — and skip the picker entirely when there's no size dimension.
// Returns: { directVariantId } → add straight away; { sizes, ... } → show the
// size picker; null → couldn't resolve (caller uses the legacy picker).
async function elloResolveCartVariant() {
    var handle = window.__elloTriedOnHandle
        || ((typeof getProductIdFromUrl === 'function') ? getProductIdFromUrl(window.location.pathname) : null);
    if (!handle) return null;
    var json = await elloFetchProductJson(handle);
    if (!json || !Array.isArray(json.variants) || !json.variants.length) return null;

    // The tried-on variant: what we color-corrected to, else the URL ?variant=,
    // else the first available.
    var vid = (window.__elloTriedOnVariant && window.__elloTriedOnVariant.id) || null;
    if (!vid) { try { vid = new URLSearchParams(window.location.search).get('variant'); } catch (e) {} }
    var V = null;
    if (vid) { var want = String(vid).replace(/^gid:\/\/shopify\/ProductVariant\//, ''); V = json.variants.find(function (x) { return String(x.id) === want; }); }
    if (!V) V = json.variants.find(function (x) { return x.available; }) || json.variants[0];
    if (!V) return null;

    var optNames = (json.options || []).map(function (o) { return (typeof o === 'string') ? o : ((o && o.name) || ''); });
    var sizeIdx = -1;
    for (var i = 0; i < optNames.length; i++) { if (/size/i.test(optNames[i])) { sizeIdx = i; break; } }
    if (sizeIdx === -1) return { directVariantId: V.id }; // no size dimension → add the tried-on variant

    var sizeKey = 'option' + (sizeIdx + 1);
    var sizes = json.variants.filter(function (x) {
        for (var k = 0; k < optNames.length; k++) { if (k === sizeIdx) continue; if (x['option' + (k + 1)] !== V['option' + (k + 1)]) return false; }
        return true;
    }).map(function (x) { return { label: x[sizeKey], variantId: x.id, available: x.available !== false }; });
    if (sizes.length <= 1) return { directVariantId: V.id }; // only one size in this color → add directly

    var colorLabel = optNames.map(function (n, k) { return k !== sizeIdx ? V['option' + (k + 1)] : null; }).filter(Boolean).join(' · ');
    var image = (V.featured_image && V.featured_image.src) ? elloAbsImageUrl(V.featured_image.src) : null;
    return { sizes: sizes, colorLabel: colorLabel, image: image, title: json.title || '' };
}

// Size-only picker for the tried-on color. Returns Promise<variantId|null>.
function elloShowSizePicker(info) {
    return new Promise(function (resolve) {
        var overlay = document.createElement('div');
        overlay.id = 'ello-sz-overlay';   // pass-through marker for the PDP tap shield
        overlay.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;height:100dvh;background:rgba(0,0,0,.55);z-index:2147483647;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
        var sizesHtml = info.sizes.map(function (s) {
            var dis = s.available ? '' : 'opacity:.4;cursor:not-allowed;text-decoration:line-through;';
            return '<button class="ello-sz" data-vid="' + s.variantId + '" data-av="' + (s.available ? '1' : '0') + '" style="padding:13px 8px;border:1.5px solid #e3e3e3;background:#fff;border-radius:12px;font:inherit;font-weight:var(--ello-fw-600, 600);font-size:14px;color:#111;cursor:pointer;text-transform:uppercase;letter-spacing:.04em;transition:all .15s;' + dis + '">' + (s.label || '-') + '</button>';
        }).join('');
        var sub = [info.title, info.colorLabel].filter(Boolean).join(' · ');
        overlay.innerHTML =
            '<div style="background:#fff;padding:24px 22px 20px;border-radius:20px;max-width:360px;width:90%;box-shadow:0 24px 70px rgba(0,0,0,.3);font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;">' +
            (info.image ? '<div style="text-align:center;margin-bottom:12px;"><img src="' + info.image + '" alt="" style="width:84px;height:104px;object-fit:cover;border-radius:12px;display:inline-block;"></div>' : '') +
            '<div style="text-align:center;margin-bottom:4px;font-size:17px;font-weight:var(--ello-fw-700, 700);color:#111;">Select your size</div>' +
            (sub ? '<div style="text-align:center;margin-bottom:18px;color:#777;font-size:13px;">' + sub + '</div>' : '<div style="margin-bottom:18px;"></div>') +
            '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-bottom:18px;">' + sizesHtml + '</div>' +
            '<div style="display:flex;gap:10px;">' +
            '<button id="ello-sz-cancel" style="flex:1;padding:13px;background:#f1f1f1;border:none;border-radius:12px;cursor:pointer;font:inherit;font-weight:var(--ello-fw-600, 600);color:#555;font-size:14px;">Cancel</button>' +
            '<button id="ello-sz-add" disabled style="flex:1.4;padding:13px;background:#111;color:#fff;border:none;border-radius:12px;cursor:pointer;font:inherit;font-weight:var(--ello-fw-600, 600);font-size:14px;opacity:.45;">Add to cart</button>' +
            '</div></div>';
        document.body.appendChild(overlay);
        var chosen = null;
        var addBtn = overlay.querySelector('#ello-sz-add');
        overlay.querySelectorAll('.ello-sz').forEach(function (b) {
            if (b.getAttribute('data-av') !== '1') return;
            b.addEventListener('click', function () {
                overlay.querySelectorAll('.ello-sz').forEach(function (x) { x.style.background = '#fff'; x.style.color = '#111'; x.style.borderColor = '#e3e3e3'; });
                b.style.background = '#111'; b.style.color = '#fff'; b.style.borderColor = '#111';
                chosen = b.getAttribute('data-vid');
                addBtn.disabled = false; addBtn.style.opacity = '1';
            });
        });
        var close = function (val) { try { overlay.remove(); } catch (e) {} resolve(val); };
        overlay.querySelector('#ello-sz-cancel').addEventListener('click', function () { close(null); });
        addBtn.addEventListener('click', function () { if (chosen) close(chosen); });
        overlay.addEventListener('click', function (e) { if (e.target === overlay) close(null); });
    });
}

// Add-to-Cart: knows the tried-on variant (color), so it only asks for SIZE via
// elloResolveCartVariant/elloShowSizePicker — falling back to the legacy
// showSizeSelector. Calls Shopify's standard /cart/add.js — works on every theme.
async function addToCartFromTryOn() {
    const btn = document.getElementById('ello-inline-add-to-cart-btn');
    const errEl = document.getElementById('ello-inline-cart-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

    try {
        if (btn) { btn.disabled = true; btn.textContent = 'Adding...'; }

        let variantId = null;
        const garment = window.elloSelectedGarment;

        // Smart path: we know the color/version they tried on, so only ask for
        // size within it (and skip the picker when there's no size to choose).
        let resolvedByCart = false;
        try {
            const r = await elloResolveCartVariant();
            if (r && r.directVariantId) {
                variantId = r.directVariantId;
                resolvedByCart = true;
            } else if (r && r.sizes && r.sizes.length) {
                variantId = await elloShowSizePicker(r);   // null if cancelled
                resolvedByCart = true;
                if (!variantId) {
                    // Cancelled the size picker — abort cleanly, restore the button.
                    if (btn) { btn.disabled = false; btn.textContent = 'Add to Cart' + (typeof derivePriceLabel === 'function' ? derivePriceLabel() : ''); }
                    return;
                }
            }
        } catch (e) { /* fall back to the legacy picker */ }

        // Legacy fallback (no tried-on variant / no product JSON): the old picker.
        if (!resolvedByCart) {
            variantId = window.ELLO_INLINE_CTX && window.ELLO_INLINE_CTX.variantId;
            if (garment && Array.isArray(garment.variants) && garment.variants.length > 1) {
                window.ELLO_PRESELECTED_VARIANT_ID = null;
                variantId = await showSizeSelector(garment);
            } else if (!variantId && garment) {
                variantId = garment.selectedVariantId
                    || (garment.variants && garment.variants[0] && (garment.variants[0].shopify_variant_gid || garment.variants[0].id))
                    || null;
            }
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

        // Refresh the merchant's theme cart UI (count + drawer) in place so the
        // shopper sees the item immediately — no full reload (which would wipe
        // the try-on result they're looking at).
        try { await elloRefreshThemeCart(); } catch (e) { /* non-fatal */ }

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
                style="box-sizing:border-box;width:100%;padding:14px 20px;border:1px solid #d1d5db;border-radius:6px;background:transparent;color:#000;font:inherit;font-weight:var(--ello-fw-600, 600);font-size:15px;cursor:pointer;">
            Continue shopping
        </button>
        <button class="ello-inline-btn ello-inline-btn-primary" id="ello-inline-view-cart-btn"
                style="box-sizing:border-box;width:100%;padding:14px 20px;border:none;border-radius:6px;background:#000;color:#fff;font:inherit;font-weight:var(--ello-fw-600, 600);font-size:15px;cursor:pointer;">
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

var startTryOn = async function startTryOn() {
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

    // PDP swap: the result renders on the PDP hero image and the panel is hidden,
    // so we skip the in-panel loading bar (a badge on the image stands in for it —
    // see elloBeginPdpSwapLoading below, after the photo/garment guards).
    if (!elloPdpSwapOn()) {
        // Show loading bar
        showLoadingBar(true);

        // Scroll to show the loading bar immediately
        scrollToLoadingBar();
    }

    clearError?.();
    // Clear rate limit state when starting new try-on (in case limit was reset)
    isRateLimited = false;

    // Color-correct garment: the catalog stores ONE (color-blind) image per
    // product, so on a product page we try on the SELECTED variant's image — the
    // URL ?variant= is the source of truth for the chosen color. Only overrides
    // when the garment IS the current product; any failure keeps the catalog
    // image. (Decoupled from the swap experiment — applies in the normal widget.)
    await elloApplyColorCorrectGarment();

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

    // PDP swap: now that photo + garment are valid, hide the panel and show a
    // loading badge on the PDP hero image. If no PDP image resolves, fall back to
    // the in-panel loading bar + result so the try-on still completes normally.
    // Surface routing: the hero swap runs whenever elloPdpSwapOn() is true —
    // that includes CTL Scenario B (the layering pass short-circuits
    // elloPdpSwapOn to stay on the hero). When it's false the result stays in the
    // widget, where CTL Scenario A renders its rail. So CTL no longer suppresses
    // the swap; it RIDES it in B and lives in-widget in A.
    let elloIsPdpSwap = false;
    if (elloPdpSwapOn()) {
        elloIsPdpSwap = elloBeginPdpSwapLoading();
        if (!elloIsPdpSwap) {
            showLoadingBar(true);
            scrollToLoadingBar();
        }
    }
    window.__elloPdpSwapActive = elloIsPdpSwap;

    // Keep resultSection hidden until image is ready (no blank space)
    const resultSection = document.getElementById("resultSection");
    // Tear down any prior Complete-the-Look surfaces so a fresh try-on never
    // shows a stale suggestion. NOT during a layer pass — that pass must keep the
    // hero panel alive so it can morph to "add both".
    try { elloTeardownCompleteTheLook(); } catch (e) {}
    if (!window.__elloCtlLayeringInB) { try { elloTeardownCtlPdpPanel(); } catch (e) {} }
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

        // Attribution insurance: the shopper just successfully tried something
        // on, so stamp the cart with the session id NOW — before they decide how
        // to check out. Covers theme-native ATC and cart-based wallet paths that
        // never hit an Ello button. Best-effort; never blocks the result.
        elloWriteSessionCartAttr();

        // PDP swap: render the result onto the PDP hero image and keep the
        // panel hidden so the shopper buys while looking at themselves. Wardrobe
        // + lead capture still run; then bail before the in-panel render path.
        if (window.__elloPdpSwapActive) {
            elloFinishPdpSwap(imageB64);
            if (garment && imageB64 && activePhotoValidationStatus !== 'pending') {
                const tryOnId = 'tryon_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                autoSaveToWardrobe(garment, imageB64, tryOnId).catch(err => {
                    console.error('Error auto-saving to wardrobe:', err);
                });
            }
            elloMaybeShowLeadCapture(garment);
            window.__elloPdpSwapActive = false;
            // Complete the Look (Scenario B): stash the latest result for
            // layering, then either morph the panel to "add both" (this WAS the
            // layer pass) or mount the offer card below the hero (base pass).
            // Best-effort — never blocks the result the shopper is looking at.
            try {
                __elloPdpSwap.lastResultB64 = imageB64;
                if (window.__elloCtlLayeringInB) {
                    window.__elloCtlLayeringInB = false;
                    __elloCtlB.layered = true;
                    elloRenderCtlBoth(imageB64);
                    // Persist the OUTFIT (combined A+B image + item B) so a
                    // return visit restores BOTH pieces + the two-piece panel,
                    // not just item A (Andrew 2026-07-03).
                    var hA = __elloCtlB.triedOnHandleA || (__elloCtlB.garmentA && __elloCtlB.garmentA.id) || null;
                    if (hA) elloSavePdpOutfitResult(hA, imageB64, __elloCtlB.itemB);
                } else {
                    // Base pass (item A only): cache the FULL-RES result + the
                    // garment/variant so a later revisit restores it crisply AND
                    // rebuilds the upsell faithfully — NOT on the layer pass,
                    // whose image is the combined A+B outfit.
                    if (garment && garment.id) elloSavePdpFullResult(garment.id, imageB64, garment, window.__elloTriedOnVariant || null);
                    if (elloCompleteTheLookOn()) elloMountCtlPdpPanel(garment);
                }
            } catch (e) { window.__elloCtlLayeringInB = false; }
            return; // finally{} resets isTryOnProcessing + hides any loading bar
        }

        // Now show the resultSection and prepare to display the image
        if (resultSection) {
            resultSection.style.display = "block";
        }

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

        // Inline mode: swap the default action row for Add-to-Cart + Try-another.
        // Called AFTER the result image is appended so the CTAs (and attribution)
        // always sit BELOW the result, never above it. No-ops when
        // ELLO_INLINE_MODE is false (still safe for the floating widget).
        renderInlineModeResultCtas();

        // Complete the Look: append the in-widget upsell rail under the CTAs.
        // Gated + best-effort (no curation / any error → no rail), and async so
        // it never delays showing the result. On a LAYER pass (the shopper
        // tapped "Try on" in the rail) the result now shows A+B — morph the
        // rail to "Add both to cart" instead of offering a fresh item.
        try {
            if (window.__elloCtlLayeringInWidget) {
                window.__elloCtlLayeringInWidget = false;
                __elloCtlA.layered = true;
                __elloCtlA.lastResultB64 = imageB64;
                elloRenderCtlRailBoth();
            } else if (elloCompleteTheLookOn() && garment) {
                __elloCtlA.lastResultB64 = imageB64;
                elloRenderCompleteTheLook(garment);
            }
        } catch (e) { window.__elloCtlLayeringInWidget = false; }

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

        // Lead capture (off unless the merchant enabled it). Never blocks the result.
        elloMaybeShowLeadCapture(garment);

        if (typeof openTryOnResult === "function") {
            openTryOnResult();
        }

        if (window._previewTryOnProcessing) {
            trackPreviewEvent('tryon_completed');
        }

    } catch (err) {
        // In-widget CTL layer failed — clear the flag so the NEXT try-on can't
        // wrongly morph the rail, restore the page's selection to A, and re-offer.
        if (window.__elloCtlLayeringInWidget) {
            window.__elloCtlLayeringInWidget = false;
            if (__elloCtlA.garmentA) {
                window.elloSelectedGarment = __elloCtlA.garmentA;
                try { elloRenderCompleteTheLook(__elloCtlA.garmentA); } catch (e2) {}
            }
        }
        // PDP swap: undo the swap + re-show the panel so the error below is
        // visible and the page isn't left half-swapped or with a stuck badge.
        if (window.__elloCtlLayeringInB) {
            // CTL layer failed — keep item A on the hero (do NOT restore the true
            // product photo, which would wipe the result) and reset the offer card.
            elloCtlAbortLayer();
        } else if (window.__elloPdpSwapActive) {
            elloAbortPdpSwap();
            const errResultSection = document.getElementById("resultSection");
            if (errResultSection) errResultSection.style.display = "block";
        }
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

// ─── Lead capture (email after Nth try-on) ──────────────────────────────────
// Off unless ELLO_STORE_CONFIG.leadCaptureEnabled. Counts successful try-ons per
// browser in localStorage and shows a one-time, dismissible email prompt once
// the count reaches leadCaptureAfterN. Submitted emails POST to /api/capture-lead.
// Never blocks or gates the try-on result.
function elloLeadStoreSlug() {
    return (window.ELLO_STORE_CONFIG && window.ELLO_STORE_CONFIG.storeSlug)
        || window.ELLO_STORE_SLUG || window.ELLO_STORE_ID || 'default_store';
}

function elloMaybeShowLeadCapture(garment) {
    try {
        const cfg = window.ELLO_STORE_CONFIG || {};
        if (!cfg.leadCaptureEnabled) return;

        const slug = elloLeadStoreSlug();
        const capturedKey = 'ello_lead_captured_' + slug;
        if (userEmail || window.localStorage.getItem(capturedKey)) return;

        const afterN = Math.max(1, parseInt(cfg.leadCaptureAfterN, 10) || 1);
        const countKey = 'ello_lead_count_' + slug;
        const count = (parseInt(window.localStorage.getItem(countKey), 10) || 0) + 1;
        window.localStorage.setItem(countKey, String(count));
        if (count < afterN) return;

        showElloLeadCaptureModal(garment);
    } catch (e) {
        console.warn('[Ello] lead capture check failed:', e);
    }
}

// Brand palette mirrors vault Brand-Palette.md: crisp blue + ink + lots of
// white, editorial. The CTA uses the merchant's widget accent so it feels
// native to their store; everything else is the Ello landing-page look.
function elloLeadReadableTextOn(hex) {
    try {
        var h = String(hex || '').replace('#', '');
        if (h.length !== 6) return '#FFFFFF';
        var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
        return ((0.299 * r + 0.587 * g + 0.114 * b) / 255) > 0.62 ? '#0B1220' : '#FFFFFF';
    } catch (e) { return '#FFFFFF'; }
}

function showElloLeadCaptureModal(garment) {
    if (document.getElementById('ello-lead-capture-overlay')) return;

    const cfg = window.ELLO_STORE_CONFIG || {};
    const accent = cfg.widgetPrimaryColor || cfg.minimizedColor || '#111827';
    const accentText = elloLeadReadableTextOn(accent);
    const slug = elloLeadStoreSlug();
    const markDone = () => { try { window.localStorage.setItem('ello_lead_captured_' + slug, '1'); } catch (e) {} };
    const garmentImg = (garment && (garment.image_url || garment.image)) || null;

    // One-time keyframes for the fade/pop entrance.
    if (!document.getElementById('ello-lead-capture-style')) {
        const styleEl = document.createElement('style');
        styleEl.id = 'ello-lead-capture-style';
        styleEl.textContent =
            '@keyframes elloLeadFade{from{opacity:0}to{opacity:1}}' +
            '@keyframes elloLeadPop{from{opacity:0;transform:translateY(16px) scale(.96)}to{opacity:1;transform:none}}' +
            '#ello-lead-email::placeholder{color:#9098A8;}';
        document.head.appendChild(styleEl);
    }

    const overlay = document.createElement('div');
    overlay.id = 'ello-lead-capture-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Save your try-on results');
    overlay.style.cssText =
        'position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(11,18,32,0.62);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);' +
        'padding:16px;animation:elloLeadFade 220ms ease;';

    const card = document.createElement('div');
    card.style.cssText =
        'position:relative;background:#FFFFFF;border-radius:20px;max-width:400px;width:100%;overflow:hidden;' +
        'box-shadow:0 24px 70px rgba(11,18,32,0.35);text-align:center;' +
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
        'animation:elloLeadPop 260ms cubic-bezier(.2,.9,.3,1.1);';
    card.innerHTML =
        '<button id="ello-lead-close" type="button" aria-label="Close" style="position:absolute;top:12px;right:12px;width:30px;height:30px;border-radius:50%;border:1px solid #ECEEF3;background:#FFFFFF;color:#6B7388;font-size:15px;line-height:1;cursor:pointer;padding:0;z-index:1;">×</button>' +
        '<div style="background:linear-gradient(170deg,#F4F7FE 0%,#E8EEFD 55%,#FFFFFF 100%);padding:30px 26px 18px;">' +
            (garmentImg
                ? '<img src="' + String(garmentImg).replace(/"/g, '&quot;') + '" alt="" style="width:84px;height:106px;object-fit:cover;border-radius:14px;border:3px solid #FFFFFF;box-shadow:0 10px 26px rgba(11,18,32,0.18);transform:rotate(-2deg);" />'
                : '<div style="width:64px;height:64px;border-radius:50%;margin:0 auto;background:#FFFFFF;display:flex;align-items:center;justify-content:center;font-size:28px;box-shadow:0 10px 26px rgba(11,18,32,0.12);">✨</div>') +
        '</div>' +
        '<div style="padding:18px 26px 24px;">' +
            '<div style="font-size:10px;font-weight:var(--ello-fw-700, 700);letter-spacing:0.14em;text-transform:uppercase;color:#3B63D4;margin-bottom:8px;">Your virtual fitting room</div>' +
            '<div style="font-size:21px;font-weight:var(--ello-fw-800, 800);letter-spacing:-0.01em;color:#0B1220;margin-bottom:7px;">Don&#39;t lose this look</div>' +
            '<div style="font-size:13.5px;color:#434D63;line-height:1.55;margin-bottom:16px;">Enter your email and we&#39;ll keep your try-on results — plus you&#39;ll get first dibs on new drops.</div>' +
            '<input id="ello-lead-email" type="email" inputmode="email" autocomplete="email" placeholder="you@email.com" style="width:100%;box-sizing:border-box;padding:13px 15px;border:1.5px solid #D8DCE3;border-radius:12px;font-size:15px;color:#0B1220;outline:none;transition:border-color 140ms ease,box-shadow 140ms ease;" />' +
            '<div id="ello-lead-error" style="display:none;color:#D94E4E;font-size:12px;margin-top:8px;text-align:left;"></div>' +
            '<button id="ello-lead-submit" type="button" style="width:100%;box-sizing:border-box;padding:13px;margin-top:12px;border:none;border-radius:12px;background:' + accent + ';color:' + accentText + ';font-size:15px;font-weight:var(--ello-fw-700, 700);letter-spacing:0.01em;cursor:pointer;box-shadow:0 8px 22px rgba(11,18,32,0.18);">Save my looks</button>' +
            '<div style="font-size:11px;color:#9098A8;margin-top:12px;">No spam, ever. Unsubscribe anytime.</div>' +
        '</div>';

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Deliberate friction: the small × is the ONLY way out — no skip button,
    // no backdrop click-to-dismiss. Entering an email stays one keystroke +
    // Enter away.
    const close = () => { try { overlay.remove(); } catch (e) {} };
    card.querySelector('#ello-lead-close').addEventListener('click', () => { markDone(); close(); });

    const input = card.querySelector('#ello-lead-email');
    const errEl = card.querySelector('#ello-lead-error');
    input.addEventListener('focus', () => { input.style.borderColor = '#3B63D4'; input.style.boxShadow = '0 0 0 3px #E8EEFD'; });
    input.addEventListener('blur', () => { input.style.borderColor = '#D8DCE3'; input.style.boxShadow = 'none'; });
    setTimeout(() => { if (input) input.focus(); }, 80);

    const submit = () => {
        const email = ((input && input.value) || '').trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            if (errEl) { errEl.textContent = 'Please enter a valid email.'; errEl.style.display = 'block'; }
            return;
        }
        // Mark done + set email locally first so the UX is instant; POST is fire-and-forget.
        markDone();
        userEmail = email;
        try {
            const base = window.ELLO_WIDGET_BASE_URL || '';
            fetch(base + '/api/capture-lead', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    store_slug: slug,
                    email: email,
                    session_id: sessionId || window.ELLO_SESSION_ID || null,
                    product_id: (garment && (garment.shopify_product_id || garment.id)) || null,
                    source: 'widget'
                })
            }).catch((e) => console.warn('[Ello] lead capture POST failed:', e));
        } catch (e) {
            console.warn('[Ello] lead capture POST threw:', e);
        }
        // Brief success state, then dismiss.
        card.innerHTML =
            '<div style="padding:44px 26px 40px;">' +
                '<div style="width:56px;height:56px;border-radius:50%;margin:0 auto 14px;background:#E8EEFD;display:flex;align-items:center;justify-content:center;font-size:26px;">🎉</div>' +
                '<div style="font-size:20px;font-weight:var(--ello-fw-800, 800);color:#0B1220;margin-bottom:6px;">You&#39;re in</div>' +
                '<div style="font-size:13.5px;color:#434D63;">We&#39;ll keep your looks safe.</div>' +
            '</div>';
        setTimeout(close, 1400);
    };

    card.querySelector('#ello-lead-submit').addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
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

        // The popup is inline-styled and mounts on document.body, so the black
        // theme can't reach it through container-scoped CSS — thread a palette
        // through the styles (and the select/reset handlers below) instead.
        const P = elloThemeIsBlack() ? {
            card: '#15171c', title: '#fff', sub: 'rgba(255,255,255,0.65)',
            btnBg: '#23272f', btnColor: '#fff', btnBorder: 'rgba(255,255,255,0.22)',
            selBg: '#fff', selColor: '#111418', selBorder: '#fff',
            cancelBg: 'rgba(255,255,255,0.06)', cancelColor: 'rgba(255,255,255,0.75)', cancelBorder: 'rgba(255,255,255,0.22)',
            confirmBg: '#fff', confirmColor: '#111418', confirmBorder: '#fff',
            shadow: '0 24px 70px rgba(0,0,0,0.6)'
        } : {
            card: '#fff', title: '#333', sub: '#666',
            btnBg: '#f8f8f8', btnColor: '#333', btnBorder: '#e0e0e0',
            selBg: '#333', selColor: 'white', selBorder: '#333',
            cancelBg: '#f0f0f0', cancelColor: '#666', cancelBorder: '#e0e0e0',
            confirmBg: '#333', confirmColor: 'white', confirmBorder: '#333',
            shadow: '0 24px 70px rgba(0,0,0,0.28)'
        };

        // Create popup HTML (rest of your existing popup code...)
        const popup = document.createElement('div');
        // Body-mounted with no id — the class puts it in the brand-font scope.
        popup.className = 'ello-widget-surface';
        popup.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    height: 100dvh;
    background: rgba(0,0,0,0.6);
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(4px);
`;

        popup.innerHTML = `
    <div style="
        background: ${P.card};
        padding: 28px 24px 22px;
        border-radius: 18px;
        max-width: 360px;
        width: 90%;
        box-shadow: ${P.shadow};
        border: none;
    ">
        <div style="text-align: center; margin-bottom: 20px;">
            <h3 style="
                margin: 0 0 8px 0;
                font-size: 18px;
                font-weight: var(--ello-fw-700, 700);
                color: ${P.title};
                text-transform: uppercase;
                letter-spacing: 1px;
            ">${(function(){var __v=availableSizes.map(function(s){return String(s.size||'').trim();});var __sz=/^(one ?size|os|xxs|xs|s|m|l|xl|2xl|xxl|3xl|xxxl|4xl|[0-9]{1,2})$/i;return (__v.length && __v.every(function(x){return __sz.test(x);})) ? 'Select your size' : 'Select an option';})()}</h3>
            <p style="
                margin: 0;
                color: ${P.sub};
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
                    border: 1px solid ${P.btnBorder};
                    background: ${P.btnBg};
                    cursor: pointer;
                    border-radius: 6px;
                    font-weight: var(--ello-fw-600, 600);
                    font-size: 14px;
                    color: ${P.btnColor};
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
                background: ${P.cancelBg};
                border: 1px solid ${P.cancelBorder};
                border-radius: 6px;
                cursor: pointer;
                font-weight: var(--ello-fw-600, 600);
                color: ${P.cancelColor};
                text-transform: uppercase;
                letter-spacing: 0.5px;
                font-size: 13px;
            ">Cancel</button>
            <button id="confirmSize" style="
                flex: 1;
                padding: 12px;
                background: ${P.confirmBg};
                color: ${P.confirmColor};
                border: 1px solid ${P.confirmBorder};
                border-radius: 6px;
                cursor: pointer;
                font-weight: var(--ello-fw-600, 600);
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
                    b.style.background = P.btnBg;
                    b.style.color = P.btnColor;
                    b.style.borderColor = P.btnBorder;
                });

                // Highlight selected button
                btn.style.background = P.selBg;
                btn.style.color = P.selColor;
                btn.style.borderColor = P.selBorder;

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

    // Create notification element. (Toasts are brand-colored — green/red
    // gradient with white text — so they read correctly on both themes.)
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
<button class="notification-close" onclick="__elloWidget.hideNotification(this.parentElement)">
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

        // Safe count update (doesn't clobber the bubble's inner icon markup the
        // way innerHTML= did) + re-render the standard cart sections so the
        // drawer/bubble reflect the new item. Shared with the inline add path.
        elloUpdateCartCount(cartData.item_count);
        try {
            const __sr = await fetch(window.location.pathname + '?sections=' + ELLO_CART_SECTION_IDS.join(','), { headers: { 'Accept': 'application/json' }, credentials: 'same-origin' });
            if (__sr.ok) { const __sec = await __sr.json().catch(() => null); if (__sec) elloApplyCartSections(__sec); }
        } catch (e) { /* section rendering unsupported — count + events still run */ }

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
    // Body-mounted with no id — the class puts it in the brand-font scope.
    modal.className = 'ello-widget-surface';
    modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    height: 100dvh;
    background: rgba(0,0,0,0.6);
    z-index: 2147483647;
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
                font-weight: var(--ello-fw-700, 700);
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
                font-weight: var(--ello-fw-600, 600);
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
                font-weight: var(--ello-fw-600, 600);
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

    // Reset the wardrobe viewer so the next open starts clean.
    if (typeof elloViewerResetZoom === 'function') {
        elloViewerResetZoom();
        __elloViewer.list = [];
        __elloViewer.index = -1;
    }

    // The wardrobe modal may still be open underneath — keep the page locked.
    const wardrobeModal = document.getElementById('wardrobeModal');
    if (wardrobeModal && wardrobeModal.classList.contains('active')) {
        document.body.style.overflow = 'hidden';
    } else if (!widgetOpen || !isMobile) {
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
    // Arrow keys page through the wardrobe viewer while it's open
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        const imageModal = document.getElementById('imageModal');
        if (imageModal && imageModal.classList.contains('active') &&
            imageModal.classList.contains('wardrobe-view') && __elloViewer.list.length > 1) {
            event.preventDefault();
            elloViewerShow(__elloViewer.index + (event.key === 'ArrowRight' ? 1 : -1));
            return;
        }
    }

    // Escape key - close widget, modals, and browsers
    if (event.key === 'Escape') {
        // Close image modal if open. No event arg: closeImageModal's guard is
        // for backdrop clicks and would swallow a keyboard event (target is
        // whatever has focus, never the modal itself).
        const imageModal = document.getElementById('imageModal');
        if (imageModal && imageModal.classList.contains('active')) {
            closeImageModal();
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

// THEME: white by default; per-store black via style_overrides.theme = "black"
// (vto_stores JSONB — one SQL update, no deploy, live within ~30s).
function elloThemeIsBlack() {
    // Preview hook: ?ello_theme=black forces the dark theme for THIS page view
    // only (?ello_theme=white forces light) — eyeball a store without touching
    // its DB row. Nothing persists; drop the param and the store config rules.
    try {
        const q = new URLSearchParams(window.location.search).get('ello_theme');
        if (q === 'black') return true;
        if (q === 'white') return false;
    } catch (e) { /* fall through to store config */ }
    const so = window.ELLO_STORE_CONFIG && window.ELLO_STORE_CONFIG.styleOverrides;
    return !!(so && so.theme === 'black');
}

// The theme class lives on the CONTAINER, not the panel: the wardrobe /
// collection / image modals are siblings of the panel, so a panel-level class
// (the old scheme) never reached them — every .theme-black modal rule was
// dead code. All template dark rules are scoped `#container.theme-black …`.
function applyWidgetThemeColors() {
    const black = elloThemeIsBlack();
    const container = document.getElementById('virtual-tryon-widget-container');
    if (container) container.classList.toggle('theme-black', black);

    const widget = document.getElementById('virtualTryonWidget');
    if (!widget) {
        console.warn('⚠️ Widget element not found for theme color application');
        return;
    }

    // theme-white stays panel-level (its rules predate the container scheme).
    // It must come OFF in black mode or its surface rules fight the dark ones.
    widget.classList.remove('theme-cream', 'theme-black');
    widget.classList.toggle('theme-white', !black);

    // Remove data-theme attribute if it exists
    widget.removeAttribute('data-theme');
}

/**
 * Apply minimized widget color from store configuration
 * Reads the minimized_color from window.ELLO_STORE_CONFIG and applies it
 * Falls back to default gradient if color is not set
 */
function applyMinimizedWidgetColor() {
    // Per-store style overrides ride the same "config arrived" hook — every
    // call site that (re)applies the minimized color re-applies overrides too,
    // including the retry ladder in init and the re-minimize path.
    applyStyleOverrides();

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

// ============================================================================
// BRAND FONT — the widget wears the merchant theme's font by default
// ============================================================================

// Every widget surface that carries text, including the ones mounted on
// document.body OUTSIDE the container (modals, toasts, PDP panel/card) that
// container-scoped rules can't reach.
var ELLO_FONT_SCOPES = [
    '#virtual-tryon-widget-container',
    '.ello-pdp-card',
    '#ello-ctl-pdp-panel',
    '#ello-sz-overlay',
    '#ello-lead-capture-overlay',
    '.custom-notification',
    '.ello-widget-surface'
];

function elloFontScopeSelector() {
    return ELLO_FONT_SCOPES.map(function (s) { return s + ',' + s + ' *'; }).join(',');
}

/**
 * Read the merchant page's main font stack. Body's computed font-family is the
 * primary signal (Shopify themes set the body font there); if the body reads
 * as a raw browser default (Times / -webkit-standard), the theme styles text
 * elsewhere — sample prominent content nodes instead. Returns null when no
 * theme-set font is found (widget keeps Poppins). A theme that GENUINELY sets
 * bare "Times New Roman" is indistinguishable from the UA default and keeps
 * Poppins too — the per-store font_family override is the fix for that store.
 *
 * Non-null results are cached; null re-probes on the next call, so a detection
 * that ran before the theme's CSS settled gets retried by the config ladder.
 */
function elloDetectBrandFont() {
    if (elloDetectBrandFont._stack) return elloDetectBrandFont._stack;

    // Only true browser defaults: a computed -apple-system / system-ui stack
    // means the theme deliberately chose system fonts — inherit it.
    var UA_DEFAULT = /^(-webkit-standard|times new roman|times|serif)$/i;
    function firstFamily(ff) {
        return (ff || '').split(',')[0].replace(/['"]/g, '').trim();
    }

    var stack = null;
    try {
        var bodyFont = document.body ? window.getComputedStyle(document.body).fontFamily : '';
        if (bodyFont && !UA_DEFAULT.test(firstFamily(bodyFont))) {
            stack = bodyFont;
        } else {
            var picks = document.querySelectorAll('h1, .product__title, main p, p');
            for (var i = 0; i < picks.length && i < 12; i++) {
                if (picks[i].closest('#virtual-tryon-widget-container')) continue;
                var ff = window.getComputedStyle(picks[i]).fontFamily;
                if (ff && !UA_DEFAULT.test(firstFamily(ff))) { stack = ff; break; }
            }
        }
    } catch (e) { /* keep Poppins */ }

    if (stack) {
        // Computed values shouldn't contain these, but the string is headed
        // into a stylesheet — scrub anything that could break out of the rule.
        stack = stack.replace(/[{}();<>!]/g, '').trim().slice(0, 400);
    }
    elloDetectBrandFont._stack = stack || null;
    return elloDetectBrandFont._stack;
}

/**
 * Read the theme's font-weight scale: body text weight plus heading weight
 * (first prominent heading outside the widget). Feeds the --ello-fw-* tier
 * remap in applyBrandFont so a light-typography theme (e.g. Jost at 400/500)
 * doesn't sit next to Poppins-era 700/800 widget accents.
 *
 * Caches only once a heading is found — like the font-stack cache, a probe
 * that ran before the theme's CSS settled gets retried by the config ladder.
 */
function elloDetectBrandWeights() {
    if (elloDetectBrandWeights._w) return elloDetectBrandWeights._w;

    function num(el) {
        if (!el) return null;
        var w = parseFloat(window.getComputedStyle(el).fontWeight);
        return (w >= 100 && w <= 1000) ? w : null;
    }

    var body = null, head = null;
    try {
        body = num(document.body);
        var picks = document.querySelectorAll('h1, h2, .product__title, .product-title, h3');
        for (var i = 0; i < picks.length && i < 12; i++) {
            if (picks[i].closest('#virtual-tryon-widget-container')) continue;
            head = num(picks[i]);
            if (head) break;
        }
    } catch (e) { /* keep defaults */ }

    var w = { body: body || 400, head: head || 700 };
    if (head) elloDetectBrandWeights._w = w;
    return w;
}

/**
 * Default-on font inheritance: apply the detected theme font to every widget
 * surface so the widget reads as part of the merchant's brand. Rides the same
 * config ladder as applyStyleOverrides (called from it, above the early
 * return, so it runs even for stores with no style_overrides row).
 *
 * Yields to per-store knobs: an explicit font_family override disables it
 * (that store chose a specific font), and font_inherit:false opts a store out
 * back to Poppins. Preview hooks mirror ?ello_theme: ?ello_brand_font=0 kills
 * it for this page view, ?ello_brand_font=1 forces it past an opt-out.
 *
 * Weight inheritance rides along: when the widget wears the theme's font it
 * also adopts the theme's weight scale. Template weights are declared as
 * var(--ello-fw-500/600/700/800) with the original value as fallback, so this
 * only sets the variables — no vars, pixel-identical widget. The tier remap
 * shifts by (theme heading weight − 700): a Jost theme with 500 headings
 * pulls the 700/800 accents down to 500/600; the 500/600 tiers only ever
 * lighten (a heavy-heading theme doesn't bolden body-adjacent text). Floors
 * keep tiers monotonic so hierarchy never inverts. font_weight_inherit:false
 * opts out of the weight part alone; ?ello_brand_weight=0/1 previews.
 */
function applyBrandFont() {
    var so = window.ELLO_STORE_CONFIG && window.ELLO_STORE_CONFIG.styleOverrides;
    var tag = document.getElementById('ello-brand-font');

    var force = null;
    try {
        var q = new URLSearchParams(window.location.search).get('ello_brand_font');
        if (q === '0' || q === 'off') force = false;
        else if (q === '1' || q === 'on') force = true;
    } catch (e) { /* fall through to store config */ }

    var enabled;
    if (force !== null) enabled = force;
    else if (so && typeof so.font_family === 'string' && so.font_family.trim()) enabled = false;
    else if (so && so.font_inherit === false) enabled = false;
    else enabled = true;

    var stack = enabled ? elloDetectBrandFont() : null;
    if (!stack) {
        if (tag) tag.remove();
        return;
    }

    var css = elloFontScopeSelector() + '{font-family:' + stack + ' !important;}';

    // ── Theme font-weight inheritance (rides the family inheritance) ──
    var wforce = null;
    try {
        var wq = new URLSearchParams(window.location.search).get('ello_brand_weight');
        if (wq === '0' || wq === 'off') wforce = false;
        else if (wq === '1' || wq === 'on') wforce = true;
    } catch (e) { /* fall through to store config */ }
    var wEnabled = (wforce !== null) ? wforce : !(so && so.font_weight_inherit === false);

    if (wEnabled) {
        var w = elloDetectBrandWeights();
        var r100 = function (n) { return Math.round(n / 100) * 100; };
        var clamp = function (n, lo, hi) { return Math.min(hi, Math.max(lo, n)); };
        var bodyW = clamp(r100(w.body), 300, 500);
        var delta = clamp(r100(w.head) - 700, -300, 100);
        var soft = Math.min(delta, 0);
        var fw500 = clamp(500 + soft, bodyW, 600);
        var fw600 = clamp(600 + soft, fw500, 700);
        var fw700 = clamp(700 + delta, fw600, 800);
        var fw800 = clamp(800 + delta, fw700, 900);

        var rules = '';
        // Base text weight cascades from the scope roots (no !important, so
        // any template rule that sets an explicit weight still wins).
        if (bodyW !== 400) rules += 'font-weight:' + bodyW + ';';
        if (delta !== 0) {
            rules += '--ello-fw-500:' + fw500 + ';--ello-fw-600:' + fw600 +
                ';--ello-fw-700:' + fw700 + ';--ello-fw-800:' + fw800 + ';';
        }
        if (rules) css += '\n' + ELLO_FONT_SCOPES.join(',') + '{' + rules + '}';
    }

    if (!tag) {
        tag = document.createElement('style');
        tag.id = 'ello-brand-font';
        // Sit BEFORE the style-overrides tag so ops custom_css wins ties.
        var overrides = document.getElementById('ello-style-overrides');
        if (overrides) document.head.insertBefore(tag, overrides);
        else document.head.appendChild(tag);
    }
    if (tag.textContent !== css) {
        tag.textContent = css;
        elloLog('🔤 Brand font inherited from theme:', stack);
    }
}

/**
 * Apply per-store style overrides from window.ELLO_STORE_CONFIG.styleOverrides.
 *
 * Ops-level knob (vto_stores.style_overrides JSONB — set by support/Claude via
 * SQL, no dashboard UI). Rides the same config pipeline as brand color, so a
 * DB update propagates to shoppers within ~30s with no deploy. Supported keys:
 *
 *   theme                    string  — "black" flips the whole widget (panel +
 *                           all modals + viewer + size picker + notifications)
 *                           to the dark theme; anything else / absent = white.
 *
 *   hide_section_icons      boolean — hide the star/flame SVGs in the
 *                           "Featured Today" / "Trending" section titles
 *   launcher_stroke_width   number  — hanger icon stroke weight (default 2.2;
 *                           e.g. 1.5 for a thinner look)
 *   launcher_label_weight   number  — hover "Virtual Try-On" label
 *                           font-weight (default 800)
 *   launcher_label_transform string — text-transform (default uppercase;
 *                           'none' for sentence case)
 *   launcher_label_spacing  string  — letter-spacing (default 0.6px)
 *   launcher_label_text     string  — replace the hover label text
 *   font_family + font_url  string  — @font-face a merchant brand font
 *                           (https woff2/woff/otf/ttf) and apply widget-wide;
 *                           disables the default theme-font inheritance
 *   font_inherit            boolean — theme-font inheritance is DEFAULT-ON
 *                           (applyBrandFont); set false to opt a store back
 *                           to Poppins (ignored if font_family set)
 *   font_weight_inherit     boolean — theme font-WEIGHT inheritance is
 *                           DEFAULT-ON whenever font inheritance is active
 *                           (--ello-fw-* tier remap from the theme's
 *                           body/heading weights); set false to keep the
 *                           stock weight scale under the inherited font
 *   sample_model_gender     string  — "female" | "male": show only that
 *                           gender in the sample-model browser (single-
 *                           gender stores); absent/other = all models
 *   hide_emojis             boolean — strip decorative emoji (📷 ✨ 👕 📸 …)
 *                           from ALL widget text — container AND body-level
 *                           surfaces (lead capture, toasts, size picker) —
 *                           via MutationObservers. Functional marks survive
 *                           (✓ added-to-cart, ✕ close, ➜ step arrows).
 *   custom_css              string  — escape hatch, appended verbatim.
 *                           OPS-AUTHORED ONLY — never merchant input.
 *
 * All generated rules carry !important so they win against the template
 * stylesheet regardless of injection order. Idempotent: re-running replaces
 * the same <style id="ello-style-overrides"> tag.
 */
function applyStyleOverrides() {
    var so = window.ELLO_STORE_CONFIG && window.ELLO_STORE_CONFIG.styleOverrides;
    var existing = document.getElementById('ello-style-overrides');

    // ── Widget theme (theme: "black") ──
    // Applied here (not only in applyWidgetThemeColors) because this function
    // rides the config retry ladder — the store config usually lands AFTER the
    // widget's first paint, and this is the hook that re-runs when it does.
    // Must sit above the early return so a cleared override restores white.
    applyWidgetThemeColors();

    // Default-on brand font — also above the early return: stores with NO
    // style_overrides row still inherit the merchant theme's font.
    applyBrandFont();

    // ── Footwear try-on kill switch (per-store, no redeploy) ──
    // style_overrides {"footwear_tryon_enabled": false} disables ALL footwear
    // UX (upload copy, tips, body-check leniency, payload type override).
    // Only touched when the key is present so a console/theme-set flag isn't
    // clobbered; copy re-applies either way because this function rides the
    // config retry ladder and config usually lands after first paint.
    if (so && so.footwear_tryon_enabled === false) {
        window.ELLO_FOOTWEAR_TRYON = false;
    } else if (so && so.footwear_tryon_enabled === true) {
        window.ELLO_FOOTWEAR_TRYON = true;
    }
    elloApplyFootwearUploadCopy();

    if (!so || typeof so !== 'object') {
        if (existing) existing.remove();
        return;
    }

    var C = '#virtual-tryon-widget-container';
    var css = '';

    // ── Section icons (star/flame) ──
    if (so.hide_section_icons === true) {
        css += C + ' .section-title svg{display:none !important;}\n';
    }

    // ── Minimized launcher: hanger stroke weight ──
    // The hanger is a CSS mask data-URI with a hardcoded stroke-width, so a
    // thinner icon means regenerating the URI with the requested stroke.
    var stroke = Number(so.launcher_stroke_width);
    if (stroke > 0 && stroke <= 6) {
        var hangerMask = "url(\"data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='%23000'%20stroke-width='" + stroke + "'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='M12%209%20V6%20a1.8%201.8%200%201%200%20-1.8%201.8'/%3E%3Cpath%20d='M12%209%20L4.2%2014.8%20a1.2%201.2%200%200%200%20.7%202.1%20H19.1%20a1.2%201.2%200%200%200%20.7%20-2.1%20L12%209%20Z'/%3E%3C/svg%3E\") center / contain no-repeat";
        css += C + ' .widget-minimized::before{-webkit-mask:' + hangerMask + ' !important;mask:' + hangerMask + ' !important;}\n';
    }

    // ── Minimized launcher: hover label typography ──
    var labelRules = '';
    var weight = Number(so.launcher_label_weight);
    if (weight >= 100 && weight <= 900) {
        labelRules += 'font-weight:' + weight + ' !important;';
    }
    if (typeof so.launcher_label_transform === 'string' &&
        /^(none|uppercase|lowercase|capitalize)$/.test(so.launcher_label_transform)) {
        labelRules += 'text-transform:' + so.launcher_label_transform + ' !important;';
    }
    if (typeof so.launcher_label_spacing === 'string' &&
        /^-?\d+(\.\d+)?(px|em)$/.test(so.launcher_label_spacing)) {
        labelRules += 'letter-spacing:' + so.launcher_label_spacing + ' !important;';
    }
    if (typeof so.launcher_label_text === 'string' && so.launcher_label_text.trim() &&
        so.launcher_label_text.length <= 40) {
        // content: strings can't safely carry quotes/backslashes — strip them.
        labelRules += "content:'" + so.launcher_label_text.replace(/['"\\]/g, '') + "' !important;";
    }
    if (labelRules) {
        css += C + ' .widget-minimized::after{' + labelRules + '}\n';
    }

    // ── Widget font (replaces the hardcoded Poppins) ──
    // Theme-font inheritance is DEFAULT-ON via applyBrandFont() above; this
    // branch is the explicit per-store font (which disables inheritance).
    if (typeof so.font_family === 'string' && so.font_family.trim()) {
        // Strip anything that could break out of the font-family string.
        var famName = so.font_family.trim().replace(/['"\\;{}<>]/g, '');
        if (typeof so.font_url === 'string' && /^https:\/\/[^'"\s)]+$/.test(so.font_url)) {
            var fmt = /\.woff2(\?|$)/i.test(so.font_url) ? 'woff2'
                : /\.woff(\?|$)/i.test(so.font_url) ? 'woff'
                : /\.otf(\?|$)/i.test(so.font_url) ? 'opentype' : 'truetype';
            css += "@font-face{font-family:'" + famName + "';src:url('" + so.font_url +
                "') format('" + fmt + "');font-display:swap;font-weight:100 900;}\n";
        }
        css += elloFontScopeSelector() + "{font-family:'" + famName + "','Poppins',sans-serif !important;}\n";
    }

    // ── Escape hatch: raw scoped CSS (ops-authored only) ──
    if (typeof so.custom_css === 'string' && so.custom_css.trim()) {
        css += so.custom_css.replace(/<\/style/gi, '').slice(0, 20000) + '\n';
    }

    // ── Emoji stripping (📷 ✨ 👕 📸 🖼️ …) ──
    // Emoji live in TEXT nodes (button labels, chat lines), which CSS can't
    // reach — so a MutationObserver scoped to the widget container rewrites
    // them out as the UI renders. Pictograph blocks + ✨/⭐/VS16 only:
    // ✓ (U+2713), ✕ (U+2715) and ➜ (U+279C) are functional and survive.
    if (so.hide_emojis === true) {
        ensureEmojiStripper();
    } else {
        if (applyStyleOverrides._emojiObs) {
            applyStyleOverrides._emojiObs.disconnect();
            applyStyleOverrides._emojiObs = null;
        }
        if (applyStyleOverrides._emojiBodyObs) {
            applyStyleOverrides._emojiBodyObs.disconnect();
            applyStyleOverrides._emojiBodyObs = null;
        }
    }

    if (!css.trim()) {
        if (existing) existing.remove();
        return;
    }
    if (!existing) {
        existing = document.createElement('style');
        existing.id = 'ello-style-overrides';
        document.head.appendChild(existing);
    }
    if (existing.textContent !== css) existing.textContent = css;
    elloLog('🎨 Style overrides applied:', Object.keys(so).join(', '));
}

/**
 * hide_emojis worker: strip decorative emoji from every text node inside the
 * widget container, now and on every future render. Attaches once (idempotent
 * across the applyStyleOverrides retry ladder); disconnected when the flag is
 * cleared. Rewrites only when a node actually contains emoji, so the observer
 * never re-triggers itself.
 */
function ensureEmojiStripper() {
    var EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2728}\u{2B50}\u{FE0F}]/gu;

    function stripIn(root) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        var node;
        while ((node = walker.nextNode())) {
            if (EMOJI_RE.test(node.nodeValue)) {
                EMOJI_RE.lastIndex = 0;
                node.nodeValue = node.nodeValue.replace(EMOJI_RE, '').replace(/ {2,}/g, ' ');
            }
            EMOJI_RE.lastIndex = 0;
        }
    }

    // ── Main widget container: scoped observer (hot path) ──
    var container = document.getElementById('virtual-tryon-widget-container');
    // Container may not exist yet on early calls — the retry ladder and every
    // re-minimize re-run applyStyleOverrides, so a later call attaches.
    if (container && !applyStyleOverrides._emojiObs) {
        stripIn(container);
        var obs = new MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var m = mutations[i];
                if (m.type === 'characterData') {
                    stripIn(m.target.parentNode || container);
                } else {
                    for (var j = 0; j < m.addedNodes.length; j++) {
                        var n = m.addedNodes[j];
                        if (n.nodeType === 3 && n.parentNode) stripIn(n.parentNode);
                        else if (n.nodeType === 1) stripIn(n);
                    }
                }
            }
        });
        obs.observe(container, { childList: true, subtree: true, characterData: true });
        applyStyleOverrides._emojiObs = obs;
    }

    // ── Body-level widget surfaces (lead capture ✨/🎉, toasts, size picker,
    // PDP panel/card) live outside the container, so a second observer watches
    // document.body — but only strips inside our own surfaces, so merchant DOM
    // churn costs one closest() per added node at worst.
    var BODY_SURFACES = ELLO_FONT_SCOPES
        .filter(function (s) { return s !== '#virtual-tryon-widget-container'; })
        .join(',');
    if (document.body && !applyStyleOverrides._emojiBodyObs) {
        try {
            var existing = document.querySelectorAll(BODY_SURFACES);
            for (var k = 0; k < existing.length; k++) stripIn(existing[k]);
        } catch (e) { /* selector never throws, but stay paranoid */ }
        var bodyObs = new MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var m = mutations[i];
                if (m.type === 'characterData') {
                    var p = m.target.parentElement;
                    if (p && p.closest && p.closest(BODY_SURFACES)) stripIn(p);
                } else {
                    for (var j = 0; j < m.addedNodes.length; j++) {
                        var n = m.addedNodes[j];
                        var el = (n.nodeType === 3) ? n.parentElement : (n.nodeType === 1 ? n : null);
                        if (el && el.closest && el.closest(BODY_SURFACES)) stripIn(el);
                    }
                }
            }
        });
        bodyObs.observe(document.body, { childList: true, subtree: true, characterData: true });
        applyStyleOverrides._emojiBodyObs = bodyObs;
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

// ─── Wardrobe storage: IndexedDB + in-memory cache ──────────────────────────
// The wardrobe used to live in localStorage, whose ~5MB origin quota forced
// saves to silently trim to the 8 newest looks (5 under quota pressure) —
// shoppers' try-ons were disappearing. The wardrobe now lives in IndexedDB
// (quota = a share of the disk), UNCAPPED: the only thing that limits try-ons
// is the try-on allowance itself. The synchronous getWardrobe() contract is
// preserved via a write-through in-memory cache hydrated at script load; any
// legacy localStorage wardrobe is migrated once, then the old key is freed.
var __elloWardrobeCache = null;      // null until hydrated; then the truth
var __elloIdbUnavailable = false;    // true → legacy localStorage behavior

function elloWardrobeDb() {
    return new Promise(function (resolve, reject) {
        if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
        var req = indexedDB.open('ello_vto', 1);
        req.onupgradeneeded = function () {
            var db = req.result;
            if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('IndexedDB open failed')); };
    });
}

function elloIdbGetWardrobe() {
    return elloWardrobeDb().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction('kv', 'readonly');
            var rq = tx.objectStore('kv').get(WARDROBE_STORAGE_KEY);
            rq.onsuccess = function () { resolve(Array.isArray(rq.result) ? rq.result : null); };
            rq.onerror = function () { reject(rq.error); };
        });
    });
}

function elloIdbSetWardrobe(items) {
    return elloWardrobeDb().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction('kv', 'readwrite');
            tx.objectStore('kv').put(items, WARDROBE_STORAGE_KEY);
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { reject(tx.error); };
        });
    });
}

// ─── Full-resolution hero-restore cache (separate from the wardrobe) ─────────
// The wardrobe compresses result images to ~400px for its thumbnail grid, which
// looks fuzzy blown up to hero size. So the hero-swap PERSISTENCE keeps its own
// FULL-RES copy of the latest result per product handle, in the same IndexedDB
// db (generic kv get/set/delete). LRU-capped so it can't grow without bound.
var ELLO_PDP_FULL_PREFIX = 'pdp_full::';
var ELLO_PDP_FULL_INDEX = 'pdp_full_index';
var ELLO_PDP_FULL_MAX = 30;

function elloIdbKvGet(key) {
    return elloWardrobeDb().then(function (db) {
        return new Promise(function (resolve, reject) {
            var rq = db.transaction('kv', 'readonly').objectStore('kv').get(key);
            rq.onsuccess = function () { resolve(rq.result); };
            rq.onerror = function () { reject(rq.error); };
        });
    });
}
function elloIdbKvSet(key, val) {
    return elloWardrobeDb().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction('kv', 'readwrite');
            tx.objectStore('kv').put(val, key);
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { reject(tx.error); };
        });
    });
}
function elloIdbKvDelete(key) {
    return elloWardrobeDb().then(function (db) {
        return new Promise(function (resolve) {
            var tx = db.transaction('kv', 'readwrite');
            tx.objectStore('kv').delete(key);
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { resolve(); };
        });
    });
}

// Cache the FULL-RES result for a product's hero restore — plus enough of the
// garment + tried-on variant to rebuild the Complete-the-Look upsell faithfully
// on a return visit (the complementary fetch needs the numeric product id, and
// "Add both to cart" needs the color the shopper actually tried). Best-effort;
// keeps at most ELLO_PDP_FULL_MAX products (evicts the oldest).
async function elloSavePdpFullResult(handle, dataUrl, garment, variant) {
    try {
        if (__elloIdbUnavailable || !handle) return;
        if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image') !== 0) return;
        var g = garment ? {
            id: garment.id, name: garment.name, price: garment.price, image_url: garment.image_url,
            shopify_product_id: garment.shopify_product_id, shopify_product_gid: garment.shopify_product_gid
        } : null;
        await elloIdbKvSet(ELLO_PDP_FULL_PREFIX + handle, { result: dataUrl, ts: Date.now(), garment: g, variant: variant || null });
        var idx = [];
        try { idx = (await elloIdbKvGet(ELLO_PDP_FULL_INDEX)) || []; } catch (e) { idx = []; }
        if (!Array.isArray(idx)) idx = [];
        idx = idx.filter(function (e) { return e && e.handle !== handle; });
        idx.push({ handle: handle, ts: Date.now() });
        if (idx.length > ELLO_PDP_FULL_MAX) {
            idx.sort(function (a, b) { return a.ts - b.ts; });          // oldest first
            var evict = idx.slice(0, idx.length - ELLO_PDP_FULL_MAX);
            for (var i = 0; i < evict.length; i++) {
                try { await elloIdbKvDelete(ELLO_PDP_FULL_PREFIX + evict[i].handle); } catch (e) {}
            }
            idx = idx.slice(idx.length - ELLO_PDP_FULL_MAX);
        }
        await elloIdbKvSet(ELLO_PDP_FULL_INDEX, idx);
    } catch (e) { /* best-effort — a miss just falls back to the wardrobe copy */ }
}

// Merge the LAYERED outfit into a product's full-res record: the combined A+B
// image + a minimal item B (enough to rebuild "Add both" — cart resolution
// re-fetches the product json by handle). A fresh BASE-pass save overwrites
// the whole record, which correctly clears a stale outfit when the shopper
// re-tries item A alone. Best-effort like the base save.
async function elloSavePdpOutfitResult(handle, outfitB64, itemB) {
    try {
        if (__elloIdbUnavailable || !handle || !itemB) return;
        if (typeof outfitB64 !== 'string' || outfitB64.indexOf('data:image') !== 0) return;
        var b = {
            id: itemB.id, handle: itemB.handle || itemB.id, name: itemB.name,
            price: itemB.price, image_url: itemB.image_url,
            shopify_product_id: itemB.shopify_product_id, shopify_product_gid: itemB.shopify_product_gid
        };
        var rec = null;
        try { rec = await elloIdbKvGet(ELLO_PDP_FULL_PREFIX + handle); } catch (e) { rec = null; }
        // No base record (base save failed/evicted): the outfit doubles as the
        // hero restore image so the look still comes back.
        if (!rec || typeof rec.result !== 'string') rec = { result: outfitB64, garment: null, variant: null };
        rec.outfit = outfitB64;
        rec.itemB = b;
        rec.ts = Date.now();
        await elloIdbKvSet(ELLO_PDP_FULL_PREFIX + handle, rec);
        var idx = [];
        try { idx = (await elloIdbKvGet(ELLO_PDP_FULL_INDEX)) || []; } catch (e) { idx = []; }
        if (!Array.isArray(idx)) idx = [];
        idx = idx.filter(function (e) { return e && e.handle !== handle; });
        idx.push({ handle: handle, ts: Date.now() });
        await elloIdbKvSet(ELLO_PDP_FULL_INDEX, idx);
    } catch (e) { /* best-effort — worst case the next visit restores item A only */ }
}

// Read the full-res record for a product handle ({ result, garment, variant })
// or null. Callers use .result for the hero and .garment/.variant for the CTL
// upsell restore.
async function elloGetPdpFullResult(handle) {
    try {
        if (__elloIdbUnavailable || !handle) return null;
        var rec = await elloIdbKvGet(ELLO_PDP_FULL_PREFIX + handle);
        return (rec && typeof rec.result === 'string' && rec.result.indexOf('data:image') === 0) ? rec : null;
    } catch (e) { return null; }
}

// Legacy read (pre-IndexedDB). Keeps the old sessionStorage→localStorage
// shuffle: sessionStorage gets wiped on mobile tab suspension and would
// strand the "Your Photo" tile + results.
function elloReadLegacyWardrobe() {
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

// Hydrate at script load — completes long before a human can open the hub.
// The legacy localStorage copy is imported once and removed only AFTER a
// verified readback (frees ~1.5MB of the store origin's quota).
// Resolves as soon as __elloWardrobeCache is populated (before the background
// migration finishes). Load-time consumers that need the saved wardrobe — e.g.
// the PDP-swap restore — await this instead of racing the async hydrate.
var __elloWardrobeReadyResolve;
var __elloWardrobeReady = new Promise(function (res) { __elloWardrobeReadyResolve = res; });

(function elloHydrateWardrobe() {
    var done = function () { try { __elloWardrobeReadyResolve(); } catch (e) {} };
    elloIdbGetWardrobe().then(function (idbItems) {
        if (idbItems) { __elloWardrobeCache = idbItems; done(); return; }
        var legacy = elloReadLegacyWardrobe();
        __elloWardrobeCache = legacy;
        done();   // cache is usable now; the migration below is best-effort background work
        if (!legacy.length) { elloIdbSetWardrobe([]).catch(function () {}); return; }
        elloIdbSetWardrobe(legacy)
            .then(function () { return elloIdbGetWardrobe(); })
            .then(function (verify) {
                if (verify && verify.length === legacy.length) {
                    try { localStorage.removeItem(WARDROBE_STORAGE_KEY); } catch (e) {}
                    elloLog('✅ Wardrobe migrated to IndexedDB (' + verify.length + ' items)');
                }
            }).catch(function () {});
    }).catch(function () {
        __elloIdbUnavailable = true;
        __elloWardrobeCache = elloReadLegacyWardrobe();
        done();
    });
})();

function getWardrobe() {
    // Hydrated cache is the source of truth (IndexedDB-backed, uncapped).
    if (Array.isArray(__elloWardrobeCache)) return __elloWardrobeCache;
    // Pre-hydration fallback for the first moments of page load.
    return elloReadLegacyWardrobe();
}

// Debounce timer for wardrobe saves to avoid blocking
let wardrobeSaveTimer = null;

// Save wardrobe to sessionStorage with size management (non-blocking)
async function saveWardrobe(wardrobe) {
    // Write-through cache FIRST so sync getWardrobe() callers see this save
    // immediately (the persistence below is debounced).
    __elloWardrobeCache = wardrobe;
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

                // Sort by timestamp (newest first)
                cleanedWardrobe.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
                __elloWardrobeCache = cleanedWardrobe;

                // Normal path: UNCAPPED IndexedDB save. A shopper's try-ons
                // must never disappear — the only cap on try-ons is the
                // try-on allowance itself, never the wardrobe.
                if (!__elloIdbUnavailable) {
                    try {
                        await elloIdbSetWardrobe(cleanedWardrobe);
                        elloLog('✅ Saved wardrobe (' + cleanedWardrobe.length + ' items, IndexedDB)');
                        resolve();
                        return;
                    } catch (e) {
                        console.warn('IndexedDB save failed, falling back to localStorage:', e);
                        __elloIdbUnavailable = true;
                    }
                }

                // Legacy fallback (no IndexedDB): localStorage quota is ~5MB
                // shared with the whole store origin, so the old protective
                // caps stay here — better 8 recent looks than a crashed save.
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

// ─── Outfit chain tracking ───────────────────────────────────────────────────
// When a try-on is layered on a previous RESULT (wardrobe "Add to outfit" or
// either Complete-the-Look layer pass), record what the base image already
// wears, keyed to the userPhotoFileId minted by that re-base. addToWardrobe
// checks the key at save time: any photo change mints a new userPhotoFileId,
// so a stale record can never mislabel a fresh solo try-on as an outfit.
let __elloOutfitBase = null;

// Normalize a garment reference (catalog `clothing` object or stored wardrobe
// item) into the descriptor shape kept in outfitItems. Base64 garment images
// are dropped — descriptors must stay tiny inside the persisted wardrobe.
function elloGarmentDescriptor(src) {
    let imageUrl = src.clothingImageUrl || src.image_url || '';
    if (typeof imageUrl === 'string' && imageUrl.startsWith('data:')) imageUrl = '';
    return {
        clothingId: src.clothingId != null ? src.clothingId : src.id,
        clothingName: src.clothingName || src.name || '',
        clothingPrice: src.clothingPrice != null ? src.clothingPrice : (src.price || 0),
        clothingImageUrl: imageUrl
    };
}

function elloSetOutfitBase(garments) {
    const items = (garments || []).filter(Boolean).map(elloGarmentDescriptor);
    __elloOutfitBase = items.length ? { key: userPhotoFileId, items: items } : null;
}

// Add item to wardrobe
async function addToWardrobe(clothing, resultImageUrl, tryOnId) {
    const wardrobe = getWardrobe();

    // Layered try-on? The outfit base must belong to the CURRENT photo id —
    // otherwise the shopper re-based, then changed photos, and this is solo.
    const baseItems = (__elloOutfitBase && __elloOutfitBase.key === userPhotoFileId)
        ? __elloOutfitBase.items : null;
    const newDescriptor = elloGarmentDescriptor(clothing);
    let outfitItems = null;
    if (baseItems && baseItems.length) {
        outfitItems = baseItems
            .filter(d => String(d.clothingId) !== String(newDescriptor.clothingId))
            .concat([newDescriptor]);
        if (outfitItems.length < 2) outfitItems = null; // re-layered the same piece → solo
    }
    const isOutfit = !!outfitItems;

    // Dedupe: solo looks replace the previous solo card for the same garment;
    // outfits replace only an outfit with the IDENTICAL garment set. A solo
    // save must never overwrite an outfit card (and vice versa) — shoppers
    // compare the one-piece and the full outfit side by side.
    let existingIndex = -1;
    if (isOutfit) {
        const outfitKey = outfitItems.map(d => String(d.clothingId)).sort().join('|');
        existingIndex = wardrobe.findIndex(item => item.isOutfit && Array.isArray(item.outfitItems) &&
            item.outfitItems.map(d => String(d.clothingId)).sort().join('|') === outfitKey);
    } else {
        existingIndex = wardrobe.findIndex(item => !item.isOutfit && !item.isOriginalPhoto &&
            item.clothingId === clothing.id);
    }

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
    if (isOutfit) {
        wardrobeItem.isOutfit = true;
        wardrobeItem.outfitItems = outfitItems;
    }

    if (existingIndex !== -1) {
        // Update existing item
        wardrobe[existingIndex] = wardrobeItem;
    } else {
        // Add new item
        wardrobe.push(wardrobeItem);
    }

    await saveWardrobe(wardrobe);
    updateWardrobeButton();

    elloLog('✅ Added to wardrobe:', isOutfit ? outfitItems.map(d => d.clothingName).join(' + ') : clothing.name);
    return wardrobeItem;
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

// Update wardrobe button count. The focused PDP returning view injects a second
// .wardrobe-btn (matching the hub card), so update every count badge, not just
// the first one querySelector would find.
function updateWardrobeButton() {
    const count = getWardrobeCount();
    document.querySelectorAll('.wardrobe-btn .wardrobe-count').forEach(function (span) {
        span.textContent = count;
    });
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

    // Fitting-room hub: dismissing the wardrobe closes the whole hub, unless
    // we're switching to the collection tab (__elloHubKeepOpen set by elloHubSwitch).
    if (window.ELLO_HUB_MODE && !window.__elloHubKeepOpen) {
        closeWidget();
    }
}

// Escape a value for interpolation into wardrobe HTML. Product names come from
// merchant catalogs — an apostrophe ("Women's Tee") used to be a syntax error
// inside the old inline onclick handlers, killing the whole card's JS.
function elloEscapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Shared icon set for wardrobe cards + the viewer footer.
const ELLO_WC_ICONS = {
    cart: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.4"></circle><circle cx="17.5" cy="20" r="1.4"></circle><path d="M2.5 3.5h2.3l2.2 11.1a1.4 1.4 0 0 0 1.37 1.1h8.1a1.4 1.4 0 0 0 1.36-1.07L21 7.5H6.2"></path></svg>',
    outfit: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"></path></svg>',
    photo: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"></rect><circle cx="8.5" cy="10" r="1.6"></circle><path d="m20 17-4.6-4.6L7 20"></path></svg>',
    photoLarge: '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"></rect><circle cx="8.5" cy="10" r="1.6"></circle><path d="m20 17-4.6-4.6L7 20"></path></svg>',
    camera: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4.5h-5L7.2 7H4.5a2 2 0 0 0-2 2v8.5a2 2 0 0 0 2 2h15a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2.7L14.5 4.5z"></path><circle cx="12" cy="13" r="3.1"></circle></svg>',
    zoom: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M16 3h3a2 2 0 0 1 2 2v3"></path><path d="M8 21H5a2 2 0 0 1-2-2v-3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path></svg>'
};

// Display order: the shopper's photo is PINNED first, then looks newest-first
// (the stored wardrobe is already timestamp-sorted by saveWardrobe, but the
// photo item is stamped once at the first try-on, so without pinning it sinks
// one slot per new look — that's why it kept ending up mid-grid).
function elloOrderedWardrobe() {
    const wardrobe = getWardrobe();
    const photo = wardrobe.filter(item => item.isOriginalPhoto);
    const looks = wardrobe.filter(item => !item.isOriginalPhoto);
    return photo.slice(0, 1).concat(looks);
}

// Resolve the displayable image for a wardrobe item ('' when there is none).
function elloWardrobeItemImage(item) {
    let src = item && item.resultImageUrl;
    if (item && item.isOriginalPhoto && (!src || src === 'stored_in_localStorage')) {
        src = localStorage.getItem(USER_PHOTO_STORAGE_KEY) || '';
    }
    if (typeof src !== 'string') return '';
    return (src.startsWith('data:image') || src.startsWith('http') || src.startsWith('blob:') || src.startsWith('/')) ? src : '';
}

function elloWardrobeIsOutfit(item) {
    return !!(item && item.isOutfit && Array.isArray(item.outfitItems) && item.outfitItems.length > 1);
}

function elloWardrobeDisplayName(item) {
    if (item.isOriginalPhoto) return 'Your photo';
    if (elloWardrobeIsOutfit(item)) {
        return item.outfitItems.map(d => d.clothingName).filter(Boolean).join(' + ');
    }
    return item.clothingName || '';
}

function elloWardrobePriceLabel(item) {
    if (item.isOriginalPhoto) return '';
    if (elloWardrobeIsOutfit(item)) {
        const total = item.outfitItems.reduce((sum, d) => sum + (Number(d.clothingPrice) || 0), 0);
        return total > 0 ? `$${total.toFixed(2)} total` : '';
    }
    const price = Number(item.clothingPrice);
    return isFinite(price) ? `$${price.toFixed(2)}` : '';
}

// Pinned "Your photo" card — a utility anchor, not a look: chip label,
// use/change actions, distinct styling.
function elloPhotoCardHTML(item) {
    const src = elloWardrobeItemImage(item);
    const media = src
        ? `<img class="epc-img" src="${src}" alt="Your photo" loading="lazy" decoding="async" onload="this.classList.add('is-loaded');this.parentNode.classList.add('epc-ready')">`
        : `<div class="ewc-photo-empty">${ELLO_WC_ICONS.photoLarge}</div>`;
    const zoomBtn = src
        ? `<button type="button" class="ewc-zoom" data-act="zoom" aria-label="View your photo larger">${ELLO_WC_ICONS.zoom}</button>`
        : '';
    const useBtn = src
        ? `<button class="ewc-btn ewc-btn-primary" data-act="use-photo">${ELLO_WC_ICONS.photo}<span>Use this photo</span></button>`
        : '';
    return `
        <div class="epc-card ewc-card ewc-photo" data-tryon-id="${elloEscapeHtml(item.id)}">
            <div class="epc-media${src ? '' : ' epc-ready'}">
                ${media}
                <span class="ewc-chip">Your photo</span>
                ${zoomBtn}
            </div>
            <div class="epc-info">
                <div class="epc-name">Your photo</div>
            </div>
            <div class="ewc-actions">
                ${useBtn}
                <button class="ewc-btn ${src ? 'ewc-btn-ghost' : 'ewc-btn-primary'}" data-act="change-photo">${ELLO_WC_ICONS.camera}<span>Change photo</span></button>
            </div>
        </div>
    `;
}

// Solo look or outfit card. Outfits are badged, show every piece's name, the
// combined price, and add ALL pieces to cart — while the solo card for the
// same garment stays alongside so shoppers can compare one piece vs the set.
function elloLookCardHTML(item) {
    const src = elloWardrobeItemImage(item);
    const isOutfit = elloWardrobeIsOutfit(item);
    const displayName = elloEscapeHtml(elloWardrobeDisplayName(item));
    const priceLabel = elloWardrobePriceLabel(item);
    const chip = isOutfit
        ? `<span class="ewc-chip ewc-chip-outfit">Outfit · ${item.outfitItems.length} items</span>`
        : '';
    return `
        <div class="epc-card ewc-card${isOutfit ? ' ewc-outfit' : ''}" data-tryon-id="${elloEscapeHtml(item.id)}">
            <div class="epc-media">
                <img class="epc-img" src="${src}" alt="Try-on result: ${displayName}" loading="lazy" decoding="async" onload="this.classList.add('is-loaded');this.parentNode.classList.add('epc-ready')">
                ${chip}
                <button type="button" class="ewc-zoom" data-act="zoom" aria-label="View larger">${ELLO_WC_ICONS.zoom}</button>
            </div>
            <div class="epc-info">
                <div class="epc-name">${displayName}</div>
                ${priceLabel ? `<div class="epc-price">${priceLabel}</div>` : ''}
            </div>
            <div class="ewc-actions">
                <button class="ewc-btn ewc-btn-primary" data-act="cart">${ELLO_WC_ICONS.cart}<span>${isOutfit ? 'Add all to cart' : 'Add to cart'}</span></button>
                <button class="ewc-btn ewc-btn-ghost" data-act="outfit">${ELLO_WC_ICONS.outfit}<span>Add to outfit</span></button>
            </div>
        </div>
    `;
}

// Render wardrobe grid
function renderWardrobeGrid() {
    const grid = document.getElementById('wardrobeGrid');
    const empty = document.getElementById('wardrobeEmpty');
    const wardrobe = elloOrderedWardrobe();

    if (wardrobe.length === 0) {
        grid.style.display = 'none';
        empty.style.display = 'block';
        return;
    }

    grid.style.display = 'grid';
    empty.style.display = 'none';

    grid.innerHTML = wardrobe
        .map(item => item.isOriginalPhoto ? elloPhotoCardHTML(item) : elloLookCardHTML(item))
        .join('');
    elloWireWardrobeGrid(grid);
}

// One delegated listener owns every wardrobe card action. No inline onclick:
// survives re-renders, apostrophes in product names, and never duplicates the
// base64 result image into the DOM as a handler argument.
function elloWireWardrobeGrid(grid) {
    if (grid.__elloWired) return;
    grid.__elloWired = true;
    grid.addEventListener('click', function (e) {
        const card = e.target.closest('.ewc-card');
        if (!card || !grid.contains(card)) return;
        const id = card.getAttribute('data-tryon-id');
        const actBtn = e.target.closest('[data-act]');
        // A tap anywhere on the image opens the viewer; buttons win if hit.
        const act = actBtn ? actBtn.getAttribute('data-act')
            : (e.target.closest('.epc-media') ? 'zoom' : null);
        if (!act) return;
        if (act === 'zoom') openWardrobeViewer(id);
        else if (act === 'cart') addWardrobeItemToCart(id);
        else if (act === 'outfit') addToOutfit(id);
        else if (act === 'use-photo') useOriginalPhoto(id);
        else if (act === 'change-photo') elloWardrobeChangePhoto();
    });
}

// "Change photo" from the pinned card: run the normal upload flow, then
// refresh the grid once the new photo lands in storage (compression + save
// are async with no completion hook, so poll the stored value briefly).
let __elloWardrobePhotoPoll = null;
function elloWardrobeChangePhoto() {
    const before = localStorage.getItem(USER_PHOTO_STORAGE_KEY);
    handlePhotoUploadClick();
    if (__elloWardrobePhotoPoll) clearInterval(__elloWardrobePhotoPoll);
    let waited = 0;
    __elloWardrobePhotoPoll = setInterval(function () {
        waited += 500;
        const current = localStorage.getItem(USER_PHOTO_STORAGE_KEY);
        if (current && current !== before) {
            clearInterval(__elloWardrobePhotoPoll);
            __elloWardrobePhotoPoll = null;
            const modal = document.getElementById('wardrobeModal');
            if (modal && modal.classList.contains('active')) renderWardrobeGrid();
        } else if (waited >= 30000) {
            clearInterval(__elloWardrobePhotoPoll);
            __elloWardrobePhotoPoll = null;
        }
    }, 500);
}

// ─── Wardrobe viewer (lightbox) ──────────────────────────────────────────────
// Full-screen look viewer: prev/next (buttons, arrow keys, swipe), double-tap
// or double-click zoom, pinch zoom + pan on touch, and a footer with the
// item's name/price and the same buy actions as the card.
const __elloViewer = {
    list: [], index: -1,
    scale: 1, tx: 0, ty: 0,
    pointers: new Map(), pinch: null, gesture: null, lastTap: 0,
    wired: false
};

function openWardrobeViewer(tryOnId) {
    const list = elloOrderedWardrobe().filter(item => !!elloWardrobeItemImage(item));
    if (!list.length) return;
    let index = list.findIndex(item => item.id === tryOnId);
    if (index === -1) index = 0;
    __elloViewer.list = list;
    elloViewerWireChrome();
    const modal = document.getElementById('imageModal');
    modal.classList.add('wardrobe-view');
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
    elloViewerShow(index);
}

function elloViewerShow(index) {
    const v = __elloViewer;
    const n = v.list.length;
    if (!n) return;
    v.index = ((index % n) + n) % n;
    const item = v.list[v.index];
    elloViewerResetZoom();
    const img = document.getElementById('modalImage');
    if (img) {
        img.src = elloWardrobeItemImage(item);
        img.alt = item.isOriginalPhoto ? 'Your photo' : `Try-on result: ${elloWardrobeDisplayName(item)}`;
    }
    const footer = document.getElementById('elloViewerFooter');
    if (footer) footer.innerHTML = elloViewerFooterHTML(item);
    const count = document.getElementById('elloViewerCount');
    if (count) { count.textContent = (v.index + 1) + ' / ' + n; count.hidden = n < 2; }
    const prev = document.getElementById('elloViewerPrev');
    const next = document.getElementById('elloViewerNext');
    if (prev) prev.hidden = n < 2;
    if (next) next.hidden = n < 2;
}

function elloViewerFooterHTML(item) {
    const id = elloEscapeHtml(item.id);
    if (item.isOriginalPhoto) {
        return `
            <div class="ewv-meta">
                <div class="ewv-title">Your photo</div>
                <div class="ewv-sub">The base photo for your try-ons</div>
            </div>
            <div class="ewv-actions">
                <button class="ewc-btn ewc-btn-primary" data-act="use-photo" data-id="${id}">${ELLO_WC_ICONS.photo}<span>Use this photo</span></button>
            </div>`;
    }
    const isOutfit = elloWardrobeIsOutfit(item);
    const badge = isOutfit ? `<span class="ewv-badge">Outfit · ${item.outfitItems.length} items</span>` : '';
    const priceLabel = elloWardrobePriceLabel(item);
    return `
        <div class="ewv-meta">
            <div class="ewv-title">${elloEscapeHtml(elloWardrobeDisplayName(item))}${badge}</div>
            ${priceLabel ? `<div class="ewv-sub">${priceLabel}</div>` : ''}
        </div>
        <div class="ewv-actions">
            <button class="ewc-btn ewc-btn-primary" data-act="cart" data-id="${id}">${ELLO_WC_ICONS.cart}<span>${isOutfit ? 'Add all to cart' : 'Add to cart'}</span></button>
            <button class="ewc-btn ewc-btn-ghost" data-act="outfit" data-id="${id}">${ELLO_WC_ICONS.outfit}<span>Add to outfit</span></button>
        </div>`;
}

function elloViewerWireChrome() {
    const v = __elloViewer;
    if (v.wired) return;
    v.wired = true;
    const prev = document.getElementById('elloViewerPrev');
    const next = document.getElementById('elloViewerNext');
    const footer = document.getElementById('elloViewerFooter');
    const stage = document.getElementById('elloViewerStage');
    if (prev) prev.addEventListener('click', function (e) { e.stopPropagation(); elloViewerShow(v.index - 1); });
    if (next) next.addEventListener('click', function (e) { e.stopPropagation(); elloViewerShow(v.index + 1); });
    if (footer) footer.addEventListener('click', function (e) {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.getAttribute('data-act');
        const id = btn.getAttribute('data-id');
        // Close the viewer first: cart flow opens the size picker over the
        // wardrobe grid (its proven stacking context), outfit/use-photo close
        // the wardrobe themselves.
        closeImageModal();
        if (act === 'cart') addWardrobeItemToCart(id);
        else if (act === 'outfit') addToOutfit(id);
        else if (act === 'use-photo') useOriginalPhoto(id);
    });
    if (stage) elloViewerWireStage(stage);
}

function elloViewerApply(animate) {
    const img = document.getElementById('modalImage');
    if (!img) return;
    const v = __elloViewer;
    img.style.transition = animate ? 'transform .25s ease' : 'none';
    img.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.scale})`;
    img.classList.toggle('ewv-zoomed', v.scale > 1);
}

function elloViewerResetZoom() {
    const v = __elloViewer;
    v.scale = 1; v.tx = 0; v.ty = 0;
    v.pinch = null; v.gesture = null;
    v.pointers.clear();
    elloViewerApply(false);
}

// Zoom keeping the viewport point (cx, cy) fixed. rect already includes the
// current transform, so the offset from the rendered center divided by the
// current scale is the content point — translate compensates its growth.
function elloViewerZoomTo(scale, cx, cy, animate) {
    const v = __elloViewer;
    const img = document.getElementById('modalImage');
    const next = Math.max(1, Math.min(4, scale));
    if (next === 1) { v.scale = 1; v.tx = 0; v.ty = 0; elloViewerApply(animate); return; }
    if (cx != null && img) {
        const rect = img.getBoundingClientRect();
        const dx = cx - (rect.left + rect.width / 2);
        const dy = cy - (rect.top + rect.height / 2);
        v.tx -= dx * (next / v.scale - 1);
        v.ty -= dy * (next / v.scale - 1);
    }
    v.scale = next;
    elloViewerClampPan();
    elloViewerApply(animate);
}

function elloViewerClampPan() {
    const v = __elloViewer;
    const img = document.getElementById('modalImage');
    if (!img) return;
    const rect = img.getBoundingClientRect();
    const baseW = rect.width / v.scale;
    const baseH = rect.height / v.scale;
    const maxX = baseW * (v.scale - 1) / 2 + 60;
    const maxY = baseH * (v.scale - 1) / 2 + 60;
    v.tx = Math.max(-maxX, Math.min(maxX, v.tx));
    v.ty = Math.max(-maxY, Math.min(maxY, v.ty));
}

function elloViewerWireStage(stage) {
    const v = __elloViewer;

    stage.addEventListener('pointerdown', function (e) {
        const modal = document.getElementById('imageModal');
        if (!modal || !modal.classList.contains('wardrobe-view')) return;
        if (stage.setPointerCapture) { try { stage.setPointerCapture(e.pointerId); } catch (err) {} }
        v.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (v.pointers.size === 1) {
            v.gesture = { x0: e.clientX, y0: e.clientY, t0: Date.now(), tx0: v.tx, ty0: v.ty, moved: false };
        } else if (v.pointers.size === 2) {
            const pts = Array.from(v.pointers.values());
            v.pinch = { d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), s0: v.scale };
            v.gesture = null;
        }
        e.preventDefault();
    });

    stage.addEventListener('pointermove', function (e) {
        if (!v.pointers.has(e.pointerId)) return;
        v.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (v.pinch && v.pointers.size >= 2) {
            const pts = Array.from(v.pointers.values());
            const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            if (v.pinch.d0 > 0) {
                elloViewerZoomTo(v.pinch.s0 * (d / v.pinch.d0), (pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, false);
            }
        } else if (v.gesture) {
            const dx = e.clientX - v.gesture.x0;
            const dy = e.clientY - v.gesture.y0;
            if (Math.abs(dx) > 6 || Math.abs(dy) > 6) v.gesture.moved = true;
            if (v.scale > 1) {
                v.tx = v.gesture.tx0 + dx;
                v.ty = v.gesture.ty0 + dy;
                elloViewerClampPan();
                elloViewerApply(false);
            }
        }
    });

    const onPointerEnd = function (e) {
        if (!v.pointers.has(e.pointerId)) return;
        v.pointers.delete(e.pointerId);
        if (v.pointers.size < 2) v.pinch = null;
        const g = v.gesture;
        if (!g || v.pointers.size !== 0) return;
        v.gesture = null;
        const dt = Date.now() - g.t0;
        const dx = e.clientX - g.x0;
        const dy = e.clientY - g.y0;
        if (v.scale === 1 && Math.abs(dx) > 56 && Math.abs(dx) > 2 * Math.abs(dy) && dt < 600) {
            // Horizontal swipe → previous / next look.
            elloViewerShow(v.index + (dx < 0 ? 1 : -1));
        } else if (!g.moved && dt < 300) {
            // Double-tap (or double-click) toggles zoom at the tap point.
            const now = Date.now();
            if (now - v.lastTap < 350) {
                v.lastTap = 0;
                if (v.scale > 1) elloViewerZoomTo(1, null, null, true);
                else elloViewerZoomTo(2.2, e.clientX, e.clientY, true);
            } else {
                v.lastTap = now;
            }
        }
    };
    stage.addEventListener('pointerup', onPointerEnd);
    stage.addEventListener('pointercancel', onPointerEnd);
}

// Back-compat shim: older cached markup called this with (src, name, id).
function enlargeWardrobeImage(imageSrc, itemName, tryOnId) {
    openWardrobeViewer(tryOnId);
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

    // The next result will contain everything this base already wears + the
    // new garment — record the chain so the save labels it as an outfit.
    elloSetOutfitBase(item.isOutfit && Array.isArray(item.outfitItems) && item.outfitItems.length
        ? item.outfitItems
        : [item]);

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
        const saved = await addToWardrobe(clothing, resultImageUrl, tryOnId);
        await addOriginalPhotoToWardrobe(); // Also save original photo if not already saved
        const isOutfit = saved && saved.isOutfit;
        showSuccessNotification(
            isOutfit ? 'Outfit Saved to Wardrobe' : 'Saved to Wardrobe',
            isOutfit
                ? `${saved.outfitItems.map(d => d.clothingName).join(' + ')} saved as an outfit!`
                : `${clothing.name} has been saved to your wardrobe!`
        );
    }
}

// Add wardrobe item to cart. An outfit card adds EVERY piece it contains —
// sequentially, so each piece gets its own size pick.
async function addWardrobeItemToCart(tryOnId) {
    const wardrobe = getWardrobe();
    const item = wardrobe.find(w => w.id === tryOnId);

    if (!item) {
        console.error('Wardrobe item not found:', tryOnId);
        return;
    }

    const garments = elloWardrobeIsOutfit(item)
        ? item.outfitItems
        : [{ clothingId: item.clothingId, clothingName: item.clothingName }];
    for (const garment of garments) {
        await elloAddWardrobeGarmentToCart(item, garment);
    }
}

// Resolve one garment reference to catalog data + a variant and add it to the
// Shopify cart (the single-item body of the old addWardrobeItemToCart).
async function elloAddWardrobeGarmentToCart(item, garment) {
    const tryOnId = item.id;

    // Find the original clothing data (Robust match)
    const clothing = sampleClothing.find(c => {
        const idStr = String(garment.clothingId);
        if (c.id == garment.clothingId) return true;
        if (String(c.id).endsWith(`/${idStr}`)) return true;
        if (idStr.endsWith(`/${c.id}`)) return true;
        if (c.shopify_product_id && c.shopify_product_id == garment.clothingId) return true;
        if (c.handle && (c.handle === idStr || c.handle === idStr.toLowerCase())) return true;
        return false;
    });

    if (!clothing) {
        console.error('Original clothing data not found for wardrobe item:', garment.clothingId);
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
                `${garment.clothingName || clothing.name} ${sizeDisplay ? `• ${sizeDisplay}` : ''}`
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
    if ((isMobile || window.innerWidth < 768 || !isFinePointer) && !forceShowPreview) {
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
var forceShowPreview = checkPreviewEligibilityAndShow;
// (resetPreviewTimers and forceShowPreview are published via window.__elloWidget below)


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

    // New page = new product context. The footwear cache is path-keyed (it
    // self-invalidates on pathname change), but clear it anyway and re-apply
    // the upload copy proactively for stores where these listeners run. The
    // widget-open hook covers stores where they don't (preview gated off).
    __elloFootwearContext = null;
    __elloFootwearContextPath = null;
    elloApplyFootwearUploadCopy();

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
    if ((isMobile || window.innerWidth < 768 || !isFinePointer) && !forceShowPreview) {
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

    // Already tried this product on? Don't nag them to generate again. Covers a
    // try-on already showing on the hero this pageview AND one from a past visit
    // (saved in the wardrobe — which is also what the hero restores on load).
    // Either way they've seen themselves in it; the "generate my look" prompt
    // would be redundant.
    try {
        if (typeof __elloPdpSwap !== 'undefined' && __elloPdpSwap && __elloPdpSwap.swapped) {
            elloLog('[Ello VTO] Preview blocked: try-on already on the hero.');
            return;
        }
        const triedHandle = getProductIdFromUrl(window.location.pathname);
        if (triedHandle) {
            if (typeof __elloWardrobeReady !== 'undefined') { try { await __elloWardrobeReady; } catch (e) {} }
            const wr = getWardrobe();
            const alreadyTried = Array.isArray(wr) && wr.some(function (w) {
                return w && w.clothingId === triedHandle
                    && typeof w.resultImageUrl === 'string'
                    && w.resultImageUrl.indexOf('data:image') === 0;
            });
            if (alreadyTried) {
                elloLog('[Ello VTO] Preview blocked: shopper already tried this product on.');
                return;
            }
        }
    } catch (e) { /* if the check fails, fall through and show as before */ }

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
var handlePreviewUploadClick = function () {
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

var handlePreviewTryOn = async function () {
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
            updateTryOnLoadingCopy(overlay, elloActiveTryonTips().length - 1);
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

// Product-aware intro: a first-timer decides in ~2.5s from the first frame
// alone (2026-07-13 audit: bounce median 2.5s, converters click at 2.4s — the
// intro is glanced at, never read). When we know the exact product being
// viewed, the 3-card stock strip collapses to ONE hero card showing that
// product (the .fro-product-aware CSS hides the You/result cards — stock
// female placeholders that mis-signaled on menswear stores). The PDP already
// loaded this image, so it paints from browser cache. Falls back to the
// generic strip off-PDP, for non-catalog products, or if anything throws.
function personalizeIntroStrip(overlay) {
    try {
        let imageUrl = null;
        try {
            const product = detectCurrentProduct();
            imageUrl = (product && product.image_url) || null;
        } catch (e) { /* fall through to the og:image fallback */ }

        // Catalog not loaded yet (fast open racing the async product fetch):
        // trust the PDP's own og:image so the intro is still personal. Only
        // when the URL says this is a product page — once the catalog IS
        // loaded, a miss means "not try-on-able" and the generic strip is right.
        if (!imageUrl && (!Array.isArray(sampleClothing) || sampleClothing.length === 0)
            && getProductIdFromUrl(window.location.pathname)) {
            const og = document.querySelector('meta[property="og:image"]');
            if (og && og.content) imageUrl = og.content;
        }

        if (!imageUrl) {
            overlay.classList.remove('fro-product-aware');
            return;
        }

        const itemImg = overlay.querySelector('.fro-step.item-card .fro-media img');
        if (!itemImg) return;
        itemImg.src = imageUrl;
        itemImg.style.display = ''; // undo the placeholder's onerror fallback if it fired
        const icon = itemImg.nextElementSibling;
        if (icon) icon.style.display = 'none';

        const headline = overlay.querySelector('.fro-headline');
        if (headline) headline.innerHTML = 'See this on you.<br>Instantly.';
        const subtext = overlay.querySelector('.fro-subtext');
        if (subtext) subtext.textContent = 'One photo is all it takes.';

        overlay.classList.add('fro-product-aware');
    } catch (e) {
        overlay.classList.remove('fro-product-aware');
    }
}

function checkOnboarding() {
    const overlay = document.getElementById('firstRunOverlay');
    if (!overlay) return;

    const storeSlug = window.ELLO_STORE_CONFIG?.storeSlug || window.ELLO_STORE_SLUG || window.ELLO_STORE_ID || 'default_store';
    const ONBOARDING_KEY = `ello_intro_seen:${storeSlug}`;

    // Check if user has already onboarded
    const onboardingComplete = localStorage.getItem(ONBOARDING_KEY) === 'true';

    // Hub mode (no-widget PDP): the overlay IS the no-photo first-touch screen
    // (Upload your photo / Use a model), so show it whenever there's no saved
    // photo — not only on the first-ever open. Once a photo exists, hub mode
    // lands on the home and the overlay stays hidden.
    let hasPhoto = !!(userPhoto || window.elloUserImageUrl);
    if (!hasPhoto) { try { hasPhoto = !!localStorage.getItem(USER_PHOTO_STORAGE_KEY); } catch (e) {} }
    const hubFirstTouch = elloPdpHubModeOn() && !hasPhoto;

    // If NOT complete (or hub mode with no photo), show overlay
    if (!onboardingComplete || hubFirstTouch) {
        isFirstTimeIntro = true;
        introViewId = generateIntroViewId();
        introShownAt = Date.now();
        introActionFired = false;

        // Personalize BEFORE the overlay becomes visible so the first paint
        // already shows the shopper's product (never a flash of the generic strip).
        personalizeIntroStrip(overlay);

        // Make sure it's visible. In hub mode paint it OPAQUE on the first frame
        // (add .active synchronously, no fade) so it covers the panel before the
        // browser paints — eliminating the flash of the bare workspace behind it.
        overlay.style.display = 'flex';
        if (hubFirstTouch) {
            overlay.classList.add('active');
        } else {
            // Small delay to allow display:flex to apply before adding active class for opacity transition
            setTimeout(() => {
                overlay.classList.add('active');
            }, 10);
        }

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

    window.__elloSelectedSource = 'user';

    // Hub mode OR focused mode: go STRAIGHT to the file picker instead of
    // dropping the shopper on the bare upload workspace. Focused mode NEEDS
    // this — its CSS hides the whole .photo-section, so the old scroll-to-card
    // path pointed at an invisible target. After they pick, the upload handler
    // repaints the focused stage (and auto-fires the try-on when armed).
    if (elloPdpHubModeOn() || window.ELLO_FOCUSED_MODE === true) {
        const fire = () => { const i = document.getElementById('photoInput'); if (i) i.click(); };
        if (typeof checkShouldShowBestPractices === 'function' && checkShouldShowBestPractices()) {
            pendingPhotoAction = fire;
            showBestPracticesModal();
        } else {
            fire();
        }
        return;
    }

    // Save selection state and scroll
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

    window.__elloSelectedSource = 'model';

    // Hub mode OR inline mode: open the model browser directly. The inline
    // workspace hides #useModelCard entirely (display:none in the template CSS),
    // so the scroll-to-card path below dead-ends there — the 2026-07-13 audit
    // measured 43 "Use a Model" intro clicks → 9 model selections because of it.
    if ((elloPdpHubModeOn() || window.ELLO_INLINE_MODE === true) && typeof openModelBrowser === 'function') {
        openModelBrowser();
        return;
    }

    // Save selection state and scroll
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


// ─── Inline-handler namespace ───────────────────────────────────────────────
// The widget's HTML uses inline on*= attributes, which resolve their functions
// against window. Everything is published under the single window.__elloWidget
// namespace so the widget claims exactly ONE global for its UI handlers.
// Bare-name aliases are only filled when the page hasn't claimed the name —
// they exist solely so a CDN-cached older widget.html (whose markup still
// calls bare names) keeps working until its cache expires.
window.__elloWidget = window.__elloWidget || {};

window.__elloWidget.addToOutfit = (typeof addToOutfit !== 'undefined') ? addToOutfit : window.addToOutfit;
window.__elloWidget.addWardrobeItemToCart = (typeof addWardrobeItemToCart !== 'undefined') ? addWardrobeItemToCart : window.addWardrobeItemToCart;
window.__elloWidget.chooseFromGallery = (typeof chooseFromGallery !== 'undefined') ? chooseFromGallery : window.chooseFromGallery;
window.__elloWidget.clearSelectedClothing = (typeof clearSelectedClothing !== 'undefined') ? clearSelectedClothing : window.clearSelectedClothing;
window.__elloWidget.closeBestPracticesModal = (typeof closeBestPracticesModal !== 'undefined') ? closeBestPracticesModal : window.closeBestPracticesModal;
window.__elloWidget.openPhotoTips = (typeof openPhotoTips !== 'undefined') ? openPhotoTips : window.openPhotoTips;
window.__elloWidget.closeClothingBrowser = (typeof closeClothingBrowser !== 'undefined') ? closeClothingBrowser : window.closeClothingBrowser;
window.__elloWidget.closeImageModal = (typeof closeImageModal !== 'undefined') ? closeImageModal : window.closeImageModal;
window.__elloWidget.closeModelBrowser = (typeof closeModelBrowser !== 'undefined') ? closeModelBrowser : window.closeModelBrowser;
window.__elloWidget.closeWardrobe = (typeof closeWardrobe !== 'undefined') ? closeWardrobe : window.closeWardrobe;
window.__elloWidget.closeWidget = (typeof closeWidget !== 'undefined') ? closeWidget : window.closeWidget;
window.__elloWidget.dismissPreview = (typeof dismissPreview !== 'undefined') ? dismissPreview : window.dismissPreview;
window.__elloWidget.enlargeWardrobeImage = (typeof enlargeWardrobeImage !== 'undefined') ? enlargeWardrobeImage : window.enlargeWardrobeImage;
// Ops hook: re-apply style_overrides (incl. theme) after mutating
// window.ELLO_STORE_CONFIG.styleOverrides from the console.
window.__elloWidget.applyStyleOverrides = (typeof applyStyleOverrides !== 'undefined') ? applyStyleOverrides : window.applyStyleOverrides;
window.__elloWidget.goToBrowserPage = (typeof goToBrowserPage !== 'undefined') ? goToBrowserPage : window.goToBrowserPage;
window.__elloWidget.handleBestPracticesUpload = (typeof handleBestPracticesUpload !== 'undefined') ? handleBestPracticesUpload : window.handleBestPracticesUpload;
window.__elloWidget.handleBrowserSearch = (typeof handleBrowserSearch !== 'undefined') ? handleBrowserSearch : window.handleBrowserSearch;
window.__elloWidget.handlePhotoUpload = (typeof handlePhotoUpload !== 'undefined') ? handlePhotoUpload : window.handlePhotoUpload;
window.__elloWidget.handlePhotoUploadClick = (typeof handlePhotoUploadClick !== 'undefined') ? handlePhotoUploadClick : window.handlePhotoUploadClick;
window.__elloWidget.handlePreviewTryOn = (typeof handlePreviewTryOn !== 'undefined') ? handlePreviewTryOn : window.handlePreviewTryOn;
window.__elloWidget.handlePreviewUploadClick = (typeof handlePreviewUploadClick !== 'undefined') ? handlePreviewUploadClick : window.handlePreviewUploadClick;
window.__elloWidget.hideNotification = (typeof hideNotification !== 'undefined') ? hideNotification : window.hideNotification;
window.__elloWidget.nextBrowserPage = (typeof nextBrowserPage !== 'undefined') ? nextBrowserPage : window.nextBrowserPage;
window.__elloWidget.openClothingBrowser = (typeof openClothingBrowser !== 'undefined') ? openClothingBrowser : window.openClothingBrowser;
window.__elloWidget.openModelBrowser = (typeof openModelBrowser !== 'undefined') ? openModelBrowser : window.openModelBrowser;
window.__elloWidget.openWardrobe = (typeof openWardrobe !== 'undefined') ? openWardrobe : window.openWardrobe;
window.__elloWidget.prevBrowserPage = (typeof prevBrowserPage !== 'undefined') ? prevBrowserPage : window.prevBrowserPage;
window.__elloWidget.resetPhotoUploadArea = (typeof resetPhotoUploadArea !== 'undefined') ? resetPhotoUploadArea : window.resetPhotoUploadArea;
window.__elloWidget.selectClothing = (typeof selectClothing !== 'undefined') ? selectClothing : window.selectClothing;
window.__elloWidget.selectFeaturedClothing = (typeof selectFeaturedClothing !== 'undefined') ? selectFeaturedClothing : window.selectFeaturedClothing;
window.__elloWidget.takePicture = (typeof takePicture !== 'undefined') ? takePicture : window.takePicture;
window.__elloWidget.useOriginalPhoto = (typeof useOriginalPhoto !== 'undefined') ? useOriginalPhoto : window.useOriginalPhoto;
window.__elloWidget.elloHubSwitch = (typeof elloHubSwitch !== 'undefined') ? elloHubSwitch : window.elloHubSwitch;
window.__elloWidget.startTryOn = (typeof startTryOn !== 'undefined') ? startTryOn : window.startTryOn;
window.__elloWidget.resetPreviewTimers = (typeof resetPreviewTimers !== 'undefined') ? resetPreviewTimers : window.resetPreviewTimers;
window.__elloWidget.forceShowPreview = (typeof forceShowPreview !== 'undefined') ? forceShowPreview : window.forceShowPreview;

Object.keys(window.__elloWidget).forEach(function (n) {
    if (typeof window[n] === 'undefined' && typeof window.__elloWidget[n] === 'function') {
        window[n] = window.__elloWidget[n];
    }
});


})();
