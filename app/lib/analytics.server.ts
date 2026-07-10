// Analytics data layer for the native admin (Home, Analytics, Export).
//
// Reads the same Supabase events the external dashboard uses:
//   widget_events    — widget_open/close, intro decisions, model/upload setup,
//                      photo upload friction (device, page_type, is_first_time)
//   tryon_events     — billable try-ons (success, entry_source, product)
//   cart_events      — attributed cart adds
//   purchase_events  — attributed orders (total_price, line_items)
//   product_view_events / vto_preview_events
// plus the attribution RPCs (get_vto_conversion_summary, get_vto_product_conversion,
// get_preview_metrics_daily) that are already proven in production.
//
// Everything aggregates session-level in TypeScript: volumes are paginated and
// capped, and every fetch fails soft so one missing table never blanks a page.

import { supabaseAdmin } from "./supabase.server";
import { getPlanConfig } from "./shopify-billing.server";
import type { ExportCategory, Insight } from "./analytics-shared";

export type { ExportCategory, Insight } from "./analytics-shared";

// ─── Row shapes ─────────────────────────────────────────────────────────────

export interface WidgetEventRow {
  event_type: string;
  session_id: string | null;
  device: string | null;
  page_type: string | null;
  is_first_time: boolean | null;
  created_at: string;
  reason: string | null;
}

export interface TryonRow {
  session_id: string | null;
  product_id: string | null;
  success: boolean | null;
  entry_source: string | null;
  created_at: string;
}

export interface CartRow {
  session_id: string | null;
  product_id: string | null;
  created_at: string;
}

export interface PurchaseRow {
  session_id: string | null;
  order_id: string | null;
  total_price: number | null;
  created_at: string;
}

export interface ViewRow {
  session_id: string | null;
  product_id: string | null;
  created_at: string;
}

export interface CoreEvents {
  widgetEvents: WidgetEventRow[];
  tryons: TryonRow[];
  carts: CartRow[];
  purchases: PurchaseRow[];
  views: ViewRow[];
}

// ─── Store + plan context ───────────────────────────────────────────────────

export interface StoreContext {
  storeId: string | null;
  slug: string | null;
  shopDomain: string | null;
  storefrontToken: string | null;
}

export async function getStoreContext(shop: string): Promise<StoreContext> {
  const { data } = await supabaseAdmin
    .from("vto_stores")
    .select("id, store_slug, shop_domain, storefront_token")
    .eq("shop_domain", shop)
    .maybeSingle();
  return {
    storeId: (data?.id as string | undefined) ?? null,
    slug: (data?.store_slug as string | undefined) ?? null,
    shopDomain: (data?.shop_domain as string | undefined) ?? null,
    storefrontToken: (data?.storefront_token as string | undefined) ?? null,
  };
}

