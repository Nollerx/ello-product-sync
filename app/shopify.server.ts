import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { supabaseAdmin } from "./lib/supabase.server";
import { SQLiteSessionStorage } from "@shopify/shopify-app-session-storage-sqlite";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY || "missing_api_key",
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "missing_secret_key",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(",") || [],
  appUrl: process.env.SHOPIFY_APP_URL || "https://missing-app-url.com",
  authPathPrefix: "/auth",
  sessionStorage: new SQLiteSessionStorage(process.env.SESSION_DB_PATH || "./shopify_sessions.sqlite"),
  hooks: {
    async afterAuth({ session, admin }) {
      console.log("👉 Entered afterAuth for shop:", session.shop);
      try {
        const shop = session.shop;

        // 1) Creates storefront token in Shopify
        const mutation = `#graphql
          mutation CreateStorefrontToken($input: StorefrontAccessTokenInput!) {
            storefrontAccessTokenCreate(input: $input) {
              storefrontAccessToken { accessToken }
              userErrors { field message }
            }
          }
        `;

        console.log("👉 Minting Storefront Token...");
        const resp = await admin.graphql(mutation, {
          variables: { input: { title: "Ello VTO" } },
        });

        const json = await resp.json();
        const token =
          json?.data?.storefrontAccessTokenCreate?.storefrontAccessToken?.accessToken;
        const errs = json?.data?.storefrontAccessTokenCreate?.userErrors;

        if (errs && errs.length > 0) {
          console.error("❌ call to storefrontAccessTokenCreate failed:", errs);
        }

        if (!token) {
          console.error("❌ No token returned from Shopify:", json);
          return;
        }

        console.log("✅ Minted Shopify Token:", token);

        // 2) Store in Supabase (shopify_app Schema)
        console.log("👉 Saving to Supabase (shopify_app.storefront_tokens)...");
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
          console.error("❌ Supabase upsert error:", upsertErr);
          if (upsertErr.code === 'PGRST106') {
            console.error("🚨 CRITICAL: You must expose the 'shopify_app' schema in Supabase!");
            console.error("   Go to: Dashboard -> Settings -> API -> Exposed Schemas -> Add 'shopify_app'");
          }
          if (upsertErr.code === '42P01') console.error("   (Table does not exist?)");
          return;
        }

        console.log("✅ Successfully stored storefront token for", shop);
      } catch (err) {
        console.error("❌ Critical afterAuth hook error:", err);
      }
    },
  },
  distribution: AppDistribution.AppStore,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    removeRest: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
