// Shared analytics UI: time-range selector, deltas, charts, heatmap, funnel,
// insights, and the free-plan lock. Brand-styled to match components/ui.tsx.

import { Fragment, useId, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { BlockStack, Box, Button, ButtonGroup, Card, InlineStack, Text } from "@shopify/polaris";
import { MagicIcon } from "@shopify/polaris-icons";
import { RANGE_OPTIONS, parseRange, type RangeKey } from "../lib/timerange";
import { brand, IconChip, StatusPill, TONE_STYLES, type IconSource, type Tone } from "./ui";
import type { Insight } from "../lib/analytics-shared";

// Re-exported so existing `../components/analytics` imports keep working; the
// definitions now live in ./ui as the single source of truth for the tone system.
export { IconChip, StatusPill, type Tone };

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

// Verdict derived from a metric's own prior-period trend — honest by construction
// (no invented industry benchmark). `invert` flips it for "lower is better"
// metrics like bounce or drop-off. Null delta → no verdict.
export function verdictFromDelta(delta: number | null | undefined, invert = false): { label: string; tone: Tone } | null {
  if (delta == null) return null;
  const dir = invert ? -delta : delta;
  if (dir >= 10) return { label: "Strong", tone: "good" };
  if (dir >= -5) return { label: "Steady", tone: "neutral" };
  if (dir >= -20) return { label: "Slipping", tone: "watch" };
  return { label: "Needs work", tone: "bad" };
}

// ─── Plain-English headline strip ───────────────────────────────────────────
// The TL;DR above the tabs: one sentence a non-technical merchant can read in
// two seconds. The page composes `children` (bold the numbers that matter).
export function HeadlineStrip({ eyebrow = "This period at a glance", children }: { eyebrow?: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start", background: brand.blue100, borderLeft: `3px solid ${brand.blue}`, padding: "12px 14px" }}>
      <span aria-hidden style={{ marginTop: 2, display: "inline-flex" }}>
        <MagicIcon width={20} height={20} style={{ fill: brand.blue700 }} />
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: brand.blue700, marginBottom: 3 }}>{eyebrow}</div>
        <div style={{ fontSize: 15, lineHeight: 1.5, color: brand.ink }}>{children}</div>
      </div>
    </div>
  );
}