/** Free-plan detection for gating the advanced analytics tabs. */
export async function getPlanTier(
  shop: string,
): Promise<{ planKey: string | null; isFree: boolean }> {
  // eslint-disable-next-line no-undef
  if (process.env.SKIP_BILLING === "true") return { planKey: "custom_distribution", isFree: false };
  try {
    const { data: account } = await supabaseAdmin
      .from("vto_accounts")
      .select("id")
      .eq("shopify_shop_domain", shop)
      .maybeSingle();
    if (!account) return { planKey: null, isFree: true };
    const { data: sub } = await supabaseAdmin
      .from("vto_subscriptions")
      .select("plan_id")
      .eq("account_id", account.id)
      .eq("status", "active")
      .order("shopify_subscription_id", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (!sub?.plan_id) return { planKey: null, isFree: true };
    const entry = Object.entries(getPlanConfig()).find(([, m]) => m.planId === sub.plan_id);
    const planKey = entry?.[0] ?? null;
    return { planKey, isFree: planKey === "ello_free" };
  } catch (err) {
    console.error("[analytics] plan tier lookup failed (non-fatal):", err);
    return { planKey: null, isFree: false };
  }
}

// Shop IANA timezone — cached per shop for the Cloud Run instance lifetime so
// the heatmap/day buckets match the merchant's clock without a GraphQL call
// on every analytics load.
const tzCache = new Map<string, string>();

export async function getShopTimezone(
  admin: { graphql: (q: string) => Promise<Response> },
  shop: string,
): Promise<string> {
  const cached = tzCache.get(shop);
  if (cached) return cached;
  try {
    const res = await admin.graphql(`#graphql\n{ shop { ianaTimezone } }`);
    const json = await res.json();
    const tz = json?.data?.shop?.ianaTimezone;
    if (typeof tz === "string" && tz.length > 0) {
      tzCache.set(shop, tz);
      return tz;
    }
  } catch (err) {
    console.error("[analytics] timezone lookup failed (non-fatal):", err);
  }
  return "UTC";
}

// ─── Fetchers ───────────────────────────────────────────────────────────────

const PAGE = 1000;
// Per-table row cap for a single dashboard load. These selects are narrow (a
// few columns), so 100k rows is well within memory — it covers a high-volume
// brand's monthly window where the old 20k cap silently under-counted every
// number (opens, try-ons, conversion, revenue). NOTE: the correct long-term
// fix for truly huge stores is server-side aggregation (a Postgres RPC that
// returns rollups instead of raw rows); until then, hitting this cap is logged
// loudly rather than passed off as a complete count.
const ROW_CAP = 100000;

async function fetchPaged<T>(
  build: (lo: number, hi: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  cap = ROW_CAP,
): Promise<T[]> {
  const out: T[] = [];
  let hitCap = true;
  for (let lo = 0; lo < cap; lo += PAGE) {
    try {
      const { data, error } = await build(lo, Math.min(lo + PAGE, cap) - 1);
      if (error) {
        console.error("[analytics] fetch failed (non-fatal):", error.message);
        break;
      }
      const rows = (data as T[] | null) ?? [];
      out.push(...rows);
      if (rows.length < PAGE) { hitCap = false; break; }
    } catch (err) {
      console.error("[analytics] fetch threw (non-fatal):", err);
      hitCap = false;
      break;
    }
  }
  if (hitCap && out.length >= cap) {
    console.warn(
      `[analytics] row cap (${cap}) reached — numbers for this window are UNDER-counted. ` +
      `Move this store to server-side aggregation.`,
    );
  }
  return out;
}

export async function fetchCoreEvents(slug: string, from: Date, to: Date): Promise<CoreEvents> {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const paged = <T,>(table: string, columns: string) =>
    fetchPaged<T>((lo, hi) =>
      supabaseAdmin
        .from(table)
        .select(columns)
        .eq("store_slug", slug)
        .gte("created_at", fromIso)
        .lt("created_at", toIso)
        .order("created_at", { ascending: false })
        .range(lo, hi),
    );

  const [widgetEvents, tryons, carts, purchases, views] = await Promise.all([
    paged<WidgetEventRow>(
      "widget_events",
      "event_type, session_id, device, page_type, is_first_time, created_at, reason:event_data->>reason",
    ),
    paged<TryonRow>("tryon_events", "session_id, product_id, success, entry_source, created_at"),
    paged<CartRow>("cart_events", "session_id, product_id, created_at"),
    paged<PurchaseRow>("purchase_events", "session_id, order_id, total_price, created_at"),
    paged<ViewRow>("product_view_events", "session_id, product_id, created_at"),
  ]);

  return { widgetEvents, tryons, carts, purchases, views };
}

export interface ConversionSummary {
  tryonSessions: number;
  viewed: number;
  addedToCart: number;
  purchased: number;
  revenue: number;
  purchaseConversionPct: number | null;
}

export async function getConversionSummary(
  slug: string,
  from: Date,
  to: Date,
): Promise<ConversionSummary | null> {
  const { data, error } = await supabaseAdmin.rpc("get_vto_conversion_summary", {
    p_store_slug: slug,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) {
    console.error("[analytics] conversion summary failed (non-fatal):", error.message);
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = (Array.isArray(data) ? data[0] : null) as any;
  if (!row) return null;
  return {
    tryonSessions: Number(row.tryon_sessions ?? 0),
    viewed: Number(row.sessions_viewed_product ?? 0),
    addedToCart: Number(row.sessions_added_to_cart ?? 0),
    purchased: Number(row.sessions_purchased ?? 0),
    revenue: Number(row.attributed_revenue ?? 0),
    purchaseConversionPct:
      row.purchase_conversion_pct != null ? Number(row.purchase_conversion_pct) : null,
  };
}

// Complete-the-Look proof layer: upsell usage, AOV segmented by whether the
// session used the look, and treatment-vs-holdout aggregates while a 50/50
// proof test runs. Numbers reconcile with get_vto_conversion_summary — the
// RPC reuses its exact attribution join.
export interface CtlPerformance {
  ctlTryons: number;
  ctlSessions: number;
  ordersWithLook: number;
  revenueWithLook: number;
  aovWithLook: number | null;
  ordersWithoutLook: number;
  revenueWithoutLook: number;
  aovWithoutLook: number | null;
  holdoutActive: boolean;
  holdoutSince: string | null;
  tSessions: number;
  tOrders: number;
  tRevenue: number;
  tAov: number | null;
  hSessions: number;
  hOrders: number;
  hRevenue: number;
  hAov: number | null;
}

export async function getCtlPerformance(
  slug: string,
  from: Date,
  to: Date,
): Promise<CtlPerformance | null> {
  const { data, error } = await supabaseAdmin.rpc("get_ctl_performance", {
    p_store_slug: slug,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) {
    console.error("[analytics] CTL performance failed (non-fatal):", error.message);
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = (Array.isArray(data) ? data[0] : null) as any;
  if (!row) return null;
  const num = (v: unknown) => Number(v ?? 0);
  const numOrNull = (v: unknown) => (v == null ? null : Number(v));
  return {
    ctlTryons: num(row.ctl_tryons),
    ctlSessions: num(row.ctl_sessions),
    ordersWithLook: num(row.orders_with_look),
    revenueWithLook: num(row.revenue_with_look),
    aovWithLook: numOrNull(row.aov_with_look),
    ordersWithoutLook: num(row.orders_without_look),
    revenueWithoutLook: num(row.revenue_without_look),
    aovWithoutLook: numOrNull(row.aov_without_look),
    holdoutActive: row.holdout_active === true,
    holdoutSince: row.holdout_since ?? null,
    tSessions: num(row.t_sessions),
    tOrders: num(row.t_orders),
    tRevenue: num(row.t_revenue),
    tAov: numOrNull(row.t_aov),
    hSessions: num(row.h_sessions),
    hOrders: num(row.h_orders),
    hRevenue: num(row.h_revenue),
    hAov: numOrNull(row.h_aov),
  };
}

export interface ProductConversionRow {
  productId: string;
  tryons: number;
  conversionPct: number | null;
  revenue: number;
}

export async function getProductConversion(
  slug: string,
  from: Date,
  to: Date,
): Promise<ProductConversionRow[]> {
  const { data, error } = await supabaseAdmin.rpc("get_vto_product_conversion", {
    p_store_slug: slug,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) {
    console.error("[analytics] product conversion failed (non-fatal):", error.message);
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((data as any[] | null) ?? []).map((r) => ({
    productId: String(r.product_id ?? ""),
    tryons: Number(r.tryons ?? 0),
    conversionPct: r.conversion_pct != null ? Number(r.conversion_pct) : null,
    revenue: Number(r.attributed_revenue ?? 0),
  }));
}

export interface PreviewMetrics {
  daily: Array<{ day: string; impressions: number; engagements: number; tryonCompleted: number }>;
  impressions: number;
  engagements: number;
  photoUploaded: number;
  tryonCompleted: number;
  tryonFailed: number;
  dismissedForever: number;
}

export async function getPreviewMetrics(
  storeId: string,
  from: Date,
  to: Date,
): Promise<PreviewMetrics> {
  const empty: PreviewMetrics = {
    daily: [],
    impressions: 0,
    engagements: 0,
    photoUploaded: 0,
    tryonCompleted: 0,
    tryonFailed: 0,
    dismissedForever: 0,
  };
  try {
    const [rpcRes, dismissRes] = await Promise.all([
      supabaseAdmin.rpc("get_preview_metrics_daily", {
        p_store_id: storeId,
        p_from: from.toISOString(),
        p_to: to.toISOString(),
      }),
      supabaseAdmin
        .from("vto_preview_events")
        .select("*", { count: "exact", head: true })
        .eq("store_id", storeId)
        .eq("event_name", "preview_dismissed_forever")
        .gte("occurred_at", from.toISOString())
        .lt("occurred_at", to.toISOString()),
    ]);
    if (rpcRes.error) {
      console.error("[analytics] preview metrics failed (non-fatal):", rpcRes.error.message);
      return empty;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = ((rpcRes.data as any[] | null) ?? []).map((r) => ({
      day: String(r.day),
      impressions: Number(r.impressions ?? 0),
      engagements: Number(r.engagements ?? 0),
      tryonCompleted: Number(r.tryon_completed ?? 0),
    }));
    const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
    return {
      daily: rows,
      impressions: sum((r) => r.impressions),
      engagements: sum((r) => r.engagements),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      photoUploaded: ((rpcRes.data as any[] | null) ?? []).reduce((a, r) => a + Number(r.photo_uploaded ?? 0), 0),
      tryonCompleted: sum((r) => r.tryonCompleted),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tryonFailed: ((rpcRes.data as any[] | null) ?? []).reduce((a, r) => a + Number(r.tryon_failed ?? 0), 0),
      dismissedForever: dismissRes.count ?? 0,
    };
  } catch (err) {
    console.error("[analytics] preview metrics threw (non-fatal):", err);
    return empty;
  }
}

/** Cheap head-counts for the previous window, for KPI deltas. */
export async function getPrevCounts(slug: string, from: Date, to: Date) {
  const head = (table: string, extra?: { col: string; val: string }) => {
    let q = supabaseAdmin
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("store_slug", slug)
      .gte("created_at", from.toISOString())
      .lt("created_at", to.toISOString());
    if (extra) q = q.eq(extra.col, extra.val);
    return q;
  };
  const [tryonsRes, opensRes, cartsRes, summary] = await Promise.all([
    head("tryon_events"),
    head("widget_events", { col: "event_type", val: "widget_open" }),
    head("cart_events"),
    getConversionSummary(slug, from, to),
  ]);
  return {
    tryons: tryonsRes.count ?? 0,
    opens: opensRes.count ?? 0,
    carts: cartsRes.count ?? 0,
    revenue: summary?.revenue ?? 0,
    addedToCart: summary?.addedToCart ?? 0,
    tryonSessions: summary?.tryonSessions ?? 0,
  };
}

/** category + active flags from the synced catalog, for product health. */
export async function getCatalogCategories(
  slug: string,
  productIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (productIds.length === 0) return out;
  try {
    const { data } = await supabaseAdmin
      .from("clothing_items")
      .select("item_id, category")
      .eq("store_id", slug)
      .in("item_id", productIds.slice(0, 500));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of (data as any[] | null) ?? []) {
      if (r.item_id) out.set(String(r.item_id), String(r.category ?? "clothing"));
    }
  } catch (err) {
    console.error("[analytics] catalog categories failed (non-fatal):", err);
  }
  return out;
}

// ─── Timezone bucketing ─────────────────────────────────────────────────────

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function getFmt(tz: string): Intl.DateTimeFormat {
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hour12: false,
        weekday: "short",
      });
    } catch {
      fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hour12: false,
        weekday: "short",
      });
    }
    fmtCache.set(tz, fmt);
  }
  return fmt;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function tzParts(iso: string, tz: string): { day: string; weekday: number; hour: number } {
  const parts = getFmt(tz).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  const hour = Number.parseInt(get("hour"), 10) % 24; // "24" → 0
  const weekday = Math.max(0, WEEKDAYS.indexOf(get("weekday")));
  return { day, weekday, hour: Number.isFinite(hour) ? hour : 0 };
}

/** Continuous per-day counts (shop timezone) over the window — no gaps. */
export function dailySeries(
  isoDates: string[],
  tz: string,
  from: Date,
  to: Date,
): Array<{ day: string; count: number }> {
  const counts = new Map<string, number>();
  for (const iso of isoDates) {
    const { day } = tzParts(iso, tz);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const out: Array<{ day: string; count: number }> = [];
  // Walk in 24h steps; dedupe day keys (DST can repeat/skip).
  const seen = new Set<string>();
  for (let t = from.getTime(); t <= to.getTime(); t += 24 * 60 * 60 * 1000) {
    const { day } = tzParts(new Date(t).toISOString(), tz);
    if (seen.has(day)) continue;
    seen.add(day);
    out.push({ day, count: counts.get(day) ?? 0 });
  }
  const last = tzParts(to.toISOString(), tz).day;
  if (!seen.has(last)) out.push({ day: last, count: counts.get(last) ?? 0 });
  return out;
}

/** 7×24 day-of-week × hour-of-day intensity grid (shop timezone). */
export function heatmapGrid(isoDates: string[], tz: string): number[][] {
  const grid: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const iso of isoDates) {
    const { weekday, hour } = tzParts(iso, tz);
    grid[weekday][hour] += 1;
  }
  return grid;
}

// ─── Session model ──────────────────────────────────────────────────────────

export interface SessionInfo {
  id: string;
  firstAt: string;
  lastAt: string;
  device: string | null;
  pageType: string | null;
  firstTime: boolean;
  opened: boolean;
  introClicked: boolean;
  introDismissed: boolean;
  modelSelected: boolean;
  uploadSuccess: boolean;
  tryonCount: number;
  tryonSuccessCount: number;
  cartCount: number;
  purchased: boolean;
  revenue: number;
  viewed: boolean;
  products: string[];
}

export function buildSessions(core: CoreEvents): SessionInfo[] {
  const map = new Map<string, SessionInfo>();
  const get = (id: string | null, at: string): SessionInfo | null => {
    if (!id) return null;
    let s = map.get(id);
    if (!s) {
      s = {
        id,
        firstAt: at,
        lastAt: at,
        device: null,
        pageType: null,
        firstTime: false,
        opened: false,
        introClicked: false,
        introDismissed: false,
        modelSelected: false,
        uploadSuccess: false,
        tryonCount: 0,
        tryonSuccessCount: 0,
        cartCount: 0,
        purchased: false,
        revenue: 0,
        viewed: false,
        products: [],
      };
      map.set(id, s);
    }
    if (at < s.firstAt) s.firstAt = at;
    if (at > s.lastAt) s.lastAt = at;
    return s;
  };

  for (const ev of core.widgetEvents) {
    const s = get(ev.session_id, ev.created_at);
    if (!s) continue;
    if (ev.device && !s.device) s.device = ev.device;
    if (ev.page_type && !s.pageType) s.pageType = ev.page_type;
    if (ev.is_first_time) s.firstTime = true;
    switch (ev.event_type) {
      case "widget_open":
        s.opened = true;
        break;
      case "intro_cta_click":
        s.introClicked = true;
        break;
      case "intro_dismiss":
        s.introDismissed = true;
        break;
      case "model_selected":
        s.modelSelected = true;
        break;
      case "photo_upload_success":
        s.uploadSuccess = true;
        break;
    }
  }
  for (const t of core.tryons) {
    const s = get(t.session_id, t.created_at);
    if (!s) continue;
    s.tryonCount += 1;
    if (t.success) s.tryonSuccessCount += 1;
    if (t.product_id && !s.products.includes(t.product_id)) s.products.push(t.product_id);
  }
  for (const c of core.carts) {
    const s = get(c.session_id, c.created_at);
    if (!s) continue;
    s.cartCount += 1;
    if (c.product_id && !s.products.includes(c.product_id)) s.products.push(c.product_id);
  }
  for (const p of core.purchases) {
    const s = get(p.session_id, p.created_at);
    if (!s) continue;
    s.purchased = true;
    s.revenue += Number(p.total_price ?? 0);
  }
  for (const v of core.views) {
    const s = get(v.session_id, v.created_at);
    if (s) s.viewed = true;
  }
  return Array.from(map.values());
}

// ─── Aggregates ─────────────────────────────────────────────────────────────

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
}

export interface SessionFunnel {
  stages: FunnelStage[];
  activationPct: number | null; // setup complete / opens
  bouncePct: number | null; // opened, did nothing else
  biggestLeak: { fromLabel: string; toLabel: string; lostPct: number } | null;
  dataQualityWarning: boolean;
  uniqueOpens: number;
  tryonToCartPct: number | null;
}

export function sessionFunnel(sessions: SessionInfo[]): SessionFunnel {
  const opens = sessions.filter((s) => s.opened).length;
  const introDecided = sessions.filter((s) => s.introClicked).length;
  const setup = sessions.filter((s) => s.modelSelected || s.uploadSuccess).length;
  const tried = sessions.filter((s) => s.tryonCount > 0).length;
  const carted = sessions.filter((s) => s.cartCount > 0).length;
  const purchased = sessions.filter((s) => s.purchased).length;

  const raw = [opens, introDecided, setup, tried, carted, purchased];
  // Sessions can skip explicit intro/setup events (returning shoppers, missing
  // beacons) — smooth right-to-left so the funnel never shows an impossible
  // negative drop, and flag it when smoothing had to kick in.
  let dataQualityWarning = false;
  const smoothed = [...raw];
  for (let i = smoothed.length - 2; i >= 0; i--) {
    if (smoothed[i] < smoothed[i + 1]) {
      dataQualityWarning = true;
      smoothed[i] = smoothed[i + 1];
    }
  }

  const labels = ["Widget opened", "Started setup", "Setup complete", "Tried on", "Added to cart", "Purchased"];
  const keys = ["opens", "intro", "setup", "tryon", "cart", "purchase"];
  const stages = labels.map((label, i) => ({ key: keys[i], label, count: smoothed[i] }));

  let biggestLeak: SessionFunnel["biggestLeak"] = null;
  for (let i = 0; i < smoothed.length - 1; i++) {
    if (smoothed[i] < 3) continue; // ignore noise on tiny volumes
    const lostPct = Math.round(((smoothed[i] - smoothed[i + 1]) / smoothed[i]) * 100);
    if (!biggestLeak || lostPct > biggestLeak.lostPct) {
      biggestLeak = { fromLabel: labels[i], toLabel: labels[i + 1], lostPct };
    }
  }

  const bounced = sessions.filter(
    (s) =>
      s.opened &&
      !s.introClicked &&
      !s.modelSelected &&
      !s.uploadSuccess &&
      s.tryonCount === 0 &&
      s.cartCount === 0,
  ).length;

  return {
    stages,
    activationPct: opens > 0 ? Math.round((smoothed[2] / opens) * 100) : null,
    bouncePct: opens > 0 ? Math.round((bounced / opens) * 100) : null,
    biggestLeak,
    dataQualityWarning,
    uniqueOpens: opens,
    tryonToCartPct: smoothed[3] > 0 ? Math.round((smoothed[4] / smoothed[3]) * 100) : null,
  };
}

export interface PathStats {
  label: string;
  sessions: number;
  tryonPct: number | null;
  cartPct: number | null;
}

/** Model path vs Upload path performance. */
export function pathComparison(sessions: SessionInfo[]): PathStats[] {
  const stats = (label: string, list: SessionInfo[]): PathStats => ({
    label,
    sessions: list.length,
    tryonPct: list.length > 0 ? Math.round((list.filter((s) => s.tryonCount > 0).length / list.length) * 100) : null,
    cartPct: list.length > 0 ? Math.round((list.filter((s) => s.cartCount > 0).length / list.length) * 100) : null,
  });
  return [
    stats("Model path", sessions.filter((s) => s.modelSelected)),
    stats("Upload path", sessions.filter((s) => s.uploadSuccess && !s.modelSelected)),
  ];
}

export interface UploadFriction {
  starts: number;
  successes: number;
  failures: number;
  successPct: number | null;
  byDevice: Array<{ device: string; starts: number; successPct: number | null }>;
  topReasons: Array<{ reason: string; count: number }>;
}

export function uploadFriction(widgetEvents: WidgetEventRow[]): UploadFriction {
  const uploads = widgetEvents.filter((e) => e.event_type.startsWith("photo_upload_"));
  const starts = uploads.filter((e) => e.event_type === "photo_upload_start").length;
  const successes = uploads.filter((e) => e.event_type === "photo_upload_success").length;
  const failures = uploads.filter((e) => e.event_type === "photo_upload_fail").length;

  const devices = new Map<string, { starts: number; successes: number }>();
  for (const e of uploads) {
    const d = (e.device ?? "unknown").toLowerCase();
    const entry = devices.get(d) ?? { starts: 0, successes: 0 };
    if (e.event_type === "photo_upload_start") entry.starts += 1;
    if (e.event_type === "photo_upload_success") entry.successes += 1;
    devices.set(d, entry);
  }

  const reasons = new Map<string, number>();
  for (const e of uploads) {
    if (e.event_type !== "photo_upload_fail") continue;
    const r = e.reason ?? "unknown";
    reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }

  return {
    starts,
    successes,
    failures,
    successPct: starts > 0 ? Math.round((successes / starts) * 100) : null,
    byDevice: Array.from(devices.entries())
      .filter(([, v]) => v.starts > 0)
      .map(([device, v]) => ({
        device,
        starts: v.starts,
        successPct: v.starts > 0 ? Math.round((v.successes / v.starts) * 100) : null,
      }))
      .sort((a, b) => b.starts - a.starts),
    topReasons: Array.from(reasons.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3),
  };
}

export interface DeviceRow {
  device: string;
  opens: number;
  tryons: number;
  carts: number;
  cartPct: number | null;
}

export function deviceSplit(sessions: SessionInfo[]): DeviceRow[] {
  const byDevice = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    if (!s.opened) continue;
    const d = (s.device ?? "unknown").toLowerCase();
    const list = byDevice.get(d) ?? [];
    list.push(s);
    byDevice.set(d, list);
  }
  return Array.from(byDevice.entries())
    .map(([device, list]) => {
      const tried = list.filter((s) => s.tryonCount > 0).length;
      const carted = list.filter((s) => s.cartCount > 0).length;
      return {
        device,
        opens: list.length,
        tryons: tried,
        carts: carted,
        cartPct: tried > 0 ? Math.round((carted / tried) * 100) : null,
      };
    })
    .sort((a, b) => b.opens - a.opens);
}

export interface PageTypeRow {
  pageType: string;
  opens: number;
  tryons: number;
  carts: number;
}

export function pageInsights(sessions: SessionInfo[]): PageTypeRow[] {
  const byPage = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    if (!s.opened) continue;
    const p = s.pageType ?? "unknown";
    const list = byPage.get(p) ?? [];
    list.push(s);
    byPage.set(p, list);
  }
  return Array.from(byPage.entries())
    .map(([pageType, list]) => ({
      pageType,
      opens: list.length,
      tryons: list.filter((s) => s.tryonCount > 0).length,
      carts: list.filter((s) => s.cartCount > 0).length,
    }))
    .sort((a, b) => b.opens - a.opens);
}

