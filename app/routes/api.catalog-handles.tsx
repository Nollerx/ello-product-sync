import { type LoaderFunctionArgs } from "react-router";
import { supabaseAdmin } from "../lib/supabase.server";
import { createVersionedCache } from "../lib/widget-cache.server";

// Per-instance cache of the resolved handles list, keyed by store + version.
// Eliminates the multi-page Shopify crawl for every cache-missing shopper during a
// spike. Safety net (default 5 min) forces a rebuild even if a webhook is dropped.
const CATALOG_STALE_MS = Number(process.env.CATALOG_CACHE_STALE_MS || 300_000);
const catalogCache = createVersionedCache<string[]>(CATALOG_STALE_MS);

// CORS for cross-origin widget loads (storefronts on merchant domains).
// If-None-Match included so browsers/CDNs can do conditional revalidation.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
};

const CACHE_HEADERS =
  "public, max-age=30, s-maxage=30, stale-while-revalidate=300";

/**
 * GET /api/catalog-handles?shop=<domain>   (or ?store_slug=<slug>)
 *
 * Returns the list of enabled product handles for a merchant's try-on catalog.
 * Powers the inline-button gate, smart-visibility, and wardrobe re-matching
 * without forcing every shopper to download the full product catalog on page
 * load.
 *
 * Replaces the previous behavior where `widget-main.js` fetched the entire
 * Shopify GraphQL catalog (~2.5 MB Brotli for a 1,600-product store) on every
 * page view just to answer "is this product enabled?". Now the widget calls
 * THIS endpoint instead — a 10–30 KB handles list, server-side paginated,
 * CDN-cacheable.
 *
 * Branches on `vto_stores.clothing_population_type`:
 *   - "supabase": query `clothing_items` where active=true
 *   - "shopify"  (default): paginate Shopify Storefront GraphQL with a
 *     handles-only query, then exclude handles whose product id is marked
 *     active=false in `clothing_items` (merchant disable overrides)
 *
 * Both modes return the same JSON shape so the widget client doesn't branch.
 *
 * Caching mirrors `api.widget-config-resolved.tsx`:
 *   - max-age=30 + stale-while-revalidate=300 lets the browser/CDN serve
 *     repeat reads instantly while revalidating in the background.
 *   - ETag = "v<version>" where version = max(vto_stores.config_version,
 *     MAX(updated_at) over clothing_items for this store_id). Bumps both
 *     when the merchant changes store-level config AND when they toggle a
 *     product's active flag, so the cache invalidates correctly.
 *   - If-None-Match → 304 Not Modified.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const storeSlug = url.searchParams.get("store_slug");

  if (!shop && !storeSlug) {
    return jsonError(400, "Missing 'shop' or 'store_slug' query parameter");
  }

  // `shop` is interpolated into a PostgREST .or() filter below, so reject
  // anything outside the legit shop-domain/slug charset — a comma or paren
  // could otherwise inject extra filter terms (e.g. match a different store).
  // (storeSlug is only ever used via .eq(), which PostgREST parameterizes.)
  if (shop && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(shop)) {
    return jsonError(400, "Invalid 'shop' parameter");
  }

  try {
    // 1. Resolve store config.
    const storeQuery = supabaseAdmin
      .from("vto_stores")
      .select(
        "store_slug, shop_domain, storefront_token, clothing_population_type, config_version, tryon_targeting_mode, tryon_included_product_ids, tryon_included_collection_ids",
      );

    const { data: storeData, error: storeError } = shop
      ? await storeQuery
          .or(`shop_domain.eq.${shop},store_slug.eq.${shop}`)
          .maybeSingle()
      : await storeQuery.eq("store_slug", storeSlug!).maybeSingle();

    if (storeError) {
      console.error("[catalog-handles] Store fetch error:", storeError.message);
      return jsonError(500, storeError.message);
    }

    if (!storeData) {
      // Store not found — return empty so the widget falls back gracefully.
      // Cache briefly to avoid hammering DB on misconfigured storefronts.
      return new Response(
        JSON.stringify({ handles: [], version: "0" }),
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

    // Product targeting (Shopify-population stores only). Default 'all' keeps
    // legacy behavior. 'products'/'collections' scope try-on to a chosen set.
    const targetingMode =
      (storeData.tryon_targeting_mode as string | null) || "all";
    const includedProductIds = Array.isArray(storeData.tryon_included_product_ids)
      ? (storeData.tryon_included_product_ids as string[])
      : [];
    const includedCollectionIds = Array.isArray(
      storeData.tryon_included_collection_ids,
    )
      ? (storeData.tryon_included_collection_ids as string[])
      : [];

    // 2. Compute version: max(config_version, latest clothing_items.updated_at).
    //    Empty clothing_items table (default Shopify install) falls back to
    //    config_version. Either path produces a monotonically-increasing key
    //    that invalidates the cache when the merchant changes something.
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

    // 3. Conditional GET — saves payload on cache revalidation.
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

    // 4. Resolve handles by population mode — cached per (store, version) with
    //    single-flight, so a spike of cache-missing shoppers doesn't fan out into N
    //    identical multi-page Shopify crawls. The version already moves when the
    //    catalog or settings change (products webhook / settings save / the
    //    Refresh-widget button), so real changes invalidate immediately; the cache's
    //    safety-net TTL covers a dropped webhook.
    const handles: string[] = await catalogCache(slug, version, async () => {
      if (populationType === "supabase") {
        // Match legacy semantics: active=null is treated as enabled. Only
        // products explicitly set to active=false are excluded.
        // See widget-main.js processClothingRows line 1441:
        //   active: item.active !== false, // Default to true if missing
        const { data, error } = await supabaseAdmin
          .from("clothing_items")
          .select("item_id")
          .eq("store_id", slug)
          .not("active", "is", false);

        if (error) throw new Error(`supabase mode query: ${error.message}`);

        // In supabase mode item_id is the handle (per loadClothingFromSupabase in
        // widget-main.js — sampleClothing[i].id is set to the same string used
        // by detectCurrentProduct's URL handle match).
        return (data || [])
          .map((r) => (r as { item_id: string | null }).item_id)
          .filter((h): h is string => Boolean(h));
      }

      // Shopify mode. Targeting mode decides which products are eligible:
      //   'all'         → every product, minus merchant exclusions (default)
      //   'products'    → only the explicitly-selected products
      //   'collections' → only products inside the selected collections
      // Merchant exclusions (clothing_items.active=false) are still applied on
      // top of every mode, so a product can be hidden even within a collection.
      let pairs: Array<{ id: string; handle: string }> = [];
      if (targetingMode === "products") {
        pairs = await fetchHandlesForProductIds(
          storeData.shop_domain as string | null,
          storeData.storefront_token as string | null,
          includedProductIds,
        );
      } else if (targetingMode === "collections") {
        pairs = await fetchHandlesForCollectionIds(
          storeData.shop_domain as string | null,
          storeData.storefront_token as string | null,
          includedCollectionIds,
        );
      } else {
        pairs = await fetchShopifyHandles(
          storeData.shop_domain as string | null,
          storeData.storefront_token as string | null,
        );
      }

      const hiddenIds = await fetchHiddenShopifyIds(slug);

      return pairs
        .filter((p) => {
          // item_id in clothing_items can be stored as either the full GID
          // ("gid://shopify/Product/123") or the numeric portion ("123").
          // Check both shapes — mirrors widget-main.js fetchHiddenProductIds.
          const numericId = p.id.split("/").pop() || "";
          if (hiddenIds.has(p.id)) return false;
          if (hiddenIds.has(numericId)) return false;
          return true;
        })
        .map((p) => p.handle)
        .filter(Boolean);
    });

    return new Response(JSON.stringify({ handles, version }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": CACHE_HEADERS,
        ETag: etag,
        ...CORS,
      },
    });
  } catch (err) {
    console.error("[catalog-handles] Exception:", err);
    return jsonError(500, String(err));
  }
}

/**
 * Server-side Shopify Storefront pagination, handles-only.
 *
 * Mirrors loadClothingFromShopify in widget-main.js but fetches ONLY {id,handle}
 * per node — roughly 30 bytes/product vs ~2 KB/product. For a 1,600-product
 * store this is ~50 KB uncompressed (~10 KB Brotli) instead of ~2.5 MB.
 *
 * Safety cap: 20 × 250 = 5,000 products max (matches widget-main.js MAX_PAGES).
 */
