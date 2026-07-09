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
  Icon,
} from "@shopify/polaris";
import {
  ThemeIcon,
  ButtonIcon,
  ImageIcon,
  ChatIcon,
  CartUpIcon,
} from "@shopify/polaris-icons";
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

type TryOnStyle = "product" | "widget";
type PreviewMode = "embed" | "button" | "product" | "widget" | "upsell";

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
      "pdp_image_swap_enabled, complete_the_look_enabled, desktop_preview_enabled, placements_banner_dismissed_at, inline_button_color, minimized_color, widget_primary_color",
    )
    .eq("shop_domain", session.shop)
    .maybeSingle();

  if (error) {
    console.error("[Onboarding placements] read error:", error.message);
  }

  // Default to the recommended product-page style. Only fall back to "widget"
  // when the merchant already made an explicit choice on a previous pass
  // (placements saved before) and image swap is off.
  const madeChoiceBefore = Boolean(data?.placements_banner_dismissed_at);
  const initialStyle: TryOnStyle =
    madeChoiceBefore && data?.pdp_image_swap_enabled === false ? "widget" : "product";

  return {
    initialStyle,
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
    const style: TryOnStyle = formData.get("style") === "widget" ? "widget" : "product";
    // Same flag mapping as the "Choose your try-on style" presets in
    // app.widget-design.tsx — keep the two in sync.
    const patch = {
      inline_button_enabled: true,
      pdp_image_swap_enabled: style === "product",
      floating_widget_pdp_enabled: style === "widget",
      floating_widget_non_pdp_enabled: style === "widget",
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

// ─── Left-column building blocks ─────────────────────────────────────────────

function SetupRow({
  icon,
  title,
  description,
  badge,
  action,
  help,
  onFocusPreview,
}: {
  icon: React.FunctionComponent<React.SVGProps<SVGSVGElement>>;
  title: string;
  description: string;
  badge: React.ReactNode;
  action?: React.ReactNode;
  help?: React.ReactNode;
  onFocusPreview: () => void;
}) {
  return (
    <div
      onMouseEnter={onFocusPreview}
      style={{
        border: "1px solid #D8DCE3",
        borderRadius: 12,
        background: "#FFFFFF",
        padding: 16,
      }}
    >
      <InlineStack align="space-between" blockAlign="start" wrap={false} gap="400">
        <InlineStack gap="300" blockAlign="start" wrap={false}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: "#EEF3FE",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Icon source={icon} tone="info" />
          </div>
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h3" variant="headingMd">
                {title}
              </Text>
              {badge}
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              {description}
            </Text>
            {help}
          </BlockStack>
        </InlineStack>
        {action}
      </InlineStack>
    </div>
  );
}

function StyleChoice({
  selected,
  focused,
  icon,
  title,
  badge,
  description,
  onSelect,
  onPreview,
}: {
  selected: boolean;
  focused: boolean;
  icon: React.FunctionComponent<React.SVGProps<SVGSVGElement>>;
  title: string;
  badge?: React.ReactNode;
  description: string;
  onSelect: () => void;
  onPreview: () => void;
}) {
  return (
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onClick={onSelect}
      onMouseEnter={onPreview}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      style={{
        border: selected ? "2px solid #3B63D4" : "1px solid #D8DCE3",
        borderRadius: 12,
        background: selected ? "#F4F7FE" : "#FFFFFF",
        padding: 16,
        cursor: "pointer",
        flex: 1,
        boxShadow: focused ? "0 4px 14px rgba(59, 99, 212, 0.18)" : "none",
        transition: "box-shadow 120ms ease, border-color 120ms ease",
      }}
    >
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: selected ? "#3B63D4" : "#EEF3FE",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span style={{ color: selected ? "#FFFFFF" : undefined }}>
              <Icon source={icon} tone={selected ? "inherit" : "info"} />
            </span>
          </div>
          <span
            aria-hidden
            style={{
              width: 18,
              height: 18,
              borderRadius: 999,
              border: selected ? "6px solid #3B63D4" : "2px solid #D0D5DD",
              background: "#FFFFFF",
              flexShrink: 0,
            }}
          />
        </InlineStack>
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h3" variant="headingMd">
              {title}
            </Text>
            {badge}
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            {description}
          </Text>
        </BlockStack>
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

// Real try-on result from the creative library (RepoVault
// 02-Areas/Content/Creative-Library/assets/proof/ba-dress-after.jpg) — an
// actual widget output, so the preview shows what the feature really produces.
function ShopperResultPhoto() {
  return (
    <img
      src="/onboarding/shopper-result.jpg"
      alt="Try-on result — shopper wearing the product"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
        objectPosition: "top",
      }}
    />
  );
}

// The hero cell: either the plain product photo, or the try-on result
// (shopper wearing the item) with the real flip-back thumbnail — plus,
// optionally, the real Complete-the-Look bottom sheet pinned to its base.
function HeroCell({
  brandColor,
  showResult,
  showBottomSheet,
}: {
  brandColor: string;
  showResult: boolean;
  showBottomSheet: boolean;
}) {
  const textColor = readableTextColor(brandColor);
  return (
    <div
      style={{
        position: "relative",
        aspectRatio: "4 / 5",
        borderRadius: 10,
        overflow: "hidden",
        background: showResult
          ? `linear-gradient(165deg, ${brandColor}26 0%, #F2F4F7 60%, #E4E7EC 100%)`
          : "linear-gradient(145deg, #E8EEFD 0%, #F2F4F7 52%, #D0D5DD 100%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#667085",
        fontWeight: 650,
      }}
    >
      {showResult ? (
        <>
          <ShopperResultPhoto />
          <span
            style={{
              position: "absolute",
              top: 10,
              left: 10,
              background: "rgba(255,255,255,0.92)",
              borderRadius: 999,
              padding: "3px 10px",
              fontSize: 10,
              fontWeight: 700,
              color: "#101828",
              boxShadow: "0 2px 6px rgba(11,18,32,0.12)",
            }}
          >
            ✨ Your shopper, wearing it
          </span>
          {/* Flip-back thumbnail — the real widget pins this to the swapped hero */}
          <span
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              width: 34,
              height: 42,
              borderRadius: 6,
              background: "linear-gradient(145deg, #E8EEFD 0%, #D0D5DD 100%)",
              border: "2px solid #FFFFFF",
              boxShadow: "0 2px 6px rgba(11,18,32,0.2)",
            }}
          />
        </>
      ) : (
        "Product image"
      )}

      {showBottomSheet ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(255,255,255,0.96)",
            backdropFilter: "blur(4px)",
            borderRadius: "10px 10px 0 0",
            padding: "8px 10px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            boxShadow: "0 -4px 14px rgba(11,18,32,0.10)",
          }}
        >
          <div
            style={{
              width: 30,
              height: 38,
              borderRadius: 5,
              background: "#EAECF0",
              flexShrink: 0,
            }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 9,
                fontWeight: 800,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "#667085",
              }}
            >
              Complete the look
            </div>
            <div style={{ fontSize: 11, fontWeight: 650, color: "#101828" }}>Matching jacket</div>
          </div>
          <button
            type="button"
            style={{
              border: "none",
              borderRadius: 999,
              padding: "6px 12px",
              background: brandColor,
              color: textColor,
              fontSize: 11,
              fontWeight: 700,
              whiteSpace: "nowrap",
            }}
          >
            Try it on too
          </button>
        </div>
      ) : null}
    </div>
  );
}

