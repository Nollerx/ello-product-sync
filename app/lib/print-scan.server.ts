// Automated catalogue print-side scan — the productized version of the vision
// pass run by hand for Atlas (08-13) and Omnithreads (08-28).
//
// Trigger model (no cron): the scan is kicked per store —
//   - at INSTALL, from afterAuth after the storefront token sync completes,
//   - from the products webhook when the catalog changes (gated to stores
//     installed after PRINT_SCAN_CUTOFF, so legacy catalogs never scan
//     without a deliberate manual kick),
//   - manually via /api/print-scan-sweep?store=<slug-or-domain>.
// One invocation processes a bounded batch; the route self-chains until the
// store's catalog is drained.
//
// Data model: clothing_items is an EXCEPTIONS table, not a catalog mirror —
// there is no install-time sync that mirrors products into it. The scan
// therefore enumerates the catalog LIVE from the Storefront API (the token
// minted at install; works on password-protected storefronts) and UPSERTS one
// row per product it classifies, exactly the shape the Products admin writes
// for manual corrections. Products already carrying a scanned or manual row
// are skipped, so re-kicks are cheap and merchant corrections are never
// revisited. Regex-skipped kinds (bottoms, accessories) get no row at all —
// re-deciding them costs nothing.
//
// Split (back/both) is only ever written for TOPS and BACKPACKS: the engine's
// split prompt is top-only (bottoms garble — Atlas lesson), and accessories
// ride their own pipeline.
//
// HANDBAGS (2026-09-07) get a different set of columns from the same sweep:
// carry_modes (crossbody | shoulder | handheld | clutch — the engine renders
// a strap|handheld split card when two apply), bag_dimensions (listed W x H x
// D + handle/strap drops, parsed deterministically from the description and
// only back-filled by the model), and carry_meta (best strap-attached and
// by-the-handles photos, strap removability). See app/lib/bag-carry.ts.
//
// Classifier: gemini-3.6-flash. gemini-2.5-flash was retired for our AI Studio
// key 2026-08-28 (the API 404s and names 3.6-flash as successor). Contract is
// the same as the verified Atlas scan: judge by print LOCATION on the garment,
// never by which way the model faces; confidence 0-2, keep threshold 1.5.

import { supabaseAdmin } from "./supabase.server";
import {
  classifyHandbag,
  detectCarryModes,
  isHandbagLike,
  mergeDimensions,
  normalizeModes,
  parseBagDimensions,
  strapIsRemovable,
  type BagDimensions,
  type CarryMode,
  type InlineImage,
} from "./bag-carry";

const GEMINI_MODEL = "gemini-3.6-flash";

// Catalogue scanning must never compete with rendering. Both used to share
// GEMINI_API_KEY, so one big catalogue sweep (a 5,000-product store is ~2,500
// calls) ate into the same AI Studio requests-per-day budget that paying
// merchants' try-ons draw from — a scan for a free store could throttle a
// render for Atlas. Scans now prefer their own key and only fall back to the
// render key when it isn't set, so this is safe to deploy before the key exists.
// Cost is NOT the reason for the split: a full catalogue scan is cents
// (Atlas's 27 scannable products measured $0.116). Throughput is.
function scanApiKey(): string | undefined {
  return process.env.PRINT_SCAN_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
}
const CONFIDENCE_KEEP = 1.5;
const MAX_IMAGES = 10; // later gallery slots are detail crops / size charts

interface CatalogProduct {
  gid: string;
  title: string;
  productType: string;
  tags: string[];
  price: number;
  images: string[];
  description: string;
}

interface Classification {
  print_side: "front" | "back" | "both" | "none";
  confidence: number;
  print_size: "large" | "medium" | "small" | "tiny" | null;
  front_image_url: string | null;
  back_image_url: string | null;
}

export interface ScanStats {
  catalog: number; // products enumerated from Shopify
  candidates: number; // unscanned tops/backpacks this invocation could see
  classified: number; // classifier calls made this invocation
  written: number; // rows upserted with a print_side
  split: number; // subset with back/both
  parked: number; // rows stamped scanned with no usable result
  remaining: number; // candidates left for the next hop
  bags: number; // handbag rows written with carry modes / dimensions
}

