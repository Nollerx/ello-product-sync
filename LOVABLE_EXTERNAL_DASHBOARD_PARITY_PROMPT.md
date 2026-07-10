# Prompt for dashboard.ello.services — feature parity with the Shopify-native admin

Copy everything below the line into the external dashboard's builder.

---

The Ello VTO Shopify-native admin has shipped several new Widget Design features. This dashboard reads and writes the same Supabase `vto_stores` table, and it needs full parity. Add every feature below that is missing; do not redesign or remove anything that already works.

## Data contract (Supabase `vto_stores`, one row per store)

All of these columns already exist in production. Booleans are real booleans, not strings. When saving, update ONLY the columns listed here and only for the merchant's own store row — never write defaults into columns the merchant hasn't touched, and never touch billing, usage, or attribution columns from this page.

| Column | Type | Default | Meaning |
|---|---|---|---|
| `widget_enabled` | bool | true | Master switch — try-on on/off storewide |
| `widget_primary_color` | text | — | Brand color used across the widget |
| `inline_button_color` | text | — | Inline button background (keep in sync with brand color when the merchant picks one color) |
| `inline_button_text_color` | text | — | Auto-set to black or white by contrast against the button color — do not ask the merchant |
| `inline_button_enabled` | bool | true | "Try On" button on product pages |
| `inline_button_text` | text | "Try On" | Button label, max 24 chars |
| `inline_button_hide_when_oos` | bool | false | Hide button on sold-out products |
| `floating_widget_pdp_enabled` | bool | false | Floating bubble on product pages |
| `floating_widget_non_pdp_enabled` | bool | true | Floating bubble on all other pages |
| `fitting_room_enabled` | bool | true | Launcher-less "Fitting Room" hub (header link / nav entry) |
| `pdp_image_swap_enabled` | bool | **false** | **NEW — "Try-on on the product photo" (the mirror)** |
| `complete_the_look_enabled` | bool | **false** | **NEW — Complete the Look outfit upsell** |
| `widget_position` | text | "right" | Floating bubble corner: left / right |
| `desktop_preview_enabled` | bool | false | Desktop "preview" popup that nudges shoppers to try on |
| `preview_delay_seconds` | int | 3 | Seconds before the preview popup appears |
| `featured_item_id` | text | — | Featured product inside the widget |
| `quick_picks_ids` | json/text | — | Quick-pick products inside the widget |

## Page structure (mirror the native admin)

**1. Status banner (top).** A prominent full-width banner, not a checkbox: green "Try-On is live on your store" or red "Try-On is hidden", with one big Turn on / Turn off button bound to `widget_enabled`.

**2. "Choose your try-on style" — two preset tiles.** Selecting a tile flips the underlying switches; every switch below stays individually adjustable afterward.
- **"On the product page"** — subtitle "No widget — the product photo IS the mirror". Sets: `pdp_image_swap_enabled=true`, `floating_widget_pdp_enabled=false`, `floating_widget_non_pdp_enabled=false`, `inline_button_enabled=true`.
- **"Inside the widget"** — subtitle "The classic Ello experience". Sets: `pdp_image_swap_enabled=false`, `inline_button_enabled=true`, `floating_widget_non_pdp_enabled=true`.
- Which tile shows as active is determined by `pdp_image_swap_enabled` alone.

**3. "Look & feel".** One brand color picker that writes both `widget_primary_color` and `inline_button_color`, and derives `inline_button_text_color` automatically (black or white, whichever is readable). Inline button text field (24-char limit).

**4. "Where shoppers start a try-on"** — independent entry points, each its own toggle with a one-line explanation:
- Inline Try-On button (`inline_button_enabled`, plus text + hide-when-sold-out)
- Floating widget on product pages (`floating_widget_pdp_enabled`) and on other pages (`floating_widget_non_pdp_enabled`), plus corner position
- Fitting Room hub (`fitting_room_enabled`)
- Preview popup (`desktop_preview_enabled` + `preview_delay_seconds`)

**5. "After the try-on — turn looks into orders"** — the two NEW features:
- **Try-on on the product photo** (`pdp_image_swap_enabled`): when a shopper finishes a try-on, the result replaces the product page's main photo in place (the original collapses to a corner thumbnail they can tap to flip back). Explain: this is the "mirror" experience; shoppers buy while looking at themselves.
- **Complete the Look** (`complete_the_look_enabled`): after a try-on lands on the product photo, a small card offers one complementary item — the shopper can layer it onto their photo with one tap and add one or both pieces to cart. Include an explainer box: *"You choose what pairs with what. Ello reads the complementary products you curate in Shopify's free Search & Discovery app. No pairing set → no offer shows → nothing breaks."* Add a deep link to `https://admin.shopify.com/store/{shopHandle}/apps/search-and-discovery` where `{shopHandle}` is `shop_domain` with `.myshopify.com` stripped. Frame the value as raising average order value by selling the outfit instead of the item — do NOT invent statistics or revenue numbers.

**6. "Inside the widget".** Featured item and quick-picks product curation (`featured_item_id`, `quick_picks_ids`) if this dashboard has product pickers; otherwise leave the existing curation UI as is.

## Hard rules

- Both new features default OFF. Merely opening or saving this page must never flip them, and existing stores must see zero behavior change until a merchant explicitly toggles a switch.
- Save only changed fields; no bulk writes across stores.
- Match this dashboard's existing auth and store-scoping exactly — a merchant can only ever read/write their own row.
- Keep the tone of the copy plain and merchant-facing: what the shopper sees, what the merchant controls, one sentence each.
