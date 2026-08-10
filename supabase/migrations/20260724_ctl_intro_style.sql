-- Complete the Look intro style: how the upsell first appears over the hero.
-- 'pairing' | 'whisper' | 'drop'; NULL = legacy full-width card (no visual
-- change for existing stores until a merchant picks a style in the dashboard).
--
-- APPLIED TO PROD via Supabase MCP 2026-07-24 (grants verified identical
-- post-recreate: PUBLIC/anon/authenticated/service_role EXECUTE preserved).
-- get_widget_config returns a typed TABLE, so adding a column requires
-- DROP + CREATE; this def is the live prod def + ctl_intro_style only.

ALTER TABLE public.vto_stores
  ADD COLUMN IF NOT EXISTS ctl_intro_style text
  CHECK (ctl_intro_style IS NULL OR ctl_intro_style IN ('pairing','whisper','drop'));

DROP FUNCTION public.get_widget_config(text, text);

CREATE FUNCTION public.get_widget_config(p_store_slug text DEFAULT NULL::text, p_shop_domain text DEFAULT NULL::text)
 RETURNS TABLE(store_slug text, shop_domain text, storefront_token text, clothing_population_type text, widget_primary_color text, widget_accent_color text, minimized_color text, featured_item_id text, quick_picks_ids text[], desktop_preview_enabled boolean, preview_delay_seconds integer, preview_theme text, widget_position text, widget_visibility_mode text, inline_button_enabled boolean, inline_button_text text, inline_button_color text, inline_button_text_color text, inline_button_hide_when_oos boolean, floating_widget_pdp_enabled boolean, floating_widget_non_pdp_enabled boolean, fitting_room_enabled boolean, complete_the_look_enabled boolean, ctl_intro_style text, pdp_image_swap_enabled boolean, pdp_image_selector text, ctl_holdout_enabled boolean, ctl_holdout_percent integer, lead_capture_enabled boolean, lead_capture_after_n integer, ab_experiment_enabled boolean, ab_experiment_id uuid, ab_holdout_percent integer, style_overrides jsonb, config_version bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
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
         s.ctl_intro_style,
         s.pdp_image_swap_enabled,
         s.pdp_image_selector,
         s.ctl_holdout_enabled, s.ctl_holdout_percent,
         s.lead_capture_enabled, s.lead_capture_after_n,
         s.ab_experiment_enabled, s.ab_experiment_id, s.ab_holdout_percent,
         s.style_overrides,
         s.config_version
    FROM vto_stores s
   WHERE (p_store_slug  IS NOT NULL AND s.store_slug  = p_store_slug)
      OR (p_shop_domain IS NOT NULL AND s.shop_domain = p_shop_domain)
   LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.get_widget_config(text, text) TO anon, authenticated, service_role;
