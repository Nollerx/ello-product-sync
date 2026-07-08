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
  Badge,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  getAppEmbedEditorUrl,
  getInlineTryOnBlockEditorUrl,
  preserveShopifyQuery,
  setOnboardingStep,
} from "../lib/onboarding.server";
import { getThemeWidgetStatus } from "../lib/theme-status.server";
import { InlineButtonPlacementHelp } from "../components/inline-placement-help";
import { supabaseAdmin } from "../lib/supabase.server";

type PreviewMode = "embed" | "product" | "widget" | "upsell";

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
  const { admin, session } = await authenticate.admin(request);

  // Live theme read — the source of truth for whether each placement is on.
  const themeStatus = await getThemeWidgetStatus(admin);

  const { data, error } = await supabaseAdmin
    .from("vto_stores")
    .select(
      "inline_button_enabled, floating_widget_non_pdp_enabled, floating_widget_pdp_enabled, desktop_preview_enabled, complete_the_look_enabled, widget_enabled_at, inline_button_color, minimized_color, widget_primary_color",
    )
    .eq("shop_domain", session.shop)
    .maybeSingle();

  if (error) {
    console.error("[Onboarding placements] read error:", error.message);
  }

  return {
    productPageOn: data?.inline_button_enabled ?? true,
    widgetOn: data?.floating_widget_non_pdp_enabled ?? true,
    upsellsOn: data?.complete_the_look_enabled ?? true,
    previewEnabled: data?.desktop_preview_enabled ?? true,
    // Live theme-derived status (replaces the stale widget_enabled_at latch).
    widgetEnabled: themeStatus.appEmbedEnabled === true,
    inlineButtonAdded: themeStatus.inlineButtonAdded === true,
    brandColor: normalizeHex(
      data?.inline_button_color ??
        data?.minimized_color ??
        data?.widget_primary_color,
    ),
    themeEditorUrl: getInlineTryOnBlockEditorUrl(session.shop),
    appEmbedUrl: getAppEmbedEditorUrl(session.shop),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "continue") {
    const productPageOn = formData.get("product_page") === "on";
    const widgetOn = formData.get("widget") === "on";
    const patch = {
      inline_button_enabled: productPageOn,
      floating_widget_non_pdp_enabled: widgetOn,
      // If the widget is their only placement, let it cover product pages too —
      // otherwise the PDP would have no try-on entry point at all.
      floating_widget_pdp_enabled: widgetOn && !productPageOn,
      complete_the_look_enabled: formData.get("upsells") === "on",
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
  // Flag the billing page so it shows the "here's what you set up" recap —
  // only during onboarding, not when an existing merchant changes plans.
  const query = preserveShopifyQuery(url);
  const billingUrl = `/app/billing${query}${query ? "&" : "?"}onboarding=1`;
  return redirect(billingUrl);
};

// ─── Selectable placement card ────────────────────────────────────────────────

function PlacementCard({
  selected,
  focused,
  title,
  badge,
  description,
  onToggle,
  onFocusPreview,
  children,
}: {
  selected: boolean;
  focused: boolean;
  title: string;
  badge?: React.ReactNode;
  description: string;
  onToggle: () => void;
  onFocusPreview: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        onToggle();
        onFocusPreview();
      }}
      onMouseEnter={onFocusPreview}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle();
          onFocusPreview();
        }
      }}
      style={{
        border: selected ? "2px solid #3B63D4" : "1px solid #D8DCE3",
        borderRadius: 12,
        background: selected ? "#F4F7FE" : "#FFFFFF",
        padding: 18,
        cursor: "pointer",
        boxShadow: focused
          ? "0 4px 14px rgba(59, 99, 212, 0.18)"
          : selected
            ? "0 2px 8px rgba(59, 99, 212, 0.12)"
            : "none",
        transition: "box-shadow 120ms ease, border-color 120ms ease",
      }}
    >
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center" wrap={false} gap="300">
          <InlineStack gap="200" blockAlign="center">
            {/* Selection indicator */}
            <span
              aria-hidden
              style={{
                width: 20,
                height: 20,
                borderRadius: 6,
                flexShrink: 0,
                border: selected ? "none" : "2px solid #D0D5DD",
                background: selected ? "#3B63D4" : "#FFFFFF",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#FFFFFF",
                fontSize: 13,
                fontWeight: 800,
              }}
            >
              {selected ? "✓" : ""}
            </span>
            <Text as="h3" variant="headingMd">
              {title}
            </Text>
          </InlineStack>
          {badge}
        </InlineStack>
        <Text as="p" variant="bodySm" tone="subdued">
          {description}
        </Text>
        {children}
      </BlockStack>
    </div>
  );
}

