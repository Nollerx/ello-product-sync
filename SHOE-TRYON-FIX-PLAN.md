# Shoe / Footwear Try-On Fix — Implementation Plan

**Owner:** Andrew · **Executor:** Fable · **Scope:** PDP-only (footwear works on its own product page; browse/cross-sell unchanged)

> ## ✅ EXECUTED 2026-07-12 (Fable) — with review hardening
>
> All 4 steps implemented in `public/widget-main.js` + loader version bump (`2.8.1 → 2.8.2`).
> Verified: `node --check`, **62/62 sandbox tests** on extracted source, live browser
> run on the dev harness (5-step SPA scenario, zero console errors). **NOT yet deployed.**
>
> **Deviations from this plan (all improvements, found by a 3-lens adversarial review):**
> 1. **Apparel-veto matcher** — the plan's keyword list false-positived on "Oxford Shirt",
>    "Trainer Jacket", "Slide Shorts", "Waist Trainer", "Boot Socks", "Pump Cover Tee",
>    "Wedge Dress" (Ello's core ICP). Added `ELLO_FOOTWEAR_APPAREL_VETO` (veto beats
>    footwear; "dress shoes" bigram preserved). Trade-off accepted: "Sock Sneakers"
>    reads apparel (conservative = today's behavior).
> 2. **Payload override scoped to `garment.isFallback === true`** — the plan's 4b could
>    label a browse-rail shirt with the shoe PDP's type. Only the og-fallback garment
>    (which IS the page product) ever gets relabeled.
> 3. **Path-keyed context cache + garment page-match guard** — SPA/AJAX themes navigate
>    without reload; the cache now self-invalidates on `location.pathname` change and a
>    stale `elloSelectedGarment` can't vouch for a new page. No dependency on the
>    preview feature's history listeners (gated off on mobile/preview-disabled stores).
> 4. **Two-way copy applier, re-applied at `openWidget()` + route change** — restores
>    clothing copy when navigating shoe→dress; converges late-arriving signals.
> 5. **Kill switch is real**: `style_overrides {"footwear_tryon_enabled": false}` wired in
>    `applyStyleOverrides` (1 SQL, no redeploy), plus `window.ELLO_FOOTWEAR_TRYON=false`.
> 6. Plan step 3a's `.upload-text` element doesn't exist in the served template — the
>    user-visible copy mechanism is the `.photo-instruction` rewrite (label branch kept,
>    harmless). Loading tips use `elloActiveTryonTips()` at all 3 consumer sites.
>
> **Remaining before shoppers see it:** `deploy` (public + custom), purge/verify
> `widget.ellotryon.com` CDN cache, then run the on-store testing checklist below on a
> real shoe PDP (needs a store with a footwear product — dev store has none).

## Goal

When a shopper is on a **footwear product page** and uses try-on, the flow must:
1. Ask for a photo that shows their **feet** (not "full body / shoulders-to-hips").
2. **Not hard-reject** a legs-and-feet photo that lacks a torso.
3. Send the **real footwear product type** to the render engine so the prompt says "a pair of shoes."

The render engine prompt already handles shoes correctly — **do NOT change `ELLO VTOW/main.py`.** All work is in the widget (`public/widget-main.js`) plus one copy touch. The fix is: detect footwear PDP context, then adapt the upload UX, the body check, and the product metadata around it.

---

## Why shoes fail today (root causes, verified)

All references are `public/widget-main.js` unless noted.

1. **Body check demands a torso.** `detectBodyInImage()` (~line 4873) marks a photo "success" only when **both shoulders AND both hips** are detected (~line 4992), and "reject" when neither is found (~line 4987). The only hard block is in `runBackgroundBodyValidation()` (line 2124): `state === 'reject'` → `rejectActivePhotoAfterBodyCheck()` clears the photo. A close photo of legs+feet with no torso gets rejected. Feet/ankles are never considered.

2. **Upload copy tells the wrong thing.** Upload label (line 4054) says *"upload full body image"*; the guidance messages say *"shoulders to hips"* (lines 5002–5006); the tips array (line 6580) says *"Full-body photos usually work better than close crops."* For footwear this steers shoppers away from the exact framing shoes need.

3. **The real footwear category gets lost before it reaches the engine.** `detectCurrentProduct()` (line 1689) resolves the PDP product by matching against `sampleClothing` (lines 1698, 1707, 1723) — but `sampleClothing` is filtered by `isClothingItem()`, which **excludes footwear** (lines 314–318, 410–416). So on a shoe PDP the match fails and it falls to the og-tag fallback (line 1739), which **hardcodes `category: 'clothing'`** (line 1756). That generic category flows into `elloSelectedGarment.category` → the `/tryon` payload `productType` (lines 6482–6484) → the engine's `build_tryon_prompt`, which then emits a generic *"a garment"* descriptor instead of *"a pair of shoes."* (The inline button block only passes `handle`/`id`/`variantId` — `inline-tryon-button.liquid` lines 113–114 — so the widget must supply the category itself.)

---

## Implementation steps (in order)

### Step 1 — Shared footwear-context detector

Add a hoisted helper near `detectCurrentProduct()` (~line 1689) and a keyword constant. It must work **even though footwear is filtered out of `sampleClothing`**, so it reads independent page signals.

```js
// Footwear keywords — mirrors the ELLO_DEMO_BUCKETS 'footwear' set (~line 5692).
var ELLO_FOOTWEAR_KEYWORDS = [
  'shoe','shoes','sneaker','sneakers','boot','boots','heel','heels','sandal','sandals',
  'loafer','loafers','slipper','slippers','trainer','trainers','cleat','cleats','mule',
  'mules','slide','slides','flip flop','flip-flop','flip flops','clog','clogs','footwear',
  'oxford','oxfords','pump','pumps','stiletto','stilettos','wedge','wedges','espadrille','moccasin'
];
// Guard against apparel that CONTAINS a footwear substring but isn't footwear.
var ELLO_FOOTWEAR_FALSE_POSITIVES = ['boot cut','bootcut','boot-cut','board short','boardshort','bootleg'];

function elloTextIsFootwear(text) {
  if (!text) return false;
  var t = ' ' + String(text).toLowerCase() + ' ';
  for (var i = 0; i < ELLO_FOOTWEAR_FALSE_POSITIVES.length; i++) {
    if (t.indexOf(ELLO_FOOTWEAR_FALSE_POSITIVES[i]) !== -1) return false;
  }
  for (var j = 0; j < ELLO_FOOTWEAR_KEYWORDS.length; j++) {
    var w = ELLO_FOOTWEAR_KEYWORDS[j].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('(^|[^a-z])' + w + '([^a-z]|$)').test(t)) return true;
  }
  return false;
}

// True when the CURRENT PDP product is footwear. Prefers product TYPE (cleanest
// signal); title is secondary. Cached per page load.
var __elloFootwearContext = null;
function elloIsFootwearContext() {
  if (__elloFootwearContext !== null) return __elloFootwearContext;
  var result = false;
  try {
    // 1. Shopify analytics meta — present on most PDPs, independent of sampleClothing.
    var metaType = window.ShopifyAnalytics && window.ShopifyAnalytics.meta &&
                   window.ShopifyAnalytics.meta.product && window.ShopifyAnalytics.meta.product.type;
    if (elloTextIsFootwear(metaType)) result = true;

    // 2. The already-selected garment / resolved product, when available.
    if (!result && window.elloSelectedGarment) {
      var g = window.elloSelectedGarment;
      var gtags = Array.isArray(g.tags) ? g.tags.join(' ') : (g.tags || '');
      if (elloTextIsFootwear([g.category, g.product_type, g.name, g.title, gtags].join(' '))) result = true;
    }

    // 3. og:title fallback (matches detectCurrentProduct's own last resort).
    if (!result) {
      var ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle && elloTextIsFootwear(ogTitle.getAttribute('content'))) result = true;
    }
  } catch (e) { /* never let detection throw */ }
  __elloFootwearContext = result;
  return result;
}
```

**Why type-first + false-positive guard:** Shopify `product_type` is usually clean ("Shoes", "Sneakers", "Boots"); titles are noisy. The guard stops "bootcut jeans" / "board shorts" from reading as footwear.

**Acceptance:** On a shoe PDP `elloIsFootwearContext()` returns `true`; on a tee/jeans/dress PDP it returns `false`; "bootcut jeans" returns `false`.

---

### Step 2 — Relax the body-check rejection for footwear

In `runBackgroundBodyValidation()` (line 2124), do not clear the photo on `reject` when in footwear context; show a feet-oriented tip instead.

```js
function runBackgroundBodyValidation(imageDataUrl, photoId) {
  var footwear = elloIsFootwearContext();
  detectBodyInImage(imageDataUrl).then((bodyResult) => {
    if (!isActivePhotoValidation(photoId)) return;

    if (bodyResult && bodyResult.state === 'reject') {
      if (footwear) {
        // Feet/legs close-ups have no torso to detect — accept, don't clear.
        activePhotoValidationStatus = 'valid';
        showSuccessNotification('Quality Tips',
          'For shoes, make sure your feet are fully in the photo.', 4000, false);
        return;
      }
      rejectActivePhotoAfterBodyCheck(photoId);
      return;
    }

    activePhotoValidationStatus = 'valid';
    if (bodyResult && bodyResult.state === 'warning' && bodyResult.message) {
      // In footwear context the "shoulders/hips" warning copy is wrong — swap it.
      var msg = footwear ? 'For best results, keep your feet fully in frame.' : bodyResult.message;
      showSuccessNotification('Quality Tips', msg, 4000, false);
    }
  }).catch((error) => {
    elloLog('Background body validation error:', error);
    if (!isActivePhotoValidation(photoId)) return;
    activePhotoValidationStatus = 'valid';
  });
}
```

**Note:** A legs+hips photo (no shoulders) is already only a `warning`, not a `reject`, so this change only rescues the true feet/legs-only close-up — low blast radius. The inline `validateImageQuality` call at line 4417 already runs with `includeBodyDetection: false`, so no change is needed there.

**Acceptance:** On a shoe PDP, a legs-and-feet photo with no torso is accepted (not cleared) and shows the feet tip. On an apparel PDP, a no-body photo is still rejected.

---

### Step 3 — Footwear upload copy

**3a. Upload label (line 4054).** Make it footwear-aware:

```js
uploadText.textContent = elloIsFootwearContext()
  ? (isMobile ? 'Tap to upload a photo with your feet visible' : 'Click to upload a photo with your feet visible')
  : (isMobile ? 'Tap to upload full body image' : 'Click to upload full body image');
```

**3b. Tips array (line 6580).** The line *"Full-body photos usually work better than close crops."* is counterproductive for shoes. Either branch the tips on `elloIsFootwearContext()` to a footwear set (e.g. *"Stand so your feet and shoes are fully in the shot."*, *"A straight-on photo of your feet works best."*) or filter that one line out in footwear context. Keep it simple — a footwear tip variant is enough.

**Acceptance:** On a shoe PDP the upload prompt references feet; apparel PDPs are unchanged.

---

### Step 4 — Preserve the real footwear category to the engine

Two small changes so `build_tryon_prompt` receives the true type and emits *"a pair of shoes."*

**4a. Fix the og-tag fallback (line 1756)** in `detectCurrentProduct()` — read the real Shopify product type instead of hardcoding `'clothing'`:

```js
var metaType = (window.ShopifyAnalytics && window.ShopifyAnalytics.meta &&
                window.ShopifyAnalytics.meta.product && window.ShopifyAnalytics.meta.product.type) || '';
product = {
  id: productHandle || 'unknown-product',
  name: ogTitle,
  title: ogTitle,
  image_url: ogImage,
  variants: [],
  category: (metaType || 'clothing').toLowerCase(),   // was hardcoded 'clothing'
  product_url: window.location.href,
  isFallback: true
};
```

**4b. Belt-and-suspenders at the payload build (lines 6482–6484).** If footwear context is detected but `productType` is empty/generic, force a footwear type through:

```js
var __resolvedType = garment?.category || garment?.product_type || null;
if (elloIsFootwearContext() && (!__resolvedType || __resolvedType === 'clothing' || __resolvedType === 'apparel')) {
  __resolvedType = (window.ShopifyAnalytics?.meta?.product?.type) || 'shoes';
}
// ...
productTitle: garment?.name || garment?.title || null,
productType: __resolvedType,
productTags: garment?.tags || null,
```

**Verify against the engine:** `_PRODUCT_BUCKETS` in `ELLO VTOW/main.py` (~line 98) maps `shoe/sneaker/boot/footwear/heel/loafer/sandal` → *"a pair of shoes."* Sending any of those (or the literal `"shoes"`) makes the prompt correct. **No engine edit required.**

**Acceptance:** In the `/tryon` request payload (check the Network tab), `productType` on a shoe PDP is the real footwear type, not `"clothing"`. The engine's rendered person is wearing the shoe from the product photo.

---

### Step 5 (optional upgrade) — Positive feet detection

MVP is Steps 1–4. If you want stronger validation later: MoveNet already returns **ankle** keypoints (left/right ankle, indices 15/16). In `detectBodyInImage()`, when footwear context is on, treat "ankles detected" as a positive success signal and only reject when the frame is truly empty. This turns footwear validation from "don't block" into "confirm feet are present." Not required to ship.

---

## Constraints Fable must respect

- **Widget isolation (critical):** `widget-main.js` runs inside an IIFE with scoped state (see the v2.7.15 theme-isolation work). Declare new helpers as **hoisted `function` declarations** and module-scoped `var` (like `detectCurrentProduct`) — **do NOT add new top-level global `let`/`const`**; a global-`let` collision previously broke themes and the widget.
- **Cache-bust:** After editing, **bump the widget version string** (search the file for the current version constant) so browsers and the CDN pull the new build.
- **CDN:** The public app's widget is fronted by `widget.ellotryon.com` (Cloudflare Worker — see `CLOUDFLARE_CDN_DECISION.md`). After deploy, **purge / verify the CDN cache** so shoppers get the new widget.
- **Deploy both apps:** `deploy` pushes public + custom Cloud Run. Verify the shoe flow on both (the custom app points `ML_API_URL` at the Gemini engine).

---

## Testing checklist

Use `?ello_dev=1` on the dev store, or the `/demo` auto-login link.

1. **Footwear detection:** Load a shoe PDP → confirm `elloIsFootwearContext() === true` (console). Load a tee, jeans, and a "bootcut jeans" PDP → all `false`.
2. **Copy:** Shoe PDP upload prompt reads "…feet visible"; apparel PDP still reads "full body".
3. **Body check — rescue:** On a shoe PDP, upload a legs+feet photo with no torso → photo is **kept** (not cleared), feet tip shows.
4. **Body check — regression:** On an apparel PDP, upload a no-body photo (e.g. a landscape) → still **rejected**.
5. **Category to engine:** On a shoe PDP, fire try-on, inspect the `/tryon` request → `productType` is the real footwear type, not `"clothing"`.
6. **Render quality:** With a full-length photo (feet in frame) on a shoe PDP, the result shows the product shoe on the shopper's feet, torso/face/background unchanged.
7. **Apparel regression:** A normal top/dress try-on is visually identical to before (no copy, validation, or payload change on non-footwear).

---

## Rollout / kill-switch

- Detection is conservative (type-first + false-positive guard), so this can ship **on** without a new store-level flag.
- If you want an escape hatch, gate `elloIsFootwearContext()` to also require a runtime flag (e.g. `window.ELLO_FOOTWEAR_TRYON !== false`, default on) so it can be flipped off per-store via the existing style-override / config path without a redeploy.

## Out of scope (deliberate, per Andrew — PDP-only)

- **Do NOT** unhide footwear in the browsable catalog or Complete-the-Look rails (`isClothingItem` at lines 1559, 5646, 5758 stays as-is). Shoes work on their own PDP; they won't appear as browse/upsell suggestions. Revisit separately.
- **Do NOT** modify the engine prompt in `ELLO VTOW/main.py` — it already supports shoes.

## Definition of done

A shopper on a footwear product page is prompted to show their feet, can upload a feet-visible photo without it being rejected, and receives a render with the correct shoe placed on their feet — while every non-footwear try-on behaves exactly as it does today.
