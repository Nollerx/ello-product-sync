-- Migration: Line-item attribution + refund netting (Qualified Revenue)
--
-- WHY: attributed_revenue previously summed purchase_events.total_price — the
-- WHOLE order total including untried items, shipping and taxes. The enterprise
-- term sheet (and any CFO audit) defines Qualified Revenue as "the tried-on
-- items only, net of returns, excluding shipping and taxes". This migration
-- makes the code match the contract:
--
--   1. purchase_events gains subtotal_price; the pixel now sends a discounted
--      line_price per line item (unit × qty, after discounts, before ship/tax).
--   2. attributed_revenue = SUM of tried-on lines' line_price per attributed
--      order. Try on shirt ($30) + buy shirt + untried $60 item → $30, not $90+.
--      Try on shirt AND shorts, buy both → both lines count.
--   3. LEGACY rows (no line_price captured): prorate COALESCE(subtotal, total)
--      by tried-on units / total units. Historic numbers stay populated but are
--      no longer inflated by untried items; ship/tax inflation remains only
--      where subtotal was never captured (flagged, unavoidable retroactively).
--   4. refund_events (fed by the refunds/create webhook) nets refunded tried-on
--      lines out of attributed_revenue_net and powers tried-on return rates.
--   5. RETURNS NETTING WINDOW (Andrew, 2026-07-13): only refunds within 45 days
--      of the purchase net against billing, so closed months never reopen.
--      get_vto_return_rates stays UNwindowed on purpose: it measures shopper
--      behavior (do tried-on items come back less?), not billing.
--
-- Dedup key is purchase_events.id (not order_id) so NULL-order rows can never
-- collapse into each other. Product ids are normalized with
-- regexp_replace(x, '^.*/', '') everywhere (GID vs numeric — see
-- 20260531_attribution_product_id_normalize.sql).
--
-- Security posture preserved: event tables stay RLS-locked with no anon grants
-- (20260711_sec_04); rebuilt views stay revoked from anon/authenticated
-- (20260711_sec_02); dashboard reads go through SECURITY DEFINER get_vto_* RPCs.
-- Idempotent: safe to re-run.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. purchase_events.subtotal_price — merchandise total after discounts,
--    before shipping/taxes. Cross-check for the per-line line_price sum.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.purchase_events
  ADD COLUMN IF NOT EXISTS subtotal_price NUMERIC(10, 2);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. record_purchase_event — accept subtotal. Old 6-arg signature is dropped
