import { type LoaderFunctionArgs } from "react-router";
import { supabaseAdmin } from "../lib/supabase.server";

// CORS for cross-origin widget loads (storefronts on merchant domains).
// If-None-Match included so browsers/CDNs can do conditional revalidation.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
};

/**
 * GET /api/widget-config-resolved?shop=<domain>  (or ?store_slug=<slug>)
 *
 * Server-side proxy to the get_widget_config Supabase RPC. Wraps the response
 * with cache-friendly headers so the browser (and any future CDN) can serve
 * repeat reads without re-hitting Supabase.
 *
 * Caching strategy:
 *   - max-age=30: browsers serve cached response for 30s with no network call.
 *   - stale-while-revalidate=300: after 30s, browsers serve stale immediately
 *     AND fetch fresh in background. Visitor never waits.
 *   - ETag: "v<config_version>" lets browsers/CDNs do conditional revalidation.
 *
 * Merchant-feedback path: a BEFORE UPDATE trigger on vto_stores bumps
 * config_version on every widget setting change, so the next non-cached
 * response automatically reflects the change. The widget loader pairs this
 * with localStorage + reload detection for instant merchant feedback.
 *
 * On cache-bust (?_t=<ts>): bypasses browser cache via the new URL. Used by
 * the widget loader when it detects a page reload or `?ello_preview=1`.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const storeSlug = url.searchParams.get("store_slug");

  if (!shop && !storeSlug) {
    return new Response(
      JSON.stringify({ error: "Missing 'shop' or 'store_slug' query parameter" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS },
      },
    );
  }

  try {
    const { data, error } = await supabaseAdmin.rpc("get_widget_config", {
      p_store_slug: storeSlug || null,
      p_shop_domain: shop || null,
    });

    if (error) {
      console.error("[widget-config-resolved] RPC error:", error.message);
      return new Response(
        JSON.stringify({ error: error.message }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            // Don't cache errors — caller should retry on next pageview.
            "Cache-Control": "no-store",
            ...CORS,
          },
        },
      );
    }

    const row = Array.isArray(data) && data.length > 0 ? data[0] : null;

    if (!row) {
      // Store not found. Return empty result so widget falls back to defaults.
      // Cache briefly to avoid hammering DB if a misconfigured storefront
      // keeps requesting a non-existent slug.
      return new Response(
        JSON.stringify({ config: null, version: 0 }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=60, s-maxage=60",
            ...CORS,
          },
        },
      );
    }

    const version = Number(row.config_version) || 0;
    const etag = `"v${version}"`;

    // Conditional GET: if client has matching ETag, return 304 — saves payload.
    const ifNoneMatch = request.headers.get("If-None-Match");
    if (ifNoneMatch === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          "Cache-Control": "public, max-age=30, s-maxage=30, stale-while-revalidate=300",
          ...CORS,
        },
      });
    }

    return new Response(
      JSON.stringify({ config: row, version }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=30, s-maxage=30, stale-while-revalidate=300",
          ETag: etag,
          ...CORS,
        },
      },
    );
  } catch (err) {
    console.error("[widget-config-resolved] Exception:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          ...CORS,
        },
      },
    );
  }
}
