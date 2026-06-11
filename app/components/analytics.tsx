// Shared analytics UI: time-range selector, deltas, charts, heatmap, funnel,
// insights, and the free-plan lock. Brand-styled to match components/ui.tsx.

import { useId, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { BlockStack, Box, Button, ButtonGroup, Card, InlineStack, Text } from "@shopify/polaris";
import { RANGE_OPTIONS, parseRange, type RangeKey } from "../lib/timerange";
import { brand } from "./ui";
import type { Insight } from "../lib/analytics-shared";

// ─── Time range selector (?range=7d|30d|90d, preserves other params) ───────
export function TimeRangeSelector() {
  const [searchParams, setSearchParams] = useSearchParams();
  const current = parseRange(searchParams.get("range"));

  const select = (key: RangeKey) => {
    const next = new URLSearchParams(searchParams);
    next.set("range", key);
    setSearchParams(next, { preventScrollReset: true });
  };

  return (
    <ButtonGroup variant="segmented">
      {RANGE_OPTIONS.map((opt) => (
        <Button key={opt.key} pressed={current === opt.key} onClick={() => select(opt.key)} size="slim">
          {opt.label}
        </Button>
      ))}
    </ButtonGroup>
  );
}

// ─── Delta vs previous period ───────────────────────────────────────────────
export function Delta({ value, invert }: { value: number | null; invert?: boolean }) {
  if (value == null) return null;
  const good = invert ? value <= 0 : value >= 0;
  const color = value === 0 ? brand.ink500 : good ? brand.success : brand.danger;
  const arrow = value > 0 ? "▲" : value < 0 ? "▼" : "—";
  return (
    <span style={{ fontSize: 12, fontWeight: 600, color }}>
      {arrow} {Math.abs(value)}%
      <span style={{ color: brand.ink500, fontWeight: 400 }}> vs prev.</span>
    </span>
  );
}

// ─── KPI tile with optional delta ───────────────────────────────────────────
export function KpiTile({
  label,
  value,
  hint,
  delta,
  invertDelta,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  delta?: number | null;
  invertDelta?: boolean;
  accent?: boolean;
}) {
  return (
    <Card padding="500">
      <BlockStack gap="150">
        <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
        <span style={{ fontSize: 28, fontWeight: 600, lineHeight: 1.1, color: accent ? brand.blue : brand.ink }}>
          {value}
        </span>
        <InlineStack gap="200" blockAlign="center">
          {delta !== undefined && <Delta value={delta} invert={invertDelta} />}
          {hint && <Text as="span" variant="bodySm" tone="subdued">{hint}</Text>}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

// ─── Daily trend line (smooth area chart with hover readout) ────────────────

// Catmull-Rom → cubic bezier, in the chart's 0–100 viewBox space. Control-point
// Ys are clamped so spikes never overshoot below the baseline or above the top.
function smoothPath(pts: Array<[number, number]>): string {
  const r = (v: number) => Math.round(v * 100) / 100;
  if (pts.length === 1) return `M 0 ${r(pts[0][1])} L 100 ${r(pts[0][1])}`;
  const clampY = (v: number) => Math.min(100, Math.max(4, v));
  let d = `M ${r(pts[0][0])} ${r(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = r(p1[0] + (p2[0] - p0[0]) / 6);
    const c1y = r(clampY(p1[1] + (p2[1] - p0[1]) / 6));
    const c2x = r(p2[0] - (p3[0] - p1[0]) / 6);
    const c2y = r(clampY(p2[1] - (p3[1] - p1[1]) / 6));
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${r(p2[0])} ${r(p2[1])}`;
  }
  return d;
}

// "2026-06-04" → "Jun 4"; anything unparseable falls back to the raw key.
function prettyDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function LineSeries({
  data,
  height = 150,
}: {
  data: Array<{ day: string; count: number }>;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const gradId = useId().replace(/:/g, "");

  const n = data.length;
  const max = Math.max(1, ...data.map((d) => d.count));
  const xFor = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 50);
  const yFor = (c: number) => 8 + (1 - c / max) * 86;

  if (n === 0) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: brand.ink500 }}>
        No data for this period yet.
      </div>
    );
  }

  const pts = data.map((d, i) => [xFor(i), yFor(d.count)] as [number, number]);
  const linePath = smoothPath(pts);
  const areaPath = `${linePath} L 100 100 L 0 100 Z`;

  const move = (e: ReactMouseEvent<HTMLDivElement>) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover(Math.round(frac * (n - 1)));
  };

  const hovered = hover != null ? data[hover] : null;
  const hx = hover != null ? xFor(hover) : 0;
  const hy = hovered ? yFor(hovered.count) : 0;
  const tipAlign = hx < 12 ? "0%" : hx > 88 ? "-100%" : "-50%";
  const tipBelow = hy < 32;

  return (
    <div
      ref={boxRef}
      onMouseMove={move}
      onMouseLeave={() => setHover(null)}
      style={{ position: "relative", height, marginTop: 8, cursor: "crosshair" }}
    >
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", overflow: "visible" }}
        aria-hidden
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={brand.blue} stopOpacity="0.18" />
            <stop offset="100%" stopColor={brand.blue} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill={`url(#${gradId})`} stroke="none" />
        <path
          d={linePath}
          fill="none"
          stroke={brand.blue}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <line x1="0" y1="100" x2="100" y2="100" stroke={brand.ink100} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      </svg>

      {hovered && (
        <>
          <div
            style={{ position: "absolute", top: 4, bottom: 0, left: `${hx}%`, width: 1, background: brand.ink200, pointerEvents: "none" }}
          />
          <div
            style={{
              position: "absolute",
              left: `${hx}%`,
              top: (hy / 100) * height,
              width: 9,
              height: 9,
              borderRadius: "50%",
              background: brand.white,
              border: `2px solid ${brand.blue}`,
              transform: "translate(-50%, -50%)",
              pointerEvents: "none",
              boxShadow: "0 1px 4px rgba(11,18,32,0.18)",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: `${hx}%`,
              top: (hy / 100) * height + (tipBelow ? 12 : -12),
              transform: `translate(${tipAlign}, ${tipBelow ? "0%" : "-100%"})`,
              background: brand.ink,
              color: brand.white,
              borderRadius: 8,
              padding: "5px 9px",
              fontSize: 11,
              lineHeight: 1.35,
              whiteSpace: "nowrap",
              pointerEvents: "none",
              boxShadow: "0 4px 14px rgba(11,18,32,0.22)",
              zIndex: 3,
            }}
          >
            <span style={{ fontWeight: 700, fontSize: 12 }}>{hovered.count.toLocaleString()}</span>
            <span style={{ opacity: 0.75 }}> · {prettyDay(hovered.day)}</span>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Horizontal funnel bar ──────────────────────────────────────────────────
export function FunnelBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <BlockStack gap="100">
      <InlineStack align="space-between">
        <Text as="span" variant="bodySm">{label}</Text>
        <Text as="span" variant="bodySm" tone="subdued">
          {value.toLocaleString()}{max > 0 ? ` · ${pct}%` : ""}
        </Text>
      </InlineStack>
      <div style={{ height: 8, background: brand.ink100, borderRadius: 6, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: brand.blue, borderRadius: 6, transition: "width 300ms ease" }} />
      </div>
    </BlockStack>
  );
}

// ─── Day × hour heatmap (rows: Sun–Sat, cols: 0–23) ─────────────────────────
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function Heatmap({ grid }: { grid: number[][] }) {
  const max = Math.max(1, ...grid.flat());
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {grid.map((row, day) => (
        <div key={day} style={{ display: "flex", alignItems: "center", gap: 3 }}>
          <span style={{ width: 30, fontSize: 10, color: brand.ink500, flexShrink: 0 }}>{DAY_LABELS[day]}</span>
          {row.map((count, hour) => (
            <div
              key={hour}
              title={`${DAY_LABELS[day]} ${hour}:00 — ${count.toLocaleString()} try-on${count === 1 ? "" : "s"}`}
              style={{
                flex: 1,
                aspectRatio: "1 / 1",
                minWidth: 0,
                borderRadius: 3,
                background: count === 0 ? brand.ink50 : brand.blue,
                opacity: count === 0 ? 1 : 0.25 + 0.75 * (count / max),
              }}
            />
          ))}
        </div>
      ))}
      <div style={{ display: "flex", gap: 3, marginTop: 2 }}>
        <span style={{ width: 30, flexShrink: 0 }} />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} style={{ flex: 1, fontSize: 8, color: brand.ink500, textAlign: "center", minWidth: 0 }}>
            {h % 6 === 0 ? h : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Insights list ──────────────────────────────────────────────────────────
const INSIGHT_COLORS: Record<Insight["tone"], string> = {
  success: brand.success,
  warning: brand.warning,
  critical: brand.danger,
  info: brand.blue,
};

export function InsightsList({ insights }: { insights: Insight[] }) {
  if (insights.length === 0) {
    return <Text as="p" tone="subdued">Not enough data yet to generate recommendations.</Text>;
  }
  return (
    <BlockStack gap="300">
      {insights.map((ins, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            gap: 12,
            border: `1px solid ${brand.ink100}`,
            borderRadius: 12,
            padding: "14px 16px",
            background: brand.offwhite,
          }}
        >
          <span
            style={{
              width: 4,
              borderRadius: 2,
              flexShrink: 0,
              background: INSIGHT_COLORS[ins.tone],
            }}
          />
          <BlockStack gap="100">
            <Text as="span" variant="bodyMd" fontWeight="semibold">{ins.title}</Text>
            <Text as="span" variant="bodySm" tone="subdued">{ins.body}</Text>
          </BlockStack>
        </div>
      ))}
    </BlockStack>
  );
}

// ─── Free-plan lock ─────────────────────────────────────────────────────────
export function LockedCard({ feature }: { feature: string }) {
  const navigate = useNavigate();
  return (
    <Card padding="500">
      <Box paddingBlock="400">
        <BlockStack gap="300" inlineAlign="center">
          <span style={{ fontSize: 28 }}>🔒</span>
          <Text as="h3" variant="headingMd" alignment="center">{feature} is a paid feature</Text>
          <Text as="p" variant="bodySm" tone="subdued" alignment="center">
            Upgrade to unlock the full conversion story — funnels, device breakdowns, product health, and plain-English recommendations.
          </Text>
          <Button variant="primary" onClick={() => navigate("/app/billing")}>View plans</Button>
        </BlockStack>
      </Box>
    </Card>
  );
}
