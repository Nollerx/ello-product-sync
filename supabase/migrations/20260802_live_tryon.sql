-- ============================================================================
-- Live Try-On (Decart realtime mirror) — schema + config plumbing
-- 2026-08-02
--
-- Adds the per-store Live Try-On flag + caps, a session-metering table, and
-- walks the widget-config checklist (get_widget_config + version-bump trigger)
-- so the flag reaches storefronts. Additive only; safe with deployed builds
-- (new columns are DEFAULTed, RPC signature keeps existing params).
--
-- Rollout: everything defaults OFF. Enable for the demo store only with the
-- statement at the bottom (commented out — run deliberately).
-- ============================================================================

-- 1. Per-store flag + caps -----------------------------------------------------
ALTER TABLE vto_stores
  ADD COLUMN IF NOT EXISTS live_tryon_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE vto_stores
  ADD COLUMN IF NOT EXISTS live_tryon_session_seconds integer NOT NULL DEFAULT 60
    CHECK (live_tryon_session_seconds BETWEEN 15 AND 300);
ALTER TABLE vto_stores
  ADD COLUMN IF NOT EXISTS live_tryon_daily_seconds_cap integer NOT NULL DEFAULT 900
    CHECK (live_tryon_daily_seconds_cap BETWEEN 60 AND 86400);

-- 2. Session metering table ----------------------------------------------------
-- One row per minted live session. seconds_cap is reserved at mint time; the
-- close-out beacon writes seconds_used. Daily-cap math sums
-- COALESCE(seconds_used, seconds_cap) so an unclosed session counts as fully
-- spent (fail-closed, matches Decart's server-side kill at the cap).
CREATE TABLE IF NOT EXISTS vto_live_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_slug text NOT NULL,
  session_id text,            -- shopper session (ello_session_id), for per-shopper caps
  product_id text,
  entry_source text,
  seconds_cap integer NOT NULL,
  seconds_used integer,       -- null until close-out beacon lands
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_vto_live_sessions_store_created
  ON vto_live_sessions (store_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vto_live_sessions_shopper
  ON vto_live_sessions (store_slug, session_id, created_at DESC);

-- Service-role only (the Remix app). No anon/authenticated policies on purpose
-- — same posture as the 2026-07-15 anon-RPC lockdown.
ALTER TABLE vto_live_sessions ENABLE ROW LEVEL SECURITY;

-- 3. get_widget_config: expose live_tryon_enabled -------------------------------
-- Typed TABLE return → DROP + CREATE + re-GRANT (checklist step 2).
DROP FUNCTION IF EXISTS public.get_widget_config(text, text);

CREATE FUNCTION public.get_widget_config(p_store_slug text DEFAULT NULL::text, p_shop_domain text DEFAULT NULL::text)
 RETURNS TABLE(store_slug text, shop_domain text, storefront_token text, clothing_population_type text, widget_primary_color text, widget_accent_color text, minimized_color text, featured_item_id text, quick_picks_ids text[], desktop_preview_enabled boolean, preview_delay_seconds integer, preview_theme text, widget_position text, widget_visibility_mode text, inline_button_enabled boolean, inline_button_text text, inline_button_color text, inline_button_text_color text, inline_button_hide_when_oos boolean, inline_button_border_style text, inline_button_border_color text, floating_widget_pdp_enabled boolean, floating_widget_non_pdp_enabled boolean, fitting_room_enabled boolean, complete_the_look_enabled boolean, ctl_intro_style text, pdp_image_swap_enabled boolean, pdp_image_selector text, ctl_holdout_enabled boolean, ctl_holdout_percent integer, lead_capture_enabled boolean, lead_capture_after_n integer, ab_experiment_enabled boolean, ab_experiment_id uuid, ab_holdout_percent integer, style_overrides jsonb, live_tryon_enabled boolean, config_version bigint)
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
         s.inline_button_border_style,
         s.inline_button_border_color,
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
         s.live_tryon_enabled,
         s.config_version
    FROM vto_stores s
   WHERE (p_store_slug  IS NOT NULL AND s.store_slug  = p_store_slug)
      OR (p_shop_domain IS NOT NULL AND s.shop_domain = p_shop_domain)
   LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.get_widget_config(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_widget_config(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_widget_config(text, text) TO service_role;

-- 4. Version-bump trigger: watch live_tryon_enabled (checklist step 3) ----------
CREATE OR REPLACE FUNCTION public.bump_vto_store_config_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF (NEW.widget_primary_color, NEW.widget_accent_color, NEW.minimized_color,
      NEW.featured_item_id, NEW.quick_picks_ids, NEW.desktop_preview_enabled,
      NEW.preview_delay_seconds, NEW.preview_theme, NEW.widget_position,
      NEW.widget_visibility_mode, NEW.clothing_population_type,
      NEW.storefront_token, NEW.shop_domain,
      NEW.inline_button_enabled, NEW.inline_button_text, NEW.inline_button_color,
      NEW.inline_button_text_color, NEW.inline_button_hide_when_oos,
      NEW.inline_button_border_style, NEW.inline_button_border_color,
      NEW.floating_widget_pdp_enabled, NEW.floating_widget_non_pdp_enabled,
      NEW.fitting_room_enabled, NEW.complete_the_look_enabled,
      NEW.ctl_intro_style,
      NEW.pdp_image_swap_enabled, NEW.pdp_image_selector,
      NEW.tryon_targeting_mode, NEW.tryon_included_product_ids,
      NEW.tryon_included_collection_ids,
      NEW.ctl_holdout_enabled, NEW.ctl_holdout_percent,
      NEW.lead_capture_enabled, NEW.lead_capture_after_n,
      NEW.ab_experiment_enabled, NEW.ab_experiment_id, NEW.ab_holdout_percent,
      NEW.style_overrides,
      NEW.live_tryon_enabled)
     IS DISTINCT FROM
     (OLD.widget_primary_color, OLD.widget_accent_color, OLD.minimized_color,
      OLD.featured_item_id, OLD.quick_picks_ids, OLD.desktop_preview_enabled,
      OLD.preview_delay_seconds, OLD.preview_theme, OLD.widget_position,
      OLD.widget_visibility_mode, OLD.clothing_population_type,
      OLD.storefront_token, OLD.shop_domain,
      OLD.inline_button_enabled, OLD.inline_button_text, OLD.inline_button_color,
      OLD.inline_button_text_color, OLD.inline_button_hide_when_oos,
      OLD.inline_button_border_style, OLD.inline_button_border_color,
      OLD.floating_widget_pdp_enabled, OLD.floating_widget_non_pdp_enabled,
      OLD.fitting_room_enabled, OLD.complete_the_look_enabled,
      OLD.ctl_intro_style,
      OLD.pdp_image_swap_enabled, OLD.pdp_image_selector,
      OLD.tryon_targeting_mode, OLD.tryon_included_product_ids,
      OLD.tryon_included_collection_ids,
      OLD.ctl_holdout_enabled, OLD.ctl_holdout_percent,
      OLD.lead_capture_enabled, OLD.lead_capture_after_n,
      OLD.ab_experiment_enabled, OLD.ab_experiment_id, OLD.ab_holdout_percent,
      OLD.style_overrides,
      OLD.live_tryon_enabled)
  THEN
    NEW.config_version := COALESCE(OLD.config_version, 0) + 1;
  END IF;
  RETURN NEW;
END;
$function$;

-- 5. Demo-store enable (run separately, on purpose) -----------------------------
-- UPDATE vto_stores SET live_tryon_enabled = true WHERE store_slug = 'ello-dev-store';