--    (not overloaded) so named-arg RPC calls can never become ambiguous.
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.record_purchase_event(TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.record_purchase_event(
  p_store_slug     TEXT,
  p_session_id     TEXT,
  p_order_id       TEXT    DEFAULT NULL,
  p_total_price    NUMERIC DEFAULT NULL,
  p_currency       TEXT    DEFAULT NULL,
  p_line_items     TEXT    DEFAULT '[]',
  p_subtotal_price NUMERIC DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.purchase_events
    (store_slug, session_id, order_id, total_price, subtotal_price, currency, line_items)
  VALUES
    (p_store_slug, p_session_id, p_order_id, p_total_price, p_subtotal_price, p_currency, p_line_items::JSONB)
  ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING;
  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. refund_events — one row per Shopify refund (refunds/create webhook).
--    line_items: [{product_id, variant_id, quantity, subtotal, title}] where
--    subtotal is the refunded merchandise amount for that line (pre-tax, post-
--    discount) — the same basis as line_price, so netting is apples-to-apples.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.refund_events (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_slug        TEXT        NOT NULL,
  order_id          TEXT,
  refund_id         TEXT        UNIQUE,
  refunded_subtotal NUMERIC(12, 2),
  currency          TEXT,
  line_items        JSONB       NOT NULL DEFAULT '[]',
  refunded_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refund_events_store ON public.refund_events (store_slug, created_at);
CREATE INDEX IF NOT EXISTS idx_refund_events_order ON public.refund_events (order_id);

ALTER TABLE public.refund_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.refund_events FROM anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. vto_attributed_purchases — the CFO line-audit view. One row per
--    (session, tried-on product, order): earliest try-on that preceded the
--    purchase, with the tried-on lines' revenue (attributed_line_revenue,
--    NULL for legacy rows without line_price).
--    vto_conversion_summary depends on it, so both are dropped and rebuilt.
-- ─────────────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.vto_conversion_summary;
DROP VIEW IF EXISTS public.vto_attributed_purchases;

CREATE VIEW public.vto_attributed_purchases AS
SELECT DISTINCT ON (t.store_slug, t.session_id, regexp_replace(t.product_id, '^.*/', ''), pe.id)
  t.store_slug,
  t.session_id,
  regexp_replace(t.product_id, '^.*/', '')          AS tried_on_product,
  pe.order_id,
  pe.total_price,
  pe.subtotal_price,
  lr.line_revenue                                    AS attributed_line_revenue,
  pe.currency,
  pe.created_at                                      AS purchased_at,
  t.created_at                                       AS tried_on_at,
  EXTRACT(EPOCH FROM (pe.created_at - t.created_at)) AS seconds_to_purchase
FROM public.tryon_events t
JOIN public.purchase_events pe
  ON  pe.session_id = t.session_id
  AND pe.store_slug = t.store_slug
  AND pe.created_at > t.created_at
CROSS JOIN LATERAL (
  SELECT SUM((li->>'line_price')::NUMERIC) AS line_revenue, COUNT(*) AS n
  FROM jsonb_array_elements(pe.line_items) li
  WHERE regexp_replace(li->>'product_id', '^.*/', '') = regexp_replace(t.product_id, '^.*/', '')
) lr
WHERE t.success IS TRUE AND lr.n > 0
ORDER BY t.store_slug, t.session_id, regexp_replace(t.product_id, '^.*/', ''), pe.id, t.created_at;

CREATE VIEW public.vto_conversion_summary AS
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
 AND regexp_replace(v.product_id, '^.*/', '') = regexp_replace(t.product_id, '^.*/', '')
 AND v.created_at > t.created_at
LEFT JOIN public.cart_events c
  ON c.session_id = t.session_id AND c.store_slug = t.store_slug
 AND regexp_replace(c.product_id, '^.*/', '') = regexp_replace(t.product_id, '^.*/', '')
 AND c.created_at > t.created_at
LEFT JOIN public.vto_attributed_purchases ap
  ON ap.session_id = t.session_id AND ap.store_slug = t.store_slug
WHERE t.success IS TRUE
GROUP BY t.store_slug;

-- Re-apply 20260711_sec_02 lockdown on the rebuilt views.
REVOKE ALL ON public.vto_attributed_purchases FROM anon, authenticated;
REVOKE ALL ON public.vto_conversion_summary   FROM anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. get_vto_conversion_summary — Qualified Revenue definition.
--    Return shape changes (adds refunded_revenue / attributed_revenue_net),
--    so the old function must be dropped first.
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_vto_conversion_summary(TEXT, TIMESTAMPTZ, TIMESTAMPTZ);

CREATE FUNCTION public.get_vto_conversion_summary(
  p_store_slug TEXT,
  p_from       TIMESTAMPTZ,
  p_to         TIMESTAMPTZ
) RETURNS TABLE (
  tryon_sessions          BIGINT,
  sessions_viewed_product BIGINT,
  sessions_added_to_cart  BIGINT,
  sessions_purchased      BIGINT,
  attributed_revenue      NUMERIC,  -- gross Qualified Revenue (tried-on lines only)
  refunded_revenue        NUMERIC,  -- refunded tried-on lines in those orders
  attributed_revenue_net  NUMERIC,  -- what the 15% applies to
  purchase_conversion_pct NUMERIC,
  cart_conversion_pct     NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH base AS (
    SELECT DISTINCT
      session_id,
      regexp_replace(product_id, '^.*/', '') AS pid,
      created_at
    FROM public.tryon_events
    WHERE store_slug = p_store_slug AND success IS TRUE
      AND created_at >= p_from AND created_at < p_to
  ),
  tryon_sess AS (SELECT DISTINCT session_id FROM base),
  viewed AS (
    SELECT DISTINCT b.session_id FROM base b
    JOIN public.product_view_events v
      ON v.session_id = b.session_id AND v.store_slug = p_store_slug
     AND regexp_replace(v.product_id, '^.*/', '') = b.pid
     AND v.created_at > b.created_at
  ),
  carted AS (
    SELECT DISTINCT b.session_id FROM base b
    JOIN public.cart_events c
      ON c.session_id = b.session_id AND c.store_slug = p_store_slug
     AND regexp_replace(c.product_id, '^.*/', '') = b.pid
     AND c.created_at > b.created_at
  ),
  -- One row per (purchase row, tried-on product). pe.id is the dedup key so
  -- NULL order_ids can never merge distinct purchases.
  attributed AS (
    SELECT DISTINCT pe.id AS purchase_row_id, pe.order_id, b.session_id, b.pid,
           pe.total_price, pe.subtotal_price, pe.line_items,
           pe.created_at AS purchased_at
    FROM base b
    JOIN public.purchase_events pe
      ON pe.session_id = b.session_id AND pe.store_slug = p_store_slug
     AND pe.created_at > b.created_at
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(pe.line_items) li
       WHERE regexp_replace(li->>'product_id', '^.*/', '') = b.pid
     )
  ),
  purch_sess AS (SELECT DISTINCT session_id FROM attributed),
  per_order AS (
    SELECT purchase_row_id,
           MAX(order_id)                 AS order_id,
           MAX(total_price)              AS total_price,
           MAX(subtotal_price)           AS subtotal_price,
           MAX(purchased_at)             AS purchased_at,
           array_agg(DISTINCT pid)       AS tried_pids,
           MAX(line_items::TEXT)::JSONB  AS line_items
    FROM attributed
    GROUP BY purchase_row_id
  ),
  order_calc AS (
    SELECT o.purchase_row_id, o.order_id, o.total_price, o.subtotal_price,
           SUM(COALESCE((li->>'quantity')::NUMERIC, 1)) AS total_units,
           SUM(COALESCE((li->>'quantity')::NUMERIC, 1))
             FILTER (WHERE regexp_replace(li->>'product_id', '^.*/', '') = ANY(o.tried_pids)) AS tried_units,
           SUM((li->>'line_price')::NUMERIC)
             FILTER (WHERE regexp_replace(li->>'product_id', '^.*/', '') = ANY(o.tried_pids)) AS tried_line_rev,
           bool_and((li ? 'line_price') AND (li->>'line_price') IS NOT NULL)
             FILTER (WHERE regexp_replace(li->>'product_id', '^.*/', '') = ANY(o.tried_pids)) AS has_prices
    FROM per_order o
    CROSS JOIN LATERAL jsonb_array_elements(o.line_items) li
    GROUP BY o.purchase_row_id, o.order_id, o.total_price, o.subtotal_price, o.tried_pids
  ),
  qualified AS (
    SELECT oc.purchase_row_id, oc.order_id,
           CASE
             WHEN oc.has_prices THEN oc.tried_line_rev
             -- Legacy rows (pixel predates line_price): prorate the merchandise
             -- total by tried-on units so untried items never inflate revenue.
             ELSE COALESCE(oc.subtotal_price, oc.total_price, 0)
                  * oc.tried_units / NULLIF(oc.total_units, 0)
           END AS qualified_revenue
    FROM order_calc oc
  ),
  refunded AS (
    SELECT o.purchase_row_id,
           SUM((rli->>'subtotal')::NUMERIC) AS refunded_qualified
    FROM per_order o
    JOIN public.refund_events re
      ON re.store_slug = p_store_slug AND re.order_id = o.order_id
     -- Returns netting window: refunds land against billing only within 45
     -- days of the purchase. Later refunds never reopen a closed month.
     AND COALESCE(re.refunded_at, re.created_at) < o.purchased_at + INTERVAL '45 days'
    CROSS JOIN LATERAL jsonb_array_elements(re.line_items) rli
    WHERE o.order_id IS NOT NULL
      AND regexp_replace(rli->>'product_id', '^.*/', '') = ANY(o.tried_pids)
    GROUP BY o.purchase_row_id
  ),
  revenue AS (
    SELECT
      COALESCE(SUM(q.qualified_revenue), 0) AS gross,
      -- Refunds are capped per order at what was attributed, so a mostly-
      -- refunded order can never drive the net figure negative.
      COALESCE(SUM(LEAST(COALESCE(r.refunded_qualified, 0), COALESCE(q.qualified_revenue, 0))), 0) AS refunds,
      COALESCE(SUM(GREATEST(COALESCE(q.qualified_revenue, 0) - COALESCE(r.refunded_qualified, 0), 0)), 0) AS net
    FROM qualified q
    LEFT JOIN refunded r USING (purchase_row_id)
  )
  SELECT
    (SELECT count(*) FROM tryon_sess),
    (SELECT count(*) FROM viewed),
    (SELECT count(*) FROM carted),
    (SELECT count(*) FROM purch_sess),
    ROUND((SELECT gross   FROM revenue), 2),
    ROUND((SELECT refunds FROM revenue), 2),
    ROUND((SELECT net     FROM revenue), 2),
    ROUND(100.0 * (SELECT count(*) FROM purch_sess) / NULLIF((SELECT count(*) FROM tryon_sess), 0), 2),
    ROUND(100.0 * (SELECT count(*) FROM carted)     / NULLIF((SELECT count(*) FROM tryon_sess), 0), 2);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. get_vto_product_conversion — per-product revenue is now that product's
--    own lines (or its prorated share on legacy rows), same return shape.
-- ─────────────────────────────────────────────────────────────────────────────
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
    SELECT DISTINCT b.product_id, b.session_id, pe.id AS purchase_row_id,
           pe.total_price, pe.subtotal_price, pe.line_items
    FROM base b
    JOIN public.purchase_events pe
      ON pe.session_id = b.session_id AND pe.store_slug = p_store_slug
     AND pe.created_at > b.created_at
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(pe.line_items) li
       WHERE regexp_replace(li->>'product_id', '^.*/', '') = regexp_replace(b.product_id, '^.*/', '')
     )
  ),
  line_calc AS (
    SELECT a.product_id, a.session_id, a.purchase_row_id,
           SUM(COALESCE((li->>'quantity')::NUMERIC, 1)) AS total_units,
           SUM(COALESCE((li->>'quantity')::NUMERIC, 1))
             FILTER (WHERE regexp_replace(li->>'product_id', '^.*/', '') = regexp_replace(a.product_id, '^.*/', '')) AS prod_units,
           SUM((li->>'line_price')::NUMERIC)
             FILTER (WHERE regexp_replace(li->>'product_id', '^.*/', '') = regexp_replace(a.product_id, '^.*/', '')) AS prod_line_rev,
           bool_and((li ? 'line_price') AND (li->>'line_price') IS NOT NULL)
             FILTER (WHERE regexp_replace(li->>'product_id', '^.*/', '') = regexp_replace(a.product_id, '^.*/', '')) AS has_prices,
           MAX(a.subtotal_price) AS subtotal_price,
           MAX(a.total_price)    AS total_price
    FROM attributed a
    CROSS JOIN LATERAL jsonb_array_elements(a.line_items) li
    GROUP BY a.product_id, a.session_id, a.purchase_row_id
  ),
  attr_agg AS (
    SELECT product_id,
           count(DISTINCT session_id) AS purchased_sessions,
           COALESCE(SUM(
             CASE
               WHEN has_prices THEN prod_line_rev
               ELSE COALESCE(subtotal_price, total_price, 0)
                    * prod_units / NULLIF(total_units, 0)
             END
           ), 0) AS attributed_revenue
    FROM line_calc GROUP BY product_id
  )
  SELECT
    p.product_id,
    p.tryons,
    p.tryon_sessions,
    COALESCE(a.purchased_sessions, 0),
    ROUND(COALESCE(a.attributed_revenue, 0), 2),
    ROUND(100.0 * COALESCE(a.purchased_sessions, 0) / NULLIF(p.tryon_sessions, 0), 2)
  FROM per_product p
  LEFT JOIN attr_agg a USING (product_id)
  ORDER BY p.tryons DESC
  LIMIT 50;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. get_vto_return_rates — do tried-on items come back less often?