// ─── KPI tile with icon, verdict, and optional delta ────────────────────────
export function KpiTile({
  label,
  value,
  hint,
  delta,
  invertDelta,
  accent,
  icon,
  iconTone,
  status,
}: {
  label: string;
  value: string;
  hint?: string;
  delta?: number | null;
  invertDelta?: boolean;
  accent?: boolean;
  icon?: IconSource;
  iconTone?: Tone;
  status?: { label: string; tone: Tone } | null;
}) {
  return (
    <Card padding="500">
      <BlockStack gap="150">
        {(icon || status) && (
          <InlineStack align="space-between" blockAlign="center">
            {icon ? <IconChip source={icon} tone={iconTone ?? (accent ? "money" : "neutral")} /> : <span />}
            {status && <StatusPill label={status.label} tone={status.tone} />}
          </InlineStack>
        )}
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

// ─── Multi-series daily trend (try-ons + cart adds + conversion line) ───────
// Counts (try-ons, carts) share the left scale; a rate series (conversion %)
// rides its own right scale and renders dashed. Hover reads out every series.
type TrendSeries = {
  label: string;
  color: string;
  values: number[];
  dashed?: boolean;
  area?: boolean;
  axis?: "left" | "right";
  suffix?: string;
};

export function TrendChart({
  days,
  series,
  height = 180,
}: {
  days: string[];
  series: TrendSeries[];
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const gradId = useId().replace(/:/g, "");

  const n = days.length;

  if (n === 0) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: brand.ink500 }}>
        No data for this period yet.
      </div>
    );
  }

  const leftMax = Math.max(1, ...series.filter((s) => (s.axis ?? "left") === "left").flatMap((s) => s.values));
  const rightMax = Math.max(1, ...series.filter((s) => s.axis === "right").flatMap((s) => s.values));
  const xFor = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 50);
  const yFor = (s: TrendSeries, c: number) => 8 + (1 - c / (s.axis === "right" ? rightMax : leftMax)) * 86;

  const move = (e: ReactMouseEvent<HTMLDivElement>) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover(Math.round(frac * (n - 1)));
  };

  const hx = hover != null ? xFor(hover) : 0;
  const tipAlign = hx < 16 ? "0%" : hx > 84 ? "-100%" : "-50%";

  return (
    <BlockStack gap="300">
      <InlineStack gap="400">
        {series.map((s) => (
          <span key={s.label} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: brand.ink600 }}>
            <svg width="18" height="8" aria-hidden style={{ overflow: "visible", flexShrink: 0 }}>
              <line
                x1="0"
                y1="4"
                x2="18"
                y2="4"
                stroke={s.color}
                strokeWidth={2.5}
                strokeDasharray={s.dashed ? "3 2" : undefined}
                strokeLinecap="round"
              />
            </svg>
            {s.label}
          </span>
        ))}
      </InlineStack>

      <div
        ref={boxRef}
        onMouseMove={move}
        onMouseLeave={() => setHover(null)}
        style={{ position: "relative", height, cursor: "crosshair" }}
      >
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", overflow: "visible" }}
          aria-hidden
        >
          <defs>
            {series.map((s, si) =>
              s.area ? (
                <linearGradient key={si} id={`${gradId}-${si}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity="0.16" />
                  <stop offset="100%" stopColor={s.color} stopOpacity="0.02" />
                </linearGradient>
              ) : null,
            )}
          </defs>

          <line x1="0" y1="100" x2="100" y2="100" stroke={brand.ink100} strokeWidth={1} vectorEffect="non-scaling-stroke" />

          {series.map((s, si) => {
            const pts = s.values.map((v, i) => [xFor(i), yFor(s, v)] as [number, number]);
            const linePath = smoothPath(pts);
            return (
              <g key={si}>
                {s.area && <path d={`${linePath} L 100 100 L 0 100 Z`} fill={`url(#${gradId}-${si})`} stroke="none" />}
                <path
                  d={linePath}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeDasharray={s.dashed ? "4 3" : undefined}
                  vectorEffect="non-scaling-stroke"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            );
          })}
        </svg>

        {hover != null && (
          <>
            <div style={{ position: "absolute", top: 4, bottom: 0, left: `${hx}%`, width: 1, background: brand.ink200, pointerEvents: "none" }} />
            {series.map((s, si) => {
              const y = yFor(s, s.values[hover] ?? 0);
              return (
                <div
                  key={si}
                  style={{
                    position: "absolute",
                    left: `${hx}%`,
                    top: (y / 100) * height,
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: brand.white,
                    border: `2px solid ${s.color}`,
                    transform: "translate(-50%, -50%)",
                    pointerEvents: "none",
                  }}
                />
              );
            })}
            <div
              style={{
                position: "absolute",
                left: `${hx}%`,
                top: 6,
                transform: `translate(${tipAlign}, 0)`,
                background: brand.ink,
                color: brand.white,
                borderRadius: 8,
                padding: "7px 10px",
                fontSize: 11,
                lineHeight: 1.5,
                whiteSpace: "nowrap",
                pointerEvents: "none",
                boxShadow: "0 4px 14px rgba(11,18,32,0.22)",
                zIndex: 3,
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 2 }}>{prettyDay(days[hover])}</div>
              {series.map((s) => (
                <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: s.color, display: "inline-block", flexShrink: 0 }} />
                  <span style={{ opacity: 0.85 }}>{s.label}:</span>
                  <span style={{ fontWeight: 700 }}>
                    {(s.values[hover] ?? 0).toLocaleString()}
                    {s.suffix ?? ""}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </BlockStack>
  );
}

// ─── Horizontal funnel bar ──────────────────────────────────────────────────
// `tone` colors the fill (default money/blue). `note` adds a right-aligned tag
// such as a drop-off %, colored to match — used to flag the biggest leak in red.
// `showPct` appends the share-of-top; suppress it inside <Funnel>, where the
// drop-off connector already tells the percentage story.
export function FunnelBar({
  label,
  value,
  max,
  tone = "money",
  note,
  showPct = true,
}: {
  label: string;
  value: number;
  max: number;
  tone?: Tone;
  note?: string;
  showPct?: boolean;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  const fill = TONE_STYLES[tone].icon;
  const highlight = tone === "bad" || tone === "watch";
  return (
    <BlockStack gap="100">
      <InlineStack align="space-between" blockAlign="center">
        <span style={{ fontSize: 13, fontWeight: highlight ? 600 : 400, color: highlight ? TONE_STYLES[tone].fg : brand.ink }}>{label}</span>
        <span style={{ fontSize: 13, color: highlight ? TONE_STYLES[tone].fg : brand.ink500, fontWeight: highlight ? 600 : 400 }}>
          {value.toLocaleString()}{showPct && max > 0 ? ` · ${pct}%` : ""}{note ? `  ${note}` : ""}
        </span>
      </InlineStack>
      <div style={{ height: 8, background: brand.ink100, borderRadius: 6, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: fill, borderRadius: 6, transition: "width 300ms ease" }} />
      </div>
    </BlockStack>
  );
}

// ─── Funnel silhouette with drop-off summary ────────────────────────────────
// One connected funnel: each stage is a centered trapezoid whose bottom edge is
// the next stage's top edge, so the segments join into a single shape that
// narrows as conversion falls away. Fill deepens toward the bottom for depth,
// the count sits inside each band, and the stage name rides a left gutter. The
// biggest leak is tinted red and summarized in a callout beneath (unless the
// caller renders its own via `showLeakSummary={false}`). Pass `leakLabel` to
// pin the flag to a server-computed leak; otherwise it's the biggest lost count.
export type FunnelStage = { key?: string; label: string; value: number };

// Blend two hex colors — used to graduate the funnel from a lighter blue at the
// top to a deep blue at the bottom without hand-listing a shade per stage.
function mixHex(a: string, b: string, t: number): string {
  const parse = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const to = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${to(ar, br)}${to(ag, bg)}${to(ab, bb)}`;
}

export function Funnel({
  stages,
  leakLabel,
  showLeakSummary = true,
}: {
  stages: FunnelStage[];
  leakLabel?: string;
  showLeakSummary?: boolean;
}) {
  const top = stages[0]?.value ?? 0;
  const n = stages.length;

  if (top <= 0) {
    return <Text as="p" tone="subdued">No funnel data yet.</Text>;
  }

  // Auto-detect the leak (biggest single-step loss by count) when the caller
  // hasn't named one.
  let autoLeakIdx = -1;
  let worstLost = 0;
  for (let i = 1; i < n; i++) {
    const lost = (stages[i - 1]?.value ?? 0) - stages[i].value;
    if (lost > worstLost) {
      worstLost = lost;
      autoLeakIdx = i;
    }
  }
  const leakIdx = leakLabel != null ? stages.findIndex((s, i) => i > 0 && s.label === leakLabel) : autoLeakIdx;

  // Stylized display width: monotonic in the real share so ordering always
  // holds, but floored to ~0.2 so even a tiny stage keeps a readable neck and
  // the count fits inside it. The exact count (shown inside) carries precision;
  // the shape is the at-a-glance read.
  const dispFrac = (v: number) => 0.2 + 0.8 * Math.max(0, Math.min(1, v / top));
  const half = (f: number) => Math.round(50 * f * 100) / 100;
  const shade = (i: number) => mixHex("#4A6FD6", brand.blue700, n > 1 ? i / (n - 1) : 0);

  const leak =
    leakIdx > 0
      ? {
          from: stages[leakIdx - 1].label,
          to: stages[leakIdx].label,
          lost: Math.max(0, stages[leakIdx - 1].value - stages[leakIdx].value),
          pct:
            stages[leakIdx - 1].value > 0
              ? Math.round(((stages[leakIdx - 1].value - stages[leakIdx].value) / stages[leakIdx - 1].value) * 100)
              : 0,
        }
      : null;

  return (
    <BlockStack gap="300">
      <div style={{ maxWidth: 520, width: "100%", margin: "0 auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(84px, 132px) 1fr", columnGap: 12 }}>
          {stages.map((s, i) => {
            const isLeak = i === leakIdx;
            const wTop = dispFrac(s.value);
            const wBot = i < n - 1 ? dispFrac(stages[i + 1].value) : wTop;
            const clip = `polygon(${50 - half(wTop)}% 0%, ${50 + half(wTop)}% 0%, ${50 + half(wBot)}% 100%, ${50 - half(wBot)}% 100%)`;
            const fill = isLeak ? brand.danger : shade(i);

            return (
              <Fragment key={s.key ?? s.label}>
                <div style={{ height: 50, display: "flex", alignItems: "center", justifyContent: "flex-end", textAlign: "right" }}>
                  <span style={{ fontSize: 12.5, fontWeight: isLeak ? 600 : 500, lineHeight: 1.25, color: isLeak ? brand.dangerInk : brand.ink700 }}>
                    {s.label}
                  </span>
                </div>
                <div style={{ height: 50, position: "relative" }}>
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      background: fill,
                      clipPath: clip,
                      WebkitClipPath: clip,
                      transition: "clip-path 300ms ease, background 200ms ease",
                    }}
                  />
                  <span
                    style={{
                      position: "absolute",
                      inset: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: brand.white,
                      fontSize: 13.5,
                      fontWeight: 500,
                      pointerEvents: "none",
                    }}
                  >
                    {s.value.toLocaleString()}
                  </span>
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>

      {showLeakSummary && leak && leak.lost > 0 && (
        <div
          style={{
            border: `1px solid ${brand.ink100}`,
            borderLeft: `4px solid ${brand.danger}`,
            borderRadius: 10,
            padding: "10px 12px",
            background: brand.offwhite,
          }}
        >
          <Text as="p" variant="bodySm">
            <strong>Biggest drop-off:</strong> {leak.pct}% from {leak.from.toLowerCase()} to {leak.to.toLowerCase()} — {leak.lost.toLocaleString()} lost.
          </Text>
        </div>
      )}
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
