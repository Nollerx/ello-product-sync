import { useEffect, useRef } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

// Built for Shopify admin-performance targets (p75). LCP/INP/FCP/TTFB are in
// milliseconds; CLS is unitless. These are the same thresholds Shopify scores
// against once it has ≥100 calls per metric over 28 days.
const THRESHOLDS: Record<string, number> = {
  LCP: 2500,
  CLS: 0.1,
  INP: 200,
  FCP: 1800,
  TTFB: 800,
};

type WebVitalsReport = {
  metrics: Array<{ id: string; name: string; value: number }>;
};

type WebVitalsApi = {
  onReport?: (cb: ((r: WebVitalsReport) => void) | null) => Promise<void> | void;
};

/**
 * Subscribes to App Bridge's Web Vitals stream — the SAME real-user samples
 * Shopify aggregates to score admin performance for Built for Shopify. For
 * every metric it:
 *   1. Logs to the console with a green/red pass/fail vs the official target,
 *      so you can eyeball LCP/CLS/INP live in the embedded app's DevTools.
 *   2. Best-effort beacons it to /api/web-vitals so real p75 can be computed
 *      across merchant traffic before Shopify's own 100-call threshold is hit.
 *
 * Renders nothing. Mounted once inside AppProvider in app.tsx, so it survives
 * client-side navigation and registers the callback exactly once.
 */
export function WebVitals({ shop }: { shop?: string }) {
  const shopify = useAppBridge();
  const registered = useRef(false);

  useEffect(() => {
    // webVitals only exists inside the embedded admin (not standalone/dev).
    const api = (shopify as unknown as { webVitals?: WebVitalsApi } | undefined)
      ?.webVitals;
    if (!api?.onReport || registered.current) return;
    registered.current = true;

    void api.onReport((report) => {
      const path =
        typeof window !== "undefined" ? window.location.pathname : "";

      for (const m of report.metrics) {
        const threshold = THRESHOLDS[m.name];
        const pass = threshold == null ? null : m.value <= threshold;
        const isCls = m.name === "CLS";
        const shown = isCls ? Math.round(m.value * 1000) / 1000 : Math.round(m.value);
        const unit = isCls ? "" : "ms";

        // eslint-disable-next-line no-console
        console.log(
          `%c[Web Vitals] ${m.name} ${shown}${unit}` +
            (pass == null ? "" : pass ? " ✓ pass" : " ✗ FAIL") +
            (threshold != null ? ` (target ≤ ${threshold}${unit})` : ""),
          `color:${pass == null ? "#6b7280" : pass ? "#17A673" : "#D94E4E"};font-weight:600`,
        );

        // Telemetry must never affect the page — swallow everything.
        try {
          const payload = JSON.stringify({
            name: m.name,
            value: m.value,
            id: m.id,
            path,
            shop,
          });
          if (typeof navigator !== "undefined" && navigator.sendBeacon) {
            navigator.sendBeacon(
              "/api/web-vitals",
              new Blob([payload], { type: "application/json" }),
            );
          } else {
            void fetch("/api/web-vitals", {
              method: "POST",
              body: payload,
              headers: { "Content-Type": "application/json" },
              keepalive: true,
            });
          }
        } catch {
          /* ignore — best effort */
        }
      }
    });
  }, [shopify, shop]);

  return null;
}
