import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, FunctionComponent, ReactNode, SVGProps } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Button,
  ButtonGroup,
  Checkbox,
  TextField,
  Box,
  Banner,
  Divider,
  Tooltip,
  Select,
} from "@shopify/polaris";
import {
  ButtonIcon,
  CameraIcon as CameraGlyphIcon,
  CartUpIcon,
  ChartCohortIcon,
  ChatIcon,
  ChevronDownIcon,
  CollectionIcon,
  ColorIcon,
  ConnectIcon,
  DesktopIcon,
  PlusCircleIcon,
  ProductIcon,
  SettingsIcon,
  StoreOnlineIcon,
} from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../lib/supabase.server";
import { resolveStorefront, fetchStorefrontProducts } from "../lib/storefront-names.server";
import { SectionHeading, brand, fonts, PageHeader, PillButton } from "../components/ui";
import { IconChip, StatusPill } from "../components/analytics";

const MAX_QUICK_PICKS = 6;

interface CuratedItem {
  id: string;
  title: string;
  image: string | null;
  price: number | null;
}

// ─── Color helpers ──────────────────────────────────────────────────────────
const COLOR_PRESETS = [
  "#0B1220", // ink
  "#3B63D4", // ello blue
  "#1E3A8A", // deep blue
  "#17A673", // emerald
  "#DB2777", // pink
  "#B08D57", // champagne
];

const DEFAULT_COLOR = "#0B1220";

// How the Complete the Look offer first appears over the hero. "classic" is
// the legacy full-width sheet and is stored as NULL (so nothing shifts for a
// store until its merchant actively picks one of the three new intros).
type CtlIntroStyle = "classic" | "pairing" | "whisper" | "drop";
const asCtlIntroStyle = (v: unknown): CtlIntroStyle =>
  v === "pairing" || v === "whisper" || v === "drop" ? v : "classic";

// Border treatment on the inline try-on button. "none" is stored as NULL;
// the widget injects the CSS (elloApplyInlineBtnBorder) so no theme-extension
// deploy is involved.
type BtnBorderStyle = "none" | "halo" | "gradient" | "double" | "shimmer";
const asBtnBorderStyle = (v: unknown): BtnBorderStyle =>
  v === "halo" || v === "gradient" || v === "double" || v === "shimmer" ? v : "none";

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

const DEFAULTS = {
  brandColor: DEFAULT_COLOR,
  inlineEnabled: true,
  inlineText: "Try On",
  inlineHideOos: false,
  btnBorderStyle: "none" as BtnBorderStyle,
  btnBorderColor: null as string | null,
  floatPdp: false,
  floatNonPdp: true,
  fittingRoomEnabled: true,
  pdpImageSwapEnabled: false,
  pdpImageSelector: "",
  completeTheLookEnabled: false,
  ctlIntroStyle: "classic" as CtlIntroStyle,
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
        "shop_domain",
        "storefront_token",
        "widget_primary_color",
        "minimized_color",
        "inline_button_color",
        "inline_button_enabled",
        "inline_button_text",
        "inline_button_hide_when_oos",
        "inline_button_border_style",
        "inline_button_border_color",
        "floating_widget_pdp_enabled",
        "floating_widget_non_pdp_enabled",
        "fitting_room_enabled",
        "pdp_image_swap_enabled",
        "pdp_image_selector",
        "complete_the_look_enabled",
        "ctl_intro_style",
        "live_tryon_enabled",
        "widget_position",
        "widget_enabled",
        "desktop_preview_enabled",
        "preview_delay_seconds",
        "preview_theme",
        "featured_item_id",
        "quick_picks_ids",
      ].join(", "),
    )
    .eq("shop_domain", session.shop)
    .maybeSingle();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = data as any;

  // Resolve curated products (title, photo, price) so the live widget preview
  // shows the real thing, not GIDs.
  const featuredId = (row?.featured_item_id as string | null) ?? null;
  const quickPickIds = Array.isArray(row?.quick_picks_ids) ? (row.quick_picks_ids as string[]) : [];
  const idToGid = (raw: string): string => (raw.startsWith("gid://") ? raw : `gid://shopify/Product/${raw}`);
  const curatedIds = [...(featuredId ? [featuredId] : []), ...quickPickIds];
  const domain = (row?.shop_domain as string | null) ?? null;
  const token = (row?.storefront_token as string | null) ?? null;
  const [meta, curatedProducts] = await Promise.all([
    resolveStorefront(domain, token, curatedIds.map(idToGid)),
    fetchStorefrontProducts(domain, token, curatedIds.map(idToGid)),
  ]);
  const curatedOf = (id: string): CuratedItem => {
    const p = curatedProducts.get(idToGid(id));
    return {
      id,
      title: p?.title ?? meta.titles.get(idToGid(id)) ?? id,
      image: p?.featuredImage ?? null,
      price: p?.price ?? null,
    };
  };

  return {
    storeExists: !!row,
    currencyCode: meta.currencyCode,
    widgetEnabled: (row?.widget_enabled as boolean | null) ?? true,
    previewTheme: (row?.preview_theme as string | null) === "dark" ? ("dark" as const) : ("light" as const),
    featured: featuredId ? curatedOf(featuredId) : null,
    quickPicks: quickPickIds.map(curatedOf),
    brandColor:
      row?.inline_button_color ??
      row?.minimized_color ??
      row?.widget_primary_color ??
      DEFAULTS.brandColor,
    inlineEnabled: row?.inline_button_enabled ?? DEFAULTS.inlineEnabled,
    inlineText: row?.inline_button_text ?? DEFAULTS.inlineText,
    inlineHideOos: row?.inline_button_hide_when_oos ?? DEFAULTS.inlineHideOos,
    btnBorderStyle: asBtnBorderStyle(row?.inline_button_border_style),
    btnBorderColor: /^#[0-9a-fA-F]{6}$/.test(String(row?.inline_button_border_color ?? "")) ? (row.inline_button_border_color as string) : null,
    floatPdp: row?.floating_widget_pdp_enabled ?? DEFAULTS.floatPdp,
    floatNonPdp: row?.floating_widget_non_pdp_enabled ?? DEFAULTS.floatNonPdp,
    fittingRoomEnabled: row?.fitting_room_enabled ?? DEFAULTS.fittingRoomEnabled,
    pdpImageSwapEnabled: row?.pdp_image_swap_enabled ?? DEFAULTS.pdpImageSwapEnabled,
    pdpImageSelector: (row?.pdp_image_selector as string | null) ?? DEFAULTS.pdpImageSelector,
    completeTheLookEnabled: row?.complete_the_look_enabled ?? DEFAULTS.completeTheLookEnabled,
    ctlIntroStyle: asCtlIntroStyle(row?.ctl_intro_style),
    // Early-access flag: set by Ello support (SQL), deliberately NOT written by
    // this page's action — same protection as ctl_holdout_enabled (line ~237).
    liveTryonEnabled: (row?.live_tryon_enabled as boolean | null) ?? false,
    shopHandle: session.shop.replace(".myshopify.com", ""),
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

  const featuredRaw = String(form.get("featured_item_id") ?? "").trim();
  let quickPicks: string[] = [];
  try {
    const v = JSON.parse(String(form.get("quick_picks_ids") ?? "[]"));
    if (Array.isArray(v)) {
      quickPicks = v.filter((x): x is string => typeof x === "string").slice(0, MAX_QUICK_PICKS);
    }
  } catch {
    quickPicks = [];
  }

  // The CTL holdout test toggle lives on the Proof page now (with the rest of
  // the testing) — this action must never write ctl_holdout_enabled, or a
  // routine design save would silently stop a running test.
  const { data, error } = await supabaseAdmin
    .from("vto_stores")
    .update({
      widget_enabled: bool("widget_enabled"),
      preview_theme: form.get("preview_theme") === "dark" ? "dark" : "light",
      featured_item_id: featuredRaw || null,
      quick_picks_ids: quickPicks,
      widget_primary_color: brandColor,
      minimized_color: brandColor,
      inline_button_color: brandColor,
      inline_button_text_color: readableTextColor(brandColor),
      inline_button_enabled: bool("inline_enabled"),
      inline_button_text: inlineText,
      inline_button_hide_when_oos: bool("inline_hide_oos"),
      // "none" stores NULL; the CHECK constraint only admits the four names.
      inline_button_border_style: (() => {
        const v = String(form.get("btn_border_style") ?? "");
        return v === "halo" || v === "gradient" || v === "double" || v === "shimmer" ? v : null;
      })(),
      // Solid border: switch off sends "" → NULL; CHECK admits #RRGGBB only.
      inline_button_border_color: (() => {
        const v = String(form.get("btn_border_color") ?? "");
        return /^#[0-9a-fA-F]{6}$/.test(v) ? v : null;
      })(),
      floating_widget_pdp_enabled: bool("float_pdp"),
      floating_widget_non_pdp_enabled: bool("float_non_pdp"),
      fitting_room_enabled: bool("fitting_room_enabled"),
      pdp_image_swap_enabled: bool("pdp_image_swap_enabled"),
      // Advanced hero-targeting override. Stored trimmed, empty → NULL (widget
      // treats NULL as "use the automatic cascade").
      pdp_image_selector: String(form.get("pdp_image_selector") ?? "").trim().slice(0, 300) || null,
      complete_the_look_enabled: bool("complete_the_look_enabled"),
      // "classic" is stored as NULL — the widget treats NULL as the legacy
      // sheet, and the CHECK constraint only admits the three named intros.
      ctl_intro_style: (() => {
        const v = String(form.get("ctl_intro_style") ?? "");
        return v === "pairing" || v === "whisper" || v === "drop" ? v : null;
      })(),
      widget_position: form.get("position") === "left" ? "left" : "right",
      desktop_preview_enabled: bool("preview_enabled"),
      preview_delay_seconds: previewDelay,
    })
    .eq("shop_domain", session.shop)
    .select("store_slug")
    .maybeSingle();

  if (error) return { ok: false as const, error: error.message };
  if (!data) {
    return {
      ok: false as const,
      error: "We couldn't find your store record yet. Finish onboarding, then try saving again.",
    };
  }
  return { ok: true as const };
};

// ─── Live storefront preview (closed widget: PDP + inline button + bubble) ──
function ShirtIcon({ color, size = 22 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M8 3 L4.5 5 L2 9 L5.5 11.3 L7 10.3 V20 C7 20.55 7.45 21 8 21 H16 C16.55 21 17 20.55 17 20 V10.3 L18.5 11.3 L22 9 L19.5 5 L16 3 C16 3 14.4 4.6 12 4.6 C9.6 4.6 8 3 8 3 Z"
        fill={color}
      />
    </svg>
  );
}

