import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, redirect, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import polarisTranslations from "@shopify/polaris/locales/en.json";

import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../lib/supabase.server";
import {
  extractUsageLineItemId,
  syncShopifyMerchantToSupabase,
  type ActiveSubscriptionSnapshot,
} from "../lib/shopify-billing.server";
import {
  ONBOARDING_ROUTE_BY_STEP,
  getOnboardingState,
  preserveShopifyQuery,
} from "../lib/onboarding.server";

const PAID_BILLING_PLANS = [
  "starter_monthly",         "starter_annual",
  "launch_monthly",          "launch_annual",
  "growth_monthly",          "growth_annual",
  "growth_plus_monthly",     "growth_plus_annual",
  "pro_monthly",             "pro_annual",
  "pro_plus_monthly",        "pro_plus_annual",
  "enterprise_monthly",      "enterprise_annual",
  "enterprise_plus_monthly", "enterprise_plus_annual",
] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session, admin } = await authenticate.admin(request);

  // Skip the billing gate for the billing pages themselves to avoid an infinite redirect loop.
  // app.billing.tsx and app.billing.confirm.tsx are child routes of this layout,
  // so this loader runs for every /app/* URL.
  const url = new URL(request.url);
  const isBillingRoute = url.pathname.startsWith("/app/billing");
  const isOnboardingRoute = url.pathname.startsWith("/app/onboarding");
  const isBillingActivationRequest =
    url.pathname === "/app" && url.searchParams.get("billing") === "activating";

  // Onboarding gate — new installs walk through /app/onboarding/* before
  // anything else. Existing merchants have onboarding_step='complete' (set by
  // the 20260514_onboarding_steps.sql migration), so this is a no-op for them.
  // eslint-disable-next-line no-undef
  if (!isOnboardingRoute && !isBillingRoute && process.env.SKIP_BILLING !== "true") {
    try {
      const { step } = await getOnboardingState(session.shop);
      if (step === "welcome" || step === "activate_widget" || step === "configure") {
        throw redirect(`${ONBOARDING_ROUTE_BY_STEP[step]}${preserveShopifyQuery(url)}`);
      }
    } catch (err) {
      if (err instanceof Response) throw err;
      console.error("[OnboardingGate] check failed (non-fatal):", err);
    }
  }

  // eslint-disable-next-line no-undef
  if (!isBillingRoute && process.env.SKIP_BILLING !== "true") {
    // Look up the Supabase subscription:
    //   - shopifySubId: to detect paid-plan changes on Shopify and re-sync
    //   - hasActiveSub: any active sub (paid or free: ello_free / developer_free)
    //                   — if present, the merchant has been provisioned, so
    //                   the gate allows them through even without a paid Shopify sub.
    let supabaseShopifySubId: string | null = null;
    let hasActiveSub = false;
    try {
      const { data: account } = await supabaseAdmin
        .from("vto_accounts")
        .select("id")
        .eq("shopify_shop_domain", session.shop)
        .maybeSingle();
      if (account) {
        const { data: activeSub } = await supabaseAdmin
          .from("vto_subscriptions")
          .select("shopify_subscription_id")
          .eq("account_id", account.id)
          .eq("status", "active")
          .order("shopify_subscription_id", { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle();
        if (activeSub) {
          hasActiveSub = true;
          supabaseShopifySubId = activeSub.shopify_subscription_id ?? null;
        }
      }
    } catch (err) {
      console.error("[BillingGate] Supabase check failed:", err);
    }

    // Always check Shopify for the current active subscription.
    // This single check handles: initial activation, plan changes, and resilient sync.
    try {
      const billingCheck = await billing.check({ plans: [...PAID_BILLING_PLANS] });
      const shopifySub = billingCheck?.appSubscriptions?.[0] as ActiveSubscriptionSnapshot | undefined;

      if (shopifySub?.name) {
        // Shopify has an active paid subscription.
        // Sync to Supabase if it's new or changed (different subscription ID).
        if (supabaseShopifySubId !== shopifySub.id) {
          try {
            const shopQuery = await admin.graphql(`query { shop { email } }`);
            const shopJson = await shopQuery.json();
            const shopEmail = shopJson?.data?.shop?.email ?? session.shop;
            const usageLineItemId = extractUsageLineItemId(shopifySub);

            await syncShopifyMerchantToSupabase(
              session.shop,
              shopEmail,
              shopifySub.name,
              shopifySub.id ?? null,
              usageLineItemId,
              { currentPeriodEnd: shopifySub.currentPeriodEnd ?? null },
            );
            console.log(`[BillingGate] Sync completed for ${session.shop} (plan: ${shopifySub.name})`);
          } catch (err) {
            console.error(`[BillingGate] Sync failed (non-fatal):`, err);
          }
        }
        // Subscription is active on Shopify — allow through
      } else if (isBillingActivationRequest) {
        // Billing just approved but Shopify hasn't activated yet — let dashboard show pending banner
        console.log(`[BillingGate] Activation still pending for ${session.shop}`);
      } else if (hasActiveSub) {
        // No paid Shopify sub, but an active Supabase sub exists (ello_free /
        // developer_free / custom_distribution). Allow through — the merchant
        // can upgrade from the dashboard.
      } else {
        // No paid sub and no Supabase sub — redirect to billing (afterAuth likely failed)
        const billingParams = new URLSearchParams();
        for (const key of ["shop", "host", "embedded", "id_token"]) {
          const val = url.searchParams.get(key);
          if (val) billingParams.set(key, val);
        }
        throw redirect(`/app/billing?${billingParams.toString()}`);
      }
    } catch (err) {
      // Re-throw redirects so React Router processes them
      if (err instanceof Response) throw err;
      console.error("[BillingGate] Shopify billing check failed:", err);
      // If billing check fails: allow through if we have any active Supabase sub,
      // otherwise redirect to billing
      if (!hasActiveSub && !isBillingActivationRequest) {
        const billingParams = new URLSearchParams();
        for (const key of ["shop", "host", "embedded", "id_token"]) {
          const val = url.searchParams.get(key);
          if (val) billingParams.set(key, val);
        }
        throw redirect(`/app/billing?${billingParams.toString()}`);
      }
    }
  }

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={polarisTranslations}>
        <s-app-nav>
          <s-link href="/app">Home</s-link>
          <s-link href="/app/additional">Additional page</s-link>
        </s-app-nav>
        <Outlet />
      </PolarisAppProvider>
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
