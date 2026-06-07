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
import { OVERAGE_USD_PER_TRYON, PRICING_PLANS, type PricingPlan } from "./lib/pricing-plans";
import dns from "node:dns";

// Fix for Node 18+ "fetch failed" errors in Cloud Run due to IPv6 prioritization issues
dns.setDefaultResultOrder("ipv4first");

const PLANS_BY_KEY = Object.fromEntries(
  PRICING_PLANS.map((plan) => [plan.key, plan]),
) as Record<PricingPlan["key"], PricingPlan>;
const OVERAGE_TERMS = `$${OVERAGE_USD_PER_TRYON.toFixed(2)} per try-on beyond your plan's included amount`;

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

          const settingsJson = JSON.stringify({
            store_slug: storeSlug,
            backend_url: backendUrl,
          });

          // An app can have at most ONE web pixel per shop, exposed via the
          // singular `webPixel` query — the plural `webPixels` does NOT exist on
          // QueryRoot and throws, which previously aborted activation entirely.
          // Wrap the read in its own try/catch so a missing read scope (or any
          // read error) still lets us fall through to create the pixel.
          let existingId: string | null = null;
          try {
            const existingResp = await admin.graphql(
              `query { webPixel { id settings } }`
            );
            const existingJson = await existingResp.json();
            existingId = existingJson?.data?.webPixel?.id ?? null;
          } catch (readErr) {
            console.warn(
              `[AutoSync:${requestId}] webPixel read failed (will attempt create):`,
              readErr
            );
          }

          if (existingId) {
            // Keep settings (backend_url / store_slug) current on reinstall.
            const updResp = await admin.graphql(
              `mutation webPixelUpdate($id: ID!, $webPixel: WebPixelInput!) {
                webPixelUpdate(id: $id, webPixel: $webPixel) {
                  webPixel { id }
                  userErrors { field message }
                }
              }`,
              { variables: { id: existingId, webPixel: { settings: settingsJson } } }
            );
            const updJson = await updResp.json();
            const errors = updJson?.data?.webPixelUpdate?.userErrors;
            if (errors?.length) {
              console.error(`[AutoSync:${requestId}] webPixelUpdate errors:`, errors);
            } else {
              console.log(`[AutoSync:${requestId}] Conversion pixel updated for ${shop}: ${existingId}`);
            }
          } else {
            const pixelResp = await admin.graphql(
              `mutation webPixelCreate($webPixel: WebPixelInput!) {
                webPixelCreate(webPixel: $webPixel) {
                  webPixel { id }
                  userErrors { field message }
                }
              }`,
              { variables: { webPixel: { settings: settingsJson } } }
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
    starter_monthly: { trialDays: 7, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: PLANS_BY_KEY.starter.monthlyPrice, currencyCode: "USD", interval: BillingInterval.Every30Days }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: OVERAGE_TERMS }] },
    starter_annual: { trialDays: 7, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: PLANS_BY_KEY.starter.annualPrice, currencyCode: "USD", interval: BillingInterval.Annual }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: OVERAGE_TERMS }] },
    launch_monthly: { trialDays: 7, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: PLANS_BY_KEY.launch.monthlyPrice, currencyCode: "USD", interval: BillingInterval.Every30Days }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: OVERAGE_TERMS }] },
    launch_annual: { trialDays: 7, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: PLANS_BY_KEY.launch.annualPrice, currencyCode: "USD", interval: BillingInterval.Annual }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: OVERAGE_TERMS }] },
    growth_monthly: { trialDays: 7, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: PLANS_BY_KEY.growth.monthlyPrice, currencyCode: "USD", interval: BillingInterval.Every30Days }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: OVERAGE_TERMS }] },
    growth_annual: { trialDays: 7, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: PLANS_BY_KEY.growth.annualPrice, currencyCode: "USD", interval: BillingInterval.Annual }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: OVERAGE_TERMS }] },
    scale_monthly: { trialDays: 7, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: PLANS_BY_KEY.scale.monthlyPrice, currencyCode: "USD", interval: BillingInterval.Every30Days }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: OVERAGE_TERMS }] },
    scale_annual: { trialDays: 7, replacementBehavior: BillingReplacementBehavior.ApplyImmediately, lineItems: [{ amount: PLANS_BY_KEY.scale.annualPrice, currencyCode: "USD", interval: BillingInterval.Annual }, { amount: 0.01, currencyCode: "USD", interval: BillingInterval.Usage, terms: OVERAGE_TERMS }] },
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
