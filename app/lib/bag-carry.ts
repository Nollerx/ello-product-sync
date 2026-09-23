// Handbag carry modes + true-scale dimensions (2026-09-07).
//
// Twin of the engine's bag_carry.py: the same deterministic dimension parser
// and text carry-mode read, plus the Gemini vision classifier the catalogue
// scan runs per handbag. Kept dependency-free (no Supabase import) so the
// pre-install corpus script can load it straight under Node's type stripping.
//
// Contract with the engine: `carry_modes` is a subset of CARRY_MODES; the
// engine picks the two views to render with the same priority as
// pickCarryViews here. Dimensions are inches; the parser reads unlabelled
// triples as W x H x D (luxury-resale convention).
//
// PARITY: every rule here must match bag_carry.py exactly — the Products admin
// labels what this file computes, and shoppers get what the engine computes.
// They drifted once (2026-09-18 strap-length rule shipped engine-only, so the
// admin promised a second view on 57 of Lola Saratoga's bags). Check with
// `node scripts/bag-carry-parity.mjs` after changing either side.

export const CARRY_MODES = ["crossbody", "shoulder", "handheld", "clutch"] as const;
export type CarryMode = (typeof CARRY_MODES)[number];

export interface BagDimensions {
  width_in?: number;
  height_in?: number;
  depth_in?: number;
  handle_drop_in?: number;
  strap_drop_in?: number;
  strap_drop_max_in?: number;
}

// ── Text normalisation ──────────────────────────────────────────────────────
const ENTITIES: Record<string, string> = {
  "&nbsp;": " ", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&apos;": "'",
  "&rsquo;": "'", "&lsquo;": "'", "&rdquo;": '"', "&ldquo;": '"', "&times;": "x",
  "&ndash;": "-", "&mdash;": "-", "&lt;": "<", "&gt;": ">",
};

export function normalizeText(text: string | null | undefined): string {
  if (!text) return "";
  let t = String(text)
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? (e.startsWith("&#") ? String.fromCharCode(Number(e.slice(2, -1))) : " "));
  t = t
    .replace(/[”“″ʺ]/g, '"')
    .replace(/[’‘′]/g, "'")
    .replace(/×/g, "x")
    .replace(/[–—−]/g, "-")
    .replace(/''/g, '"');
  return t.replace(/\s+/g, " ").trim();
}

// ── Dimension parsing ───────────────────────────────────────────────────────
// Fractions too: resellers write '4 7/8" length x 6 3/4" height' (Baghunter).
const NUM = "(\\d+\\s+\\d+/\\d+|\\d+/\\d+|\\d+(?:\\.\\d+)?|\\.\\d+)";
const UNIT = "(?:\\s*(\"|inches\\b|inch\\b|in\\b\\.?|cm\\b|mm\\b))?";
const PAREN = "(?:\\s*\\([^)]{0,40}\\))?";
const LBL = "(width|wide|w|height|high|tall|h|depth|deep|d|length|long|l)";
// Label may sit before the number ("W 30cm") or after it ('16" W').
const LBL_PRE = `(?:\\b${LBL}\\s*[:.=]?\\s*)?`;
const NU_LBL = `${LBL_PRE}${NUM}${UNIT}${PAREN}(?:\\s*${LBL}\\b\\.?)?`;
const SEP = "\\s*(?:x|by|\\*)\\s*";

const SEQ_RE = new RegExp(`${NU_LBL}${SEP}${NU_LBL}(?:${SEP}${NU_LBL})?`, "gi");
// A listing can quote more than one size ('Can fit a phone up to 6" x 3". Measures
// 4" W x 7" H x 1" D' on Lola Saratoga's Celine Phone Pouch). The bag's own size
// is the one the listing introduces as a measurement, or the labelled one.
const MEASURE_CUE_RE = /\b(measures?|measuring|measurements?|dimensions?|size)\b[^.;]{0,25}$/i;
// "chain length 22" is a strap measurement, never the bag's width.
const NOT_STRAP_LEN = "(?<!chain )(?<!strap )(?<!handle )(?<!handles )(?<!drop )";
const LABEL_FIRST_RE = new RegExp(`${NOT_STRAP_LEN}\\b(width|wide|height|tall|depth|deep|length|long)\\s*[:=]?\\s*${NUM}${UNIT}`, "gi");
const LABEL_LETTER_FIRST_RE = new RegExp(`${NOT_STRAP_LEN}\\b(w|h|d|l)\\s*[:=]\\s*${NUM}${UNIT}`, "gi");
const HANDLE_DROP_RES = [
  new RegExp(`${NUM}${UNIT}${PAREN}\\s*(?:top[- ])?handles?\\s+drop`, "i"),
  new RegExp(`handles?\\s+drop\\s*(?:of|:|is|measures)?\\s*(?:a\\s+)?${NUM}${UNIT}`, "i"),
];
const STRAP_DROP_RES = [
  new RegExp(
    `${NUM}${UNIT}${PAREN}(?:\\s*(?:-|to)\\s*${NUM}${UNIT}${PAREN})?\\s*(?:(?:adjustable|detachable|removable|jacquard|leather|chain|shoulder|crossbody|cross-body|canvas|webbing|nylon|fabric|long|short|top)\\s+){0,2}(?:strap|chain|shoulder)\\s+drop`,
    "gi",
  ),
  // 'strap drop: 17"', 'strap drop: 16.5"-17.5"' (a range reads as two settings)
  new RegExp(`(?:strap|chain|shoulder)\\s+drop\\s*(?:of|:|is|measures)?\\s*(?:a\\s+)?${NUM}${UNIT}(?:\\s*(?:-|to)\\s*${NUM}${UNIT})?`, "gi"),
  new RegExp(`(?:strap|chain)\\b[^.;]{0,40}?\\bwith\\s+(?:a\\s+)?${NUM}${UNIT}${PAREN}\\s*drop`, "gi"),
  new RegExp(
    `${NUM}${UNIT}${PAREN}\\s*(?:(?:chain|strap)\\s+drop\\s+)?(?:when\\s+)?(?:doubled|singled|single|fully\\s+extended|extended|at\\s+(?:its\\s+)?(?:longest|shortest))`,
    "gi",
  ),
  // '(doubled 10.5")', 'doubled: 10-11.5"', 'extended to 22"' (number after the word)
  new RegExp(`\\b(?:doubled|singled|fully\\s+extended|extended)\\s*(?:to|at|:)?\\s*${NUM}${UNIT}(?:\\s*(?:-|to)\\s*${NUM}${UNIT})?`, "gi"),
];
const BARE_DROP_RE = new RegExp(`${NUM}${UNIT}${PAREN}\\s*drop\\b`, "gi");
const STRAP_CONTEXT_RE = /\b(strap|chain|shoulder|crossbody|cross-body|sling)\b/i;

