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
  Checkbox,
  Badge,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  getInlineTryOnBlockEditorUrl,
  preserveShopifyQuery,
  setOnboardingStep,
} from "../lib/onboarding.server";
import { supabaseAdmin } from "../lib/supabase.server";

type PlacementSettings = {
  inlineEnabled: boolean;
  floatingNonPdpEnabled: boolean;
  floatingPdpEnabled: boolean;
  previewEnabled: boolean;
};

type PreviewMode = "inline" | "theme";

const DEFAULT_BRAND_COLOR = "#111827";

function normalizeHex(input: string | null | undefined): string {
  const trimmed = input?.trim() ?? "";
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  return DEFAULT_BRAND_COLOR;
}

function readableTextColor(hex: string): "#000000" | "#FFFFFF" {
  const normalized = normalizeHex(hex).replace("#", "");
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? "#000000" : "#FFFFFF";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const { data, error } = await supabaseAdmin
    .from("vto_stores")
    .select(
      "inline_button_enabled, floating_widget_non_pdp_enabled, floating_widget_pdp_enabled, desktop_preview_enabled, widget_enabled_at, inline_button_color, minimized_color, widget_primary_color",
    )
    .eq("shop_domain", session.shop)
    .maybeSingle();

  if (error) {
    console.error("[Onboarding placements] read error:", error.message);
  }

  const settings: PlacementSettings = {
    inlineEnabled: data?.inline_button_enabled ?? true,
    floatingNonPdpEnabled: data?.floating_widget_non_pdp_enabled ?? true,
    floatingPdpEnabled: data?.floating_widget_pdp_enabled ?? false,
    previewEnabled: data?.desktop_preview_enabled ?? true,
  };

  return {
    settings,
    widgetEnabled: Boolean(data?.widget_enabled_at),
    brandColor: normalizeHex(
      data?.inline_button_color ??
        data?.minimized_color ??
        data?.widget_primary_color,
    ),
    themeEditorUrl: getInlineTryOnBlockEditorUrl(session.shop),
    appEmbedUrl: `https://${session.shop}/admin/themes/current/editor?context=apps`,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "continue") {
    const patch = {
      inline_button_enabled: formData.get("inline_enabled") === "on",
      floating_widget_non_pdp_enabled:
        formData.get("floating_non_pdp_enabled") === "on",
      floating_widget_pdp_enabled:
        formData.get("floating_pdp_enabled") === "on",
      desktop_preview_enabled: formData.get("preview_enabled") === "on",
      placements_banner_dismissed_at: new Date().toISOString(),
    };

    const { error } = await supabaseAdmin
      .from("vto_stores")
      .update(patch)
      .eq("shop_domain", session.shop);

    if (error) {
      console.error("[Onboarding placements] write error:", error.message);
    }
  } else {
    const { error } = await supabaseAdmin
      .from("vto_stores")
      .update({ placements_banner_dismissed_at: new Date().toISOString() })
      .eq("shop_domain", session.shop);

    if (error) {
      console.error("[Onboarding placements] dismiss error:", error.message);
    }
  }

  await setOnboardingStep(session.shop, "billing");
  return redirect(`/app/billing${preserveShopifyQuery(url)}`);
};

function SetupCard({
  active,
  children,
  onSelect,
}: {
  active: boolean;
  children: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onSelect();
      }}
      style={{
        border: active ? "2px solid #3B63D4" : "1px solid #D8DCE3",
        borderRadius: 8,
        background: active ? "#F4F7FE" : "#FFFFFF",
        padding: 18,
        cursor: "pointer",
        boxShadow: active ? "0 2px 8px rgba(59, 99, 212, 0.12)" : "none",
      }}
    >
      {children}
    </div>
  );
}

function OptionRow({
  checked,
  label,
  helpText,
  onChange,
}: {
  checked: boolean;
  label: string;
  helpText: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <BlockStack gap="100">
      <Checkbox label={label} checked={checked} onChange={onChange} />
      <Box paddingInlineStart="600">
        <Text as="p" variant="bodySm" tone="subdued">
          {helpText}
        </Text>
      </Box>
    </BlockStack>
  );
}

