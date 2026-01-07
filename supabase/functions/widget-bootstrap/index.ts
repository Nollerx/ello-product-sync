import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SB_URL")!;
const SB_SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY")!;
const WIDGET_BOOTSTRAP_SECRET = Deno.env.get("WIDGET_BOOTSTRAP_SECRET")!;
const SHOPIFY_STOREFRONT_API_VERSION = Deno.env.get("SHOPIFY_STOREFRONT_API_VERSION") || "2024-10";

const supabase = createClient(SB_URL, SB_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: any) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sha256Hex(input: string) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256Hex(secret: string, msg: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getStorefrontToken(shop: string) {
  const { data, error } = await supabase
    // IMPORTANT: Edge Functions can only target "public" directly.
    // So we query using RPC OR fully-qualified SQL is not available here.
    // Easiest fix: create a VIEW in public that exposes the token rows you need.
    .from("storefront_tokens_public")
    .select("storefront_access_token")
    .eq("shop", shop)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`TOKEN_LOOKUP_ERROR: ${error.message}`);
  return data?.storefront_access_token ?? null;
}

async function callStorefront(shopDomain: string, token: string, query: string, variables?: any) {
  const url = `https://${shopDomain}/api/${SHOPIFY_STOREFRONT_API_VERSION}/graphql.json`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const jsonBody = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`STOREFRONT_HTTP_${resp.status}: ${JSON.stringify(jsonBody).slice(0, 400)}`);
  }
  if (jsonBody.errors?.length) {
    throw new Error(`STOREFRONT_GRAPHQL_ERRORS: ${JSON.stringify(jsonBody.errors).slice(0, 400)}`);
  }
  return jsonBody.data;
}

function normalizeProducts(data: any) {
  const edges = data?.products?.edges ?? [];
  return edges.map((e: any) => {
    const p = e.node;
    const img = p?.featuredImage?.url ?? null;
    const price = p?.priceRange?.minVariantPrice?.amount ?? null;
    const currency = p?.priceRange?.minVariantPrice?.currencyCode ?? null;
    return {
      id: p.id,
      title: p.title,
      handle: p.handle,
      image: img,
      price,
      currency,
      tags: p.tags ?? [],
    };
  });
}

function normalizeCollections(data: any) {
  const edges = data?.collections?.edges ?? [];
  return edges.map((e: any) => {
    const c = e.node;
    return { id: c.id, title: c.title, handle: c.handle };
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }

  const shop = String(body.shop || "").trim();
  const ts = Number(body.ts);
  const sig = String(body.sig || "").trim();

  if (!shop || !Number.isFinite(ts) || !sig) {
    return json(400, { ok: false, error: "MISSING_FIELDS" });
  }

  // Basic timestamp window (5 min) to prevent replay
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 300) {
    return json(401, { ok: false, error: "STALE_TS" });
  }

  // HMAC verify: sig == HMAC(secret, `${shop}.${ts}`)
  const msg = `${shop}.${ts}`;
  const expected = await hmacSha256Hex(WIDGET_BOOTSTRAP_SECRET, msg);
  if (expected !== sig) {
    return json(401, { ok: false, error: "BAD_SIG" });
  }

  // Your shop value is already like qgewea-2s.myshopify.com
  const shopDomain = shop;

  let token: string | null = null;
  try {
    token = await getStorefrontToken(shop);
  } catch (e: any) {
    return json(500, { ok: false, error: "TOKEN_LOOKUP_ERROR", detail: e.message });
  }

  if (!token) {
    return json(404, { ok: false, error: "NO_TOKEN_FOR_SHOP", shop });
  }

  const query = `
    query Bootstrap($productsFirst: Int!, $collectionsFirst: Int!) {
      products(first: $productsFirst, sortKey: UPDATED_AT, reverse: true) {
        edges {
          node {
            id
            title
            handle
            tags
            featuredImage { url }
            priceRange {
              minVariantPrice { amount currencyCode }
            }
          }
        }
      }
      collections(first: $collectionsFirst) {
        edges {
          node { id title handle }
        }
      }
    }
  `;

  try {
    const data = await callStorefront(shopDomain, token, query, {
      productsFirst: 50,
      collectionsFirst: 25,
    });

    const products = normalizeProducts(data);
    const collections = normalizeCollections(data);

    // tags: unique list from products.tags
    const tagsSet = new Set<string>();
    for (const p of products) (p.tags || []).forEach((t: string) => tagsSet.add(t));
    const tags = Array.from(tagsSet).slice(0, 500);

    return json(200, { ok: true, shop, products, tags, collections });
  } catch (e: any) {
    return json(502, { ok: false, error: "STOREFRONT_FETCH_FAILED", detail: e.message });
  }
});
