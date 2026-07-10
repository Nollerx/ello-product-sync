-- ============================================================
-- Per-store widget style overrides  (2026-07-10)
--
-- Ops-level knob: vto_stores.style_overrides JSONB, no dashboard UI.
-- Set by support/Claude directly, e.g.:
--
--   UPDATE vto_stores
--      SET style_overrides = '{
--            "hide_section_icons": true,
--            "launcher_stroke_width": 1.5,
--            "launcher_label_weight": 500
--          }'::jsonb
--    WHERE store_slug = '<slug>';
--
-- The version-bump trigger includes the column, so shoppers pick the
-- change up within ~30s (resolved-endpoint cache) with no deploy.
-- Applied by applyStyleOverrides() in public/widget-main.js — see the
-- key reference in docs/widget-style-overrides.md.
--
-- ORDER-PROOF vs 20260710_ab_holdout_proof.sql: both migrations recreate
-- get_widget_config + bump_vto_store_config_version with the FULL superset
-- of each other's fields (this one pre-creates the ab_* columns with
-- identical definitions). Whichever runs last, the final state is identical.
-- ============================================================

ALTER TABLE public.vto_stores ADD COLUMN IF NOT EXISTS style_overrides jsonb;

-- ab_* columns pre-created so the function below compiles even when this
-- migration runs BEFORE 20260710_ab_holdout_proof.sql (identical defs).
ALTER TABLE public.vto_stores ADD COLUMN IF NOT EXISTS ab_experiment_enabled boolean DEFAULT false;
ALTER TABLE public.vto_stores ADD COLUMN IF NOT EXISTS ab_experiment_id uuid;
ALTER TABLE public.vto_stores ADD COLUMN IF NOT EXISTS ab_holdout_percent integer DEFAULT 10;

-- Return-type change requires drop + recreate (transactional, so atomic).
DROP FUNCTION IF EXISTS public.get_widget_config(text, text);
CREATE FUNCTION public.get_widget_config(p_store_slug text DEFAULT NULL::text, p_shop_domain text DEFAULT NULL::text)
RETURNS TABLE(
  store_slug text, shop_domain text, storefront_token text, clothing_population_type text,
  widget_primary_color text, widget_accent_color text, minimized_color text,
  featured_item_id text, quick_picks_ids text[], desktop_preview_enabled boolean,
  preview_delay_seconds integer, preview_theme text, widget_position text,
  widget_visibility_mode text, inline_button_enabled boolean, inline_button_text text,
  inline_button_color text, inline_button_text_color text, inline_button_hide_when_oos boolean,
  floating_widget_pdp_enabled boolean, floating_widget_non_pdp_enabled boolean,
  fitting_room_enabled boolean, complete_the_look_enabled boolean,
  pdp_image_swap_enabled boolean, pdp_image_selector text,
  ctl_holdout_enabled boolean, lead_capture_enabled boolean, lead_capture_after_n integer,
  ab_experiment_enabled boolean, ab_experiment_id uuid, ab_holdout_percent integer,
  style_overrides jsonb,
  config_version bigint
)
LANGUAGE sql STABLE
AS $$
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
         s.ab_experiment_enabled, s.ab_experiment_id, s.ab_holdout_percent,
         s.style_overrides,
         s.config_version
    FROM vto_stores s
   WHERE (p_store_slug  IS NOT NULL AND s.store_slug  = p_store_slug)
      OR (p_shop_domain IS NOT NULL AND s.shop_domain = p_shop_domain)
   LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.get_widget_config(text, text) TO anon, authenticated, service_role;

-- Version-bump trigger: full superset (existing fields + ab_* + style_overrides)
-- so a style_overrides UPDATE busts the loader's localStorage/ETag cache.
CREATE OR REPLACE FUNCTION public.bump_vto_store_config_version()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
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
      NEW.tryon_included_collection_ids,
      NEW.ctl_holdout_enabled, NEW.lead_capture_enabled, NEW.lead_capture_after_n,
      NEW.ab_experiment_enabled, NEW.ab_experiment_id, NEW.ab_holdout_percent,
      NEW.style_overrides)
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
      OLD.tryon_included_collection_ids,
      OLD.ctl_holdout_enabled, OLD.lead_capture_enabled, OLD.lead_capture_after_n,
      OLD.ab_experiment_enabled, OLD.ab_experiment_id, OLD.ab_holdout_percent,
      OLD.style_overrides)
  THEN
    NEW.config_version := COALESCE(OLD.config_version, 0) + 1;
  END IF;
  RETURN NEW;
END;
$function$;

-- Public bucket for merchant brand fonts (and future per-merchant assets).
-- Public read via /storage/v1/object/public/... — fonts need CORS-friendly
-- hosting and Supabase storage serves public objects with ACAO: *.
INSERT INTO storage.buckets (id, name, public)
VALUES ('merchant-assets', 'merchant-assets', true)
ON CONFLICT (id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