// Same hanger the real storefront launcher draws via CSS mask.
function HangerIcon({ color, size = 26 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 9 V6 a1.8 1.8 0 1 0 -1.8 1.8" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 9 L4.2 14.8 a1.2 1.2 0 0 0 .7 2.1 H19.1 a1.2 1.2 0 0 0 .7 -2.1 L12 9 Z" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CameraIcon({ color, size = 20 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden>
      <path d="M12 15.2A3.2 3.2 0 1 0 12 8.8a3.2 3.2 0 0 0 0 6.4Z" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9 2 7.17 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3.17L15 2H9Zm3 15a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z"
      />
    </svg>
  );
}

function ArrowRightIcon({ color, size = 16 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

// ─── Spotlight: hover a settings card → highlight what it controls ─────────
type SpotKey =
  | "status" | "brand" | "inline" | "float" | "popup"
  // Demo keys: these don't just spotlight an element — they play out the
  // feature in the preview (ctl follows the CURRENT style toggle, the two
  // style keys force their respective mode so preset tiles can show both).
  | "ctl" | "styleMirror" | "styleWidget";
type SpotEl = "frame" | "inline" | "bubble" | "popup";

const SPOT_MAP: Record<SpotKey, SpotEl[]> = {
  status: ["frame"],
  brand: ["inline", "bubble"],
  inline: ["inline"],
  float: ["bubble"],
  popup: ["popup"],
  ctl: [],
  styleMirror: [],
  styleWidget: [],
};

const SPOT_LABELS: Record<SpotEl, string> = {
  frame: "",
  inline: "Inline Try-On button",
  bubble: "Floating widget",
  popup: "Preview popup",
};

function SpotTag({ label, align = "left" }: { label: string; align?: "left" | "right" }) {
  return (
    <span
      style={{
        position: "absolute",
        top: -29,
        ...(align === "right" ? { right: 0 } : { left: 0 }),
        background: brand.blue,
        color: brand.white,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.05em",
        padding: "3px 9px",
        borderRadius: 7,
        whiteSpace: "nowrap",
        pointerEvents: "none",
        boxShadow: "0 4px 12px rgba(11,18,32,0.22)",
        zIndex: 6,
      }}
    >
      {label}
    </span>
  );
}

function SpotZone({
  k,
  onSpot,
  children,
}: {
  k: SpotKey;
  onSpot: (k: SpotKey | null) => void;
  children: ReactNode;
}) {
  return (
    <div
      onMouseEnter={() => onSpot(k)}
      onMouseLeave={() => onSpot(null)}
      onFocusCapture={() => onSpot(k)}
      onBlurCapture={() => onSpot(null)}
    >
      {children}
    </div>
  );
}

// Simple person silhouette for the "result on you" demos.
function PersonIcon({ color, size = 64 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden>
      <circle cx="12" cy="6" r="3.2" />
      <path d="M12 10.2c-3.6 0-6 2.5-6 6.3V21h12v-4.5c0-3.8-2.4-6.3-6-6.3z" />
    </svg>
  );
}

function StorefrontPreview({
  color,
  inlineEnabled,
  inlineText,
  floatPdp,
  position,
  widgetEnabled,
  previewEnabled,
  previewTheme,
  previewDelay,
  pdpImageSwapEnabled,
  completeTheLookEnabled,
  ctlIntroStyle,
  btnBorderStyle,
  btnBorderColor,
  spot,
}: {
  color: string;
  inlineEnabled: boolean;
  inlineText: string;
  floatPdp: boolean;
  position: "left" | "right";
  widgetEnabled: boolean;
  previewEnabled: boolean;
  previewTheme: "light" | "dark";
  previewDelay: string;
  pdpImageSwapEnabled: boolean;
  completeTheLookEnabled: boolean;
  ctlIntroStyle: CtlIntroStyle;
  btnBorderStyle: BtnBorderStyle;
  btnBorderColor: string | null;
  spot: SpotKey | null;
}) {
  const textColor = readableTextColor(color);
  const side = position === "left" ? "left" : "right";
  const dimmed = widgetEnabled ? 1 : 0.3;
  const line = (w: string, h = 8, c = brand.ink100, mt = 0) => (
    <div style={{ height: h, width: w, background: c, borderRadius: 4, marginTop: mt }} />
  );
  const popupDark = previewTheme === "dark";

  // The launcher periodically plays its hover reveal so merchants see the
  // hanger-to-pill animation without having to discover it by hovering.
  const [bubbleHover, setBubbleHover] = useState(false);
  const [bubbleDemo, setBubbleDemo] = useState(false);
  useEffect(() => {
    if (!floatPdp) return undefined;
    let hide: ReturnType<typeof setTimeout> | undefined;
    const cycle = setInterval(() => {
      setBubbleDemo(true);
      hide = setTimeout(() => setBubbleDemo(false), 1700);
    }, 7000);
    return () => {
      clearInterval(cycle);
      if (hide) clearTimeout(hide);
    };
  }, [floatPdp]);
  const bubbleOpen = bubbleHover || bubbleDemo;

  // Every element can be spotlighted — even ones currently toggled OFF.
  // Hovering a settings card always demonstrates its feature in the preview
  // (ghosted + labeled "currently off" when disabled), so merchants never
  // have to turn something on just to find out what it is.
  const visibleEls: Record<SpotEl, boolean> = {
    frame: true,
    inline: true,
    bubble: true,
    popup: true,
  };
  const targets = spot ? SPOT_MAP[spot].filter((el) => visibleEls[el]) : [];
  const spotted = (el: SpotEl) => targets.includes(el);
  const spotting = targets.length > 0 && !spotted("frame");
  const ring = (el: SpotEl): CSSProperties =>
    spotted(el) ? { outline: `2px solid ${brand.blue}`, outlineOffset: 3 } : {};
  const fade = (el: SpotEl) => (spotting && !spotted(el) ? 0.35 : 1);

  // Feature demos. ctl narrates whatever the style toggle CURRENTLY does (on →
  // photo, off → widget); the style keys force one mode each so the preset
  // tiles can each show their own world regardless of current settings.
  const mirrorDemo = spot === "styleMirror" || (spot === "ctl" && pdpImageSwapEnabled);
  const widgetDemo = spot === "styleWidget" || (spot === "ctl" && !pdpImageSwapEnabled);
  const ctlDemo = spot === "ctl";
  const introCaption: Record<CtlIntroStyle, string> = {
    pairing: "The Pairing: one floating piece in the corner — a quiet label, the item, one ask. No price up front.",
    whisper: "The Whisper: only a tiny chip appears; the full offer unfolds when the shopper taps it.",
    drop: "The Drop: the product lands on the photo with its price tag and a button.",
    classic: "Classic: the full-width card with name and price rides the photo's bottom edge.",
  };
  const caption =
    spot === "ctl"
      ? (pdpImageSwapEnabled
          ? introCaption[ctlIntroStyle]
          : "The offer appears inside the widget, directly under the try-on result.") +
        (completeTheLookEnabled ? "" : " (Currently off.)")
      : spot === "styleMirror"
        ? "Product-page style — no widget: the Try-On button paints the result straight onto your product photo."
        : spot === "styleWidget"
          ? "Widget style — the Try-On button opens the Ello widget and the result renders inside it."
          : null;

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        borderRadius: 16,
        border: `1px solid ${brand.ink100}`,
        background: brand.white,
        overflow: "hidden",
        boxShadow: "0 12px 36px rgba(11,18,32,0.10)",
        ...ring("frame"),
      }}
    >
      {/* Browser chrome */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "12px 16px",
          borderBottom: `1px solid ${brand.ink100}`,
          background: brand.offwhite,
        }}
      >
        <span style={{ width: 10, height: 10, borderRadius: 5, background: "#F1968E" }} />
        <span style={{ width: 10, height: 10, borderRadius: 5, background: "#F4CE8A" }} />
        <span style={{ width: 10, height: 10, borderRadius: 5, background: "#9FD8B4" }} />
        <div
          style={{
            flex: 1,
            margin: "0 10%",
            height: 20,
            background: brand.ink50,
            borderRadius: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 10,
            color: brand.ink500,
            letterSpacing: "0.02em",
          }}
        >
          🔒 your-store.com/products/atlas-hoodie
        </div>
        {!widgetEnabled && (
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: brand.danger,
              background: "#FBEAEA",
              border: `1px solid ${brand.danger}33`,
              borderRadius: 999,
              padding: "2px 8px",
              flexShrink: 0,
            }}
          >
            Widget off
          </span>
        )}
      </div>

      {/* Product layout */}
      <div style={{ display: "flex", gap: 20, padding: 20 }}>
        <div
          style={{
            flex: "0 0 44%",
            aspectRatio: "3 / 4",
            position: "relative",
            borderRadius: 12,
            overflow: "hidden",
            background: `radial-gradient(120% 90% at 30% 20%, ${brand.blue50} 0%, ${brand.ink100} 70%, ${brand.ink200} 100%)`,
          }}
        >
          <span
            style={{
              position: "absolute",
              top: 12,
              left: 12,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.08em",
              background: brand.white,
              color: brand.ink700,
              borderRadius: 999,
              padding: "3px 9px",
              boxShadow: "0 2px 8px rgba(11,18,32,0.10)",
            }}
          >
            NEW
          </span>
          <div style={{ position: "absolute", inset: "28% 30% 12% 30%", display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.5 }}>
            <ShirtIcon color={brand.ink500} size={84} />
          </div>

          {/* Mirror demo: the product photo "becomes" the shopper */}
          <div
            aria-hidden={!mirrorDemo}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              background: `radial-gradient(120% 90% at 50% 15%, ${brand.blue50} 0%, #DDE7F5 55%, ${brand.ink200} 100%)`,
              opacity: mirrorDemo ? 1 : 0,
              transition: "opacity 240ms ease",
              pointerEvents: "none",
              outline: mirrorDemo ? `2px solid ${brand.blue}` : "none",
              outlineOffset: -2,
              borderRadius: 12,
              zIndex: 2,
            }}
          >
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.06em",
                background: brand.blue,
                color: brand.white,
                borderRadius: 999,
                padding: "3px 10px",
                boxShadow: "0 4px 12px rgba(11,18,32,0.22)",
              }}
            >
              ✨ Your shopper, wearing it
            </span>
            <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <PersonIcon color={brand.ink500} size={110} />
              <span style={{ position: "absolute", top: 46 }}>
                <ShirtIcon color={color} size={44} />
              </span>
            </div>

            {/* Complete the Look offer — rendered in the CHOSEN intro style
                (or the hovered option's style), so the picker and the preview
                always tell the same story. */}
            {ctlDemo && ctlIntroStyle === "classic" && (
              <div
                style={{
                  position: "absolute",
                  left: 8,
                  right: 8,
                  bottom: 8,
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.96)",
                  boxShadow: "0 6px 20px rgba(11,18,32,0.20)",
                  padding: "7px 9px",
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  textAlign: "left",
                }}
              >
                <div
                  style={{
                    width: 24,
                    height: 30,
                    borderRadius: 5,
                    background: brand.ink100,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <ShirtIcon color={brand.ink500} size={14} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: brand.ink }}>Complete the look</div>
                  <div style={{ fontSize: 8.5, color: brand.ink500 }}>Pants · $59</div>
                </div>
                <span
                  style={{
                    fontSize: 8.5,
                    fontWeight: 700,
                    background: color,
                    color: readableTextColor(color),
                    borderRadius: 999,
                    padding: "4px 8px",
                    whiteSpace: "nowrap",
                  }}
                >
                  + Try it on too
                </span>
              </div>
            )}
            {ctlDemo && ctlIntroStyle === "pairing" && (
              <div
                style={{
                  position: "absolute",
                  right: 10,
                  bottom: 10,
                  width: 74,
                  borderRadius: 10,
                  background: "rgba(246,243,236,0.98)",
                  border: "1px solid rgba(0,0,0,0.05)",
                  boxShadow: "0 10px 24px rgba(11,18,32,0.24)",
                  overflow: "hidden",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 5.5, fontWeight: 800, letterSpacing: "0.07em", color: "#75716A", padding: "5px 4px 2px", whiteSpace: "nowrap" }}>
                  ✦ PAIRS WITH THIS
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 46 }}>
                  <ShirtIcon color={brand.ink700} size={30} />
                </div>
                <div
                  style={{
                    background: color,
                    color: readableTextColor(color),
                    fontSize: 7,
                    fontWeight: 700,
                    padding: "5px 3px",
                    whiteSpace: "nowrap",
                  }}
                >
                  + Try it on too
                </div>
              </div>
            )}
            {ctlDemo && ctlIntroStyle === "whisper" && (
              <div
                style={{
                  position: "absolute",
                  left: "50%",
                  bottom: 10,
                  transform: "translateX(-50%)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  background: "rgba(255,255,255,0.97)",
                  borderRadius: 999,
                  boxShadow: "0 5px 16px rgba(11,18,32,0.20)",
                  padding: "5px 10px",
                  whiteSpace: "nowrap",
                }}
              >
                <span style={{ fontSize: 8, fontWeight: 700, color: brand.ink }}>✦ Complete the look</span>
                <span style={{ width: 5, height: 5, borderRadius: 999, background: color }} />
              </div>
            )}
            {ctlDemo && ctlIntroStyle === "drop" && (
              <div style={{ position: "absolute", right: 10, bottom: 10, width: 58, textAlign: "center" }}>
                <div
                  style={{
                    position: "relative",
                    width: 58,
                    height: 70,
                    borderRadius: 9,
                    background: "rgba(246,243,236,0.98)",
                    border: "1px solid rgba(0,0,0,0.05)",
                    boxShadow: "0 10px 24px rgba(11,18,32,0.24)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <ShirtIcon color={brand.ink700} size={30} />
                  <span
                    style={{
                      position: "absolute",
                      top: -7,
                      left: -9,
                      background: color,
                      color: readableTextColor(color),
                      fontSize: 7,
                      fontWeight: 700,
                      borderRadius: 999,
                      padding: "3px 6px",
                      transform: "rotate(-6deg)",
                      boxShadow: "0 3px 8px rgba(11,18,32,0.25)",
                    }}
                  >
                    $59
                  </span>
                </div>
                <div
                  style={{
                    marginTop: 5,
                    background: color,
                    color: readableTextColor(color),
                    fontSize: 7,
                    fontWeight: 700,
                    borderRadius: 999,
                    padding: "4px 3px",
                    whiteSpace: "nowrap",
                    boxShadow: "0 5px 12px rgba(11,18,32,0.22)",
                  }}
                >
                  + Try it on too
                </div>
              </div>
            )}
          </div>
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10, paddingTop: 6 }}>
          {line("78%", 15, brand.ink200)}
          {line("44%", 9, brand.ink100, 2)}
          <div style={{ fontSize: 18, fontWeight: 650, color: brand.ink, marginTop: 4 }}>$49.99</div>

          {/* Size chips */}
          <div style={{ display: "flex", gap: 7, marginTop: 2 }}>
            {["S", "M", "L", "XL"].map((s, i) => (
              <span
                key={s}
                style={{
                  width: 36,
                  height: 30,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  fontWeight: 600,
                  color: i === 1 ? brand.ink : brand.ink500,
                  border: i === 1 ? `1.5px solid ${brand.ink}` : `1px solid ${brand.ink200}`,
                  borderRadius: 7,
                  background: brand.white,
                }}
              >
                {s}
              </span>
            ))}
          </div>

          <div
            style={{
              height: 44,
              width: "100%",
              marginTop: 8,
              background: brand.ink,
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: brand.white,
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: "0.01em",
            }}
          >
            Add to cart
          </div>

          {(inlineEnabled || spotted("inline")) && (
            <div style={{ position: "relative", opacity: fade("inline"), transition: "opacity 200ms ease" }}>
              {spotted("inline") && (
                <SpotTag label={SPOT_LABELS.inline + (inlineEnabled ? "" : " · currently off")} />
              )}
              {/* Mirrors the real inline button: text only, square corners,
                  shaped like the theme's Add to cart so it reads native —
                  wearing the merchant's border and animation picks live. */}
              <div
                className={ebwClass(btnBorderStyle)}
                style={{
                  position: "relative",
                  height: 44,
                  width: "100%",
                  background: color,
                  color: textColor,
                  borderRadius: 4,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 13,
                  fontWeight: 500,
                  letterSpacing: "0.01em",
                  border: btnBorderColor ? `2px solid ${btnBorderColor}` : "none",
                  opacity: inlineEnabled ? dimmed : 0.55,
                  transition: "background 240ms ease, opacity 240ms ease",
                  ...ring("inline"),
                }}
              >
                {inlineText || "Try On"}
              </div>
            </div>
          )}

          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 7 }}>
            {line("96%", 7)}
            {line("88%", 7)}
            {line("64%", 7)}
          </div>
        </div>
      </div>

      {/* Below the fold — gives the corner elements real page to float over */}
      <div style={{ padding: "4px 20px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
        {line("26%", 10)}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <div
                style={{
                  aspectRatio: "3 / 4",
                  borderRadius: 10,
                  background: `radial-gradient(120% 90% at 30% 20%, ${brand.blue50} 0%, ${brand.ink100} ${60 + i * 14}%, ${brand.ink200} 100%)`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: 0.6,
                }}
              >
                <ShirtIcon color={brand.ink500} size={34} />
              </div>
              {line("82%", 7)}
              {line("46%", 7)}
            </div>
          ))}
        </div>
      </div>

      {/* Desktop preview popup — scaled-down replica of the real storefront
          popup (product photo → your photo → generate). Stays hidden so the
          preview doesn't read as cluttered; slides up only while the merchant
          is hovering the Preview popup settings card. */}
      {(previewEnabled || spotted("popup")) && (
        <div
          aria-hidden={!spotted("popup")}
          style={{
            position: "absolute",
            bottom: 96,
            [side]: 18,
            width: 238,
            zIndex: 3,
            opacity: spotted("popup") ? (previewEnabled ? dimmed : 0.75) : 0,
            transform: spotted("popup") ? "translateY(0)" : "translateY(14px)",
            pointerEvents: "none",
            transition: "opacity 240ms ease, transform 240ms ease",
          }}
        >
          <div
            style={{
              position: "relative",
              borderRadius: 16,
              padding: 14,
              background: popupDark ? "#111111" : brand.white,
              border: `1px solid ${popupDark ? "#333333" : brand.ink100}`,
              boxShadow: "0 16px 40px rgba(11,18,32,0.24)",
              ...ring("popup"),
            }}
          >
            {spotted("popup") && (
              <SpotTag label={SPOT_LABELS.popup + (previewEnabled ? "" : " · currently off")} align={side} />
            )}
            <span
              aria-hidden
              style={{
                position: "absolute",
                top: 8,
                right: 8,
                width: 18,
                height: 18,
                borderRadius: 9,
                background: popupDark ? "rgba(255,255,255,0.12)" : brand.ink50,
                color: popupDark ? "#9CA3AF" : brand.ink500,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10,
                lineHeight: 1,
              }}
            >
              ✕
            </span>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginTop: 6 }}>
              <div
                style={{
                  width: 64,
                  height: 92,
                  borderRadius: 8,
                  flexShrink: 0,
                  background: `radial-gradient(120% 90% at 30% 20%, ${brand.blue50} 0%, ${brand.ink100} 70%, ${brand.ink200} 100%)`,
                  border: `1px solid ${popupDark ? "#333333" : brand.ink100}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <ShirtIcon color={brand.ink500} size={26} />
              </div>
              <ArrowRightIcon color="#9CA3AF" size={15} />
              <div
                style={{
                  width: 64,
                  height: 92,
                  borderRadius: 8,
                  flexShrink: 0,
                  border: `1px solid ${popupDark ? "#444444" : "#E5E7EB"}`,
                  background: popupDark ? "#222222" : "#F9FAFB",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <CameraIcon color={popupDark ? "#D1D5DB" : "#4B5563"} size={20} />
              </div>
            </div>
            <div style={{ marginTop: 9, textAlign: "center", fontSize: 11, lineHeight: 1.35, color: popupDark ? "#F3F4F6" : "#374151" }}>
              <span style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>See it on you.</span> Add your photo.
            </div>
            <div
              style={{
                marginTop: 9,
                height: 30,
                borderRadius: 8,
                background: popupDark ? brand.white : "#0F172A",
                color: popupDark ? "#0B1220" : brand.white,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.09em",
              }}
            >
              GENERATE MY LOOK
            </div>
            <div style={{ marginTop: 8, textAlign: "center", fontSize: 10, color: popupDark ? "#9CA3AF" : brand.ink500 }}>
              {previewEnabled
                ? `Appears after ${previewDelay || "3"}s on desktop`
                : "Currently off — enable it to greet desktop shoppers"}
            </div>
          </div>
        </div>
      )}

      {/* Floating launcher — same hanger-to-pill hover reveal as the real
          storefront widget. Ghosts in on hover even when toggled off. */}
      {(floatPdp || spotted("bubble")) && (
        <div
          onMouseEnter={() => setBubbleHover(true)}
          onMouseLeave={() => setBubbleHover(false)}
          style={{
            position: "absolute",
            bottom: 20,
            [side]: 18,
            zIndex: 4,
            opacity: (floatPdp ? dimmed : 0.55) * fade("bubble"),
            transition: "left 240ms ease, right 240ms ease, opacity 240ms ease",
          }}
        >
          {spotted("bubble") && (
            <SpotTag label={SPOT_LABELS.bubble + (floatPdp ? "" : " · currently off")} align={side} />
          )}
          <div
            style={{
              height: 58,
              width: bubbleOpen ? 196 : 58,
              borderRadius: 999,
              background: color,
              display: "flex",
              flexDirection: side === "right" ? "row-reverse" : "row",
              alignItems: "center",
              justifyContent: "center",
              gap: bubbleOpen ? 9 : 0,
              padding: bubbleOpen ? "0 17px" : 0,
              overflow: "hidden",
              border: "1px solid rgba(11,18,32,0.08)",
              boxShadow: widgetEnabled
                ? "0 10px 30px rgba(11,18,32,0.18), 0 2px 8px rgba(11,18,32,0.08)"
                : "none",
              transition:
                "width 320ms cubic-bezier(0.4, 0, 0.2, 1), gap 320ms cubic-bezier(0.4, 0, 0.2, 1), padding 320ms cubic-bezier(0.4, 0, 0.2, 1), background 240ms ease",
              ...ring("bubble"),
            }}
          >
            <span style={{ display: "flex", flexShrink: 0 }}>
              <HangerIcon color={textColor} size={26} />
            </span>
            <span
              style={{
                maxWidth: bubbleOpen ? 130 : 0,
                opacity: bubbleOpen ? 1 : 0,
                overflow: "hidden",
                whiteSpace: "nowrap",
                color: textColor,
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: "0.6px",
                textTransform: "uppercase",
                transition: "max-width 320ms cubic-bezier(0.4, 0, 0.2, 1), opacity 220ms ease 60ms",
              }}
            >
              Virtual Try-On
            </span>
          </div>
        </div>
      )}

      {/* Widget-mode demo: where results render when the mirror is OFF */}
      <div
        aria-hidden={!widgetDemo}
        style={{
          position: "absolute",
          bottom: 92,
          [side]: 18,
          width: 176,
          zIndex: 5,
          opacity: widgetDemo ? 1 : 0,
          transform: widgetDemo ? "translateY(0)" : "translateY(14px)",
          pointerEvents: "none",
          transition: "opacity 240ms ease, transform 240ms ease",
        }}
      >
        <div
          style={{
            borderRadius: 14,
            overflow: "hidden",
            background: brand.white,
            border: `1px solid ${brand.ink100}`,
            boxShadow: "0 16px 40px rgba(11,18,32,0.26)",
            outline: `2px solid ${brand.blue}`,
            outlineOffset: 3,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 10px",
              background: color,
              color: readableTextColor(color),
            }}
          >
            <HangerIcon color={readableTextColor(color)} size={13} />
            <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: "0.07em", textTransform: "uppercase" }}>
              Fitting room
            </span>
            <span style={{ marginLeft: "auto", fontSize: 10, opacity: 0.75 }}>✕</span>
          </div>
          <div
            style={{
              position: "relative",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              padding: "12px 10px 10px",
              background: `radial-gradient(120% 90% at 50% 0%, ${brand.blue50} 0%, ${brand.white} 75%)`,
            }}
          >
            <span
              style={{
                fontSize: 8.5,
                fontWeight: 700,
                letterSpacing: "0.05em",
                background: brand.blue,
                color: brand.white,
                borderRadius: 999,
                padding: "2px 8px",
              }}
            >
              ✨ The result renders here
            </span>
            <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <PersonIcon color={brand.ink500} size={64} />
              <span style={{ position: "absolute", top: 27 }}>
                <ShirtIcon color={color} size={26} />
              </span>
            </div>
            {ctlDemo && (
              <div
                style={{
                  width: "100%",
                  borderRadius: 8,
                  border: `1px solid ${brand.ink100}`,
                  background: brand.white,
                  padding: "6px 8px",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 8.5, fontWeight: 700, color: brand.ink }}>Complete the look</div>
                  <div style={{ fontSize: 8, color: brand.ink500 }}>Pants · $59</div>
                </div>
                <span
                  style={{
                    fontSize: 8,
                    fontWeight: 700,
                    background: color,
                    color: readableTextColor(color),
                    borderRadius: 999,
                    padding: "3px 7px",
                    whiteSpace: "nowrap",
                  }}
                >
                  + Try it on
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Narration strip: plain-English description of what the hovered
          setting is doing right now, inside the storefront frame. */}
      {caption && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 6,
            background: "rgba(11,18,32,0.88)",
            color: brand.white,
            fontSize: 11.5,
            lineHeight: 1.45,
            padding: "9px 14px",
            textAlign: "center",
            pointerEvents: "none",
          }}
        >
          {caption}
        </div>
      )}
    </div>
  );
}

// ─── Live widget preview (open state: featured + quick picks) ───────────────
function RemoveBadge({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      style={{
        position: "absolute",
        top: 6,
        right: 6,
        width: 20,
        height: 20,
        borderRadius: "50%",
        border: "none",
        cursor: "pointer",
        background: brand.danger,
        color: brand.white,
        fontSize: 12,
        fontWeight: 700,
        lineHeight: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 2px 8px rgba(11,18,32,0.25)",
        padding: 0,
      }}
    >
      ×
    </button>
  );
}

function PreviewLabel({ children }: { children: string }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: brand.ink500,
      }}
    >
      {children}
    </span>
  );
}

function DashedPlaceholder({ children }: { children: string }) {
  return (
    <div
      style={{
        border: `1.5px dashed ${brand.ink200}`,
        borderRadius: 12,
        padding: "18px 16px",
        textAlign: "center",
        fontSize: 12,
        color: brand.ink500,
        background: brand.offwhite,
      }}
    >
      {children}
    </div>
  );
}

function WidgetOpenPreview({
  featured,
  quickPicks,
  money,
  onRemoveFeatured,
  onRemoveQuickPick,
}: {
  featured: CuratedItem | null;
  quickPicks: CuratedItem[];
  money: (n: number) => string;
  onRemoveFeatured: () => void;
  onRemoveQuickPick: (id: string) => void;
}) {
  return (
    <div
      style={{
        width: "100%",
        maxWidth: 540,
        margin: "0 auto",
        borderRadius: 18,
        border: `1px solid ${brand.ink100}`,
        background: brand.white,
        boxShadow: "0 18px 50px rgba(11,18,32,0.14)",
        overflow: "hidden",
      }}
    >
      {/* Widget header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 18px",
          borderBottom: `1px solid ${brand.ink100}`,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.08em", color: brand.ink }}>
          VIRTUAL TRY-ON
        </span>
        <span
          aria-hidden
          style={{
            width: 26,
            height: 26,
            borderRadius: 8,
            border: `1px solid ${brand.ink200}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 13,
            color: brand.ink500,
          }}
        >
          ×
        </span>
      </div>

      <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 18 }}>
        {/* Featured today */}
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <PreviewLabel>⭐ Featured today</PreviewLabel>
          {featured ? (
            <div
              style={{
                position: "relative",
                display: "flex",
                gap: 14,
                alignItems: "center",
                border: `1px solid ${brand.ink100}`,
                borderRadius: 13,
                padding: 12,
                background: brand.offwhite,
              }}
            >
              <div
                style={{
                  width: 64,
                  height: 82,
                  borderRadius: 9,
                  flexShrink: 0,
                  background: featured.image
                    ? `center / cover no-repeat url(${JSON.stringify(featured.image)})`
                    : brand.ink100,
                  border: `1px solid ${brand.ink100}`,
                }}
              />
              <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    letterSpacing: "0.03em",
                    textTransform: "uppercase",
                    color: brand.ink,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {featured.title}
                </span>
                {featured.price != null && (
                  <span style={{ fontSize: 13, fontWeight: 600, color: brand.ink600 }}>{money(featured.price)}</span>
                )}
                <span
                  style={{
                    alignSelf: "flex-start",
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: "0.07em",
                    textTransform: "uppercase",
                    color: brand.ink600,
                    border: `1px solid ${brand.ink200}`,
                    borderRadius: 999,
                    padding: "2px 8px",
                    background: brand.white,
                  }}
                >
                  Featured
                </span>
              </div>
              <RemoveBadge label={`Remove ${featured.title} from featured`} onClick={onRemoveFeatured} />
            </div>
          ) : (
            <DashedPlaceholder>No featured item — Ello spotlights one of your products automatically.</DashedPlaceholder>
          )}
        </div>

        {/* Quick picks */}
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <PreviewLabel>🔥 Quick picks</PreviewLabel>
          {quickPicks.length > 0 ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
              {quickPicks.map((p) => (
                <div
                  key={p.id}
                  style={{
                    position: "relative",
                    aspectRatio: "3 / 4",
                    borderRadius: 11,
                    overflow: "hidden",
                    background: p.image
                      ? `center / cover no-repeat url(${JSON.stringify(p.image)})`
                      : `linear-gradient(150deg, ${brand.blue50} 0%, ${brand.ink100} 100%)`,
                    border: `1px solid ${brand.ink100}`,
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      bottom: 0,
                      padding: "16px 7px 7px",
                      background: "linear-gradient(to top, rgba(11,18,32,0.82), rgba(11,18,32,0))",
                      color: brand.white,
                      fontSize: 9,
                      fontWeight: 700,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                      textAlign: "center",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {p.title}
                  </div>
                  <RemoveBadge label={`Remove ${p.title} from quick picks`} onClick={() => onRemoveQuickPick(p.id)} />
                </div>
              ))}
            </div>
          ) : (
            <DashedPlaceholder>No quick picks — Ello rotates a varied mix from your catalog automatically.</DashedPlaceholder>
          )}
        </div>
      </div>
    </div>
  );
}

