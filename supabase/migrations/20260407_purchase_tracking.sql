-- Migration: Purchase Attribution Tracking
-- Adds product_view_events and purchase_events tables, RPCs, and attribution views.
-- Run in staging first, then production.

-- ─────────────────────────────────────────────────────────────────────────────
-- product_view_events
-- Tracks when a user views a product page during a session that had a try-on.
-- Deduplicated: only the first view per (session_id, product_id) is kept.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_view_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_slug  TEXT        NOT NULL,
  session_id  TEXT        NOT NULL,
  product_id  TEXT,
  variant_id  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_view_events_store
  ON product_view_events (store_slug, created_at);

CREATE INDEX IF NOT EXISTS idx_product_view_events_session
  ON product_view_events (session_id);

-- Prevents refresh / back-nav spam — only first view per session+product stored
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_product_view_session_product'
  ) THEN
    ALTER TABLE product_view_events
      ADD CONSTRAINT uq_product_view_session_product UNIQUE (session_id, product_id);
  END IF;
END $$;

-- RPC: record_product_view_event
-- Silently ignores duplicate (session_id, product_id) pairs.
CREATE OR REPLACE FUNCTION record_product_view_event(
  p_store_slug TEXT,
  p_session_id TEXT,
  p_product_id TEXT DEFAULT NULL,
  p_variant_id TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO product_view_events (store_slug, session_id, product_id, variant_id)
  VALUES (p_store_slug, p_session_id, p_product_id, p_variant_id)
  ON CONFLICT (session_id, product_id) DO NOTHING;
  RETURN '{"success": true}'::JSONB;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- purchase_events
-- Stores completed Shopify orders, including all line items for product-level
-- attribution back to the specific item that was tried on.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_events (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  store_slug  TEXT         NOT NULL,
  session_id  TEXT         NOT NULL,
  order_id    TEXT,
  total_price NUMERIC(10, 2),
  currency    TEXT,
  line_items  JSONB        NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchase_events_store
  ON purchase_events (store_slug, created_at);

CREATE INDEX IF NOT EXISTS idx_purchase_events_session
  ON purchase_events (session_id);

-- RPC: record_purchase_event
CREATE OR REPLACE FUNCTION record_purchase_event(
  p_store_slug  TEXT,
  p_session_id  TEXT,
  p_order_id    TEXT    DEFAULT NULL,
  p_total_price NUMERIC DEFAULT NULL,
  p_currency    TEXT    DEFAULT NULL,
  p_line_items  TEXT    DEFAULT '[]'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO purchase_events (store_slug, session_id, order_id, total_price, currency, line_items)
  VALUES (p_store_slug, p_session_id, p_order_id, p_total_price, p_currency, p_line_items::JSONB);
  RETURN '{"success": true}'::JSONB;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- vto_attributed_purchases view
-- Sessions that tried on a product AND purchased that exact product AFTER the try-on.
-- seconds_to_purchase exposes lag analytics ("users who revisit in 3 min convert 4x").
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW vto_attributed_purchases AS
SELECT
  t.store_slug,
  t.session_id,
  t.product_id                                              AS tried_on_product,
  pe.order_id,
  pe.total_price,
  pe.currency,
  pe.created_at                                             AS purchased_at,
  t.created_at                                              AS tried_on_at,
  EXTRACT(EPOCH FROM (pe.created_at - t.created_at))       AS seconds_to_purchase
FROM tryon_events t
JOIN purchase_events pe
  ON  pe.session_id  = t.session_id
  AND pe.store_slug  = t.store_slug
  AND pe.created_at  > t.created_at   -- purchase must happen AFTER the try-on
  AND pe.line_items @> jsonb_build_array(
        jsonb_build_object('product_id', t.product_id)
      );

-- ─────────────────────────────────────────────────────────────────────────────
-- vto_conversion_summary view
-- Per-store funnel: try-on → product view → cart → purchase.
-- All steps must occur AFTER the try-on and on the same tried-on product.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW vto_conversion_summary AS
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
FROM tryon_events t
-- Only post-try-on views of the same tried-on product
LEFT JOIN product_view_events v
  ON  v.session_id = t.session_id
  AND v.store_slug = t.store_slug
  AND v.product_id = t.product_id
  AND v.created_at > t.created_at
-- Only post-try-on cart adds of the same product
LEFT JOIN cart_events c
  ON  c.session_id = t.session_id
  AND c.store_slug = t.store_slug
  AND c.product_id = t.product_id
  AND c.created_at > t.created_at
LEFT JOIN vto_attributed_purchases ap
  ON  ap.session_id = t.session_id
  AND ap.store_slug = t.store_slug
GROUP BY t.store_slug;
