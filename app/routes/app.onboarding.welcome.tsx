import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useNavigation } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  ProgressBar,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { setOnboardingStep, preserveShopifyQuery } from "../lib/onboarding.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  await setOnboardingStep(session.shop, "segment");
  return redirect(`/app/onboarding/segment${preserveShopifyQuery(url)}`);
};

export default function OnboardingWelcome() {
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";

  return (
    <Page>
      <Layout>
        <Layout.Section>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 20,
              minHeight: "calc(100vh - 120px)",
            }}
          >
            <Box>
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" tone="subdued">Step 1 of 5</Text>
                <ProgressBar progress={20} size="small" />
              </BlockStack>
            </Box>

            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: "100%",
              }}
            >
              <div style={{ width: "100%" }}>
                <Card padding="0">
                  <img
                    src="/onboarding/welcome-hero.webp"
                    alt="Welcome to Ello — turn browsers into buyers with AI Virtual Try-On"
                    width={1537}
                    height={1023}
                    fetchPriority="high"
                    decoding="async"
                    style={{
                      width: "100%",
                      height: "auto",
                      display: "block",
                      borderRadius: "var(--p-border-radius-300)",
                    }}
                  />
                </Card>
              </div>
            </div>

            <InlineStack align="end">
              <Form method="post">
                <Button submit variant="primary" size="large" loading={submitting}>
                  Continue
                </Button>
              </Form>
            </InlineStack>
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