function ColorSwatch({ value, selected, onClick }: { value: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Use color ${value}`}
      style={{
        width: 34,
        height: 34,
        borderRadius: "50%",
        background: value,
        border: selected ? `2px solid ${brand.blue}` : `1px solid ${brand.ink200}`,
        outline: selected ? `2px solid ${brand.white}` : "none",
        outlineOffset: -4,
        cursor: "pointer",
        padding: 0,
        transition: "border-color 120ms ease",
      }}
    />
  );
}

// Selectable preset tile for the two try-on styles. The sketch is a
// thumbnail-size product page: the mirror variant highlights the photo (the
// result lands there), the widget variant shows a small panel over the page.
function StyleTile({
  active,
  title,
  subtitle,
  body,
  variant,
  onClick,
}: {
  active: boolean;
  title: string;
  subtitle: string;
  body: string;
  variant: "mirror" | "widget";
  onClick: () => void;
}) {
  const sketchLine = (w: number, mt = 6) => (
    <div style={{ height: 6, width: `${w}%`, background: brand.ink100, borderRadius: 3, marginTop: mt }} />
  );
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        height: "100%",
        textAlign: "left",
        cursor: "pointer",
        borderRadius: 12,
        padding: 18,
        background: brand.white,
        border: active ? `1.5px solid ${brand.ink}` : `1px solid ${brand.ink200}`,
        transition: "border-color 140ms ease, background 140ms ease",
      }}
    >
      {/* Product-page sketch — hero-sized so the choice reads at a glance */}
      <div
        style={{
          position: "relative",
          width: "100%",
          height: 132,
          borderRadius: 10,
          border: `1px solid ${active ? brand.blue200 : brand.ink100}`,
          background: brand.white,
          padding: 12,
          display: "flex",
          gap: 12,
          overflow: "hidden",
          marginBottom: 14,
        }}
      >
        {variant === "mirror" ? (
          <>
            <div
              style={{
                width: 76,
                borderRadius: 8,
                background: `radial-gradient(120% 90% at 50% 15%, ${brand.blue100} 0%, ${brand.blue50} 100%)`,
                border: `2px solid ${brand.blue}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <PersonIcon color={brand.blue} size={46} />
            </div>
            <div style={{ flex: 1, paddingTop: 6 }}>
              {sketchLine(85, 0)}
              {sketchLine(55)}
              <div style={{ height: 22, width: "70%", background: brand.ink, borderRadius: 6, marginTop: 14 }} />
              {sketchLine(70, 12)}
            </div>
          </>
        ) : (
          <>
            <div style={{ width: 76, borderRadius: 8, background: brand.ink100, flexShrink: 0 }} />
            <div style={{ flex: 1, paddingTop: 6 }}>
              {sketchLine(85, 0)}
              {sketchLine(55)}
              {sketchLine(70, 12)}
            </div>
            <div
              style={{
                position: "absolute",
                right: 10,
                bottom: 10,
                width: 64,
                height: 86,
                borderRadius: 8,
                background: brand.white,
                border: `2px solid ${brand.blue}`,
                boxShadow: "0 6px 16px rgba(11,18,32,0.18)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <div style={{ height: 12, width: "100%", background: brand.blue, borderRadius: "6px 6px 0 0", position: "absolute", top: 0 }} />
              <PersonIcon color={brand.blue} size={34} />
            </div>
          </>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em", color: brand.ink }}>{title}</span>
        {active && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: brand.white,
              background: brand.blue,
              borderRadius: 999,
              padding: "3px 9px",
            }}
          >
            Active
          </span>
        )}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: brand.blue700, marginTop: 3 }}>{subtitle}</div>
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: brand.ink600, marginTop: 6 }}>{body}</div>
    </button>
  );
}

