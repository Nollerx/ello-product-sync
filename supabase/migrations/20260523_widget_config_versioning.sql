-- Migration: 20260523_widget_config_versioning
-- Purpose:   Enable cache-friendly widget config delivery without sacrificing
--            sub-30s merchant feedback. Adds a monotonically-increasing
--            config_version column to vto_stores that gets auto-bumped by a
--            trigger whenever any widget-visible setting changes. Extends
--            get_widget_config RPC to return the version alongside the config
--            so the widget loader and edge cache can key on it.
--
-- Context:   The widget loader previously fetched get_widget_config on every
--            pageview (Supabase RPC, uncacheable POST). This migration makes
--            that data cacheable: short-TTL HTTP cache + stale-while-revalidate
--            on the new /api/widget-config-resolved route, with the version
--            stamp providing a clean invalidation signal when a merchant edits
--            their widget settings.
--
-- Safety:    Pure additive change.
--            * Adding config_version with DEFAULT 1 is non-destructive.
--            * Trigger only fires on UPDATE — no behavior change for INSERTs.
--            * RPC signature gains one column at the end; existing callers that
--              ignore unknown columns (Supabase JS client default) keep working.

-- ─── 1. Add config_version column ──────────────────────────────────────────
ALTER TABLE public.vto_stores
  ADD COLUMN IF NOT EXISTS config_version BIGINT NOT NULL DEFAULT 1;

-- ─── 2. Trigger: auto-bump config_version on widget setting changes ────────
CREATE OR REPLACE FUNCTION public.bump_vto_store_config_version()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only bump when a widget-visible field actually changes. Using IS DISTINCT
  -- FROM (not !=) so NULL transitions are detected correctly.
  IF (
    NEW.widget_primary_color      IS DISTINCT FROM OLD.widget_primary_color
    OR NEW.widget_accent_color    IS DISTINCT FROM OLD.widget_accent_color
    OR NEW.minimized_color        IS DISTINCT FROM OLD.minimized_color
    OR NEW.featured_item_id       IS DISTINCT FROM OLD.featured_item_id
    OR NEW.quick_picks_ids        IS DISTINCT FROM OLD.quick_picks_ids
    OR NEW.desktop_preview_enabled IS DISTINCT FROM OLD.desktop_preview_enabled
    OR NEW.preview_delay_seconds  IS DISTINCT FROM OLD.preview_delay_seconds
    OR NEW.preview_theme          IS DISTINCT FROM OLD.preview_theme
    OR NEW.widget_position        IS DISTINCT FROM OLD.widget_position
    OR NEW.widget_visibility_mode IS DISTINCT FROM OLD.widget_visibility_mode
    OR NEW.clothing_population_type IS DISTINCT FROM OLD.clothing_population_type
    OR NEW.storefront_token       IS DISTINCT FROM OLD.storefront_token
    OR NEW.shop_domain            IS DISTINCT FROM OLD.shop_domain
  ) THEN
    NEW.config_version := COALESCE(OLD.config_version, 0) + 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bump_vto_store_config_version_trigger ON public.vto_stores;
CREATE TRIGGER bump_vto_store_config_version_trigger
  BEFORE UPDATE ON public.vto_stores
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_vto_store_config_version();

-- ─── 3. Replace get_widget_config to return config_version ─────────────────
-- Signature gains one trailing column (config_version BIGINT). All existing
-- columns + ordering preserved exactly as in production. Drop + recreate
-- needed because changing RETURNS TABLE shape requires a fresh function.

DROP FUNCTION IF EXISTS public.get_widget_config(TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.get_widget_config(
  p_store_slug  TEXT DEFAULT NULL,
  p_shop_domain TEXT DEFAULT NULL
)
RETURNS TABLE (
  store_slug               TEXT,
  shop_domain              TEXT,
  storefront_token         TEXT,
  clothing_population_type TEXT,
  widget_primary_color     TEXT,
  widget_accent_color      TEXT,
  minimized_color          TEXT,
  featured_item_id         TEXT,
  quick_picks_ids          TEXT[],
  desktop_preview_enabled  BOOLEAN,
  preview_delay_seconds    INT,
  preview_theme            TEXT,
  widget_position          TEXT,
  widget_visibility_mode   TEXT,
  config_version           BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_store_slug IS NOT NULL THEN
    RETURN QUERY
    SELECT
      s.store_slug, s.shop_domain, s.storefront_token,
      s.clothing_population_type,
      s.widget_primary_color, s.widget_accent_color, s.minimized_color,
      s.featured_item_id, s.quick_picks_ids,
      s.desktop_preview_enabled, s.preview_delay_seconds, s.preview_theme,
      s.widget_position, s.widget_visibility_mode,
      s.config_version
    FROM public.vto_stores s
    WHERE s.store_slug = p_store_slug
    LIMIT 1;
  ELSIF p_shop_domain IS NOT NULL THEN
    RETURN QUERY
    SELECT
      s.store_slug, s.shop_domain, s.storefront_token,
      s.clothing_population_type,
      s.widget_primary_color, s.widget_accent_color, s.minimized_color,
      s.featured_item_id, s.quick_picks_ids,
      s.desktop_preview_enabled, s.preview_delay_seconds, s.preview_theme,
      s.widget_position, s.widget_visibility_mode,
      s.config_version
    FROM public.vto_stores s
    WHERE s.shop_domain = p_shop_domain
    LIMIT 1;
  END IF;
END;
$$;

-- Grants: anon (widget direct callers), authenticated (dashboard), service_role (server-side proxy)
GRANT EXECUTE ON FUNCTION public.get_widget_config(TEXT, TEXT)
  TO anon, authenticated, service_role;