const RANGES: Record<keyof BagDimensions, [number, number]> = {
  width_in: [2.5, 36],
  height_in: [2, 30],
  depth_in: [0.2, 20],
  handle_drop_in: [1, 16],
  strap_drop_in: [3, 40],
  strap_drop_max_in: [3, 40],
};
const LABEL_TO_KEY: Record<string, keyof BagDimensions> = {
  width: "width_in", wide: "width_in", w: "width_in", length: "width_in", long: "width_in", l: "width_in",
  height: "height_in", high: "height_in", tall: "height_in", h: "height_in",
  depth: "depth_in", deep: "depth_in", d: "depth_in",
};

// '10.5' -> 10.5, '4 7/8' -> 4.875, '3/4' -> 0.75.
function parseNumber(value: string): number | null {
  const v = (value || "").trim();
  let m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(v);
  if (m) return Number(m[3]) ? Number(m[1]) + Number(m[2]) / Number(m[3]) : null;
  m = /^(\d+)\/(\d+)$/.exec(v);
  if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : null;
  const n = Number(v);
  return v !== "" && Number.isFinite(n) ? n : null;
}

function toInches(value: string, unit: string | undefined, fallback: string): number | null {
  const v = parseNumber(value);
  if (v == null) return null;
  const u = (unit || fallback || "in").toLowerCase().replace(/\.$/, "");
  const out = u.startsWith("cm") ? v / 2.54 : u.startsWith("mm") ? v / 25.4 : v;
  return Math.round(out * 100) / 100;
}

function globalUnitHint(text: string): string {
  if (text.includes('"') || /\b\d+(?:\.\d+)?\s*(?:in|inch|inches)\b/i.test(text)) return "in";
  if (/\b\d+(?:\.\d+)?\s*cm\b/i.test(text)) return "cm";
  return "in";
}

function inRange(key: keyof BagDimensions, v: number | null): v is number {
  if (v == null) return false;
  const [lo, hi] = RANGES[key];
  return v >= lo && v <= hi;
}

