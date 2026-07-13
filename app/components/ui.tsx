import type { FunctionComponent, ReactNode, SVGProps } from "react";
import { Card, BlockStack, Text, Tooltip } from "@shopify/polaris";

// ─── Ello brand tokens (mirror of _context/Brand-Palette.md) ────────────────
// Crisp blue + near-black + lots of white. Light-mode-first, editorial.
export const brand = {
  blue: "#3B63D4",
  blue700: "#2544A3",
  blue200: "#D2DDFB",
  blue100: "#E8EEFD",
  blue50: "#F4F7FE",
  ink: "#0B1220",
  ink700: "#2A3347",
  ink600: "#434D63",
  ink500: "#6B7388",
  ink200: "#D8DCE3",
  ink100: "#ECEEF3",
  ink50: "#F6F7F9",
  white: "#FFFFFF",
  offwhite: "#FAFBFC",
  success: "#17A673",
  warning: "#E2A93A",
  danger: "#D94E4E",
  // Semantic tint pairs (light fill + readable ink of the same family) for
  // status pills and icon chips. Money reuses blue100/blue700; neutral reuses
  // ink50/ink600.
  successBg: "#E7F6F0",
  successInk: "#0F6E56",
  warningBg: "#FBF3E1",
  warningInk: "#8A6410",
  dangerBg: "#FBEAEA",
  dangerInk: "#A32D2D",
};

// ─── Semantic tone system ───────────────────────────────────────────────────
// One vocabulary of meaning for the whole admin: color always says the SAME
// thing. money = revenue (blue), good/watch/bad = health (green/amber/red),
// neutral = a count that isn't inherently good or bad (ink). Lives here so both
// ui.tsx and analytics.tsx draw from a single source.
export type Tone = "money" | "good" | "watch" | "bad" | "neutral";

export const TONE_STYLES: Record<Tone, { fg: string; bg: string; icon: string }> = {
  money: { fg: brand.blue700, bg: brand.blue100, icon: brand.blue },
  good: { fg: brand.successInk, bg: brand.successBg, icon: brand.success },
  watch: { fg: brand.warningInk, bg: brand.warningBg, icon: brand.warning },
  bad: { fg: brand.dangerInk, bg: brand.dangerBg, icon: brand.danger },
  neutral: { fg: brand.ink600, bg: brand.ink50, icon: brand.ink600 },
};

export type IconSource = FunctionComponent<SVGProps<SVGSVGElement>>;

// Tinted square holding a Polaris icon, colored by tone. `fill` is an inherited
// SVG property and Polaris icons ship no hardcoded fill, so the brand hex on the
// icon element colors the paths.
export function IconChip({ source: Source, tone = "neutral", size = 30 }: { source: IconSource; tone?: Tone; size?: number }) {
  const s = TONE_STYLES[tone];
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        background: s.bg,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <Source width={Math.round(size * 0.58)} height={Math.round(size * 0.58)} style={{ fill: s.icon }} />
    </span>
  );
}

// One-word verdict pill. Pairs with a metric to turn a raw number into a judgment.
export function StatusPill({ label, tone }: { label: string; tone: Tone }) {
  const s = TONE_STYLES[tone];
  return (
    <span style={{ fontSize: 11, fontWeight: 600, color: s.fg, background: s.bg, padding: "2px 8px", borderRadius: 20, whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}

// Small uppercase editorial label that sits above a heading.
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.09em",
        textTransform: "uppercase",
        color: brand.ink500,
      }}
    >
      {children}
    </span>
  );
}

// Consistent section header used at the top of every card. `why` adds a
// hover-revealed "Why this matters" explainer for merchants who want the
// reasoning without cluttering the card for everyone else.
export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
  why,
  icon,
  iconTone = "money",
  status,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  why?: string;
  icon?: IconSource;
  iconTone?: Tone;
  status?: { label: string; tone: Tone } | null;
}) {
  const heading = (
    <BlockStack gap="100">
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text as="h2" variant="headingMd">{title}</Text>
        {status && <StatusPill label={status.label} tone={status.tone} />}
      </div>
      {description && <Text as="p" variant="bodySm" tone="subdued">{description}</Text>}
      {why && whyTag(why)}
    </BlockStack>
  );

  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
      {icon ? (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, minWidth: 0 }}>
          <div style={{ marginTop: 2 }}><IconChip source={icon} tone={iconTone} size={38} /></div>
          {heading}
        </div>
      ) : (
        heading
      )}
      {action && <div style={{ flexShrink: 0 }}>{action}</div>}
    </div>
  );
}

// Hover-revealed "Why this matters" explainer, shared by SectionHeading. A
// button (not a focusable span) so it's keyboard-accessible and the tooltip
// shows on focus.
function whyTag(why: string) {
  return (
    <Tooltip content={why} width="wide">
            <button
              type="button"
              aria-label="Why this matters"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                marginTop: 2,
                width: "fit-content",
                fontSize: 12,
                fontWeight: 500,
                color: brand.ink500,
                cursor: "help",
                background: "transparent",
                border: "none",
                borderBottom: `1px dotted ${brand.ink200}`,
                padding: 0,
                paddingBottom: 1,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 7,
                  border: `1.2px solid ${brand.ink500}`,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 9,
                  fontWeight: 700,
                  fontStyle: "italic",
                  lineHeight: 1,
                }}
              >
                i
              </span>
              Why this matters
            </button>
    </Tooltip>
  );
}

// KPI / stat card — matches the Home dashboard style. The hero metric on a page
// can set `accent` to render its value in brand blue.
export function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <Card padding="500">
      <BlockStack gap="150">
        <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
        <span style={{ fontSize: 30, fontWeight: 600, lineHeight: 1.1, color: accent ? brand.blue : brand.ink }}>
          {value}
        </span>
        {hint && <Text as="span" variant="bodySm" tone="subdued">{hint}</Text>}
      </BlockStack>
    </Card>
  );
}
