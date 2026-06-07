import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  ButtonGroup,
  Checkbox,
  TextField,
  Box,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../lib/supabase.server";

// ─── Color helpers ──────────────────────────────────────────────────────────
// Mirrors app.onboarding.configure.tsx so the brand-color behavior (presets,
// custom picker, auto-readable inline text) is identical across both surfaces.
// Kept local to keep this first migrated page self-contained; if a third
// surface needs them, lift into app/lib/widget-colors.ts.

const COLOR_PRESETS = [
  "#111827", // near-black
  "#1E3A8A", // deep blue
  "#2563EB", // bright blue
  "#10B981", // emerald
  "#DB2777", // pink
  "#F97316", // orange
];

const DEFAULT_COLOR = "#111827";

function normalizeHex(input: string): string {
  const trimmed = input.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  return DEFAULT_COLOR;
}

function readableTextColor(hex: string): "#000000" | "#FFFFFF" {
  const normalized = normalizeHex(hex).replace("#", "");
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? "#000000" : "#FFFFFF";
}

// ─── Defaults (match the DB column defaults from the placement migrations) ────
const DEFAULTS = {
  brandColor: DEFAULT_COLOR,
  inlineEnabled: true,
  inlineText: "Try On",
  inlineHideOos: false,
  floatPdp: false,
  floatNonPdp: true,
  position: "right" as "left" | "right",
  previewEnabled: false,
  previewDelay: 3,
};

const MAX_INLINE_TEXT = 24;

// ─── Loader ───────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const { data } = await supabaseAdmin
    .from("vto_stores")
    .select(
      [
        "store_slug",
        "widget_primary_color",
        "minimized_color",
        "inline_button_color",
        "inline_button_enabled",
        "inline_button_text",
        "inline_button_hide_when_oos",
        "floating_widget_pdp_enabled",
        "floating_widget_non_pdp_enabled",
        "widget_position",
        "desktop_preview_enabled",
        "preview_delay_seconds",
      ].join(", "),
    )
    .eq("shop_domain", session.shop)
    .maybeSingle();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = data as any;

  return {
    storeExists: !!row,
    brandColor:
      row?.inline_button_color ??
      row?.minimized_color ??
      row?.widget_primary_color ??
      DEFAULTS.brandColor,
    inlineEnabled: row?.inline_button_enabled ?? DEFAULTS.inlineEnabled,
    inlineText: row?.inline_button_text ?? DEFAULTS.inlineText,
    inlineHideOos: row?.inline_button_hide_when_oos ?? DEFAULTS.inlineHideOos,
    floatPdp: row?.floating_widget_pdp_enabled ?? DEFAULTS.floatPdp,
    floatNonPdp: row?.floating_widget_non_pdp_enabled ?? DEFAULTS.floatNonPdp,
    position: (row?.widget_position as "left" | "right") ?? DEFAULTS.position,
    previewEnabled: row?.desktop_preview_enabled ?? DEFAULTS.previewEnabled,
    previewDelay: row?.preview_delay_seconds ?? DEFAULTS.previewDelay,
  };
};

