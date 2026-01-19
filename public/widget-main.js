
// Generate and persist session ID for tracking (will be set after store config loads)
// The actual sessionId is now managed via localStorage below

console.log("✅ Ello Widget v2.3.7 - Bootstrap Blacklist Fix");

// Make initializeWidget globally accessible
window.initializeWidget = function () {
    detectDevice();
    tryonChatHistory = [];  // Initialize as array instead of undefined
    generalChatHistory = []; // Initialize as array instead of undefined

    // Model Catalogue Feature - Init Event Listeners
    // Use a small timeout to ensure DOM is ready if script loads fast
    setTimeout(initializeModelEvents, 500);

    // If store config not loaded yet (e.g., direct HTML load without loader), fetch it
    if (!window.ELLO_STORE_CONFIG) {
        const storeSlug = window.ELLO_STORE_SLUG || window.ELLO_STORE_ID || 'default_store';

        const url = `https://rwmvgwnebnsqcyhhurti.supabase.co/rest/v1/vto_stores?store_slug=eq.${storeSlug}&select=widget_primary_color,widget_accent_color,minimized_color,featured_item_id,quick_picks_ids,clothing_population_type`;
        fetch(url, {
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json',
            }
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
                        widgetPrimaryColor: storeConfig.widget_primary_color || null,
                        widgetAccentColor: storeConfig.widget_accent_color || null,
                        minimizedColor: storeConfig.minimized_color || null,
                        featuredItemId: storeConfig.featured_item_id || null,
                        quickPicksIds: storeConfig.quick_picks_ids || null
                    };

                    // Now apply the colors and theme
                    applyWidgetThemeColors();
                    applyMinimizedWidgetColor();
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
            });
    } else {
    }

    // Load saved photo from storage on initialization
    loadSavedPhoto();

    // Load clothing data from Shopify
    loadClothingData().then(() => {
    }).catch(error => {
        console.error('Initial clothing data load failed:', error);
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
        } else if (retryCount < 3) {
            retryCount++;
            const delay = retryCount * 500; // 500ms, 1000ms, 1500ms
            setTimeout(tryApplyColor, delay);
        } else {
            console.warn('⚠️ Store config not available after retries, using default color');
            applyMinimizedWidgetColor(); // Still try (will use default)
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
let scrollLockPosition = 0;
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

// Supabase Configuration
const SUPABASE_URL = 'https://rwmvgwnebnsqcyhhurti.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ3bXZnd25lYm5zcWN5aGh1cnRpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDg0MDc1MTgsImV4cCI6MjA2Mzk4MzUxOH0.OYTXiUBDN5IBlFYDHN3MyCwFUkSb8sgUOewBeSY01NY';



// Widget Configuration
const WIDGET_CONFIG = {
    MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB
    ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    MAX_MESSAGE_LENGTH: 1000,
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY: 1000
};

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
            console.log("⏳ Main: awaiting bootstrap promise...");

            // Create a timeout promise (e.g., 8 seconds) to prevent hanging
            const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 8000));

            try {
                // Race the bootstrap against the timeout
                const bootstrap = await Promise.race([window.ELLO_BOOTSTRAP_PROMISE, timeoutPromise]);

                if (bootstrap && Array.isArray(bootstrap)) {
                    const products = bootstrap;
                    console.log("🚀 Main: using bootstrapped catalog:", products.length);

                    // Initialize Blacklists for Bootstrap Path
                    window.elloHiddenProductIds = new Set();
                    window.elloHiddenTitles = new Set();
                    window.elloHiddenHandles = new Set();

                    if (products.length > 0) {
                        // Normalize bootstrap products and apply Blacklist Logic
                        sampleClothing = [];

                        products.forEach(p => {
                            // Check for Hidden Status (active: false)
                            // If p.active is strictly false, it's hidden. If undefined or true, it's visible.
                            if (p.active === false) {
                                // Add to Blacklists
                                if (p.id) window.elloHiddenProductIds.add(String(p.id));

                                // Shopify GID
                                const gid = p.id || p.shopify_product_id;
                                if (gid) {
                                    const cleanId = String(gid).split('/').pop();
                                    window.elloHiddenProductIds.add(cleanId);
                                    window.elloHiddenProductIds.add(String(gid));
                                }

                                // Title (Lowercase)
                                const name = p.title || p.name;
                                if (name) window.elloHiddenTitles.add(name.trim().toLowerCase());

                                // Handle (from URL or Handle field)
                                let handle = p.handle;
                                if (!handle && (p.product_url || p.url)) {
                                    const url = p.product_url || p.url;
                                    handle = url.split('/').pop().split('?')[0];
                                }
                                if (!handle && name) {
                                    // Fallback slugify
                                    handle = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
                                }
                                if (handle) window.elloHiddenHandles.add(handle.toLowerCase());

                                return; // SKIP adding to sampleClothing
                            }

                            // Add to Visible Clothing
                            sampleClothing.push({
                                ...p,
                                name: p.title || p.name, // Ensure 'name' exists
                                image_url: p.image || p.image_url, // Ensure 'image_url' match
                                price: typeof p.price === 'string' ? parseFloat(p.price) : (p.price || 0), // Ensure price is number
                                shopify_product_gid: p.shopify_product_id || p.id, // Ensure GID is available for tracking (prefer explicit shopify field)
                                variants: p.variants || [] // Pass through variants
                            });
                        });
                        // Refresh UI if widget is open
                        if (widgetOpen && currentMode === 'tryon') {
                            await populateFeaturedAndQuickPicks();
                        }

                        // ⚡️ PRELOAD OPTIMIZATION:
                        // Identify the current product immediately and start loading its image
                        // so it is ready when the preview widget pops up.
                        try {
                            const current = detectCurrentProduct();
                            if (current && current.image_url) {
                                console.log("🚀 Preloading image for:", current.name);
                                const preloadLink = document.createElement('link');
                                preloadLink.rel = 'preload';
                                preloadLink.as = 'image';
                                preloadLink.href = current.image_url;
                                document.head.appendChild(preloadLink);
                                new Image().src = current.image_url; // Force browser cache
                            }
                        } catch (e) { console.warn("Preload failed", e); }

                        return; // STOP HERE - Do not run Supabase/Shopify logic
                    }
                } else {
                    console.warn("⚠️ Bootstrap promise returned null or invalid data");
                }
            } catch (e) {
                console.error("❌ Error awaiting bootstrap promise:", e);
            }
        }

        if (storeConfig.clothingPopulationType === 'supabase') {
            await loadClothingFromSupabase(storeConfig);
        } else {
            await loadClothingFromShopify(storeConfig);
        }

        // If no clothing items were loaded, leave empty (no fallback)
        if (!sampleClothing || sampleClothing.length === 0) {
            console.warn('⚠️ No clothing items found.');
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
    // OPTIMIZATION: Limit to first 250 products to improve initial load time.
    // Fetching thousands of products to find clothing items is inefficient directly in the widget.
    const MAX_PAGES = 1;

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
                    console.log('⚠️ Widget optimization: Limited product fetch to first 250 items. Some items may not be visible.');
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
            console.log("🛠 [LEGACY] Extracted shop handle from domain:", extractedHandle);
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

    // FILTER REMOVED: All products allowed (dashboard controlled)
    sampleClothing = visibleProducts;


    if (sampleClothing.length === 0) {
        console.warn('⚠️ [LEGACY] No clothing items found.');
    }
}

