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
  getAppEmbedEditorUrl,
  preserveShopifyQuery,
  setOnboardingStep,
} from "../lib/onboarding.server";
import { getThemeWidgetStatus } from "../lib/theme-status.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // Live theme read tells us if the embed is actually on (not a one-way DB flag).
  const themeStatus = await getThemeWidgetStatus(admin);

  // Deep link opens the App embeds panel with our embed pre-selected via
  // activateAppId={api_key}/{block-handle} — the api_key (== client_id) is the
  // correct, stable identifier (the extension-UUID form is deprecated).
  const themeEditorUrl = getAppEmbedEditorUrl(session.shop);

  return {
    widgetEnabled: themeStatus.appEmbedEnabled === true,
    scopeMissing: themeStatus.reason === "missing_scope",
    themeEditorUrl,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  // Both "continue" and "skip" advance to placements; skip simply leaves
  // widget_enabled_at null so the merchant can come back to enable it later.
  await setOnboardingStep(session.shop, "placements");
  return redirect(`/app/onboarding/placements${preserveShopifyQuery(url)}`);
};

export default function OnboardingActivateWidget() {
  const { widgetEnabled, scopeMissing, themeEditorUrl } = useLoaderData<typeof loader>();
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
            <Text as="p" variant="bodySm" tone="subdued">Step 3 of 5</Text>
            <ProgressBar progress={60} size="small" />
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

                    {scopeMissing ? (
                      <Banner tone="warning" title="Reload to verify your widget status">
                        <Text as="p" variant="bodyMd">
                          Ello needs a one-time permission to read your theme and confirm the
                          widget is on. Reload this page to grant it.
                        </Text>
                        <Box paddingBlockStart="200">
                          <Button onClick={() => window.location.reload()} size="slim">
                            Reload &amp; verify
                          </Button>
                        </Box>
                      </Banner>
                    ) : widgetEnabled ? (
                      <Banner tone="success" title="Widget is live on your storefront">
                        <Text as="p" variant="bodyMd">
                          We detected the Ello widget enabled on your published theme.
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