export function parseBagDimensions(text: string | null | undefined): BagDimensions | null {
  const t = normalizeText(text);
  if (!t) return null;
  const hint = globalUnitHint(t);
  const out: BagDimensions = {};

  // With several W x H x D sequences, the one the listing calls a measurement
  // wins, then the labelled one, then the fuller one; ties keep the first (a
  // set's main piece is listed before its extras).
  let m: RegExpExecArray | null = null;
  let best = -1;
  SEQ_RE.lastIndex = 0;
  let cand: RegExpExecArray | null;
  while ((cand = SEQ_RE.exec(t))) {
    let nElems = 0;
    let nLabels = 0;
    for (const i of [1, 5, 9]) {
      if (cand[i + 1] == null) continue;
      nElems++;
      if (cand[i] || cand[i + 3]) nLabels++;
    }
    const score =
      (MEASURE_CUE_RE.test(t.slice(Math.max(0, cand.index - 40), cand.index)) ? 4 : 0) +
      (nLabels >= 2 ? 2 : 0) +
      (nElems === 3 ? 1 : 0);
    if (score > best) {
      m = cand;
      best = score;
    }
    if (cand[0] === "") SEQ_RE.lastIndex++;
  }
  if (m) {
    // Each element is 4 groups wide: pre-label, number, unit, post-label.
    const elems: Array<[string, string | undefined, string | undefined]> = [];
    for (const i of [1, 5, 9]) if (m[i + 1] != null) elems.push([m[i + 1], m[i + 2], m[i + 3] || m[i]]);
    const seqUnit = elems.find((e) => e[1])?.[1] ?? hint;
    const positional: Array<keyof BagDimensions> = ["width_in", "height_in", "depth_in"];
    for (const [num, unit, label] of elems) {
      let key: keyof BagDimensions | undefined = label ? LABEL_TO_KEY[label.toLowerCase()] : undefined;
      if (!key || out[key] != null) key = positional.find((k) => out[k] == null);
      if (!key) continue;
      const val = toInches(num, unit, seqUnit);
      if (inRange(key, val)) out[key] = val;
    }
  }

  for (const rx of [LABEL_FIRST_RE, LABEL_LETTER_FIRST_RE]) {
    rx.lastIndex = 0;
    let lm: RegExpExecArray | null;
    while ((lm = rx.exec(t))) {
      const key = LABEL_TO_KEY[lm[1].toLowerCase()];
      if (!key || out[key] != null) continue;
      const val = toInches(lm[2], lm[3], hint);
      if (inRange(key, val)) out[key] = val;
    }
  }

  for (const rx of HANDLE_DROP_RES) {
    const hm = rx.exec(t);
    if (hm) {
      const val = toInches(hm[1], hm[2], hint);
      if (inRange("handle_drop_in", val)) {
        out.handle_drop_in = val;
        break;
      }
    }
  }

  const drops: number[] = [];
  for (const rx of STRAP_DROP_RES) {
    rx.lastIndex = 0;
    let sm: RegExpExecArray | null;
    while ((sm = rx.exec(t))) {
      for (let ni = 1; ni < sm.length; ni += 2) {
        const num = sm[ni];
        if (num == null) continue;
        const val = toInches(num, sm[ni + 1], hint);
        if (inRange("strap_drop_in", val)) drops.push(val);
      }
    }
  }
  if (drops.length === 0 && STRAP_CONTEXT_RE.test(t)) {
    const handleSpans: Array<[number, number]> = [];
    for (const rx of HANDLE_DROP_RES) {
      const hm = rx.exec(t);
      if (hm) handleSpans.push([hm.index, hm.index + hm[0].length]);
    }
    BARE_DROP_RE.lastIndex = 0;
    let bm: RegExpExecArray | null;
    while ((bm = BARE_DROP_RE.exec(t))) {
      const at = bm.index;
      if (handleSpans.some(([s, e]) => s <= at && at < e)) continue;
      const val = toInches(bm[1], bm[2], hint);
      if (inRange("strap_drop_in", val)) drops.push(val);
    }
  }
  if (drops.length) {
    out.strap_drop_in = Math.min(...drops);
    if (Math.max(...drops) > out.strap_drop_in) out.strap_drop_max_in = Math.max(...drops);
  }
  return Object.keys(out).length ? out : null;
}

// ── Carry-mode detection (text only) ────────────────────────────────────────
const STRAP_RE = /\b(shoulder strap|crossbody strap|cross-body strap|adjustable strap|removable strap|detachable strap|chain strap|leather strap|canvas strap|webbing strap|strap drop|shoulder drop|chain drop|shoulder bag|crossbody|cross-body|cross body|messenger|sling)\b/i;
const STRAP_GENERIC_RE = /(?<!wrist )(?<!wrist-)(?<!wristlet )\bstraps?\b/i;
// A wristlet's strap goes round the wrist, not over a shoulder: with wristlet
// language and no shoulder/crossbody evidence, a bare "strap" is not a mode.
const WRISTLET_RE = /\b(wristlet|wristlets|wrist strap|wrist-strap)\b/i;
const CROSSBODY_RE = /\b(crossbody|cross-body|cross body|messenger|sling bag|sling)\b/i;
// A chain that "doubles" for the shoulder and "extends" for the body is worn
// crossbody at full length even a little under the plain-strap threshold
// (Chanel Classic Medium: 9.5" doubled / 16.25" extended).
const EXTENDED_CHAIN_RE = /\b(fully extended|extended|singled|doubled)\b/i;
// A doubling chain crosses the body only from ~20" extended (a Classic Medium's
// 16.25" sits on the shoulder at the hip); plain straps keep the 18" rule.
const CHAIN_CROSSBODY_MIN_IN = 20;
const CROSSBODY_MIN_IN = 18;
// The listing says its strap gets LONGER than the drop it quotes, so that drop
// is one setting, not the longest: "detachable and adjustable long shoulder
// strap" with an 11" drop (LV Pallas MM), 'Adjustable crossbody strap with 10"
// drop' and "Adjust the strap to wear over the shoulder or crossbody" (Tory Burch).
const ADJUSTS_RE = /\badjust(?:able|s|ed)?\b/i;
const LONG_STRAP_RE = /\blong(?:er)?\s+(?:[\w-]+\s+){0,2}?(?:straps?|chains?)\b/i;
const SHOULDER_RE = /\b(shoulder|chain)\b/i;
const HANDHELD_RE = /\b(top[- ]handles?|handles?|handle drop|wristlet|wrist strap|tote|totes|satchel|briefcase|doctor bag|bowler|carryall|shopper)\b/i;
const CLUTCH_RE = /\b(clutch|clutches|pouch|pochette|evening bag|minaudi[eè]re)\b/i;
const REMOVABLE_RE = /\b(removable|detachable|optional)\s+(?:\w+\s+){0,2}(strap|chain)\b/i;

