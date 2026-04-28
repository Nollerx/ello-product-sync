import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../lib/supabase.server";

// ─── Update Usage Capped Amount ──────────────────────────────────────────────
// Called from the Shopify admin context (merchant must be logged in).
// Updates the Shopify subscription's usage line item capped amount,
// which controls how much the merchant can be charged for overages.

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Custom distribution — no Shopify billing, usage caps managed directly in Supabase
  if (process.env.SKIP_BILLING === "true") {
    return Response.json({ error: "Shopify billing is disabled for this deployment" }, { status: 501 });
  }

  const { billing, session } = await authenticate.admin(request);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const newCapCredits = body.overage_cap_credits as number;
  if (typeof newCapCredits !== "number" || newCapCredits < 0) {
    return Response.json({ error: "Invalid overage_cap_credits" }, { status: 400 });
  }

  // Calculate the new capped amount in dollars ($0.15 per credit)
  const newCappedAmount = newCapCredits * 0.15;

  // Look up the store's subscription to get the usage line item ID
  const { data: account } = await supabaseAdmin
    .from("vto_accounts")
    .select("id")
    .eq("shopify_shop_domain", session.shop)
    .maybeSingle();

  if (!account) {
    return Response.json({ error: "Account not found" }, { status: 404 });
  }

  const { data: sub } = await supabaseAdmin
    .from("vto_subscriptions")
    .select("shopify_usage_line_item_id")
    .eq("account_id", account.id)
    .eq("status", "active")
    .maybeSingle();

  if (!sub?.shopify_usage_line_item_id) {
    return Response.json(
      { error: "No usage line item found. The merchant may need to re-subscribe to enable overage billing." },
      { status: 404 },
    );
  }

  try {
    // Update the capped amount on Shopify — this redirects to a confirmation page
    await billing.updateUsageCappedAmount({
      subscriptionLineItemId: sub.shopify_usage_line_item_id,
      cappedAmount: {
        amount: newCappedAmount,
        currencyCode: "USD",
      },
    });
  } catch (err) {
    console.error("[UpdateUsageCap] Shopify error:", err);
    return Response.json({ error: "Failed to update Shopify capped amount" }, { status: 500 });
  }

  // Also update the local store record
  await supabaseAdmin
    .from("vto_stores")
    .update({ overage_cap_credits: newCapCredits })
    .eq("account_id", account.id);

  return Response.json({ success: true, new_cap_credits: newCapCredits, new_capped_amount: newCappedAmount });
}
