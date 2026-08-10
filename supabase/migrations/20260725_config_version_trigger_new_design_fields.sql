-- config_version bump trigger: watch the 2026-07-24/25 design fields.
--
-- ROOT CAUSE (Andrew, ello-dev-store, 2026-07-25): the trigger function
-- compares a HARDCODED tuple of watched columns, written before
-- ctl_intro_style / inline_button_border_style / inline_button_border_color
-- existed. A dashboard save that changed ONLY those fields didn't bump
-- config_version, so storefront widgets kept their cached config and the
-- merchant's picks never appeared (dashboard preview looked right — it is
-- client-side). Fields were IN the DB the whole time.
--
-- APPLIED TO PROD via Supabase MCP 2026-07-25
-- (migration name: config_version_trigger_watch_new_design_fields).
-- Verified live: flipping inline_button_border_color bumped 348→349→350.
--
-- RULE — when adding any widget-config column, update ALL of:
--   1. vto_stores column (+ CHECK)
--   2. get_widget_config RPC (DROP + CREATE, typed TABLE — re-grant EXECUTE)
--   3. THIS trigger's watched tuple (both NEW.* and OLD.* lists)
--   4. widget-loader.js config mapping  5. widget-main.js consumer
--   6. app.widget-design.tsx loader + action
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
      NEW.style_overrides)
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
      OLD.style_overrides)
  THEN
    NEW.config_version := COALESCE(OLD.config_version, 0) + 1;
  END IF;
  RETURN NEW;
END;
$function$;
