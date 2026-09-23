# Lola Saratoga (lolasaratoga.com) — handbag carry modes + true-scale dims

Preowned luxury handbag reseller (Shopify, Dawn 15.4). ~450 products, ~213
handbag-like (Vintage/Contemporary Handbags + tagged SLGs with chains). The
two things this catalog needed from the widget, built 2026-09-07:

1. **Carry-mode toggle.** Most bags can be worn on a strap AND carried by the
   handles. The engine renders ONE 4:3 generation with two panels (strap view |
   handheld view), slices it, and the widget shows the pill it already uses for
   back-print tees — relabelled from the response (`viewLabels`, e.g.
   "Crossbody | Handheld", "Shoulder | Handheld", "Crossbody | Shoulder" for a
   doubled/extended chain, "Crossbody | Clutch" for a chain pochette).
2. **True scale from the listing.** Every Lola description carries
   `Measures 16" W x 10.5" H x 7" D, with 4.5" handle drop and 13.5" strap drop`
   (three phrasings across the catalog). Parsed deterministically
   (`app/lib/bag-carry.ts` / engine `bag_carry.py` — identical results on all
   213 bags) and turned into body-relative anchors in the prompt ("a little
   wider than their hips", "sits at the hip", "a hand's length below their
   hand"). The image model has no ruler; the anchors are what make a 7" camera
   bag and a 16" tote render at different sizes on the same body.

## Where the data comes from (three layers, best wins)

| Layer | When | Source |
|---|---|---|
| Catalogue scan row (`clothing_items.carry_modes`, `bag_dimensions`, `carry_meta`) | installed stores; kicked at install + on product webhooks | Gemini 3.6-flash vision over up to 8 photos + listing text, unioned with the text read; deterministic dims |
| Listing text at request time (`productDescription`, tags, type from `/products/<handle>.js`) | any Liquid store incl. **bookmarklet demos before install** | widget → proxy → engine `detect_carry_modes` + `parse_bag_dimensions` |
| Nothing | stores with no description | single render, "a bag or purse" as before |

Merchant override: a row with `carry_source = 'manual'` is never touched by a
scan (mirrors `print_side_source`). No admin UI for it yet — set by SQL.

## Pre-install validation (this folder)

`scan-bags.mjs` runs the SAME classifier the install sweep runs, against the
public `products.json`, so a prospect's catalog is validated before install:

```bash
node scripts/lola/scan-bags.mjs --store lolasaratoga.com --limit 60
```

Outputs `carry-scan.json` (per product: text read, vision read, merged write)
and `apply-carry.sql` (install-day UPSERT, replace `__STORE_SLUG__`).

Results 2026-09-07 (first 60 handbag-like products, gemini-3.6-flash):
one classifier timeout (the text read carried that product: shoulder +
handheld), 59/60 confident (conf 2), dims from the regex parser matched the
model's own read 59/59, 49/60 got two views (20 crossbody|shoulder, 15
shoulder|handheld, 13 crossbody|handheld, 1 crossbody|clutch), 10 handheld-only
(Birkins, Fourre Tout), 1 crossbody-only. Text-vs-vision mode disagreements
were 7/60, every one resolved by the union the right way (a listed strap drop
adds the strap view even when the photos show the bag without it; a chain
pochette gained a real "clutch" view). `apply-carry.sql` carries all 60 rows.

Same-day rule change after the Chanel test: a chain the listing describes as
doubled / fully extended counts as crossbody from a 16" extended drop (plain
straps still need 18"), so the untagged Classic Medium Double Flaps (9.5"
doubled / 16.25" extended) get Crossbody | Shoulder like their tagged twins.
Corpus after the change: 162 of 213 two-view, 19 shoulder-only.

## Buyer correction (2026-09-08)

Alison's buyer: a Classic Medium flap's 16.25" extended chain does not go
crossbody on most people, and the drop was being read straight down the torso.
Rules now: a chain described as doubled/extended crosses the body only from
about 20" extended; crossbody placement uses 0.8 x drop for the diagonal; a
shoulder-only chain with two listed drops renders Doubled | Extended (both on
the shoulder). Her listing tags that flap "Crossbody", which still wins at
request time, so on install set the Medium flaps by hand (carry_source =
manual, carry_modes = {shoulder}) like the demo override on ello-dev-store.
**Superseded 2026-09-23:** a listed drop now beats a crossbody tag in the engine
AND the install scan (`crossbody_by_measurement` / `crossbodyByMeasurement`), so
every Medium flap listed at 9.5" doubled / 16.25" extended renders Doubled |
Extended with no manual rows.

## Install day

1. Merchant installs the public app → the install kick scans the catalog on
   its own (`/api/print-scan-sweep?src=install`), handbags included. Verify:
   ```sql
   select count(*) filter (where carry_modes is not null) as bags,
          count(*) filter (where bag_dimensions is not null) as with_dims
   from clothing_items where store_id = '<slug>';
   ```
2. **Loading card corner → bottom-left** (Widget Design → Fine-tuning, or
   `update vto_stores set pdp_loader_corner = 'bottom-left' where store_slug = '<slug>';`).
   Lola's PDPs run Tangiblee, whose "See size" button sits top-right on the
   desktop hero and covers the default top-right loading card / flip-back
   thumbnail (captured 2026-09-22). Bottom-left leaves top-right to Tangiblee
   and top-left to the carry pill, which already picks the first free corner.
3. **Coverage → by collection** (handbags, plus clothing / shoes / jewelry if she
   wants them). The catalog also carries ~62 small leather goods (wallets, card
   cases), trunks and luggage (a $26,995 1920s trunk) and a gift card, and
   nothing in the widget excludes those.
4. Optional: `apply-carry.sql`. It is the 09-07 pre-scan (38 of its 60 bags
   were still listed on 09-22); the install scan writes the same kind of row
   with the current rules. For a fresh file re-run `scan-bags.mjs`: it now uses
   the same `decideCarryWrite` as the install scan and a NULL-safe guard
   (`IS DISTINCT FROM 'manual'`).
5. Smoke test on her live PDPs (expected with the 2026-09-23 engine):
   - LV Monogram Montaigne MM (13.5" strap, tagged Crossbody) → Shoulder | Handheld
   - Chanel Classic Medium Double Flap (the tagged one) → Doubled | Extended
   - LV Monogram Speedy 25 Bandoulière → Shoulder | Handheld
   - Goyard Cap-Vert (PM or Crossbody) → one crossbody view
   - a Birkin → one handheld view; an LV Wristlet → one view, strap round the wrist
   `node scripts/bag-carry-parity.mjs --store lolasaratoga.com` must also pass
   (engine and scan agree listing by listing).

## Capturing the demo as files

`capture-lola-demo.mjs` drives the live bookmarklet on a PDP with Playwright
and writes the hero (with pill), the full page, and both views side by side to
`scripts/lola/captures/`. The in-app Browser pane cannot save files.

```bash
node scripts/lola/capture-lola-demo.mjs "https://lolasaratoga.com/products/<handle>" scripts/lola/captures 1
```

## Demo before install (bookmarklet)

Works today with no rows: the widget reads the description from
`/products/<handle>.js` on the page product and the engine does the text read.
Verified live 2026-09-07 through the custom proxy on the LV Montaigne GM:
`views ["crossbody","handheld"]`, two sliced portraits, 13s render, bag at
hip-width scale. (That predates the 2026-09-23 measured-strap rule: a 13.5"
strap no longer gets a crossbody view, and the Montaigne MM now renders
Shoulder | Handheld, verified live 2026-09-23 on ello-vto-custom-00043, 13.7s.)
