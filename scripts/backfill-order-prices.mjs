#!/usr/bin/env node
/**
 * Backfill real per-line prices + order subtotals onto purchase_events rows
 * that predate the pixel's line_price capture (2026-07-23) or landed without
 * a subtotal_price.
 *
 * WHY: legacy rows carry only {product_id, variant_id, quantity} per line and
 * a total_price that INCLUDES shipping and taxes — so Qualified Revenue for
 * them prorates a gross number, which the Qualified-Revenue definition
 * explicitly forbids ("never shipping, never taxes"). The app has read_orders,
 * so the truth is one Admin API call away.
 *
 * SELF-VALIDATING RECONCILIATION: Shopify's Admin line-item price semantics
 * (does discountedTotal include order-level code allocations or not?) have
 * drifted across API versions, so instead of trusting one reading, each order
 * is solved against its own subtotal. Working in integer cents, pick the first
 * formula whose line sum reconciles to subtotalPrice (tolerance 2¢ + 1¢/line):
 *
 *   A: Σ discountedTotal            == subtotal → line_price=discountedTotal, line_discount=0
 *   B: Σ (discountedTotal − alloc)  == subtotal → line_price=discountedTotal, line_discount=alloc
 *   C: Σ (originalTotal   − alloc)  == subtotal → line_price=originalTotal,   line_discount=alloc
 *
 * where alloc = Σ discountAllocations for the line. All three land the SQL
 * basis cascade (20260731_qualified_revenue_discount_netting.sql) in its
 * exact 'line_alloc' branch, because Σ(line_price − line_discount) equals
 * subtotal BY CONSTRUCTION. Unreconcilable orders get subtotal_price only —
 * the cascade then prorates against real merchandise value instead of the
 * ship/tax-inflated total (still a strict upgrade).
 *
 * Non-destructive: existing line keys are preserved; matched lines gain
 * line_price / line_discount / price_source:'admin_backfill'. Idempotent:
 * candidates are rows with subtotal_price IS NULL, which the write itself
 * clears. Orders deleted in Shopify are skipped and counted.
 *
 * Usage:
 *   node scripts/backfill-order-prices.mjs --store=ecmxv0-vh           # dry run
 *   node scripts/backfill-order-prices.mjs --store=ecmxv0-vh --write   # apply
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_VERSION = "2025-01";
const BATCH = 25;

function loadEnv() {
  const env = {};
  for (const line of readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=("?)(.*)\2\s*$/);
    if (m) env[m[1]] = m[3];
  }
  return env;
}

function argVal(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : null;
}

const STORE = argVal("store") || "ecmxv0-vh";
const WRITE = process.argv.includes("--write");
const env = loadEnv();
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const cents = (s) => Math.round(parseFloat(s) * 100);
const tail = (v) => (v == null ? null : String(v).split("/").pop() || null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeShop(domain) {
  let d = domain || "";
  if (!d.includes(".")) d = `${d}.myshopify.com`;
  else if (!d.includes("myshopify.com")) d = `${d.replace(/\.(com|net|org|shop)$/, "")}.myshopify.com`;
  return d;
}

function reconcile(order) {
  const sub = cents(order.subtotalPriceSet.shopMoney.amount);
  const lines = order.lineItems.nodes.map((n) => ({
    pid: tail(n.product?.id),
    vid: tail(n.variant?.id),
    qty: n.quantity ?? 1,
    orig: cents(n.originalTotalSet.shopMoney.amount),
    disc: cents(n.discountedTotalSet.shopMoney.amount),
    alloc: (n.discountAllocations || []).reduce(
      (s, a) => s + cents(a.allocatedAmountSet.shopMoney.amount),
      0,
    ),
  }));
  const sum = (f) => lines.reduce((s, l) => s + f(l), 0);
  const tol = 2 + lines.length;
  if (Math.abs(sum((l) => l.disc) - sub) <= tol)
    return { mode: "A", sub, lines: lines.map((l) => ({ ...l, price: l.disc, discount: 0 })) };
  if (Math.abs(sum((l) => l.disc - l.alloc) - sub) <= tol)
    return { mode: "B", sub, lines: lines.map((l) => ({ ...l, price: l.disc, discount: l.alloc })) };
  if (Math.abs(sum((l) => l.orig - l.alloc) - sub) <= tol)
    return { mode: "C", sub, lines: lines.map((l) => ({ ...l, price: l.orig, discount: l.alloc })) };
  return { mode: "unreconciled", sub, lines: null };
}

// Match admin lines onto the stored pixel lines: variant id first, then
// product id; consume each admin line once so duplicate-variant orders
// resolve positionally.
function merge(storedItems, recLines) {
  const remaining = recLines.slice();
  let matched = 0;
  const items = storedItems.map((it) => {
    const pv = tail(it.variant_id);
    const pp = tail(it.product_id);
    let idx = remaining.findIndex((l) => l.vid && pv && l.vid === pv);
    if (idx < 0) idx = remaining.findIndex((l) => l.pid && pp && l.pid === pp);
    if (idx < 0) return it;
    const l = remaining.splice(idx, 1)[0];
    matched++;
    return {
      ...it,
      line_price: l.price / 100,
      line_discount: l.discount / 100,
      price_source: "admin_backfill",
    };
  });
  return { items, matched, unmatchedStored: storedItems.length - matched, unmatchedAdmin: remaining.length };
}

async function main() {
  console.log(`[backfill] store=${STORE} mode=${WRITE ? "WRITE" : "dry-run"}`);

  const { data: store, error: storeErr } = await supabase
    .from("vto_stores").select("shop_domain").eq("store_slug", STORE).maybeSingle();
  if (storeErr || !store) throw new Error(`store lookup failed: ${storeErr?.message || "not found"}`);
  const shop = normalizeShop(store.shop_domain);

  const { data: sessions, error: sessErr } = await supabase
    .from("shopify_sessions").select("id, access_token, scope")
    .eq("shop", shop).eq("is_online", false)
    .order("updated_at", { ascending: false }).limit(1);
  if (sessErr || !sessions?.length || !sessions[0].access_token)
    throw new Error(`no offline session for ${shop}: ${sessErr?.message || "none stored"}`);
  const token = sessions[0].access_token;
  if (!/read_orders/.test(sessions[0].scope || ""))
    console.warn(`[backfill] WARNING: session scope lacks read_orders (${sessions[0].scope}) — expect access errors until re-auth.`);

  const { data: rows, error: rowsErr } = await supabase
    .from("purchase_events")
    .select("id, order_id, total_price, subtotal_price, line_items, created_at")
    .eq("store_slug", STORE).is("subtotal_price", null).not("order_id", "is", null)
    .order("created_at", { ascending: true }).limit(2000);
  if (rowsErr) throw new Error(`candidate query failed: ${rowsErr.message}`);
  console.log(`[backfill] ${rows.length} candidate rows (subtotal_price IS NULL)`);

  const stats = { A: 0, B: 0, C: 0, unreconciled: 0, missing: 0, updated: 0, totalMismatch: 0 };
  const unreconciledIds = [];

  const QUERY = `query($ids:[ID!]!){ nodes(ids:$ids){ ... on Order {
    id
    subtotalPriceSet{shopMoney{amount}}
    totalPriceSet{shopMoney{amount}}
    lineItems(first:100){nodes{
      quantity
      product{id}
      variant{id}
      originalTotalSet{shopMoney{amount}}
      discountedTotalSet{shopMoney{amount}}
      discountAllocations{allocatedAmountSet{shopMoney{amount}}}
    }}
  }}}`;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const ids = batch.map((r) => `gid://shopify/Order/${r.order_id}`);
    const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query: QUERY, variables: { ids } }),
    });
    if (!res.ok) throw new Error(`Admin GraphQL HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    if (json.errors) throw new Error(`Admin GraphQL errors: ${JSON.stringify(json.errors).slice(0, 500)}`);

    const byId = new Map();
    for (const node of json.data.nodes) if (node?.id) byId.set(tail(node.id), node);

    for (const row of batch) {
      const order = byId.get(String(row.order_id));
      if (!order) { stats.missing++; continue; }

      const rec = reconcile(order);
      stats[rec.mode]++;
      if (rec.mode === "unreconciled") unreconciledIds.push(row.order_id);

      const adminTotal = cents(order.totalPriceSet.shopMoney.amount);
      if (row.total_price != null && Math.abs(cents(String(row.total_price)) - adminTotal) > 1) {
        stats.totalMismatch++;
        console.warn(`[backfill] order ${row.order_id}: stored total ${row.total_price} != admin ${adminTotal / 100}`);
      }

      const update = { subtotal_price: rec.sub / 100 };
      let mergeInfo = null;
      if (rec.lines) {
        mergeInfo = merge(Array.isArray(row.line_items) ? row.line_items : [], rec.lines);
        update.line_items = mergeInfo.items;
        if (mergeInfo.unmatchedStored || mergeInfo.unmatchedAdmin) {
          console.warn(`[backfill] order ${row.order_id}: ${mergeInfo.matched} matched, ${mergeInfo.unmatchedStored} stored / ${mergeInfo.unmatchedAdmin} admin lines unmatched`);
        }
      }

      if (WRITE) {
        const { error: upErr } = await supabase.from("purchase_events").update(update).eq("id", row.id);
        if (upErr) throw new Error(`update ${row.order_id} failed: ${upErr.message}`);
        stats.updated++;
      }
    }
    process.stdout.write(`\r[backfill] ${Math.min(i + BATCH, rows.length)}/${rows.length} orders processed`);
    await sleep(300);
  }

  console.log(`\n[backfill] done: ${JSON.stringify(stats)}`);
  if (unreconciledIds.length) console.log(`[backfill] unreconciled orders (subtotal-only backfill): ${unreconciledIds.join(", ")}`);
  if (!WRITE) console.log("[backfill] DRY RUN — nothing written. Re-run with --write to apply.");
}

main().catch((e) => { console.error(`[backfill] FAILED: ${e.message}`); process.exit(1); });
