-- Per-product try-on image override (additive, backward-compatible).
--
-- Lets a merchant pick which of a product's images is used as the garment
-- reference for the virtual try-on, instead of always using the featured image.
--
-- NULL (default for every existing row) means "use image_url" (the featured
-- image) — i.e. the exact behavior the app had before this column existed.
-- Adding a nullable column with no default is a metadata-only change in
-- Postgres: instant, no table rewrite, no long lock. Safe on a live table.

ALTER TABLE public.clothing_items
  ADD COLUMN IF NOT EXISTS image_override_url text;

COMMENT ON COLUMN public.clothing_items.image_override_url IS
  'Optional merchant-selected product image used as the try-on garment reference. NULL = fall back to image_url (featured). Purely additive; does not change existing behavior.';
