#!/usr/bin/env node
/* eslint-env node */
// Parity check: app/lib/bag-carry.ts (install scan + Products admin) against the
// engine's bag_carry.py (what shoppers actually get). The two drifted once — the
// 2026-09-18 strap-length rule shipped engine-only, so the admin promised a
// second view on 57 of Lola Saratoga's bags that shoppers never saw. Run after
// changing either side; exits 1 on any disagreement.
//
//   node scripts/bag-carry-parity.mjs                       # built-in edge cases
//   node scripts/bag-carry-parity.mjs --store lolasaratoga.com --store www.verabradley.com
//   ENGINE_DIR=/path/to/engine node scripts/bag-carry-parity.mjs
//
// Node >= 23 strips the .ts import's types natively; the engine side runs under
// python3 with ENGINE_DIR on its path (default ~/Desktop/ELLO VTOW).
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  crossbodyByMeasurement,
  detectCarryModes,
  handlesOnly,
  isHandbagLike,
  parseBagDimensions,
  pickCarryViews,
  titleHead,
} from "../app/lib/bag-carry.ts";

const ENGINE_DIR = process.env.ENGINE_DIR || path.join(os.homedir(), "Desktop", "ELLO VTOW");
const stores = process.argv.flatMap((a, i, arr) => (a === "--store" && arr[i + 1] ? [arr[i + 1]] : []));

// Listings that pin each rule (title, type, tags, description).
const EDGE_CASES = [
  ["Louis Vuitton Monogram Speedy 25 Bandoulière", "Vintage Handbags", ["Shoulder Bag"], 'Features dual rolled top handles and detachable and adjustable leather strap. Measures 10” W x 7” H x 6" D, with 3.5" handle drop.'],
  ["Goyard Burgundy Cap-Vert PM", "Vintage Handbags", ["Crossbody"], 'Adjustable shoulder strap. Measures 9" W x 5" H x 3" D, with 19-21" strap drop.'],
  ["Chanel Button On Top Flap Bag", "Vintage Handbags", ["Shoulder Bag"], 'Leather-woven chain top handle and long strap. Measures 9.25" W x 6.75" H x 3" D, with 5.25" handle drop and 16" strap drop.'],
  ["Tory Burch Mercer Pebbled Top-Zip Crossbody", "Contemporary Handbags", [], "Removable, adjustable crossbody strap."],
  ["Gucci Vintage Ivory Pouch on Strap", "Vintage Handbags", ["Crossbody"], 'Leather shoulder strap. Measures 9” W x 6.25” H x 2” D, with 19.5” strap drop.'],
  ["Celine Handbag Pattern Silk Scarf 90", "Vintage Accessories", ["scarf"], 'Silk scarf with handbag motifs. Measures 34" x 34".'],
  ["Tote Bag Tee", "T-Shirts", [], "Soft cotton tee."],
  ["Original Tote Bag Charm", "IDs/Keychains", [], ""],
  ["Zip ID Pouch w/Breakaway Lanyard", "IDs/Keychains", ["Crossbody"], ""],
  ["Pre-owned Chanel Medium Flap Bag & Mini Flap Bag Charm", "Handbags", [], ""],
  ["Chanel Classic Medium Double Flap", "Vintage Handbags", ["Crossbody", "Shoulder Bag"], 'A leather woven chain strap that can be worn singled or doubled. Measures 10" W x 6" H x 2.5" D with a 9.5" chain drop when doubled, and a 16.25" chain drop when fully extended.'],
  ["Louis Vuitton Monogram Pallas MM", "Vintage Handbags", ["Shoulder Bag"], 'Dual rolled top handles and detachable and adjustable long shoulder strap. Measures 14" W x 10" H x 6" D, with 4" handle drop, 11" strap drop.'],
  ["Hermès Box Calf Kelly 28 Noir", "Vintage Handbags", ["Crossbody"], 'Single rolled top handle and detachable shoulder strap. Measures 11.25" W x 8" H x 4" D, with 3.75" handle drop and 17.25” strap drop.'],
  ["Hermes Constance 1-24 Etoupe", "Handbags", ["Crossbody"], 'Adjustable shoulder strap. Measurements: 9.5" width x 7" height x 3" depth; 18" adjustable shoulder strap (9.5" doubled)'],
  ["Chanel Maxi Souplissimo Large Flap Bag", "Handbags", ["chanel crossbody"], 'Measurements: 15.25 " width x 10" height x 4" depth; strap drop: 16.5"-17.5" (doubled 10-11.5")'],
  ["Celine Black Leather Phone Pouch", "Vintage Handbags", ["Crossbody"], 'Can fit a phone up to 6" x 3". Measures 4" W x 7" H x 1" D, with 20" strap drop.'],
  ["Chanel Jerry Can Bag", "Chanel", [], 'Measures : 4 7/8" length x 6 3/4" height x 2" width x 20" strap height'],
  ["Gucci Vintage Leather Top Handle Bag", "Vintage Handbags", ["Shoulder Bag"], 'Dual rolled top handles. Measures 10" W x 7" H x 4.5" D with 4" handle drop.'],
  ["Louis Vuitton Monogram Artsy MM", "Vintage Handbags", ["Shoulder Bag", "hobo bag"], 'Braided leather top handle. Measures 16" W x 12" H x 6" D with a 4.5" handle drop.'],
  ["Louis Vuitton Damier Azur Wristlet", "Vintage SLG", ["Wristlet"], 'Semi-detachable wristlet strap. Measures 9.5" W x 6" H.'],
  ["Tory Burch Miller Swing Crossbody Bag", "Contemporary Handbags", [], 'Adjustable crossbody strap with 10" (25.5cm) drop. Height: 6.7" (17cm); length: 6.8" (17.3cm); depth: 2.6" (6.5cm)'],
  ["Hermès Blue Jean Birkin 35cm Bag PHW", "Hermes Birkin 35", [], ""],
  ["Chanel Micro Top Handle Round Hobo Pouch Black", "Handbags", [], ""],
];