// The measured answer to "can this bag cross the body?": true/false when the
// listing gives a strap or chain drop, null when it gives none (then a
// crossbody tag or name is all there is to go on). A drop is a measurement and
// a tag is a category, so when they disagree the drop wins: Lola Saratoga's
// buyer (2026-09-08) said a Classic Medium's 16.25" chain does not cross the
// body, yet one of her listings is tagged Crossbody, and three identical
// Pallas MMs rendered two different ways by tag alone. The exception is a
// listing that says its strap adjusts longer than the drop it quotes.
export function crossbodyByMeasurement(textBlob: string | null | undefined, dims?: BagDimensions | null): boolean | null {
  const d = dims ?? {};
  const strapMax = d.strap_drop_max_in ?? d.strap_drop_in;
  if (strapMax == null) return null;
  const t = normalizeText(textBlob);
  const doublingChain = EXTENDED_CHAIN_RE.test(t);
  if (strapMax >= (doublingChain ? CHAIN_CROSSBODY_MIN_IN : CROSSBODY_MIN_IN)) return true;
  const keyword = CROSSBODY_RE.test(t);
  if (doublingChain) {
    // Both lengths listed: the extended one is the longest, and it is too short.
    // Only the doubled length listed ('18" adjustable shoulder strap (9.5"
    // doubled)', Hermès Constance): the single length is longer and unlisted.
    return d.strap_drop_max_in != null ? false : keyword;
  }
  return ADJUSTS_RE.test(t) && (keyword || LONG_STRAP_RE.test(t));
}

export function detectCarryModes(textBlob: string | null | undefined, dims?: BagDimensions | null): CarryMode[] {
  const t = normalizeText(textBlob);
  if (!t) return [];
  const d = dims ?? {};
  const strapMin = d.strap_drop_in;
  const hasStrap = STRAP_RE.test(t) || strapMin != null || (STRAP_GENERIC_RE.test(t) && !WRISTLET_RE.test(t));
  const measured = crossbodyByMeasurement(t, d);
  const crossbody = measured == null ? CROSSBODY_RE.test(t) : measured;
  const shoulder = hasStrap && (SHOULDER_RE.test(t) || (strapMin != null && strapMin < 18) || !crossbody);
  const handheld = HANDHELD_RE.test(t) || d.handle_drop_in != null;
  const clutch = CLUTCH_RE.test(t) && !hasStrap && !handheld;
  const modes: CarryMode[] = [];
  if (crossbody) modes.push("crossbody");
  if (shoulder) modes.push("shoulder");
  if (handheld) modes.push("handheld");
  if (clutch) modes.push("clutch");
  return modes;
}

export function strapIsRemovable(textBlob: string | null | undefined): boolean | null {
  const t = normalizeText(textBlob);
  if (!t) return null;
  return REMOVABLE_RE.test(t) ? true : null;
}

export function normalizeModes(raw: unknown): CarryMode[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set(raw.filter((m): m is string => typeof m === "string").map((m) => m.trim().toLowerCase()));
  return CARRY_MODES.filter((m) => seen.has(m));
}

// Explicit strap evidence only: "shoulder bag" / "over the shoulder" do NOT count,
// because a bag with long handles is carried on the shoulder BY ITS HANDLES.
const EXPLICIT_STRAP_RE = /\b(straps?|chain|chains|crossbody|cross-body|cross body|messenger|sling|shoulder drop|strap drop)\b/i;

// The listing describes handles and nothing that reads as a strap: a shoulder
// view then means the handles over the shoulder (Vera Bradley Original 100
// Handbag, 2026-09-10). Mirrors the engine's handles_only.
export function handlesOnly(textBlob: string | null | undefined, dims?: BagDimensions | null): boolean {
  const d = dims ?? {};
  const t = normalizeText(textBlob);
  const hasHandles = d.handle_drop_in != null || HANDHELD_RE.test(t);
  const strapEvidence = d.strap_drop_in != null || d.strap_drop_max_in != null || EXPLICIT_STRAP_RE.test(t);
  return hasHandles && !strapEvidence;
}

// Handles hooked over a shoulder must be long enough to go round it: a 4"
// handle drop (Lola's Gucci Vintage Leather Top Handle Bag) cannot. A handle
// spanning a wide bag is long even at a modest drop (an LV Artsy MM, 16" wide,
// listed at 4.5-5", is a shoulder bag).
const HANDLES_OVER_SHOULDER_MIN_IN = 6;
const WIDE_BAG_IN = 14;
const WIDE_BAG_HANDLE_MIN_IN = 4.5;

export function handlesFitOverShoulder(dims?: BagDimensions | null): boolean {
  const drop = dims?.handle_drop_in;
  if (drop == null || drop >= HANDLES_OVER_SHOULDER_MIN_IN) return true;
  const width = dims?.width_in;
  return drop >= WIDE_BAG_HANDLE_MIN_IN && width != null && width >= WIDE_BAG_IN;
}

export type CarryView = CarryMode | "doubled" | "extended";

export function hasTwoChainLengths(dims?: BagDimensions | null): boolean {
  const lo = dims?.strap_drop_in, hi = dims?.strap_drop_max_in;
  return lo != null && hi != null && hi - lo >= 3;
}

