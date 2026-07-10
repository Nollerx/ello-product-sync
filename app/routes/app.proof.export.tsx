// Resource route: receipts CSV for the Proof page.
// NOTE: resource routes skip the parent app.tsx loader gates, so this MUST
// authenticate itself. Client-side must fetch() this (App Bridge patches fetch
// with the session token) — a plain <a href> would 401.

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getStoreContext } from "../lib/analytics.server";
import { getReceipts } from "../lib/ab-testing.server";

const RANGE_DAYS = 30;

function csvEscape(value: string): string {
  // Neutralize spreadsheet formula injection: product names / ids are
  // shopper-adjacent data, and Excel executes cells starting with = + - @.
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await getStoreContext(session.shop);
  if (!store.slug) {
    return new Response("Store not found", { status: 404 });
  }
  const to = new Date();
  const from = new Date(to.getTime() - RANGE_DAYS * 24 * 60 * 60 * 1000);
  const receipts = await getReceipts(store.slug, from, to, 500);

  const header = [
    "order_id",
    "product_id",
    "tried_on_at",
    "purchased_at",
    "hours_to_purchase",
    "order_value",
    "currency",
  ].join(",");
  const rows = receipts.map((r) =>
    [
      csvEscape(r.orderId ?? ""),
      csvEscape(r.productId ?? ""),
      r.triedOnAt,
      r.purchasedAt,
      (r.secondsToPurchase / 3600).toFixed(2),
      r.totalPrice.toFixed(2),
      r.currency ?? "",
    ].join(","),
  );
  const csv = [header, ...rows].join("\n");

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ello-proof-receipts.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
