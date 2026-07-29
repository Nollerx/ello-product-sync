-- Migration: get_vto_daily_attributed_revenue — attributed revenue, day by day.
--
-- WHY: get_vto_conversion_summary returns ONE total for the whole window, so the
-- dashboard could only ever say "$1,484 in the last 30 days". Andrew needs the
-- daily shape — which days actually produced attributed sales, and whether a
-- quiet stretch is a real slump or just a tracking gap (cf. the Atlas 07-19 →
-- 07-28 window where the store transfer broke the widget).
--
-- DEFINITIONS (deliberately identical to get_vto_conversion_summary's Qualified
-- Revenue math in 20260713_line_item_attribution.sql, so the daily series SUMS
-- to the headline number instead of telling a second, conflicting story):
--   * An order is attributed when a successful try-on in the SAME session
--     preceded it and the order contains a line for a tried-on product.
--   * Revenue = the tried-on lines only (line_price, post-discount, pre
--     ship/tax). Legacy rows with no line_price prorate
--     COALESCE(subtotal, total) by tried-on units / total units.
--   * Refunds net per order, capped at what was attributed, and only within 45
--     days of the purchase (the billing netting window).
--
-- BUCKETING: rows are bucketed by PURCHASE time — "money that landed that day" —
-- not by try-on time. Purchases are constrained to [p_from, p_to); the try-on
-- that earned them is looked back up to 7 days before p_from (session_ids don't
-- live longer than that, so this only catches purchases straddling the window
-- edge). Verified on ecmxv0-vh 30d: daily rows sum to exactly $1,484.00 gross
-- and net, matching get_vto_conversion_summary for the same window.
--
-- attributed_orders counts ORDERS, while the headline's sessions_purchased counts
-- SESSIONS — on that same window 27 orders came from 26 sessions (one shopper
-- ordered twice). Both are right; they answer different questions, so the UI
-- labels this column "orders".
--
-- p_tz: IANA zone the day boundaries are cut on, so "today" matches the
-- merchant's clock rather than UTC. Unknown zones fall back to UTC rather than
-- erroring. Days with no sales come back as explicit zero rows (generate_series)
-- so a chart shows a flat line, not a compressed one with gaps.
--
-- Security posture matches every other dashboard RPC: SECURITY DEFINER with a
-- pinned search_path, EXECUTE revoked from PUBLIC (which `anon` inherits — see
-- 20260715_revoke_anon_execute_on_sensitive_rpcs.sql) and granted only to
-- authenticated + service_role. Idempotent: safe to re-run.

DROP FUNCTION IF EXISTS public.get_vto_daily_attributed_revenue(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT);

