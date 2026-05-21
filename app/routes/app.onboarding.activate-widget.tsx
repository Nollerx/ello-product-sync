import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  redirect,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  ProgressBar,
  Box,
  List,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  getOnboardingState,
  preserveShopifyQuery,
  setOnboardingStep,
} from "../lib/onboarding.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { widgetEnabledAt } = await getOnboardingState(session.shop);

  // Open the theme editor's App embeds panel. We intentionally do NOT
  // pre-select a specific block via activateAppId — the per-shop extension
  // UUID isn't stable across deploys/configs, and passing the wrong one
  // surfaces "App embed does not exist" in the editor. Sending the merchant
  // to the App embeds panel is enough: they'll see "Ello AI Virtual Try On"
  // in the panel and toggle it on.
  const themeEditorUrl =
    `https://${session.shop}/admin/themes/current/editor?context=apps`;

  return {
    widgetEnabled: Boolean(widgetEnabledAt),
    themeEditorUrl,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  // Both "continue" and "skip" advance to billing; skip simply leaves
  // widget_enabled_at null so the merchant can come back to enable it later.
  await setOnboardingStep(session.shop, "billing");
  return redirect(`/app/billing${preserveShopifyQuery(url)}`);
};

export default function OnboardingActivateWidget() {
  const { widgetEnabled, themeEditorUrl } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const submitting = navigation.state !== "idle";
  const [openedEditor, setOpenedEditor] = useState(false);

  // When the merchant comes back to this tab (presumably after enabling the
  // block in the theme editor), revalidate so we pick up widget_enabled_at.
  useEffect(() => {
    function onFocus() {
      revalidator.revalidate();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [revalidator]);

  const showContinueAsPrimary = openedEditor || widgetEnabled;

  function handleOpenEditor() {
    setOpenedEditor(true);
    window.open(themeEditorUrl, "_blank", "noopener");
  }

  return (
    <Page fullWidth>
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
            <Text as="p" variant="bodySm" tone="subdued">Step 3 of 4</Text>
            <ProgressBar progress={75} size="small" />
          </BlockStack>
        </Box>

        <div style={{ flex: 1, width: "100%" }}>
          <Card padding="0">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.2fr)",
                alignItems: "stretch",
                minHeight: "calc(100vh - 220px)",
                width: "100%",
              }}
            >
                {/* Left column — instructions */}
                <Box padding="800">
                  <BlockStack gap="600">
                    <BlockStack gap="300">
                      <Text as="h1" variant="heading2xl">
                        Enable the Ello widget on your store
                      </Text>
                      <Text as="p" variant="bodyLg" tone="subdued">
                        Add the Try-On button to your storefront by enabling Ello in your
                        theme settings.
                      </Text>
                    </BlockStack>

                    {widgetEnabled ? (
                      <Banner tone="success" title="Widget is live on your storefront">
                        <Text as="p" variant="bodyMd">
                          We detected the Ello widget on a recent storefront load.
                          You&rsquo;re good to continue.
                        </Text>
                      </Banner>
                    ) : null}

                    <BlockStack gap="300">
                      <Text as="h2" variant="headingLg">How to enable</Text>
                      <List type="number">
                        <List.Item>
                          Click <Text as="span" fontWeight="semibold">Open theme settings</Text> below.
                        </List.Item>
                        <List.Item>
                          In the <Text as="span" fontWeight="semibold">App embeds</Text> panel, toggle{" "}
                          <Text as="span" fontWeight="semibold">Ello AI Virtual Try On</Text> on.
                        </List.Item>
                        <List.Item>
                          Click <Text as="span" fontWeight="semibold">Save</Text> in the top-right
                          of the theme editor.
                        </List.Item>
                        <List.Item>
                          Come back to this tab &mdash; we&rsquo;ll detect it automatically.
                        </List.Item>
                      </List>
                    </BlockStack>
                  </BlockStack>
                </Box>

                {/* Right column — preview image, fully visible (contain) */}
                <div
                  style={{
                    position: "relative",
                    background: "var(--p-color-bg-surface-secondary)",
                    overflow: "hidden",
                    minHeight: "100%",
                    padding: "24px",
                  }}
                >
                  <img
                    src="/onboarding/activate-widget-preview.webp"
                    alt="Shopify theme editor showing the Ello Virtual Try-On app embed toggled on, with the widget visible on a product page"
                    width={1900}
                    height={1134}
                    fetchPriority="high"
                    decoding="async"
                    style={{
                      position: "absolute",
                      inset: "24px",
                      width: "calc(100% - 48px)",
                      height: "calc(100% - 48px)",
                      objectFit: "contain",
                      objectPosition: "center",
                      display: "block",
                      borderRadius: "8px",
                    }}
                  />
                </div>
            </div>
          </Card>
        </div>

        <Box>
          <InlineStack align="space-between" blockAlign="center">
            <Form method="post">
              <input type="hidden" name="intent" value="skip" />
              <Button submit variant="plain" tone="critical">
                Skip for now
              </Button>
            </Form>

            <InlineStack gap="300">
              {showContinueAsPrimary ? (
                <>
                  <Button onClick={handleOpenEditor} size="large">
                    Open theme settings again
                  </Button>
                  <Form method="post">
                    <input type="hidden" name="intent" value="continue" />
                    <Button submit variant="primary" size="large" loading={submitting}>
                      Continue
                    </Button>
                  </Form>
                </>
              ) : (
                <Button onClick={handleOpenEditor} variant="primary" size="large">
                  Open theme settings
                </Button>
              )}
            </InlineStack>
          </InlineStack>
        </Box>
      </div>
    </Page>
  );
}