export interface OnboardingCohort {
  firstTimeSessions: number;
  decided: number;
  setupComplete: number;
}

export function onboardingCohort(sessions: SessionInfo[]): OnboardingCohort {
  const ft = sessions.filter((s) => s.firstTime && s.opened);
  return {
    firstTimeSessions: ft.length,
    decided: ft.filter((s) => s.introClicked).length,
    setupComplete: ft.filter((s) => s.modelSelected || s.uploadSuccess).length,
  };
}

export interface EngagementStats {
  avgTryonsPerSession: number | null;
  multiTryPct: number | null;
  openToTryonPct: number | null;
}

export function engagementStats(sessions: SessionInfo[]): EngagementStats {
  const trySessions = sessions.filter((s) => s.tryonCount > 0);
  const opens = sessions.filter((s) => s.opened).length;
  const totalTryons = trySessions.reduce((a, s) => a + s.tryonCount, 0);
  return {
    avgTryonsPerSession:
      trySessions.length > 0 ? Math.round((totalTryons / trySessions.length) * 10) / 10 : null,
    multiTryPct:
      trySessions.length > 0
        ? Math.round((trySessions.filter((s) => s.tryonCount > 1).length / trySessions.length) * 100)
        : null,
    openToTryonPct: opens > 0 ? Math.round((trySessions.length / opens) * 100) : null,
  };
}

