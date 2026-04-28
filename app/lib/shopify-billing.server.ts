import { supabaseAdmin } from "./supabase.server";

// ─── Plan Config ──────────────────────────────────────────────────────────────

type PlanInterval = "month" | "year";

export type PlanMeta = {
  displayName: string;
  price: number;
  interval: PlanInterval;
  includedTryons: number;
  planId: string;
};

const PLAN_CONFIG: Record<string, PlanMeta> = {
  custom_distribution:     { displayName: "Custom Plan",      price: 0,         interval: "month", includedTryons: parseInt(process.env.DEFAULT_INCLUDED_TRYONS || "500", 10), planId: "custom-dist-00000000-0000-0000-0000" },
  developer_free:          { displayName: "Developer Free",   price: 0,         interval: "month", includedTryons: 9999,  planId: "a7d8292a-b720-418c-9de7-70191bc9969d" },
  ello_free:               { displayName: "Ello Free",        price: 0,         interval: "month", includedTryons: 10,    planId: "ab69eb9e-648c-4777-a6f6-6482f8b780a7" },
  starter_monthly:         { displayName: "Ello Starter",     price: 97,        interval: "month", includedTryons: 150,   planId: "acf413dc-bcb0-484a-b914-2d6f6491eb39" },
  starter_annual:          { displayName: "Ello Starter",     price: 1047.60,   interval: "year",  includedTryons: 150,   planId: "acf413dc-bcb0-484a-b914-2d6f6491eb39" },
  launch_monthly:          { displayName: "Ello Launch",      price: 149,       interval: "month", includedTryons: 400,   planId: "75fa2215-7008-4242-aef5-40aa2b278968" },
  launch_annual:           { displayName: "Ello Launch",      price: 1609.20,   interval: "year",  includedTryons: 400,   planId: "75fa2215-7008-4242-aef5-40aa2b278968" },
  growth_monthly:          { displayName: "Ello Growth",      price: 172,       interval: "month", includedTryons: 750,   planId: "48ce4579-3523-45e1-9cc5-7f2bb0134073" },
  growth_annual:           { displayName: "Ello Growth",      price: 1857.60,   interval: "year",  includedTryons: 750,   planId: "48ce4579-3523-45e1-9cc5-7f2bb0134073" },
  growth_plus_monthly:     { displayName: "Ello Growth+",     price: 289,       interval: "month", includedTryons: 1800,  planId: "aa335388-c6f9-4d9d-949c-9a8ee689c5ca" },
  growth_plus_annual:      { displayName: "Ello Growth+",     price: 3121.20,   interval: "year",  includedTryons: 1800,  planId: "aa335388-c6f9-4d9d-949c-9a8ee689c5ca" },
  pro_monthly:             { displayName: "Ello Pro",         price: 647,       interval: "month", includedTryons: 4000,  planId: "6c203206-7f01-4ca2-b1f2-fabda7a6306f" },
  pro_annual:              { displayName: "Ello Pro",         price: 6987.60,   interval: "year",  includedTryons: 4000,  planId: "6c203206-7f01-4ca2-b1f2-fabda7a6306f" },
  pro_plus_monthly:        { displayName: "Pro Plus",         price: 1149,      interval: "month", includedTryons: 9000,  planId: "4d6cd330-4788-4911-ac72-c7e741b53c54" },
  pro_plus_annual:         { displayName: "Pro Plus",         price: 12409.20,  interval: "year",  includedTryons: 9000,  planId: "4d6cd330-4788-4911-ac72-c7e741b53c54" },
  enterprise_monthly:      { displayName: "Ello Enterprise",  price: 1897,      interval: "month", includedTryons: 13000, planId: "f5bc29c9-e69d-4e46-8442-5d8adb66e11e" },
  enterprise_annual:       { displayName: "Ello Enterprise",  price: 20487.60,  interval: "year",  includedTryons: 13000, planId: "f5bc29c9-e69d-4e46-8442-5d8adb66e11e" },
  enterprise_plus_monthly: { displayName: "Ello Enterprise+", price: 5197,      interval: "month", includedTryons: 25000, planId: "b4309e55-2a93-4d12-8185-ea4c8fd5841f" },
  enterprise_plus_annual:  { displayName: "Ello Enterprise+", price: 56127.60,  interval: "year",  includedTryons: 25000, planId: "b4309e55-2a93-4d12-8185-ea4c8fd5841f" },
};

export function getPlanConfig(): Record<string, PlanMeta> {
  return PLAN_CONFIG;
}

export const PAID_PLAN_KEYS = [
  "starter_monthly",
  "starter_annual",
  "launch_monthly",
  "launch_annual",
  "growth_monthly",
  "growth_annual",
  "growth_plus_monthly",
  "growth_plus_annual",
  "pro_monthly",
  "pro_annual",
  "pro_plus_monthly",
  "pro_plus_annual",
  "enterprise_monthly",
  "enterprise_annual",
  "enterprise_plus_monthly",
  "enterprise_plus_annual",
] as const;