// ─── Action ─────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  const bool = (key: string) => form.get(key) === "true";

  const brandColor = normalizeHex(String(form.get("brand_color") ?? DEFAULT_COLOR));
  const inlineText =
    String(form.get("inline_text") ?? "").trim().slice(0, MAX_INLINE_TEXT) ||
    DEFAULTS.inlineText;

  const rawDelay = Number.parseInt(String(form.get("preview_delay") ?? ""), 10);
  const previewDelay = Number.isFinite(rawDelay)
    ? Math.min(60, Math.max(0, rawDelay))
    : DEFAULTS.previewDelay;

  const { data, error } = await supabaseAdmin
    .from("vto_stores")
    .update({
      widget_primary_color: brandColor,
      minimized_color: brandColor,
      inline_button_color: brandColor,
      inline_button_text_color: readableTextColor(brandColor),
      inline_button_enabled: bool("inline_enabled"),
      inline_button_text: inlineText,
      inline_button_hide_when_oos: bool("inline_hide_oos"),
      floating_widget_pdp_enabled: bool("float_pdp"),
      floating_widget_non_pdp_enabled: bool("float_non_pdp"),
      widget_position: form.get("position") === "left" ? "left" : "right",
      desktop_preview_enabled: bool("preview_enabled"),
      preview_delay_seconds: previewDelay,
    })
    .eq("shop_domain", session.shop)
    .select("store_slug")
    .maybeSingle();

  if (error) {
    return { ok: false as const, error: error.message };
  }
  if (!data) {
    return {
      ok: false as const,
      error:
        "We couldn't find your store record yet. Finish onboarding, then try saving again.",
    };
  }

  // The BEFORE UPDATE trigger on vto_stores bumps config_version automatically,
  // so storefronts pick up these changes within ~30s via the SWR cache.
  return { ok: true as const };
};

// ─── Live storefront preview ──────────────────────────────────────────────
function StorefrontPreview({
  color,
  inlineEnabled,
  inlineText,
  floatPdp,
  position,
}: {
  color: string;
  inlineEnabled: boolean;
  inlineText: string;
  floatPdp: boolean;
  position: "left" | "right";
}) {
  const textColor = readableTextColor(color);

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        aspectRatio: "16 / 11",
        borderRadius: "12px",
        border: "1px solid #D8DCE3",
        background: "#FAFBFC",
        overflow: "hidden",
        boxShadow: "0 1px 3px rgba(11,18,32,0.06)",
      }}
    >
      {/* Browser chrome */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          padding: "8px 12px",
          borderBottom: "1px solid #ECEEF3",
          background: "#fff",
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 4, background: "#D94E4E" }} />
        <span style={{ width: 8, height: 8, borderRadius: 4, background: "#E2A93A" }} />
        <span style={{ width: 8, height: 8, borderRadius: 4, background: "#17A673" }} />
      </div>

      {/* Product layout placeholder */}
      <div style={{ display: "flex", gap: "12px", padding: "16px" }}>
        <div
          style={{
            flex: "0 0 44%",
            aspectRatio: "3 / 4",
            background: "linear-gradient(135deg,#ECEEF3 0%,#D8DCE3 100%)",
            borderRadius: "8px",
          }}
        />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "7px", paddingTop: "4px" }}>
          <div style={{ height: 11, width: "72%", background: "#D8DCE3", borderRadius: 3 }} />
          <div style={{ height: 8, width: "42%", background: "#ECEEF3", borderRadius: 3 }} />
          <div style={{ height: 28, width: "78%", background: "#0B1220", borderRadius: 6, marginTop: 12 }} />
          {inlineEnabled && (
            <div
              style={{
                height: 28,
                width: "78%",
                background: color,
                color: textColor,
                borderRadius: 6,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 11,
                fontWeight: 700,
                marginTop: 2,
              }}
            >
              {inlineText || "Try On"}
            </div>
          )}
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 5 }}>
            <div style={{ height: 6, width: "92%", background: "#ECEEF3", borderRadius: 3 }} />
            <div style={{ height: 6, width: "78%", background: "#ECEEF3", borderRadius: 3 }} />
          </div>
        </div>
      </div>

      {/* Floating widget bubble (only when enabled on product pages) */}
      {floatPdp && (
        <div
          style={{
            position: "absolute",
            bottom: "14px",
            [position === "left" ? "left" : "right"]: "14px",
            width: "44px",
            height: "44px",
            borderRadius: "50%",
            background: color,
            boxShadow: "0 4px 12px rgba(11,18,32,0.18)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: textColor,
            fontSize: "15px",
            fontWeight: 800,
            transition: "left 220ms ease, right 220ms ease, background 220ms ease",
          }}
        >
          Try
        </div>
      )}
    </div>
  );
}