async function fetchShopifyHandles(
  shopDomain: string | null,
  storefrontToken: string | null,
): Promise<Array<{ id: string; handle: string }>> {
  if (!shopDomain || !storefrontToken) return [];

  // Normalize domain (mirrors widget-main.js:723-728).
  let normalized = shopDomain;
  if (!normalized.includes(".")) {
    normalized = `${normalized}.myshopify.com`;
  } else if (!normalized.includes("myshopify.com")) {
    normalized = `${normalized.replace(/\.(com|net|org)$/, "")}.myshopify.com`;
  }

  const endpoint = `https://${normalized}/api/2024-01/graphql.json`;
  const QUERY = `query GetHandles($cursor: String) {
    products(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node { id handle } }
    }
  }`;

  const MAX_PAGES = 20;
  const all: Array<{ id: string; handle: string }> = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": storefrontToken,
      },
      body: JSON.stringify({
        query: QUERY,
        variables: cursor ? { cursor } : {},
      }),
    });

    if (!res.ok) {
      console.error(
        `[catalog-handles] Shopify GraphQL ${res.status} on page ${page + 1}`,
      );
      break;
    }

    const json: {
      data?: {
        products?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          edges?: Array<{ node?: { id?: string; handle?: string } }>;
        };
      };
      errors?: unknown;
    } = await res.json();

    if (json.errors) {
      console.error("[catalog-handles] Shopify GraphQL errors:", json.errors);
      break;
    }

    const edges = json.data?.products?.edges || [];
    for (const e of edges) {
      const id = e?.node?.id;
      const handle = e?.node?.handle;
      if (id && handle) all.push({ id, handle });
    }

    const pageInfo = json.data?.products?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) break;
    cursor = pageInfo.endCursor;
  }

  return all;
}