// ── Garment routing ──────────────────────────────────────────────────────────
// Backpack test mirrors the engine's _is_backpack (whole-word, so "Backpacker
// Tee" stays a tee) and runs FIRST — same precedence the engine needed.
const BACKPACK_RE = /\b(backpack|rucksack|knapsack|bookbag|daypack)s?\b/i;
export const BOTTOM_RE = /\b(legging|leggings|short|shorts|pant|pants|trouser|trousers|jean|jeans|jogger|joggers|sweatpant|sweatpants|skirt|skort|bottom|bottoms|tight|tights)\b/i;
// "pump cover" is gymwear for an oversized hoodie/tee and is a whole category on
// lifting brands (Atlas: 4 of 17 catalogued products). It matched nothing here, so
// garmentKind() returned "skip" and those products could never be scanned OR
// re-scanned — which is why their rotten image URLs (2026-09-17) could not self-heal.
const TOP_RE = /\b(tee|t-shirt|tshirt|shirt|hoodie|hoody|sweatshirt|sweater|crewneck|crew neck|pullover|jumper|jacket|top|tank|camisole|polo|longsleeve|long sleeve|cardigan|zip-up|zip up|flannel|blouse|pump cover)\b/i;

export function garmentKind(p: {
  title: string;
  productType: string;
  tags: string[];
}): "top" | "backpack" | "handbag" | "skip" {
  const haystack = [p.title, p.productType, ...p.tags].filter(Boolean).join(" ");
  if (BACKPACK_RE.test(haystack)) return "backpack";
  // Handbags before tops: "Top Handle Bag" carries the word "top".
  if (isHandbagLike(p)) return "handbag";
  if (BOTTOM_RE.test(haystack) && !TOP_RE.test(haystack)) return "skip";
  if (TOP_RE.test(haystack)) return "top";
  return "skip";
}

// ── Store lookup ─────────────────────────────────────────────────────────────
export interface StoreRef {
  slug: string;
  shopDomain: string;
  storefrontToken: string | null;
  createdAt: string | null;
}

// Accepts either the store slug or the myshopify domain, so install/webhook
// kicks can pass the shop domain they already have.
export async function resolveStore(slugOrDomain: string): Promise<StoreRef | null> {
  const key = slugOrDomain.trim();
  if (!key) return null;
  const col = key.includes(".") ? "shop_domain" : "store_slug";
  const { data } = await supabaseAdmin
    .from("vto_stores")
    .select("store_slug, shop_domain, storefront_token, created_at")
    .eq(col, key)
    .maybeSingle();
  if (!data?.store_slug || !data?.shop_domain) return null;
  return {
    slug: data.store_slug as string,
    shopDomain: data.shop_domain as string,
    storefrontToken: (data.storefront_token as string | null) ?? null,
    createdAt: (data.created_at as string | null) ?? null,
  };
}

// ── Catalog enumeration via the Storefront API ───────────────────────────────
// Same endpoint/auth pattern as fetchStorefrontProducts (storefront-names) and
// the catalog-handles fetchers. Token-authenticated, so it works even when the
// storefront has a password page (dev stores).
async function fetchCatalog(store: StoreRef): Promise<CatalogProduct[] | null> {
  if (!store.storefrontToken) return null;
  const domain = store.shopDomain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const endpoint = `https://${domain}/api/2024-01/graphql.json`;
  const QUERY = `query Catalog($cursor: String) {
    products(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id title productType tags
        description(truncateAt: 1500)
        images(first: ${MAX_IMAGES}) { edges { node { url } } }
        variants(first: 1) { edges { node { price { amount } } } }
      } }
    }
  }`;

  const out: CatalogProduct[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 30; page++) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Storefront-Access-Token": store.storefrontToken,
        },
        body: JSON.stringify({ query: QUERY, variables: { cursor } }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) return out.length ? out : null;
      const json = (await res.json()) as {
        data?: {
          products?: {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string };
            edges?: Array<{
              node?: {
                id?: string;
                title?: string;
                productType?: string;
                tags?: string[];
                description?: string;
                images?: { edges?: Array<{ node?: { url?: string } }> };
                variants?: { edges?: Array<{ node?: { price?: { amount?: string } } }> };
              };
            }>;
          };
        };
      };
      const conn = json.data?.products;
      for (const edge of conn?.edges ?? []) {
        const n = edge?.node;
        if (!n?.id) continue;
        out.push({
          gid: n.id,
          title: n.title ?? "",
          productType: n.productType ?? "",
          tags: Array.isArray(n.tags) ? n.tags : [],
          description: typeof n.description === "string" ? n.description : "",
          price: Number(n.variants?.edges?.[0]?.node?.price?.amount ?? 0) || 0,
          images: (n.images?.edges ?? [])
            .map((e) => e?.node?.url)
            .filter((u): u is string => Boolean(u)),
        });
      }
      if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) return out;
      cursor = conn.pageInfo.endCursor;
    } catch {
      return out.length ? out : null;
    }
  }
  return out;
}

