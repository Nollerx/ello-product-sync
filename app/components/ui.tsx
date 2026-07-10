import type { ReactNode } from "react";
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
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  why?: string;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
      <BlockStack gap="100">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <Text as="h2" variant="headingMd">{title}</Text>
        {description && <Text as="p" variant="bodySm" tone="subdued">{description}</Text>}
        {why && (
          <Tooltip content={why} width="wide">
            <span
              tabIndex={0}
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
                borderBottom: `1px dotted ${brand.ink200}`,
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
            </span>
          </Tooltip>
        )}
      </BlockStack>
      {action && <div style={{ flexShrink: 0 }}>{action}</div>}
    </div>
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
