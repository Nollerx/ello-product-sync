import type { ActionFunctionArgs } from "react-router";
import { authenticate, sessionStorage } from "../shopify.server";
import { disableShopifyMerchant } from "../lib/shopify-billing.server";
// import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await sessionStorage.deleteSessions([session.id]);
  }

  try {
    if (shop) {
      await disableShopifyMerchant(shop);
      console.log("[Uninstall] Disabled Shopify merchant in Supabase:", shop);
    }
  } catch (err) {
    console.error("[Uninstall] Failed to disable merchant in Supabase:", err);
    // Do not rethrow — Shopify expects a 200 response
  }

  return new Response();
};