// Editorial step header — the page reads as three decisions (style → upsell →
// look & feel), with everything else tucked under Fine-tuning. An uppercase
// "STEP n" eyebrow over a Playfair section title; the serif italic number is
// the only ornament.
function StepLabel({ n, title, hint }: { n: number; title: string; hint?: string }) {
  return (
    <Box paddingBlockStart="300">
      <BlockStack gap="100">
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.09em",
            textTransform: "uppercase",
            color: brand.ink500,
          }}
        >
          Step <span style={{ color: brand.blue }}>{n}</span>
          {" of 3"}
        </span>
        <span
          style={{
            fontFamily: fonts.serif,
            fontWeight: 500,
            fontSize: 24,
            lineHeight: 1.2,
            letterSpacing: "-0.01em",
            color: brand.ink,
          }}
        >
          {title}
        </span>
        {hint ? <Text as="p" variant="bodySm" tone="subdued">{hint}</Text> : null}
      </BlockStack>
    </Box>
  );
}

type IconSource = FunctionComponent<SVGProps<SVGSVGElement>>;

// A real on/off switch — features that turn something on for shoppers get
// this, not a checkbox that reads like a form field.
function ToggleSwitch({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        position: "relative",
        width: 52,
        height: 30,
        borderRadius: 999,
        border: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        background: checked ? brand.success : brand.ink200,
        transition: "background 160ms ease",
        flexShrink: 0,
        padding: 0,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: checked ? 25 : 3,
          width: 24,
          height: 24,
          borderRadius: "50%",
          background: brand.white,
          boxShadow: "0 1px 4px rgba(11,18,32,0.25)",
          transition: "left 160ms ease",
        }}
      />
    </button>
  );
}

// ─── Branded fine-tuning card ───────────────────────────────────────────────
// One header language for every setting card: an icon chip that says WHAT this
// is, the title, an optional On/Off pill + real switch when the card toggles a
// feature, and a hover "Why this matters" for the reasoning. Replaces the plain
// SectionHeading + Checkbox pattern so fine-tuning reads as on-brand as the rest.
function TuneCard({
  icon,
  title,
  description,
  why,
  toggle,
  children,
}: {
  icon: IconSource;
  title: string;
  description?: string;
  why?: string;
  toggle?: { checked: boolean; onChange: (v: boolean) => void };
  children?: ReactNode;
}) {
  const on = toggle?.checked ?? true;
  return (
    <Card padding="500">
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" wrap={false} gap="300">
          <InlineStack gap="300" blockAlign="center" wrap={false}>
            <IconChip source={icon} tone={toggle ? (on ? "good" : "neutral") : "money"} size={38} />
            <BlockStack gap="050">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h3" variant="headingMd">{title}</Text>
                {toggle && <StatusPill label={on ? "On" : "Off"} tone={on ? "good" : "neutral"} />}
                {why && (
                  <Tooltip content={why} width="wide">
                    <button
                      type="button"
                      aria-label="Why this matters"
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 8,
                        border: `1.2px solid ${brand.ink500}`,
                        background: "transparent",
                        color: brand.ink500,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 9.5,
                        fontWeight: 700,
                        fontStyle: "italic",
                        cursor: "help",
                        lineHeight: 1,
                        padding: 0,
                      }}
                    >
                      i
                    </button>
                  </Tooltip>
                )}
              </InlineStack>
              {description && <Text as="p" variant="bodySm" tone="subdued">{description}</Text>}
            </BlockStack>
          </InlineStack>
          {toggle && (
            <ToggleSwitch checked={on} onChange={toggle.onChange} ariaLabel={title} />
          )}
        </InlineStack>
        {children}
      </BlockStack>
    </Card>
  );
}

// A labeled on/off row for secondary switches inside a TuneCard (e.g. the two
// floating-widget surfaces). Bordered so it reads as its own control.
function SwitchRow({
  label,
  sublabel,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  sublabel?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div
      style={{
        border: `1px solid ${brand.ink100}`,
        borderRadius: 12,
        padding: "10px 14px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: brand.ink }}>{label}</div>
        {sublabel && <div style={{ fontSize: 11.5, color: brand.ink500, marginTop: 1 }}>{sublabel}</div>}
      </div>
      <ToggleSwitch checked={checked} onChange={onChange} ariaLabel={label} disabled={disabled} />
    </div>
  );
}

// Numbered icon step for "how it works" rows — replaces paragraph explainers.
function MiniStep({ n, icon, title, body }: { n: number; icon: IconSource; title: string; body: string }) {
  return (
    <div
      style={{
        border: `1px solid ${brand.ink100}`,
        borderRadius: 12,
        padding: "12px 14px",
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
      }}
    >
      <IconChip source={icon} tone="money" size={30} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: brand.ink }}>
          <span style={{ color: brand.blue700, marginRight: 5 }}>{n}.</span>
          {title}
        </div>
        <div style={{ fontSize: 11.5, color: brand.ink500, marginTop: 2, lineHeight: 1.45 }}>{body}</div>
      </div>
    </div>
  );
}

