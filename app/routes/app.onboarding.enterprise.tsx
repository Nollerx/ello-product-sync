import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData, useNavigation } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Box,
  InlineGrid,
  Icon,
} from "@shopify/polaris";
import {
  MagicIcon,
  AdjustIcon,
  ChartVerticalFilledIcon,
  LayoutBlockIcon,
} from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { setOnboardingStep, preserveShopifyQuery } from "../lib/onboarding.server";

const CALENDLY_BASE = "https://calendly.com/andrew-ello/ello-setup-call";

const PILLARS = [
  {
    icon: MagicIcon,
    title: "White-glove setup",
    description:
      "We install, configure, and match the widget to your theme. Zero dev work on your side.",
  },
  {
    icon: AdjustIcon,
    title: "Custom volume & pricing",
    description:
      "Try-on volume sized to your traffic, with pricing to match — not fixed tiers.",
  },
  {
    icon: ChartVerticalFilledIcon,
    title: "Attributed-revenue proof",
    description:
      "A/B holdout testing that measures the revenue lift try-on actually drives.",
  },
  {
    icon: LayoutBlockIcon,
    title: "Premium placements",
    description:
      "Complete the Look, PDP image swap, fitting-room hub, and custom branding.",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  // Tag the booking with the shop so the Calendly notification identifies who booked.
  const calendlyUrl = `${CALENDLY_BASE}?utm_source=app_onboarding&utm_campaign=${encodeURIComponent(session.shop)}`;
  return { calendlyUrl };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  await setOnboardingStep(session.shop, "configure");
  return redirect(`/app/onboarding/configure${preserveShopifyQuery(url)}`);
};

export default function OnboardingEnterprise() {
  const { calendlyUrl } = useLoaderData<typeof loader>();
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
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: "100%",
              }}
            >
              <div style={{ width: "100%", maxWidth: 720 }}>
                <Card>
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
                        experience anywhere.
                      </Text>
                    </BlockStack>

                    <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                      {PILLARS.map((pillar) => (
                        <Box
                          key={pillar.title}
                          background="bg-surface-secondary"
                          borderRadius="300"
                          padding="400"
                        >
                          <BlockStack gap="200">
                            <Icon source={pillar.icon} tone="primary" />
                            <Text as="h3" variant="headingSm">
                              {pillar.title}
                            </Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {pillar.description}
                            </Text>
                          </BlockStack>
                        </Box>
                      ))}
                    </InlineGrid>

                    <BlockStack gap="300">
                      <Button
                        url={calendlyUrl}
                        external
                        target="_blank"
                        variant="primary"
                        size="large"
                        fullWidth
                      >
                        Book your setup call — 30 minutes with the founder
                      </Button>
                      <InlineStack align="center">
                        <Form method="post">
                          <Button submit variant="plain" loading={submitting}>
                            Or continue with self-serve setup instead
                          </Button>
                        </Form>
                      </InlineStack>
                    </BlockStack>
                  </BlockStack>
                </Card>
              </div>
            </div>
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
