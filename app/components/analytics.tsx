// Shared analytics UI: time-range selector, deltas, charts, heatmap, funnel,
// insights, and the free-plan lock. Brand-styled to match components/ui.tsx.

import { useId, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { BlockStack, Box, Button, Card, InlineStack, Text } from "@shopify/polaris";
import { LockIcon } from "@shopify/polaris-icons";
import { RANGE_OPTIONS, parseRange, type RangeKey } from "../lib/timerange";
import { brand, fonts, ledger, tnum, Eyebrow, MonoMeta, IconChip, StatusPill, TONE_STYLES, type IconSource, type Tone } from "./ui";
import type { Insight } from "../lib/analytics-shared";

// Re-exported so existing `../components/analytics` imports keep working; the
// definitions now live in ./ui as the single source of truth for the tone system.
export { IconChip, StatusPill, type Tone };

// ─── Time range selector (?range=7d|30d|90d, preserves other params) ───────
// Hairline pill segmented control in the Ledger language: the active range is
// an ink chip, the rest stay quiet. Same URL contract as before.
export function TimeRangeSelector() {
  const [searchParams, setSearchParams] = useSearchParams();
  const current = parseRange(searchParams.get("range"));

  const select = (key: RangeKey) => {
    const next = new URLSearchParams(searchParams);
    next.set("range", key);
    setSearchParams(next, { preventScrollReset: true });
  };

  return (
    <div
      role="group"
      aria-label="Time range"
      style={{
        display: "inline-flex",
        border: `1px solid ${brand.ink200}`,
        borderRadius: 999,
        background: brand.white,
        padding: 2,
        gap: 2,
      }}
    >
      {RANGE_OPTIONS.map((opt) => {
        const active = current === opt.key;
        return (
          <button
            key={opt.key}
            type="button"
            aria-pressed={active}
            onClick={() => select(opt.key)}
            style={{
              border: "none",
              borderRadius: 999,
              padding: "4px 12px",
              fontSize: 12,
              fontWeight: active ? 650 : 500,
              fontFamily: "inherit",
              lineHeight: 1.4,
              cursor: active ? "default" : "pointer",
              background: active ? brand.ink : "transparent",
              color: active ? brand.white : brand.ink500,
              transition: "background 120ms ease, color 120ms ease",
              ...tnum,
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Delta vs previous period ───────────────────────────────────────────────
// Rounded diagonal trend arrow — friendlier than ▲/▼ and drawn with the same
// round-capped stroke language as the Polaris icon set.
function TrendArrow({ dir, size = 10 }: { dir: "up" | "down" | "flat"; size?: number }) {
  const d =
    dir === "up"
      ? "M1.5 8.5 L8.5 1.5 M4.2 1.5 H8.5 V5.8"
      : dir === "down"
        ? "M1.5 1.5 L8.5 8.5 M8.5 4.2 V8.5 H4.2"
        : "M1.5 5 H8.5";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      role="img"
      aria-label={dir === "up" ? "Up" : dir === "down" ? "Down" : "Flat"}
      style={{ flexShrink: 0 }}
    >
      <path d={d} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

// Plain colored delta in the Ledger register: arrow glyph + tabular percent in
// the semantic ink, comparison caption in quiet gray. The color carries the
// verdict; the number stays legible without a pill box. `invert` flips the
// good/bad coloring for lower-is-better metrics; direction always follows sign.
export function Delta({ value, invert }: { value: number | null; invert?: boolean }) {
  if (value == null) return null;
  const good = invert ? value <= 0 : value >= 0;
  const flat = value === 0;
  const fg = flat ? brand.ink500 : good ? brand.successInk : brand.dangerInk;
  const dir = value > 0 ? "up" : value < 0 ? "down" : "flat";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          color: fg,
          fontSize: 12,
          fontWeight: 650,
          lineHeight: 1.2,
          ...tnum,
        }}
      >
        <TrendArrow dir={dir} />
        {Math.abs(value)}%
      </span>
      <span style={{ fontSize: 12, color: brand.ink500 }}>vs prev.</span>
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
// The TL;DR above everything: one sentence a non-technical merchant can read
// in two seconds, set like the opening line of a ledger — a solid ink rule
// above, a dashed receipt rule below, no colored box shouting over the words.
// The page composes `children` (bold the numbers that matter).
export function HeadlineStrip({ eyebrow = "This period at a glance", children }: { eyebrow?: string; children: ReactNode }) {
  return (
    <div
      style={{
        borderTop: ledger.totalRule,
        borderBottom: ledger.dashed,
        padding: "12px 2px 13px",
      }}
    >
      <div style={{ marginBottom: 4 }}>
        <Eyebrow>{eyebrow}</Eyebrow>
      </div>
      <div style={{ fontSize: 14.5, lineHeight: 1.55, color: brand.ink700, ...tnum }}>{children}</div>
    </div>
  );
}

// ─── KPI anatomy (Editorial Ledger) ─────────────────────────────────────────
// Reading order per tile, top to bottom: quiet eyebrow label (verdict pill on
// the same line when present) → Playfair hero numeral → colored delta → mono
// receipt footnote. Icon chips deliberately stay out of KPI tiles — they
// belong to section headings; next to a number they read template, not ledger.

export type KpiTileProps = {
  label: string;
  value: string;
  hint?: string;
  delta?: number | null;
  invertDelta?: boolean;
  accent?: boolean;
  /** Accepted for call-site compatibility; KPI tiles no longer render icons. */
  icon?: IconSource;
  iconTone?: Tone;
  status?: { label: string; tone: Tone } | null;
};

// The inner anatomy, shared by the standalone card tile and the banded cell.
function KpiBody({ label, value, hint, delta, invertDelta, accent, status, hero }: KpiTileProps & { hero?: boolean }) {
  return (
    <BlockStack gap="100">
      <InlineStack align="space-between" blockAlign="center" wrap={false}>
        <Eyebrow>{label}</Eyebrow>
        {status && <StatusPill label={status.label} tone={status.tone} />}
      </InlineStack>
      <span
        style={{
          fontFamily: fonts.serif,
          fontSize: hero ? 40 : 31,
          fontWeight: 500,
          lineHeight: 1.12,
          letterSpacing: "-0.01em",
          color: accent ? brand.blue : brand.ink,
          ...tnum,
        }}
      >
        {value}
      </span>
      {(delta !== undefined || hint) && (
        <InlineStack gap="200" blockAlign="center">
          {delta !== undefined && <Delta value={delta} invert={invertDelta} />}
          {hint && <MonoMeta>{hint}</MonoMeta>}
        </InlineStack>
      )}
    </BlockStack>
  );
}

export function KpiTile(props: KpiTileProps) {
  return (
    <Card padding="500">
      <KpiBody {...props} />
    </Card>
  );
}

// One flat card holding a row of KPI cells separated by dashed receipt rules —
// never four boxed cards in a row. The first tile may set `accent`/`hero` via
// its props to be the page's single accented number.
export function KpiBand({ tiles }: { tiles: KpiTileProps[] }) {
  return (
    <Card padding="500">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${Math.max(1, tiles.length)}, minmax(190px, 1fr))`,
          overflowX: "auto",
        }}
      >
        {tiles.map((t, i) => (
          <div
            key={t.label}
            style={{
              padding: i === 0 ? "2px 18px 2px 0" : "2px 18px",
              borderLeft: i === 0 ? undefined : ledger.dashed,
              minWidth: 0,
              overflow: "hidden",
            }}
          >
            <KpiBody {...t} hero={t.accent} />
          </div>
        ))}
      </div>
    </Card>
  );
}

// ─── Daily performance card (Home) ──────────────────────────────────────────
// One full-width chart card: revenue bars on top, try-on/cart-add lines below,
// aligned to a shared x-axis with date ticks and a unified crosshair readout —
// the same interaction language as the external dashboard. Two stacked panels
// (never a dual axis): money and counts each get their own scale, and hover
// reads out all three series for the day under the cursor.
//
// Series colors are palette-validated (dataviz six checks): revenue = brand
// blue BARS, try-ons = orchid LINE + soft area, cart adds = success LINE.
// Orchid's only sub-10 CVD pair is vs the blue, which lives in the other panel
// with a different mark shape; the legend + tooltip carry exact values.

export type DailyPerfPoint = { day: string; value: number };

const PANEL_BARS_H = 128;
const PANEL_LINES_H = 104;

function LegendStat({
  color,
  label,
  value,
  delta,
}: {
  color: string;
  label: string;
  value: string;
  delta: number | null;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, whiteSpace: "nowrap" }}>
      <span aria-hidden style={{ width: 10, height: 10, borderRadius: 3, background: color, flexShrink: 0 }} />
      <span style={{ fontSize: 12.5, color: brand.ink600 }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 650, color: brand.ink, ...tnum }}>{value}</span>
      <Delta value={delta} />
    </span>
  );
}

export function DailyPerformanceCard({
  revenue,
  tryons,
  carts,
  totals,
  deltas,
  formatMoney,
  rangeDays,
  cartConversionPct,
}: {
  revenue: DailyPerfPoint[];
  tryons: DailyPerfPoint[];
  carts: DailyPerfPoint[];
  totals: { revenue: number; tryons: number; carts: number };
  deltas: { revenue: number | null; tryons: number | null; carts: number | null };
  formatMoney: (v: number) => string;
  rangeDays: number;
  cartConversionPct: number | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const gradId = useId().replace(/:/g, "");

  // Unified day list: the revenue RPC's gap-filled series is authoritative;
  // fall back to the try-on series if revenue came back empty. Counts merge in
  // by day key so a missing bucket reads 0, never misaligns.
  const days = (revenue.length > 0 ? revenue : tryons).map((d) => d.day);
  const byDay = (list: DailyPerfPoint[]) => {
    const m = new Map(list.map((d) => [d.day, d.value]));
    return days.map((day) => m.get(day) ?? 0);
  };
  const revVals = byDay(revenue);
  const tryVals = byDay(tryons);
  const cartVals = byDay(carts);

  const n = days.length;
  const revMax = Math.max(...revVals, 0);
  const countMax = Math.max(...tryVals, ...cartVals, 0);
  const hasAny = revMax > 0 || countMax > 0;

  // One x-mapping for everything: slot centers, so bars, line points, ticks,
  // and the crosshair all land on the same column.
  const xPct = (i: number) => ((i + 0.5) / Math.max(1, n)) * 100;

  const move = (e: ReactMouseEvent<HTMLDivElement>) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const frac = Math.min(0.9999, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover(Math.min(n - 1, Math.floor(frac * n)));
  };

  // ~5 date ticks spread across the window (always first + last).
  const tickCount = Math.min(n, rangeDays <= 7 ? 4 : 5);
  const tickIdx = Array.from({ length: tickCount }, (_, i) =>
    Math.round((i * (n - 1)) / Math.max(1, tickCount - 1)),
  );

  const linePts = (vals: number[]) =>
    vals.map((v, i) => [xPct(i), 8 + (1 - v / Math.max(1, countMax)) * 86] as [number, number]);

  const hx = hover != null ? xPct(hover) : 0;
  const tipAlign = hx < 16 ? "0%" : hx > 84 ? "-100%" : "-50%";

  const SERIES = [
    { key: "revenue", label: "Attributed revenue", color: brand.blue, fmt: formatMoney, vals: revVals },
    { key: "tryons", label: "Try-ons", color: brand.orchid, fmt: (v: number) => v.toLocaleString(), vals: tryVals },
    { key: "carts", label: "Cart adds", color: brand.success, fmt: (v: number) => v.toLocaleString(), vals: cartVals },
  ];

  return (
    <Card padding="500">
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="start" wrap>
          <BlockStack gap="100">
            <Text as="h2" variant="headingMd">Daily performance</Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Revenue, try-ons & cart adds per day · last {rangeDays} days
            </Text>
          </BlockStack>
          {cartConversionPct != null && (
            <Text as="span" variant="bodySm" tone="subdued">
              {cartConversionPct}% of try-on sessions add to cart
            </Text>
          )}
        </InlineStack>

        {/* Legend doubles as the stat row: color key + range total + delta. */}
        <InlineStack gap="500" blockAlign="center" wrap>
          <LegendStat color={brand.blue} label="Attributed revenue" value={formatMoney(totals.revenue)} delta={deltas.revenue} />
          <LegendStat color={brand.orchid} label="Try-ons" value={totals.tryons.toLocaleString()} delta={deltas.tryons} />
          <LegendStat color={brand.success} label="Cart adds" value={totals.carts.toLocaleString()} delta={deltas.carts} />
        </InlineStack>

        {!hasAny ? (
          <div
            style={{
              height: PANEL_BARS_H + PANEL_LINES_H + 46,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 13,
              color: brand.ink500,
            }}
          >
            No activity in this period yet — charts fill in as shoppers use the widget.
          </div>
        ) : (
          <div
            ref={boxRef}
            onMouseMove={move}
            onMouseLeave={() => setHover(null)}
            style={{ position: "relative", cursor: "crosshair" }}
          >
            {/* ── Panel A: attributed revenue (bars) ── */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: brand.ink500 }}>
                Revenue
              </span>
              {revMax > 0 && (
                <span style={{ fontSize: 11, color: brand.ink500 }}>peak {formatMoney(revMax)}/day</span>
              )}
            </div>
            <div
              style={{
                height: PANEL_BARS_H,
                display: "flex",
                alignItems: "flex-end",
                borderBottom: `1px solid ${brand.ink100}`,
              }}
            >
              {revVals.map((v, i) => {
                const h = v > 0 ? Math.max(3, Math.round((v / Math.max(1, revMax)) * (PANEL_BARS_H - 14))) : 0;
                return (
                  <div
                    key={days[i]}
                    style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "flex-end", justifyContent: "center", height: "100%" }}
                  >
                    <div
                      style={{
                        width: n > 45 ? "calc(100% - 1px)" : "min(68%, 44px)",
                        height: h,
                        background: hover === i ? brand.blue700 : brand.blue,
                        borderRadius: n > 45 ? "1.5px 1.5px 0 0" : "4px 4px 0 0",
                        transition: "background 80ms ease",
                      }}
                    />
                  </div>
                );
              })}
            </div>

            {/* ── Panel B: try-ons + cart adds (lines, shared count scale) ── */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "14px 0 6px" }}>
              <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: brand.ink500 }}>
                Try-ons & cart adds
              </span>
              {countMax > 0 && (
                <span style={{ fontSize: 11, color: brand.ink500 }}>peak {countMax.toLocaleString()}/day</span>
              )}
            </div>
            <div style={{ position: "relative", height: PANEL_LINES_H, borderBottom: `1px solid ${brand.ink100}` }}>
              <svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", overflow: "visible" }}
                aria-hidden
              >
                <defs>
                  <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={brand.orchid} stopOpacity="0.20" />
                    <stop offset="100%" stopColor={brand.orchid} stopOpacity="0.02" />
                  </linearGradient>
                </defs>
                <path d={`${smoothPath(linePts(tryVals))} L 100 100 L 0 100 Z`} fill={`url(#${gradId})`} stroke="none" />
                <path
                  d={smoothPath(linePts(tryVals))}
                  fill="none"
                  stroke={brand.orchid}
                  strokeWidth={2.25}
                  vectorEffect="non-scaling-stroke"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d={smoothPath(linePts(cartVals))}
                  fill="none"
                  stroke={brand.success}
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>

            {/* ── Shared x-axis date ticks ── */}
            <div style={{ position: "relative", height: 20, marginTop: 6 }}>
              {tickIdx.map((idx, k) => (
                <span
                  key={idx}
                  style={{
                    position: "absolute",
                    left: `${xPct(idx)}%`,
                    transform: k === 0 ? "translateX(0)" : k === tickIdx.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
                    fontSize: 11,
                    color: brand.ink500,
                    whiteSpace: "nowrap",
                  }}
                >
                  {prettyDay(days[idx])}
                </span>
              ))}
            </div>

            {/* ── Unified crosshair + readout across both panels ── */}
            {hover != null && (
              <>
                <div
                  style={{
                    position: "absolute",
                    top: 22,
                    bottom: 26,
                    left: `${hx}%`,
                    width: 1,
                    background: brand.ink200,
                    pointerEvents: "none",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: `${hx}%`,
                    top: 16,
                    transform: `translate(${tipAlign}, 0)`,
                    background: brand.ink,
                    color: brand.white,
                    borderRadius: 8,
                    padding: "7px 10px",
                    fontSize: 11,
                    lineHeight: 1.55,
                    whiteSpace: "nowrap",
                    pointerEvents: "none",
                    boxShadow: "0 4px 14px rgba(11,18,32,0.22)",
                    zIndex: 3,
                  }}
                >
                  <div style={{ fontWeight: 700, marginBottom: 2 }}>{prettyDay(days[hover])}</div>
                  {SERIES.map((s) => (
                    <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: s.color, display: "inline-block", flexShrink: 0 }} />
                      <span style={{ opacity: 0.85 }}>{s.label}:</span>
                      <span style={{ fontWeight: 700 }}>{s.fmt(s.vals[hover] ?? 0)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </BlockStack>
    </Card>
  );
}

// Fixed-size shimmer stand-in so the streamed chart never shifts layout.
export function DailyPerformanceSkeleton() {
  return (
    <Card padding="500">
      <BlockStack gap="400">
        <BlockStack gap="100">
          <div style={{ width: 170, height: 20, borderRadius: 6, background: brand.ink50 }} />
          <div style={{ width: 280, height: 13, borderRadius: 4, background: brand.ink50 }} />
        </BlockStack>
        <div style={{ display: "flex", gap: 20 }}>
          {[150, 110, 110].map((w, i) => (
            <div key={i} style={{ width: w, height: 16, borderRadius: 5, background: brand.ink50 }} />
          ))}
        </div>
        <div style={{ height: 18, width: 90, borderRadius: 4, background: brand.ink50 }} />
        <div style={{ height: PANEL_BARS_H, borderRadius: 6, background: brand.ink50 }} />
        <div style={{ height: 18, width: 140, borderRadius: 4, background: brand.ink50 }} />
        <div style={{ height: PANEL_LINES_H, borderRadius: 6, background: brand.ink50 }} />
        <div style={{ height: 14, borderRadius: 4, background: brand.ink50, width: "60%" }} />
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
        <span style={{ fontSize: 12.5, fontWeight: highlight ? 600 : 500, color: highlight ? TONE_STYLES[tone].fg : brand.ink700 }}>{label}</span>
        <span style={{ fontSize: 12.5, color: highlight ? TONE_STYLES[tone].fg : brand.ink500, fontWeight: highlight ? 650 : 500, ...tnum }}>
          {value.toLocaleString()}{showPct && max > 0 ? ` · ${pct}%` : ""}{note ? `  ${note}` : ""}
        </span>
      </InlineStack>
      <div style={{ height: 9, background: brand.ink50, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: fill, borderRadius: 3, transition: "width 300ms ease" }} />
      </div>
    </BlockStack>
  );
}

// ─── Funnel as left-aligned bars with drop-off summary ──────────────────────
// Every stage is a horizontal bar on a common baseline — never a trapezoid,
// whose diagonal areas flatter the drop-off. The right column carries the
// count plus the stage-to-stage conversion ("76% of opens"), because the
// decision lives between stages, not in share-of-top. The biggest leak keeps
// its red callout beneath (unless the caller renders its own via
// `showLeakSummary={false}`). Pass `leakLabel` to pin the flag to a
// server-computed leak; otherwise it's the biggest lost count.
export type FunnelStage = { key?: string; label: string; value: number };

// Funnel stage shades, deep to light — approved palette steps only (never
// interpolated hexes; Brand-Palette.md forbids invented values).
const FUNNEL_RAMP = [brand.blue, brand.blue500, brand.blue400, brand.blue300];

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

  // Graduated blue: deepest at the top stage, lighter as the funnel descends —
  // snapped to the nearest approved palette step.
  const shade = (i: number) =>
    FUNNEL_RAMP[n > 1 ? Math.min(FUNNEL_RAMP.length - 1, Math.round((i / (n - 1)) * (FUNNEL_RAMP.length - 1))) : 0];

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
      <div style={{ display: "grid", gap: 13 }}>
        {stages.map((s, i) => {
          const isLeak = i === leakIdx;
          const prev = i > 0 ? stages[i - 1].value : s.value;
          const stepPct = i === 0 ? 100 : prev > 0 ? Math.round((s.value / prev) * 1000) / 10 : 0;
          const stepNote =
            i === 0 ? "100%" : `${stepPct}% of ${stages[i - 1].label.toLowerCase()}`;
          // Width is share-of-top so bars stay comparable on one baseline; a
          // 2.5% floor keeps the smallest stage visible as more than a sliver.
          const widthPct = top > 0 ? Math.max(2.5, (s.value / top) * 100) : 0;

          return (
            <div key={s.key ?? s.label}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 5 }}>
                <span style={{ fontSize: 12.5, fontWeight: 500, color: isLeak ? brand.dangerInk : brand.ink700 }}>
                  {s.label}
                </span>
                <span style={{ fontSize: 12.5, fontWeight: 650, color: brand.ink, whiteSpace: "nowrap", ...tnum }}>
                  {s.value.toLocaleString()}
                  <span style={{ color: brand.ink500, fontWeight: 500 }}> · {stepNote}</span>
                </span>
              </div>
              <div style={{ height: 9, background: brand.ink50, borderRadius: 3, position: "relative", overflow: "hidden" }}>
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    bottom: 0,
                    left: 0,
                    width: `${widthPct}%`,
                    background: shade(i),
                    borderRadius: 3,
                    transition: "width 300ms ease",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {showLeakSummary && leak && leak.lost > 0 && (
        <div
          style={{
            background: brand.dangerBg,
            borderRadius: 8,
            padding: "9px 12px",
            fontSize: 12.5,
            lineHeight: 1.5,
            color: brand.dangerInk,
            ...tnum,
          }}
        >
          <strong style={{ fontWeight: 650 }}>Biggest leak:</strong> {leak.pct}% drop from {leak.from.toLowerCase()} to{" "}
          {leak.to.toLowerCase()} — {leak.lost.toLocaleString()} lost. This is the lever.
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
          <IconChip source={LockIcon} tone="neutral" size={38} />
          <BlockStack gap="100" inlineAlign="center">
            <span
              style={{
                fontFamily: fonts.serif,
                fontSize: 20,
                fontWeight: 500,
                letterSpacing: "-0.01em",
                color: brand.ink,
                textAlign: "center",
              }}
            >
              {feature} is a paid feature
            </span>
            <Text as="p" variant="bodySm" tone="subdued" alignment="center">
              Upgrade to unlock the full conversion story — funnels, device breakdowns, product health, and plain-English recommendations.
            </Text>
          </BlockStack>
          <Button variant="primary" onClick={() => navigate("/app/billing")}>View plans</Button>
        </BlockStack>
      </Box>
    </Card>
  );
}
