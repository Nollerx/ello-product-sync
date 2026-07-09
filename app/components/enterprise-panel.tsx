import { useEffect, useState } from "react";
import { Icon } from "@shopify/polaris";
import {
  MagicIcon,
  AdjustIcon,
  ChartVerticalFilledIcon,
  LayoutBlockIcon,
} from "@shopify/polaris-icons";

// Shared between the enterprise onboarding screen and the billing-page
// takeover — same offer pillars as the website's enterprise panel.

export const CALENDLY_BASE = "https://calendly.com/andrew-ello/ello-setup-call";

export const ENTERPRISE_PILLARS = [
  {
    icon: MagicIcon,
    title: "White-glove setup",
    description:
      "We install, configure, and match the widget to your theme. Zero dev work on your side.",
  },
  {
    icon: AdjustIcon,
    title: "Custom volume & pricing",
    description:
      "Try-on volume sized to your traffic, with pricing to match — not fixed tiers.",
  },
  {
    icon: ChartVerticalFilledIcon,
    title: "Attributed-revenue proof",
    description:
      "A/B holdout testing that measures the revenue lift try-on actually drives.",
  },
  {
    icon: LayoutBlockIcon,
    title: "Premium placements",
    description:
      "Complete the Look, PDP image swap, fitting-room hub, and custom branding.",
  },
];

export function EnterprisePillarsGrid() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: 12,
      }}
    >
      {ENTERPRISE_PILLARS.map((pillar) => (
        <div
          key={pillar.title}
          style={{
            border: "1px solid #D8DCE3",
            borderRadius: 12,
            background: "#FFFFFF",
            padding: 16,
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "#EEF3FE",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: 10,
            }}
          >
            <Icon source={pillar.icon} tone="info" />
          </div>
          <div style={{ fontSize: 14, fontWeight: 650, color: "#101828", marginBottom: 4 }}>
            {pillar.title}
          </div>
          <div style={{ fontSize: 12.5, color: "#667085", lineHeight: 1.5 }}>
            {pillar.description}
          </div>
        </div>
      ))}
    </div>
  );
}

// Inline Calendly booking embed. When the shopper completes a booking,
// Calendly posts `calendly.event_scheduled` to the parent window — we relay it
// to /api/notify/calendly (Telegram ping) and fire onBooked for the caller.
export function CalendlyEmbed({
  shop,
  source,
  height = 660,
  onBooked,
}: {
  shop: string;
  source: string;
  height?: number;
  onBooked?: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams({
      embed_type: "Inline",
      embed_domain: window.location.hostname,
      hide_event_type_details: "1",
      hide_gdpr_banner: "1",
      utm_source: source,
      utm_campaign: shop,
    });
    setSrc(`${CALENDLY_BASE}?${params.toString()}`);
  }, [shop, source]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (
        typeof e.origin === "string" &&
        e.origin.endsWith("calendly.com") &&
        e.data?.event === "calendly.event_scheduled"
      ) {
        fetch("/api/notify/calendly", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "app", shop }),
        }).catch(() => {});
        onBooked?.();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [shop, onBooked]);

  return (
    <div
      style={{
        border: "1px solid #D8DCE3",
        borderRadius: 12,
        overflow: "hidden",
        background: "#FFFFFF",
        boxShadow: "0 10px 30px rgba(11, 18, 32, 0.08)",
      }}
    >
      {src ? (
        <iframe
          src={src}
          title="Book your Ello setup call"
          style={{ width: "100%", height, border: "none", display: "block" }}
        />
      ) : (
        <div
          style={{
            height,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#667085",
            fontSize: 14,
          }}
        >
          Loading calendar…
        </div>
      )}
    </div>
  );
}