async function downloadImage(src: string): Promise<{ mime: string; b64: string } | null> {
  const sep = src.includes("?") ? "&" : "?";
  try {
    const res = await fetch(`${src}${sep}width=512`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ElloScan/1.0)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      mime: src.toLowerCase().includes(".png") ? "image/png" : "image/jpeg",
      b64: buf.toString("base64"),
    };
  } catch {
    return null;
  }
}

// ── Prompts ──────────────────────────────────────────────────────────────────
const TEE_PROMPT = `You are cataloguing a garment for a virtual try-on system.
You are shown numbered product photos of ONE garment ("IMAGE 0", "IMAGE 1", ...).

Decide where the printed design sits ON THE GARMENT itself:
- "front": design on the chest/front only (back blank or at most a tiny tag print)
- "back": design on the back only (front blank or tiny logo)
- "both": a real printed design on the front AND on the back
  (a small chest hit + large back piece counts as "both")
- "none": no printed design on either side

Judge by where the print sits on the garment, NEVER by which way the model
faces. A photo of the model's back showing large artwork = design on the BACK.

Pick the single best source photo of each side:
- front_image_index: image most clearly showing the ENTIRE FRONT of the garment
  (straight-on, fully visible, not a zoomed crop). -1 if none shows the front.
- back_image_index: same for the ENTIRE BACK. -1 if none.

confidence: 0 to 2 (2 = certain). print_size: size of the LARGEST print.
Return only the JSON.`;

// Backpacks: the engine maps front_image_url = STRAP side and back_image_url =
// OUTER face for its two-image split, so the classifier answers in those terms.
const BAG_PROMPT = `You are cataloguing a backpack/bag for a virtual try-on system.
You are shown numbered product photos of ONE bag ("IMAGE 0", "IMAGE 1", ...).

Pick two source photos:
- back_image_index: the image most clearly showing the bag's OUTER FACE (the
  decorated panel that faces away from the wearer's back). -1 if none.
- front_image_index: the image most clearly showing the STRAP SIDE (harness /
  shoulder straps, the side that touches the wearer's back). -1 if none.

Set print_side to "both" when BOTH views are clearly present, otherwise "none".
confidence: 0 to 2 (2 = certain). print_size: size of the largest print or
graphic on the outer face. Return only the JSON.`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    print_side: { type: "STRING", enum: ["front", "back", "both", "none"] },
    confidence: { type: "NUMBER" },
    print_size: { type: "STRING", enum: ["large", "medium", "small", "tiny"] },
    front_image_index: { type: "INTEGER" },
    back_image_index: { type: "INTEGER" },
  },
  required: ["print_side", "confidence", "front_image_index", "back_image_index"],
};