export type PaidPlanKey = typeof PAID_PLAN_KEYS[number];

export function isPaidPlanKey(planKey: string | null | undefined): planKey is PaidPlanKey {
  return Boolean(planKey && PAID_PLAN_KEYS.includes(planKey as PaidPlanKey));
}

type ActiveSubscriptionLineItem = {
  id?: string | null;
  plan?: {
    pricingDetails?: unknown;
  } | null;
};

export type ActiveSubscriptionSnapshot = {
  id?: string | null;
  name?: string | null;
  createdAt?: string | null;
  currentPeriodEnd?: string | null;
  lineItems?: ActiveSubscriptionLineItem[] | null;
};

export function extractUsageLineItemId(
  subscription: ActiveSubscriptionSnapshot | null | undefined,
): string | null {
  const lineItems = subscription?.lineItems ?? [];

  for (const lineItem of lineItems) {
    const pricingDetails = lineItem?.plan?.pricingDetails as
      | { __typename?: string | null; terms?: string | null }
      | null
      | undefined;
    if (
      pricingDetails?.__typename === "AppUsagePricing" ||
      typeof pricingDetails?.terms === "string"
    ) {
      return lineItem?.id ?? null;
    }
  }

  return null;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type ShopifyMerchantSyncResult = {
  accountId: string;
  storeSlug: string;
};

type BillingWindow = {
  currentPeriodStart: string;
  currentPeriodEnd: string;
};

type BillingWindowInput = {
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
};

function addBillingInterval(baseDate: Date, interval: PlanInterval): Date {
  const nextDate = new Date(baseDate);
  if (interval === "year") {
    nextDate.setFullYear(nextDate.getFullYear() + 1);
  } else {
    nextDate.setMonth(nextDate.getMonth() + 1);
  }
  return nextDate;
}

function subtractBillingInterval(baseDate: Date, interval: PlanInterval): Date {
  const previousDate = new Date(baseDate);
  if (interval === "year") {
    previousDate.setFullYear(previousDate.getFullYear() - 1);
  } else {
    previousDate.setMonth(previousDate.getMonth() - 1);
  }
  return previousDate;
}

function toValidDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsedDate = new Date(value);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}

function resolveBillingWindow(interval: PlanInterval, input?: BillingWindowInput): BillingWindow {
  const periodEnd = toValidDate(input?.currentPeriodEnd);
  const periodStart = toValidDate(input?.currentPeriodStart);

  if (periodStart && periodEnd) {
    return {
      currentPeriodStart: periodStart.toISOString(),
      currentPeriodEnd: periodEnd.toISOString(),
    };
  }

  if (periodEnd) {
    return {
      currentPeriodStart: subtractBillingInterval(periodEnd, interval).toISOString(),
      currentPeriodEnd: periodEnd.toISOString(),
    };
  }

  if (periodStart) {
    return {
      currentPeriodStart: periodStart.toISOString(),
      currentPeriodEnd: addBillingInterval(periodStart, interval).toISOString(),
    };
  }

  const now = new Date();
  return {
    currentPeriodStart: now.toISOString(),
    currentPeriodEnd: addBillingInterval(now, interval).toISOString(),
  };
}

// ─── Internal: Unique Slug Generation ────────────────────────────────────────

