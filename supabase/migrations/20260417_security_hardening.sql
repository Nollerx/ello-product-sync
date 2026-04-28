-- ============================================================================
-- Security Hardening Migration
-- Date: 2026-04-17
-- Fixes:
--   1. Enable RLS on shopify_sessions (contains admin OAuth access tokens)
--   2. Create get_widget_config RPC so widget reads config via function,
--      not via direct anon SELECT on vto_stores (which exposes storefront_token
--      to bulk enumeration)
--   3. Replace broad anon SELECT on vto_stores with:
--        - Anon: must call get_widget_config RPC (single-store lookup only)
--        - Authenticated: can read their own store(s) via JWT email match
--   4. Add security_invoker to analytics views
-- ============================================================================

-- ─── 1. Lock down shopify_sessions ──────────────────────────────────────────
-- This table contains Shopify admin OAuth access_tokens. Only the server-side
-- app (service_role) should ever read it. No anon or authenticated user needs
-- direct access — the app backend handles all Shopify API calls.

ALTER TABLE public.shopify_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on shopify_sessions" ON public.shopify_sessions;
CREATE POLICY "Service role full access on shopify_sessions"
  ON public.shopify_sessions TO service_role
  USING (true) WITH CHECK (true);

-- ─── 2. Create get_widget_config RPC ────────────────────────────────────────
-- Returns widget display config + storefront_token for a single store.
-- SECURITY DEFINER so anon key can call it without direct table SELECT.
-- Callers can look up by store_slug OR shop_domain (one required).

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
  preview_theme            TEXT
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
      s.desktop_preview_enabled, s.preview_delay_seconds, s.preview_theme
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
      s.desktop_preview_enabled, s.preview_delay_seconds, s.preview_theme
    FROM public.vto_stores s
    WHERE s.shop_domain = p_shop_domain
    LIMIT 1;
  END IF;
  -- If neither param provided, returns empty set (no error)
END;
$$;

-- Grant anon execute so the widget (anon key) can call this
GRANT EXECUTE ON FUNCTION public.get_widget_config(TEXT, TEXT) TO anon;

-- ─── 3. Replace broad anon SELECT on vto_stores ──────────────────────────────
-- Old policy allowed any anon caller to SELECT all rows + all columns.
-- New approach: anon uses the RPC above; authenticated users (Lovable dashboard)
-- can read their own store via JWT email match.

DROP POLICY IF EXISTS "Anon read vto_stores" ON public.vto_stores;

-- Authenticated users can read their own store(s) (for the dashboard)
DROP POLICY IF EXISTS "Authenticated read own stores" ON public.vto_stores;
CREATE POLICY "Authenticated read own stores"
  ON public.vto_stores FOR SELECT TO authenticated
  USING (
    account_id IN (
      SELECT id FROM public.vto_accounts
      WHERE owner_email = (auth.jwt() ->> 'email')
    )
  );

-- ─── 4. Security invoker on analytics views ──────────────────────────────────
-- Only recreate these views if the underlying purchase_events table exists
-- (i.e. migration 20260407 has been run). Safe to skip if not yet applied.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'purchase_events'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'product_view_events'
  ) THEN

    CREATE OR REPLACE VIEW public.vto_attributed_purchases
      WITH (security_invoker = true)
    AS
    SELECT
      t.store_slug,
      t.session_id,
      t.product_id                                        AS tried_on_product,
      pe.order_id,
      pe.total_price,
      pe.currency,
      pe.created_at                                       AS purchased_at,
      t.created_at                                        AS tried_on_at,
      EXTRACT(EPOCH FROM (pe.created_at - t.created_at)) AS seconds_to_purchase
    FROM public.tryon_events t
    JOIN public.purchase_events pe
      ON  pe.session_id = t.session_id
      AND pe.store_slug = t.store_slug
      AND pe.created_at > t.created_at
      AND pe.line_items @> jsonb_build_array(
            jsonb_build_object('product_id', t.product_id)
          );

    CREATE OR REPLACE VIEW public.vto_conversion_summary
      WITH (security_invoker = true)
    AS
    SELECT
      t.store_slug,
      COUNT(DISTINCT t.session_id)  AS tryon_sessions,
      COUNT(DISTINCT v.session_id)  AS sessions_viewed_product,
      COUNT(DISTINCT c.session_id)  AS sessions_added_to_cart,
      COUNT(DISTINCT ap.session_id) AS sessions_purchased,
      ROUND(
        100.0 * COUNT(DISTINCT ap.session_id)
          / NULLIF(COUNT(DISTINCT t.session_id), 0),
        2
      )                             AS purchase_conversion_pct
    FROM public.tryon_events t
    LEFT JOIN public.product_view_events v
      ON  v.session_id = t.session_id
      AND v.store_slug = t.store_slug
      AND v.product_id = t.product_id
      AND v.created_at > t.created_at
    LEFT JOIN public.cart_events c
      ON  c.session_id = t.session_id
      AND c.store_slug = t.store_slug
      AND c.product_id = t.product_id
      AND c.created_at > t.created_at
    LEFT JOIN public.vto_attributed_purchases ap
      ON  ap.session_id = t.session_id
      AND ap.store_slug = t.store_slug
    GROUP BY t.store_slug;

    RAISE NOTICE 'Analytics views recreated with security_invoker = true';
  ELSE
    RAISE NOTICE 'Skipping analytics views — run 20260407_purchase_tracking.sql first';
  END IF;
END $$;

-- Force PostgREST to pick up schema changes
NOTIFY pgrst, 'reload schema';
