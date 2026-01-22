import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../lib/supabase.server";

export const action = async ({ request }: ActionFunctionArgs) => {
    const { admin, session } = await authenticate.admin(request);
    const shop = session.shop;

    console.log(`👉 Manual Sync Token Triggered for ${shop}`);

    try {
        const mutation = `#graphql
      mutation CreateStorefrontToken($input: StorefrontAccessTokenInput!) {
        storefrontAccessTokenCreate(input: $input) {
          storefrontAccessToken { accessToken }
          userErrors { field message }
        }
      }
    `;

        const resp = await admin.graphql(mutation, {
            variables: { input: { title: "Ello VTO Manual Sync" } },
        });

        const jsonResp = await resp.json();
        const token =
            jsonResp?.data?.storefrontAccessTokenCreate?.storefrontAccessToken?.accessToken;
        const errs = jsonResp?.data?.storefrontAccessTokenCreate?.userErrors;

        if (errs && errs.length > 0) {
            console.error("❌ Manual Sync call to storefrontAccessTokenCreate failed:", errs);
            return new Response(JSON.stringify({ success: false, error: "Shopify API Error" }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
            });
        }

        if (!token) {
            console.error("❌ No token returned from Shopify Manual Sync:", jsonResp);
            return new Response(JSON.stringify({ success: false, error: "No Token" }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
            });
        }

        console.log("✅ Minted Shopify Token (Manual):", token);

        const { error: upsertErr } = await supabaseAdmin
            .schema('shopify_app')
            .from("storefront_tokens")
            .upsert(
                {
                    shop,
                    storefront_access_token: token,
                    updated_at: new Date().toISOString()
                },
                { onConflict: "shop" }
            );

        if (upsertErr) {
            console.error("❌ Supabase upsert error (Manual):", upsertErr);
            return new Response(JSON.stringify({ success: false, error: upsertErr.message }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
            });
        }

        console.log("✅ Successfully stored storefront token (Manual) for", shop);

        // 3) Auto-populate vto_stores 
        console.log("👉 Ensuring vto_stores entry exists (Manual)...");
        const { error: vtoErr } = await supabaseAdmin
            .from("vto_stores")
            .upsert(
                {
                    shop_domain: shop,
                    store_slug: shop.replace('.myshopify.com', ''),
                    storefront_token: token,
                    clothing_population_type: 'shopify',
                    widget_primary_color: '#000000',
                    updated_at: new Date().toISOString()
                },
                { onConflict: "shop_domain" }
            );

        if (vtoErr) {
            console.error("❌ Supabase vto_stores upsert error (Manual):", vtoErr);
            return new Response(JSON.stringify({ success: false, error: "Branding initialization failed" }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
            });
        }

        console.log("✅ Successfully initialized vto_stores (Manual) for", shop);
        return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });

    } catch (err) {
        console.error("❌ Critical Manual Sync error:", err);
        return new Response(JSON.stringify({ success: false, error: "Exception" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }
};
