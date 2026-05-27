import { useEffect } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Button,
  Banner,
  TextField,
  List,
  Link,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  syncShopifyMerchantToSupabase,
  getPlanConfig,
  extractUsageLineItemId,
  isPaidPlanKey,
  type ActiveSubscriptionSnapshot,
} from "../lib/shopify-billing.server";
import { setOnboardingStep } from "../lib/onboarding.server";

const SHOPIFY_SUBSCRIPTION_FETCH_ATTEMPTS = 5;
const SHOPIFY_SUBSCRIPTION_FETCH_DELAY_MS = 1000;
const CONFIRM_PENDING_REDIRECT_DELAY_MS = 2000;
const MAX_CONFIRM_PENDING_ATTEMPTS = 4;

const ACTIVE_SUBSCRIPTIONS_QUERY = `#graphql
  query ActiveAppSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        createdAt
        currentPeriodEnd
        lineItems {
          id
          plan {
            pricingDetails {
              __typename
              ... on AppUsagePricing {
                terms
              }
            }
          }
        }
      }
    }
  }
`;

function selectPreferredSubscription(
  subscriptions: ActiveSubscriptionSnapshot[],
  intendedPlanKey: string | null,
): ActiveSubscriptionSnapshot | null {
  const sortedSubscriptions = [...subscriptions].sort((left, right) => {
    const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
    return rightTime - leftTime;
  });

  if (isPaidPlanKey(intendedPlanKey)) {
    const exactMatch = sortedSubscriptions.find((subscription) => subscription.name === intendedPlanKey);
    if (exactMatch) return exactMatch;
  }

  return sortedSubscriptions.find((subscription) => isPaidPlanKey(subscription.name)) ?? null;
}