// ─── CTL intro-style option card ────────────────────────────────────────────
// One selectable card per intro. The visual is a miniature of how the offer
// arrives over the hero — merchants pick by look, not by reading.
function IntroStyleMini({ value }: { value: CtlIntroStyle }) {
  const hero: CSSProperties = {
    position: "relative",
    height: 96,
    borderRadius: 9,
    overflow: "hidden",
    background: "radial-gradient(120% 100% at 35% 12%, #F7F4ED 0%, #EBE6DB 62%, #DFD8C9 100%)",
  };
  // A recognizable shopper: head + navy tee + legs, soft contact shadow.
  // Same visual language as the storefront preview's mirror demo, so the
  // option cards and the live preview clearly describe the same thing.
  const figure = (
    <div style={{ position: "absolute", left: "32%", top: 8, width: 34, textAlign: "center" }}>
      <div style={{ width: 13, height: 13, borderRadius: "50%", background: "#C99B77", margin: "0 auto" }} />
      <div style={{ width: 30, height: 30, borderRadius: "8px 8px 6px 6px", background: "#2B3A5C", margin: "2px auto 0" }} />
      <div style={{ display: "flex", justifyContent: "center", gap: 4, marginTop: 1 }}>
        <div style={{ width: 8, height: 26, borderRadius: 4, background: "#C99B77" }} />
        <div style={{ width: 8, height: 26, borderRadius: 4, background: "#C29372" }} />
      </div>
      <div style={{ width: 30, height: 4, borderRadius: 999, background: "rgba(0,0,0,0.10)", margin: "2px auto 0" }} />
    </div>
  );
  // Tiny jogger silhouette — the suggested piece, used in every overlay.
  const jogger = (w: number, h: number) => (
    <svg width={w} height={h} viewBox="0 0 20 26" aria-hidden>
      <path d="M3 1h14v4l-1.4 19a1.4 1.4 0 0 1-1.4 1.3h-2.8L10 14l-1.4 11.3H5.8a1.4 1.4 0 0 1-1.4-1.3L3 5z" fill="#23252B" />
      <rect x="3" y="1" width="14" height="3.4" rx="1.4" fill="#3A3D45" />
    </svg>
  );
  const spark = (
    <svg width="6" height="6" viewBox="0 0 24 24" fill="none" stroke={brand.ink500} strokeWidth="2.6" strokeLinecap="round" aria-hidden>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
    </svg>
  );
  let overlay: ReactNode = null;
  if (value === "classic") {
    // Full-width bottom sheet: thumb, name+price lines, pill button.
    overlay = (
      <div
        style={{
          position: "absolute", left: "5%", right: "5%", bottom: 0,
          background: "rgba(255,255,255,0.97)", borderRadius: "7px 7px 0 0",
          boxShadow: "0 -2px 8px rgba(0,0,0,0.10)", padding: "5px 6px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 3 }}>
          {spark}
          <div style={{ height: 3.5, width: "44%", borderRadius: 2, background: brand.ink200 }} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 13, height: 17, borderRadius: 3, background: "#F1EFE9", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            {jogger(9, 12)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ height: 3.5, width: "72%", borderRadius: 2, background: brand.ink200 }} />
            <div style={{ height: 3, width: "34%", borderRadius: 2, background: brand.ink100, marginTop: 2.5 }} />
          </div>
          <div style={{ width: 28, height: 10, borderRadius: 999, background: brand.ink, flexShrink: 0 }} />
        </div>
      </div>
    );
  } else if (value === "pairing") {
    // One floating corner object: etched label, the piece, dark bottom bar.
    overlay = (
      <div
        style={{
          position: "absolute", right: 6, bottom: 6, width: 40,
          borderRadius: 8, background: "rgba(246,243,236,0.98)",
          boxShadow: "0 5px 14px rgba(0,0,0,0.24)", overflow: "hidden",
          border: "1px solid rgba(0,0,0,0.05)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 2, padding: "3px 3px 2px" }}>
          {spark}
          <div style={{ height: 2.5, width: 18, borderRadius: 2, background: brand.ink200 }} />
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 26 }}>
          {jogger(17, 23)}
        </div>
        <div style={{ height: 10, background: brand.ink, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ height: 2.5, width: 22, borderRadius: 2, background: "rgba(255,255,255,0.85)" }} />
        </div>
      </div>
    );
  } else if (value === "whisper") {
    // Just the chip, photo untouched.
    overlay = (
      <div
        style={{
          position: "absolute", left: "50%", bottom: 7, transform: "translateX(-50%)",
          display: "inline-flex", alignItems: "center", gap: 3,
          background: "rgba(255,255,255,0.97)", borderRadius: 999,
          boxShadow: "0 3px 9px rgba(0,0,0,0.16)", padding: "4px 8px",
        }}
      >
        {spark}
        <div style={{ height: 3.5, width: 32, borderRadius: 2, background: brand.ink200 }} />
        <div style={{ width: 4.5, height: 4.5, borderRadius: 999, background: brand.blue }} />
      </div>
    );
  } else {
    // The product tile lands with a price tag; pill button under it.
    overlay = (
      <div style={{ position: "absolute", right: 7, bottom: 6, width: 32, textAlign: "center" }}>
        <div
          style={{
            position: "relative", width: 32, height: 40, borderRadius: 6,
            background: "rgba(246,243,236,0.98)", boxShadow: "0 5px 14px rgba(0,0,0,0.24)",
            display: "flex", alignItems: "center", justifyContent: "center",
            border: "1px solid rgba(0,0,0,0.05)",
          }}
        >
          {jogger(18, 25)}
          <div
            style={{
              position: "absolute", top: -5, left: -7, borderRadius: 999,
              background: brand.ink, color: brand.white, fontSize: 5.5, fontWeight: 700,
              padding: "2px 4px", transform: "rotate(-8deg)", lineHeight: 1,
            }}
          >
            $59
          </div>
        </div>
        <div style={{ height: 9, borderRadius: 999, background: brand.ink, marginTop: 4 }} />
      </div>
    );
  }
  return (
    <div style={hero}>
      {figure}
      {overlay}
    </div>
  );
}

function IntroStyleCard({
  value,
  title,
  blurb,
  selected,
  onSelect,
  onHover,
}: {
  value: CtlIntroStyle;
  title: string;
  blurb: string;
  selected: boolean;
  onSelect: (v: CtlIntroStyle) => void;
  onHover?: (v: CtlIntroStyle | null) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      onMouseEnter={() => onHover?.(value)}
      onMouseLeave={() => onHover?.(null)}
      onFocus={() => onHover?.(value)}
      onBlur={() => onHover?.(null)}
      aria-pressed={selected}
      style={{
        display: "block", width: "100%", textAlign: "left", cursor: "pointer",
        border: `1.5px solid ${selected ? brand.blue : brand.ink100}`,
        background: selected ? brand.blue50 : brand.white,
        borderRadius: 12, padding: 9, transition: "border-color .15s, background .15s",
      }}
    >
      <IntroStyleMini value={value} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginTop: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: brand.ink }}>{title}</span>
        <span
          aria-hidden
          style={{
            width: 16, height: 16, borderRadius: 999, flexShrink: 0,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            border: `1.5px solid ${selected ? brand.blue : brand.ink200}`,
            background: selected ? brand.blue : "transparent",
            color: brand.white, fontSize: 10, fontWeight: 700, lineHeight: 1,
          }}
        >
          {selected ? "✓" : ""}
        </span>
      </div>
      <div style={{ fontSize: 11, color: brand.ink500, marginTop: 3, lineHeight: 1.45 }}>{blurb}</div>
    </button>
  );
}

// ─── Try-On button animation + border ──────────────────────────────────────
// Live previews of the widget-injected treatments (elloApplyInlineBtnBorder).
// Keyframes need a real stylesheet, so BtnFxStyles mounts ONE <style> tag at
// the page root; any element (the animation card's demo button AND the
// storefront preview's Try-On button) can then wear the ebw-* classes.
const BTN_ANIM_OPTIONS: Array<{ value: BtnBorderStyle; title: string; blurb: string }> = [
  { value: "none", title: "None", blurb: "No motion — the button sits still, exactly as your theme renders it." },
  { value: "halo", title: "Halo pulse", blurb: "A soft ring in your brand color breathes every few seconds. The quietest." },
  { value: "gradient", title: "Gradient sweep", blurb: "A thin gradient border slowly rotates. Reads as an AI feature at a glance." },
  { value: "double", title: "Double frame", blurb: "Inner keyline plus an offset outer rule. Luxury-catalog, no motion." },
  { value: "shimmer", title: "Shimmer", blurb: "A light band sweeps the face every few seconds. The most eye-catching." },
];