// ─── Storefront preview (right column) ────────────────────────────────────────

function BrowserFrame({ label, children }: { label: string; children: React.ReactNode }) {
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
        <span style={{ marginLeft: 10, fontSize: 12, color: "#667085" }}>{label}</span>
      </div>
      {children}
    </div>
  );
}

function ProductColumn({
  brandColor,
  highlightInline,
}: {
  brandColor: string;
  highlightInline: boolean;
}) {
  const textColor = readableTextColor(brandColor);
  return (
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
        {highlightInline ? (
          <div style={{ position: "relative" }}>
            <button
              type="button"
              style={{
                width: "100%",
                border: "none",
                borderRadius: 6,
                padding: "11px 14px",
                background: brandColor,
                color: textColor,
                fontWeight: 650,
                boxShadow: "0 0 0 3px rgba(59, 99, 212, 0.35)",
              }}
            >
              Try It On
            </button>
            <span
              style={{
                position: "absolute",
                top: -10,
                right: -6,
                background: "#3B63D4",
                color: "#FFFFFF",
                fontSize: 10,
                fontWeight: 700,
                borderRadius: 999,
                padding: "2px 8px",
                whiteSpace: "nowrap",
              }}
            >
              Ello button
            </span>
          </div>
        ) : null}
        <div style={{ height: 8, width: "100%", background: "#EAECF0", borderRadius: 4 }} />
        <div style={{ height: 8, width: "88%", background: "#EAECF0", borderRadius: 4 }} />
        <div style={{ height: 8, width: "72%", background: "#EAECF0", borderRadius: 4 }} />
      </BlockStack>
    </div>
  );
}

function FloatingWidgetOverlay({ brandColor }: { brandColor: string }) {
  const textColor = readableTextColor(brandColor);
  return (
    <>
      {/* Opened widget panel */}
      <div
        style={{
          position: "absolute",
          right: 20,
          bottom: 92,
          width: 250,
          borderRadius: 12,
          border: "1px solid #D8DCE3",
          background: "#FFFFFF",
          boxShadow: "0 18px 40px rgba(11, 18, 32, 0.20)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "10px 14px",
            background: brandColor,
            color: textColor,
            fontSize: 13,
            fontWeight: 700,
          }}
        >
          Fitting room
        </div>
        <div style={{ padding: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {[0, 1, 2, 3, 4, 5].map((item) => (
              <div
                key={item}
                style={{
                  aspectRatio: "3 / 4",
                  borderRadius: 6,
                  background: item === 1 ? `${brandColor}33` : "#F2F4F7",
                  border: item === 1 ? `2px solid ${brandColor}` : "1px solid #EAECF0",
                }}
              />
            ))}
          </div>
          <button
            type="button"
            style={{
              width: "100%",
              marginTop: 10,
              border: "none",
              borderRadius: 6,
              padding: "9px 12px",
              background: brandColor,
              color: textColor,
              fontWeight: 650,
              fontSize: 13,
            }}
          >
            Try It On
          </button>
        </div>
      </div>
      {/* Bubble */}
      <div style={{ position: "absolute", right: 22, bottom: 22 }}>
        <div style={{ position: "relative" }}>
          <button
            type="button"
            style={{
              width: 58,
              height: 58,
              borderRadius: 999,
              border: "none",
              background: brandColor,
              color: textColor,
              fontWeight: 800,
              boxShadow: "0 12px 28px rgba(11, 18, 32, 0.24)",
            }}
          >
            Try
          </button>
          <span
            style={{
              position: "absolute",
              top: -12,
              right: 52,
              background: "#3B63D4",
              color: "#FFFFFF",
              fontSize: 10,
              fontWeight: 700,
              borderRadius: 999,
              padding: "2px 8px",
              whiteSpace: "nowrap",
            }}
          >
            Follows every page
          </span>
        </div>
      </div>
    </>
  );
}

function UpsellPreview({ brandColor }: { brandColor: string }) {
  const textColor = readableTextColor(brandColor);
  return (
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
          width: 430,
          borderRadius: 12,
          background: "#FFFFFF",
          padding: 18,
          boxShadow: "0 18px 40px rgba(11, 18, 32, 0.28)",
        }}
      >
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">
            Your try-on result
          </Text>
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 12 }}>
            {/* Try-on result */}
            <div
              style={{
                aspectRatio: "3 / 4",
                borderRadius: 8,
                background: `linear-gradient(160deg, ${brandColor}22 0%, #F2F4F7 100%)`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#667085",
                fontSize: 12,
                fontWeight: 650,
                textAlign: "center",
                padding: 8,
              }}
            >
              Shopper wearing your product
            </div>
            {/* Complete the look rail */}
            <div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 800,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "#667085",
                  marginBottom: 8,
                }}
              >
                Complete the look
              </div>
              <BlockStack gap="200">
                {["Matching jacket", "Relaxed jeans"].map((item) => (
                  <div
                    key={item}
                    style={{
                      border: "1px solid #EAECF0",
                      borderRadius: 8,
                      padding: 8,
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                    }}
                  >
                    <div style={{ width: 34, height: 42, borderRadius: 5, background: "#F2F4F7", flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 650, color: "#101828" }}>{item}</div>
                      <button
                        type="button"
                        style={{
                          marginTop: 4,
                          border: "none",
                          borderRadius: 999,
                          padding: "3px 10px",
                          background: brandColor,
                          color: textColor,
                          fontSize: 10,
                          fontWeight: 700,
                        }}
                      >
                        + Add
                      </button>
                    </div>
                  </div>
                ))}
              </BlockStack>
            </div>
          </div>
          <Text as="p" variant="bodySm" tone="subdued">
            Ello suggests matching items from your catalog right in the try-on
            result — shoppers add the whole outfit to cart.
          </Text>
        </BlockStack>
      </div>
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