// Fetch hidden product IDs from Supabase (products with active=false)
async function fetchHiddenProductIds(storeSlug) {
    // Use store_slug (preferred) or fall back to storeId for backward compatibility
    const slug = storeSlug || window.ELLO_STORE_SLUG || window.ELLO_STORE_ID || 'default_store';

    try {
        // Query clothing_items table: WHERE store_id = store_slug AND data_source = 'shopify' AND active = false
        const url = `https://rwmvgwnebnsqcyhhurti.supabase.co/rest/v1/clothing_items?store_id=eq.${slug}&data_source=eq.shopify&active=eq.false&select=item_id`;

        const response = await fetch(url, {
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json',
            }
        });

        if (!response.ok) {
            console.warn(`⚠️ Failed to fetch hidden product IDs (status ${response.status}). Showing all products.`);
            return new Set();
        }

        const data = await response.json();

        if (!Array.isArray(data)) {
            console.warn('⚠️ Invalid data format from Supabase for hidden products. Showing all products.');
            return new Set();
        }

        // Extract item_id values and convert to Set of strings
        const hiddenIds = new Set(data.map(item => String(item.item_id || '')).filter(id => id));

        if (hiddenIds.size > 0) {
            console.log(`🔒 Filtering out ${hiddenIds.size} hidden product(s) from Supabase`);
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

// Load clothing from Supabase
async function loadClothingFromSupabase(storeConfig) {
    // Use store_slug (preferred) or fall back to storeId for backward compatibility
    const storeSlug = storeConfig.storeSlug || storeConfig.storeId || 'default_store';

    try {
        // Query clothing_items table: WHERE store_id = store_slug ORDER BY created_at DESC
        // REMOVED 'active=eq.true' to allow fetching hidden items for blacklist
        const url = `https://rwmvgwnebnsqcyhhurti.supabase.co/rest/v1/clothing_items?store_id=eq.${storeSlug}&order=created_at.desc`;

        // Fetch clothing items from Supabase
        const response = await fetch(url, {
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json',
            }
        });


        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (!Array.isArray(data)) {
            throw new Error('Invalid data format received from Supabase');
        }

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
            console.log(`[Ello VTO] Updated price for ${product.name} from DOM: $${livePrice}`);
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
// Load saved photo from localStorage
function loadSavedPhoto() {
    try {
        // 1. Check for Model Selection first
        const savedSource = localStorage.getItem('ello_user_photo_source');
        if (savedSource === 'model') {
            const savedModelId = localStorage.getItem('ello_selected_model_id');
            const model = modelCatalogue.find(m => m.id === savedModelId);
            if (model) {
                userPhotoSource = 'model'; // Ensure state is synced
                selectModel(model); // Reuse check/select logic
                return true;
            }
        }

        // 2. Fallback to Uploaded Photo
        const savedPhoto = localStorage.getItem(USER_PHOTO_STORAGE_KEY);
        const savedFileId = localStorage.getItem(USER_PHOTO_FILE_ID_STORAGE_KEY);

        if (savedPhoto) {
            userPhoto = savedPhoto;
            userPhotoSource = 'upload'; // Ensure state is synced
            userPhotoFileId = savedFileId || 'photo_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

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
// Generate or retrieve persistent sessionId from localStorage (per store)
// This ensures rate limiting works across tabs/windows for the same browser
const ELLO_SESSION_KEY = `ello_session_id_${window.ELLO_STORE_ID || window.ELLO_STORE_SLUG || 'default_store'}`;
let sessionId = null;

try {
    const existing = window.localStorage.getItem(ELLO_SESSION_KEY);
    if (existing && typeof existing === 'string' && existing.length > 0) {
        sessionId = existing;
    } else {
        sessionId = generateSessionId();
        window.localStorage.setItem(ELLO_SESSION_KEY, sessionId);
    }
} catch (e) {
    // Fallback if localStorage is blocked (very rare)
    console.warn('⚠️ localStorage blocked, using ephemeral session ID:', e);
    sessionId = generateSessionId();
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
let browserItemsPerPage = 24; // Items per page (6 columns x 4 rows)

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
        if (!skipPendingAction && pendingPhotoAction) {
            const action = pendingPhotoAction;
            pendingPhotoAction = null;
            setTimeout(() => {
                action();
            }, 300);
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

    // Store current scroll position
    scrollLockPosition = window.pageYOffset || document.documentElement.scrollTop;

    // Set body to fixed position at current scroll
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollLockPosition}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
    document.body.style.overflow = 'hidden';

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

    // Remove fixed positioning
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.width = '';
    document.body.style.overflow = '';

    // Restore scroll position
    window.scrollTo(0, scrollLockPosition);
    scrollLockPosition = 0;

    // Remove touch handler
    if (scrollLockTouchHandler) {
        document.removeEventListener('touchmove', scrollLockTouchHandler);
        scrollLockTouchHandler = null;
    }
}

function openWidget() {
    // If opening full widget, close preview if it's open (use temporary dismiss so it user preference isn't permanent)
    if (isPreviewVisible) {
        dismissPreview(true);
        // Manual open is a meaningful interaction, so we mark it engaged (stops permanent dismissal logic if they close later)
        previewEngaged = true;
    }

    const widget = document.getElementById('virtualTryonWidget');

    // Mobile animation handling
    if (isMobile) {
        // Remove any existing animation classes
        widget.classList.remove('is-animating-open', 'is-animating-close');

        // Add opening animation class
        widget.classList.add('is-animating-open');

        // Clean up animation class when done
        const handleAnimationEnd = () => {
            widget.classList.remove('is-animating-open');
            widget.removeEventListener('animationend', handleAnimationEnd);
        };
        widget.addEventListener('animationend', handleAnimationEnd, { once: true });
    }

    widget.classList.remove('widget-minimized');
    widgetOpen = true;

    // Check for First-Run Overlay
    checkOnboarding();

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
        // 🎯 ADD THESE LINES AT THE END OF YOUR EXISTING openWidget() FUNCTION:
        setTimeout(() => {
            const currentProduct = detectCurrentProduct();
            if (currentProduct) {
                selectedClothing = currentProduct.id;
                const featuredContainer = document.getElementById('featuredItem');
                featuredContainer.classList.add('selected');

                // Don't show preview - auto-selected product is visible in featured section
                updateSelectedClothingPreview(null);

                updateTryOnButton();
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

    // Mobile animation handling
    if (isMobile) {
        // Remove any existing animation classes
        widget.classList.remove('is-animating-open', 'is-animating-close');

        // Add closing animation class
        widget.classList.add('is-animating-close');

        // Clean up animation class when done
        const handleAnimationEnd = () => {
            widget.classList.remove('is-animating-close');
            widget.removeEventListener('animationend', handleAnimationEnd);
        };
        widget.addEventListener('animationend', handleAnimationEnd, { once: true });
    }

    widget.classList.add('widget-minimized');
    widgetOpen = false;
    currentMode = 'tryon';

    // Apply minimized widget color (check if gradient was already set)
    const savedGradient = widget.getAttribute('data-minimized-gradient');
    if (savedGradient) {
        widget.style.background = savedGradient;
    } else {
        // Apply color if not already set
        applyMinimizedWidgetColor();
    }

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

    // Reset user data
    selectedClothing = null;
    userPhoto = null;
    userPhotoFileId = null;

    // Clear photo preview
    const preview = document.getElementById('photoPreview');
    if (preview) {
        preview.style.display = 'none';
    }

    // Reset upload area
    resetPhotoUploadArea();

    // Clear clothing selections
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
    const uploadArea = document.querySelector('.photo-upload');
    if (!uploadArea) return;

    uploadArea.classList.remove('has-photo', 'uploading');

    const uploadIcon = uploadArea.querySelector('.upload-icon');
    const uploadText = uploadArea.querySelector('.upload-text:not(#changePhotoText)');
    const changeText = document.getElementById('changePhotoText');
    const preview = document.getElementById('photoPreview');

    if (uploadIcon) uploadIcon.style.display = 'block';
    if (uploadText) {
        uploadText.style.display = 'block';
        // Reset text to default in case it was stuck on "Analyzing image quality..."
        uploadText.textContent = isMobile ? 'Tap to upload full body image' : 'Click to upload full body image';
    }
    if (changeText) changeText.style.display = 'none';
    if (preview) {
        preview.style.display = 'none';
        preview.src = ''; // Clear source to prevent ghosting
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

// Fetch custom curation from Supabase vto_stores table
async function fetchCustomCuration(storeSlug) {
    try {
        const url = `https://rwmvgwnebnsqcyhhurti.supabase.co/rest/v1/vto_stores?store_slug=eq.${storeSlug}&select=featured_item_id,quick_picks_ids`;
        const response = await fetch(url, {
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json',
            }
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
            console.log(`[Ello Debug] Hidden by ID: ${idStr}`);
            return true;
        }
    }

    // 2. Check Title
    if (product.name || product.title) {
        const name = (product.name || product.title).toLowerCase().trim();
        if (window.elloHiddenTitles && window.elloHiddenTitles.has(name)) {
            console.log(`[Ello Debug] Hidden by Title: ${name}`);
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
            console.log(`[Ello Debug] Hidden by Handle: ${cleanHandle}`);
            return true;
        }
    }

    return false;
}

// --- Model Catalogue Feature ---
const modelCatalogue = [
    { id: 'model_f1', name: 'Model 1', gender: 'female', image_url: 'https://ello-vto-public-13593516897.us-central1.run.app/assets/overlay/itemplaceholder.jpg' }, // Placeholder
    { id: 'model_m1', name: 'Model 2', gender: 'male', image_url: 'https://ello-vto-public-13593516897.us-central1.run.app/assets/overlay/userplaceholder.jpg' }, // Placeholder
];

let userPhotoSource = 'upload'; // 'upload' | 'model'

function initializeModelEvents() {
    const openBtn = document.getElementById('openModelBrowserBtn');
    const closeBtn = document.getElementById('closeModelBrowserBtn');
    const switchBtn = document.getElementById('switchToUploadBtn');

    if (openBtn) {
        openBtn.addEventListener('click', (e) => {
            e.preventDefault();
            openModelBrowser();
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            closeModelBrowser();
        });
    }

    if (switchBtn) {
        switchBtn.addEventListener('click', (e) => {
            e.preventDefault();
            closeModelBrowser();
            // Optional: trigger upload click if allowed
            // handlePhotoUploadClick();
        });
    }

    // Reset to 'upload' source when a real file is selected
    const fileInput = document.getElementById('imageUploadInput');
    if (fileInput) {
        fileInput.addEventListener('change', () => {
            console.log('[Model Catalogue] Real file selected, switching source to upload');
            userPhotoSource = 'upload';
            localStorage.setItem('ello_user_photo_source', 'upload');
            resetModelSelectionUI(); // Reset UI text
        });
    }

    // New Refined UI Listeners
    const dropzone = document.getElementById('photoUploadDropzone');
    if (dropzone) {
        dropzone.addEventListener('click', handlePhotoUploadClick);
    }

    const tipsBtn = document.getElementById('photoTipsBtn');
    if (tipsBtn) {
        tipsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showBestPracticesModal();
        });
    }
}

function openModelBrowser() {
    const modal = document.getElementById('modelBrowserModal');
    const backdrop = document.getElementById('modalBackdrop');
    if (!modal || !backdrop) return;

    // Populate grid if empty
    const grid = document.getElementById('modelBrowserGrid');
    if (grid && grid.children.length === 0) {
        renderModelGrid();
    }

    modal.classList.add('active');
    backdrop.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeModelBrowser() {
    const modal = document.getElementById('modelBrowserModal');
    const backdrop = document.getElementById('modalBackdrop');
    if (modal) modal.classList.remove('active');
    if (backdrop) backdrop.classList.remove('active');
    document.body.style.overflow = '';
}

function renderModelGrid() {
    const grid = document.getElementById('modelBrowserGrid');
    if (!grid) return;
    grid.innerHTML = '';

    modelCatalogue.forEach(model => {
        const card = document.createElement('div');
        card.className = 'browser-clothing-card'; // Reuse clothing card style
        card.onclick = () => selectModel(model);

        card.innerHTML = `
            <div class="clothing-card-image-container">
                <img src="${model.image_url}" alt="${model.name}" class="clothing-card-image" style="object-fit: cover;">
            </div>
            <div class="clothing-card-details">
                <div class="clothing-card-name" style="text-align:center;">${model.name}</div>
            </div>
        `;
        grid.appendChild(card);
    });
}

function selectModel(model) {
    userPhotoSource = 'model';
    console.log('[Model Catalogue] Selected:', model.id);

    // Set preview
    const preview = document.getElementById('photoPreview');
    const uploadEmpty = document.querySelector('.upload-empty'); // New UI element

    if (preview) {
        preview.src = model.image_url;
        preview.style.display = 'block';
    }

    // Hide the "Click to upload" empty state
    if (uploadEmpty) {
        uploadEmpty.style.display = 'none';
    }

    // Set global userPhoto so validation passes
    userPhoto = model.image_url;

    // Update the "Plan B" text area to show current selection
    const altContainer = document.getElementById('modelSelectContainer');
    if (altContainer) {
        altContainer.innerHTML = `
            <span style="color: #666;">Using: <strong>${model.name}</strong></span>
            <span style="margin: 0 4px;">•</span>
            <button type="button" class="link-btn" id="openModelBrowserBtn_Change">Change</button>
        `;
        // Re-attach listener to the new button
        const changeBtn = document.getElementById('openModelBrowserBtn_Change');
        if (changeBtn) {
            changeBtn.addEventListener('click', openModelBrowser);
        }
    }

    // Persist model selection
    localStorage.setItem('ello_user_photo_source', 'model');
    localStorage.setItem('ello_selected_model_id', model.id);

    closeModelBrowser();

    // Trigger "ready" state updates
    updateTryOnButtonState();

    // Show notification
    showNotification('Model selected', 'success');
}

// Helper to reset the model selection UI text
function resetModelSelectionUI() {
    const altContainer = document.getElementById('modelSelectContainer');
    const uploadEmpty = document.querySelector('.upload-empty');

    // Show upload prompt again if hidden
    if (uploadEmpty) {
        uploadEmpty.style.display = 'flex';
    }

    if (altContainer) {
        altContainer.innerHTML = `
            <span>Don’t have a photo?</span>
            <button type="button" class="link-btn" id="openModelBrowserBtn">Choose a model</button>
        `;
        // Re-attach original listener
        const openBtn = document.getElementById('openModelBrowserBtn');
        if (openBtn) {
            openBtn.addEventListener('click', (e) => {
                e.preventDefault();
                openModelBrowser();
            });
        }
    }
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
            console.log("🚫 Current Page Product is HIDDEN. Falling back to Featured/Trending.");
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
            // Use robust ID matching for quick picks
            quickPicks = customCuration.quickPicksIds
                .map(id => findClothingByRobustId(sampleClothing, id))
                .filter(item => item != null)
            // Normalize IDs to strings for comparison
            const featuredItemIdStr = String(featuredItem.id);
            const featuredItemShopifyIdStr = String(featuredItem.shopify_product_id || '');
            quickPicks = customCuration.quickPicksIds
                .filter(id => {
                    if (id == null) return false;
                    const idStr = String(id);
                    return idStr !== featuredItemIdStr && idStr !== featuredItemShopifyIdStr;
                })
                .map(id => {
                    const idStr = String(id);
                    return sampleClothing.find(item =>
                        String(item.shopify_product_id) === idStr || String(item.id) === idStr
                    );
                })
                .filter(item => item != null)
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

    // Auto-select the featured item ONLY if no item is currently selected
    // This prevents overwriting a user's selection from the "Browse Collection" modal
    if (currentFeaturedItem && !selectedClothing) {
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
        preview.style.display = 'block';
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

            // Show analyzing overlay (mobile and desktop)
            const analysisOverlay = document.getElementById('photoAnalysisOverlay');
            if (analysisOverlay) {
                analysisOverlay.style.display = 'flex';
            }

            // Show analyzing overlay for Preview Widget
            const previewOverlay = document.getElementById('previewAnalysisOverlay');
            if (previewOverlay) {
                previewOverlay.style.display = 'flex';
            }

            // Show analyzing state
            const uploadText = uploadArea?.querySelector('.upload-text:not(#changePhotoText)');
            if (uploadText) {
                const originalText = uploadText.textContent;
                uploadText.textContent = 'First upload may take a moment';
            }

            // Enhanced quality validation
            const qualityResult = await validateImageQuality(imageDataUrl);

            if (!qualityResult.isValid) {
                // Hide overlay
                if (analysisOverlay) {
                    analysisOverlay.style.display = 'none';
                }
                const previewOverlay = document.getElementById('previewAnalysisOverlay');
                if (previewOverlay) {
                    previewOverlay.style.display = 'none';
                }
                // Restore original text
                if (uploadText) {
                    uploadText.textContent = uploadArea.querySelector('.upload-icon') ? 'Tap to upload full body image' : 'Click to upload full body image';
                }
                showSuccessNotification('Image Quality Issue', qualityResult.error, 5000, true);
                if (uploadArea) {
                    uploadArea.classList.remove('uploading');
                }
                return;
            }

            // Show warnings if any (non-blocking)
            if (qualityResult.warnings && qualityResult.warnings.length > 0) {
                const warningMessage = qualityResult.warnings.join(' ');
                showSuccessNotification('Quality Tips', warningMessage, 4000, false);
            }

            // Image passed all checks
            userPhoto = imageDataUrl;
            window.elloUserImageUrl = imageDataUrl;
            userPhotoFileId = 'photo_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

            // Save photo to localStorage for persistence (async with compression)
            await savePhotoToStorage(imageDataUrl, userPhotoFileId);

            // Update UI
            updatePhotoPreview(e.target.result);
            updatePreviewUserPhoto(e.target.result); // Update preview if open
            if (uploadArea) uploadArea.classList.remove('uploading'); // Clear uploading state without resetting preview

            updateTryOnButton();

            // Haptic feedback on mobile
            if (isMobile && navigator.vibrate) {
                navigator.vibrate(50);
            }

            showSuccessNotification('Photo Uploaded', 'Your photo has been uploaded successfully!', 2000);

        } catch (error) {
            console.error('Error processing uploaded image:', error);
            showSuccessNotification('Upload Error', 'Failed to process the image. Please try again.', 4000);
        } finally {
            // Hide overlay
            const analysisOverlay = document.getElementById('photoAnalysisOverlay');
            if (analysisOverlay) {
                analysisOverlay.style.display = 'none';
            }
            const previewOverlay = document.getElementById('previewAnalysisOverlay');
            if (previewOverlay) {
                previewOverlay.style.display = 'none';
            }
            if (analysisOverlay) {
                analysisOverlay.style.display = 'none';
            }
            if (uploadArea) {
                uploadArea.classList.remove('uploading');
            }
        }
    };

    reader.onerror = function (error) {
        console.error('Error reading file:', error);
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
                            console.log('Image load error in face detection');
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
        console.log('Face detection error:', error);
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
        console.log('TensorFlow ready check failed in loadMoveNetModel:', error);
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
                    console.log('Pose-detection library failed to load');
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
            console.log('✅ MoveNet detector loaded successfully via pose-detection library');
            return movenetModel;
        } else {
            console.log('⚠️ pose-detection library not available after loading');
            return null;
        }
    } catch (error) {
        console.log('MoveNet loading failed:', error);
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
            console.log('TensorFlow ready check failed in detectBodyInImage:', error);
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
            console.log('Available keypoints:', keypoints.map(kp => ({ name: kp.name, score: kp.score })));

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

            console.log('Body detection details (pose-detection):', {
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
            console.log('Error getting array from predictions:', e);
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
                console.log('Output is not an array, type:', typeof keypointsArray);
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
                console.log('Failed to extract keypoints from MoveNet output');
                return { detected: false, warning: null };
            }
        } catch (e) {
            console.log('Error extracting keypoints structure:', e);
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
                console.log(`Error extracting keypoint ${i}:`, e, keypoints[i]);
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

        console.log('Body detection details:', {
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
        console.log('Body detection error:', error);
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
async function validateImageQuality(imageSrc) {
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

    // Check brightness (Relaxed)
    if (analysis.brightness < 0.05) {
        // Only block if extremely dark
        errors.push('Image is too dark. Please use a photo with better lighting.');
    } else if (analysis.brightness < 0.15 || analysis.brightness > 0.95) {
        // Warn for other cases
        warnings.push('Lighting could be improved for best results.');
    }

    // Check contrast
    if (analysis.contrast < 0.05) {
        errors.push('Image has insufficient contrast. Please use a clearer, more defined photo.');
    } else if (analysis.contrast < 0.1) {
        warnings.push('Image contrast is low. Better contrast will improve try-on results.');
    }

    // Optional face detection (non-blocking, warning only)
    const faceResult = await detectFaceInImage(imageSrc);
    if (faceResult.warning && !faceResult.detected) {
        warnings.push(faceResult.warning);
    }

    // Body detection with three-tier system: reject, warning, or success
    const bodyResult = await detectBodyInImage(imageSrc);

    // Handle body detection states (only act if state is not null - null means silent fail)
    if (bodyResult && bodyResult.state) {
        if (bodyResult.state === 'reject') {
            // REJECT: Block upload - no body detected
            errors.push(bodyResult.message || 'No body detected in photo. Please upload a full-body photo with you standing clearly visible.');
        } else if (bodyResult.state === 'warning') {
            // WARNING: Show notification but allow upload - partial body detected
            warnings.push(bodyResult.message || 'Partial body detected. For best try-on results, use a full-body photo with both your shoulders and hips clearly visible.');
        }
        // SUCCESS: No action needed - full body detected, allow silently
    }
    // If state is null, silent fail - don't block or warn (graceful degradation)

    return {
        isValid: errors.length === 0,
        error: errors.length > 0 ? errors.join(' ') : null,
        warnings: warnings,
        analysis: analysis
    };
}

function updatePhotoPreview(imageData) {
    const preview = document.getElementById('photoPreview');
    const uploadArea = document.querySelector('.photo-upload');
    const changeText = document.getElementById('changePhotoText');
    const uploadIcon = uploadArea?.querySelector('.upload-icon');
    const uploadText = uploadArea?.querySelector('.upload-text:not(#changePhotoText)');

    // Hide analyzing overlay when photo preview is updated
    const analysisOverlay = document.getElementById('photoAnalysisOverlay');
    if (analysisOverlay) {
        analysisOverlay.style.display = 'none';
    }
    const previewOverlay = document.getElementById('previewAnalysisOverlay');
    if (previewOverlay) {
        previewOverlay.style.display = 'none';
    }

    if (preview) {
        preview.src = imageData;
        preview.style.display = 'block';
        preview.style.opacity = '1';
    }

    if (uploadArea) {
        // Hide the upload elements
        if (uploadIcon) uploadIcon.style.display = 'none';
        if (uploadText) {
            uploadText.style.display = 'none';
            // Force hide parent container if necessary
            uploadText.parentElement.classList.add('has-photo');
        }

        uploadArea.classList.add('has-photo');
        uploadArea.style.display = 'block';

        // FORCE REFLOW: Sometimes browser doesn't update display:none -> block immediately for images
        // Reading offsetHeight forces a layout calculation
        void preview.offsetHeight;
    }

    if (changeText) {
        changeText.style.display = 'block';
        changeText.textContent = isMobile ? 'Tap to change photo' : 'Click to change photo';
    }
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

    console.log('Opening clothing browser, sampleClothing length:', sampleClothing.length);
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

    console.log('renderBrowserGrid called, sampleClothing length:', sampleClothing.length);
    console.log('Grid element found:', !!grid);

    if (!grid) {
        console.error('Browser grid element not found!');
        return;
    }

    // Check if clothing data is loaded
    if (!sampleClothing || sampleClothing.length === 0) {
        console.log('No clothing data available, loading...');
        grid.innerHTML = '<div style="text-align: center; padding: 40px; color: #666;">Loading products...</div>';
        loadClothingData().then(() => {
            console.log('Data loaded, re-rendering grid...');
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
    populateFeaturedAndQuickPicks();
    updateTryOnButton();
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
            const imgHtml = `<img src="${item.image_url}" alt="${safeName}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22300%22 height=%22400%22 viewBox=%220 0 300 400%22%3E%3Crect width=%22300%22 height=%22400%22 fill=%22%23f0f0f0%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 fill=%22%23999%22 font-family=%22Arial%22 font-size=%2214%22%3ENo Image%3C/text%3E%3C/svg%3E'">`;

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

    const payload = {
        personImageUrl,
        productImageUrl,
        modelName: "tryon-v1.6",
        storeSlug,
        productId: productId || null,
        variantId: variantId || null,
        sessionId: sessionId || null,
    };


    const res = await fetch(
        "https://ello-vto-13593516897.us-central1.run.app/tryon",
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

// Loading bar control functions
let loadingBarInterval = null;
let loadingBarProgress = 0;

function showLoadingBar(show) {
    const container = document.getElementById("tryOnLoadingBar");
    const fill = document.getElementById("tryOnLoadingBarFill");

    if (!container || !fill) {
        return;
    }

    if (show) {
        container.style.display = "block";
        // FORCE visibility against themes
        container.style.setProperty('display', 'block', 'important');

        loadingBarProgress = 0;
        fill.style.width = "0%";

        console.log("🚀 Starting Loading Bar Animation...");

        // Start animated progress
        let startTime = Date.now();
        const estimatedDuration = 15000; // 15 seconds estimated

        loadingBarInterval = setInterval(() => {
            const elapsed = Date.now() - startTime;
            // Use easing function to make it feel natural
            // Progress quickly to 80%, then slow down
            if (elapsed < estimatedDuration) {
                const progress = Math.min(elapsed / estimatedDuration, 0.95);
                // Ease out cubic for smooth deceleration
                const eased = 1 - Math.pow(1 - progress, 3);
                loadingBarProgress = Math.min(eased * 90, 90); // Cap at 90% until done
                fill.style.setProperty('width', loadingBarProgress + "%", 'important');
            }
        }, 50); // Update every 50ms for smooth animation
    } else {
        // Complete the bar to 100% quickly, then hide
        if (loadingBarInterval) {
            clearInterval(loadingBarInterval);
            loadingBarInterval = null;
        }

        // Animate to 100%
        fill.style.setProperty('width', "100%", 'important');

        // Hide after a brief moment
        setTimeout(() => {
            if (container) {
                container.style.display = "none";
            }
            loadingBarProgress = 0;
        }, 300);
    }
}

function completeLoadingBar() {
    const fill = document.getElementById("tryOnLoadingBarFill");
    if (fill && loadingBarInterval) {
        clearInterval(loadingBarInterval);
        loadingBarInterval = null;
        fill.style.width = "100%";
    }
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
window.startTryOn = async function startTryOn() {
    // Prevent duplicate calls if already processing (check and set atomically)
    if (isTryOnProcessing) {
        return;
    }
    // Set flag immediately to prevent race conditions from rapid clicks
    isTryOnProcessing = true;

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
    const garment = window.elloSelectedGarment;
    const productImageUrl = garment?.image_url;

    if (!personImageUrl) {
        // Trigger upload prompt instead of error
        isTryOnProcessing = false;
        updateTryOnButton();
        showLoadingBar(false);
        const uploadInput = document.getElementById('photoInput');
        if (uploadInput) {
            uploadInput.click();
        } else {
            showError("Please upload a photo first.");
        }
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

        // Complete and hide loading bar
        completeLoadingBar();
        showLoadingBar(false);

        // Hide loader (not needed since we use the premium loading bar)
        showLoader(false);

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

        // Create and add "Add to Cart" button after result image
        if (garment && resultPanel) {
            // Remove existing buy button if it exists
            const existingBuyBtn = resultPanel.querySelector('.buy-now-container');
            if (existingBuyBtn) {
                existingBuyBtn.remove();
            }

            // Create buy button container
            const buyContainer = document.createElement('div');
            buyContainer.className = 'buy-now-container';

            const buyButton = document.createElement('button');
            buyButton.className = 'buy-now-btn';
            buyButton.innerHTML = `
                <span class="btn-text">Add to Cart</span>
                <div class="loading-spinner" style="display: none;">
                    <span></span><span></span><span></span><span></span>
                </div>
            `;

            // Generate tryOnId for tracking
            const tryOnId = 'tryon_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            const tryonResultUrl = imageB64;

            // Add click handler
            buyButton.onclick = function (event) {
                event.preventDefault();
                handleBuyNow(garment.id, tryonResultUrl, tryOnId, buyButton);
            };

            buyContainer.appendChild(buyButton);
            resultPanel.appendChild(buyContainer);
        }

        // Auto-save to wardrobe after successful try-on
        if (garment && imageB64) {
            const tryOnId = 'tryon_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            // Call async function properly
            autoSaveToWardrobe(garment, imageB64, tryOnId).catch(err => {
                console.error('Error auto-saving to wardrobe:', err);
            });
        }

        if (typeof openTryOnResult === "function") {
            openTryOnResult();
        }

    } catch (err) {
        console.error("Ello: try-on failed", err);

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
    console.log('Retrying try-on request...');
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
        console.log('showSizeSelector called with:', clothing);

        // Get unique sizes from variants - try multiple methods
        const availableSizes = [];

        clothing.variants.forEach(variant => {
            console.log('Processing variant:', variant);

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

            console.log('Extracted size value:', sizeValue);

            if (sizeValue && variant.available && !availableSizes.some(s => s.size === sizeValue)) {
                availableSizes.push({
                    size: sizeValue,
                    variantId: variant.id,
                    price: variant.price
                });
            }
        });

        console.log('Available sizes found:', availableSizes);

        // If no sizes found, just use first available variant
        if (availableSizes.length === 0) {
            console.log('No sizes detected, using first available variant');
            const firstAvailable = clothing.variants.find(v => v.available) || clothing.variants[0];
            if (firstAvailable) {
                resolve(firstAvailable.id);
                return;
            }
        }

        // If only one size, use it directly
        if (availableSizes.length === 1) {
            console.log('Only one size available, using directly');
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

        console.log('Updated cart data:', cartData);

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

        console.log('✅ Cart display updated successfully');

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

    console.log('handleBuyNow called for:', clothing);

    if (!clothing) {
        alert('Item not found. Please try again.');
        return;
    }

    // LAZY LOAD VARIANTS if missing
    if (!clothing.variants || clothing.variants.length === 0) {
        if (clothing.handle) {
            console.log(`[Ello] Variants missing for ${clothing.handle} in BuyNow, lazy loading...`);
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

        // Handle different data sources
        // Handle different data sources
        // Default to Shopify if we have variants and a handle, even if data_source is missing
        if (clothing.data_source === 'shopify' || (!clothing.data_source && clothing.handle && clothing.variants)) {
            await handleShopifyPurchase(clothing, variantToAdd, tryonResultUrl, tryOnId);
        } else if (clothing.data_source === 'supabase') {
            await handleSupabasePurchase(clothing, variantToAdd, tryonResultUrl, tryOnId);
        } else {
            // Fallback for demo data or unknown sources
            await handleDemoPurchase(clothing, variantToAdd, tryonResultUrl, tryOnId);
        }

    } catch (error) {
        console.error('❌ Purchase error:', error);
        alert('❌ Purchase error: ' + error.message);
    } finally {
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
            console.log('✅ Successfully added to Shopify cart:', cartResult);

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

        } else {
            const errorText = await cartResponse.text();
            console.error('❌ Shopify cart error:', errorText);
            alert(`❌ Failed to add to cart. Error: ${cartResponse.status}`);
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

        // Send analytics tracking
        await sendAnalyticsTracking('supabase_purchase_intent', clothing, variantToAdd, tryonResultUrl, tryOnId);

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

    } catch (error) {
        console.error('❌ Demo purchase error:', error);
        throw error;
    }
}

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
                console.log('✅ Analytics tracked successfully');
            } else {
                console.log('⚠️ Analytics tracking failed, but purchase succeeded');
            }
        }).catch(error => {
            console.log('⚠️ Analytics tracking error:', error);
        });

    } catch (webhookError) {
        console.log('⚠️ Webhook tracking failed:', webhookError);
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
        let lastTouchEnd = 0;
        document.addEventListener('touchend', function (event) {
            const now = (new Date()).getTime();
            if (now - lastTouchEnd <= 300) {
                event.preventDefault();
            }
            lastTouchEnd = now;
        }, false);
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
        console.log('ℹ️ No minimized color found in store config. storeConfig:', storeConfig);
        if (!storeConfig) {
            console.log('⚠️ Store config not loaded yet. Color will use default.');
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
            console.log('ℹ️ Widget not minimized yet, gradient will apply when minimized');
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
// WARDROBE FUNCTIONALITY
// ============================================================================

// Wardrobe storage key
const WARDROBE_STORAGE_KEY = 'virtual_tryon_wardrobe';

// Get wardrobe count for display
function getWardrobeCount() {
    const wardrobe = getWardrobe();
    return wardrobe.length;
}

// Get wardrobe from sessionStorage
function getWardrobe() {
    try {
        const stored = sessionStorage.getItem(WARDROBE_STORAGE_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch (error) {
        console.error('Error reading wardrobe from sessionStorage:', error);
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
                            console.log('✅ Further compressed result image:', Math.round(cleaned.resultImageUrl.length / 1024) + 'KB');
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
                            sessionStorage.setItem(WARDROBE_STORAGE_KEY, JSON.stringify(trimmed));
                            console.log('✅ Saved wardrobe (trimmed to', trimmed.length, 'items)');
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
                            sessionStorage.setItem(WARDROBE_STORAGE_KEY, wardrobeString);
                            console.log('✅ Saved wardrobe (' + limitedWardrobe.length + ' items, ' + Math.round(wardrobeString.length / 1024) + 'KB)');
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
                                sessionStorage.setItem(WARDROBE_STORAGE_KEY, JSON.stringify(ultraCleaned));
                                console.log('✅ Saved wardrobe after cleanup (5 items, heavily compressed)');
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
            console.log('✅ Compressed result image for wardrobe:', Math.round(compressedResultImage.length / 1024) + 'KB');
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
            console.log('✅ Compressed original photo for outfit building:', Math.round(compressedOriginalPhoto.length / 1024) + 'KB');
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

    console.log('✅ Added to wardrobe:', clothing.name);
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

        console.log('✅ Added original photo to wardrobe (reference only)');
    }
}

// Remove item from wardrobe
async function removeFromWardrobe(tryOnId) {
    const wardrobe = getWardrobe();
    const filteredWardrobe = wardrobe.filter(item => item.id !== tryOnId);
    await saveWardrobe(filteredWardrobe);
    updateWardrobeButton();

    console.log('🗑️ Removed from wardrobe:', tryOnId);
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
        console.log('✅ Updated window.elloUserImageUrl to use try-on result (base64)');
    } else if (item.originalPhotoUrl && item.originalPhotoUrl.startsWith('data:image')) {
        // Fallback: if result not available, use original photo (first item in outfit)
        userPhoto = item.originalPhotoUrl;
        window.elloUserImageUrl = item.originalPhotoUrl;
        console.log('⚠️ Result image not available, using original photo as fallback');
    } else {
        console.warn('⚠️ No valid image found in wardrobe item, cannot add to outfit');
        showError('Unable to add to outfit: image not available. Please try again.');
        return;
    }

    userPhotoFileId = 'outfit_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

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

    console.log('✅ Selected wardrobe item:', clothing.name);
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
            console.log(`[Ello] Variants missing for ${clothing.handle}, lazy loading...`);
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
            console.log('✅ Successfully added wardrobe item to cart:', cartResult);

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
                        console.log('✅ Wardrobe analytics tracked successfully');
                    } else {
                        console.log('⚠️ Wardrobe analytics tracking failed, but cart add succeeded');
                    }
                }).catch(error => {
                    console.log('⚠️ Wardrobe analytics tracking error:', error);
                });

            } catch (webhookError) {
                console.log('⚠️ Wardrobe webhook tracking failed:', webhookError);
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

        // Fire and forget - use sendBeacon if possible, or fetch with keepalive
        let baseUrl = "https://ello-vto-13593516897.us-central1.run.app";
        // Check if we are running locally for development
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            baseUrl = "http://localhost:8000";
        }
        const url = `${baseUrl}/track-preview-event`;

        // Use fetch with keepalive for reliability on page unload
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            keepalive: true
        }).catch((e) => {
            console.warn('[Ello] Analytics error:', e);
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
    console.log('[Ello VTO] Initializing Preview Triggers...');
    // 0. Kill Switch (Dashboard Config)
    const config = window.ELLO_STORE_CONFIG || {};
    if (config.desktopPreviewEnabled === false) {
        console.log('[Ello VTO] Preview disabled by kill-switch.');
        return;
    }

    // 1. Desktop & Pointer Gate
    const isFinePointer = window.matchMedia('(pointer: fine)').matches;
    // Relaxed width check for testing/laptops.
    if ((isMobile || window.innerWidth < 768 || !isFinePointer) && !window.forceShowPreview) {
        console.log('[Ello VTO] Preview disabled by device check:', { isMobile, width: window.innerWidth, isFinePointer });
        return;
    }

    console.log('[Ello VTO] Preview Triggers Active.');

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

    // Define activity flag variable locally if not global, or ensure it is accessible.
    // In this scope, we need to make sure the listener callback can reach it.
    let hasUserActivity = false;

    console.log(`[Ello VTO] Starting Preview Timer (${delaySeconds}s delay)...`);

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
        console.log('[Ello VTO] Timer finished. Checking activity...');
        attemptShowPreview();
    }, delaySeconds * 1000);
}

function attemptShowPreview() {
    // If user has already interacted, show immediately.
    if (hasUserActivity) {
        checkPreviewEligibilityAndShow();
    } else {
        // If not yet active, wait for the FIRST interaction, then show (almost) immediately.
        console.log('[Ello VTO] User not active yet. Waiting for interaction...');
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

// Old idle watcher is deprecated by this simpler logic
function stopIdleWatcher() {
    if (previewDelayTimer) {
        clearTimeout(previewDelayTimer);
        previewDelayTimer = null;
    }
}


async function checkPreviewEligibilityAndShow() {
    const storeId = window.ELLO_STORE_ID || 'default_store';
    console.log('[Ello VTO] Checking preview eligibility...');

    // Check Global Toggle
    if (window.ELLO_STORE_CONFIG && window.ELLO_STORE_CONFIG.desktopPreviewEnabled === false) {
        console.log('[Ello VTO] Preview blocked: Disabled in configuration.');
        return;
    }

    // Check if main widget is already open
    if (widgetOpen) {
        console.log('[Ello VTO] Preview blocked: Main widget is already open.');
        return;
    }

    // Re-check simple conditions
    try {
        /*
        if (sessionStorage.getItem(`ello_${storeId}_preview_shown_session`) === 'true') {
             console.log('[Ello VTO] Preview blocked: Already shown this session.');
             return;
        }
        */
        if (localStorage.getItem(`ello_${storeId}_preview_dismissed`) === 'true') {
            console.log('[Ello VTO] Preview blocked: Permanently dismissed.');
            return;
        }
    } catch (e) { }

    // Relaxed width check for testing
    const isFinePointer = window.matchMedia('(pointer: fine)').matches;
    if ((isMobile || window.innerWidth < 768 || !isFinePointer) && !window.forceShowPreview) {
        console.log('[Ello VTO] Preview blocked: Device check failed', { width: window.innerWidth, isMobile, isFinePointer });
        return;
    }

    // Must be on a product page
    const currentProduct = detectCurrentProduct();

    // 4. Check Blacklist (Hidden Products)
    if (window.elloHiddenProductIds || window.elloHiddenTitles || window.elloHiddenHandles) {
        let isHidden = false;

        // Debug Blacklist State
        console.log(`[Ello Debug] Blacklist Sizes - IDs: ${window.elloHiddenProductIds?.size}, Titles: ${window.elloHiddenTitles?.size}, Handles: ${window.elloHiddenHandles?.size}`);

        if (currentProduct) {
            // A. Check ID
            const currentId = getProductId(currentProduct);
            if (currentId && window.elloHiddenProductIds && window.elloHiddenProductIds.has(currentId)) {
                console.log(`[Ello Debug] MATCHED ID: ${currentId}`);
                isHidden = true;
            }

            // B. Check Title
            const currentTitle = (currentProduct.name || currentProduct.title || '').toLowerCase().trim();
            console.log(`[Ello Debug] Checking Title: "${currentTitle}" against blacklist.`);
            if (window.elloHiddenTitles && window.elloHiddenTitles.has(currentTitle)) {
                console.log(`[Ello Debug] MATCHED TITLE: ${currentTitle}`);
                isHidden = true;
            }

            // C. Check Handle
            let currentHandle = null;
            if (currentProduct.handle) {
                currentHandle = currentProduct.handle.toLowerCase();
            } else {
                // Extract from URL if possible
                const url = window.location.pathname;
                if (url && url.includes('/products/')) {
                    currentHandle = url.split('/products/')[1].split('?')[0].split('/')[0];
                }
            }

            if (currentHandle && window.elloHiddenHandles) {
                console.log(`[Ello Debug] Checking Handle: "${currentHandle}"`);
                if (window.elloHiddenHandles.has(currentHandle)) {
                    console.log(`[Ello Debug] MATCHED HANDLE: ${currentHandle}`);
                    isHidden = true;
                }
            }

        }

        if (isHidden) {
            console.log("🚫 [Ello VTO] Preview blocked: Product is hidden in dashboard.");
            return;
        }
    }

    if (!currentProduct) {
        console.log('[Ello VTO] Preview blocked: No product detected on this page.');
        return;
    }

    /* 
    // New Filtering Logic REMOVED: 
    // Delegating control to the Dashboard (vto_stores -> clothing_items).
    // If an item is active/enabled in the dashboard, it will appear in sampleClothing.
    // If it is in sampleClothing, we should allow the preview.
    // This allows merchants to manually enable "edge cases" like hats/shoes.
    /*
    if (!isClothingItem(currentProduct)) {
        console.log('[Ello VTO] Preview blocked: Product is not identified as clothing.', currentProduct.name);
        return;
    }
    */

    console.log('[Ello VTO] Eligibility Passed! Showing preview for:', currentProduct.title || currentProduct.name);
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
        trackPreviewEvent('preview_shown', { productId: product.id });
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

    // Trigger the existing file input
    const photoInput = document.getElementById('photoInput');
    if (photoInput) {
        // Stop propagation to prevent bubbling up to the minimized widget container (which would open it)
        const stopProp = (e) => e.stopPropagation();
        photoInput.addEventListener('click', stopProp, { once: true });
        photoInput.click();
    }
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
        }
    }
}

// Helper to reset UI state
function resetPreviewUI() {
    const overlay = document.getElementById('previewProgressOverlay');
    const bar = document.getElementById('previewProgressBar');
    const btn = document.getElementById('previewTryBtn');

    if (overlay) overlay.style.display = 'none';
    if (bar) bar.style.width = '0%';
    if (btn) {
        btn.textContent = 'Try On';
        btn.disabled = false;
        btn.style.cursor = 'pointer';
    }
}

window.handlePreviewTryOn = async function () {
    // Prevent duplicate clicks immediately
    if (isTryOnProcessing || window._previewTryOnProcessing) {
        return;
    }
    window._previewTryOnProcessing = true; // Local lock for preview specifically

    previewEngaged = true; // Mark as engaged
    trackPreviewEvent('tryon_clicked');

    const overlay = document.getElementById('previewProgressOverlay');
    const bar = document.getElementById('previewProgressBar');
    const btn = document.getElementById('previewTryBtn');

    // 1. Show Progress GUI
    if (overlay) {
        overlay.style.display = 'flex';
        overlay.style.setProperty('display', 'flex', 'important'); // FORCE visibility
        overlay.style.setProperty('z-index', '2147483647', 'important'); // FORCE TOP
        // Force reflow
        void overlay.offsetWidth;
    }

    // 2. Start Request in Background
    // We catch errors here so we don't break the progress bar flow immediately
    const tryOnPromise = startTryOn().catch(e => {
        console.error("Preview generation failed:", e);
        window._previewTryOnProcessing = false; // Release lock on error
        return false;
    });

    // 3. Animate Progress Bar (Simulate ~8-12s generation)
    // We'll advance it to 90% and hold until the real process finishes
    let progress = 0;
    const totalDuration = 9000; // 9 seconds target
    const intervalTime = 100;
    const step = 90 / (totalDuration / intervalTime); // increment per step

    const progressInterval = setInterval(() => {
        progress += step;
        if (progress > 90) progress = 90; // Cap at 90% until done

        if (bar) {
            bar.style.width = `${progress}%`;
            bar.style.setProperty('width', `${progress}%`, 'important'); // LOCK IT IN
        }

        // Check if real process finished early (rare) or failed
        if (!isTryOnProcessing && progress > 20) {
            // Process finished (success or fail), jump to end
            clearInterval(progressInterval);
            finishPreviewTransition();
        }
    }, intervalTime);

    // 4. Wait for real completion or max timeout
    // We'll rely on the interval checking `isTryOnProcessing`, but we also need a safety net
    // If startTryOn returns (it's async), it means the *request* was sent, but not necessarily finished.
    // The `isTryOnProcessing` flag is our truth.

    function finishPreviewTransition() {
        if (bar) {
            bar.style.width = '100%';
            bar.style.setProperty('width', '100%', 'important');
        }

        // Small delay to show 100%
        setTimeout(() => {
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

    // Check if user has already onboarded
    const onboardingComplete = localStorage.getItem('ello_onboarding_complete') === 'true';

    // If NOT complete, show overlay
    if (!onboardingComplete) {
        // Make sure it's visible
        overlay.style.display = 'flex';
        // Small delay to allow display:flex to apply before adding active class for opacity transition
        setTimeout(() => {
            overlay.classList.add('active');
        }, 10);

        // Bind events if not already bound (checking a flag or removing/adding to be safe)
        const demoBtn = document.getElementById('froDemoBtn');
        const realBtn = document.getElementById('froRealBtn');

        // Remove old listeners to prevent duplicates (using cloneNode trick or just fresh listeners if simple)
        if (demoBtn) demoBtn.onclick = startDemoFlow;
        if (realBtn) realBtn.onclick = useMyPhotoFlow;
    } else {
        // Ensure it's hidden if complete
        overlay.style.display = 'none';
        overlay.classList.remove('active');
    }
}

function useMyPhotoFlow() {
    // 1. Mark complete
    completeOnboarding();

    // 2. Hide overlay
    dismissOverlay();

    // 3. Highlight inputs (Spotlight effect)
    setTimeout(() => {
        highlightInputs();
    }, 500);
}

function startDemoFlow() {
    // 1. Mark complete
    completeOnboarding();

    // 2. Hide overlay
    dismissOverlay();

    // 3. Simulate "Generating..." state
    showProcessingState();

    // 4. Auto-populate inputs with placeholders (simulated)
    // We don't actually upload files, we just assume the 'demo' state.

    // 5. After delay, show result
    setTimeout(() => {
        // Show a fake result or just the standard 'result ready' state if we had a real result.
        // Since we don't have real assets yet, we will rely on the verify plan's "placeholders".
        // For now, let's trigger the 'rendering' UI and then show a placeholder result.

        // Use a placeholder image from a public source or generated asset
        const demoResultUrl = 'https://placehold.co/600x800/png?text=Demo+Result'; // Temporary

        showSuccessNotification('Demo Complete', 'Here is how it works!');

        // In a real scenario, we would populate the 'generatedImage' and show the result modal.
        // For now, let's just show a notification to prove the flow worked.

    }, 2500);
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

function completeOnboarding() {
    localStorage.setItem('ello_onboarding_complete', 'true');
}

function highlightInputs() {
    const dropZone = document.getElementById('imageUploadDropZone');
    const featured = document.getElementById('featuredItem');

    if (dropZone) dropZone.classList.add('highlight-pulse');
    if (featured) featured.classList.add('highlight-pulse');

    // Remove pulse after animation
    setTimeout(() => {
        if (dropZone) dropZone.classList.remove('highlight-pulse');
        if (featured) featured.classList.remove('highlight-pulse');
    }, 2000);
}

function showProcessingState() {
    // Trigger the existing loading state logic if possible, or visually simulate it
    const button = document.getElementById('tryOnBtn');
    if (button) {
        const originalText = button.innerHTML;
        button.innerHTML = '<span class="spinner"></span> Generating...';
        button.disabled = true;

        setTimeout(() => {
            button.innerHTML = originalText;
            button.disabled = false;
        }, 2500);
    }
}
