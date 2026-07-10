-- 20260709_pdp_image_selector.sql
--
-- Merchant-editable CSS selector override for the PDP image swap's hero
-- targeting (the ANTLA-style escape hatch). The widget's automatic cascade
-- (elloFindPdpImage) covers mainstream themes; when a heavily customized theme
-- defeats it, support sets this one field from the dashboard instead of
-- shipping a widget deploy. NULL/empty = cascade only (every existing store
-- byte-for-byte unchanged).
--
--   • vto_stores.pdp_image_selector  → per-store selector (DEFAULT NULL)
--   • get_widget_config              → returns it to the widget loader
--                                      (buildConfigFromRow → pdpImageSelector)
--   • bump_vto_store_config_version  → bumps config_version when it changes
--
-- Safety: purely additive, defaults NULL. The widget treats the selector as a
-- HINT: invalid selector / no match / hidden or tiny target all fall back to
-- the automatic cascade, so a bad value can never kill the swap.

BEGIN;

-- ─── 1. New column ───────────────────────────────────────────────────────────
ALTER TABLE public.vto_stores
  ADD COLUMN IF NOT EXISTS pdp_image_selector TEXT;

-- ─── 2. Expose via get_widget_config ─────────────────────────────────────────
-- Body = the 20260704_ctl_proof_layer definition (current production shape,
-- verified in-repo 2026-07-09) + the one new field. DROP required because the
-- RETURNS TABLE shape changes. Widget reads by name — column order irrelevant.
DROP FUNCTION IF EXISTS public.get_widget_config(text, text);
CREATE FUNCTION public.get_widget_config(p_store_slug text DEFAULT NULL::text, p_shop_domain text DEFAULT NULL::text)
 RETURNS TABLE(store_slug text, shop_domain text, storefront_token text, clothing_population_type text, widget_primary_color text, widget_accent_color text, minimized_color text, featured_item_id text, quick_picks_ids text[], desktop_preview_enabled boolean, preview_delay_seconds integer, preview_theme text, widget_position text, widget_visibility_mode text, inline_button_enabled boolean, inline_button_text text, inline_button_color text, inline_button_text_color text, inline_button_hide_when_oos boolean, floating_widget_pdp_enabled boolean, floating_widget_non_pdp_enabled boolean, fitting_room_enabled boolean, complete_the_look_enabled boolean, pdp_image_swap_enabled boolean, pdp_image_selector text, ctl_holdout_enabled boolean, lead_capture_enabled boolean, lead_capture_after_n integer, config_version bigint)
 LANGUAGE sql
 STABLE
AS $function$
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
         s.pdp_image_selector,
         s.ctl_holdout_enabled,
         s.lead_capture_enabled, s.lead_capture_after_n,
         s.config_version
    FROM vto_stores s
   WHERE (p_store_slug  IS NOT NULL AND s.store_slug  = p_store_slug)
      OR (p_shop_domain IS NOT NULL AND s.shop_domain = p_shop_domain)
   LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.get_widget_config(text, text) TO anon, authenticated, service_role;

-- ─── 3. Bump config_version when the selector changes ────────────────────────
-- Tuple = the 20260629_pdp_image_swap_enabled definition (latest recreation)
-- + pdp_image_selector appended to both sides.
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
      NEW.pdp_image_swap_enabled, NEW.pdp_image_selector,
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
      OLD.pdp_image_swap_enabled, OLD.pdp_image_selector,
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