export interface RecentSession {
  id: string;
  lastAt: string;
  device: string | null;
  tryonCount: number;
  products: string[];
  outcome: "purchased" | "carted" | "tried" | "browsed";
  revenue: number;
}

export function recentSessions(sessions: SessionInfo[], limit = 8): RecentSession[] {
  return sessions
    .filter((s) => s.opened || s.tryonCount > 0)
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))
    .slice(0, limit)
    .map((s) => ({
      id: s.id,
      lastAt: s.lastAt,
      device: s.device,
      tryonCount: s.tryonCount,
      products: s.products.slice(0, 3),
      outcome: s.purchased ? "purchased" : s.cartCount > 0 ? "carted" : s.tryonCount > 0 ? "tried" : "browsed",
      revenue: s.revenue,
    }));
}

// ─── Insights (rule-based, plain English) ───────────────────────────────────

export function buildInsights(input: {
  funnel: SessionFunnel;
  friction: UploadFriction;
  devices: DeviceRow[];
  paths: PathStats[];
  preview: PreviewMetrics | null;
  misfits: Array<{ name: string }>;
}): Insight[] {
  const out: Insight[] = [];
  const { funnel, friction, paths, preview, misfits } = input;

  if (funnel.biggestLeak && funnel.biggestLeak.lostPct >= 50) {
    out.push({
      tone: "warning",
      title: `Biggest leak: ${funnel.biggestLeak.fromLabel} → ${funnel.biggestLeak.toLabel}`,
      body: `${funnel.biggestLeak.lostPct}% of shoppers drop off at this step. Focus improvements here first — it's where the most conversions are lost.`,
    });
  }

  const mobile = friction.byDevice.find((d) => d.device === "mobile");
  if (mobile && mobile.starts >= 5 && (mobile.successPct ?? 100) < 70) {
    out.push({
      tone: "critical",
      title: "Mobile photo uploads are struggling",
      body: `Only ${mobile.successPct}% of mobile uploads succeed. Most failures are "${friction.topReasons[0]?.reason ?? "unknown"}" — consider pointing shoppers to the model path on mobile.`,
    });
  } else if (friction.starts >= 5 && (friction.successPct ?? 100) < 75) {
    out.push({
      tone: "warning",
      title: "Photo upload success rate is low",
      body: `${friction.successPct}% of uploads succeed. Top failure reason: "${friction.topReasons[0]?.reason ?? "unknown"}".`,
    });
  }

  const [model, upload] = paths;
  if (model && upload && model.sessions >= 5 && upload.sessions >= 5) {
    const better = (model.cartPct ?? 0) >= (upload.cartPct ?? 0) ? model : upload;
    const worse = better === model ? upload : model;
    if ((better.cartPct ?? 0) >= (worse.cartPct ?? 0) + 15) {
      out.push({
        tone: "info",
        title: `${better.label} converts better`,
        body: `${better.label} sessions add to cart ${better.cartPct}% of the time vs ${worse.cartPct ?? 0}% for ${worse.label.toLowerCase()} sessions. Consider featuring that flow more prominently.`,
      });
    }
  }

  if (preview && preview.impressions >= 20) {
    const engagePct = Math.round((preview.engagements / preview.impressions) * 100);
    const dismissPct = Math.round((preview.dismissedForever / preview.impressions) * 100);
    if (dismissPct >= 30) {
      out.push({
        tone: "warning",
        title: "Preview popup is being dismissed often",
        body: `${dismissPct}% of shoppers dismiss the desktop preview permanently. Try a longer delay or the other theme in Widget Design.`,
      });
    } else if (engagePct >= 25) {
      out.push({
        tone: "success",
        title: "Preview popup is pulling its weight",
        body: `${engagePct}% of preview impressions turn into engagement. Keep it on.`,
      });
    }
  }

  if (misfits.length > 0) {
    out.push({
      tone: "warning",
      title: `${misfits.length} product${misfits.length === 1 ? "" : "s"} with high try-ons but low conversion`,
      body: `${misfits.slice(0, 3).map((m) => m.name).join(", ")}${misfits.length > 3 ? "…" : ""} — shoppers try ${misfits.length === 1 ? "it" : "these"} on but don't buy. Check sizing info and the try-on photo in Products.`,
    });
  }

  if (out.length === 0 && funnel.uniqueOpens > 0) {
    out.push({
      tone: "success",
      title: "No issues detected",
      body: "Your funnel looks healthy for this period. Check back as volume grows.",
    });
  }

  return out.slice(0, 4);
}