// Mirrors the engine's pick_carry_views: strap + handheld first; crossbody +
// shoulder only when the listing gives a strap setting short enough to be a
// shoulder strap (a crossbody-only strap listed at 22" does not become a purse
// loop because the prompt says so — Andrew, 2026-09-18); a shoulder-only chain
// with two listed drops renders doubled | extended; else the single mode.
// `handlesOnlyBag`: see handlesOnly() — a shoulder view by handles too short
// to go round the shoulder is dropped.
export function pickCarryViews(modes: CarryMode[], dims?: BagDimensions | null, handlesOnlyBag = false): CarryView[] {
  let m = normalizeModes(modes);
  if (handlesOnlyBag && m.includes("shoulder") && !handlesFitOverShoulder(dims)) m = m.filter((x) => x !== "shoulder");
  const strap = (["crossbody", "shoulder"] as const).find((x) => m.includes(x));
  const hand = (["handheld", "clutch"] as const).find((x) => m.includes(x));
  if (strap && hand) return [strap, hand];
  if (m.includes("crossbody") && m.includes("shoulder")) {
    const short = dims?.strap_drop_in;
    const longest = dims?.strap_drop_max_in ?? short;
    if (short != null && short <= 16 && (longest == null || longest > short || short < 18)) return ["crossbody", "shoulder"];
    return ["crossbody"];
  }
  if (strap === "shoulder" && hasTwoChainLengths(dims)) return ["doubled", "extended"];
  if (strap) return [strap];
  if (hand) return [hand];
  return [];
}

// ── Handbag detection from title / type / tags ──────────────────────────────
const HANDBAG_RE = /\b(handbags?|purses?|totes?|satchels?|crossbody|cross-body|hobos?|clutch(?:es)?|pochettes?|bucket bag|camera bag|flap bag|flap|shoulder bag|top[- ]handle|messenger|bags?|wristlets?|baguette|carryall|minaudiere|bowler|doctor bag|saddle bag|belt bag|bum bag|sling|wallet on chain|woc)\b/i;
const SLG_ONLY_RE = /\b(slg|wallets?|card ?holders?|card ?cases?|key ?holders?|key ?pouch(?:es)?|key ?chains?|coin purses?|passport|agenda|phone cases?|cosmetic cases?|makeup cases?|pouch(?:es)?)\b/i;
// A small leather good carried on a chain, strap, wrist strap or handle is a bag
// (a wallet-on-chain is a crossbody bag; a pouch "on Strap" is a shoulder bag).
const SLG_RESCUE_RE = /\b(chain|crossbody|cross-body|strap|shoulder|woc|wallet on chain|wristlet|handles?)\b/i;
const NON_BAG_RE = /\b(jewelry|jewellery|necklaces?|bracelets?|cuffs?|earrings?|rings?|brooch(?:es)?|pendants?|scarf|scarves|shawls?|bandeau|twilly|watch(?:es)?|sunglasses|eyewear|glasses|trunks?|luggage|suitcases?|umbrellas?|keychains?|key rings?|charms?|hats?|belts?|gloves?|gift cards?)\b/i;
const GARMENT_WORDS = [
  "shirt", "shirts", "tee", "tees", "t-shirt", "t-shirts", "hoodie", "hoodies",
  "sweater", "sweaters", "sweatshirt", "jacket", "jackets", "coat", "coats",
  "dress", "dresses", "skirt", "skirts", "pant", "pants", "jean", "jeans",
  "short", "shorts", "legging", "leggings", "top", "tops", "blouse", "tank",
  "sock", "socks", "cap", "hat", "hats", "beanie", "shoe", "shoes", "sneaker",
  "sneakers", "boot", "boots", "sandal", "sandals", "heel", "heels", "loafer", "loafers",
];
const BACKPACK_RE = /\b(backpack|rucksack|knapsack|bookbag|daypack)s?\b/i;