export async function classify(
  kind: "top" | "backpack",
  title: string,
  imageUrls: string[],
): Promise<Classification | null> {
  const apiKey = scanApiKey();
  if (!apiKey) return null;

  const parts: unknown[] = [
    { text: kind === "backpack" ? BAG_PROMPT : TEE_PROMPT },
    { text: `Product title: ${title}` },
  ];
  const keptUrls: string[] = [];
  for (const src of imageUrls.slice(0, MAX_IMAGES)) {
    const img = await downloadImage(src);
    if (!img) continue;
    parts.push({ text: `IMAGE ${keptUrls.length}` });
    parts.push({ inline_data: { mime_type: img.mime, data: img.b64 } });
    keptUrls.push(src.split("?")[0]);
  }
  if (keptUrls.length === 0) return null;

  const body = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0,
    },
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(60000),
        },
      );
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return null;
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) return null;
      const out = JSON.parse(text) as {
        print_side: Classification["print_side"];
        confidence: number;
        print_size: Classification["print_size"];
        front_image_index: number;
        back_image_index: number;
      };
      const urlAt = (i: number) =>
        Number.isInteger(i) && i >= 0 && i < keptUrls.length ? keptUrls[i] : null;
      return {
        print_side: out.print_side,
        confidence: out.confidence,
        print_size: out.print_size ?? null,
        front_image_url: urlAt(out.front_image_index),
        back_image_url: urlAt(out.back_image_index),
      };
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null;
}

// ── Write gating ─────────────────────────────────────────────────────────────
// Returns the print columns to write, or null to park the row (a scanned stamp
// with no print_side, so the product is never re-paid-for at the classifier).
function decideWrite(
  kind: "top" | "backpack",
  cls: Classification,
): { print_side: string; front_image_url: string | null; back_image_url: string | null } | null {
  if (cls.confidence < CONFIDENCE_KEEP) return null;

  if (kind === "backpack") {
    // Two-image mapping only helps when both views exist; otherwise the
    // engine's zero-data backpack path already does the right thing.
    if (cls.print_side !== "both" || !cls.front_image_url || !cls.back_image_url) return null;
    return {
      print_side: "both",
      front_image_url: cls.front_image_url,
      back_image_url: cls.back_image_url,
    };
  }

  let side = cls.print_side;
  // Tiny back prints (collar logos) render fine as-is and a split adds nothing
  // — the Atlas rollout excluded them for that reason.
  if (cls.print_size === "tiny") {
    if (side === "both") side = "front";
    else if (side === "back") return null;
  }
  if ((side === "back" || side === "both") && !cls.back_image_url) return null;
  return {
    print_side: side,
    front_image_url: cls.front_image_url,
    back_image_url: side === "front" || side === "none" ? null : cls.back_image_url,
  };
}

// ── Handbags: vision + text → carry modes, dimensions, photo picks ───────────
const BAG_MAX_IMAGES = 8; // resale listings run 10-18 photos; the first 8 carry the views

interface CarryWrite {
  carry_modes: CarryMode[];
  bag_dimensions: BagDimensions | null;
  carry_meta: {
    strap_image_url: string | null;
    handle_image_url: string | null;
    strap_removable: boolean | null;
    vision_modes: CarryMode[];
    text_modes: CarryMode[];
  };
  carry_scan_confidence: number | null;
}

async function classifyHandbagProduct(p: CatalogProduct): Promise<Awaited<ReturnType<typeof classifyHandbag>>> {
  const apiKey = scanApiKey();
  if (!apiKey) return null;
  const images: InlineImage[] = [];
  for (const src of p.images.slice(0, BAG_MAX_IMAGES)) {
    const img = await downloadImage(src);
    if (img) images.push({ url: src.split("?")[0], mime: img.mime, b64: img.b64 });
  }
  if (images.length === 0) return null;
  return classifyHandbag({
    apiKey,
    model: GEMINI_MODEL,
    title: p.title,
    productType: p.productType,
    tags: p.tags,
    description: p.description,
    images,
  });
}

