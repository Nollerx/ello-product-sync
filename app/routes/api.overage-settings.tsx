import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabaseAdmin } from "../lib/supabase.server";
import { unauthenticated } from "../shopify.server";

// ─── CORS Headers ─────────────────────────────────────────────────────────────
// This endpoint is called by the Ello dashboard (external origin)

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-store-slug",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ─── GET: Retrieve overage settings + current usage ───────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const storeSlug = url.searchParams.get("store_slug") || url.searchParams.get("storeSlug");

  if (!storeSlug) {
    return json(400, { error: "Missing store_slug parameter" });
  }

  // Get store overage settings
  const { data: store, error: storeError } = await supabaseAdmin
    .from("vto_stores")
    .select("account_id, overage_auto_topup, overage_cap_credits, overage_trigger_threshold, overage_credits_used")
    .eq("store_slug", storeSlug)
    .maybeSingle();

  if (storeError || !store) {
    return json(404, { error: "Store not found" });
  }

  // Get current usage via RPC
  const { data: usage, error: usageError } = await supabaseAdmin.rpc("get_store_usage", {
    p_store_slug: storeSlug,
  });

  if (usageError) {
    console.error("[OverageSettings] get_store_usage error:", usageError.message);
  }

  return json(200, {
    overage_auto_topup: store.overage_auto_topup,
    overage_cap_credits: store.overage_cap_credits,
    overage_trigger_threshold: store.overage_trigger_threshold,
    overage_credits_used: store.overage_credits_used,
    overage_rate: 0.15,
    usage: usage ?? null,
  });
}

// ─── POST: Update overage settings ───────────────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const storeSlug = body.store_slug as string || body.storeSlug as string;
  if (!storeSlug) {
    return json(400, { error: "Missing store_slug" });
  }

  // Build update object from provided fields
  const updates: Record<string, unknown> = {};

  if (typeof body.overage_auto_topup === "boolean") {
    updates.overage_auto_topup = body.overage_auto_topup;
  }
  if (typeof body.overage_cap_credits === "number" && body.overage_cap_credits >= 0) {
    updates.overage_cap_credits = body.overage_cap_credits;
  }
  if (typeof body.overage_trigger_threshold === "number" && body.overage_trigger_threshold >= 0) {
    updates.overage_trigger_threshold = body.overage_trigger_threshold;
  }

  if (Object.keys(updates).length === 0) {
    return json(400, { error: "No valid fields to update" });
  }

  const { error } = await supabaseAdmin
    .from("vto_stores")
    .update(updates)
    .eq("store_slug", storeSlug);

  if (error) {
    console.error("[OverageSettings] Update error:", error.message);
    return json(500, { error: "Failed to update settings" });
  }

  // If overage_cap_credits changed, also update the Shopify cappedAmount so
  // Shopify actually allows charges up to the new cap.
  // Skip Shopify cap update when SKIP_BILLING is enabled (custom distribution)
  let shopifyCapUpdated = false;
  if (process.env.SKIP_BILLING !== "true" && typeof updates.overage_cap_credits === "number") {
    try {
      // Look up the store's shop_domain and subscription usage line item ID
      const { data: store } = await supabaseAdmin
        .from("vto_stores")
        .select("account_id, shop_domain")
        .eq("store_slug", storeSlug)
        .maybeSingle();

      if (store?.shop_domain) {
        const { data: sub } = await supabaseAdmin
          .from("vto_subscriptions")
          .select("shopify_usage_line_item_id")
          .eq("account_id", store.account_id)
          .eq("status", "active")
          .not("shopify_subscription_id", "is", null)
          .maybeSingle();

        if (sub?.shopify_usage_line_item_id) {
          const newCappedAmount = (updates.overage_cap_credits as number) * 0.15;
          const { admin } = await unauthenticated.admin(store.shop_domain);
          const response = await admin.graphql(
            `#graphql
              mutation AppSubscriptionLineItemUpdate($cappedAmount: MoneyInput!, $lineItemId: ID!) {
                appSubscriptionLineItemUpdate(cappedAmount: $cappedAmount, lineItemId: $lineItemId) {
                  appSubscription { id }
                  userErrors { field message }
                }
              }
            `,
            {
              variables: {
                lineItemId: sub.shopify_usage_line_item_id,
                cappedAmount: { amount: newCappedAmount, currencyCode: "USD" },
              },
            },
          );
          const gqlJson = await response.json();
          const userErrors = gqlJson?.data?.appSubscriptionLineItemUpdate?.userErrors;
          if (userErrors?.length) {
            console.error("[OverageSettings] Shopify cap update errors:", userErrors);
          } else {
            shopifyCapUpdated = true;
            console.log(`[OverageSettings] Updated Shopify cappedAmount to $${newCappedAmount} for ${store.shop_domain}`);
          }
        } else {
          console.warn(`[OverageSettings] No usage line item ID for store ${storeSlug} — Shopify cap not updated`);
        }
      }
    } catch (err) {
      console.error("[OverageSettings] Failed to update Shopify capped amount (non-fatal):", err);
      // Non-fatal — Supabase settings are already saved
    }
  }

  return json(200, { success: true, updated: updates, shopify_cap_updated: shopifyCapUpdated });
}
