# Lovable Agent Prompt: Widget Placements Settings

## Context

The Ello Virtual Try-On widget can now appear in three places on a merchant's storefront:

1. **Inline button** on product pages — a "Try On" button merchants drop next to Add to Cart via Shopify's theme editor. Highest conversion.
2. **Floating widget** — the existing bottom-corner bubble. Can run on product pages, non-product pages (home, collections, cart), or both.
3. **Preview popup** — a small product preview that slides up on product pages (desktop only).

Merchants need a dashboard page to toggle each surface and configure the inline button's text and colors. All settings live in our Supabase `vto_stores` table; the storefront widget reads them and re-renders within ~60 seconds of any change (cached via `config_version`). No Shopify-app changes are needed for these toggles to take effect.

## Supabase Connection

The dashboard already connects to our Supabase project at `rwmvgwnebnsqcyhhurti.supabase.co`. Use the existing Supabase client.

## Data Source

The `vto_stores` table has these placement columns:

| Column | Type | Default | Notes |
|---|---|---|---|
| `inline_button_enabled` | `BOOLEAN NOT NULL` | `true` | Hard kill switch — when false, the inline button hides even if the merchant has placed the block in their theme. |
| `inline_button_text` | `TEXT NOT NULL` | `'Try On'` | Button label shown to shoppers. Free text, no max length, but encourage ≤ 12 characters. |
| `inline_button_color` | `TEXT` (nullable) | `NULL` | Hex like `'#000000'`. Defaults to black when null. |
| `inline_button_text_color` | `TEXT` (nullable) | `NULL` | Hex like `'#FFFFFF'`. Defaults to white when null. |
| `inline_button_hide_when_oos` | `BOOLEAN NOT NULL` | `false` | Hide the button on out-of-stock products. |
| `floating_widget_pdp_enabled` | `BOOLEAN NOT NULL` | `false` | Show floating bubble on product pages. |
| `floating_widget_non_pdp_enabled` | `BOOLEAN NOT NULL` | `true` | Show floating bubble on home/collections/cart. |
| `desktop_preview_enabled` | `BOOLEAN` | (existing) | Show preview popup on product pages (desktop only). |
| `preview_theme` | `TEXT` | (existing) | `'light'` or `'dark'`. |
| `preview_delay_seconds` | `INT` | (existing) | Seconds after page load before the preview appears. |
| `widget_position` | `TEXT` | (existing) | `'left'` or `'right'` — only applies to the floating widget. |

### Reading

```typescript
const { data, error } = await supabase
  .from('vto_stores')
  .select(`
    inline_button_enabled,
    inline_button_text,
    inline_button_color,
    inline_button_text_color,
    inline_button_hide_when_oos,
    floating_widget_pdp_enabled,
    floating_widget_non_pdp_enabled,
    widget_position,
    desktop_preview_enabled,
    preview_theme,
    preview_delay_seconds
  `)
  .eq('store_slug', storeSlug)
  .single();
```

### Writing

```typescript
const { error } = await supabase
  .from('vto_stores')
  .update({
    inline_button_enabled: true,
    inline_button_text: 'Try It On',
    inline_button_color: '#000000',
    inline_button_text_color: '#FFFFFF',
    inline_button_hide_when_oos: false,
  })
  .eq('store_slug', storeSlug);
```

## UI Requirements

Add a **Widget Placements** page (or section, if a settings page already exists). The page contains three cards — one per surface — stacked vertically.

### Card 1 — Inline Try-On Button

- **Title**: "Inline Try-On Button"
- **Subtitle**: "Recommended — converts 3–10× better than the floating widget. Merchants drag this into their product template via Shopify's theme editor."
- **Master toggle** at the top: "Enable on product pages" — writes `inline_button_enabled`.
- **When toggle is ON, show four sub-controls:**
  1. Text input "Button text" — bound to `inline_button_text`. Placeholder: `Try On`. Max 30 chars (soft).
  2. Color picker "Background color" — bound to `inline_button_color`. Shows current value or `#000000` default.
  3. Color picker "Text color" — bound to `inline_button_text_color`. Shows current value or `#FFFFFF` default.
  4. Checkbox "Hide on out-of-stock products" — bound to `inline_button_hide_when_oos`.
- **Below sub-controls**, a small helper text: "Don't see the button on your storefront? Add it to your theme: open your Shopify theme editor, find the **Ello Inline Try-On** block in the product template, and drag it where you want it (typically under Add to Cart)."
- **Live preview** (nice but not required): a mockup of the button at full width with the current color/text.

### Card 2 — Floating Widget

- **Title**: "Floating Widget"
- **Subtitle**: "The bottom-corner bubble. Useful as a discovery surface on pages without a product."
- **Two checkboxes**:
  1. "Show on product pages" — bound to `floating_widget_pdp_enabled`.
  2. "Show on home, collection, and cart pages" — bound to `floating_widget_non_pdp_enabled`.
- **Position segmented control** (only enabled if either checkbox above is on):
  - "Bottom Left" / "Bottom Right" — bound to `widget_position`. (Already exists as its own card per `LOVABLE_WIDGET_POSITION_PROMPT.md` — feel free to merge.)

### Card 3 — Preview Popup (Desktop only)

- **Title**: "Preview Popup"
- **Subtitle**: "A small product preview that slides up on product pages, inviting shoppers to try the item on. Desktop only — does not appear on mobile."
- **Master toggle**: "Enable on product pages (desktop)" — bound to `desktop_preview_enabled`.
- **When toggle is ON, show two sub-controls:**
  1. Segmented control "Theme" — `light` / `dark` — bound to `preview_theme`.
  2. Number input "Delay before showing" — `1`–`30` seconds — bound to `preview_delay_seconds`. Default `3`.

### Behavior — all cards

1. On mount, read all eleven columns from `vto_stores` in a single query and populate the controls.
2. Each control change:
   - Optimistically updates the local UI.
   - Calls the Supabase update for ONLY the changed field (single-field PATCHes — faster, fewer race conditions).
   - Shows a success toast on first change per session: "Changes appear on your storefront within a minute." (Don't toast on every keystroke for text/color inputs — debounce 500ms and only after the field blurs.)
   - On error, reverts the control to the previous value and shows an error toast.
3. Disable controls only while the request is in flight to prevent rapid double-clicks; allow typing in text/color fields freely.
4. Treat any `null`/missing column as the default per the table above.

## Notes

- The storefront widget caches config briefly (~30s SWR). Tell merchants changes appear "within a minute" — don't promise instant.
- The inline button's hard kill switch (`inline_button_enabled = false`) hides the button even when the merchant has placed the block in their theme. This is intentional — it lets merchants A/B without re-editing their theme.
- The `widget_position` column already has a separate Lovable prompt. If you've already implemented that as its own card, you can either leave it standalone or merge it into Card 2. Don't duplicate the writes.
- The store slug is available from the merchant's login session (same source used by the existing billing page and the existing widget-position card).
- These columns trigger `config_version` bumps via a database trigger — no extra invalidation needed from the dashboard.