function ColorSwatch({
  value,
  selected,
  onClick,
}: {
  value: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Use color ${value}`}
      style={{
        width: 36,
        height: 36,
        borderRadius: "50%",
        background: value,
        border: selected ? "3px solid #3B63D4" : "2px solid #D8DCE3",
        cursor: "pointer",
        padding: 0,
        boxShadow: selected ? "0 0 0 2px #fff inset" : undefined,
        transition: "border-color 120ms ease",
      }}
    />
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────
export default function WidgetDesign() {
  const initial = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [brandColor, setBrandColor] = useState<string>(initial.brandColor || DEFAULT_COLOR);
  const [inlineEnabled, setInlineEnabled] = useState<boolean>(initial.inlineEnabled);
  const [inlineText, setInlineText] = useState<string>(initial.inlineText || DEFAULTS.inlineText);
  const [inlineHideOos, setInlineHideOos] = useState<boolean>(initial.inlineHideOos);
  const [floatPdp, setFloatPdp] = useState<boolean>(initial.floatPdp);
  const [floatNonPdp, setFloatNonPdp] = useState<boolean>(initial.floatNonPdp);
  const [position, setPosition] = useState<"left" | "right">(initial.position);
  const [previewEnabled, setPreviewEnabled] = useState<boolean>(initial.previewEnabled);
  const [previewDelay, setPreviewDelay] = useState<string>(String(initial.previewDelay));

  const saving = fetcher.state !== "idle";
  const saved = fetcher.data?.ok === true;
  const saveError = fetcher.data && fetcher.data.ok === false ? fetcher.data.error : null;

  const dirty = useMemo(() => {
    return (
      normalizeHex(brandColor) !== normalizeHex(initial.brandColor) ||
      inlineEnabled !== initial.inlineEnabled ||
      inlineText !== initial.inlineText ||
      inlineHideOos !== initial.inlineHideOos ||
      floatPdp !== initial.floatPdp ||
      floatNonPdp !== initial.floatNonPdp ||
      position !== initial.position ||
      previewEnabled !== initial.previewEnabled ||
      String(previewDelay) !== String(initial.previewDelay)
    );
  }, [
    brandColor, inlineEnabled, inlineText, inlineHideOos, floatPdp,
    floatNonPdp, position, previewEnabled, previewDelay, initial,
  ]);

  const handleSave = () => {
    const fd = new FormData();
    fd.set("brand_color", brandColor);
    fd.set("inline_enabled", String(inlineEnabled));
    fd.set("inline_text", inlineText);
    fd.set("inline_hide_oos", String(inlineHideOos));
    fd.set("float_pdp", String(floatPdp));
    fd.set("float_non_pdp", String(floatNonPdp));
    fd.set("position", position);
    fd.set("preview_enabled", String(previewEnabled));
    fd.set("preview_delay", previewDelay);
    fetcher.submit(fd, { method: "POST" });
  };

  return (
    <Page
      title="Widget Design"
      subtitle="Customize how the Try-On button and widget look and behave on your storefront."
      primaryAction={{
        content: "Save",
        onAction: handleSave,
        loading: saving,
        disabled: !dirty,
      }}
    >
      <BlockStack gap="400">
        {saved && !dirty && (
          <Banner tone="success">
            Saved. Your storefront updates within about 30 seconds.
          </Banner>
        )}
        {saveError && <Banner tone="critical">{saveError}</Banner>}

        <Layout>
          {/* ── Settings column ── */}
          <Layout.Section>
            <BlockStack gap="400">
              {/* Brand color */}
              <Card>
                <BlockStack gap="300">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">Brand color</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Used for the inline Try-On button and the floating widget. Text color is chosen automatically for contrast.
                    </Text>
                  </BlockStack>
                  <InlineStack gap="300" blockAlign="center" wrap>
                    {COLOR_PRESETS.map((preset) => (
                      <ColorSwatch
                        key={preset}
                        value={preset}
                        selected={brandColor.toLowerCase() === preset.toLowerCase()}
                        onClick={() => setBrandColor(preset)}
                      />
                    ))}
                    <label
                      htmlFor="custom-color"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                        cursor: "pointer",
                        padding: "6px 10px",
                        borderRadius: 8,
                        border: "1px solid #D8DCE3",
                        background: "#fff",
                      }}
                    >
                      <span
                        style={{
                          width: 20,
                          height: 20,
                          borderRadius: 4,
                          background: brandColor,
                          border: "1px solid #D8DCE3",
                        }}
                      />
                      <span style={{ fontSize: 13, color: "#2A3347" }}>Custom</span>
                      <input
                        id="custom-color"
                        type="color"
                        value={normalizeHex(brandColor)}
                        onChange={(e) => setBrandColor(e.target.value)}
                        style={{ width: 0, height: 0, opacity: 0, position: "absolute" }}
                      />
                    </label>
                    <Text as="span" variant="bodySm" tone="subdued">{brandColor.toUpperCase()}</Text>
                  </InlineStack>
                </BlockStack>
              </Card>

              {/* Inline Try-On button */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Inline Try-On button</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    The button shown directly on product pages, next to Add to cart.
                  </Text>
                  <Checkbox
                    label="Show the inline Try-On button on product pages"
                    checked={inlineEnabled}
                    onChange={setInlineEnabled}
                  />
                  <TextField
                    label="Button text"
                    value={inlineText}
                    onChange={setInlineText}
                    autoComplete="off"
                    maxLength={MAX_INLINE_TEXT}
                    disabled={!inlineEnabled}
                    helpText={`Up to ${MAX_INLINE_TEXT} characters.`}
                  />
                  <Checkbox
                    label="Hide the button on out-of-stock products"
                    checked={inlineHideOos}
                    onChange={setInlineHideOos}
                    disabled={!inlineEnabled}
                  />
                </BlockStack>
              </Card>

              {/* Floating widget */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Floating widget</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    The round Try-On bubble that floats in a bottom corner of the page.
                  </Text>
                  <Checkbox
                    label="Show on product pages"
                    checked={floatPdp}
                    onChange={setFloatPdp}
                  />
                  <Checkbox
                    label="Show on other pages (home, collections, etc.)"
                    checked={floatNonPdp}
                    onChange={setFloatNonPdp}
                  />
                  <BlockStack gap="150">
                    <Text as="span" variant="bodyMd">Position</Text>
                    <ButtonGroup variant="segmented">
                      <Button pressed={position === "left"} onClick={() => setPosition("left")}>
                        Bottom left
                      </Button>
                      <Button pressed={position === "right"} onClick={() => setPosition("right")}>
                        Bottom right
                      </Button>
                    </ButtonGroup>
                  </BlockStack>
                </BlockStack>
              </Card>

              {/* Desktop preview popup */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Desktop preview popup</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    An optional popup that invites desktop shoppers to try the item on after a short delay.
                  </Text>
                  <Checkbox
                    label="Show the preview popup on desktop"
                    checked={previewEnabled}
                    onChange={setPreviewEnabled}
                  />
                  <Box maxWidth="220px">
                    <TextField
                      label="Delay before showing (seconds)"
                      type="number"
                      value={previewDelay}
                      onChange={setPreviewDelay}
                      autoComplete="off"
                      min={0}
                      max={60}
                      disabled={!previewEnabled}
                    />
                  </Box>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>

          {/* ── Live preview column ── */}
          <Layout.Section variant="oneThird">
            <div style={{ position: "sticky", top: "16px" }}>
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Live preview</Text>
                  <StorefrontPreview
                    color={brandColor}
                    inlineEnabled={inlineEnabled}
                    inlineText={inlineText}
                    floatPdp={floatPdp}
                    position={position}
                  />
                  <Text as="p" variant="bodySm" tone="subdued">
                    A simplified mock of a product page. Your live storefront updates within ~30 seconds of saving.
                  </Text>
                </BlockStack>
              </Card>
            </div>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