// ─── CSV export ─────────────────────────────────────────────────────────────

export function toCsv(headers: string[], rows: Array<Array<string | number | null>>): string {
  const escape = (v: string | number | null) => {
    let s = v == null ? "" : String(v);
    // Spreadsheet formula-injection guard: a cell starting with = + - @ (or a
    // tab/CR) executes as a formula in Excel/Sheets, and some exported fields
    // (product handles, page paths, entry sources) trace back to storefront
    // input. Prefix a single quote so it stays literal text.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((r) => r.map(escape).join(","))].join("\n");
}

export async function buildExportCsv(
  category: ExportCategory,
  slug: string,
  from: Date,
  to: Date,
): Promise<string> {
  const core = await fetchCoreEvents(slug, from, to);
  switch (category) {
    case "tryons":
      return toCsv(
        ["created_at", "session_id", "product_id", "success", "entry_source"],
        core.tryons.map((t) => [t.created_at, t.session_id, t.product_id, String(t.success ?? false), t.entry_source]),
      );
    case "widget_events":
      return toCsv(
        ["created_at", "event_type", "session_id", "device", "page_type", "is_first_time"],
        core.widgetEvents.map((e) => [
          e.created_at,
          e.event_type,
          e.session_id,
          e.device,
          e.page_type,
          e.is_first_time == null ? "" : String(e.is_first_time),
        ]),
      );
    case "cart_events":
      return toCsv(
        ["created_at", "session_id", "product_id"],
        core.carts.map((c) => [c.created_at, c.session_id, c.product_id]),
      );
    case "purchases":
      return toCsv(
        ["created_at", "session_id", "order_id", "total_price"],
        core.purchases.map((p) => [p.created_at, p.session_id, p.order_id, p.total_price]),
      );
    case "sessions": {
      const sessions = buildSessions(core);
      return toCsv(
        ["session_id", "first_at", "last_at", "device", "page_type", "first_time", "tryons", "cart_adds", "purchased", "revenue"],
        sessions.map((s) => [
          s.id,
          s.firstAt,
          s.lastAt,
          s.device,
          s.pageType,
          String(s.firstTime),
          s.tryonCount,
          s.cartCount,
          String(s.purchased),
          s.revenue,
        ]),
      );
    }
  }
}