function StorefrontPreview({
  brandColor,
  showPreview,
  showProductFloating,
}: {
  brandColor: string;
  showPreview: boolean;
  showProductFloating: boolean;
}) {
  const [tryOnOpen, setTryOnOpen] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false);
  const textColor = readableTextColor(brandColor);

  useEffect(() => {
    setPreviewVisible(false);
    if (!showPreview) return undefined;
    const timeout = window.setTimeout(() => setPreviewVisible(true), 900);
    return () => window.clearTimeout(timeout);
  }, [showPreview]);

  return (
    <div
      style={{
        position: "relative",
        minHeight: 540,
        border: "1px solid #D8DCE3",
        borderRadius: 10,
        overflow: "hidden",
        background: "#FFFFFF",
        boxShadow: "0 10px 30px rgba(11, 18, 32, 0.08)",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          padding: "10px 14px",
          borderBottom: "1px solid #EAECF0",
          background: "#FAFBFC",
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 4, background: "#F04438" }} />
        <span style={{ width: 8, height: 8, borderRadius: 4, background: "#FDB022" }} />
        <span style={{ width: 8, height: 8, borderRadius: 4, background: "#12B76A" }} />
        <span style={{ marginLeft: 10, fontSize: 12, color: "#667085" }}>
          Product page preview
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.02fr 0.98fr", gap: 24, padding: 24 }}>
        <div>
          <div
            style={{
              aspectRatio: "4 / 5",
              borderRadius: 10,
              background: "linear-gradient(145deg, #E8EEFD 0%, #F2F4F7 52%, #D0D5DD 100%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#667085",
              fontWeight: 650,
            }}
          >
            Product image
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            {[0, 1, 2].map((item) => (
              <div key={item} style={{ width: 46, height: 56, borderRadius: 6, background: "#EAECF0" }} />
            ))}
          </div>
        </div>

        <BlockStack gap="300">
          <div>
            <div style={{ height: 14, width: "82%", background: "#101828", borderRadius: 4, marginBottom: 8 }} />
            <div style={{ height: 12, width: "38%", background: "#667085", borderRadius: 4 }} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {["S", "M", "L"].map((size) => (
              <span
                key={size}
                style={{
                  border: "1px solid #D0D5DD",
                  borderRadius: 6,
                  padding: "6px 10px",
                  fontSize: 12,
                }}
              >
                {size}
              </span>
            ))}
          </div>
          <button
            type="button"
            style={{
              width: "100%",
              border: "none",
              borderRadius: 6,
              padding: "11px 14px",
              background: "#101828",
              color: "#FFFFFF",
              fontWeight: 650,
            }}
          >
            Add to cart
          </button>
          <button
            type="button"
            onClick={() => setTryOnOpen(true)}
            style={{
              width: "100%",
              border: "none",
              borderRadius: 6,
              padding: "11px 14px",
              background: brandColor,
              color: textColor,
              fontWeight: 650,
              cursor: "pointer",
            }}
          >
            Try On
          </button>
          <div style={{ height: 8, width: "100%", background: "#EAECF0", borderRadius: 4 }} />
          <div style={{ height: 8, width: "88%", background: "#EAECF0", borderRadius: 4 }} />
          <div style={{ height: 8, width: "72%", background: "#EAECF0", borderRadius: 4 }} />
        </BlockStack>
      </div>

      {showProductFloating ? (
        <button
          type="button"
          onClick={() => setTryOnOpen(true)}
          style={{
            position: "absolute",
            right: 22,
            bottom: 22,
            width: 58,
            height: 58,
            borderRadius: 999,
            border: "none",
            background: brandColor,
            color: textColor,
            fontWeight: 800,
            boxShadow: "0 12px 28px rgba(11, 18, 32, 0.24)",
            cursor: "pointer",
          }}
        >
          Try
        </button>
      ) : null}

      {showPreview && previewVisible ? (
        <div
          style={{
            position: "absolute",
            right: 20,
            bottom: 20,
            width: 260,
            borderRadius: 10,
            border: "1px solid #D8DCE3",
            background: "#FFFFFF",
            boxShadow: "0 18px 40px rgba(11, 18, 32, 0.18)",
            padding: 12,
          }}
        >
          <InlineStack gap="300" blockAlign="center" wrap={false}>
            <div style={{ width: 64, height: 78, borderRadius: 8, background: `${brandColor}22` }} />
            <BlockStack gap="150">
              <Text as="p" variant="bodySm" fontWeight="semibold">
                See it on you
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Try this product before you buy.
              </Text>
              <Button size="slim" onClick={() => setTryOnOpen(true)}>
                Try On
              </Button>
            </BlockStack>
          </InlineStack>
        </div>
      ) : null}

      {tryOnOpen ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(11, 18, 32, 0.42)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <div
            style={{
              width: 360,
              borderRadius: 12,
              background: "#FFFFFF",
              padding: 18,
              boxShadow: "0 18px 40px rgba(11, 18, 32, 0.28)",
            }}
          >
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingMd">
                  Try-On result
                </Text>
                <Button variant="plain" onClick={() => setTryOnOpen(false)}>
                  Close
                </Button>
              </InlineStack>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div style={{ aspectRatio: "3 / 4", borderRadius: 8, background: "#F2F4F7" }} />
                <div style={{ aspectRatio: "3 / 4", borderRadius: 8, background: `${brandColor}22` }} />
              </div>
              <Text as="p" variant="bodySm" tone="subdued">
                This is the shopper experience after they click Try On.
              </Text>
            </BlockStack>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ThemeSettingsPreview() {
  return (
    <div
      style={{
        border: "1px solid #D8DCE3",
        borderRadius: 10,
        background: "#FFFFFF",
        padding: 16,
        boxShadow: "0 10px 30px rgba(11, 18, 32, 0.08)",
      }}
    >
      <img
        src="/onboarding/activate-widget-preview.webp"
        alt="Shopify theme editor showing the Ello app embed enabled and the widget visible"
        width={1900}
        height={1134}
        style={{
          width: "100%",
          height: "auto",
          display: "block",
          borderRadius: 8,
        }}
      />
    </div>
  );
}

export default function OnboardingPlacements() {
  const { settings, themeEditorUrl, appEmbedUrl, widgetEnabled, brandColor } =
    useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const submitting = navigation.state !== "idle";

  const [inlineEnabled] = useState(settings.inlineEnabled);
  const [floatingNonPdpEnabled, setFloatingNonPdpEnabled] = useState(
    settings.floatingNonPdpEnabled,
  );
  const [floatingPdpEnabled, setFloatingPdpEnabled] = useState(
    settings.floatingPdpEnabled,
  );
  const [previewEnabled, setPreviewEnabled] = useState(settings.previewEnabled);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("theme");
  const [openedEditor, setOpenedEditor] = useState(false);
  const [openedThemeSettings, setOpenedThemeSettings] = useState(false);

  useEffect(() => {
    function onFocus() {
      revalidator.revalidate();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [revalidator]);

  function handleOpenEditor() {
    setPreviewMode("inline");
    setOpenedEditor(true);
    window.open(themeEditorUrl, "_blank", "noopener");
  }

  function handleOpenThemeSettings() {
    setPreviewMode("theme");
    setOpenedThemeSettings(true);
    window.open(appEmbedUrl, "_blank", "noopener");
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
            <Text as="p" variant="bodySm" tone="subdued">
              Step 3 of 4
            </Text>
            <ProgressBar progress={75} size="small" />
          </BlockStack>
        </Box>

        <div style={{ flex: 1, width: "100%" }}>
          <Card padding="0">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(430px, 0.88fr) minmax(460px, 1.12fr)",
                alignItems: "stretch",
                minHeight: "calc(100vh - 220px)",
                width: "100%",
              }}
            >
              <Box padding="800">
                <BlockStack gap="500">
                  <BlockStack gap="300">
                    <Text as="h1" variant="heading2xl">
                      Add Try-On to your store
                    </Text>
                    <Text as="p" variant="bodyLg" tone="subdued">
                      Two quick steps in your theme editor: turn Ello on, then
                      drop the inline button onto your product page.
                    </Text>
                  </BlockStack>

                  <SetupCard
                    active={previewMode === "theme"}
                    onSelect={() => setPreviewMode("theme")}
                  >
                    <InlineStack align="space-between" blockAlign="center" wrap={false} gap="400">
                      <BlockStack gap="150">
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="h2" variant="headingLg">
                            1. Turn on Ello in your theme
                          </Text>
                          <Badge tone={widgetEnabled ? "success" : "attention"}>
                            {widgetEnabled ? "Enabled" : openedThemeSettings ? "Opened" : "Required"}
                          </Badge>
                        </InlineStack>
                        <Text as="p" variant="bodyMd" tone="subdued">
                          Opens Shopify theme settings. Toggle Ello AI Virtual
                          Try On on, then click Save.
                        </Text>
                      </BlockStack>
                      <Button variant="primary" onClick={handleOpenThemeSettings}>
                        {openedThemeSettings ? "Open theme settings again" : "Open theme settings"}
                      </Button>
                    </InlineStack>
                  </SetupCard>

                  <SetupCard
                    active={previewMode === "inline"}
                    onSelect={() => setPreviewMode("inline")}
                  >
                    <InlineStack align="space-between" blockAlign="center" wrap={false} gap="400">
                      <BlockStack gap="150">
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="h2" variant="headingLg">
                            2. Add the inline Try-On button
                          </Text>
                          <Badge tone={openedEditor ? "success" : "info"}>
                            {openedEditor ? "Opened" : "Recommended"}
                          </Badge>
                        </InlineStack>
                        <Text as="p" variant="bodyMd" tone="subdued">
                          This is the main conversion placement. Shopify opens
                          the product template with Ello ready to add.
                        </Text>
                      </BlockStack>
                      <Button variant="primary" onClick={handleOpenEditor}>
                        {openedEditor ? "Open inline setup again" : "Add inline button"}
                      </Button>
                    </InlineStack>
                  </SetupCard>

                  <Card>
                    <BlockStack gap="300">
                      <BlockStack gap="100">
                        <Text as="h2" variant="headingMd">
                          Optional visibility
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          These are good defaults. You can change them later in
                          the dashboard.
                        </Text>
                      </BlockStack>
                      <OptionRow
                        checked={floatingNonPdpEnabled}
                        label="Show floating Try-On widget on non-product pages"
                        helpText="The full Try-On widget appears in the bottom corner on home, collection, and cart pages."
                        onChange={setFloatingNonPdpEnabled}
                      />
                      <OptionRow
                        checked={previewEnabled}
                        label="Show desktop preview prompt on product pages"
                        helpText="A small desktop popup nudges shoppers to try the product."
                        onChange={setPreviewEnabled}
                      />
                      <OptionRow
                        checked={floatingPdpEnabled}
                        label="Also show the floating widget on product pages"
                        helpText="On top of the inline button. Most stores leave this off — the inline button already handles product pages."
                        onChange={setFloatingPdpEnabled}
                      />
                    </BlockStack>
                  </Card>

                  <InlineStack align="space-between" blockAlign="center">
                    <Form method="post">
                      <input type="hidden" name="intent" value="skip" />
                      <Button submit variant="plain" tone="critical">
                        Skip for now
                      </Button>
                    </Form>
                    <Form method="post">
                      <input type="hidden" name="intent" value="continue" />
                      <input
                        type="hidden"
                        name="inline_enabled"
                        value={inlineEnabled ? "on" : "off"}
                      />
                      <input
                        type="hidden"
                        name="floating_non_pdp_enabled"
                        value={floatingNonPdpEnabled ? "on" : "off"}
                      />
                      <input
                        type="hidden"
                        name="floating_pdp_enabled"
                        value={floatingPdpEnabled ? "on" : "off"}
                      />
                      <input
                        type="hidden"
                        name="preview_enabled"
                        value={previewEnabled ? "on" : "off"}
                      />
                      <Button
                        submit
                        variant="primary"
                        size="large"
                        loading={submitting}
                      >
                        Continue
                      </Button>
                    </Form>
                  </InlineStack>
                </BlockStack>
              </Box>

              <div
                style={{
                  background: "#FAFBFC",
                  borderLeft: "1px solid #EAECF0",
                  minHeight: "100%",
                  padding: 32,
                }}
              >
                {previewMode === "theme" ? (
                  <ThemeSettingsPreview />
                ) : (
                  <StorefrontPreview
                    brandColor={brandColor}
                    showPreview={previewEnabled}
                    showProductFloating={floatingPdpEnabled}
                  />
                )}
              </div>
            </div>
          </Card>
        </div>
      </div>
    </Page>
  );
}
