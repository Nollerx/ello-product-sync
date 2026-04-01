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
  const isBillingActivationRequest =
    url.pathname === "/app" && url.searchParams.get("billing") === "activating";

  // eslint-disable-next-line no-undef
  if (!isBillingRoute && process.env.SKIP_BILLING !== "true") {
    // Detect development stores — they can use the developer_free plan
    let isDevStore = false;
    try {
      const shopResp = await admin.graphql(`query { shop { plan { partnerDevelopment } } }`);
      const shopJson = await shopResp.json();
      isDevStore = shopJson?.data?.shop?.plan?.partnerDevelopment === true;
    } catch (err) {
      console.error("[BillingGate] Failed to detect dev store:", err);
    }

    // Check if merchant has an active Supabase subscription.
    // For dev stores: any active subscription (including developer_free) passes the gate.
    // For real stores: only paid subscriptions (with shopify_subscription_id) pass.
    let hasActiveSub = false;
    try {
      const { data: account } = await supabaseAdmin
        .from("vto_accounts")
        .select("id")
        .eq("shopify_shop_domain", session.shop)
        .maybeSingle();
      if (account) {
        if (isDevStore) {
          // Dev stores: any active subscription passes (including developer_free)
          const { data: activeSub } = await supabaseAdmin
            .from("vto_subscriptions")
            .select("id")
            .eq("account_id", account.id)
            .eq("status", "active")
            .limit(1)
            .maybeSingle();
          hasActiveSub = !!activeSub;
        } else {
          // Production stores: only paid subscriptions with shopify_subscription_id
          const { data: activeSub } = await supabaseAdmin
            .from("vto_subscriptions")
            .select("id")
            .eq("account_id", account.id)
            .eq("status", "active")
            .not("shopify_subscription_id", "is", null)
            .maybeSingle();
          hasActiveSub = !!activeSub;
        }
      }
    } catch (err) {
      console.error("[BillingGate] Supabase check failed (falling back to Shopify billing):", err);
    }

    const syncActiveSubscription = async (
      activeSub: ActiveSubscriptionSnapshot | null | undefined,
      source: "activation" | "resilient",
    ) => {
      if (!activeSub?.name) return;

      try {
        const shopQuery = await admin.graphql(`query { shop { email } }`);
        const shopJson = await shopQuery.json();
        const shopEmail = shopJson?.data?.shop?.email ?? session.shop;
        const usageLineItemId = extractUsageLineItemId(activeSub);

        await syncShopifyMerchantToSupabase(
          session.shop,
          shopEmail,
          activeSub.name,
          activeSub.id ?? null,
          usageLineItemId,
          { currentPeriodEnd: activeSub.currentPeriodEnd ?? null },
        );
        console.log(`[BillingGate] ${source} sync completed for ${session.shop} (plan: ${activeSub.name})`);
      } catch (err) {
        console.error(`[BillingGate] ${source} sync failed (non-fatal):`, err);
      }
    };

    if (!hasActiveSub) {
      if (isBillingActivationRequest) {
        const billingCheck = await billing.check({ plans: [...PAID_BILLING_PLANS] });
        const activeSub = billingCheck?.appSubscriptions?.[0] as ActiveSubscriptionSnapshot | undefined;

        if (activeSub?.name) {
          await syncActiveSubscription(activeSub, "activation");
        } else {
          console.log(`[BillingGate] Activation mode still pending for ${session.shop}`);
        }
      } else {
        // billing.require() — if this passes, the merchant has an active Shopify subscription.
        // Capture the result so we can sync to Supabase if the billing/confirm page was skipped.
        const billingCheck = await billing.require({
          plans: [...PAID_BILLING_PLANS],
          onFailure: async () => {
            const billingParams = new URLSearchParams();
            for (const key of ["shop", "host", "embedded", "id_token"]) {
              const val = url.searchParams.get(key);
              if (val) billingParams.set(key, val);
            }
            return redirect(`/app/billing?${billingParams.toString()}`);
          },
        });

        // ── Resilient sync: billing.require() passed but Supabase has no record ──
        // This handles the case where the billing/confirm page was skipped (e.g. session
        // lost during the billing redirect, re-auth redirected to /app instead).
        const activeSub = billingCheck?.appSubscriptions?.[0] as ActiveSubscriptionSnapshot | undefined;
        await syncActiveSubscription(activeSub, "resilient");
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
