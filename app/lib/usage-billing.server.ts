import { supabaseAdmin } from "./supabase.server";
import { unauthenticated } from "../shopify.server";
import { sendTelegramMessage } from "./telegram.server";

// ─── Bounded fail-open ────────────────────────────────────────────────────────
// If the metering RPC is unavailable we must NOT wave through unlimited renders:
// each try-on costs real Gemini COGS and, while the RPC is down, every plan limit,
// overage cap, and per-shopper cap is unenforceable. Instead of pure fail-open,
// allow a small per-store burst per instance during the outage, then deny with a
// retryable error. State is per Cloud Run instance, so the fleet-wide bound is
// (FAILOPEN_MAX_PER_MIN × instance count) — bounded, not infinite.
const FAILOPEN_MAX_PER_MIN = Number(process.env.FAILOPEN_MAX_PER_MIN || 30);
const _failOpenWindow = new Map<string, { windowStart: number; count: number }>();
let _lastDegradedAlert = 0;

function boundedFailOpen(storeSlug: string, reason: string): UsageCheckResult {
  const now = Date.now();
  const slot = _failOpenWindow.get(storeSlug);
  if (!slot || now - slot.windowStart >= 60_000) {
    _failOpenWindow.set(storeSlug, { windowStart: now, count: 1 });
  } else {
    slot.count += 1;
  }
  const count = _failOpenWindow.get(storeSlug)!.count;

  // Loud, throttled alert (≤ once/min per instance) so a metering outage can't run
  // silently the way pure fail-open did.
  if (now - _lastDegradedAlert > 60_000) {
    _lastDegradedAlert = now;
    void sendTelegramMessage(
      `⚠️ Ello metering RPC degraded — bounded fail-open active (store ${storeSlug}). Reason: ${reason}`,
    ).catch(() => {});
  }

  if (count > FAILOPEN_MAX_PER_MIN) {
    // Past the degraded-mode burst: stop spending on unmetered renders. tryon.tsx
    // maps SERVICE_DEGRADED to a retryable 503.
    return {
      allowed: false,
      is_overage: false,
      tryons_used: 0,
      included_tryons: 0,
      error: "SERVICE_DEGRADED",
    };
  }
  return {
    allowed: true,
    is_overage: false,
    tryons_used: 0,
    included_tryons: 9999,
    error: reason,
  };
}

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
  shopper_limit_count?: number;
  shopper_limit_window_hours?: number;
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
  ipAddress?: string | null,
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
      p_ip_address: ipAddress ?? null,
    });

    if (error) {
      console.error("[UsageBilling] RPC error:", error.message);
      // Bounded fail-open: allow a limited per-store burst, then deny so a metering
      // outage can't turn into unlimited unmetered Gemini spend.
      return boundedFailOpen(storeSlug, error.message);
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
      shopper_limit_count: result.shopper_limit_count as number | undefined,
      shopper_limit_window_hours: result.shopper_limit_window_hours as number | undefined,
    };
  } catch (err) {
    console.error("[UsageBilling] Exception during usage check:", err);
    // Bounded fail-open (see above) rather than unconditionally allowing.
    return boundedFailOpen(storeSlug, String(err));
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

// ─── Release Usage On Failed Render ───────────────────────────────────────────
// record_tryon_event increments usage UP FRONT so the limit gate can run before
// we spend ML compute. When the render then fails to return an image, this hands
// the metered credit back (decrements tryons_used / overage_credits_used and flips
// the logged event to failed) so a try-on that produced no photo never consumes
// the merchant's included or overage allowance. Best-effort: never throws.

export async function releaseTryonCredit(
  storeSlug: string,
  sessionId: string | null,
  wasOverage: boolean,
): Promise<void> {
  try {
    const { error } = await supabaseAdmin.rpc("reverse_tryon_event", {
      p_store_slug: storeSlug,
      p_session_id: sessionId,
      p_was_overage: wasOverage,
    });
    if (error) {
      console.error("[UsageBilling] Failed to release try-on credit:", error.message);
    } else {
      console.log(
        `[UsageBilling] Released try-on credit for ${storeSlug} (overage: ${wasOverage})`,
      );
    }
  } catch (err) {
    console.error("[UsageBilling] Exception releasing try-on credit:", err);
  }
}
