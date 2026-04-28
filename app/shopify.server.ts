import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  BillingReplacementBehavior,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { SupabaseSessionStorage } from "./lib/supabase-session-storage.server";
import { runTokenSync } from "./lib/sync.server";
import { syncShopifyMerchantToSupabase } from "./lib/shopify-billing.server";
import dns from "node:dns";

// Fix for Node 18+ "fetch failed" errors in Cloud Run due to IPv6 prioritization issues
dns.setDefaultResultOrder("ipv4first");

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(/[, ]+/) || [],
  appUrl: process.env.SHOPIFY_APP_URL || "https://ello-vto-public-13593516897-u5htiuxfrq-uc.a.run.app",
  authPathPrefix: "/auth",
  sessionStorage: new SupabaseSessionStorage(),
  hooks: {
    async afterAuth({ session, admin }) {
      console.log("👉 Entered afterAuth for shop:", session.shop);
      const requestId = `install_${crypto.randomUUID()}`;

      try {
        const shop = session.shop;

        // 1. Mint Token immediately
        const mutation = `#graphql
          mutation CreateStorefrontToken($input: StorefrontAccessTokenInput!) {
            storefrontAccessTokenCreate(input: $input) {
              storefrontAccessToken { accessToken }
              userErrors { field message }
            }
          }
        `;

        const resp = await admin.graphql(mutation, {
            variables: { input: { title: "Ello VTO Auto-Sync" } },
        });

        const json = await resp.json();
        const token = json?.data?.storefrontAccessTokenCreate?.storefrontAccessToken?.accessToken;
        
        if (token) {
             console.log(`[AutoSync:${requestId}] Token acquired. Running Sync Engine...`);
             // 2. Run Sync Engine (Idempotent + Retries)
             await runTokenSync(shop, token, requestId);
        } else {
             console.error(`[AutoSync:${requestId}] Failed to mint token on install.`);
        }

        // 3. Provision Supabase merchant records so the store is auto-connected
        //    Uses "custom_distribution" when SKIP_BILLING is enabled (custom distribution — billed via Stripe)
        //    Otherwise uses "developer_free" as the provisional plan (idempotent — billing confirm will upgrade it).
        try {
          const provisionPlan = process.env.SKIP_BILLING === "true" ? "custom_distribution" : "ello_free";
          const shopQuery = await admin.graphql(`query { shop { email } }`);
          const shopJson = await shopQuery.json();
          const shopEmail = shopJson?.data?.shop?.email ?? shop;
          await syncShopifyMerchantToSupabase(shop, shopEmail, provisionPlan, undefined);
          console.log(`[AutoSync:${requestId}] Supabase merchant records provisioned for ${shop} (plan: ${provisionPlan})`);
        } catch (syncErr) {
          console.error(`[AutoSync:${requestId}] Supabase merchant sync failed (non-fatal):`, syncErr);
        }

        // 4. Activate the Ello conversion pixel for this store (idempotent).
        //    The pixel cannot fire until webPixelCreate is called — it is not auto-activated.
        //    backend_url is derived from SHOPIFY_APP_URL so staging and prod resolve automatically.
        try {
          const storeSlug = shop.replace(".myshopify.com", "");
          const backendUrl =
            (process.env.SHOPIFY_APP_URL ||
              "https://ello-vto-public-13593516897-u5htiuxfrq-uc.a.run.app") +
            "/api/cart-purchase-event";

          // Check if pixel already exists for this store (prevents duplicates on reinstall)
          const pixelListResp = await admin.graphql(
            `query { webPixels(first: 20) { edges { node { id settings } } } }`
          );
          const pixelListJson = await pixelListResp.json();
          const existingPixel = pixelListJson?.data?.webPixels?.edges?.find(
            (e: { node: { settings: string } }) => {
              try {
                return JSON.parse(e.node.settings)?.store_slug === storeSlug;
              } catch {
                return false;
              }
            }
          );

          if (!existingPixel) {
            const pixelResp = await admin.graphql(
              `mutation webPixelCreate($webPixel: WebPixelInput!) {
                webPixelCreate(webPixel: $webPixel) {
                  webPixel { id }
                  userErrors { field message }
                }
              }`,
              {
                variables: {
                  webPixel: {
                    settings: JSON.stringify({
                      store_slug: storeSlug,
                      backend_url: backendUrl,
                    }),
                  },
                },
              }
            );
            const pixelJson = await pixelResp.json();
            const errors = pixelJson?.data?.webPixelCreate?.userErrors;
            if (errors?.length) {
              console.error(`[AutoSync:${requestId}] webPixelCreate errors:`, errors);
            } else {
              console.log(
                `[AutoSync:${requestId}] Conversion pixel activated for ${shop}:`,
                pixelJson?.data?.webPixelCreate?.webPixel?.id
              );
            }
          } else {
            console.log(`[AutoSync:${requestId}] Conversion pixel already exists for ${shop}, skipping.`);
          }
        } catch (pixelErr) {
          console.error(`[AutoSync:${requestId}] Pixel activation failed (non-fatal):`, pixelErr);
        }

      } catch (err) {
        console.error(`[AutoSync:${requestId}] Critical Install Error:`, err);
      }
    },
  },
  distribution: (process.env.APP_DISTRIBUTION as AppDistribution) || AppDistribution.AppStore,
  future: {},
  billing: {
    // Each paid plan has: (1) recurring subscription charge + (2) usage-based overage at $0.15/try-on
    // The usage line item cappedAmount is set to $0.01 (minimum Shopify allows). Merchants can increase via auto top-up settings.
    starter_monthly:         { trialDays: 0, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: 97,        currencyCode: "USD", interval: BillingInterval.Every30Days }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: "$0.15 per try-on beyond your plan's included amount" }] },
    starter_annual:          { trialDays: 0, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: 1047.60,   currencyCode: "USD", interval: BillingInterval.Annual      }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: "$0.15 per try-on beyond your plan's included amount" }] },
    launch_monthly:          { trialDays: 0, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: 149,       currencyCode: "USD", interval: BillingInterval.Every30Days }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: "$0.15 per try-on beyond your plan's included amount" }] },
    launch_annual:           { trialDays: 0, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: 1609.20,   currencyCode: "USD", interval: BillingInterval.Annual      }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: "$0.15 per try-on beyond your plan's included amount" }] },
    growth_monthly:          { trialDays: 0, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: 172,       currencyCode: "USD", interval: BillingInterval.Every30Days }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: "$0.15 per try-on beyond your plan's included amount" }] },
    growth_annual:           { trialDays: 0, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: 1857.60,   currencyCode: "USD", interval: BillingInterval.Annual      }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: "$0.15 per try-on beyond your plan's included amount" }] },
    growth_plus_monthly:     { trialDays: 0, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: 289,       currencyCode: "USD", interval: BillingInterval.Every30Days }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: "$0.15 per try-on beyond your plan's included amount" }] },
    growth_plus_annual:      { trialDays: 0, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: 3121.20,   currencyCode: "USD", interval: BillingInterval.Annual      }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: "$0.15 per try-on beyond your plan's included amount" }] },
    pro_monthly:             { trialDays: 0, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: 647,       currencyCode: "USD", interval: BillingInterval.Every30Days }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: "$0.15 per try-on beyond your plan's included amount" }] },
    pro_annual:              { trialDays: 0, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: 6987.60,   currencyCode: "USD", interval: BillingInterval.Annual      }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: "$0.15 per try-on beyond your plan's included amount" }] },
    pro_plus_monthly:        { trialDays: 0, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: 1149,      currencyCode: "USD", interval: BillingInterval.Every30Days }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: "$0.15 per try-on beyond your plan's included amount" }] },
    pro_plus_annual:         { trialDays: 0, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: 12409.20,  currencyCode: "USD", interval: BillingInterval.Annual      }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: "$0.15 per try-on beyond your plan's included amount" }] },
    enterprise_monthly:      { trialDays: 0, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: 1897,      currencyCode: "USD", interval: BillingInterval.Every30Days }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: "$0.15 per try-on beyond your plan's included amount" }] },
    enterprise_annual:       { trialDays: 0, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: 20487.60,  currencyCode: "USD", interval: BillingInterval.Annual      }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: "$0.15 per try-on beyond your plan's included amount" }] },
    enterprise_plus_monthly: { trialDays: 0, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: 5197,      currencyCode: "USD", interval: BillingInterval.Every30Days }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: "$0.15 per try-on beyond your plan's included amount" }] },
    enterprise_plus_annual:  { trialDays: 0, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: 56127.60,  currencyCode: "USD", interval: BillingInterval.Annual      }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: "$0.15 per try-on beyond your plan's included amount" }] },
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