/** Normalize a merchant shop domain to its myshopify.com host. */
function normalizeShopDomain(shopDomain: string): string {
  let normalized = shopDomain;
  if (!normalized.includes(".")) {
    normalized = `${normalized}.myshopify.com`;
  } else if (!normalized.includes("myshopify.com")) {
    normalized = `${normalized.replace(/\.(com|net|org)$/, "")}.myshopify.com`;
  }
  return normalized;
}

/**
 * Resolve a set of Shopify product GIDs to their current handles via the
 * Storefront API ('products' targeting mode). Handles are resolved at request
 * time so product renames stay correct. Batched by 250 (nodes() limit).
 */
async function fetchHandlesForProductIds(
  shopDomain: string | null,
  storefrontToken: string | null,
  productIds: string[],
): Promise<Array<{ id: string; handle: string }>> {
  if (!shopDomain || !storefrontToken || productIds.length === 0) return [];

  const endpoint = `https://${normalizeShopDomain(shopDomain)}/api/2024-01/graphql.json`;
  const QUERY = `query Handles($ids: [ID!]!) {
    nodes(ids: $ids) { ... on Product { id handle } }
  }`;

  const out: Array<{ id: string; handle: string }> = [];
  for (let i = 0; i < productIds.length; i += 250) {
    const batch = productIds.slice(i, i + 250);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": storefrontToken,
      },
      body: JSON.stringify({ query: QUERY, variables: { ids: batch } }),
    });
    if (!res.ok) {
      console.error(`[catalog-handles] product-ids GraphQL ${res.status}`);
      continue;
    }
    const json: {
      data?: { nodes?: Array<{ id?: string; handle?: string } | null> };
    } = await res.json();
    for (const node of json.data?.nodes ?? []) {
      if (node?.id && node?.handle) out.push({ id: node.id, handle: node.handle });
    }
  }
  return out;
}

/**
 * Resolve all product handles inside a set of collection GIDs via the
 * Storefront API ('collections' targeting mode). Paginated per collection,
 * deduped by product id. Page cap mirrors fetchShopifyHandles.
 */
async function fetchHandlesForCollectionIds(
  shopDomain: string | null,
  storefrontToken: string | null,
  collectionIds: string[],
): Promise<Array<{ id: string; handle: string }>> {
  if (!shopDomain || !storefrontToken || collectionIds.length === 0) return [];

  const endpoint = `https://${normalizeShopDomain(shopDomain)}/api/2024-01/graphql.json`;
  const QUERY = `query CollectionProducts($id: ID!, $cursor: String) {
    collection(id: $id) {
      products(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges { node { id handle } }
      }
    }
  }`;

  const MAX_PAGES = 20;
  const seen = new Set<string>();
  const out: Array<{ id: string; handle: string }> = [];

  for (const collectionId of collectionIds) {
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Storefront-Access-Token": storefrontToken,
        },
        body: JSON.stringify({
          query: QUERY,
          variables: { id: collectionId, cursor },
        }),
      });
      if (!res.ok) {
        console.error(`[catalog-handles] collection GraphQL ${res.status}`);
        break;
      }
      const json: {
        data?: {
          collection?: {
            products?: {
              pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
              edges?: Array<{ node?: { id?: string; handle?: string } }>;
            };
          };
        };
      } = await res.json();

      const products = json.data?.collection?.products;
      for (const edge of products?.edges ?? []) {
        const id = edge?.node?.id;
        const handle = edge?.node?.handle;
        if (id && handle && !seen.has(id)) {
          seen.add(id);
          out.push({ id, handle });
        }
      }
      if (!products?.pageInfo?.hasNextPage || !products?.pageInfo?.endCursor) break;
      cursor = products.pageInfo.endCursor;
    }
  }
  return out;
}

/**
 * Returns the set of Shopify product IDs marked active=false by the merchant.
 * Mirrors widget-main.js:1170 fetchHiddenProductIds. Each entry is stored in
 * both numeric and GID form to handle either shape on lookup.
 */
async function fetchHiddenShopifyIds(slug: string): Promise<Set<string>> {
  const hidden = new Set<string>();

  const { data, error } = await supabaseAdmin
    .from("clothing_items")
    .select("item_id")
    .eq("store_id", slug)
    .eq("data_source", "shopify")
    .eq("active", false);

  if (error) {
    console.error("[catalog-handles] hidden-ids query error:", error.message);
    return hidden;
  }

  for (const row of data || []) {
    const itemId = (row as { item_id: string | null }).item_id;
    if (!itemId) continue;
    hidden.add(itemId);
    if (itemId.startsWith("gid://")) {
      const numeric = itemId.split("/").pop();
      if (numeric) hidden.add(numeric);
    } else {
      hidden.add(`gid://shopify/Product/${itemId}`);
    }
  }

  return hidden;
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
