#!/usr/bin/env node
/* eslint-env node */
// Pre-install handbag scan against a store's PUBLIC catalog (products.json) —
// the same classifier the install-time sweep runs (app/lib/bag-carry.ts), so
// a prospect's catalog can be validated before they install. Built for Lola
// Saratoga (lolasaratoga.com, preowned luxury handbags), reusable for any
// Shopify store with a public products.json.
//
//   GEMINI_API_KEY=... node scripts/lola/scan-bags.mjs --store lolasaratoga.com --limit 30
//   (without GEMINI_API_KEY the script reads it from cloud_run_env.yaml)
//
// Outputs (next to this script):
//   carry-scan.json   per-product: text read, vision read, merged write, agreement
//   apply-carry.sql   install-day UPSERT into clothing_items (replace __STORE_SLUG__)
//
// Node ≥ 23 strips the .ts import's types natively; no build step.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CARRY_CONFIDENCE_KEEP,
  classifyHandbag,
  decideCarryWrite,
  detectCarryModes,
  handlesOnly,
  isHandbagLike,
  normalizeModes,
  parseBagDimensions,
  pickCarryViews,
  strapIsRemovable,
} from "../../app/lib/bag-carry.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? "1"] : [])).filter((x) => x.length),
);
const STORE = (args.store || "lolasaratoga.com").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
const LIMIT = Number(args.limit || 30);
const OFFSET = Number(args.offset || 0);
const MODEL = args.model || "gemini-3.6-flash";
const CONFIDENCE_KEEP = CARRY_CONFIDENCE_KEEP;
const MAX_IMAGES = 8;

function apiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    const yaml = fs.readFileSync(path.join(here, "../../cloud_run_env.yaml"), "utf8");
    const m = yaml.match(/^GEMINI_API_KEY:\s*"?([^"\n]+)"?\s*$/m);
    if (m) return m[1].trim();
  } catch {}
  throw new Error("GEMINI_API_KEY not set and not found in cloud_run_env.yaml");
}

