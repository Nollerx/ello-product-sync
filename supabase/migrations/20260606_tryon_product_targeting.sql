-- 20260606_tryon_product_targeting.sql
--
-- Adds product-targeting modes to vto_stores so merchants can scope try-on to:
--   • 'all'         → every product (default — preserves current behavior)
--   • 'products'    → only an explicitly-selected set of products
--   • 'collections' → only products inside selected collections
--
-- app/routes/api.catalog-handles.tsx reads these columns and returns the
-- matching product handles; the storefront widget gates try-on on that handle
-- list (window.elloEnabledHandles), so no widget JS change is required.
--
-- Safety: purely additive. DEFAULT 'all' + empty arrays mean every existing
-- store (including Marcos / Kaizen) behaves exactly as before until a merchant
-- opts into a narrower mode.

BEGIN;

-- ─── 1. New columns ─────────────────────────────────────────────────────────
ALTER TABLE public.vto_stores
  ADD COLUMN IF NOT EXISTS tryon_targeting_mode TEXT NOT NULL DEFAULT 'all'
    CHECK (tryon_targeting_mode IN ('all', 'products', 'collections')),
  ADD COLUMN IF NOT EXISTS tryon_included_product_ids    TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS tryon_included_collection_ids TEXT[] NOT NULL DEFAULT '{}';

-- ─── 2. Extend the config-version bump trigger ──────────────────────────────
-- catalog-handles caches keyed on config_version; bump it when targeting changes
-- so storefronts pick up the new scope within the SWR window. Mirrors the body
-- from 20260524_inline_tryon_button.sql with the three new columns appended.
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
      OLD.tryon_targeting_mode, OLD.tryon_included_product_ids,
      OLD.tryon_included_collection_ids)
  THEN
    NEW.config_version := COALESCE(OLD.config_version, 0) + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── 3. Cache-bust existing rows ────────────────────────────────────────────
UPDATE public.vto_stores SET config_version = COALESCE(config_version, 0) + 1;

COMMIT;

NOTIFY pgrst, 'reload schema';