// What each edge case must come out as (bag? and the views shoppers get).
// These are the Lola Saratoga audit calls (2026-09-22) plus the resellers used
// to regression-test them; change one only with a reason in the commit.
const EXPECT = {
  "Louis Vuitton Monogram Speedy 25 Bandoulière": [true, "shoulder|handheld"],
  "Goyard Burgundy Cap-Vert PM": [true, "crossbody"],
  "Chanel Button On Top Flap Bag": [true, "shoulder|handheld"],
  "Tory Burch Mercer Pebbled Top-Zip Crossbody": [true, "crossbody"],
  "Gucci Vintage Ivory Pouch on Strap": [true, "crossbody"],
  "Celine Handbag Pattern Silk Scarf 90": [false, ""],
  "Tote Bag Tee": [false, ""],
  "Original Tote Bag Charm": [false, ""],
  "Zip ID Pouch w/Breakaway Lanyard": [false, ""],
  "Pre-owned Chanel Medium Flap Bag & Mini Flap Bag Charm": [true, ""],
  "Chanel Classic Medium Double Flap": [true, "doubled|extended"],
  "Louis Vuitton Monogram Pallas MM": [true, "crossbody|handheld"],
  "Hermès Box Calf Kelly 28 Noir": [true, "shoulder|handheld"],
  "Hermes Constance 1-24 Etoupe": [true, "crossbody|shoulder"],
  "Chanel Maxi Souplissimo Large Flap Bag": [true, "doubled|extended"],
  "Celine Black Leather Phone Pouch": [true, "crossbody"],
  "Gucci Vintage Leather Top Handle Bag": [true, "handheld"],
  "Louis Vuitton Monogram Artsy MM": [true, "shoulder|handheld"],
  "Louis Vuitton Damier Azur Wristlet": [true, "handheld"],
  "Tory Burch Miller Swing Crossbody Bag": [true, "crossbody|shoulder"],
  "Hermès Blue Jean Birkin 35cm Bag PHW": [true, ""],
  "Chanel Micro Top Handle Round Hobo Pouch Black": [true, "handheld"],
};
const EXPECT_DIMS = {
  "Celine Black Leather Phone Pouch": { width_in: 4, height_in: 7 },
  "Chanel Jerry Can Bag": { width_in: 4.88, height_in: 6.75 },
};