// The vision read decides; the text read is ADDITIVE (a listed strap drop
// proves a strap exists even when every photo shows the bag without it) and
// is the whole answer when the model is unavailable or unsure. A confident
// "not a handbag" (wallet, case) parks the row. Nothing usable → park.
export function decideCarryWrite(
  cls: Awaited<ReturnType<typeof classifyHandbag>>,
  textModes: CarryMode[],
  parsedDims: BagDimensions | null,
  textBlob: string,
): CarryWrite | null {
  let modes: CarryMode[] = [];
  let confidence: number | null = null;
  let strapImage: string | null = null;
  let handleImage: string | null = null;
  let strapRemovable = strapIsRemovable(textBlob);
  const visionModes = cls?.carry_modes ?? [];
  if (cls && cls.confidence >= CONFIDENCE_KEEP && !cls.is_handbag) return null;
  if (cls && cls.is_handbag && cls.confidence >= CONFIDENCE_KEEP && visionModes.length) {
    modes = normalizeModes([...visionModes, ...textModes]);
    confidence = cls.confidence;
    strapImage = cls.strap_image_url;
    handleImage = cls.handle_image_url;
    if (cls.strap_removable != null) strapRemovable = cls.strap_removable;
  } else {
    modes = textModes;
    confidence = textModes.length ? 1 : null;
  }
  const dims = mergeDimensions(parsedDims, cls?.dimensions ?? null);
  if (modes.length === 0 && !dims) return null;
  return {
    carry_modes: modes,
    bag_dimensions: dims,
    carry_meta: {
      strap_image_url: strapImage,
      handle_image_url: handleImage,
      strap_removable: strapRemovable,
      vision_modes: visionModes,
      text_modes: textModes,
    },
    carry_scan_confidence: confidence,
  };
}

