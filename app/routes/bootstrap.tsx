import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabaseAdmin } from "../lib/supabase.server";

export async function loader({ request }: LoaderFunctionArgs) {
    if (request.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type"
            }
        });
    }
    return new Response("Method not allowed", { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
    // 1. Handle CORS Preflight (OPTIONS) - manual handling if action is called directly
    if (request.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type"
            }
        });
    }

    try {
        const body = await request.json();
        const shop = body.shop;

        if (!shop) {
            return new Response(JSON.stringify({ error: "Missing shop" }), {
                status: 400,
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*"
                }
            });
        }

        console.log(`[Bootstrap] Fetching config for shop: ${shop}`);

        // 2. Fetch Store Config from Supabase
        const { data: storeData, error: storeError } = await supabaseAdmin
            .from("vto_stores")
            .select("store_slug, shop_domain, storefront_token, clothing_population_type, featured_item_id, quick_picks_ids, widget_primary_color")
            .or(`shop_domain.eq.${shop},store_slug.eq.${shop}`)
            .maybeSingle();

        if (storeError) {
            console.error("[Bootstrap] DB Error:", storeError);
        }

        // 3. Fallback to shopify_app.storefront_tokens if not found in vto_stores
        let finalStoreData = storeData;
        if (!finalStoreData) {
            console.log(`[Bootstrap] Store not found in vto_stores, checking storefront_tokens for: ${shop}`);
            const { data: tokenData, error: tokenError } = await supabaseAdmin
                .schema('shopify_app')
                .from("storefront_tokens")
                .select("storefront_access_token")
                .eq("shop", shop)
                .maybeSingle();

            if (tokenError) {
                console.error("[Bootstrap] Token DB Error:", tokenError);
            }

            if (tokenData) {
                console.log(`[Bootstrap] Found token in storefront_tokens, creating synthetic store object.`);
                finalStoreData = {
                    shop_domain: shop,
                    storefront_token: tokenData.storefront_access_token,
                    clothing_population_type: 'shopify',
                    store_slug: shop.replace('.myshopify.com', ''),
                    widget_primary_color: '#000000',
                    featured_item_id: null,
                    quick_picks_ids: []
                };
            }
        }

        // 4. Detect Hidden Products (Blacklist) using Admin Client
        let hiddenProductIds: string[] = [];
        // (Optional: Add logic here to fetch hidden products if you have a table)

        // 4. Return JSON Response with CORS Headers
        return new Response(JSON.stringify({
            store: finalStoreData || null,
            blacklist: {
                hiddenProductIds: hiddenProductIds
            },
            timestamp: Date.now()
        }), {
            status: 200,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*" // CRITICAL
            }
        });

    } catch (error) {
        console.error("[Bootstrap] Error:", error);
        return new Response(JSON.stringify({ error: "Internal Server Error" }), {
            status: 500,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            }
        });
    }
}
