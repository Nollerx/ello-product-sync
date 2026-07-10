import { type LoaderFunctionArgs } from "react-router";
import { supabaseAdmin } from "../lib/supabase.server";

// CORS for cross-origin widget loads (storefronts on merchant domains).
// If-None-Match included so browsers/CDNs can do conditional revalidation.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
};

const CACHE_HEADERS =
  "public, max-age=30, s-maxage=30, stale-while-revalidate=300";

// Mirror widget-main.js:238 — keep field shape identical to what the widget
// already expects in sampleClothing[i] so populateFeaturedAndQuickPicks works
// without modification.
const CLOTHING_SELECT_COLUMNS =
  "id,item_id,name,price,category,tags,color,image_url,product_url,data_source,active,shopify_product_id,variants";

/**
 * GET /api/widget-preview?shop=<domain>&handle=<current-pdp-handle>
 *
 * Returns a small payload of fully-formed product objects (featured item +
 * quick picks + current PDP product) so the widget can render its initial
 * "ready to try on" view instantly without first downloading the full
 * catalog.
 *
 * The widget reads `vto_stores.featured_item_id` and `quick_picks_ids` from
 * the bootstrap response and passes them to this endpoint, OR omits them and
 * lets this endpoint resolve them server-side from vto_stores. Either path
 * works; the client uses whatever is more convenient.
 *
 * Branches on `vto_stores.clothing_population_type`:
 *   - "supabase": SELECT * FROM clothing_items WHERE item_id IN (ids)
 *   - "shopify"  (default): single Shopify Storefront GraphQL request using
 *     query aliases — fetches each needed product by either id or handle in
 *     one round trip, then transforms to the widget's expected shape.
 *
 * Caching mirrors api.widget-config-resolved.tsx (ETag conditional GET +
 * max-age=30 + stale-while-revalidate=300). Version derived the same way as
 * api.catalog-handles for consistent invalidation.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const storeSlug = url.searchParams.get("store_slug");
  const currentHandle = url.searchParams.get("handle");

  if (!shop && !storeSlug) {
    return jsonError(400, "Missing 'shop' or 'store_slug' query parameter");
  }

  // `shop` is interpolated into a PostgREST .or() filter — reject anything
  // outside the legit shop-domain/slug charset so a comma/paren can't inject
  // extra filter terms. (storeSlug is used only via .eq(), parameterized.)
  if (shop && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(shop)) {
    return jsonError(400, "Invalid 'shop' parameter");
  }

  try {
    // 1. Resolve store config (includes featured_item_id + quick_picks_ids).
    const storeQuery = supabaseAdmin
      .from("vto_stores")
      .select(
        "store_slug, shop_domain, storefront_token, clothing_population_type, config_version, featured_item_id, quick_picks_ids",
      );

    const { data: storeData, error: storeError } = shop
      ? await storeQuery
          .or(`shop_domain.eq.${shop},store_slug.eq.${shop}`)
          .maybeSingle()
      : await storeQuery.eq("store_slug", storeSlug!).maybeSingle();

    if (storeError) {
      console.error("[widget-preview] Store fetch error:", storeError.message);
      return jsonError(500, storeError.message);
    }

    if (!storeData) {
      return new Response(
        JSON.stringify({
          featured: null,
          quickPicks: [],
          currentProduct: null,
          version: "0",
        }),
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

    const slug = storeData.store_slug as string;
    const populationType = storeData.clothing_population_type as
      | string
      | null;
    const featuredId =
      (storeData.featured_item_id as string | null) || null;
    const quickPicksIds =
      (storeData.quick_picks_ids as string[] | null) || [];

    // 2. Compute version (same logic as api.catalog-handles).
    const { data: latestRow } = await supabaseAdmin
      .from("clothing_items")
      .select("updated_at")
      .eq("store_id", slug)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const latestItemMs = latestRow?.updated_at
      ? new Date(latestRow.updated_at).getTime()
      : 0;
    const configVersion = Number(storeData.config_version) || 0;
    const version = String(Math.max(latestItemMs, configVersion));
    const etag = `"v${version}"`;

    // 3. Conditional GET.
    const ifNoneMatch = request.headers.get("If-None-Match");
    if (ifNoneMatch === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          "Cache-Control": CACHE_HEADERS,
          ...CORS,
        },
      });
    }

    // 4. Resolve products by mode.
    let featured: WidgetProduct | null = null;
    let quickPicks: WidgetProduct[] = [];
    let currentProduct: WidgetProduct | null = null;

    if (populationType === "supabase") {
      const result = await resolveSupabasePreview(
        slug,
        featuredId,
        quickPicksIds,
        currentHandle,
      );
      featured = result.featured;
      quickPicks = result.quickPicks;
      currentProduct = result.currentProduct;
    } else {
      const result = await resolveShopifyPreview(
        storeData.shop_domain as string | null,
        storeData.storefront_token as string | null,
        featuredId,
        quickPicksIds,
        currentHandle,
      );
      featured = result.featured;
      quickPicks = result.quickPicks;
      currentProduct = result.currentProduct;
    }

    return new Response(
      JSON.stringify({ featured, quickPicks, currentProduct, version }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": CACHE_HEADERS,
          ETag: etag,
          ...CORS,
        },
      },
    );
  } catch (err) {
    console.error("[widget-preview] Exception:", err);
    return jsonError(500, String(err));
  }
}

// ─── Widget product shape ───────────────────────────────────────────────────
// Matches the object shape that widget-main.js builds and stores in
// sampleClothing[] — see loadClothingFromShopify line 901 + loadClothingFromSupabase
// + processClothingRows. The widget's existing functions (findClothingByRobustId,
// detectCurrentProduct, populateFeaturedAndQuickPicks) read these fields, so we
// preserve them exactly.

interface WidgetProduct {
  id: string;
  name: string;
  price: number;
  category: string;
  tags: string[];
  color: string | null;
  image_url: string;
  product_url: string;
  shopify_product_id: string | null;
  shopify_product_gid: string | null;
  data_source: "shopify" | "supabase";
  variants: Array<{
    id: string | null;
    shopify_variant_gid: string | null;
    title: string;
    price: number;
    available: boolean;
    size: string | null;
    color: string | null;
    option3: string | null;
  }>;
}

// ─── Supabase-mode resolver ─────────────────────────────────────────────────

async function resolveSupabasePreview(
  slug: string,
  featuredId: string | null,
  quickPicksIds: string[],
  currentHandle: string | null,
): Promise<{
  featured: WidgetProduct | null;
  quickPicks: WidgetProduct[];
  currentProduct: WidgetProduct | null;
}> {
  const ids = [featuredId, ...quickPicksIds, currentHandle].filter(
    // Boolean AND safe-charset: these are joined into a PostgREST .in.(…)
    // filter below, and currentHandle is attacker-controlled. GIDs/numeric
    // ids/handles only ever use [A-Za-z0-9._:/-]; a value with a comma or
    // paren would inject filter terms, so drop it.
    (v): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(v),
  );
  if (ids.length === 0) {
    return { featured: null, quickPicks: [], currentProduct: null };
  }

  // Match by item_id OR id (legacy rows may use either column). Treat
  // active=null as enabled (matches legacy widget-main.js:1441 semantics).
  // Only active=false explicitly excludes a product.
  const { data, error } = await supabaseAdmin
    .from("clothing_items")
    .select(CLOTHING_SELECT_COLUMNS)
    .eq("store_id", slug)
    .not("active", "is", false)
    .or(`item_id.in.(${ids.join(",")}),id.in.(${ids.join(",")})`);

  if (error) {
    console.error(
      "[widget-preview] Supabase preview query error:",
      error.message,
    );
    return { featured: null, quickPicks: [], currentProduct: null };
  }

  const rows = (data || []) as Array<Record<string, unknown>>;
  const findRow = (target: string | null): WidgetProduct | null => {
    if (!target) return null;
    const row = rows.find(
      (r) =>
        String(r.item_id ?? "") === target || String(r.id ?? "") === target,
    );
    return row ? supabaseRowToWidgetProduct(row) : null;
  };

  return {
    featured: findRow(featuredId),
    quickPicks: quickPicksIds
      .map((id) => findRow(id))
      .filter((p): p is WidgetProduct => p !== null),
    currentProduct: findRow(currentHandle),
  };
}

function supabaseRowToWidgetProduct(
  row: Record<string, unknown>,
): WidgetProduct {
  // Supabase clothing_items rows already store data in the widget's expected
  // shape — see processClothingRows in widget-main.js. We pass through fields
  // directly, only normalizing types where the row may be sloppy.
  const variants = Array.isArray(row.variants)
    ? (row.variants as Array<Record<string, unknown>>).map((v) => ({
        id: v.id != null ? String(v.id) : null,
        shopify_variant_gid:
          v.shopify_variant_gid != null ? String(v.shopify_variant_gid) : null,
        title: String(v.title ?? ""),
        price: Number(v.price ?? 0),
        available: Boolean(v.available),
        size: v.size != null ? String(v.size) : null,
        color: v.color != null ? String(v.color) : null,
        option3: v.option3 != null ? String(v.option3) : null,
      }))
    : [];

  return {
    id: String(row.id ?? row.item_id ?? ""),
    name: String(row.name ?? ""),
    price: Number(row.price ?? 0),
    category: String(row.category ?? "clothing"),
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    color: row.color != null ? String(row.color) : null,
    image_url: String(row.image_url ?? ""),
    product_url: String(row.product_url ?? ""),
    shopify_product_id:
      row.shopify_product_id != null ? String(row.shopify_product_id) : null,
    shopify_product_gid:
      row.shopify_product_id != null
        ? `gid://shopify/Product/${row.shopify_product_id}`
        : null,
    data_source: "supabase",
    variants,
  };
}

// ─── Shopify-mode resolver ──────────────────────────────────────────────────

async function resolveShopifyPreview(
  shopDomain: string | null,
  storefrontToken: string | null,
  featuredId: string | null,
  quickPicksIds: string[],
  currentHandle: string | null,
): Promise<{
  featured: WidgetProduct | null;
  quickPicks: WidgetProduct[];
  currentProduct: WidgetProduct | null;
}> {
  if (!shopDomain || !storefrontToken) {
    return { featured: null, quickPicks: [], currentProduct: null };
  }

  const normalized = normalizeShopDomain(shopDomain);
  const endpoint = `https://${normalized}/api/2024-01/graphql.json`;

  // Build a single GraphQL request using aliases — one round trip for all
  // needed products. Each alias is keyed so we can map back after.
  const aliases: Array<{ alias: string; query: string }> = [];

  const featuredAlias =
    featuredId !== null ? makeAlias("featured", featuredId) : null;
  if (featuredAlias) aliases.push(featuredAlias);

  quickPicksIds.forEach((id, idx) => {
    if (id != null && id !== "") {
      const qpAlias = makeAlias(`qp_${idx}`, id);
      if (qpAlias) aliases.push(qpAlias);
    }
  });

  const currentAlias =
    currentHandle !== null && currentHandle !== ""
      ? makeAlias("current", currentHandle)
      : null;
  if (currentAlias) aliases.push(currentAlias);

  if (aliases.length === 0) {
    return { featured: null, quickPicks: [], currentProduct: null };
  }

  const queryBody = aliases.map((a) => a.query).join("\n");
  const fullQuery = `query Preview {\n${queryBody}\n}\n${PRODUCT_FRAGMENT}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": storefrontToken,
    },
    body: JSON.stringify({ query: fullQuery }),
  });

  if (!res.ok) {
    console.error(`[widget-preview] Shopify GraphQL ${res.status}`);
    return { featured: null, quickPicks: [], currentProduct: null };
  }

  const json: {
    data?: Record<string, ShopifyProductNode | null>;
    errors?: unknown;
  } = await res.json();

  if (json.errors) {
    console.error("[widget-preview] Shopify GraphQL errors:", json.errors);
  }

  const data = json.data || {};
  const toWidget = (node: ShopifyProductNode | null | undefined) =>
    node ? shopifyNodeToWidgetProduct(node, normalized) : null;

  const featured = toWidget(data.featured);
  const currentProduct = toWidget(data.current);
  const quickPicks = quickPicksIds
    .map((_, idx) => toWidget(data[`qp_${idx}`]))
    .filter((p): p is WidgetProduct => p !== null);

  return { featured, quickPicks, currentProduct };
}

// Build a GraphQL alias for either a GID, numeric id, or handle.
// - GID         → product(id: "gid://shopify/Product/123") { ...ProductFields }
// - numeric "123" → product(id: "gid://shopify/Product/123") { ...ProductFields }
// - "blue-dress"  → productByHandle(handle: "blue-dress") { ...ProductFields }
//
// SECURITY: `currentHandle` comes straight off the storefront URL, so rawId is
// attacker-controlled. The value is (a) validated against the exact shape it's
// supposed to be — anything else is rejected (returns null) rather than
// interpolated — and (b) emitted through JSON.stringify, which produces a fully
// escaped GraphQL string literal (backslashes, quotes, control chars and all).
// The old code escaped only `"`, so an input containing `\"` collapsed to `\\"`
// and broke out of the string → GraphQL injection into the merchant's
// Storefront API.
function makeAlias(
  alias: string,
  rawId: string,
): { alias: string; query: string } | null {
  // Full GID form: gid://shopify/Product/<digits>
  if (/^gid:\/\/shopify\/Product\/\d+$/.test(rawId)) {
    return {
      alias,
      query: `${alias}: product(id: ${JSON.stringify(rawId)}) { ...ProductFields }`,
    };
  }

  // Bare numeric id → wrap into a GID.
  if (/^\d+$/.test(rawId)) {
    return {
      alias,
      query: `${alias}: product(id: ${JSON.stringify(`gid://shopify/Product/${rawId}`)}) { ...ProductFields }`,
    };
  }

  // Shopify product handle: lowercase alphanumerics + hyphens (be lenient on
  // case/underscore). Reject anything outside this charset — never interpolate
  // unexpected input into the query.
  if (/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(rawId)) {
    return {
      alias,
      query: `${alias}: productByHandle(handle: ${JSON.stringify(rawId)}) { ...ProductFields }`,
    };
  }

  return null;
}

const PRODUCT_FRAGMENT = `fragment ProductFields on Product {
  id
  title
  handle
  productType
  tags
  images(first: 5) { edges { node { url } } }
  variants(first: 100) {
    edges {
      node {
        id
        price { amount }
        title
        availableForSale
        selectedOptions { name value }
      }
    }
  }
}`;

interface ShopifyProductNode {
  id?: string;
  title?: string;
  handle?: string;
  productType?: string;
  tags?: string[];
  images?: { edges?: Array<{ node?: { url?: string } }> };
  variants?: {
    edges?: Array<{
      node?: {
        id?: string;
        price?: { amount?: string };
        title?: string;
        availableForSale?: boolean;
        selectedOptions?: Array<{ name?: string; value?: string }>;
      };
    }>;
  };
}

// Mirror widget-main.js convertGraphQLProductToShopifyFormat (line 649) +
// the second-stage conversion at line 891. Output matches sampleClothing shape.
function shopifyNodeToWidgetProduct(
  node: ShopifyProductNode,
  shopDomain: string,
): WidgetProduct {
  const extractNumericId = (gid?: string): string | null => {
    if (!gid) return null;
    const parts = gid.split("/");
    return parts[parts.length - 1] || null;
  };

  const variants = (node.variants?.edges || []).map((edge) => {
    const v = edge.node || {};
    const opts = v.selectedOptions || [];
    return {
      id: extractNumericId(v.id),
      shopify_variant_gid: v.id || null,
      title: v.title || "",
      price: v.price?.amount ? parseFloat(v.price.amount) : 0,
      available: Boolean(v.availableForSale),
      size: opts[0]?.value ?? null,
      color: opts[1]?.value ?? null,
      option3: opts[2]?.value ?? null,
    };
  });

  const firstImage = node.images?.edges?.[0]?.node?.url || "";
  const firstVariant = variants[0];
  const handle = node.handle || "";

  return {
    id: handle,
    name: node.title || "",
    price: firstVariant?.price ?? 0,
    category: (node.productType || "clothing").toLowerCase(),
    tags: node.tags || [],
    // Color isn't directly on the Shopify product — widget-main.js derives it
    // via getColorFromProduct (line 1552). For the preview shape we leave it
    // null; populateFeaturedAndQuickPicks doesn't depend on it.
    color: null,
    image_url: firstImage,
    product_url: `https://${shopDomain}/products/${handle}`,
    shopify_product_id: extractNumericId(node.id),
    shopify_product_gid: node.id || null,
    data_source: "shopify",
    variants,
  };
}

function normalizeShopDomain(shopDomain: string): string {
  // Mirror widget-main.js:723-728.
  let normalized = shopDomain;
  if (!normalized.includes(".")) {
    normalized = `${normalized}.myshopify.com`;
  } else if (!normalized.includes("myshopify.com")) {
    normalized = `${normalized.replace(/\.(com|net|org)$/, "")}.myshopify.com`;
  }
  return normalized;
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...CORS,
    },
  });
}
