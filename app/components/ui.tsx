import type { FunctionComponent, ReactNode, SVGProps } from "react";
import { Card, BlockStack, Text, Tooltip } from "@shopify/polaris";

// ─── Ello brand tokens (mirror of _context/Brand-Palette.md) ────────────────
// Crisp blue + near-black + lots of white. Light-mode-first, editorial.
export const brand = {
  blue: "#3B63D4",
  blue700: "#2544A3",
  blue500: "#4E77E4",
  blue400: "#7A99F0",
  blue300: "#A9BEF7",
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
  // Data-viz series accent (approved 2026-08-02, mirrored in Brand-Palette.md):
  // a fashion-forward orchid for chart series that must read apart from both
  // the revenue blue and the success green. Not a status color.
  orchid: "#C95BB8",
};

// ─── Editorial Ledger type system (direction approved 2026-08-10) ───────────
// Serif is a garnish, not a workhorse: Playfair Display appears ONLY at display
// sizes — page titles and hero KPI numerals (>= 24px). Inter owns everything
// data-bearing. The mono stack is the receipt layer: tiny uppercase metadata
// footnotes under hero numbers ("90D · VERIFIED WINDOW"), never body copy.
export const fonts = {
  serif: "'Playfair Display', Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace",
};

// Receipt rules: solid hairline for card structure, dashed for line-item
// separators inside a surface, and a solid ink rule above "totals". One motif
// per surface — a card gets dashed dividers OR a mono footnote, never the
// full receipt costume at once.
export const ledger = {
  hairline: `1px solid ${brand.ink100}`,
  dashed: `1px dashed ${brand.ink200}`,
  totalRule: `1px solid ${brand.ink}`,
  radius: 10,
};

// Tabular lining figures wherever digits align or update in place.
export const tnum = { fontVariantNumeric: "tabular-nums lining-nums" } as const;

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

// Receipt metadata line: letterspaced mono, the "printed at the bottom of the
// till slip" register. Reserved for factual footnotes under hero numbers
// ("90d · orders after a try-on"), timestamps, and record ids. 12px clears
// Shopify's caption floor for App Store review; wraps rather than clipping so
// longer hints survive narrow cards.
export function MonoMeta({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: fonts.mono,
        fontSize: 12,
        lineHeight: 1.4,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: brand.ink500,
      }}
    >
      {children}
    </span>
  );
}

// ─── Editorial page header ──────────────────────────────────────────────────
// Replaces the Polaris <Page title> heading on the four core admin pages: a
// quiet uppercase kicker, a Playfair Display title (the serif's one sanctioned
// home besides hero numbers), and an actions slot that keeps each page's
// controls on the title line. `accent` italicizes one word in brand blue —
// the signature heading move, used at most once per page.
export function PageHeader({
  kicker,
  title,
  accent,
  actions,
}: {
  kicker?: string;
  title: string;
  accent?: string;
  actions?: ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
      <div style={{ minWidth: 0 }}>
        {kicker && <div style={{ marginBottom: 3 }}><Eyebrow>{kicker}</Eyebrow></div>}
        <h1
          style={{
            fontFamily: fonts.serif,
            fontWeight: 500,
            fontSize: 27,
            lineHeight: 1.15,
            letterSpacing: "-0.01em",
            color: brand.ink,
            margin: 0,
          }}
        >
          {title}
          {accent && (
            <>
              {" "}
              <span style={{ fontStyle: "italic", color: brand.blue }}>{accent}</span>
            </>
          )}
        </h1>
      </div>
      {actions && <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>{actions}</div>}
    </div>
  );
}

// Pill button in the brand language for in-body page actions (the Shopify
// chrome's own buttons stay Polaris). `variant="primary"` = ink fill; default
// is a quiet hairline pill.
export function PillButton({
  children,
  onClick,
  variant = "plain",
  disabled,
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "plain";
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const primary = variant === "primary";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      style={{
        borderRadius: 999,
        padding: "6px 15px",
        fontSize: 12.5,
        fontWeight: 600,
        fontFamily: "inherit",
        lineHeight: 1.4,
        cursor: disabled ? "default" : "pointer",
        border: primary ? `1px solid ${brand.ink}` : `1px solid ${brand.ink200}`,
        background: primary ? brand.ink : brand.white,
        color: primary ? brand.white : brand.ink700,
        opacity: disabled ? 0.45 : 1,
        // Let hover fall through to a wrapping Polaris Tooltip when disabled,
        // matching Polaris button behavior (tooltips still show on disabled
        // actions).
        pointerEvents: disabled ? "none" : undefined,
        transition: "background 120ms ease, border-color 120ms ease",
      }}
    >
      {children}
    </button>
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

// KPI / stat card — Ledger anatomy: eyebrow label, Playfair hero numeral, mono
// footnote. The hero metric on a page can set `accent` to render its value in
// brand blue (one accented number per view).
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
        <Eyebrow>{label}</Eyebrow>
        <span
          style={{
            fontFamily: fonts.serif,
            fontSize: 32,
            fontWeight: 500,
            lineHeight: 1.12,
            letterSpacing: "-0.01em",
            color: accent ? brand.blue : brand.ink,
            ...tnum,
          }}
        >
          {value}
        </span>
        {hint && <MonoMeta>{hint}</MonoMeta>}
      </BlockStack>
    </Card>
  );
}
