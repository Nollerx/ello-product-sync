-- 20260629_pdp_image_swap_enabled.sql
--
-- Dashboard on/off switch for the PDP image-swap hub — the "real enablement"
-- stage the fitting_room / complete_the_look migrations anticipated (until now
-- it was trial-only via the ?ello_pdp_swap=1 URL override). When ON, a try-on
-- replaces the product page's main photo with the result (mirror), instead of
-- staying inside the widget.
--
--   • vto_stores.pdp_image_swap_enabled  → per-store on/off (DEFAULT false)
--   • get_widget_config                  → returns the flag to the widget loader
--                                          (loader already reads it: buildConfigFromRow
--                                           → pdpImageSwapEnabled === true)
--   • bump_vto_store_config_version      → bumps config_version when it changes
--
-- Safety: purely additive and defaults FALSE, so every existing store is
-- byte-for-byte unchanged until a merchant opts in. Mirrors the fitting_room /
-- complete_the_look kill-switch pattern.
--
-- Self-contained / order-independent: also ensures complete_the_look_enabled
-- exists (IF NOT EXISTS) so this recreates get_widget_config with the full flag
-- set whether or not 20260628_complete_the_look_enabled.sql ran first. Both
-- column-adds are idempotent.

BEGIN;

-- ─── 1. New column (+ ensure the CTL column exists so the function below is
--         valid regardless of migration order) ─────────────────────────────
ALTER TABLE public.vto_stores
  ADD COLUMN IF NOT EXISTS complete_the_look_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.vto_stores
  ADD COLUMN IF NOT EXISTS pdp_image_swap_enabled BOOLEAN NOT NULL DEFAULT false;

-- ─── 2. Expose the flag to the widget via get_widget_config ─────────────────
-- Recreate the function (from 20260628_complete_the_look_enabled) with
-- pdp_image_swap_enabled added. DROP required because the RETURNS TABLE shape
-- changes. Column order is irrelevant — the widget reads by name.
DROP FUNCTION IF EXISTS get_widget_config(TEXT, TEXT);

CREATE OR REPLACE FUNCTION get_widget_config(
  p_store_slug  TEXT DEFAULT NULL,
  p_shop_domain TEXT DEFAULT NULL
) RETURNS TABLE (
  store_slug                      TEXT,
  shop_domain                     TEXT,
  storefront_token                TEXT,
  clothing_population_type        TEXT,
  widget_primary_color            TEXT,
  widget_accent_color             TEXT,
  minimized_color                 TEXT,
  featured_item_id                TEXT,
  quick_picks_ids                 TEXT[],
  desktop_preview_enabled         BOOLEAN,
  preview_delay_seconds           INT,
  preview_theme                   TEXT,
  widget_position                 TEXT,
  widget_visibility_mode          TEXT,
  inline_button_enabled           BOOLEAN,
  inline_button_text              TEXT,
  inline_button_color             TEXT,
  inline_button_text_color        TEXT,
  inline_button_hide_when_oos     BOOLEAN,
  floating_widget_pdp_enabled     BOOLEAN,
  floating_widget_non_pdp_enabled BOOLEAN,
  fitting_room_enabled            BOOLEAN,
  complete_the_look_enabled       BOOLEAN,
  pdp_image_swap_enabled          BOOLEAN,
  lead_capture_enabled            BOOLEAN,
  lead_capture_after_n            INT,
  config_version                  BIGINT
) LANGUAGE sql STABLE AS $$
  SELECT s.store_slug, s.shop_domain, s.storefront_token, s.clothing_population_type,
         s.widget_primary_color, s.widget_accent_color, s.minimized_color,
         s.featured_item_id, s.quick_picks_ids, s.desktop_preview_enabled,
         s.preview_delay_seconds, s.preview_theme, s.widget_position,
         s.widget_visibility_mode,
         s.inline_button_enabled, s.inline_button_text, s.inline_button_color,
         s.inline_button_text_color, s.inline_button_hide_when_oos,
         s.floating_widget_pdp_enabled, s.floating_widget_non_pdp_enabled,
         s.fitting_room_enabled,
         s.complete_the_look_enabled,
         s.pdp_image_swap_enabled,
         s.lead_capture_enabled, s.lead_capture_after_n,
         s.config_version
    FROM vto_stores s
   WHERE (p_store_slug  IS NOT NULL AND s.store_slug  = p_store_slug)
      OR (p_shop_domain IS NOT NULL AND s.shop_domain = p_shop_domain)
   LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION get_widget_config(TEXT, TEXT) TO anon, authenticated, service_role;

-- ─── 3. Bump config_version when the flag changes ───────────────────────────
-- Recreate the trigger body (from 20260628_complete_the_look_enabled) with
-- pdp_image_swap_enabled appended to both tuples, so toggling it bumps
-- config_version and storefronts re-fetch within the SWR window.
CREATE OR REPLACE FUNCTION bump_vto_store_config_version() RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.widget_primary_color, NEW.widget_accent_color, NEW.minimized_color,
      NEW.featured_item_id, NEW.quick_picks_ids, NEW.desktop_preview_enabled,
      NEW.preview_delay_seconds, NEW.preview_theme, NEW.widget_position,
      NEW.widget_visibility_mode, NEW.clothing_population_type,
      NEW.storefront_token, NEW.shop_domain,
      NEW.inline_button_enabled, NEW.inline_button_text, NEW.inline_button_color,
      NEW.inline_button_text_color, NEW.inline_button_hide_when_oos,
      NEW.floating_widget_pdp_enabled, NEW.floating_widget_non_pdp_enabled,
      NEW.fitting_room_enabled, NEW.complete_the_look_enabled,
      NEW.pdp_image_swap_enabled,
      NEW.tryon_targeting_mode, NEW.tryon_included_product_ids,
      NEW.tryon_included_collection_ids)
     IS DISTINCT FROM
     (OLD.widget_primary_color, OLD.widget_accent_color, OLD.minimized_color,
      OLD.featured_item_id, OLD.quick_picks_ids, OLD.desktop_preview_enabled,
      OLD.preview_delay_seconds, OLD.preview_theme, OLD.widget_position,
      OLD.widget_visibility_mode, OLD.clothing_population_type,
      OLD.storefront_token, OLD.shop_domain,
      OLD.inline_button_enabled, OLD.inline_button_text, OLD.inline_button_color,
      OLD.inline_button_text_color, OLD.inline_button_hide_when_oos,
      OLD.floating_widget_pdp_enabled, OLD.floating_widget_non_pdp_enabled,
      OLD.fitting_room_enabled, OLD.complete_the_look_enabled,
      OLD.pdp_image_swap_enabled,
      OLD.tryon_targeting_mode, OLD.tryon_included_product_ids,
      OLD.tryon_included_collection_ids)
  THEN
    NEW.config_version := COALESCE(OLD.config_version, 0) + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── 4. Cache-bust existing rows so widgets re-fetch with the new field ─────
UPDATE public.vto_stores SET config_version = COALESCE(config_version, 0) + 1;

COMMIT;

NOTIFY pgrst, 'reload schema';