// ── Store scan (one bounded invocation; the route self-chains) ───────────────
export async function scanStoreCatalog(
  store: StoreRef,
  opts: { limit: number; deadlineMs: number; force?: string[]; onlyForced?: boolean },
): Promise<{ stats: ScanStats; error?: string }> {
  const startedAt = Date.now();
  const stats: ScanStats = {
    catalog: 0,
    candidates: 0,
    classified: 0,
    written: 0,
    split: 0,
    parked: 0,
    remaining: 0,
    bags: 0,
  };

  const catalog = await fetchCatalog(store);
  if (!catalog) return { stats, error: "catalog enumeration failed (no storefront token, or Storefront API unreachable)" };
  stats.catalog = catalog.length;

  // Anything already decided — scanned by a previous hop/run, or set by the
  // merchant — is skipped. This is also the manual-row protection: a manual
  // row always has print data, lands in this set, and is never upserted over.
  const { data: existing } = await supabaseAdmin
    .from("clothing_items")
    .select("item_id, print_side, print_scanned_at, carry_modes, carry_source, print_side_source")
    .eq("store_id", store.slug);
  const done = new Set<string>();
  const manual = new Set<string>();
  for (const row of existing ?? []) {
    const tail = String(row.item_id).match(/(\d+)$/)?.[1];
    if (!tail) continue;
    if (row.print_side || row.print_scanned_at || row.carry_modes || row.carry_source === "manual") done.add(tail);
    // A merchant correction must survive a re-scan. carry_source covers handbags;
    // print_side_source is what app.products.tsx stamps when someone fixes a
    // front/back call by hand, and it was NOT protected here — so a forced
    // rescan (which product webhooks now trigger on legacy stores) would
    // silently overwrite their correction with the classifier's guess.
    if (row.carry_source === "manual" || row.print_side_source === "manual") manual.add(tail);
  }
  // Forced products (from a products webhook) are re-read unless the merchant
  // set them by hand.
  const force = new Set((opts.force ?? []).map((g) => g.match(/(\d+)$/)?.[1]).filter((t): t is string => Boolean(t)));

  const candidates = catalog.filter((p) => {
    const tail = p.gid.match(/(\d+)$/)?.[1];
    if (!tail) return false;
    if (force.has(tail)) return !manual.has(tail) && garmentKind(p) !== "skip";
    // onlyForced: a legacy (pre-cutoff) store's product webhook re-reads the named
    // product and NOTHING else, so a merchant photo swap can never turn into a
    // full-catalog vision scan they never asked for.
    if (opts.onlyForced) return false;
    if (done.has(tail)) return false;
    return garmentKind(p) !== "skip";
  });
  stats.candidates = candidates.length;

  for (const p of candidates) {
    if (stats.classified >= opts.limit || Date.now() - startedAt > opts.deadlineMs) break;
    const kind = garmentKind(p) as "top" | "backpack" | "handbag";
    // Same row shape the Products admin writes for manual corrections; the
    // upsert either creates the exception row or adds scan data to an
    // existing override-only row. print_scanned_at doubles as the generic
    // "vision scan ran" stamp for every kind.
    const row: Record<string, unknown> = {
      store_id: store.slug,
      item_id: p.gid,
      name: p.title || "Product",
      price: p.price,
      category: p.productType || "clothing",
      data_source: "shopify",
      print_scanned_at: new Date().toISOString(),
    };
    let configured = false;
    let isSplit = false;
    let isBag = false;
    if (kind === "handbag") {
      const parsedDims = parseBagDimensions(p.description);
      const textBlob = [p.title, p.productType, p.tags.join(" "), p.description].join(" ");
      const textModes = detectCarryModes(textBlob, parsedDims);
      const cls = p.images.length >= 1 ? await classifyHandbagProduct(p) : null;
      stats.classified += 1;
      const write = decideCarryWrite(cls, textModes, parsedDims, textBlob);
      if (write) {
        row.carry_modes = write.carry_modes;
        row.carry_source = "auto";
        row.bag_dimensions = write.bag_dimensions;
        row.carry_meta = write.carry_meta;
        row.carry_scan_confidence = write.carry_scan_confidence;
        configured = true;
        isBag = true;
      }
    } else {
      const cls = p.images.length >= 2 ? await classify(kind, p.title, p.images) : null;
      stats.classified += 1;
      const write = cls ? decideWrite(kind, cls) : null;
      if (write) {
        // NEVER store "back". It is the one label the engine renders wrong: it
        // puts the back graphic on the FRONT panel (Atlas ROSE tee, 2026-09-18 —
        // the identical product stored as "both" renders both panels correctly).
        // Every one of the live split cards in this DB is "both", so that is the
        // only exercised path. The classifier's back/both judgment is not thrown
        // away — it becomes lead_view, which decides the view the shopper sees
        // first. A back-graphic garment opens on its back; the widget's Front/Back
        // toggle still gives them the front.
        const backDominant = write.print_side === "back" || write.print_side === "both";
        row.print_side = write.print_side === "back" ? "both" : write.print_side;
        row.print_side_source = "auto";
        row.front_image_url = write.front_image_url;
        row.back_image_url = write.back_image_url;
        row.print_scan_confidence = cls!.confidence;
        if (backDominant && write.back_image_url) row.lead_view = "back";
        configured = true;
        isSplit = backDominant;
      }
    }
    const { error } = await supabaseAdmin
      .from("clothing_items")
      .upsert(row, { onConflict: "store_id,item_id" });
    if (error) {
      console.error(`[PrintScan] upsert failed ${store.slug}/${p.gid}: ${error.message}`);
      continue;
    }
    if (configured) {
      stats.written += 1;
      if (isSplit) stats.split += 1;
      if (isBag) stats.bags += 1;
    } else {
      stats.parked += 1;
    }
  }

  stats.remaining = Math.max(0, stats.candidates - stats.classified);
  return { stats };
}

// ── Kick (fire-and-forget) ───────────────────────────────────────────────────
// Used by afterAuth and the products webhook to start a scan without blocking
// the caller: the scan runs in its own HTTP request, which gives it its own
// CPU allocation on Cloud Run. `src` tells the route which gate to apply.
export function kickPrintScan(shopOrSlug: string, src: "install" | "webhook" | "admin", productGid?: string | null): void {
  const base = process.env.SHOPIFY_APP_URL;
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) return;
  let url = `${base.replace(/\/$/, "")}/api/print-scan-sweep?store=${encodeURIComponent(shopOrSlug)}&src=${src}`;
  // A product webhook names the product: that one is re-read even if it was
  // scanned before (a merchant adding measurements after publishing must not
  // be stuck with the first read). Manual rows are still never touched.
  if (productGid) url += `&product=${encodeURIComponent(productGid)}`;
  fetch(url, { headers: { "x-cron-key": secret } }).catch(() => {});
}
