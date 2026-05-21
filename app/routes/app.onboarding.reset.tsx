import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Button,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../lib/supabase.server";
import { preserveShopifyQuery } from "../lib/onboarding.server";

async function isDevStore(admin: { graphql: (q: string) => Promise<Response> }): Promise<boolean> {
  try {
    const resp = await admin.graphql(`query { shop { plan { partnerDevelopment } } }`);
    const json = await resp.json();
    return json?.data?.shop?.plan?.partnerDevelopment === true;
  } catch {
    return false;
  }
}

function envTestMode(): boolean {
  // eslint-disable-next-line no-undef
  return process.env.BILLING_TEST_MODE === "true" || process.env.SKIP_BILLING === "true";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const dev = await isDevStore(admin);
  return {
    canReset: dev || envTestMode(),
    shop: session.shop,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const dev = await isDevStore(admin);
  if (!dev && !envTestMode()) {
    return { error: "Reset is only available on Shopify dev stores or when BILLING_TEST_MODE is enabled." };
  }

  const { error } = await supabaseAdmin
    .from("vto_stores")
    .update({
      onboarding_step: "welcome",
      onboarding_started_at: null,
      widget_enabled_at: null,
      onboarding_completed_at: null,
    })
    .eq("shop_domain", session.shop);

  if (error) {
    console.error(`[OnboardingReset] update failed for ${session.shop}:`, error.message);
    return { error: `Reset failed: ${error.message}` };
  }

  console.log(`[OnboardingReset] Reset onboarding for ${session.shop}`);
  const url = new URL(request.url);
  return redirect(`/app/onboarding/welcome${preserveShopifyQuery(url)}`);
};

export default function OnboardingReset() {
  const { canReset, shop } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";

  return (
    <Page title="Reset onboarding (dev tool)">
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {!canReset ? (
              <Banner tone="critical" title="Reset blocked">
                <Text as="p" variant="bodyMd">
                  This shop is not a Shopify dev store, and <code>BILLING_TEST_MODE</code> is not
                  enabled. Reset is disabled to prevent accidental use on a real merchant.
                </Text>
              </Banner>
            ) : (
              <Banner tone="warning" title="Dev tool">
                <Text as="p" variant="bodyMd">
                  This wipes onboarding state for <strong>{shop}</strong> and sends you back to step 1.
                </Text>
              </Banner>
            )}

            {actionData?.error ? (
              <Banner tone="critical" title="Reset failed">
                <Text as="p" variant="bodyMd">{actionData.error}</Text>
              </Banner>
            ) : null}

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">What this does</Text>
                <Text as="p" variant="bodyMd">
                  Sets <code>onboarding_step</code> back to <code>welcome</code> and clears
                  <code> onboarding_started_at</code>, <code> widget_enabled_at</code>, and
                  <code> onboarding_completed_at</code> for the current shop. Subscriptions are
                  not touched &mdash; cancel any active sub in Shopify admin if you also want to
                  retest billing.
                </Text>
                <Form method="post">
                  <Button
                    submit
                    variant="primary"
                    tone="critical"
                    size="large"
                    loading={submitting}
                    disabled={!canReset || submitting}
                  >
                    Reset onboarding for this shop
                  </Button>
                </Form>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
