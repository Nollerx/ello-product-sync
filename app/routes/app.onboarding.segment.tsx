import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData, useNavigation } from "react-router";
import { useState } from "react";
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
  Banner,
  RadioButton,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../lib/supabase.server";
import { setOnboardingStep, preserveShopifyQuery } from "../lib/onboarding.server";
import { sendTelegramMessage, escapeHtml } from "../lib/telegram.server";

type Segment = "small" | "mid" | "enterprise";

const SEGMENT_OPTIONS: Array<{ value: Segment; label: string; helpText: string }> = [
  {
    value: "small",
    label: "Under $250K per year",
    helpText: "Getting started or growing — self-serve plans fit best.",
  },
  {
    value: "mid",
    label: "$250K – $1M per year",
    helpText: "Established store with steady traffic.",
  },
  {
    value: "enterprise",
    label: "Over $1M per year",
    helpText: "High-volume brand — you qualify for a custom enterprise deal.",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  let isShopifyPlus = false;
  try {
    const { data } = await supabaseAdmin
      .from("vto_stores")
      .select("shopify_plan")
      .eq("shop_domain", session.shop)
      .maybeSingle();
    isShopifyPlus = (data?.shopify_plan ?? "").toLowerCase().includes("plus");
  } catch {
    // Non-fatal — the banner is just a hint.
  }

  return { isShopifyPlus };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const formData = await request.formData();
  const raw = String(formData.get("segment") ?? "");
  const segment: Segment = raw === "enterprise" || raw === "mid" ? (raw as Segment) : "small";

  const { error } = await supabaseAdmin
    .from("vto_stores")
    .update({ merchant_segment: segment })
    .eq("shop_domain", session.shop);
  if (error) {
    console.error("[Onboarding] failed to save merchant_segment:", error.message);
  }

  if (segment === "enterprise") {
    await setOnboardingStep(session.shop, "enterprise");
    // High-intent signal — a store just self-identified as $1M+/yr.
    sendTelegramMessage(
      `🔥 <b>Enterprise-size store in onboarding</b>\n${escapeHtml(session.shop)} said they do $1M+/yr. They're being routed to book a setup call.`,
    ).catch(() => {});
    return redirect(`/app/onboarding/enterprise${preserveShopifyQuery(url)}`);
  }

  await setOnboardingStep(session.shop, "configure");
  return redirect(`/app/onboarding/configure${preserveShopifyQuery(url)}`);
};

export default function OnboardingSegment() {
  const { isShopifyPlus } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";
  const [segment, setSegment] = useState<Segment>(isShopifyPlus ? "enterprise" : "small");

  return (
    <Page>
      <Layout>
        <Layout.Section>
          <Form method="post">
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
                  <Text as="p" variant="bodySm" tone="subdued">Step 2 of 5</Text>
                  <ProgressBar progress={40} size="small" />
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
              <div style={{ width: "100%", maxWidth: 640 }}>
                <Card>
                  <BlockStack gap="500">
                    <BlockStack gap="200">
                      <Text as="h1" variant="headingLg">
                        How big is your store?
                      </Text>
                      <Text as="p" tone="subdued">
                        This helps us point you to the right setup — self-serve plans, or a
                        custom deal built around your volume.
                      </Text>
                    </BlockStack>

                    {isShopifyPlus && (
                      <Banner tone="info">
                        Looks like you're on Shopify Plus — you qualify for our enterprise
                        program.
                      </Banner>
                    )}

                      <BlockStack gap="300">
                        {SEGMENT_OPTIONS.map((option) => (
                          <div
                            key={option.value}
                            onClick={() => setSegment(option.value)}
                            style={{
                              border:
                                segment === option.value
                                  ? "2px solid var(--p-color-border-emphasis)"
                                  : "1px solid var(--p-color-border)",
                              borderRadius: "var(--p-border-radius-300)",
                              padding: "16px",
                              cursor: "pointer",
                              background:
                                segment === option.value
                                  ? "var(--p-color-bg-surface-selected)"
                                  : "var(--p-color-bg-surface)",
                            }}
                          >
                            <RadioButton
                              label={option.label}
                              helpText={option.helpText}
                              checked={segment === option.value}
                              id={`segment-${option.value}`}
                              name="segment"
                              value={option.value}
                              onChange={() => setSegment(option.value)}
                            />
                          </div>
                        ))}
                      </BlockStack>
                  </BlockStack>
                </Card>
              </div>
            </div>

              <InlineStack align="end">
                <Button submit variant="primary" size="large" loading={submitting}>
                  Continue
                </Button>
              </InlineStack>
            </div>
          </Form>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