// Whole-word test with the engine's boundary (anything but a-z), so digits and
// punctuation separate words the same way on both sides.
function hasWord(text: string, word: string): boolean {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z])${esc}([^a-z]|$)`).test(text);
}

// ── What the title says the product IS ──────────────────────────────────────
// English compounds put the head noun LAST: a "Tote Bag Tee" is a tee, a
// "Button On Top Flap Bag" is a bag, a "Handbag Pattern Silk Scarf" is a scarf,
// a "Bag Charm" is a charm. So the last category word in the title names the
// product. Model names and bag anatomy that contain category words are
// rewritten first so they cannot pose as one ("Cap-Vert" is a Goyard bag, not a
// cap; "Top-Zip" and "Top Handle" are not tops; "Speedy 25 Bandouliere" is a
// Speedy, not a strap sold alone), and feature clauses ("with Charms", "on
// Strap") never name the product. Built after Lola Saratoga (2026-09-22): six
// real bags were missed this way and a scarf was read as a 34-inch bag.
// Runs on lower-cased, accent-folded text (see fold), so every pattern is ASCII.
const TITLE_REWRITES: Array<[RegExp, string]> = [
  [/\bwallet[- ]on[- ](?:a[- ])?chain\b/g, " woc "],
  [/\b(?:on|with)\s+(?:a\s+|an\s+|its\s+)?(?:[a-z-]+\s+){0,2}?(?:straps?|chains?)\b/g, " "],
  [/\s(?:with\b|w\/).*$/g, " "],
  [/\bdust[- ]?bags?\b/g, " dustbag "],
  [/\b(?:paper|gift)[- ](?:shopping[- ])?bags?\b/g, " giftbag "],
  [/\btop[- ]handles?\b/g, " handle "],
  [/\btop[- ]zip(?:per|ped)?\b/g, " zip "],
  [/\btop[- ]flap\b/g, " flap "],
  [/\bon[- ]top\b/g, " "],
  [/\bcap[- ]vert\b/g, " capvert "],
  [/\b(speedy|keepall|neverfull|noe|alma|carryall|onthego)\b(.*?)\bbandouliere\b/g, "$1$2"],
  [/\b(?:nano|micro|mini|phantom)[- ]luggage\b/g, " bag "],
  [/\bcard[- ]?(holder|case)(s?)\b/g, " card$1$2 "],
  [/\bkey[- ]?(holder|pouch|ring|chain)(s|es)?\b/g, " key$1$2 "],
  [/\bcoin[- ]purses?\b/g, " coinpurse "],
  [/\bphone[- ]cases?\b/g, " phonecase "],
  [/\b(?:cosmetic|make[- ]?up)[- ](?:case|pouch)(?:es|s)?\b/g, " cosmeticcase "],
  [/\bpassport[- ](?:cover|holder|case)s?\b/g, " passport "],
  [/\bgift[- ]?cards?\b/g, " giftcard "],
];
const HEAD_BAG = new Set([
  "bag", "bags", "handbag", "handbags", "purse", "purses", "tote", "totes", "satchel",
  "satchels", "crossbody", "cross-body", "hobo", "hobos", "clutch", "clutches",
  "pochette", "pochettes", "wristlet", "wristlets", "baguette", "baguettes", "carryall",
  "minaudiere", "minaudieres", "bowler", "messenger", "woc", "flap", "sling", "shopper",
  "duffle", "duffel", "weekender", "holdall", "keepall", "briefcase",
]);
const HEAD_SLG = new Set([
  "slg", "wallet", "wallets", "cardholder", "cardholders", "cardcase", "cardcases",
  "keyholder", "keyholders", "keypouch", "keypouches", "coinpurse", "passport", "agenda",
  "phonecase", "cosmeticcase", "pouch", "pouches",
]);
const HEAD_NONBAG = new Set([
  "jewelry", "jewellery", "necklace", "necklaces", "bracelet", "bracelets", "cuff", "cuffs",
  "earring", "earrings", "ring", "rings", "brooch", "brooches", "pendant", "pendants",
  "scarf", "scarves", "shawl", "shawls", "bandeau", "twilly", "twillies", "watch", "watches",
  "sunglasses", "eyewear", "glasses", "trunk", "trunks", "luggage", "suitcase", "suitcases",
  "umbrella", "umbrellas", "keychain", "keychains", "keyring", "keyrings", "charm", "charms",
  "belt", "belts", "glove", "gloves", "giftcard", "strap", "straps", "bandouliere",
  // Things sold alongside bags that are not bags ("Bag Tassel", "Duffel Ornament",
  // "Speedy 30 Organizer Insert", "Hermes Dust Bag").
  "tassel", "tassels", "ornament", "ornaments", "organizer", "organizers", "insert",
  "inserts", "liner", "liners", "shaper", "shapers", "lanyard", "lanyards", "hanger",
  "hangers", "extender", "extenders", "dustbag", "giftbag", "magnet", "magnets",
  "sticker", "stickers",
]);
const HEAD_GARMENT = new Set(GARMENT_WORDS);

export type TitleHead = "bag" | "slg" | "nonbag" | "garment";

// Strip accents ("bandoulière" -> "bandouliere") so ASCII patterns match.
function fold(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

function headKind(word: string): TitleHead | null {
  if (HEAD_BAG.has(word)) return "bag";
  if (HEAD_SLG.has(word)) return "slg";
  if (HEAD_NONBAG.has(word)) return "nonbag";
  if (HEAD_GARMENT.has(word)) return "garment";
  return null;
}

function lastHead(name: string): TitleHead | null {
  const toks = name.match(/[a-z0-9][a-z0-9'-]*/g) ?? [];
  for (let i = toks.length - 1; i >= 0; i--) {
    const tok = toks[i].replace(/^['-]+|['-]+$/g, "");
    let kind = headKind(tok);
    if (kind == null && tok.includes("-")) kind = headKind(tok.slice(tok.lastIndexOf("-") + 1));
    if (kind) return kind;
  }
  return null;
}

// "bag" | "slg" | "nonbag" | "garment" for the LAST category word in the title,
// or null when the title names no category (a model name: "Hermès Birkin 30").
export function titleHead(productTitle: string | null | undefined): TitleHead | null {
  let name = fold((productTitle || "").toLowerCase());
  for (const [rx, rep] of TITLE_REWRITES) name = name.replace(rx, rep);
  // A set names each piece: "Flap Bag & Mini Flap Bag Charm" is sold as a bag.
  const kinds = name.split(/\s(?:&|and|\+)\s/).map(lastHead);
  if (kinds.includes("bag")) return "bag";
  for (let i = kinds.length - 1; i >= 0; i--) if (kinds[i]) return kinds[i];
  return null;
}

// Mirrors the engine's is_handbag: backpacks out (they ride the back-worn
// split); the TITLE decides first by its last category word — a garment or a
// non-bag accessory is out even when a reseller tags it "Handbags", a small
// leather good is out unless a chain, strap, wrist strap or handle makes it a
// bag; a title that names no category falls back to the type and tags.
export function isHandbagLike(p: { title: string; productType: string; tags: string[] }): boolean {
  const title = (p.title || "").toLowerCase();
  const ptype = (p.productType || "").toLowerCase();
  const tags = (p.tags ?? []).join(" ").toLowerCase();
  const blob = [ptype, title, tags].filter(Boolean).join(" ");
  if (!blob) return false;
  if (BACKPACK_RE.test(blob)) return false;
  const head = titleHead(p.title);
  if (head === "bag") return true;
  if (head === "garment" || head === "nonbag") return false;
  if (head === "slg") {
    // A store that files it under a non-bag type ("IDs/Keychains") has decided.
    return !NON_BAG_RE.test(ptype) && SLG_RESCUE_RE.test(`${title} ${tags}`);
  }
  // "Top Handle Bag" as a product type must not trip the garment veto on "top".
  const ptypeHead = ptype.replace(/\btop[- ]handle/g, "handle");
  if (GARMENT_WORDS.some((w) => hasWord(ptypeHead, w))) return false;
  if (NON_BAG_RE.test(ptype)) return false;
  if (SLG_ONLY_RE.test(ptype) && !SLG_RESCUE_RE.test(`${title} ${tags}`)) return false;
  return HANDBAG_RE.test(blob);
}

// ── Gemini vision classifier (catalogue scan) ───────────────────────────────
export const HANDBAG_PROMPT = `You are cataloguing a HANDBAG for a virtual try-on system.
You are shown numbered product photos of ONE bag ("IMAGE 0", "IMAGE 1", ...) plus the listing text (title, tags, description).

