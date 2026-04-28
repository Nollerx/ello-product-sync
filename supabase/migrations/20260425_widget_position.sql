-- ============================================================================
-- Widget Position (left/right bottom corner)
-- Date: 2026-04-25
-- Adds a `widget_position` column to vto_stores so merchants can choose which
-- bottom corner the widget renders in. Updates get_widget_config RPC to expose
-- it to the storefront widget loader.
-- ============================================================================

ALTER TABLE public.vto_stores
  ADD COLUMN IF NOT EXISTS widget_position TEXT NOT NULL DEFAULT 'right'
    CHECK (widget_position IN ('left', 'right'));

-- Recreate get_widget_config to include widget_position in its return signature.
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
  widget_position          TEXT
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
      s.widget_position
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
      s.widget_position
    FROM public.vto_stores s
    WHERE s.shop_domain = p_shop_domain
    LIMIT 1;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_widget_config(TEXT, TEXT) TO anon;

NOTIFY pgrst, 'reload schema';
