import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData, useNavigation } from "react-router";
import {
  Page,
  Layout,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { setOnboardingStep, preserveShopifyQuery } from "../lib/onboarding.server";
import { CalendlyEmbed, EnterprisePillarsGrid } from "../components/enterprise-panel";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { shop: session.shop };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  await setOnboardingStep(session.shop, "configure");
  return redirect(`/app/onboarding/configure${preserveShopifyQuery(url)}`);
};

export default function OnboardingEnterprise() {
  const { shop } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";
  const [booked, setBooked] = useState(false);

  return (
    <Page fullWidth>
      <Layout>
        <Layout.Section>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(380px, 0.9fr) minmax(420px, 1.1fr)",
              gap: 28,
              alignItems: "start",
              padding: "12px 4px",
            }}
          >
            <BlockStack gap="500">
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" tone="subdued">
                  ENTERPRISE — WHAT WE PRIORITIZE
                </Text>
                <Text as="h1" variant="headingXl">
                  You qualify for a custom enterprise deal
                </Text>
                <Text as="p" tone="subdued">
                  At your volume, self-serve tiers sell you short. Every enterprise
                  partnership is built on custom, ROI-focused deliverables — sized to
                  your traffic and designed to give your shoppers the best try-on
                  experience anywhere. Grab a time on the right and we'll take it
                  from there.
                </Text>
              </BlockStack>

              <EnterprisePillarsGrid />

              {booked ? (
                <Banner tone="success" title="Call booked — we'll take it from here">
                  <Text as="p" variant="bodyMd">
                    You'll get a confirmation email. You can keep going with the
                    widget setup in the meantime.
                  </Text>
                </Banner>
              ) : null}

              <InlineStack align="start">
                <Form method="post">
                  <Button
                    submit
                    variant={booked ? "primary" : "plain"}
                    loading={submitting}
                  >
                    {booked ? "Continue widget setup" : "Continue setup for now"}
                  </Button>
                </Form>
              </InlineStack>
            </BlockStack>

            <CalendlyEmbed
              shop={shop}
              source="app_onboarding"
              height={680}
              onBooked={() => setBooked(true)}
            />
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