async function fetchStore(host) {
  const out = [];
  for (let page = 1; page <= 12; page++) {
    const res = await fetch(`https://${host}/products.json?limit=250&page=${page}`, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) break;
    const { products } = await res.json();
    if (!products?.length) break;
    for (const p of products) {
      const tags = Array.isArray(p.tags) ? p.tags : String(p.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
      out.push([p.title, p.product_type || "", tags, p.body_html || ""]);
    }
  }
  return out;
}

function tsRead([title, type, tags, desc]) {
  const bag = isHandbagLike({ title, productType: type, tags });
  const dims = parseBagDimensions(desc);
  const blob = [title, type, tags.join(" "), desc].join(" ");
  const modes = bag ? detectCarryModes(blob, dims) : [];
  const ho = bag ? handlesOnly(blob, dims) : false;
  return {
    head: titleHead(title),
    bag,
    dims,
    measured: bag ? crossbodyByMeasurement(blob, dims) : null,
    modes,
    handles_only: ho,
    views: bag ? pickCarryViews(modes, dims, ho) : [],
  };
}

const PY = `
import json, sys
sys.path.insert(0, sys.argv[1])
import bag_carry as bc
out = []
for title, ptype, tags, desc in json.load(sys.stdin):
    bag = bc.is_handbag(title, ptype, tags)
    dims = bc.parse_bag_dimensions(desc)
    blob = " ".join([title, ptype, " ".join(tags), desc])
    modes = bc.detect_carry_modes(blob, dims) if bag else []
    ho = bc.handles_only(blob, dims) if bag else False
    out.append({
        "head": bc.title_head(title), "bag": bag, "dims": dims,
        "measured": bc.crossbody_by_measurement(blob, dims) if bag else None,
        "modes": modes, "handles_only": ho,
        "views": bc.pick_carry_views(modes, dims, ho) if bag else [],
    })
json.dump(out, sys.stdout)
`;

function sameDims(a, b) {
  const ka = Object.keys(a || {}).sort(), kb = Object.keys(b || {}).sort();
  if (ka.join() !== kb.join()) return false;
  // Python rounds half-to-even, JS half-up: an exact .xx5 may differ by 0.01.
  return ka.every((k) => Math.abs(a[k] - b[k]) <= 0.011);
}

const listings = [...EDGE_CASES];
for (const host of stores) {
  const got = await fetchStore(host);
  console.log(`${host}: ${got.length} products`);
  listings.push(...got);
}
const py = spawnSync("python3", ["-c", PY, ENGINE_DIR], { input: JSON.stringify(listings), maxBuffer: 256 * 1024 * 1024 });
if (py.status !== 0) {
  console.error(String(py.stderr));
  process.exit(2);
}
const engine = JSON.parse(String(py.stdout));
let diffs = 0;
listings.forEach((l, i) => {
  const t = tsRead(l), p = engine[i];
  const bad = [];
  for (const k of ["head", "bag", "measured", "handles_only"]) if (t[k] !== p[k]) bad.push(`${k}: ts=${t[k]} py=${p[k]}`);
  if (!sameDims(t.dims, p.dims)) bad.push(`dims: ts=${JSON.stringify(t.dims)} py=${JSON.stringify(p.dims)}`);
  for (const k of ["modes", "views"]) if (t[k].join("|") !== p[k].join("|")) bad.push(`${k}: ts=${t[k].join("|")} py=${p[k].join("|")}`);
  if (bad.length) {
    diffs++;
    if (diffs <= 40) console.log(`DIFF ${JSON.stringify(l[0])}\n   ${bad.join("\n   ")}`);
  }
});
let wrong = 0;
EDGE_CASES.forEach((l) => {
  const t = tsRead(l);
  const want = EXPECT[l[0]];
  if (want && (t.bag !== want[0] || t.views.join("|") !== want[1])) {
    wrong++;
    console.log(`WRONG ${JSON.stringify(l[0])}: got bag=${t.bag} views=${t.views.join("|") || "-"}, want bag=${want[0]} views=${want[1] || "-"}`);
  }
  for (const [k, v] of Object.entries(EXPECT_DIMS[l[0]] ?? {})) {
    if (Math.abs((t.dims?.[k] ?? NaN) - v) > 0.011 || Number.isNaN(t.dims?.[k] ?? NaN)) {
      wrong++;
      console.log(`WRONG ${JSON.stringify(l[0])}: ${k}=${t.dims?.[k]}, want ${v}`);
    }
  }
});
console.log(`${listings.length} listings compared (${EDGE_CASES.length} edge cases), ${diffs} disagreement(s), ${wrong} wrong expected result(s)`);
process.exit(diffs || wrong ? 1 : 0);
