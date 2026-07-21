import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

// Shopify's mandatory GDPR compliance webhooks. The app config points
// compliance_topics at /api/privacy — this file must live at exactly that
// path (the old api.privacy_compliance.tsx route was never registered with
// Shopify, so these webhooks 404ed until 2026-07-18).
//
// Shopify probes this endpoint during app review: a request with an invalid
// HMAC must get a 401, a valid one a 200.

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Every BASE TABLE that stores per-shop shopper/order data, keyed by
// store_slug (vto_attributed_purchases / vto_conversion_summary are views
// over these — they empty automatically and reject DELETE). This is the
// deletion set behind the privacy policy's retention promise: "retained
// while the merchant has the app installed, deleted after the app is
// uninstalled." Shopify sends shop/redact ~48h after uninstall — that is
// the sanctioned purge moment (an immediate purge on app/uninstalled would
// destroy data on accidental uninstall/reinstall cycles).
const SHOP_DATA_TABLES = [
  "purchase_events",
  "refund_events",
  "cart_events",
  "product_view_events",
  "tryon_events",
  "widget_events",
  "vto_ab_exposures",
] as const;

export const loader = async (_: LoaderFunctionArgs) => {
  return new Response("Privacy Webhook Endpoint Active", { status: 200 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const topic = request.headers.get("x-shopify-topic") || "UNKNOWN";
    const shopHeader = request.headers.get("x-shopify-shop-domain") || "";
    const hmac = request.headers.get("x-shopify-hmac-sha256");

    const rawBody = await request.text();

    const secret = process.env.SHOPIFY_API_SECRET || "";
    if (!secret || !hmac) {
      console.error("[GDPR] Missing secret or HMAC header");
      return new Response("Unauthorized", { status: 401 });
    }

    const generatedHash = crypto
      .createHmac("sha256", secret)
      .update(rawBody, "utf8")
      .digest("base64");

    const valid =
      hmac.length === generatedHash.length &&
      crypto.timingSafeEqual(Buffer.from(generatedHash), Buffer.from(hmac));
    if (!valid) {
      console.error(`[GDPR] HMAC validation failed for ${topic}`);
      return new Response("Unauthorized", { status: 401 });
    }

    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(rawBody);
    } catch {
      // Some probes send empty bodies — HMAC already validated, proceed.
    }
    const shopDomain = (body.shop_domain as string) || shopHeader;
    console.log(`✅ [GDPR] Verified webhook ${topic} for ${shopDomain}`);

    if (topic === "shop/redact") {
      // store_slug convention fleet-wide: the myshopify subdomain
      // (afterAuth: shop.replace(".myshopify.com", "")).
      const slug = shopDomain.replace(".myshopify.com", "");
      if (!slug || slug.length > 100) {
        console.error(`[GDPR] shop/redact with unusable shop domain: "${shopDomain}"`);
        return new Response("GDPR Request Received", { status: 200 });
      }
      for (const table of SHOP_DATA_TABLES) {
        const { error, count } = await supabase
          .from(table)
          .delete({ count: "exact" })
          .eq("store_slug", slug);
        if (error) {
          // Loud but non-fatal: a failed table must not stop the rest of the
          // purge, and Shopify will retry the webhook on non-2xx anyway.
          console.error(`[GDPR] shop/redact ${slug}: ${table} failed — ${error.message}`);
        } else {
          console.log(`[GDPR] shop/redact ${slug}: ${table} purged ${count ?? 0} rows`);
        }
      }
    } else if (topic === "customers/redact" || topic === "customers/data_request") {
      // Ello stores no customer PII (no names, emails, phones, addresses) and
      // identifies shoppers only by anonymous widget session ids, which cannot
      // be mapped to a Shopify customer id. There is nothing to look up or
      // redact per-customer; order-level data is removed wholesale on
      // shop/redact above.
      console.log(`[GDPR] ${topic}: no customer PII held — acknowledged`);
    }

    return new Response("GDPR Request Received", { status: 200 });
  } catch (error) {
    console.error("[GDPR] Webhook processing error:", error);
    return new Response("Server Error", { status: 500 });
  }
};
