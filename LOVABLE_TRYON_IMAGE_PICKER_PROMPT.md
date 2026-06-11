# Lovable Prompt — Per-Product Try-On Image Picker

Paste everything below the line into Lovable. It is written to be self-contained.

---

## Feature

On the product management screen (the list where merchants turn each clothing
item **on/off**), add the ability to choose **which of a product's images is used
as the virtual try-on image**.

Today the try-on always uses the product's **featured image** (first image).
Some products have a flat-lay as their featured image but a much better
on-model shot further down the gallery. Merchants should be able to override the
try-on image per product — but it must stay **optional**, defaulting to the
featured image exactly as it works now.

## Backend is already done — do NOT change it

The `fetch-shopify-products` edge function now returns, for each product:

```ts
{
  item_id: string;            // Shopify GID, e.g. "gid://shopify/Product/123"
  name: string;
  category: string;
  price: number;
  image_url: string | null;   // FEATURED image (images[0]) — the current default
  images: string[];           // NEW: ALL product images (up to 20), order preserved
  image_override_url: string | null; // NEW: currently-selected try-on image, or null
  product_url: string;
  tags: string[];
  active: boolean;
}
```

Persistence is the Supabase table `clothing_items` (the SAME table where the
on/off `active` toggle is stored). A new nullable column already exists:

- `image_override_url text` — `null` means "use the featured image" (default).

The table has a unique constraint on `(store_id, item_id)`, and you already
upsert this table when saving the `active` toggle.

## What to build

For each product row, add a **"Try-on image"** control (a dropdown / popover /
small thumbnail picker — match the existing dashboard style):

1. **Show a thumbnail gallery** of `product.images`. Render each image as a
   selectable thumbnail.
2. **Mark the first image** (`images[0]`, the featured image) with a small
   **"Default"** badge.
3. **Pre-select** the current choice:
   - If `image_override_url` is set, highlight that image as selected.
   - Otherwise highlight `images[0]` (featured) as selected.
4. **On selecting an image:**
   - If the chosen image **is** `images[0]` (the featured image), save
     `image_override_url = null` (i.e. clear the override — back to default).
   - If the chosen image is **any other** image, save
     `image_override_url = <that image url>`.
5. Include a small **"Reset to default"** affordance that sets
   `image_override_url = null`.

## How to save (reuse the existing write path)

Persist using the **exact same mechanism you already use to save the `active`
on/off toggle** to `clothing_items` — an upsert on conflict `(store_id, item_id)`.
Just additionally set the `image_override_url` field. When inserting a brand-new
row, include the fields the table requires (NOT NULL): `store_id`, `item_id`,
`name`, `price`, `category`, and set `data_source = 'shopify'`. You already have
all of these from the product object.

Example upsert payload:

```ts
{
  store_id,                 // current store slug (same value used for the active toggle)
  item_id: product.item_id, // full Shopify GID
  name: product.name,
  price: product.price,
  category: product.category,
  data_source: 'shopify',
  image_override_url: selectedIsFeatured ? null : selectedImageUrl,
}
```

Use `onConflict: 'store_id,item_id'` so it updates the existing row rather than
creating a duplicate.

## Critical constraints (please honor exactly)

- **Do NOT touch `image_url`.** That column / field stays the featured image and
  is the default. You only ever write `image_override_url`.
- **Optional by default.** A product with no override must behave exactly as
  today. Most products should be left on "Default."
- **No bulk requirement.** Merchants set this only on the few products where it
  matters. Don't force a selection.
- Add a one-line helper hint near the control:
  *"Pick the clearest front-facing photo — it's what the try-on renders from."*
- Match existing dashboard visual style, spacing, and loading/save patterns.
  Show a subtle saved/confirmation state consistent with the active toggle.

## Acceptance

- Products show their full image gallery; featured image is badged "Default."
- Selecting a non-featured image saves `image_override_url`; the selection
  persists on reload.
- Selecting the featured image (or "Reset to default") clears the override
  (`image_override_url = null`).
- Existing on/off toggle behavior is unchanged.
