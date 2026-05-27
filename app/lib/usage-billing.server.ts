import { supabaseAdmin } from "./supabase.server";
import { unauthenticated } from "../shopify.server";

// ─── Types ────────────────────────────────────────────────────────────────────

export type UsageCheckResult = {
  allowed: boolean;
  error?: string;
  is_overage: boolean;
  plan_code?: string;
  tryons_used: number;
  included_tryons: number;
  overage_credits_used?: number;
  overage_cap_credits?: number;
  shop_domain?: string;
  shopify_usage_line_item_id?: string;
};

// ─── Check & Record Usage ─────────────────────────────────────────────────────
// Calls the Supabase RPC function to check limits, increment usage, and return status.

export type PageContext = {
  type?: string | null;
  path?: string | null;
  handle?: string | null;
  in_catalog?: boolean | null;
} | null | undefined;

// entry_source values mirror the CHECK constraint added in 20260524_inline_tryon_button.sql.
// 'unknown' is intentionally allowed so we don't drop events from older widget
// versions that haven't been updated to tag the source.
export type EntrySource =
  | "inline_button"
  | "floating_widget"
  | "preview_popup"
  | "unknown";

export async function checkAndRecordUsage(
  storeSlug: string,
  success: boolean = true,
  productId?: string | null,
  variantId?: string | null,
  sessionId?: string | null,
  pageContext?: PageContext,
  entrySource?: EntrySource | null,
): Promise<UsageCheckResult> {
  try {
    const { data, error } = await supabaseAdmin.rpc("record_tryon_event", {
      p_store_slug: storeSlug,
      p_success: success,
      p_product_id: productId ?? null,
      p_variant_id: variantId ?? null,
      p_session_id: sessionId ?? null,
      p_page_type: pageContext?.type ?? null,
      p_page_path: pageContext?.path ?? null,
      p_page_handle: pageContext?.handle ?? null,
      p_page_in_catalog: pageContext?.in_catalog ?? null,
      p_entry_source: entrySource ?? null,
    });

    if (error) {
      console.error("[UsageBilling] RPC error:", error.message);
      // On RPC failure, allow the try-on (fail open) but log the error
      return {
        allowed: true,
        is_overage: false,
        tryons_used: 0,
        included_tryons: 9999,
        error: error.message,
      };
    }

    const result = data as Record<string, unknown>;

    return {
      allowed: result.allowed as boolean,
      error: result.error as string | undefined,
      is_overage: (result.is_overage as boolean) ?? false,
      plan_code: result.plan_code as string | undefined,
      tryons_used: (result.tryons_used as number) ?? 0,
      included_tryons: (result.included_tryons as number) ?? 0,
      overage_credits_used: result.overage_credits_used as number | undefined,
      overage_cap_credits: result.overage_cap_credits as number | undefined,
      shop_domain: result.shop_domain as string | undefined,
      shopify_usage_line_item_id: result.shopify_usage_line_item_id as string | undefined,
    };
  } catch (err) {
    console.error("[UsageBilling] Exception during usage check:", err);
    // Fail open — don't block try-ons if our billing system is down
    return {
      allowed: true,
      is_overage: false,
      tryons_used: 0,
      included_tryons: 9999,
      error: String(err),
    };
  }
}

// ─── Create Shopify Usage Charge ──────────────────────────────────────────────
// Creates a $0.15 usage record on the merchant's Shopify subscription.
// Uses unauthenticated.admin() to access the Admin API without an active session.

const OVERAGE_RATE = 0.15;

const APP_USAGE_RECORD_CREATE = `#graphql
  mutation AppUsageRecordCreate($subscriptionLineItemId: ID!, $price: MoneyInput!, $description: String!) {
    appUsageRecordCreate(
      subscriptionLineItemId: $subscriptionLineItemId
      price: $price
      description: $description
    ) {
      appUsageRecord {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function createShopifyUsageCharge(
  shopDomain: string,
  subscriptionLineItemId: string,
  description: string = "Virtual try-on overage",
): Promise<{ success: boolean; error?: string }> {
  try {
    const { admin } = await unauthenticated.admin(shopDomain);

    const response = await admin.graphql(APP_USAGE_RECORD_CREATE, {
      variables: {
        subscriptionLineItemId,
        price: {
          amount: OVERAGE_RATE,
          currencyCode: "USD",
        },
        description,
      },
    });

    const json = await response.json();
    const userErrors = json?.data?.appUsageRecordCreate?.userErrors;

    if (userErrors?.length) {
      const errorMsg = userErrors.map((e: { message: string }) => e.message).join(", ");
      console.error(`[UsageBilling] Shopify usage charge error for ${shopDomain}:`, errorMsg);
      return { success: false, error: errorMsg };
    }

    console.log(
      `[UsageBilling] Created $${OVERAGE_RATE} usage charge for ${shopDomain} (line item: ${subscriptionLineItemId})`,
    );
    return { success: true };
  } catch (err) {
    console.error(`[UsageBilling] Failed to create Shopify usage charge for ${shopDomain}:`, err);
    return { success: false, error: String(err) };
  }
}
