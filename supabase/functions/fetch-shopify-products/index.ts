import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ShopifyProduct {
  id: string;
  title: string;
  handle: string;
  productType: string;
  tags: string[];
  images: {
    edges: Array<{
      node: {
        url: string;
      };
    }>;
  };
  variants: {
    edges: Array<{
      node: {
        id: string;
        price: {
          amount: string;
        };
        availableForSale: boolean;
      };
    }>;
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Use service role key for accessing shopify_storefront_tokens
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { storeId } = await req.json();

    if (!storeId) {
      throw new Error('Store ID is required');
    }

    // Get store configuration from vto_stores table
    const { data: storeData, error: storeError } = await supabaseClient
      .from('vto_stores')
      .select('shop_domain, storefront_token, store_slug')
      .eq('store_slug', storeId)
      .single();

    if (storeError || !storeData) {
      console.error('Store fetch error:', storeError);
      throw new Error('Failed to fetch store data');
    }

    const { shop_domain, store_slug } = storeData as { 
      shop_domain: string | null; 
      storefront_token: string | null;
      store_slug: string;
    };

    if (!shop_domain) {
      throw new Error('Shop domain must be configured');
    }

    // Get storefront token - check shopify_storefront_tokens first (OAuth flow), then fallback to vto_stores
    let storefrontToken = null;

    // Primary: Check shopify_storefront_tokens (managed by Shopify App OAuth)
    const { data: tokenData } = await supabaseClient
      .from('shopify_storefront_tokens')
      .select('storefront_access_token')
      .eq('shop', shop_domain)
      .maybeSingle();

    if (tokenData?.storefront_access_token) {
      storefrontToken = tokenData.storefront_access_token;
      console.log(`Using OAuth token for ${shop_domain}`);
      
      // Sync token to vto_stores for consistency
      if (storeData.storefront_token !== storefrontToken) {
        await supabaseClient
          .from('vto_stores')
          .update({ storefront_token: storefrontToken })
          .eq('store_slug', storeId);
      }
    } else if (storeData.storefront_token) {
      // Fallback: Use token from vto_stores (legacy manual entry)
      storefrontToken = storeData.storefront_token;
      console.log(`Using legacy token for ${shop_domain}`);
    }

    if (!storefrontToken) {
      throw new Error('No Shopify storefront token available. Please install the Ello Shopify App.');
    }

    console.log(`Fetching products for store: ${storeId}, domain: ${shop_domain}`);

    // Fetch active status overrides from clothing_items table
    const { data: storedItems, error: storedItemsError } = await supabaseClient
      .from('clothing_items')
      .select('item_id, active, image_override_url')
      .eq('store_id', store_slug)
      .eq('data_source', 'shopify');

    if (storedItemsError) {
      console.error('Error fetching stored items:', storedItemsError);
    }

    // Create maps of per-product overrides (supporting both GID and numeric formats).
    // activeOverrides: existing on/off toggle. imageOverrides: NEW merchant-selected
    // try-on image. Both are keyed by every id form the product might appear as.
    const activeOverrides = new Map<string, boolean>();
    const imageOverrides = new Map<string, string>();
    if (storedItems) {
      storedItems.forEach(
        (item: { item_id: string; active: boolean | null; image_override_url: string | null }) => {
          // All id forms this product could be matched on.
          const keys: string[] = [item.item_id];
          if (item.item_id.startsWith('gid://')) {
            const numericId = item.item_id.split('/').pop();
            if (numericId) keys.push(numericId);
          } else {
            keys.push(`gid://shopify/Product/${item.item_id}`);
          }

          if (item.active !== null) {
            keys.forEach((k) => activeOverrides.set(k, item.active as boolean));
          }
          if (item.image_override_url) {
            keys.forEach((k) => imageOverrides.set(k, item.image_override_url as string));
          }
        },
      );
    }

    console.log(
      `Found ${activeOverrides.size} active overrides, ${imageOverrides.size} image overrides`,
    );

    const query = `
      query GetProducts {
        products(first: 250) {
          edges {
            node {
              id
              title
              handle
              productType
              tags
              images(first: 20) {
                edges {
                  node {
                    url
                  }
                }
              }
              variants(first: 1) {
                edges {
                  node {
                    id
                    price {
                      amount
                    }
                    availableForSale
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(`https://${shop_domain}/api/2025-01/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': storefrontToken,
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      throw new Error(`Shopify API error: ${response.status}`);
    }

    const result = await response.json();

    if (result.errors) {
      throw new Error(`GraphQL error: ${JSON.stringify(result.errors)}`);
    }

    const products = result.data.products.edges.map((edge: any) => {
      const product: ShopifyProduct = edge.node;
      const itemId = product.id; // Keep full GID: gid://shopify/Product/123456
      // All product images (deduped, order preserved) for the dashboard picker.
      const images = Array.from(
        new Set(product.images.edges.map((e) => e.node?.url).filter(Boolean) as string[]),
      );
      // images[0] is the featured image — unchanged default behavior.
      const imageUrl = images[0] || null;
      // Merchant-selected try-on image, if they've chosen one (null = use featured).
      const imageOverrideUrl = imageOverrides.get(itemId) || null;
      const firstVariant = product.variants.edges[0]?.node;
      const price = firstVariant ? parseFloat(firstVariant.price.amount) : 0;
      const productUrl = `https://${shop_domain}/products/${product.handle}`;
      
      // Check if we have an override for this product's active status
      // If override exists, use it; otherwise use Shopify's availableForSale
      const shopifyActive = product.variants.edges.some((v: any) => v.node.availableForSale);
      const hasOverride = activeOverrides.has(itemId);
      const active = hasOverride ? activeOverrides.get(itemId) : shopifyActive;

      return {
        item_id: itemId,
        name: product.title,
        category: product.productType?.toLowerCase() || 'uncategorized',
        price,
        image_url: imageUrl, // featured image (default) — unchanged
        images, // NEW: all product images, for the try-on image picker
        image_override_url: imageOverrideUrl, // NEW: current selection (null = featured)
        product_url: productUrl,
        tags: product.tags,
        active: active,
      };
    });

    console.log(`Fetched ${products.length} products`);

    return new Response(
      JSON.stringify({
        success: true,
        products,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error fetching Shopify products:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
