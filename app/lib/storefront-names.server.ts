// Resolve product/collection titles + shop currency via the Storefront API.
//
// The app only holds Storefront scopes (unauthenticated_read_product_listings),
// not the Admin `read_products` scope, so Admin GraphQL `nodes(... on Product)`
// fails. The storefront token (already used by catalog-handles / widget-preview)
// can read published products and collections by GID, which is what the admin
// analytics + products pages need to show real names instead of raw GIDs.

function normalizeShopDomain(shopDomain: string): string {
  let normalized = shopDomain;
  if (!normalized.includes(".")) {
    normalized = `${normalized}.myshopify.com`;
  } else if (!normalized.includes("myshopify.com")) {
    normalized = `${normalized.replace(/\.(com|net|org)$/, "")}.myshopify.com`;
  }
  return normalized;
}

export interface StorefrontMeta {
  currencyCode: string;
  /** Maps a GID (gid://shopify/Product/123 or .../Collection/123) → title. */
  titles: Map<string, string>;
}

/**
 * Look up titles for a set of product/collection GIDs and the shop currency in
 * a single Storefront GraphQL request. Always resolves (errors are swallowed) so
 * callers can fall back to showing the raw id.
 */
export async function resolveStorefront(
  shopDomain: string | null,
  storefrontToken: string | null,
  ids: string[],
): Promise<StorefrontMeta> {
  const titles = new Map<string, string>();
  if (!shopDomain || !storefrontToken) {
    return { currencyCode: "USD", titles };
  }

  const endpoint = `https://${normalizeShopDomain(shopDomain)}/api/2024-01/graphql.json`;
  // Dedupe + cap (nodes() accepts up to 250 ids per call).
  const unique = Array.from(new Set(ids)).slice(0, 250);

  const QUERY = `query Meta($ids: [ID!]!) {
    shop { paymentSettings { currencyCode } }
    nodes(ids: $ids) {
      ... on Product { id title }
      ... on Collection { id title }
    }
  }`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": storefrontToken,
      },
      body: JSON.stringify({ query: QUERY, variables: { ids: unique } }),
    });

    if (!res.ok) {
      console.error(`[storefront-names] GraphQL ${res.status}`);
      return { currencyCode: "USD", titles };
    }

    const json: {
      data?: {
        shop?: { paymentSettings?: { currencyCode?: string } };
        nodes?: Array<{ id?: string; title?: string } | null>;
      };
    } = await res.json();

    const currencyCode = json.data?.shop?.paymentSettings?.currencyCode ?? "USD";
    for (const node of json.data?.nodes ?? []) {
      if (node?.id && node?.title) titles.set(node.id, node.title);
    }
    return { currencyCode, titles };
  } catch (err) {
    console.error("[storefront-names] lookup failed (non-fatal):", err);
    return { currencyCode: "USD", titles };
  }
}

export interface SFProduct {
  id: string;
  title: string;
  price: number;
  category: string;
  featuredImage: string | null;
  images: string[];
}

/**
 * Fetch full product detail (title, price, category, featured image, and the
 * full image gallery) for a set of product GIDs via the Storefront API. Powers
 * the per-product try-on image picker. Featured image is always first in
 * `images`.
 */
export async function fetchStorefrontProducts(
  shopDomain: string | null,
  storefrontToken: string | null,
  productGids: string[],
): Promise<Map<string, SFProduct>> {
  const out = new Map<string, SFProduct>();
  if (!shopDomain || !storefrontToken || productGids.length === 0) return out;

  const endpoint = `https://${normalizeShopDomain(shopDomain)}/api/2024-01/graphql.json`;
  const unique = Array.from(new Set(productGids)).slice(0, 250);

  const QUERY = `query Products($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        productType
        featuredImage { url }
        images(first: 20) { edges { node { url } } }
        variants(first: 1) { edges { node { price { amount } } } }
      }
    }
  }`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": storefrontToken,
      },
      body: JSON.stringify({ query: QUERY, variables: { ids: unique } }),
    });
    if (!res.ok) {
      console.error(`[storefront-names] products GraphQL ${res.status}`);
      return out;
    }

    const json: {
      data?: {
        nodes?: Array<
          | {
              id?: string;
              title?: string;
              productType?: string;
              featuredImage?: { url?: string } | null;
              images?: { edges?: Array<{ node?: { url?: string } }> };
              variants?: { edges?: Array<{ node?: { price?: { amount?: string } } }> };
            }
          | null
        >;
      };
    } = await res.json();

    for (const node of json.data?.nodes ?? []) {
      if (!node?.id) continue;
      const gallery = (node.images?.edges ?? [])
        .map((e) => e?.node?.url)
        .filter((u): u is string => Boolean(u));
      const featured = node.featuredImage?.url ?? gallery[0] ?? null;
      // Guarantee the featured image is first, without duplicating it.
      const images = featured
        ? [featured, ...gallery.filter((u) => u !== featured)]
        : gallery;
      const amount = node.variants?.edges?.[0]?.node?.price?.amount;
      out.set(node.id, {
        id: node.id,
        title: node.title ?? "Product",
        price: amount ? parseFloat(amount) : 0,
        category: (node.productType || "clothing").toLowerCase(),
        featuredImage: featured,
        images,
      });
    }
    return out;
  } catch (err) {
    console.error("[storefront-names] products lookup failed (non-fatal):", err);
    return out;
  }
}