1. is_handbag: true if this is a bag carried on the body or in the hand (handbag, purse, tote, satchel, crossbody, shoulder bag, clutch, pochette, wallet-on-chain). false for wallets/card holders/pouches with no strap or handle, luggage, and anything that is not a bag.

2. carry_modes: EVERY way the bag AS SOLD can be carried, judged from the straps and handles you can actually see in the photos or that the listing names:
- "crossbody": a long strap that lets the bag hang across the body (strap drop of roughly 18 inches / 45 cm or more). When the listing states a strap or chain drop, that measurement decides: a shorter drop is NOT crossbody even if the title or tags say crossbody, unless the listing says the strap adjusts longer than the drop it gives. A chain listed at two lengths (doubled / fully extended) is crossbody only if the extended drop is about 20 inches / 51 cm or more.
- "shoulder": a strap or chain that hangs the bag from one shoulder (drop roughly 7-17 inches / 18-43 cm; a doubled chain counts).
- "handheld": top handle(s), a wrist strap, or tote handles the bag is carried by in the hand.
- "clutch": no strap and no handle; carried in the hand as a clutch.
A strap that is removable still counts. Include a mode ONLY if the strap or handle that enables it is present.

3. strap_removable: true if the shoulder/crossbody strap detaches (listing says removable/detachable, or the photos show clip hardware).

4. Photo picks (indexes into the numbered images, -1 if none):
- strap_image_index: the photo that most clearly shows the WHOLE bag with its shoulder/crossbody strap ATTACHED and visible, straight-on, not a detail crop.
- handle_image_index: the photo that most clearly shows the WHOLE bag straight-on by its top handle(s), ideally with the strap detached or out of the way.
If one photo is best for both, use it for both.

5. dimensions: read ONLY from the listing text — never estimate from photos. Convert cm to inches (divide by 2.54). Use null for anything the text does not state.
width_in (side to side), height_in (top to bottom, excluding handles), depth_in, handle_drop_in (top of handle to top of bag), strap_drop_min_in and strap_drop_max_in (shortest and longest strap or chain drop the listing gives; the same value when only one is given).