--    Cohort A: tried-on units inside attributed orders (try-on in window).
--    Cohort B: every unit in every captured order in the window (baseline).
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_vto_return_rates(TEXT, TIMESTAMPTZ, TIMESTAMPTZ);

CREATE FUNCTION public.get_vto_return_rates(
  p_store_slug TEXT,
  p_from       TIMESTAMPTZ,
  p_to         TIMESTAMPTZ
) RETURNS TABLE (
  tried_units_sold           NUMERIC,
  tried_units_refunded       NUMERIC,
  tried_return_rate_pct      NUMERIC,
  all_units_sold             NUMERIC,
  all_units_refunded         NUMERIC,
  all_return_rate_pct        NUMERIC,
  refunded_qualified_revenue NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH base AS (
    SELECT DISTINCT session_id, regexp_replace(product_id, '^.*/', '') AS pid, created_at
    FROM public.tryon_events
    WHERE store_slug = p_store_slug AND success IS TRUE
      AND created_at >= p_from AND created_at < p_to
  ),
  attributed AS (
    SELECT DISTINCT pe.id AS purchase_row_id, pe.order_id, b.pid, pe.line_items
    FROM base b
    JOIN public.purchase_events pe
      ON pe.session_id = b.session_id AND pe.store_slug = p_store_slug
     AND pe.created_at > b.created_at
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(pe.line_items) li
       WHERE regexp_replace(li->>'product_id', '^.*/', '') = b.pid
     )
  ),
  per_order AS (
    SELECT purchase_row_id,
           MAX(order_id)                AS order_id,
           array_agg(DISTINCT pid)      AS tried_pids,
           MAX(line_items::TEXT)::JSONB AS line_items
    FROM attributed GROUP BY purchase_row_id
  ),
  tried_sold AS (
    SELECT COALESCE(SUM(COALESCE((li->>'quantity')::NUMERIC, 1)), 0) AS units
    FROM per_order o
    CROSS JOIN LATERAL jsonb_array_elements(o.line_items) li
    WHERE regexp_replace(li->>'product_id', '^.*/', '') = ANY(o.tried_pids)
  ),
  tried_ref AS (
    SELECT COALESCE(SUM(COALESCE((rli->>'quantity')::NUMERIC, 0)), 0) AS units,
           COALESCE(SUM((rli->>'subtotal')::NUMERIC), 0)              AS amt
    FROM per_order o
    JOIN public.refund_events re
      ON re.store_slug = p_store_slug AND re.order_id = o.order_id
    CROSS JOIN LATERAL jsonb_array_elements(re.line_items) rli
    WHERE o.order_id IS NOT NULL
      AND regexp_replace(rli->>'product_id', '^.*/', '') = ANY(o.tried_pids)
  ),
  all_orders AS (
    SELECT id, order_id, line_items
    FROM public.purchase_events
    WHERE store_slug = p_store_slug
      AND created_at >= p_from AND created_at < p_to
  ),
  all_sold AS (
    SELECT COALESCE(SUM(COALESCE((li->>'quantity')::NUMERIC, 1)), 0) AS units
    FROM all_orders o
    CROSS JOIN LATERAL jsonb_array_elements(o.line_items) li
  ),
  all_ref AS (
    SELECT COALESCE(SUM(COALESCE((rli->>'quantity')::NUMERIC, 0)), 0) AS units
    FROM all_orders o
    JOIN public.refund_events re
      ON re.store_slug = p_store_slug AND re.order_id = o.order_id
    CROSS JOIN LATERAL jsonb_array_elements(re.line_items) rli
    WHERE o.order_id IS NOT NULL
  )
  SELECT
    ts.units,
    tr.units,
    ROUND(100.0 * tr.units / NULLIF(ts.units, 0), 2),
    als.units,
    alr.units,
    ROUND(100.0 * alr.units / NULLIF(als.units, 0), 2),
    ROUND(tr.amt, 2)
  FROM tried_sold ts, tried_ref tr, all_sold als, all_ref alr;
$$;

-- Same access model as the existing dashboard RPCs.
GRANT EXECUTE ON FUNCTION public.get_vto_conversion_summary(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_vto_product_conversion(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_vto_return_rates(TEXT, TIMESTAMPTZ, TIMESTAMPTZ)      TO anon, authenticated, service_role;