async function fetchActiveSubscription(
  admin: { graphql: (query: string) => Promise<Response> },
  intendedPlanKey: string | null,
  shop: string,
): Promise<ActiveSubscriptionSnapshot | null> {
  for (let attempt = 0; attempt < SHOPIFY_SUBSCRIPTION_FETCH_ATTEMPTS; attempt += 1) {
    const response = await admin.graphql(ACTIVE_SUBSCRIPTIONS_QUERY);
    const json = (await response.json()) as {
      data?: {
        currentAppInstallation?: {
          activeSubscriptions?: ActiveSubscriptionSnapshot[] | null;
        } | null;
      } | null;
    };

    const subscriptions = json?.data?.currentAppInstallation?.activeSubscriptions ?? [];
    const subscriptionNames = subscriptions.map((subscription) => subscription.name ?? "(unnamed)");
    console.log(
      `[BillingConfirm] Shopify subscription check ${attempt + 1}/${SHOPIFY_SUBSCRIPTION_FETCH_ATTEMPTS} for ${shop} (intended: ${intendedPlanKey ?? "unknown"}): ${
        subscriptionNames.length > 0 ? subscriptionNames.join(", ") : "(none)"
      }`,
    );
    const preferredSubscription = selectPreferredSubscription(subscriptions, intendedPlanKey);

    if (preferredSubscription) {
      return preferredSubscription;
    }

    if (attempt < SHOPIFY_SUBSCRIPTION_FETCH_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, SHOPIFY_SUBSCRIPTION_FETCH_DELAY_MS));
    }
  }

  return null;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  // authenticate.admin can throw a Response for auth redirects — let that propagate.
  const { session, admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const intendedPlanKey = url.searchParams.get("plan");
  const attemptValue = Number.parseInt(url.searchParams.get("attempt") ?? "0", 10);
  const attempt = Number.isFinite(attemptValue) && attemptValue >= 0 ? attemptValue : 0;
  const normalizedPlanKey = isPaidPlanKey(intendedPlanKey) ? intendedPlanKey : null;

  const nextConfirmUrl = new URL(request.url);
  nextConfirmUrl.searchParams.set("attempt", String(attempt + 1));

  const buildActivationUrl = (planKey: string | null) => {
    const activationUrl = new URL("/app", url.origin);
    for (const key of ["shop", "host", "embedded", "id_token"]) {
      const value = url.searchParams.get(key);
      if (value) activationUrl.searchParams.set(key, value);
    }
    activationUrl.searchParams.set("billing", "activating");
    if (planKey) {
      activationUrl.searchParams.set("plan", planKey);
    }
    return activationUrl.toString();
  };

  const pendingResponse = (planKey: string | null) => ({
    status: "pending" as const,
    intendedPlanKey: planKey,
    pendingPlanDisplayName: planKey ? getPlanConfig()[planKey]?.displayName ?? null : null,
    attempt,
    nextConfirmUrl: nextConfirmUrl.toString(),
    activationUrl: buildActivationUrl(planKey),
    shouldRedirectToApp: attempt >= MAX_CONFIRM_PENDING_ATTEMPTS,
  });

  // Wrap the core logic in try-catch so unexpected errors (GraphQL failures,
  // network timeouts, etc.) fall back to the activation flow on the dashboard
  // instead of rendering a blank page. The resilient sync in the billing gate
  // (app.tsx) will pick up the un-synced subscription on the next page load.
  try {
    let activePlanKey: string | null = null;
    let shopifySubscriptionId: string | null = null;
    let shopifyUsageLineItemId: string | null = null;
    let currentPeriodEnd: string | null = null;

    if (intendedPlanKey === "developer_free") {
      activePlanKey = "developer_free";
    } else {
      const activeSubscription = await fetchActiveSubscription(admin, intendedPlanKey, session.shop);

      if (!activeSubscription || !isPaidPlanKey(activeSubscription.name)) {
        return pendingResponse(normalizedPlanKey);
      }

      activePlanKey = activeSubscription.name;
      shopifySubscriptionId = activeSubscription.id ?? null;
      shopifyUsageLineItemId = extractUsageLineItemId(activeSubscription);
      currentPeriodEnd = activeSubscription.currentPeriodEnd ?? null;
    }

    // 1. Get merchant email from Shopify Admin GraphQL
    const shopResponse = await admin.graphql(`
      query {
        shop {
          email
          name
        }
      }
    `);
    const shopJson = await shopResponse.json();
    const shopEmail = shopJson?.data?.shop?.email ?? session.shop;

    // 2. Sync to Supabase — if Shopify has approved the subscription but our DB is
    //    still catching up, stay on this confirmation route and retry on refresh.
    let storeSlug: string = session.shop;
    try {
      const result = await syncShopifyMerchantToSupabase(
        session.shop,
        shopEmail,
        activePlanKey!,
        shopifySubscriptionId ?? undefined,
        shopifyUsageLineItemId,
        { currentPeriodEnd },
      );
      storeSlug = result.storeSlug;
    } catch (err) {
      console.error(`[BillingConfirm] syncShopifyMerchantToSupabase failed on attempt ${attempt}:`, err);
      return pendingResponse(isPaidPlanKey(activePlanKey) ? activePlanKey : normalizedPlanKey);
    }

    // 3. Get plan display info
    const planConfig = getPlanConfig();
    const planMeta = planConfig[activePlanKey];

    // Mark onboarding complete — billing approval is the final step.
    await setOnboardingStep(session.shop, "complete");

    return {
      status: "active" as const,
      storeSlug,
      planMeta,
      shopEmail,
    };
  } catch (err) {
    // Re-throw Response objects (auth redirects, etc.) so React Router handles them.
    if (err instanceof Response) throw err;
    console.error(`[BillingConfirm] Unexpected error in loader for ${session.shop}:`, err);
    // Fall back to pending → activation URL which sends the user to the dashboard.
    // The resilient sync in app.tsx will handle syncing the subscription.
    return pendingResponse(normalizedPlanKey);
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function BillingConfirmPage() {
  const data = useLoaderData<typeof loader>();

  useEffect(() => {
    if (data.status !== "pending") return undefined;

    const timeoutId = window.setTimeout(() => {
      window.location.replace(data.shouldRedirectToApp ? data.activationUrl : data.nextConfirmUrl);
    }, CONFIRM_PENDING_REDIRECT_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [data]);

  if (data.status === "pending") {
    return (
      <Page title="Finalizing your plan">
        <Layout>
          <Layout.Section>
            <BlockStack gap="500">
              <Banner title="Your subscription was approved" tone="success">
                <Text as="p" variant="bodyMd">
                  {data.pendingPlanDisplayName
                    ? `We’re activating your ${data.pendingPlanDisplayName} plan now.`
                    : "We’re activating your plan now."}{" "}
                  {data.shouldRedirectToApp
                    ? "This is taking longer than expected, so we’ll take you back to the app and keep checking there."
                    : "This usually finishes within a few seconds."}
                </Text>
              </Banner>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">What happens next</Text>
                  <List type="bullet">
                    <List.Item>We confirm the active Shopify subscription.</List.Item>
                    <List.Item>We sync the plan into your Ello account.</List.Item>
                    <List.Item>
                      {data.shouldRedirectToApp
                        ? "We’ll return you to the app while activation continues in the background."
                        : "This page refreshes automatically while setup completes."}
                    </List.Item>
                  </List>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  const { storeSlug, planMeta, shopEmail } = data;
  const dashboardUrl = `https://dashboard.ello.services/login?slug=${storeSlug}`;
  const intervalLabel = planMeta?.interval === "year" ? "year" : "month";

  return (
    <Page title="Welcome to Ello!">
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">

            {/* Success banner */}
            <Banner title="You're all set — welcome to Ello!" tone="success">
              <Text as="p" variant="bodyMd">
                Your {planMeta?.displayName} plan ({intervalLabel}ly billing) is now active.
              </Text>
            </Banner>

            {/* Dashboard access */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Your Dashboard Login</Text>
                <Text as="p" variant="bodyMd">
                  Use these credentials to log into the Ello dashboard. Bookmark this page.
                </Text>
                <TextField
                  label="Store Slug"
                  value={storeSlug}
                  readOnly
                  autoComplete="off"
                />
                <TextField
                  label="Login Email"
                  value={shopEmail}
                  readOnly
                  autoComplete="off"
                />
                <Button
                  variant="primary"
                  size="large"
                  url="/app"
                >
                  Return to Ello App
                </Button>
                <Button
                  size="large"
                  url={dashboardUrl}
                  target="_blank"
                >
                  Open Ello Dashboard
                </Button>
              </BlockStack>
            </Card>

            {/* Next steps */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Next Steps</Text>
                <List type="number">
                  <List.Item>
                    <Text as="span" variant="bodyMd">
                      Log into your dashboard at{" "}
                      <Link url={dashboardUrl} target="_blank">
                        dashboard.ello.services
                      </Link>{" "}
                      using your store slug and email above
                    </Text>
                  </List.Item>
                  <List.Item>
                    <Text as="span" variant="bodyMd">
                      Go to the <strong>Installation</strong> page to get your API key
                    </Text>
                  </List.Item>
                  <List.Item>
                    <Text as="span" variant="bodyMd">
                      Add the widget to your storefront —{" "}
                      <Link
                        url="https://www.loom.com/share/e86c1862a6444b2c8971f49200fe7cc9"
                        target="_blank"
                      >
                        watch the setup video →
                      </Link>
                    </Text>
                  </List.Item>
                </List>
              </BlockStack>
            </Card>

          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
