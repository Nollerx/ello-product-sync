# Per-Store Widget Style Overrides

Ops-level styling knob for enterprise/branding requests ("remove the icons,
match our font, make the launcher thinner"). No dashboard UI — set directly on
`vto_stores.style_overrides` (JSONB) in Supabase. The version-bump trigger
includes the column, so shoppers pick changes up within ~30s. **No deploy per
merchant.**

Applied by `applyStyleOverrides()` in `public/widget-main.js`. All rules are
scoped under `#virtual-tryon-widget-container` and carry `!important`.

## Setting overrides

```sql
UPDATE vto_stores
   SET style_overrides = '{
         "hide_section_icons": true,
         "launcher_stroke_width": 1.5,
         "launcher_label_weight": 500
       }'::jsonb
 WHERE store_slug = '<slug>';   -- or shop_domain = '<domain>.myshopify.com'
```

Clear with `SET style_overrides = NULL`. Merge a single key without touching
the rest: `SET style_overrides = COALESCE(style_overrides,'{}'::jsonb) || '{"key":value}'::jsonb`.

## Supported keys

| Key | Type | Default | What it does |
|---|---|---|---|
| `hide_section_icons` | boolean | false | Hides the star/flame SVGs in "Featured Today" / "Trending" |
| `hide_emojis` | boolean | false | Strips decorative emoji (📷 ✨ 👕 📸 🖼️ …) from all widget text via a scoped MutationObserver; functional marks (✓ ✕ ➜) survive |
| `launcher_stroke_width` | number (0–6] | 2.2 | Hanger icon stroke weight on the minimized bubble (1.5 = thin) |
| `launcher_label_weight` | number 100–900 | 800 | Hover "Virtual Try-On" label font-weight (400–500 = thin) |
| `launcher_label_transform` | string | uppercase | `none` / `uppercase` / `lowercase` / `capitalize` |
| `launcher_label_spacing` | string | 0.6px | letter-spacing, e.g. `"0.2px"` |
| `launcher_label_text` | string ≤40 | Virtual Try-On | Replace the hover label text (quotes stripped) |
| `font_family` | string | Poppins | Widget-wide font name; pair with `font_url` |
| `font_url` | https URL | — | woff2/woff/otf/ttf for the `@font-face`; host in the `merchant-assets` bucket |
| `font_inherit` | boolean | false | Inherit the merchant theme's body font (ignored if `font_family` set) |
| `custom_css` | string ≤20KB | — | Raw CSS escape hatch. **Ops-authored only, never merchant input.** Scope selectors under `#virtual-tryon-widget-container`. |

## Hosting a merchant font

Public bucket `merchant-assets` (created by `20260710_style_overrides.sql`).
Upload with the service key (from `.env`):

```bash
curl -X POST "$SUPABASE_URL/storage/v1/object/merchant-assets/fonts/<brand>-<name>.woff2" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: font/woff2" \
  --data-binary @font-file.woff2
```

Public URL for `font_url`:
`$SUPABASE_URL/storage/v1/object/public/merchant-assets/fonts/<brand>-<name>.woff2`

Prefer woff2 (convert ttf/otf: `pip install fonttools brotli` →
`fonttools ttLib.woff2 compress font.ttf`). Confirm the merchant's font license
permits web embedding before hosting.

## Rollout notes

- Requires the `20260710_style_overrides.sql` migration AND a widget deploy
  (both Cloud Run services) — one-time; after that every store is SQL-only.
- Old deployed widgets ignore the extra RPC column — fully backward compatible.
- Order-proof vs `20260710_ab_holdout_proof.sql`: both recreate
  `get_widget_config` + the version trigger with the full superset.
- Verify on the storefront with a hard refresh (reload detection busts the
  loader's localStorage cache) or `?ello_preview=1`.
