// Resource route: /app/analytics/export?category=tryons&range=30d
// Streams a CSV of raw analytics for the selected window. Fetched client-side
// (App Bridge attaches the session token), then blob-downloaded.

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getStoreContext, buildExportCsv } from "../lib/analytics.server";
import { EXPORT_CATEGORIES, type ExportCategory } from "../lib/analytics-shared";
import { parseRange, rangeWindow } from "../lib/timerange";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const category = url.searchParams.get("category") as ExportCategory | null;
  if (!category || !EXPORT_CATEGORIES.some((c) => c.key === category)) {
    return new Response("Unknown export category", { status: 400 });
  }

  const store = await getStoreContext(session.shop);
  if (!store.slug) {
    return new Response("Store not connected yet", { status: 404 });
  }

  const range = parseRange(url.searchParams.get("range"));
  const win = rangeWindow(range);
  const csv = await buildExportCsv(category, store.slug, win.from, win.to);

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ello-${category}-${range}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