function PdpMock({
  brandColor,
  highlightInline,
  heroResult,
  heroBottomSheet,
}: {
  brandColor: string;
  highlightInline: boolean;
  heroResult: boolean;
  heroBottomSheet: boolean;
}) {
  const textColor = readableTextColor(brandColor);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1.02fr 0.98fr", gap: 24, padding: 24 }}>
      <div>
        <HeroCell
          brandColor={brandColor}
          showResult={heroResult}
          showBottomSheet={heroBottomSheet}
        />
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
              boxShadow: highlightInline ? "0 0 0 3px rgba(59, 99, 212, 0.35)" : "none",
            }}
          >
            Try It On
          </button>
          {highlightInline ? (
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
              Your Ello button
            </span>
          ) : null}
        </div>
        <div style={{ height: 8, width: "100%", background: "#EAECF0", borderRadius: 4 }} />
        <div style={{ height: 8, width: "88%", background: "#EAECF0", borderRadius: 4 }} />
        <div style={{ height: 8, width: "72%", background: "#EAECF0", borderRadius: 4 }} />
      </BlockStack>
    </div>
  );
}

// Widget-style preview: the result renders inside the Ello panel; the page
// itself stays untouched. Optionally shows the in-panel Complete-the-Look rail.
function WidgetPanelOverlay({
  brandColor,
  withRail,
}: {
  brandColor: string;
  withRail: boolean;
}) {
  const textColor = readableTextColor(brandColor);
  return (
    <>
      <div
        style={{
          position: "absolute",
          right: 20,
          bottom: 92,
          width: 260,
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
          Try-on result
        </div>
        <div style={{ padding: 12 }}>
          <div
            style={{
              position: "relative",
              aspectRatio: "3 / 4",
              borderRadius: 8,
              background: `linear-gradient(165deg, ${brandColor}26 0%, #F2F4F7 100%)`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
            }}
          >
            <ShopperResultPhoto />
          </div>
          {withRail ? (
            <div
              style={{
                marginTop: 10,
                border: "1px solid #EAECF0",
                borderRadius: 8,
                padding: 8,
                display: "flex",
                gap: 8,
                alignItems: "center",
              }}
            >
              <div style={{ width: 30, height: 38, borderRadius: 5, background: "#EAECF0", flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 9,
                    fontWeight: 800,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: "#667085",
                  }}
                >
                  Complete the look
                </div>
                <div style={{ fontSize: 11, fontWeight: 650, color: "#101828" }}>Matching jacket</div>
              </div>
              <button
                type="button"
                style={{
                  border: "none",
                  borderRadius: 999,
                  padding: "5px 10px",
                  background: brandColor,
                  color: textColor,
                  fontSize: 10,
                  fontWeight: 700,
                }}
              >
                Try on
              </button>
            </div>
          ) : (
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
              Add to cart
            </button>
          )}
        </div>
      </div>
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
            On every page
          </span>
        </div>
      </div>
    </>
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OnboardingPlacements() {
  const {
    initialStyle,
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

  const [style, setStyle] = useState<TryOnStyle>(initialStyle);
  const [upsellsOn, setUpsellsOn] = useState<boolean>(Boolean(initialUpsells));
  const [previewMode, setPreviewMode] = useState<PreviewMode>(
    widgetEnabled ? (initialStyle as PreviewMode) : "embed",
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
    setPreviewMode("button");
    setOpenedEditor(true);
    window.open(themeEditorUrl, "_blank", "noopener");
  }

  function handleOpenThemeSettings() {
    setPreviewMode("embed");
    setOpenedThemeSettings(true);
    window.open(appEmbedUrl, "_blank", "noopener");
  }

  const previewLabel: Record<PreviewMode, string> = {
    embed: "Theme editor — one click, then Save",
    button: "The Try It On button, under Add to cart",
    product: "Tap Try It On → the product photo becomes your shopper",
    widget: "Tap Try It On → the result opens in the Ello panel",
    upsell:
      style === "product"
        ? "Right on the result — one tap tries the matching piece"
        : "Right under the result — one tap tries the matching piece",
  };

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
                  <BlockStack gap="200">
                    <Text as="h1" variant="heading2xl">
                      Set up your try-on
                    </Text>
                    <Text as="p" variant="bodyLg" tone="subdued">
                      Two quick theme steps, one choice, one upsell switch.
                    </Text>
                  </BlockStack>

                  {/* 1 — required setup */}
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">
                      1. Turn it on
                    </Text>
                    <SetupRow
                      icon={ThemeIcon}
                      title="Enable Ello in your theme"
                      description="Opens theme settings with Ello switched on — just hit Save."
                      badge={
                        <Badge tone={widgetEnabled ? "success" : "attention"}>
                          {widgetEnabled ? "Enabled" : openedThemeSettings ? "Opened — click Save" : "Required"}
                        </Badge>
                      }
                      action={
                        !widgetEnabled ? (
                          <Button variant="primary" onClick={handleOpenThemeSettings}>
                            {openedThemeSettings ? "Open again" : "Turn on Ello"}
                          </Button>
                        ) : undefined
                      }
                      onFocusPreview={() => setPreviewMode("embed")}
                    />
                    <SetupRow
                      icon={ButtonIcon}
                      title="Add the Try It On button"
                      description="Goes right under Add to cart on your product pages."
                      badge={
                        <Badge tone={inlineButtonAdded ? "success" : "attention"}>
                          {inlineButtonAdded ? "Added" : openedEditor ? "Opened — click Save" : "Required"}
                        </Badge>
                      }
                      action={
                        !inlineButtonAdded ? (
                          <Button variant="primary" onClick={handleOpenEditor}>
                            {openedEditor ? "Open again" : "Add button"}
                          </Button>
                        ) : undefined
                      }
                      help={!inlineButtonAdded ? <InlineButtonPlacementHelp /> : undefined}
                      onFocusPreview={() => setPreviewMode("button")}
                    />
                  </BlockStack>

                  {/* 2 — the one choice */}
                  <BlockStack gap="300">
                    <BlockStack gap="100">
                      <Text as="h2" variant="headingMd">
                        2. Where does the result show up?
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        When a shopper taps Try It On — pick one. You can switch anytime.
                      </Text>
                    </BlockStack>
                    <InlineStack gap="300" wrap={false}>
                      <StyleChoice
                        selected={style === "product"}
                        focused={previewMode === "product"}
                        icon={ImageIcon}
                        title="On the product photo"
                        badge={<Badge tone="info">Recommended</Badge>}
                        description="The product photo becomes your shopper wearing it. Native, no popups."
                        onSelect={() => {
                          setStyle("product");
                          setPreviewMode("product");
                        }}
                        onPreview={() => setPreviewMode("product")}
                      />
                      <StyleChoice
                        selected={style === "widget"}
                        focused={previewMode === "widget"}
                        icon={ChatIcon}
                        title="Inside the widget"
                        description="A corner panel shows the result. Your page stays untouched."
                        onSelect={() => {
                          setStyle("widget");
                          setPreviewMode("widget");
                        }}
                        onPreview={() => setPreviewMode("widget")}
                      />
                    </InlineStack>
                  </BlockStack>

                  {/* 3 — upsells */}
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">
                      3. Turn try-ons into bigger carts
                    </Text>
                    <div
                      role="checkbox"
                      aria-checked={upsellsOn}
                      tabIndex={0}
                      onClick={() => {
                        setUpsellsOn((v: boolean) => !v);
                        setPreviewMode("upsell");
                      }}
                      onMouseEnter={() => setPreviewMode("upsell")}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setUpsellsOn((v: boolean) => !v);
                          setPreviewMode("upsell");
                        }
                      }}
                      style={{
                        border: upsellsOn ? "2px solid #3B63D4" : "1px solid #D8DCE3",
                        borderRadius: 12,
                        background: upsellsOn ? "#F4F7FE" : "#FFFFFF",
                        padding: 16,
                        cursor: "pointer",
                        boxShadow:
                          previewMode === "upsell" ? "0 4px 14px rgba(59, 99, 212, 0.18)" : "none",
                        transition: "box-shadow 120ms ease, border-color 120ms ease",
                      }}
                    >
                      <InlineStack align="space-between" blockAlign="start" wrap={false} gap="400">
                        <InlineStack gap="300" blockAlign="start" wrap={false}>
                          <div
                            style={{
                              width: 36,
                              height: 36,
                              borderRadius: 10,
                              background: upsellsOn ? "#3B63D4" : "#EEF3FE",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              flexShrink: 0,
                            }}
                          >
                            <span style={{ color: upsellsOn ? "#FFFFFF" : undefined }}>
                              <Icon source={CartUpIcon} tone={upsellsOn ? "inherit" : "info"} />
                            </span>
                          </div>
                          <BlockStack gap="100">
                            <InlineStack gap="200" blockAlign="center">
                              <Text as="h3" variant="headingMd">
                                Complete the Look upsells
                              </Text>
                              <Badge tone="success">Boosts order value</Badge>
                            </InlineStack>
                            <Text as="p" variant="bodySm" tone="subdued">
                              After the result, Ello offers a matching item — one tap adds the
                              whole outfit to cart.
                            </Text>
                          </BlockStack>
                        </InlineStack>
                        <span
                          aria-hidden
                          style={{
                            width: 20,
                            height: 20,
                            borderRadius: 6,
                            flexShrink: 0,
                            border: upsellsOn ? "none" : "2px solid #D0D5DD",
                            background: upsellsOn ? "#3B63D4" : "#FFFFFF",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "#FFFFFF",
                            fontSize: 13,
                            fontWeight: 800,
                          }}
                        >
                          {upsellsOn ? "✓" : ""}
                        </span>
                      </InlineStack>
                    </div>
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
                      <input type="hidden" name="style" value={style} />
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
                  <BrowserFrame label={previewLabel[previewMode]}>
                    <PdpMock
                      brandColor={brandColor}
                      highlightInline={previewMode === "button"}
                      heroResult={
                        previewMode === "product" ||
                        (previewMode === "upsell" && style === "product")
                      }
                      heroBottomSheet={previewMode === "upsell" && style === "product"}
                    />
                    {previewMode === "widget" || (previewMode === "upsell" && style === "widget") ? (
                      <WidgetPanelOverlay
                        brandColor={brandColor}
                        withRail={previewMode === "upsell"}
                      />
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
