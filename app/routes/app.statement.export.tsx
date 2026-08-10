// Resource route: the billing statement CSV — the itemized proof that backs an
// invoice. This is the file a client opens next to their Stripe bill, so every
// row is a real Shopify order they can look up, and the rows add up to the
// charged amount (a TOTAL row is emitted last so the tie-out is visible without
// selecting the column).
//
// NOTE: resource routes skip the parent app.tsx loader gates, so this MUST
// authenticate itself. Client-side must fetch() this (App Bridge patches fetch
// with the session token) — a plain <a href> would 401.

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getStoreContext,
  getShopTimezone,
  getBillingStatement,
  getInvoice,
} from "../lib/analytics.server";
import { resolveBillingPeriod } from "../lib/billing-period";

function csvEscape(value: string): string {
  // Neutralize spreadsheet formula injection: product names are shopper-adjacent
  // data, and Excel executes cells starting with = + - @.
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** "2026-07-28 22:50 CDT" — the merchant matches this against Shopify admin,
 *  which shows their local time, so local with an explicit zone beats UTC. */
function localStamp(iso: string, timeZone: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const store = await getStoreContext(session.shop);
  if (!store.slug) {
    return new Response("Store not found", { status: 404 });
  }

  const tz = await getShopTimezone(admin, session.shop);
  const url = new URL(request.url);
  const period = resolveBillingPeriod(url.searchParams.get("month"), tz);

  const [lines, invoice] = await Promise.all([
    getBillingStatement(store.slug, period.from, period.to),
    getInvoice(store.slug, period.from, period.to),
  ]);

  const header = [
    "shopify_order_id",
    "product_tried_on",
    "tried_on_at",
    "purchased_at",
    "hours_from_tryon_to_purchase",
    "attributed_revenue",
    "refunded",
    "net_attributed",
    "free_trial",
    "billed_on",
    "currency",
  ].join(",");

  const rows = lines.map((l) =>
    [
      csvEscape(l.orderId ?? ""),
      // Fall back to the raw id so a row is never blank — an unnamed line is
      // still auditable, just less readable.
      csvEscape(l.productName ?? (l.productId ? `Product ${l.productId}` : "")),
      csvEscape(localStamp(l.triedOnAt, tz)),
      csvEscape(localStamp(l.purchasedAt, tz)),
      l.hoursToPurchase.toFixed(2),
      l.attributedRevenue.toFixed(2),
      l.refundedAmount.toFixed(2),
      l.netAttributed.toFixed(2),
      l.inTrial ? "yes" : "no",
      l.billableNet.toFixed(2),
      csvEscape(l.currency ?? ""),
    ].join(","),
  );

  // Trailing total, so the client can see the lines tie to the invoice without
  // having to sum the column themselves.
  const currency = invoice?.currency ?? lines.find((l) => l.currency)?.currency ?? "";
  const orders = invoice?.ordersCount ?? new Set(lines.map((l) => l.orderId).filter(Boolean)).size;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const totalRow = [
    csvEscape(`TOTAL (${lines.length} sales across ${orders} orders)`),
    "",
    "",
    "",
    "",
    (invoice?.grossAttributed ?? round2(lines.reduce((s, l) => s + l.attributedRevenue, 0))).toFixed(2),
    (invoice?.refunded ?? round2(lines.reduce((s, l) => s + l.refundedAmount, 0))).toFixed(2),
    (invoice?.netAttributed ?? round2(lines.reduce((s, l) => s + l.netAttributed, 0))).toFixed(2),
    "",
    (invoice?.billableNet ?? round2(lines.reduce((s, l) => s + l.billableNet, 0))).toFixed(2),
    csvEscape(currency),
  ].join(",");

  const csv = [header, ...rows, totalRow].join("\n");

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ello-statement-${period.key}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