async function generateUniqueSlug(shop: string): Promise<string> {
  const base = shop
    .replace(".myshopify.com", "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // Pre-fetch any existing account for this shop so we can recognise our own slug
  const { data: existingAccount } = await supabaseAdmin
    .from("vto_accounts")
    .select("id")
    .eq("shopify_shop_domain", shop)
    .maybeSingle();

  const ownAccountId: string | null = existingAccount?.id ?? null;

  let slug = base;
  let suffix = 2;

  for (;;) {
    const { data: conflict } = await supabaseAdmin
      .from("vto_stores")
      .select("account_id")
      .eq("store_slug", slug)
      .maybeSingle();

    // Slug is free
    if (!conflict) return slug;

    // Slug already belongs to this merchant's account — reuse it
    if (ownAccountId && conflict.account_id === ownAccountId) return slug;

    // Taken by a different account — try the next suffix
    slug = `${base}-${suffix++}`;
  }
}

// ─── syncShopifyMerchantToSupabase ────────────────────────────────────────────

export async function syncShopifyMerchantToSupabase(
  shop: string,
  email: string,
  planKey: string,
  shopifySubscriptionId: string | null | undefined,
  shopifyUsageLineItemId?: string | null,
  billingWindowInput?: BillingWindowInput,
): Promise<ShopifyMerchantSyncResult> {
  const plan = PLAN_CONFIG[planKey];
  if (!plan) {
    throw new Error(`[ShopifyBilling] Unknown planKey: "${planKey}"`);
  }

  // 1. Generate a unique store slug
  const storeSlug = await generateUniqueSlug(shop);

  // 2. Upsert vto_accounts
  const { data: accountData, error: accountError } = await supabaseAdmin
    .from("vto_accounts")
    .upsert(
      {
        shopify_shop_domain: shop,
        billing_source: "shopify",
        type: "brand",
        owner_email: email,
        billing_email: email,
        name: shop,
      },
      { onConflict: "shopify_shop_domain", ignoreDuplicates: false },
    )
    .select("id")
    .single();

  if (accountError || !accountData) {
    throw new Error(
      `[ShopifyBilling] Failed to upsert vto_accounts for shop "${shop}": ${accountError?.message}`,
    );
  }

  const accountId = accountData.id as string;

  // 3. Insert or update vto_stores (no upsert — account_id has no unique constraint)
  const { data: existingStore } = await supabaseAdmin
    .from("vto_stores")
    .select("id")
    .eq("account_id", accountId)
    .maybeSingle();

  if (existingStore) {
    const { error: storeError } = await supabaseAdmin
      .from("vto_stores")
      .update({ store_slug: storeSlug, store_name: shop, shop_domain: shop, widget_enabled: true })
      .eq("account_id", accountId);
    if (storeError) {
      throw new Error(
        `[ShopifyBilling] Failed to update vto_stores for account "${accountId}": ${storeError.message}`,
      );
    }
  } else {
    const { error: storeError } = await supabaseAdmin
      .from("vto_stores")
      .insert({
        account_id: accountId,
        store_slug: storeSlug,
        store_name: shop,
        shop_domain: shop,
        widget_enabled: true,
        clothing_population_type: "shopify",
        minimized_color: "#000000",
        widget_primary_color: "#111827",
        widget_accent_color: "#6EE7B7",
      });
    if (storeError) {
      throw new Error(
        `[ShopifyBilling] Failed to insert vto_stores for account "${accountId}": ${storeError.message}`,
      );
    }
  }

  // 3b. Copy storefront token from shopify_app.storefront_tokens → vto_stores
  //     The afterAuth hook mints and inserts the token before billing,
  //     but the DB trigger may not fire if vto_stores didn't exist yet.
  try {
    const { data: tokenRow } = await supabaseAdmin
      .schema("shopify_app")
      .from("storefront_tokens")
      .select("storefront_access_token")
      .eq("shop", shop)
      .maybeSingle();

    if (tokenRow?.storefront_access_token) {
      await supabaseAdmin
        .from("vto_stores")
        .update({ storefront_token: tokenRow.storefront_access_token })
        .eq("account_id", accountId);
    }
  } catch (err) {
    console.error(
      `[ShopifyBilling] Failed to copy storefront token for account "${accountId}":`,
      err,
    );
    // Non-fatal — the sync-token endpoint can fix this later
  }

  // 4. Insert or update vto_subscriptions
  let subData: { id: string } | null = null;
  let billingWindow = resolveBillingWindow(plan.interval, billingWindowInput);

  if (shopifySubscriptionId) {
    // Cancel any existing free/dev subscriptions for this account so there's only
    // one active subscription. Without this, the developer_free row from afterAuth
    // stays active alongside the new paid row, and the dashboard may show the wrong plan.
    await supabaseAdmin
      .from("vto_subscriptions")
      .update({ status: "canceled" })
      .eq("account_id", accountId)
      .eq("status", "active")
      .is("shopify_subscription_id", null);

    // Keep only the latest paid Shopify subscription active for this account.
    await supabaseAdmin
      .from("vto_subscriptions")
      .update({ status: "canceled" })
      .eq("account_id", accountId)
      .eq("status", "active")
      .not("shopify_subscription_id", "is", null)
      .neq("shopify_subscription_id", shopifySubscriptionId);

    // Paid plan — find existing row by shopify_subscription_id, or insert a new one.
    const { data: existingPaidSub } = await supabaseAdmin
      .from("vto_subscriptions")
      .select("id")
      .eq("shopify_subscription_id", shopifySubscriptionId)
      .maybeSingle();

    if (existingPaidSub) {
      const { error: updateError } = await supabaseAdmin
        .from("vto_subscriptions")
        .update({
          account_id: accountId,
          plan_id: plan.planId,
          status: "active",
          billing_interval: plan.interval,
          billing_source: "shopify",
          current_period_start: billingWindow.currentPeriodStart,
          current_period_end: billingWindow.currentPeriodEnd,
          ...(shopifyUsageLineItemId ? { shopify_usage_line_item_id: shopifyUsageLineItemId } : {}),
        })
        .eq("id", existingPaidSub.id);
      if (updateError) {
        throw new Error(
          `[ShopifyBilling] Failed to update vto_subscriptions for account "${accountId}": ${updateError.message}`,
        );
      }
      subData = existingPaidSub;
    } else {
      const { data, error: insertError } = await supabaseAdmin
        .from("vto_subscriptions")
        .insert({
          account_id: accountId,
          plan_id: plan.planId,
          status: "active",
          billing_interval: plan.interval,
          billing_source: "shopify",
          shopify_subscription_id: shopifySubscriptionId,
          current_period_start: billingWindow.currentPeriodStart,
          current_period_end: billingWindow.currentPeriodEnd,
          ...(shopifyUsageLineItemId ? { shopify_usage_line_item_id: shopifyUsageLineItemId } : {}),
        })
        .select("id")
        .single();
      if (insertError || !data) {
        throw new Error(
          `[ShopifyBilling] Failed to insert vto_subscriptions for account "${accountId}": ${insertError?.message}`,
        );
      }
      subData = data;
    }
  } else {
    // Free/developer plan — no Shopify subscription ID; select or insert by account
    const { data: existingSub } = await supabaseAdmin
      .from("vto_subscriptions")
      .select("id, current_period_start, current_period_end")
      .eq("account_id", accountId)
      .maybeSingle();
    if (existingSub) {
      billingWindow = resolveBillingWindow(plan.interval, {
        currentPeriodStart: existingSub.current_period_start,
        currentPeriodEnd: existingSub.current_period_end,
      });
      await supabaseAdmin
        .from("vto_subscriptions")
        .update({
          plan_id: plan.planId,
          status: "active",
          billing_interval: plan.interval,
          current_period_start: billingWindow.currentPeriodStart,
          current_period_end: billingWindow.currentPeriodEnd,
        })
        .eq("id", existingSub.id);
      subData = existingSub;
    } else {
      billingWindow = resolveBillingWindow(plan.interval);
      const { data, error: subError } = await supabaseAdmin
        .from("vto_subscriptions")
        .insert({
          account_id: accountId,
          plan_id: plan.planId,
          status: "active",
          billing_interval: plan.interval,
          billing_source: "shopify",
          shopify_subscription_id: null,
          current_period_start: billingWindow.currentPeriodStart,
          current_period_end: billingWindow.currentPeriodEnd,
        })
        .select("id")
        .single();
      if (subError || !data) {
        throw new Error(
          `[ShopifyBilling] Failed to insert vto_subscriptions for account "${accountId}": ${subError?.message}`,
        );
      }
      subData = data;
    }
  }

  // 5. Insert vto_usage_periods for the current billing period
  try {
    await supabaseAdmin
      .from("vto_usage_periods")
      .upsert(
        {
          account_id: accountId,
          subscription_id: subData.id,
          period_start: billingWindow.currentPeriodStart,
          period_end: billingWindow.currentPeriodEnd,
          tryons_used: 0,
          overage_quantity: 0,
          overage_billed: false,
        },
        { onConflict: "subscription_id,period_start", ignoreDuplicates: true },
      );
  } catch (err) {
    console.error(
      `[ShopifyBilling] Failed to insert vto_usage_periods for account "${accountId}":`,
      err,
    );
    // Non-fatal — merchant is already set up, cron can backfill if needed
  }

  return { accountId, storeSlug };
}

// ─── disableShopifyMerchant ───────────────────────────────────────────────────

export async function disableShopifyMerchant(shop: string): Promise<void> {
  const { data: account, error: lookupError } = await supabaseAdmin
    .from("vto_accounts")
    .select("id")
    .eq("shopify_shop_domain", shop)
    .maybeSingle();

  if (lookupError) {
    console.error(
      `[ShopifyBilling] Error looking up account for shop "${shop}":`,
      lookupError.message,
    );
    return;
  }

  if (!account) {
    console.log(
      `[ShopifyBilling] No account found for shop "${shop}" — skipping disable.`,
    );
    return;
  }

  const accountId = account.id as string;

  // Disable widget on all stores for this account
  const { error: storeError } = await supabaseAdmin
    .from("vto_stores")
    .update({ widget_enabled: false })
    .eq("account_id", accountId);

  if (storeError) {
    console.error(
      `[ShopifyBilling] Failed to disable vto_stores for account "${accountId}":`,
      storeError.message,
    );
  }

  // Cancel all Shopify-billed subscriptions for this account
  const { error: subError } = await supabaseAdmin
    .from("vto_subscriptions")
    .update({ status: "canceled" })
    .eq("account_id", accountId)
    .eq("billing_source", "shopify");

  if (subError) {
    console.error(
      `[ShopifyBilling] Failed to cancel vto_subscriptions for account "${accountId}":`,
      subError.message,
    );
  }
}