function BtnFxStyles({ color }: { color: string }) {
  // Mirrors the widget CSS with the merchant's live brand color as the accent,
  // so every in-admin demo IS the real treatment.
  const css = `
.ebw-halo{box-shadow:0 0 0 1px rgba(0,0,0,.28);}
.ebw-halo::after{content:"";position:absolute;inset:-5px;border-radius:7px;border:1.5px solid ${color};opacity:0;animation:ebwHalo 2.6s ease infinite;pointer-events:none;}
@keyframes ebwHalo{0%{opacity:0;transform:scale(.96)}35%{opacity:.8}70%,100%{opacity:0;transform:scale(1.06)}}
@property --ebwA{syntax:"<angle>";initial-value:0deg;inherits:false}
.ebw-gradient::before{content:"";position:absolute;inset:-2px;border-radius:6px;padding:2px;background:conic-gradient(from var(--ebwA,0deg),#9a9a9a,#fff,${color},#9a9a9a);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude;animation:ebwSpin 3.5s linear infinite;pointer-events:none;}
@keyframes ebwSpin{to{--ebwA:360deg}}
.ebw-double{box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.85),0 0 0 1px rgba(0,0,0,.55);}
.ebw-double::after{content:"";position:absolute;inset:-5px;border:1px solid rgba(0,0,0,.45);border-radius:7px;pointer-events:none;}
.ebw-shimmer{overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.4);}
.ebw-shimmer::after{content:"";position:absolute;top:0;bottom:0;width:36%;left:-45%;background:linear-gradient(105deg,transparent,rgba(255,255,255,.34),transparent);animation:ebwSweep 3.2s ease infinite;pointer-events:none;}
@keyframes ebwSweep{0%{left:-45%}55%,100%{left:115%}}
@media (prefers-reduced-motion:reduce){[class*="ebw-"]::before,[class*="ebw-"]::after{animation:none;}}
`;
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

const ebwClass = (v: BtnBorderStyle) => (v === "none" ? "" : `ebw-${v}`);

// ─── Page ─────────────────────────────────────────────────────────────────
export default function WidgetDesign() {
  const initial = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [brandColor, setBrandColor] = useState<string>(initial.brandColor || DEFAULT_COLOR);
  const [inlineEnabled, setInlineEnabled] = useState<boolean>(initial.inlineEnabled);
  const [inlineText, setInlineText] = useState<string>(initial.inlineText || DEFAULTS.inlineText);
  const [inlineHideOos, setInlineHideOos] = useState<boolean>(initial.inlineHideOos);
  const [btnBorderStyle, setBtnBorderStyle] = useState<BtnBorderStyle>(asBtnBorderStyle(initial.btnBorderStyle));
  const [btnBorderColor, setBtnBorderColor] = useState<string | null>(initial.btnBorderColor ?? null);
  // Hovering an intro-style option previews THAT style in the storefront mock
  // (selection previews on the section hover via SpotZone k="ctl").
  const [introHover, setIntroHover] = useState<CtlIntroStyle | null>(null);
  const [floatPdp, setFloatPdp] = useState<boolean>(initial.floatPdp);
  const [floatNonPdp, setFloatNonPdp] = useState<boolean>(initial.floatNonPdp);
  // Fine-tuning drawer — collapsed by default so the page reads as 3 decisions.
  const [showFineTuning, setShowFineTuning] = useState(false);
  const [fittingRoomEnabled, setFittingRoomEnabled] = useState<boolean>(initial.fittingRoomEnabled);
  const [pdpImageSwapEnabled, setPdpImageSwapEnabled] = useState<boolean>(initial.pdpImageSwapEnabled);
  const [pdpImageSelector, setPdpImageSelector] = useState<string>(initial.pdpImageSelector);
  const [completeTheLookEnabled, setCompleteTheLookEnabled] = useState<boolean>(initial.completeTheLookEnabled);
  const [ctlIntroStyle, setCtlIntroStyle] = useState<CtlIntroStyle>(asCtlIntroStyle(initial.ctlIntroStyle));
  const [position, setPosition] = useState<"left" | "right">(initial.position);
  const [previewEnabled, setPreviewEnabled] = useState<boolean>(initial.previewEnabled);
  const [previewDelay, setPreviewDelay] = useState<string>(String(initial.previewDelay));
  const [widgetEnabled, setWidgetEnabled] = useState<boolean>(initial.widgetEnabled);
  const [previewTheme, setPreviewTheme] = useState<"light" | "dark">(initial.previewTheme);
  const [featured, setFeatured] = useState<CuratedItem | null>(initial.featured);
  const [quickPicks, setQuickPicks] = useState<CuratedItem[]>(initial.quickPicks);
  const [spot, setSpot] = useState<SpotKey | null>(null);

  const navigate = useNavigate();
  const saving = fetcher.state !== "idle";
  const saved = fetcher.data?.ok === true;
  const saveError = fetcher.data && fetcher.data.ok === false ? fetcher.data.error : null;

  const money = (n: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: initial.currencyCode || "USD",
    }).format(n);

  const dirty = useMemo(() => {
    return (
      normalizeHex(brandColor) !== normalizeHex(initial.brandColor) ||
      inlineEnabled !== initial.inlineEnabled ||
      inlineText !== initial.inlineText ||
      inlineHideOos !== initial.inlineHideOos ||
      btnBorderStyle !== asBtnBorderStyle(initial.btnBorderStyle) ||
      btnBorderColor !== (initial.btnBorderColor ?? null) ||
      floatPdp !== initial.floatPdp ||
      floatNonPdp !== initial.floatNonPdp ||
      fittingRoomEnabled !== initial.fittingRoomEnabled ||
      pdpImageSwapEnabled !== initial.pdpImageSwapEnabled ||
      pdpImageSelector.trim() !== initial.pdpImageSelector.trim() ||
      completeTheLookEnabled !== initial.completeTheLookEnabled ||
      ctlIntroStyle !== asCtlIntroStyle(initial.ctlIntroStyle) ||
      position !== initial.position ||
      previewEnabled !== initial.previewEnabled ||
      String(previewDelay) !== String(initial.previewDelay) ||
      widgetEnabled !== initial.widgetEnabled ||
      previewTheme !== initial.previewTheme ||
      (featured?.id ?? null) !== (initial.featured?.id ?? null) ||
      quickPicks.map((p) => p.id).join(",") !== initial.quickPicks.map((p) => p.id).join(",")
    );
  }, [
    brandColor, inlineEnabled, inlineText, inlineHideOos, btnBorderStyle, btnBorderColor, floatPdp,
    floatNonPdp, fittingRoomEnabled, pdpImageSwapEnabled, pdpImageSelector, completeTheLookEnabled,
    ctlIntroStyle,
    position,
    previewEnabled, previewDelay,
    widgetEnabled, previewTheme, featured, quickPicks, initial,
  ]);

  const handleSave = () => {
    const fd = new FormData();
    fd.set("brand_color", brandColor);
    fd.set("inline_enabled", String(inlineEnabled));
    fd.set("inline_text", inlineText);
    fd.set("inline_hide_oos", String(inlineHideOos));
    fd.set("btn_border_style", btnBorderStyle);
    fd.set("btn_border_color", btnBorderColor ?? "");
    fd.set("float_pdp", String(floatPdp));
    fd.set("float_non_pdp", String(floatNonPdp));
    fd.set("fitting_room_enabled", String(fittingRoomEnabled));
    fd.set("pdp_image_swap_enabled", String(pdpImageSwapEnabled));
    fd.set("pdp_image_selector", pdpImageSelector);
    fd.set("complete_the_look_enabled", String(completeTheLookEnabled));
    fd.set("ctl_intro_style", ctlIntroStyle);
    fd.set("position", position);
    fd.set("preview_enabled", String(previewEnabled));
    fd.set("preview_delay", previewDelay);
    fd.set("widget_enabled", String(widgetEnabled));
    fd.set("preview_theme", previewTheme);
    fd.set("featured_item_id", featured?.id ?? "");
    fd.set("quick_picks_ids", JSON.stringify(quickPicks.map((p) => p.id)));
    fetcher.submit(fd, { method: "POST" });
  };

  // Build a CuratedItem from a resource-picker result, keeping any image/price
  // we already resolved for items that were picked before.
  const toCurated = (
    r: { id: string; title?: string; images?: Array<{ originalSrc?: string; src?: string; url?: string }>; variants?: Array<{ price?: string | number }> },
    existing?: CuratedItem | null,
  ): CuratedItem => {
    const image =
      (r.images ?? [])
        .map((i) => i.url ?? i.originalSrc ?? i.src ?? null)
        .find((u): u is string => Boolean(u)) ?? existing?.image ?? null;
    const rawPrice = r.variants?.[0]?.price;
    const price = rawPrice != null && rawPrice !== "" ? Number(rawPrice) : existing?.price ?? null;
    return { id: r.id, title: r.title ?? existing?.title ?? r.id, image, price: Number.isFinite(price) ? price : null };
  };

  const pickFeatured = async () => {
    const picker = window.shopify?.resourcePicker;
    if (!picker) return;
    const sel = await picker({
      type: "product",
      multiple: false,
      selectionIds: featured ? [{ id: featured.id }] : [],
    });
    if (!sel || sel.length === 0) return;
    setFeatured(toCurated(sel[0], featured?.id === sel[0].id ? featured : null));
  };

  const pickQuickPicks = async () => {
    const picker = window.shopify?.resourcePicker;
    if (!picker) return;
    const sel = await picker({
      type: "product",
      multiple: MAX_QUICK_PICKS,
      selectionIds: quickPicks.map((p) => ({ id: p.id })),
    });
    if (!sel) return;
    setQuickPicks(
      sel.slice(0, MAX_QUICK_PICKS).map((r) => toCurated(r, quickPicks.find((p) => p.id === r.id) ?? null)),
    );
  };

  return (
    <Page fullWidth>
      <BlockStack gap="500">
        <PageHeader
          kicker="Shape the try-on experience"
          title="Widget Design"
          actions={
            <PillButton variant="primary" onClick={handleSave} disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save changes"}
            </PillButton>
          }
        />
        {saved && !dirty && (
          <Banner tone="success">Saved. Your storefront updates within about 30 seconds.</Banner>
        )}
        {saveError && <Banner tone="critical">{saveError}</Banner>}

        <InlineGrid columns={{ xs: "1fr", lg: "minmax(0, 1fr) 560px", xl: "minmax(0, 1fr) 620px" }} gap="500">
          {/* ── Settings ── */}
          <BlockStack gap="500">
            <SpotZone k="status" onSpot={setSpot}>
            {/* Master switch — a calm white card; the status is carried by the
                icon tone and the pill, not a full-card tint wash. */}
            <Card padding="0">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 16,
                  flexWrap: "wrap",
                  padding: "18px 20px",
                  borderLeft: `3px solid ${widgetEnabled ? brand.success : brand.warning}`,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
                  <span
                    style={{
                      width: 42,
                      height: 42,
                      borderRadius: 10,
                      background: widgetEnabled ? brand.successBg : brand.warningBg,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <StoreOnlineIcon
                      width={24}
                      height={24}
                      style={{ fill: widgetEnabled ? brand.success : brand.warning }}
                    />
                  </span>
                  <BlockStack gap="100">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        {widgetEnabled ? "Try-On is live on your storefront" : "Try-On is hidden"}
                      </Text>
                      <StatusPill
                        label={widgetEnabled ? "Live" : "Hidden"}
                        tone={widgetEnabled ? "good" : "watch"}
                      />
                    </InlineStack>
                    <Text as="p" variant="bodySm" tone="subdued">
                      The master switch. Turning it off pauses Try-On everywhere — during a theme
                      change or a busy launch — without losing any of your settings.
                    </Text>
                  </BlockStack>
                </div>
                <ToggleSwitch
                  checked={widgetEnabled}
                  onChange={setWidgetEnabled}
                  ariaLabel="Try-On master switch"
                />
              </div>
            </Card>
            </SpotZone>

            <StepLabel
              n={1}
              title="Choose your style"
              hint="The one decision that matters. Hover each option to watch it play out in the preview — picking one sets the right defaults, and every detail stays adjustable under Fine-tuning."
            />

            <Card padding="500">
              <BlockStack gap="300">
                <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                  <SpotZone k="styleMirror" onSpot={setSpot}>
                    <StyleTile
                      active={pdpImageSwapEnabled}
                      title="On the product page"
                      subtitle="No widget — the product photo IS the mirror"
                      body="Shoppers tap Try On and the result paints straight onto your product photo, next to your price and Add to cart. Clean, native, zero popups."
                      variant="mirror"
                      onClick={() => {
                        setPdpImageSwapEnabled(true);
                        setInlineEnabled(true);
                        setFloatPdp(false);
                        setFloatNonPdp(false);
                      }}
                    />
                  </SpotZone>
                  <SpotZone k="styleWidget" onSpot={setSpot}>
                    <StyleTile
                      active={!pdpImageSwapEnabled}
                      title="Inside the widget"
                      subtitle="The classic Ello experience"
                      body="Try On opens the Ello widget: shoppers browse your catalog, keep a wardrobe, and every result renders inside the panel. Your product page stays untouched."
                      variant="widget"
                      onClick={() => {
                        setPdpImageSwapEnabled(false);
                        setInlineEnabled(true);
                        setFloatPdp(true);
                        setFloatNonPdp(true);
                      }}
                    />
                  </SpotZone>
                </InlineGrid>
                <Text as="p" variant="bodySm" tone="subdued">
                  Nothing changes on your store until you hit Save.
                </Text>
              </BlockStack>
            </Card>

            <StepLabel
              n={2}
              title="The upsell"
              hint="Complete the Look turns one try-on into a two-item order — Ello's biggest lever on average order value."
            />

            <SpotZone k="ctl" onSpot={setSpot}>
            <Card padding="500">
              <BlockStack gap="400">
                {/* Identity + the real switch — turning this on is the decision,
                    so it looks like one, not like a form checkbox. */}
                <InlineStack align="space-between" blockAlign="center" wrap={false} gap="300">
                  <InlineStack gap="300" blockAlign="center" wrap={false}>
                    <IconChip
                      source={CartUpIcon}
                      tone={completeTheLookEnabled ? "good" : "neutral"}
                      size={38}
                    />
                    <BlockStack gap="050">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="h2" variant="headingMd">Complete the Look</Text>
                        <StatusPill
                          label={completeTheLookEnabled ? "On" : "Off"}
                          tone={completeTheLookEnabled ? "good" : "neutral"}
                        />
                      </InlineStack>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Offer the matching piece the moment a try-on lands.
                      </Text>
                    </BlockStack>
                  </InlineStack>
                  <ToggleSwitch
                    checked={completeTheLookEnabled}
                    onChange={setCompleteTheLookEnabled}
                    ariaLabel="Complete the Look"
                  />
                </InlineStack>

                {/* Value panel — the differentiator on light editorial ground:
                    blue-tint paper, serif headline with the one italic-blue
                    word, and the offer mocked up as a small receipt card. */}
                <div
                  style={{
                    borderRadius: 12,
                    padding: "18px 18px 16px",
                    background: brand.blue50,
                    border: `1px solid ${brand.blue100}`,
                    display: "flex",
                    gap: 18,
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ flex: "1 1 220px", minWidth: 200 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: brand.blue700, textTransform: "uppercase" }}>
                      Only on Ello · Average order value
                    </div>
                    <div style={{ fontSize: 24, fontWeight: 500, color: brand.ink, marginTop: 6, fontFamily: fonts.serif, letterSpacing: "-0.01em", lineHeight: 1.2 }}>
                      Sell the <span style={{ fontStyle: "italic", color: brand.blue }}>outfit</span>, not the item.
                    </div>
                    <div style={{ fontSize: 12, lineHeight: 1.55, color: brand.ink600, marginTop: 7 }}>
                      The offer lands at the exact moment shoppers are most convinced. No other
                      try-on does this.
                    </div>
                  </div>
                  <div style={{ flex: "0 0 auto", width: 172 }}>
                    <div
                      style={{
                        borderRadius: 11,
                        background: brand.white,
                        border: `1px solid ${brand.blue200}`,
                        padding: "9px 10px",
                      }}
                    >
                      <div style={{ fontSize: 9.5, fontWeight: 700, color: brand.ink }}>✨ Complete the look</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 6 }}>
                        <div style={{ width: 22, height: 28, borderRadius: 5, background: brand.ink100, flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 9, fontWeight: 600, color: brand.ink }}>Pants</div>
                          <div style={{ fontSize: 8.5, color: brand.ink500 }}>$59</div>
                        </div>
                        <span
                          style={{
                            fontSize: 8.5,
                            fontWeight: 700,
                            background: brand.blue,
                            color: brand.white,
                            borderRadius: 999,
                            padding: "4px 8px",
                            whiteSpace: "nowrap",
                          }}
                        >
                          + Try it on too
                        </span>
                      </div>
                    </div>
                    <div style={{ textAlign: "center", color: brand.blue400, fontSize: 11, lineHeight: 1, margin: "5px 0" }}>↓</div>
                    <div
                      style={{
                        borderRadius: 9,
                        background: brand.ink,
                        color: brand.white,
                        textAlign: "center",
                        fontSize: 9.5,
                        fontWeight: 700,
                        padding: "8px 6px",
                      }}
                    >
                      Add both to cart · $108
                    </div>
                  </div>
                </div>

                {/* How it works — three icon steps instead of a paragraph */}
                <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
                  <MiniStep
                    n={1}
                    icon={CameraGlyphIcon}
                    title="Shopper tries a piece"
                    body="And is admiring the result"
                  />
                  <MiniStep
                    n={2}
                    icon={PlusCircleIcon}
                    title="Ello offers the pair"
                    body="One tap styles the full outfit on them"
                  />
                  <MiniStep
                    n={3}
                    icon={CartUpIcon}
                    title="Both go in the cart"
                    body="Two items, one order"
                  />
                </InlineGrid>

                {/* Intro style — how the offer arrives is a brand decision, so
                    it's a visible picker, not a buried dropdown. Every intro
                    converges on the same two-piece "Add both" row. */}
                <BlockStack gap="200">
                  <BlockStack gap="050">
                    <Text as="h3" variant="headingSm">How the offer first appears</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Pick the entrance — hover any option to see it on the storefront preview.
                      Whichever you choose, one tap styles the outfit and lands on the same
                      two-piece &ldquo;Add both&rdquo; row.
                    </Text>
                  </BlockStack>
                  <InlineGrid columns={{ xs: 2, md: 4 }} gap="200">
                    <IntroStyleCard
                      value="pairing"
                      title="The Pairing"
                      blurb="One floating piece: a quiet label, the item, one ask. No price up front."
                      selected={ctlIntroStyle === "pairing"}
                      onSelect={setCtlIntroStyle}
                      onHover={setIntroHover}
                    />
                    <IntroStyleCard
                      value="whisper"
                      title="The Whisper"
                      blurb="Just a tiny chip. Tapping it unfolds the full offer — shopper opts in."
                      selected={ctlIntroStyle === "whisper"}
                      onSelect={setCtlIntroStyle}
                      onHover={setIntroHover}
                    />
                    <IntroStyleCard
                      value="drop"
                      title="The Drop"
                      blurb="The product lands with a price tag and a button. Playful, product-first."
                      selected={ctlIntroStyle === "drop"}
                      onSelect={setCtlIntroStyle}
                      onHover={setIntroHover}
                    />
                    <IntroStyleCard
                      value="classic"
                      title="Classic"
                      blurb="The original full-width card with name and price. Today's default."
                      selected={ctlIntroStyle === "classic"}
                      onSelect={setCtlIntroStyle}
                      onHover={setIntroHover}
                    />
                  </InlineGrid>
                </BlockStack>

                <Text as="p" variant="bodySm" tone="subdued">
                  Hover this card to watch the offer play out in the preview.
                  {completeTheLookEnabled
                    ? " Test it live: open a product with a pairing and run a try-on."
                    : ""}
                </Text>

                {/* Pairings — you stay in control, one line + one button */}
                <div
                  style={{
                    border: `1px solid ${brand.ink100}`,
                    borderRadius: 12,
                    padding: "12px 14px",
                    display: "flex",
                    gap: 12,
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <IconChip source={ConnectIcon} tone="money" size={34} />
                  <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: brand.ink }}>
                      You choose what pairs with what
                    </div>
                    <div style={{ fontSize: 12, color: brand.ink500, marginTop: 2, lineHeight: 1.45 }}>
                      Set Complementary products in Shopify&apos;s free Search &amp; Discovery app.
                      No pairing set → no offer shown. Nothing random.
                    </div>
                  </div>
                  <Button
                    url={`https://admin.shopify.com/store/${initial.shopHandle}/apps/search-and-discovery`}
                    external
                  >
                    Set up pairings
                  </Button>
                </div>

                {/* Testing lives on the Proof page — one home for every
                    experiment, so this page stays purely about design. */}
                {completeTheLookEnabled && (
                  <div
                    style={{
                      border: `1px solid ${brand.ink100}`,
                      borderRadius: 12,
                      padding: "12px 14px",
                      display: "flex",
                      gap: 12,
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <IconChip source={ChartCohortIcon} tone="neutral" size={34} />
                    <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: brand.ink }}>
                        Want proof it lifts order value?
                      </span>
                      <div style={{ fontSize: 12, color: brand.ink500, marginTop: 2, lineHeight: 1.45 }}>
                        Run the holdout test from the Proof page — a slice of shoppers never sees the offer,
                        half never do, and the order-value gap is the true lift.
                      </div>
                    </div>
                    <Button onClick={() => navigate("/app/proof")}>Open Proof</Button>
                  </div>
                )}
              </BlockStack>
            </Card>
            </SpotZone>

            {/* ── Live Try-On (realtime mirror) — early access ──────────────
                Status display only: the flag is support-set (SQL) and this
                page's action never writes it, so a routine design save can't
                clobber a rollout state. Real toggle arrives with GA. */}
            <Card padding="500">
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center" wrap={false} gap="300">
                  <InlineStack gap="300" blockAlign="center" wrap={false}>
                    <IconChip
                      source={CameraGlyphIcon}
                      tone={initial.liveTryonEnabled ? "good" : "neutral"}
                      size={38}
                    />
                    <BlockStack gap="050">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="h2" variant="headingMd">Live Try-On</Text>
                        <StatusPill
                          label={initial.liveTryonEnabled ? "Live" : "Early access"}
                          tone={initial.liveTryonEnabled ? "good" : "watch"}
                        />
                      </InlineStack>
                      <Text as="p" variant="bodySm" tone="subdued">
                        A realtime mirror on your product pages — shoppers see your pieces on
                        themselves, on camera, in motion.
                      </Text>
                    </BlockStack>
                  </InlineStack>
                </InlineStack>

                <div
                  style={{
                    borderRadius: 12,
                    padding: "18px 18px 16px",
                    background: brand.blue50,
                    border: `1px solid ${brand.blue100}`,
                    display: "flex",
                    gap: 18,
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ flex: "1 1 220px", minWidth: 200 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: brand.blue700, textTransform: "uppercase" }}>
                      First on Ello · Realtime AI
                    </div>
                    <div style={{ fontSize: 24, fontWeight: 500, color: brand.ink, marginTop: 6, fontFamily: fonts.serif, letterSpacing: "-0.01em", lineHeight: 1.2 }}>
                      The fitting room, on their <span style={{ fontStyle: "italic", color: brand.blue }}>camera</span>.
                    </div>
                    <div style={{ fontSize: 12, lineHeight: 1.55, color: brand.ink600, marginTop: 7 }}>
                      Shoppers tap once and watch your garment move with them, live. Photo
                      try-on stays exactly as it is — this is the moment on top.
                    </div>
                  </div>
                  <div style={{ flex: "0 0 auto", width: 172 }}>
                    <div
                      style={{
                        borderRadius: 11,
                        background: "#0b0d10",
                        border: "1px solid rgba(255,255,255,0.16)",
                        boxShadow: "0 4px 14px rgba(11,18,32,0.16)",
                        padding: "10px 10px 9px",
                        color: brand.white,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9.5, fontWeight: 700 }}>
                        <span style={{ width: 6, height: 6, borderRadius: 999, background: "#ef4444", display: "inline-block" }} />
                        Live mirror
                        <span style={{ marginLeft: "auto", fontSize: 9, fontWeight: 600, background: "rgba(255,255,255,0.14)", borderRadius: 999, padding: "2px 7px", fontVariantNumeric: "tabular-nums" }}>
                          43s
                        </span>
                      </div>
                      <div style={{ marginTop: 7, borderRadius: 8, background: "linear-gradient(180deg, #1c2230 0%, #12161e 100%)", height: 74, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>
                        🪞
                      </div>
                      <div style={{ marginTop: 7, textAlign: "center", borderRadius: 8, border: "1px solid rgba(255,255,255,0.2)", fontSize: 9.5, fontWeight: 700, padding: "6px 4px" }}>
                        ◉ Snap the look
                      </div>
                    </div>
                  </div>
                </div>

                <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
                  <MiniStep
                    n={1}
                    icon={CameraGlyphIcon}
                    title="Tap &ldquo;Try on live&rdquo;"
                    body="Camera opens into a full-screen mirror"
                  />
                  <MiniStep
                    n={2}
                    icon={PlusCircleIcon}
                    title="The piece appears on them"
                    body="Moving naturally, logo and fabric intact"
                  />
                  <MiniStep
                    n={3}
                    icon={CartUpIcon}
                    title="Snap, keep, buy"
                    body="Captures land in the wardrobe like any try-on"
                  />
                </InlineGrid>

                {!initial.liveTryonEnabled && (
                  <div
                    style={{
                      border: `1px solid ${brand.ink100}`,
                      borderRadius: 12,
                      padding: "12px 14px",
                      display: "flex",
                      gap: 12,
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <IconChip source={CameraGlyphIcon} tone="watch" size={34} />
                    <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: brand.ink }}>
                        Rolling out to select stores
                      </div>
                      <div style={{ fontSize: 12, color: brand.ink500, marginTop: 2, lineHeight: 1.45 }}>
                        Live sessions run on dedicated realtime AI, so we onboard stores in
                        waves. Want in early? Tell us and we&apos;ll set you up.
                      </div>
                    </div>
                    <Button url="https://ello.services/demo" external>
                      Request early access
                    </Button>
                  </div>
                )}
              </BlockStack>
            </Card>

            <StepLabel
              n={3}
              title="Look & feel"
              hint="Make Ello read as part of your store, not a third-party plugin."
            />

            <SpotZone k="brand" onSpot={setSpot}>
            <TuneCard
              icon={ColorIcon}
              title="Brand color"
              description="Used for the Try-On button and floating widget. Text contrast is handled automatically."
              why="A widget in your brand color reads as part of your store, not a third-party plugin. Shoppers trust it more — and click it more."
            >
              {/* Live swatch preview — shoppers see the exact button + bubble in
                  the chosen color, so the color stops being an abstract hex. */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  flexWrap: "wrap",
                  borderRadius: 12,
                  border: `1px solid ${brand.ink100}`,
                  background: brand.ink50,
                  padding: "16px 18px",
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    background: brandColor,
                    color: readableTextColor(brandColor),
                    fontSize: 14,
                    fontWeight: 700,
                    padding: "10px 18px",
                    borderRadius: 10,
                    boxShadow: "0 4px 12px rgba(11,18,32,0.14)",
                  }}
                >
                  <CameraIcon color={readableTextColor(brandColor)} size={17} />
                  {inlineText || "Try On"}
                </span>
                <span
                  style={{
                    width: 46,
                    height: 46,
                    borderRadius: "50%",
                    background: brandColor,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: "0 6px 16px rgba(11,18,32,0.18)",
                  }}
                >
                  <HangerIcon color={readableTextColor(brandColor)} size={24} />
                </span>
                <BlockStack gap="050">
                  <Text as="span" variant="bodySm" fontWeight="semibold">This is your look</Text>
                  <Text as="span" variant="bodySm" tone="subdued">Button and floating widget, live.</Text>
                </BlockStack>
              </div>

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
                    padding: "7px 12px",
                    borderRadius: 10,
                    border: `1px solid ${brand.ink200}`,
                    background: brand.white,
                  }}
                >
                  <span style={{ width: 18, height: 18, borderRadius: 5, background: brandColor, border: `1px solid ${brand.ink200}` }} />
                  <span style={{ fontSize: 13, color: brand.ink700 }}>Custom</span>
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

              {/* Solid button border — for themes whose buttons are outlined
                  (white button, black border). Widget-injected, any theme. */}
              <Box paddingBlockStart="300">
                <div style={{ border: `1px solid ${brand.ink100}`, borderRadius: 12, padding: "12px 14px" }}>
                  <InlineStack align="space-between" blockAlign="center" gap="300" wrap={false}>
                    <BlockStack gap="050">
                      <Text as="h3" variant="headingSm">Button border</Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        A solid outline around the Try-On button — match themes whose buttons
                        are outlined, like a white button with a black border.
                      </Text>
                    </BlockStack>
                    <ToggleSwitch
                      checked={btnBorderColor !== null}
                      onChange={(v) => setBtnBorderColor(v ? "#111111" : null)}
                      ariaLabel="Button border"
                    />
                  </InlineStack>
                  {btnBorderColor !== null && (
                    <Box paddingBlockStart="300">
                      <InlineStack gap="300" blockAlign="center" wrap>
                        {["#111111", "#FFFFFF", "#6B7280", "#2563EB"].map((preset) => (
                          <ColorSwatch
                            key={preset}
                            value={preset}
                            selected={btnBorderColor.toLowerCase() === preset.toLowerCase()}
                            onClick={() => setBtnBorderColor(preset)}
                          />
                        ))}
                        <label
                          htmlFor="border-color"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                            cursor: "pointer",
                            padding: "7px 12px",
                            borderRadius: 10,
                            border: `1px solid ${brand.ink200}`,
                            background: brand.white,
                          }}
                        >
                          <span style={{ width: 18, height: 18, borderRadius: 5, background: btnBorderColor, border: `1px solid ${brand.ink200}` }} />
                          <span style={{ fontSize: 13, color: brand.ink700 }}>Custom</span>
                          <input
                            id="border-color"
                            type="color"
                            value={normalizeHex(btnBorderColor)}
                            onChange={(e) => setBtnBorderColor(e.target.value)}
                            style={{ width: 0, height: 0, opacity: 0, position: "absolute" }}
                          />
                        </label>
                        <Text as="span" variant="bodySm" tone="subdued">{btnBorderColor.toUpperCase()}</Text>
                      </InlineStack>
                    </Box>
                  )}
                </div>
              </Box>
            </TuneCard>
            </SpotZone>

            {/* ── Button animation: motion treatments on the Try-On button,
                picked from a dropdown; the storefront preview wears the pick
                live. Widget-injected CSS — works on any theme. ── */}
            <BtnFxStyles color={brandColor} />
            <SpotZone k="inline" onSpot={setSpot}>
            <TuneCard
              icon={ButtonIcon}
              title="Button animation"
              description="A touch of motion on the Try-On button that pulls the eye without changing your theme."
              why="Shoppers can't click what they don't notice. A slow, quiet animation lifts the button out of the page without feeling like an ad — and it renders in your brand color."
            >
              <InlineStack gap="400" blockAlign="center" wrap>
                <div style={{ flex: "0 0 230px", minWidth: 200 }}>
                  <Select
                    label="Animation"
                    labelHidden
                    options={BTN_ANIM_OPTIONS.map((o) => ({ label: o.title, value: o.value }))}
                    value={btnBorderStyle}
                    onChange={(v) => setBtnBorderStyle(asBtnBorderStyle(v))}
                  />
                </div>
                <div
                  style={{
                    flex: "0 0 auto",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 10,
                    background: brand.ink50,
                    border: `1px solid ${brand.ink100}`,
                    padding: "18px 26px",
                  }}
                >
                  <span
                    className={ebwClass(btnBorderStyle)}
                    style={{
                      position: "relative",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      background: brandColor,
                      color: readableTextColor(brandColor),
                      fontSize: 12,
                      fontWeight: 700,
                      letterSpacing: "0.02em",
                      padding: "10px 18px",
                      borderRadius: 4,
                      whiteSpace: "nowrap",
                      border: btnBorderColor ? `2px solid ${btnBorderColor}` : "none",
                    }}
                  >
                    {inlineText || "Try On"}
                  </span>
                </div>
                <div style={{ flex: "1 1 220px", minWidth: 180 }}>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {BTN_ANIM_OPTIONS.find((o) => o.value === btnBorderStyle)?.blurb}
                  </Text>
                </div>
              </InlineStack>
            </TuneCard>
            </SpotZone>

            {/* ── Fine-tuning drawer: everything a first-time merchant doesn't
                need. Collapsed by default so the page reads as 3 decisions. ── */}
            <Box paddingBlockStart="300">
              <Card padding="0">
                <button
                  type="button"
                  onClick={() => setShowFineTuning((v) => !v)}
                  aria-expanded={showFineTuning}
                  style={{
                    display: "block",
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    textAlign: "left",
                    padding: "16px 20px",
                    fontFamily: "inherit",
                  }}
                >
                  <InlineStack align="space-between" blockAlign="center" wrap={false}>
                    <InlineStack gap="300" blockAlign="center" wrap={false}>
                      <IconChip source={SettingsIcon} tone="neutral" size={34} />
                      <BlockStack gap="050">
                        <Text as="h3" variant="headingMd">Fine-tuning</Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          Button text, floating widget, popups, and what shows inside the widget.
                          Optional — your style choice already set good defaults.
                        </Text>
                      </BlockStack>
                    </InlineStack>
                    <span
                      aria-hidden
                      style={{
                        display: "inline-flex",
                        flexShrink: 0,
                        transition: "transform 160ms ease",
                        transform: showFineTuning ? "rotate(180deg)" : "none",
                      }}
                    >
                      <ChevronDownIcon width={20} height={20} style={{ fill: brand.ink500 }} />
                    </span>
                  </InlineStack>
                </button>
              </Card>
            </Box>

            {showFineTuning && (<>

            <SpotZone k="inline" onSpot={setSpot}>
            <TuneCard
              icon={ButtonIcon}
              title="Inline Try-On button"
              description="Shown directly on product pages, beside Add to cart."
              why="It sits exactly where shoppers already take action — right beside Add to cart. Trying on becomes a natural step toward buying, not a detour."
              toggle={{ checked: inlineEnabled, onChange: setInlineEnabled }}
            >
              {inlineEnabled && (
                <>
                  <TextField
                    label="Button text"
                    value={inlineText}
                    onChange={setInlineText}
                    autoComplete="off"
                    maxLength={MAX_INLINE_TEXT}
                    helpText={`Up to ${MAX_INLINE_TEXT} characters.`}
                  />
                  <Checkbox
                    label="Hide on out-of-stock products"
                    checked={inlineHideOos}
                    onChange={setInlineHideOos}
                  />
                </>
              )}
            </TuneCard>
            </SpotZone>

            <SpotZone k="float" onSpot={setSpot}>
            <TuneCard
              icon={ChatIcon}
              title="Floating widget"
              description="The round Try-On bubble that floats in a bottom corner."
              why="This is the shopper's Try-On hub — their wardrobe, their past try-ons, and new looks, one tap away from any page of your store."
            >
              <SwitchRow
                label="Show on product pages"
                checked={floatPdp}
                onChange={setFloatPdp}
              />
              <SwitchRow
                label="Show on other pages"
                sublabel="Home, collections, and the rest of your store"
                checked={floatNonPdp}
                onChange={setFloatNonPdp}
              />
              <BlockStack gap="150">
                <Text as="span" variant="bodyMd">Position</Text>
                <ButtonGroup variant="segmented">
                  <Button pressed={position === "left"} onClick={() => setPosition("left")}>Bottom left</Button>
                  <Button pressed={position === "right"} onClick={() => setPosition("right")}>Bottom right</Button>
                </ButtonGroup>
              </BlockStack>
            </TuneCard>
            </SpotZone>

            <TuneCard
              icon={CollectionIcon}
              title="Fitting Room hub"
              description="A launcher-less entry — like a “Fitting room” link in your header — that opens the shopper's saved wardrobe and full collection."
              why="Lets shoppers reopen their try-ons to decide what to buy, with no floating bubble."
              toggle={{ checked: fittingRoomEnabled, onChange: setFittingRoomEnabled }}
            >
              <Box background="bg-surface-secondary" borderRadius="200" padding="300">
                <Text as="p" variant="bodySm" tone="subdued">
                  Add the “Ello Fitting Room” block to your header (or a menu link pointing to
                  #ello-fitting-room), then turn it on here.
                </Text>
              </Box>
            </TuneCard>

            {/* Advanced escape hatch for the on-the-product-page style: only
                relevant when the mirror is the chosen style, and only needed
                on the rare theme whose gallery defeats automatic detection —
                so it hides unless the mirror is on. */}
            {pdpImageSwapEnabled && (
              <TuneCard
                icon={ProductIcon}
                title="Product photo targeting"
                description="Ello finds your product photo automatically. If a heavily customized theme trips it up, point Ello at the right image with a CSS selector."
                why="A support-level override: paste a selector once instead of waiting on a widget update. Leave blank on almost every store."
              >
                <TextField
                  label="Product image CSS selector"
                  value={pdpImageSelector}
                  onChange={setPdpImageSelector}
                  autoComplete="off"
                  maxLength={300}
                  placeholder=".product__media img"
                  helpText="Optional. Ello verifies the match — if the selector is invalid or points at a hidden image, automatic detection takes over, so this can't break your page."
                  monospaced
                />
              </TuneCard>
            )}

            <SpotZone k="popup" onSpot={setSpot}>
            <TuneCard
              icon={DesktopIcon}
              title="Preview popup"
              description="An optional nudge inviting desktop shoppers to try the item on. Hover this card to see it in the preview."
              why="A desktop-only invitation to generate a look — and it's polite about it. If a shopper closes it once, it never pops up for them again."
              toggle={{ checked: previewEnabled, onChange: setPreviewEnabled }}
            >
              {previewEnabled && (
                <>
                  <Box maxWidth="240px">
                    <TextField
                      label="Delay before showing (seconds)"
                      type="number"
                      value={previewDelay}
                      onChange={setPreviewDelay}
                      autoComplete="off"
                      min={0}
                      max={60}
                    />
                  </Box>
                  <BlockStack gap="150">
                    <Text as="span" variant="bodyMd">Theme</Text>
                    <ButtonGroup variant="segmented">
                      <Button pressed={previewTheme === "light"} onClick={() => setPreviewTheme("light")}>
                        Light
                      </Button>
                      <Button pressed={previewTheme === "dark"} onClick={() => setPreviewTheme("dark")}>
                        Dark
                      </Button>
                    </ButtonGroup>
                  </BlockStack>
                </>
              )}
            </TuneCard>
            </SpotZone>


            <TuneCard
              icon={ProductIcon}
              title="Inside the widget"
              description="Exactly what shoppers see when the widget opens. Pick a featured item and quick picks, or leave them empty and Ello curates automatically."
              why="First impressions: the featured item and quick picks are the first thing shoppers see when the widget opens. A strong feature and fresh picks set the tone for what to try on."
            >
              <InlineStack gap="200" wrap>
                <Button onClick={pickFeatured}>{featured ? "⭐ Change featured" : "⭐ Pick featured"}</Button>
                <Button onClick={pickQuickPicks}>
                  {quickPicks.length > 0 ? "🔥 Edit quick picks" : "🔥 Pick quick picks"}
                </Button>
              </InlineStack>
              <WidgetOpenPreview
                featured={featured}
                quickPicks={quickPicks}
                money={money}
                onRemoveFeatured={() => setFeatured(null)}
                onRemoveQuickPick={(id) => setQuickPicks((prev) => prev.filter((x) => x.id !== id))}
              />
              <Text as="p" variant="bodySm" tone="subdued">
                Up to {MAX_QUICK_PICKS} quick picks. Remove an item with the × on its card.
              </Text>
            </TuneCard>
            </>)}

            {/* Breathing room so the last card never hugs the bottom edge. */}
            <Box paddingBlockEnd="800" />
          </BlockStack>

          {/* ── Sticky live preview ── */}
          <div style={{ position: "sticky", top: 16, alignSelf: "start" }}>
            <Card padding="500">
              <BlockStack gap="400">
                <SectionHeading
                  eyebrow="Live preview"
                  title="On your storefront"
                  description="Hover any setting on the left to spotlight exactly what it changes here. Hover the floating widget to see how it greets shoppers."
                />
                <StorefrontPreview
                  color={brandColor}
                  inlineEnabled={inlineEnabled}
                  inlineText={inlineText}
                  floatPdp={floatPdp}
                  position={position}
                  widgetEnabled={widgetEnabled}
                  previewEnabled={previewEnabled}
                  previewTheme={previewTheme}
                  previewDelay={previewDelay}
                  pdpImageSwapEnabled={pdpImageSwapEnabled}
                  completeTheLookEnabled={completeTheLookEnabled}
                  ctlIntroStyle={introHover ?? ctlIntroStyle}
                  btnBorderStyle={btnBorderStyle}
                  btnBorderColor={btnBorderColor}
                  spot={introHover ? "ctl" : spot}
                />
                <Divider />
                <Text as="p" variant="bodySm" tone="subdued">
                  Every change here updates the preview instantly. Your live storefront updates within ~30 seconds of saving.
                </Text>
              </BlockStack>
            </Card>
          </div>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