async function fetchCatalog() {
  const out = [];
  for (let page = 1; page <= 12; page++) {
    const res = await fetch(`https://${STORE}/products.json?limit=250&page=${page}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ElloScan/1.0)" },
    });
    if (!res.ok) break;
    const { products } = await res.json();
    if (!products?.length) break;
    out.push(...products);
    if (products.length < 250) break;
  }
  return out;
}

async function downloadImage(src) {
  const sep = src.includes("?") ? "&" : "?";
  try {
    const res = await fetch(`${src}${sep}width=512`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ElloScan/1.0)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return { mime: src.toLowerCase().includes(".png") ? "image/png" : "image/jpeg", b64: buf.toString("base64") };
  } catch {
    return null;
  }
}

const sqlStr = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const sqlArr = (a) => (a?.length ? `ARRAY[${a.map(sqlStr).join(",")}]::text[]` : "NULL");
const sqlJson = (o) => (o == null ? "NULL" : `${sqlStr(JSON.stringify(o))}::jsonb`);

async function main() {
  const key = apiKey();
  const catalog = await fetchCatalog();
  const bags = catalog.filter((p) => isHandbagLike({ title: p.title, productType: p.product_type || "", tags: p.tags || [] }));
  console.log(`${STORE}: ${catalog.length} products, ${bags.length} handbag-like; scanning ${OFFSET}..${Math.min(bags.length, OFFSET + LIMIT)} with ${MODEL}`);

  const results = [];
  let agreeModes = 0, agreeViews = 0, visionKept = 0, dimsAgree = 0, dimsBoth = 0, errors = 0;
  for (const p of bags.slice(OFFSET, OFFSET + LIMIT)) {
    const description = p.body_html || "";
    const tags = p.tags || [];
    const productType = p.product_type || "";
    const parsedDims = parseBagDimensions(description);
    const textBlob = [p.title, productType, tags.join(" "), description].join(" ");
    const textModes = detectCarryModes(textBlob, parsedDims);
    const images = [];
    for (const img of (p.images || []).slice(0, MAX_IMAGES)) {
      const dl = await downloadImage(img.src);
      if (dl) images.push({ url: img.src.split("?")[0], ...dl });
    }
    const t0 = Date.now();
    const cls = images.length ? await classifyHandbag({ apiKey: key, model: MODEL, title: p.title, productType, tags, description, images }) : null;
    const ms = Date.now() - t0;
    if (!cls) errors++;
    const write = decideCarryWrite(cls, textModes, parsedDims, textBlob);
    const views = write ? pickCarryViews(write.carry_modes, write.bag_dimensions, write.carry_meta.handles_only) : [];
    const textViews = pickCarryViews(textModes, parsedDims, handlesOnly(textBlob, parsedDims));
    const vModes = cls?.carry_modes ?? [];
    const sameModes = JSON.stringify(normalizeModes(vModes)) === JSON.stringify(normalizeModes(textModes));
    const sameViews = JSON.stringify(pickCarryViews(vModes, parsedDims, handlesOnly(textBlob, parsedDims))) === JSON.stringify(textViews);
    if (cls && cls.confidence >= CONFIDENCE_KEEP && cls.is_handbag && vModes.length) visionKept++;
    if (sameModes) agreeModes++;
    if (sameViews) agreeViews++;
    if (cls?.dimensions && parsedDims) {
      dimsBoth++;
      const k = ["width_in", "height_in", "depth_in"];
      if (k.every((x) => cls.dimensions[x] == null || parsedDims[x] == null || Math.abs(cls.dimensions[x] - parsedDims[x]) < 0.6)) dimsAgree++;
    }
    const row = {
      handle: p.handle,
      gid: `gid://shopify/Product/${p.id}`,
      title: p.title,
      productType,
      tags,
      price: Number(p.variants?.[0]?.price || 0),
      text: { modes: textModes, views: textViews, dims: parsedDims, strap_removable: strapIsRemovable(textBlob) },
      vision: cls,
      write,
      views,
      ms,
    };
    results.push(row);
    console.log(
      `${String(views.join("|") || "-").padEnd(20)} text=${(textModes.join("+") || "-").padEnd(28)} vision=${(vModes.join("+") || "-").padEnd(28)} conf=${cls?.confidence ?? "-"} dims=${parsedDims ? "P" : "-"}${cls?.dimensions ? "V" : "-"} ${ms}ms  ${p.title}`,
    );
  }

  const n = results.length;
  const summary = {
    store: STORE,
    model: MODEL,
    scanned: n,
    errors,
    vision_kept: visionKept,
    text_vs_vision_modes_agree: agreeModes,
    text_vs_vision_views_agree: agreeViews,
    dims_both: dimsBoth,
    dims_agree: dimsAgree,
    two_view: results.filter((r) => r.views.length === 2).length,
    views: Object.fromEntries(Object.entries(results.reduce((a, r) => ((a[r.views.join("|") || "(none)"] = (a[r.views.join("|") || "(none)"] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1])),
    written: results.filter((r) => r.write).length,
  };
  console.log("\nSUMMARY", JSON.stringify(summary, null, 1));
  fs.writeFileSync(path.join(here, "carry-scan.json"), JSON.stringify({ summary, results }, null, 1));

  // Install-day apply: UPSERT the reviewed rows (clothing_items is an
  // exceptions table — a fresh install has no rows). Never touches manual rows.
  const lines = [
    "-- Handbag carry rows for " + STORE + " — generated " + new Date().toISOString().slice(0, 10) + " by scripts/lola/scan-bags.mjs",
    "-- Replace __STORE_SLUG__ with the store's vto_stores.store_slug after install. Idempotent; manual rows untouched",
    "-- (IS DISTINCT FROM, not <>: a row the install scan parked has carry_source NULL, and NULL <> 'manual' is never true).",
    "INSERT INTO clothing_items (store_id, item_id, name, price, category, data_source, carry_modes, carry_source, bag_dimensions, carry_meta, carry_scan_confidence, print_scanned_at) VALUES",
  ];
  const vals = results.filter((r) => r.write).map((r) =>
    `  ('__STORE_SLUG__', ${sqlStr(r.gid)}, ${sqlStr(r.title || "Product")}, ${r.price || 0}, ${sqlStr(r.productType || "handbag")}, 'shopify', ${sqlArr(r.write.carry_modes)}, 'auto', ${sqlJson(r.write.bag_dimensions)}, ${sqlJson(r.write.carry_meta)}, ${r.write.carry_scan_confidence ?? "NULL"}, now())`,
  );
  lines.push(vals.join(",\n"));
  lines.push("ON CONFLICT (store_id, item_id) DO UPDATE SET");
  lines.push("  carry_modes = EXCLUDED.carry_modes, carry_source = EXCLUDED.carry_source, bag_dimensions = EXCLUDED.bag_dimensions, carry_meta = EXCLUDED.carry_meta,");
  lines.push("  carry_scan_confidence = EXCLUDED.carry_scan_confidence, print_scanned_at = EXCLUDED.print_scanned_at");
  lines.push("WHERE clothing_items.carry_source IS DISTINCT FROM 'manual';");
  fs.writeFileSync(path.join(here, "apply-carry.sql"), lines.join("\n") + "\n");
  console.log(`wrote ${path.join(here, "carry-scan.json")} and apply-carry.sql (${vals.length} rows)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
