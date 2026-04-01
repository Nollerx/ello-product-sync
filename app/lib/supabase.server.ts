import { createClient } from "@supabase/supabase-js";

// Safe init - avoid crashing module import when env is missing.
const SUPABASE_URL = process.env.SUPABASE_URL || "https://placeholder.invalid";
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder-service-role-key";
const HAS_REAL_SUPABASE_URL = Boolean(process.env.SUPABASE_URL);

// Server-only client (service role bypasses RLS)
export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  db: { schema: 'public' } // Default to public, but we can override in queries
});

/**
 * Robust token retrieval: Checks `shopify_app.storefront_tokens` first, then falls back to `vto_stores`.
 */
export async function getStoredStorefrontToken(shop: string): Promise<string | null> {
    if (!HAS_REAL_SUPABASE_URL) return null;

    // 1. Try canonical isolated table
    const { data: tokenData } = await supabaseAdmin
        .schema('shopify_app')
        .from('storefront_tokens')
        .select('storefront_access_token')
        .eq('shop', shop)
        .maybeSingle();
    
    if (tokenData?.storefront_access_token) return tokenData.storefront_access_token;

    // 2. Fallback to public token table used in older deployments
    const { data: publicTokenData } = await supabaseAdmin
        .from('shopify_storefront_tokens')
        .select('storefront_access_token')
        .eq('shop', shop)
        .maybeSingle();

    if (publicTokenData?.storefront_access_token) return publicTokenData.storefront_access_token;

    // 3. Fallback to legacy vto_stores
    const { data: storeData } = await supabaseAdmin
        .from('vto_stores')
        .select('storefront_token')
        .eq('shop_domain', shop)
        .maybeSingle();
    
    return storeData?.storefront_token || null;
}