CREATE FUNCTION public.get_vto_daily_attributed_revenue(
  p_store_slug TEXT,
  p_from       TIMESTAMPTZ,
  p_to         TIMESTAMPTZ,
  p_tz         TEXT DEFAULT 'UTC'
) RETURNS TABLE (
  day                    DATE,
  tryon_sessions         BIGINT,   -- sessions with a successful try-on that day
  attributed_orders      BIGINT,   -- orders that day containing a tried-on item
  attributed_revenue     NUMERIC,  -- gross Qualified Revenue (tried-on lines only)
  refunded_revenue       NUMERIC,  -- refunded tried-on lines from those orders
  attributed_revenue_net NUMERIC   -- what the rev-share applies to
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH tz AS (
    -- Unknown/typo'd zone must not 500 the dashboard: fall back to UTC.
    SELECT COALESCE(
      (SELECT name FROM pg_timezone_names WHERE name = p_tz LIMIT 1),
      'UTC'
    ) AS zone
  ),
  base AS (
    SELECT DISTINCT
      session_id,
      regexp_replace(product_id, '^.*/', '') AS pid,
      created_at
    FROM public.tryon_events
    WHERE store_slug = p_store_slug AND success IS TRUE
      AND product_id IS NOT NULL
      -- Look back past p_from so an order on day 1 of the window still finds
      -- the try-on that earned it. Bounded so the join stays cheap.
      AND created_at >= p_from - INTERVAL '7 days'
      AND created_at <  p_to
  ),
  -- One row per (purchase row, tried-on product). pe.id is the dedup key so
  -- NULL order_ids can never merge distinct purchases.
  attributed AS (
    SELECT DISTINCT pe.id AS purchase_row_id, pe.order_id, b.pid,
           pe.total_price, pe.subtotal_price, pe.line_items,
           pe.created_at AS purchased_at
    FROM base b
    JOIN public.purchase_events pe
      ON pe.session_id = b.session_id AND pe.store_slug = p_store_slug
     AND pe.created_at > b.created_at
     AND pe.created_at >= p_from AND pe.created_at < p_to
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(pe.line_items) li
       WHERE regexp_replace(li->>'product_id', '^.*/', '') = b.pid
     )
  ),
  per_order AS (
    SELECT purchase_row_id,
           MAX(order_id)                 AS order_id,
           MAX(purchased_at)             AS purchased_at,
           MAX(total_price)              AS total_price,
           MAX(subtotal_price)           AS subtotal_price,
           array_agg(DISTINCT pid)       AS tried_pids,
           MAX(line_items::TEXT)::JSONB  AS line_items
    FROM attributed
    GROUP BY purchase_row_id
  ),
  order_calc AS (
    SELECT o.purchase_row_id, o.order_id, o.purchased_at, o.tried_pids,
           o.total_price, o.subtotal_price,
           SUM(COALESCE((li->>'quantity')::NUMERIC, 1)) AS total_units,
           SUM(COALESCE((li->>'quantity')::NUMERIC, 1))
             FILTER (WHERE regexp_replace(li->>'product_id', '^.*/', '') = ANY(o.tried_pids)) AS tried_units,
           SUM((li->>'line_price')::NUMERIC)
             FILTER (WHERE regexp_replace(li->>'product_id', '^.*/', '') = ANY(o.tried_pids)) AS tried_line_rev,
           bool_and((li ? 'line_price') AND (li->>'line_price') IS NOT NULL)
             FILTER (WHERE regexp_replace(li->>'product_id', '^.*/', '') = ANY(o.tried_pids)) AS has_prices
    FROM per_order o
    CROSS JOIN LATERAL jsonb_array_elements(o.line_items) li
    GROUP BY o.purchase_row_id, o.order_id, o.purchased_at, o.tried_pids,
             o.total_price, o.subtotal_price
  ),
  qualified AS (
    SELECT oc.purchase_row_id, oc.order_id, oc.purchased_at, oc.tried_pids,
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
    SELECT q.purchase_row_id,
           SUM((rli->>'subtotal')::NUMERIC) AS refunded_qualified
    FROM qualified q
    JOIN public.refund_events re
      ON re.store_slug = p_store_slug AND re.order_id = q.order_id
     AND COALESCE(re.refunded_at, re.created_at) < q.purchased_at + INTERVAL '45 days'
    CROSS JOIN LATERAL jsonb_array_elements(re.line_items) rli
    WHERE q.order_id IS NOT NULL
      AND regexp_replace(rli->>'product_id', '^.*/', '') = ANY(q.tried_pids)
    GROUP BY q.purchase_row_id
  ),
  per_day AS (
    SELECT (q.purchased_at AT TIME ZONE (SELECT zone FROM tz))::DATE AS day,
           COUNT(*) AS attributed_orders,
           SUM(COALESCE(q.qualified_revenue, 0)) AS gross,
           -- Refunds capped per order at what was attributed, so a mostly-
           -- refunded order can never drive a day negative.
           SUM(LEAST(COALESCE(r.refunded_qualified, 0), COALESCE(q.qualified_revenue, 0))) AS refunds
    FROM qualified q
    LEFT JOIN refunded r USING (purchase_row_id)
    GROUP BY 1
  ),
  tryons_per_day AS (
    SELECT (created_at AT TIME ZONE (SELECT zone FROM tz))::DATE AS day,
           COUNT(DISTINCT session_id) AS tryon_sessions
    FROM public.tryon_events
    WHERE store_slug = p_store_slug AND success IS TRUE
      AND created_at >= p_from AND created_at < p_to
    GROUP BY 1
  ),
  days AS (
    SELECT generate_series(
      (p_from AT TIME ZONE (SELECT zone FROM tz))::DATE,
      (p_to   AT TIME ZONE (SELECT zone FROM tz))::DATE,
      INTERVAL '1 day'
    )::DATE AS day
  )
  SELECT d.day,
         COALESCE(t.tryon_sessions, 0),
         COALESCE(p.attributed_orders, 0),
         ROUND(COALESCE(p.gross, 0), 2),
         ROUND(COALESCE(p.refunds, 0), 2),
         ROUND(GREATEST(COALESCE(p.gross, 0) - COALESCE(p.refunds, 0), 0), 2)
  FROM days d
  LEFT JOIN per_day        p USING (day)
  LEFT JOIN tryons_per_day t USING (day)
  ORDER BY d.day;
$$;

-- EXECUTE defaults to PUBLIC, which `anon` inherits — the exact hole
-- 20260715_revoke_anon_execute_on_sensitive_rpcs.sql closed. Revoke first, then
-- grant only the two roles the dashboard and server actually use.
REVOKE ALL ON FUNCTION public.get_vto_daily_attributed_revenue(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_vto_daily_attributed_revenue(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_vto_daily_attributed_revenue(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO authenticated, service_role;