confidence: 0 to 2 (2 = certain) for carry_modes. Return only the JSON.`;

export const HANDBAG_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    is_handbag: { type: "BOOLEAN" },
    carry_modes: { type: "ARRAY", items: { type: "STRING", enum: [...CARRY_MODES] } },
    strap_removable: { type: "BOOLEAN" },
    confidence: { type: "NUMBER" },
    strap_image_index: { type: "INTEGER" },
    handle_image_index: { type: "INTEGER" },
    dimensions: {
      type: "OBJECT",
      properties: {
        width_in: { type: "NUMBER", nullable: true },
        height_in: { type: "NUMBER", nullable: true },
        depth_in: { type: "NUMBER", nullable: true },
        handle_drop_in: { type: "NUMBER", nullable: true },
        strap_drop_min_in: { type: "NUMBER", nullable: true },
        strap_drop_max_in: { type: "NUMBER", nullable: true },
      },
    },
  },
  required: ["is_handbag", "carry_modes", "confidence", "strap_image_index", "handle_image_index"],
};

export interface HandbagClassification {
  is_handbag: boolean;
  carry_modes: CarryMode[];
  strap_removable: boolean | null;
  confidence: number;
  strap_image_url: string | null;
  handle_image_url: string | null;
  dimensions: BagDimensions | null; // model-read, text-only per the prompt
}

export interface InlineImage {
  url: string; // clean URL (no query) recorded for the pick
  mime: string;
  b64: string;
}

// Same endpoint/retry shape as the tee classifier in print-scan.server.ts.
export async function classifyHandbag(opts: {
  apiKey: string;
  model: string;
  title: string;
  productType?: string;
  tags?: string[];
  description?: string;
  images: InlineImage[];
  fetchImpl?: typeof fetch;
}): Promise<HandbagClassification | null> {
  const f = opts.fetchImpl ?? fetch;
  if (opts.images.length === 0) return null;
  const parts: unknown[] = [
    { text: HANDBAG_PROMPT },
    { text: `Product title: ${opts.title}` },
    { text: `Product type: ${opts.productType || "(none)"}` },
    { text: `Tags: ${(opts.tags ?? []).join(", ") || "(none)"}` },
    { text: `Description: ${normalizeText(opts.description).slice(0, 2000) || "(none)"}` },
  ];
  opts.images.forEach((img, i) => {
    parts.push({ text: `IMAGE ${i}` });
    parts.push({ inline_data: { mime_type: img.mime, data: img.b64 } });
  });
  const body = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: HANDBAG_RESPONSE_SCHEMA,
      temperature: 0,
    },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await f(
        `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${opts.apiKey}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(60000) },
      );
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return null;
      const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) return null;
      const out = JSON.parse(text) as {
        is_handbag?: boolean;
        carry_modes?: string[];
        strap_removable?: boolean | null;
        confidence?: number;
        strap_image_index?: number;
        handle_image_index?: number;
        dimensions?: Record<string, number | null> | null;
      };
      // Photo picks are only trusted from the first few gallery slots: resale
      // galleries lead with full-bag shots and end with detail crops (corners,
      // hardware, interiors), and a detail crop as a reference photo is worse
      // than none. The primary image is never replaced by a pick downstream.
      const MAX_PICK_INDEX = 4;
      const urlAt = (i: number | undefined) =>
        Number.isInteger(i) && (i as number) >= 0 && (i as number) <= MAX_PICK_INDEX && (i as number) < opts.images.length ? opts.images[i as number].url : null;
      const rawDims = out.dimensions ?? null;
      let dims: BagDimensions | null = null;
      if (rawDims && typeof rawDims === "object") {
        const d: BagDimensions = {};
        const take = (k: keyof BagDimensions, src: string) => {
          const v = rawDims[src];
          if (typeof v === "number" && Number.isFinite(v) && inRange(k, Math.round(v * 100) / 100)) d[k] = Math.round(v * 100) / 100;
        };
        take("width_in", "width_in");
        take("height_in", "height_in");
        take("depth_in", "depth_in");
        take("handle_drop_in", "handle_drop_in");
        take("strap_drop_in", "strap_drop_min_in");
        take("strap_drop_max_in", "strap_drop_max_in");
        if (d.strap_drop_max_in != null && d.strap_drop_in != null && d.strap_drop_max_in <= d.strap_drop_in) delete d.strap_drop_max_in;
        dims = Object.keys(d).length ? d : null;
      }
      return {
        is_handbag: out.is_handbag === true,
        carry_modes: normalizeModes(out.carry_modes),
        strap_removable: typeof out.strap_removable === "boolean" ? out.strap_removable : null,
        confidence: Number(out.confidence ?? 0),
        strap_image_url: urlAt(out.strap_image_index),
        handle_image_url: urlAt(out.handle_image_index),
        dimensions: dims,
      };
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null;
}

// A listed drop decides crossbody over a tag for the photo read too: the vision
// prompt is told the same rule, but the text+vision UNION must never re-add a
// crossbody view the measurement rules out. The strap is real (it was read or
// seen), it just does not cross the body, so it becomes a shoulder view.
export function reconcileCarryModes(modes: CarryMode[], dims: BagDimensions | null, textBlob: string): CarryMode[] {
  if (!modes.includes("crossbody") || crossbodyByMeasurement(textBlob, dims) !== false) return modes;
  return normalizeModes([...modes.filter((m) => m !== "crossbody"), "shoulder"]);
}

export const CARRY_CONFIDENCE_KEEP = 1.5;

export interface CarryWrite {
  carry_modes: CarryMode[];
  bag_dimensions: BagDimensions | null;
  carry_meta: {
    strap_image_url: string | null;
    handle_image_url: string | null;
    strap_removable: boolean | null;
    vision_modes: CarryMode[];
    text_modes: CarryMode[];
    // Read from the whole listing at scan time; the engine prefers it over its
    // own read (which only has the description when the widget fetched it).
    handles_only: boolean;
  };
  carry_scan_confidence: number | null;
}

// The vision read decides; the text read is ADDITIVE (a listed strap drop
// proves a strap exists even when every photo shows the bag without it) and is
// the whole answer when the model is unavailable or unsure. A confident "not a
// handbag" (wallet, case) parks the row. Nothing usable → park. One copy, used
// by the install sweep (print-scan.server.ts) and the pre-install script
// (scripts/lola/scan-bags.mjs) alike.
export function decideCarryWrite(
  cls: HandbagClassification | null,
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
  if (cls && cls.confidence >= CARRY_CONFIDENCE_KEEP && !cls.is_handbag) return null;
  if (cls && cls.is_handbag && cls.confidence >= CARRY_CONFIDENCE_KEEP && visionModes.length) {
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
  modes = reconcileCarryModes(modes, dims, textBlob);
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
      handles_only: handlesOnly(textBlob, dims),
    },
    carry_scan_confidence: confidence,
  };
}

// Merge the deterministic parse with the model's read: the parser is the
// authority whenever it finds a field (it never hallucinates); the model only
// fills what the parser missed (odd phrasings).
export function mergeDimensions(parsed: BagDimensions | null, model: BagDimensions | null): BagDimensions | null {
  if (!parsed && !model) return null;
  const out: BagDimensions = { ...(model ?? {}), ...(parsed ?? {}) };
  if (out.strap_drop_max_in != null && out.strap_drop_in != null && out.strap_drop_max_in <= out.strap_drop_in) delete out.strap_drop_max_in;
  return Object.keys(out).length ? out : null;
}
