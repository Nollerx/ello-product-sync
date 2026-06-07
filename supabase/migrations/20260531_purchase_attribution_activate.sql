-- Migration: Activate Purchase Attribution (Phases 1 & 2)
-- Context: 20260407_purchase_tracking.sql was authored but never applied to prod, so the
-- Web Pixel's checkout_completed / product_viewed events have been silently dropped
-- (record_purchase_event / record_product_view_event did not exist). This migration
-- creates the missing tables, RPCs and views against the REAL event tables
-- (tryon_events / cart_events — the bare tables, not vto_*), with production hardening:
--   * order_id dedup so a refreshed thank-you page can't double-count revenue
--   * RLS enabled with no public policies (reachable only via SECURITY DEFINER RPCs + service role)
--   * date-windowed RPCs the dashboard anon key can call (matches get_vto_* pattern)
-- Idempotent: safe to re-run.

-- ─────────────────────────────────────────────────────────────────────────────
-- product_view_events — a product page view during a session that had a try-on.
-- Deduped to first view per (session_id, product_id).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.product_view_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_slug  TEXT        NOT NULL,
  session_id  TEXT        NOT NULL,
  product_id  TEXT,
  variant_id  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_view_events_store   ON public.product_view_events (store_slug, created_at);
CREATE INDEX IF NOT EXISTS idx_product_view_events_session ON public.product_view_events (session_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_product_view_session_product') THEN
    ALTER TABLE public.product_view_events
      ADD CONSTRAINT uq_product_view_session_product UNIQUE (session_id, product_id);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- purchase_events — completed Shopify orders, line items kept for product-level
-- attribution back to the tried-on item.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.purchase_events (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  store_slug  TEXT         NOT NULL,
  session_id  TEXT         NOT NULL,
  order_id    TEXT,
  total_price NUMERIC(10, 2),
  currency    TEXT,
  line_items  JSONB        NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchase_events_store   ON public.purchase_events (store_slug, created_at);
CREATE INDEX IF NOT EXISTS idx_purchase_events_session ON public.purchase_events (session_id);

-- Dedup: one row per real order. Partial so multiple null-order rows never collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_events_order
  ON public.purchase_events (order_id) WHERE order_id IS NOT NULL;

-- Lock the new tables down: no anon/authenticated table grants. They are reachable
-- only through the SECURITY DEFINER functions below and the service role.
ALTER TABLE public.product_view_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_events     ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- Recorder RPCs (called by /api/cart-purchase-event with the service role).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_product_view_event(
  p_store_slug TEXT,
  p_session_id TEXT,
  p_product_id TEXT DEFAULT NULL,
  p_variant_id TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.product_view_events (store_slug, session_id, product_id, variant_id)
  VALUES (p_store_slug, p_session_id, p_product_id, p_variant_id)
  ON CONFLICT (session_id, product_id) DO NOTHING;
  RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_purchase_event(
  p_store_slug  TEXT,
  p_session_id  TEXT,
  p_order_id    TEXT    DEFAULT NULL,
  p_total_price NUMERIC DEFAULT NULL,
  p_currency    TEXT    DEFAULT NULL,
  p_line_items  TEXT    DEFAULT '[]'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.purchase_events (store_slug, session_id, order_id, total_price, currency, line_items)
  VALUES (p_store_slug, p_session_id, p_order_id, p_total_price, p_currency, p_line_items::JSONB)
  ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING;
  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- vto_attributed_purchases — sessions that tried on a product AND bought that exact
-- product AFTER the try-on. seconds_to_purchase exposes lag analytics.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.vto_attributed_purchases AS
SELECT
  t.store_slug,
  t.session_id,
  t.product_id                                        AS tried_on_product,
  pe.order_id,
  pe.total_price,
  pe.currency,
  pe.created_at                                       AS purchased_at,
  t.created_at                                        AS tried_on_at,
  EXTRACT(EPOCH FROM (pe.created_at - t.created_at))  AS seconds_to_purchase
FROM public.tryon_events t
JOIN public.purchase_events pe
  ON  pe.session_id = t.session_id
  AND pe.store_slug = t.store_slug
  AND pe.created_at > t.created_at
  AND pe.line_items @> jsonb_build_array(jsonb_build_object('product_id', t.product_id))
WHERE t.success IS TRUE;

-- ─────────────────────────────────────────────────────────────────────────────
-- vto_conversion_summary — per-store all-time funnel: try-on → view → cart → purchase
-- (all steps on the tried-on product, after the try-on).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.vto_conversion_summary AS
SELECT
  t.store_slug,
  COUNT(DISTINCT t.session_id)  AS tryon_sessions,
  COUNT(DISTINCT v.session_id)  AS sessions_viewed_product,
  COUNT(DISTINCT c.session_id)  AS sessions_added_to_cart,
  COUNT(DISTINCT ap.session_id) AS sessions_purchased,
  ROUND(100.0 * COUNT(DISTINCT ap.session_id) / NULLIF(COUNT(DISTINCT t.session_id), 0), 2) AS purchase_conversion_pct
FROM public.tryon_events t
LEFT JOIN public.product_view_events v
  ON v.session_id = t.session_id AND v.store_slug = t.store_slug
 AND v.product_id = t.product_id AND v.created_at > t.created_at
LEFT JOIN public.cart_events c
  ON c.session_id = t.session_id AND c.store_slug = t.store_slug
 AND c.product_id = t.product_id AND c.created_at > t.created_at
LEFT JOIN public.vto_attributed_purchases ap
  ON ap.session_id = t.session_id AND ap.store_slug = t.store_slug
WHERE t.success IS TRUE
GROUP BY t.store_slug;

-- ─────────────────────────────────────────────────────────────────────────────
-- Dashboard RPCs (anon-callable, SECURITY DEFINER, date-windowed) — match the
-- existing get_vto_* access model used by the analytics UI.
-- ─────────────────────────────────────────────────────────────────────────────

-- Store-level true funnel within a date window. Revenue deduped by order.
CREATE OR REPLACE FUNCTION public.get_vto_conversion_summary(
  p_store_slug TEXT,
  p_from       TIMESTAMPTZ,
  p_to         TIMESTAMPTZ
) RETURNS TABLE (
  tryon_sessions          BIGINT,
  sessions_viewed_product BIGINT,
  sessions_added_to_cart  BIGINT,
  sessions_purchased      BIGINT,
  attributed_revenue      NUMERIC,
  purchase_conversion_pct NUMERIC,
  cart_conversion_pct     NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH base AS (
    SELECT DISTINCT session_id, product_id, created_at
    FROM public.tryon_events
    WHERE store_slug = p_store_slug AND success IS TRUE
      AND created_at >= p_from AND created_at < p_to
  ),
  tryon_sess AS (SELECT DISTINCT session_id FROM base),
  viewed AS (
    SELECT DISTINCT b.session_id FROM base b
    JOIN public.product_view_events v
      ON v.session_id = b.session_id AND v.store_slug = p_store_slug
     AND v.product_id = b.product_id AND v.created_at > b.created_at
  ),
  carted AS (
    SELECT DISTINCT b.session_id FROM base b
    JOIN public.cart_events c
      ON c.session_id = b.session_id AND c.store_slug = p_store_slug
     AND c.product_id = b.product_id AND c.created_at > b.created_at
  ),
  attributed AS (
    SELECT b.session_id, pe.order_id, pe.total_price FROM base b
    JOIN public.purchase_events pe
      ON pe.session_id = b.session_id AND pe.store_slug = p_store_slug
     AND pe.created_at > b.created_at
     AND pe.line_items @> jsonb_build_array(jsonb_build_object('product_id', b.product_id))
  ),
  purch_sess AS (SELECT DISTINCT session_id FROM attributed),
  revenue AS (SELECT COALESCE(SUM(total_price), 0) AS rev FROM (SELECT DISTINCT order_id, total_price FROM attributed) d)
  SELECT
    (SELECT count(*) FROM tryon_sess),
    (SELECT count(*) FROM viewed),
    (SELECT count(*) FROM carted),
    (SELECT count(*) FROM purch_sess),
    (SELECT rev FROM revenue),
    ROUND(100.0 * (SELECT count(*) FROM purch_sess) / NULLIF((SELECT count(*) FROM tryon_sess), 0), 2),
    ROUND(100.0 * (SELECT count(*) FROM carted)     / NULLIF((SELECT count(*) FROM tryon_sess), 0), 2);
$$;

-- Per-product conversion within a date window. Revenue is product-influenced
-- (an order with two tried-on products counts toward each); store totals use the
-- order-deduped figure above.
CREATE OR REPLACE FUNCTION public.get_vto_product_conversion(
  p_store_slug TEXT,
  p_from       TIMESTAMPTZ,
  p_to         TIMESTAMPTZ
) RETURNS TABLE (
  product_id         TEXT,
  tryons             BIGINT,
  tryon_sessions     BIGINT,
  purchased_sessions BIGINT,
  attributed_revenue NUMERIC,
  conversion_pct     NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH base AS (
    SELECT session_id, product_id, created_at
    FROM public.tryon_events
    WHERE store_slug = p_store_slug AND success IS TRUE
      AND created_at >= p_from AND created_at < p_to
      AND product_id IS NOT NULL
  ),
  per_product AS (
    SELECT product_id, count(*) AS tryons, count(DISTINCT session_id) AS tryon_sessions
    FROM base GROUP BY product_id
  ),
  attributed AS (
    SELECT DISTINCT b.product_id, b.session_id, pe.order_id, pe.total_price
    FROM base b
    JOIN public.purchase_events pe
      ON pe.session_id = b.session_id AND pe.store_slug = p_store_slug
     AND pe.created_at > b.created_at
     AND pe.line_items @> jsonb_build_array(jsonb_build_object('product_id', b.product_id))
  ),
  attr_agg AS (
    SELECT product_id,
           count(DISTINCT session_id)     AS purchased_sessions,
           COALESCE(SUM(total_price), 0)  AS attributed_revenue
    FROM attributed GROUP BY product_id
  )
  SELECT
    p.product_id,
    p.tryons,
    p.tryon_sessions,
    COALESCE(a.purchased_sessions, 0),
    COALESCE(a.attributed_revenue, 0),
    ROUND(100.0 * COALESCE(a.purchased_sessions, 0) / NULLIF(p.tryon_sessions, 0), 2)
  FROM per_product p
  LEFT JOIN attr_agg a USING (product_id)
  ORDER BY p.tryons DESC
  LIMIT 50;
$$;

GRANT EXECUTE ON FUNCTION public.get_vto_conversion_summary(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_vto_product_conversion(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO anon, authenticated, service_role;