const PREVIEW_LABELS: Record<PreviewMode, string> = {
  embed: "Theme editor — one click, then Save",
  product: "What shoppers see on your product page",
  widget: "The widget follows shoppers on every page",
  upsell: "After the try-on — upsells that build the cart",
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OnboardingPlacements() {
  const {
    productPageOn: initialProduct,
    widgetOn: initialWidget,
    upsellsOn: initialUpsells,
    previewEnabled,
    themeEditorUrl,
    appEmbedUrl,
    widgetEnabled,
    inlineButtonAdded,
    brandColor,
  } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const submitting = navigation.state !== "idle";

  const [productPageOn, setProductPageOn] = useState<boolean>(Boolean(initialProduct));
  const [widgetOn, setWidgetOn] = useState<boolean>(Boolean(initialWidget));
  const [upsellsOn, setUpsellsOn] = useState<boolean>(Boolean(initialUpsells));
  const [previewMode, setPreviewMode] = useState<PreviewMode>(
    widgetEnabled ? "product" : "embed",
  );
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
    setPreviewMode("product");
    setOpenedEditor(true);
    window.open(themeEditorUrl, "_blank", "noopener");
  }

  function handleOpenThemeSettings() {
    setPreviewMode("embed");
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
              Step 4 of 5
            </Text>
            <ProgressBar progress={80} size="small" />
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
                      Put Try-On where it sells
                    </Text>
                    <Text as="p" variant="bodyLg" tone="subdued">
                      Turn Ello on, pick where shoppers try things on, and switch
                      on outfit upsells.
                    </Text>
                  </BlockStack>

                  {/* Step 1 — app embed (required) */}
                  <div
                    style={{
                      border: "1px solid #D8DCE3",
                      borderRadius: 12,
                      background: widgetEnabled ? "#F6FEF9" : "#FFFFFF",
                      padding: 16,
                    }}
                  >
                    <InlineStack align="space-between" blockAlign="center" wrap={false} gap="400">
                      <BlockStack gap="100">
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="h2" variant="headingMd">
                            1. Turn on Ello in your theme
                          </Text>
                          <Badge tone={widgetEnabled ? "success" : "attention"}>
                            {widgetEnabled ? "Enabled" : openedThemeSettings ? "Opened — click Save" : "Required"}
                          </Badge>
                        </InlineStack>
                        <Text as="p" variant="bodySm" tone="subdued">
                          Opens your theme settings with Ello switched on — just
                          click Save in the top-right.
                        </Text>
                      </BlockStack>
                      {!widgetEnabled ? (
                        <Button variant="primary" onClick={handleOpenThemeSettings}>
                          {openedThemeSettings ? "Open again" : "Turn on Ello"}
                        </Button>
                      ) : null}
                    </InlineStack>
                  </div>

                  {/* Step 2 — the two placements */}
                  <BlockStack gap="300">
                    <BlockStack gap="100">
                      <Text as="h2" variant="headingMd">
                        2. Where should shoppers try things on?
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Pick one or both — hover to preview what shoppers see.
                      </Text>
                    </BlockStack>

                    <PlacementCard
                      selected={productPageOn}
                      focused={previewMode === "product"}
                      title="On the product page"
                      badge={
                        inlineButtonAdded ? (
                          <Badge tone="success">Added to theme</Badge>
                        ) : (
                          <Badge tone="info">Recommended</Badge>
                        )
                      }
                      description="A Try It On button right under Add to cart — shoppers try the exact product they're looking at. The highest-converting placement."
                      onToggle={() => setProductPageOn((v) => !v)}
                      onFocusPreview={() => setPreviewMode("product")}
                    >
                      {productPageOn && !inlineButtonAdded ? (
                        <div
                          role="presentation"
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <BlockStack gap="200">
                            <InlineStack gap="200">
                              <Button size="slim" variant="primary" onClick={handleOpenEditor}>
                                {openedEditor ? "Open theme editor again" : "Add button to your product page"}
                              </Button>
                            </InlineStack>
                            <InlineButtonPlacementHelp />
                          </BlockStack>
                        </div>
                      ) : null}
                    </PlacementCard>

                    <PlacementCard
                      selected={widgetOn}
                      focused={previewMode === "widget"}
                      title="Inside the floating widget"
                      description="A try-on bubble in the corner of every page — home, collections, cart. Shoppers browse your catalog and try on from anywhere. No theme edits needed."
                      onToggle={() => setWidgetOn((v) => !v)}
                      onFocusPreview={() => setPreviewMode("widget")}
                    />
                  </BlockStack>

                  {/* Step 3 — upsells */}
                  <BlockStack gap="300">
                    <BlockStack gap="100">
                      <Text as="h2" variant="headingMd">
                        3. Turn try-ons into bigger carts
                      </Text>
                    </BlockStack>
                    <PlacementCard
                      selected={upsellsOn}
                      focused={previewMode === "upsell"}
                      title="Complete the Look upsells"
                      badge={<Badge tone="success">Boosts order value</Badge>}
                      description="After every try-on, Ello suggests matching items from your catalog — shoppers add the whole outfit, not just one piece. Included on all plans."
                      onToggle={() => setUpsellsOn((v) => !v)}
                      onFocusPreview={() => setPreviewMode("upsell")}
                    />
                  </BlockStack>

                  <InlineStack align="space-between" blockAlign="center">
                    <Form method="post">
                      <input type="hidden" name="intent" value="skip" />
                      <Button submit variant="plain" tone="critical">
                        Skip for now
                      </Button>
                    </Form>
                    <Form method="post">
                      <input type="hidden" name="intent" value="continue" />
                      <input type="hidden" name="product_page" value={productPageOn ? "on" : "off"} />
                      <input type="hidden" name="widget" value={widgetOn ? "on" : "off"} />
                      <input type="hidden" name="upsells" value={upsellsOn ? "on" : "off"} />
                      <input type="hidden" name="preview_enabled" value={previewEnabled ? "on" : "off"} />
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
                {previewMode === "embed" ? (
                  <ThemeSettingsPreview />
                ) : (
                  <BrowserFrame label={PREVIEW_LABELS[previewMode]}>
                    <ProductColumn
                      brandColor={brandColor}
                      highlightInline={previewMode === "product"}
                    />
                    {previewMode === "widget" ? (
                      <FloatingWidgetOverlay brandColor={brandColor} />
                    ) : null}
                    {previewMode === "upsell" ? (
                      <UpsellPreview brandColor={brandColor} />
                    ) : null}
                  </BrowserFrame>
                )}
              </div>
            </div>
          </Card>
        </div>
      </div>
    </Page>
  );
}
