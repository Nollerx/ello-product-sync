-- Migration: Qualified Revenue — order-level discount netting, 7-day pair cap,
--            ledger basis labels, consistent window semantics.
--
-- WHY (Atlas audit, 2026-07-31): the pixel's line_price is Shopify's
-- finalLinePrice, which reflects LINE-level discounts only. Order-level
-- discount codes (sitewide "10% off" etc.) reduce checkout.subtotalPrice but
-- never touch finalLinePrice. Atlas runs sitewide codes on most orders — on
-- 2026-07-31, 89 of 101 new-payload orders had Σ line_price > subtotal_price,
-- with subtotal/Σline landing on exact code percentages (0.90, 0.85, 0.80,
-- 0.75, 0.60, 0.40). Billing on line_price therefore billed 15% of a price the
-- shopper did not pay — the exact thing Qualified-Revenue-Mechanics promises a
-- CFO we never do. Measured overstatement on attributed orders: ~21%.
--
-- WHAT CHANGES (all four RPCs + the ledger view, kept in lockstep):
--
--   1. NET-OF-ALL-DISCOUNTS BASIS — a four-branch cascade, exact first:
--        a. line_alloc   — every line carries line_price AND line_discount
--                          (pixel ≥ 2026-07-31 captures discountAllocations)
--                          and Σ(line_price − line_discount) reconciles to
--                          subtotal within $0.05 → bill the tried lines'
--                          allocation-net sum. Handles product-targeted codes
--                          exactly.
--        b. line_scaled  — lines have prices, subtotal present → bill
--                          tried_line_rev × LEAST(1, subtotal / Σ line_price).
--                          For sitewide % codes the factor IS (1 − d); for
--                          fixed-amount order codes Shopify allocates
--                          proportionally to line price, so scaling reproduces
--                          the allocation to the cent. LEAST(1, …) guarantees
--                          we never bill above the line price.
--        c. line_unscaled— lines have prices but no subtotal to reconcile
--                          against (9 known rows) → line prices as-is.
--        d. prorate      — legacy rows with no line prices → prorate
--                          COALESCE(subtotal, total) by tried units. Rows
--                          where only total exists still include ship+tax;
--                          the Admin-API backfill (2026-07-31) eliminates
--                          these for every order that still exists in Shopify.
--
--   2. 7-DAY PAIR CAP — the contract sentence is "a purchase of a tried-on
--      product completed within seven days of the try-on". That was only ever
--      enforced by the cookie's nominal lifetime, but the cookie is ROLLING —
--      an active shopper can keep one session id far past 7 days from a given
--      try-on. Every attribution join now requires
--      pe.created_at <= tryon.created_at + INTERVAL '7 days'. (A later try-on
--      of the same product re-qualifies the pair — the cap applies per pair,
--      pre-dedup, so the nearest qualifying try-on still attributes.)
--
--   3. WINDOW SEMANTICS — billing follows PURCHASE date; funnel follows
--      TRY-ON date. get_vto_conversion_summary previously put no upper bound
--      on the purchase join, so a purchase after p_to counted into this
--      window's revenue AND the next window's (via the daily RPC) — two
--      stories from one order. Purchases are now bounded to [p_from, p_to)
--      with the try-on base extended 7 days back past p_from (same lookback
--      the daily RPC always had), so a closed month is a closed month and the
--      daily series sums to the headline BY CONSTRUCTION. viewed/carted joins
--      get the same < p_to bound.
--
--   4. LEDGER = INVOICE — vto_attributed_purchases previously summed raw
--      line_price (NULL on all 54 legacy rows) while the RPCs returned
--      prorated numbers: the CFO audit trail disagreed with the invoice. The
--      view now computes the same cascade at per-tried-product grain and
--      labels every row with revenue_basis
--      ('line_alloc' | 'line_scaled' | 'line_unscaled' | 'prorated_subtotal'
--       | 'prorated_total_gross') so every ledger row is self-explaining.
--
--   5. build_daily_rollup.tryon_attributed_revenue previously summed the WHOLE
--      total_price of any order whose session ever had a try-on — no product
--      match, no line math, no cap: a third revenue story. It now delegates to
--      get_vto_daily_attributed_revenue (net) so there is exactly one
--      definition of a qualified dollar in the schema.
--
-- Refund netting is unchanged (45-day window, per-line, floored at zero) and
-- is now symmetric: Shopify refund line subtotals are net of ALL discounts,
-- and so is billing.
--
-- Security posture preserved: rebuilt views re-REVOKE anon/authenticated
-- (20260711_sec_02); functions are replaced in-place (CREATE OR REPLACE, same
-- signatures) so existing ACLs — including the 20260715 anon lockdown — carry
-- over untouched. Idempotent: safe to re-run.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. vto_attributed_purchases — the CFO line-audit view, now on the same
--    basis cascade as the invoice RPCs, with revenue_basis labels and the
--    7-day pair cap. vto_conversion_summary depends on it → drop and rebuild.
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
  -- This product's own lines, net of all discounts (cascade in the header).
  ROUND(
    CASE
      WHEN lr.prod_has_prices AND lr.all_has_disc AND pe.subtotal_price IS NOT NULL
           AND ABS((lr.all_line_rev - lr.all_disc) - pe.subtotal_price) <= 0.05
        THEN lr.prod_net_alloc
      WHEN lr.prod_has_prices AND lr.all_has_prices AND pe.subtotal_price IS NOT NULL
           AND lr.all_line_rev > 0
        THEN lr.prod_line_rev * LEAST(1, pe.subtotal_price / lr.all_line_rev)
      WHEN lr.prod_has_prices
        THEN lr.prod_line_rev
      ELSE COALESCE(pe.subtotal_price, pe.total_price, 0)
           * lr.prod_units / NULLIF(lr.total_units, 0)
    END
  , 2)                                               AS attributed_line_revenue,
  CASE
    WHEN lr.prod_has_prices AND lr.all_has_disc AND pe.subtotal_price IS NOT NULL
         AND ABS((lr.all_line_rev - lr.all_disc) - pe.subtotal_price) <= 0.05
      THEN 'line_alloc'
    WHEN lr.prod_has_prices AND lr.all_has_prices AND pe.subtotal_price IS NOT NULL
         AND lr.all_line_rev > 0
      THEN 'line_scaled'
    WHEN lr.prod_has_prices
      THEN 'line_unscaled'
    WHEN pe.subtotal_price IS NOT NULL
      THEN 'prorated_subtotal'
    ELSE 'prorated_total_gross'
  END                                                AS revenue_basis,
  pe.currency,
  pe.created_at                                      AS purchased_at,
  t.created_at                                       AS tried_on_at,
  EXTRACT(EPOCH FROM (pe.created_at - t.created_at)) AS seconds_to_purchase
FROM public.tryon_events t
JOIN public.purchase_events pe
  ON  pe.session_id = t.session_id
  AND pe.store_slug = t.store_slug
  AND pe.created_at > t.created_at
  -- Contract: within seven days of the try-on. Applied per (try-on, purchase)
  -- pair BEFORE the DISTINCT ON, so a later re-try-on still qualifies.
  AND pe.created_at <= t.created_at + INTERVAL '7 days'
CROSS JOIN LATERAL (
  SELECT
    COUNT(*)    FILTER (WHERE x.is_prod)                                  AS n_prod,
    SUM(x.lp)   FILTER (WHERE x.is_prod)                                  AS prod_line_rev,
    SUM(GREATEST(x.lp - COALESCE(x.ld, 0), 0)) FILTER (WHERE x.is_prod)   AS prod_net_alloc,
    SUM(x.qty)  FILTER (WHERE x.is_prod)                                  AS prod_units,
    COALESCE(bool_and(x.lp IS NOT NULL) FILTER (WHERE x.is_prod), false)  AS prod_has_prices,
    SUM(x.lp)                                                             AS all_line_rev,
    SUM(x.ld)                                                             AS all_disc,
    COALESCE(bool_and(x.lp IS NOT NULL), false)                           AS all_has_prices,
    COALESCE(bool_and(x.ld IS NOT NULL), false)                           AS all_has_disc,
    SUM(x.qty)                                                            AS total_units
  FROM (
    SELECT (li->>'line_price')::NUMERIC                    AS lp,
           (li->>'line_discount')::NUMERIC                 AS ld,
           COALESCE((li->>'quantity')::NUMERIC, 1)         AS qty,
           regexp_replace(li->>'product_id', '^.*/', '') =
             regexp_replace(t.product_id, '^.*/', '')      AS is_prod
    FROM jsonb_array_elements(pe.line_items) li
  ) x
) lr
WHERE t.success IS TRUE AND lr.n_prod > 0
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
-- 2. get_vto_conversion_summary — netting cascade + 7-day pair cap + purchase
--    window bound [p_from, p_to) with 7-day try-on lookback. Same return
--    shape → CREATE OR REPLACE preserves the existing ACLs.
-- ─────────────────────────────────────────────────────────────────────────────
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
  refunded_revenue        NUMERIC,
  attributed_revenue_net  NUMERIC,
  purchase_conversion_pct NUMERIC,
  cart_conversion_pct     NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  -- Funnel counts (tryon/viewed/carted) follow TRY-ON date: base_win.
  -- Billing (revenue, purchased sessions) follows PURCHASE date: base_bill
  -- looks back 7 days past p_from so an order on day 1 still finds the try-on
  -- that earned it, and purchases are bounded to [p_from, p_to) so a closed
  -- window never moves and never double-counts with the next one.
  WITH base_win AS (
    SELECT DISTINCT
      session_id,
      regexp_replace(product_id, '^.*/', '') AS pid,
      created_at
    FROM public.tryon_events
    WHERE store_slug = p_store_slug AND success IS TRUE
      AND created_at >= p_from AND created_at < p_to
  ),
  tryon_sess AS (SELECT DISTINCT session_id FROM base_win),
  viewed AS (
    SELECT DISTINCT b.session_id FROM base_win b
    JOIN public.product_view_events v
      ON v.session_id = b.session_id AND v.store_slug = p_store_slug
     AND regexp_replace(v.product_id, '^.*/', '') = b.pid
     AND v.created_at > b.created_at
     AND v.created_at < p_to
  ),
  carted AS (
    SELECT DISTINCT b.session_id FROM base_win b
    JOIN public.cart_events c
      ON c.session_id = b.session_id AND c.store_slug = p_store_slug
     AND regexp_replace(c.product_id, '^.*/', '') = b.pid
     AND c.created_at > b.created_at
     AND c.created_at < p_to
  ),
  base_bill AS (
    SELECT DISTINCT
      session_id,
      regexp_replace(product_id, '^.*/', '') AS pid,
      created_at
    FROM public.tryon_events
    WHERE store_slug = p_store_slug AND success IS TRUE
      AND created_at >= p_from - INTERVAL '7 days'
      AND created_at <  p_to
  ),
  attributed AS (
    SELECT DISTINCT pe.id AS purchase_row_id, pe.order_id, b.session_id, b.pid,
           pe.total_price, pe.subtotal_price, pe.line_items,
           pe.created_at AS purchased_at
    FROM base_bill b
    JOIN public.purchase_events pe
      ON pe.session_id = b.session_id AND pe.store_slug = p_store_slug
     AND pe.created_at > b.created_at
     AND pe.created_at <= b.created_at + INTERVAL '7 days'
     AND pe.created_at >= p_from AND pe.created_at < p_to
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
           SUM(GREATEST((li->>'line_price')::NUMERIC - COALESCE((li->>'line_discount')::NUMERIC, 0), 0))
             FILTER (WHERE regexp_replace(li->>'product_id', '^.*/', '') = ANY(o.tried_pids)) AS tried_net_alloc,
           bool_and((li ? 'line_price') AND (li->>'line_price') IS NOT NULL)
             FILTER (WHERE regexp_replace(li->>'product_id', '^.*/', '') = ANY(o.tried_pids)) AS has_prices,
           SUM((li->>'line_price')::NUMERIC)    AS all_line_rev,
           SUM((li->>'line_discount')::NUMERIC) AS all_disc,
           bool_and((li ? 'line_price') AND (li->>'line_price') IS NOT NULL)       AS all_has_prices,
           bool_and((li ? 'line_discount') AND (li->>'line_discount') IS NOT NULL) AS all_has_disc
    FROM per_order o
    CROSS JOIN LATERAL jsonb_array_elements(o.line_items) li
    GROUP BY o.purchase_row_id, o.order_id, o.total_price, o.subtotal_price, o.tried_pids
  ),
  qualified AS (
    SELECT oc.purchase_row_id, oc.order_id,
           -- Net-of-all-discounts cascade — see migration header.
           CASE
             WHEN oc.has_prices AND oc.all_has_disc AND oc.subtotal_price IS NOT NULL
                  AND ABS((oc.all_line_rev - oc.all_disc) - oc.subtotal_price) <= 0.05
               THEN oc.tried_net_alloc
             WHEN oc.has_prices AND oc.all_has_prices AND oc.subtotal_price IS NOT NULL
                  AND oc.all_line_rev > 0
               THEN oc.tried_line_rev * LEAST(1, oc.subtotal_price / oc.all_line_rev)
             WHEN oc.has_prices THEN oc.tried_line_rev
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
     AND COALESCE(re.refunded_at, re.created_at) < o.purchased_at + INTERVAL '45 days'
    CROSS JOIN LATERAL jsonb_array_elements(re.line_items) rli
    WHERE o.order_id IS NOT NULL
      AND regexp_replace(rli->>'product_id', '^.*/', '') = ANY(o.tried_pids)
    GROUP BY o.purchase_row_id
  ),
  revenue AS (
    SELECT
      COALESCE(SUM(q.qualified_revenue), 0) AS gross,
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
-- 3. get_vto_daily_attributed_revenue — netting cascade + 7-day pair cap.
--    Window semantics were already purchase-dated with try-on lookback.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_vto_daily_attributed_revenue(
  p_store_slug TEXT,
  p_from       TIMESTAMPTZ,
  p_to         TIMESTAMPTZ,
  p_tz         TEXT DEFAULT 'UTC'
) RETURNS TABLE (
  day                    DATE,
  tryon_sessions         BIGINT,
  attributed_orders      BIGINT,
  attributed_revenue     NUMERIC,
  refunded_revenue       NUMERIC,
  attributed_revenue_net NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH tz AS (
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
      AND created_at >= p_from - INTERVAL '7 days'
      AND created_at <  p_to
  ),
  attributed AS (
    SELECT DISTINCT pe.id AS purchase_row_id, pe.order_id, b.pid,
           pe.total_price, pe.subtotal_price, pe.line_items,
           pe.created_at AS purchased_at
    FROM base b
    JOIN public.purchase_events pe
      ON pe.session_id = b.session_id AND pe.store_slug = p_store_slug
     AND pe.created_at > b.created_at
     AND pe.created_at <= b.created_at + INTERVAL '7 days'
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
           SUM(GREATEST((li->>'line_price')::NUMERIC - COALESCE((li->>'line_discount')::NUMERIC, 0), 0))
             FILTER (WHERE regexp_replace(li->>'product_id', '^.*/', '') = ANY(o.tried_pids)) AS tried_net_alloc,
           bool_and((li ? 'line_price') AND (li->>'line_price') IS NOT NULL)
             FILTER (WHERE regexp_replace(li->>'product_id', '^.*/', '') = ANY(o.tried_pids)) AS has_prices,
           SUM((li->>'line_price')::NUMERIC)    AS all_line_rev,
           SUM((li->>'line_discount')::NUMERIC) AS all_disc,
           bool_and((li ? 'line_price') AND (li->>'line_price') IS NOT NULL)       AS all_has_prices,
           bool_and((li ? 'line_discount') AND (li->>'line_discount') IS NOT NULL) AS all_has_disc
    FROM per_order o
    CROSS JOIN LATERAL jsonb_array_elements(o.line_items) li
    GROUP BY o.purchase_row_id, o.order_id, o.purchased_at, o.tried_pids,
             o.total_price, o.subtotal_price
  ),
  qualified AS (
    SELECT oc.purchase_row_id, oc.order_id, oc.purchased_at, oc.tried_pids,
           CASE
             WHEN oc.has_prices AND oc.all_has_disc AND oc.subtotal_price IS NOT NULL
                  AND ABS((oc.all_line_rev - oc.all_disc) - oc.subtotal_price) <= 0.05
               THEN oc.tried_net_alloc
             WHEN oc.has_prices AND oc.all_has_prices AND oc.subtotal_price IS NOT NULL
                  AND oc.all_line_rev > 0
               THEN oc.tried_line_rev * LEAST(1, oc.subtotal_price / oc.all_line_rev)
             WHEN oc.has_prices THEN oc.tried_line_rev
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

-- Re-assert the 20260729 grant posture (OR REPLACE preserves ACLs, but this
-- keeps the migration self-contained if it ever runs on a fresh database).
REVOKE ALL ON FUNCTION public.get_vto_daily_attributed_revenue(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_vto_daily_attributed_revenue(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_vto_daily_attributed_revenue(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. get_vto_product_conversion — same cascade at per-product grain, purchase
--    join bounded to the window with the 7-day pair cap. Product rows credit
--    windows by TRY-ON date (this is a "which products convert" list, not an
--    invoice), so no lookback base here.
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
     AND pe.created_at <= b.created_at + INTERVAL '7 days'
     AND pe.created_at < p_to
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
           SUM(GREATEST((li->>'line_price')::NUMERIC - COALESCE((li->>'line_discount')::NUMERIC, 0), 0))
             FILTER (WHERE regexp_replace(li->>'product_id', '^.*/', '') = regexp_replace(a.product_id, '^.*/', '')) AS prod_net_alloc,
           bool_and((li ? 'line_price') AND (li->>'line_price') IS NOT NULL)
             FILTER (WHERE regexp_replace(li->>'product_id', '^.*/', '') = regexp_replace(a.product_id, '^.*/', '')) AS has_prices,
           SUM((li->>'line_price')::NUMERIC)    AS all_line_rev,
           SUM((li->>'line_discount')::NUMERIC) AS all_disc,
           bool_and((li ? 'line_price') AND (li->>'line_price') IS NOT NULL)       AS all_has_prices,
           bool_and((li ? 'line_discount') AND (li->>'line_discount') IS NOT NULL) AS all_has_disc,
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
               WHEN has_prices AND all_has_disc AND subtotal_price IS NOT NULL
                    AND ABS((all_line_rev - all_disc) - subtotal_price) <= 0.05
                 THEN prod_net_alloc
               WHEN has_prices AND all_has_prices AND subtotal_price IS NOT NULL
                    AND all_line_rev > 0
                 THEN prod_line_rev * LEAST(1, subtotal_price / all_line_rev)
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
-- 5. get_vto_return_rates — units only (no price basis change); the attributed
--    cohort gets the 7-day pair cap and the purchase window bound so its
--    orders match the billing definition.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_vto_return_rates(
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
      AND created_at >= p_from - INTERVAL '7 days'
      AND created_at < p_to
  ),
  attributed AS (
    SELECT DISTINCT pe.id AS purchase_row_id, pe.order_id, b.pid, pe.line_items
    FROM base b
    JOIN public.purchase_events pe
      ON pe.session_id = b.session_id AND pe.store_slug = p_store_slug
     AND pe.created_at > b.created_at
     AND pe.created_at <= b.created_at + INTERVAL '7 days'
     AND pe.created_at >= p_from AND pe.created_at < p_to
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. build_daily_rollup — tryon_purchases / tryon_attributed_revenue now come
--    from get_vto_daily_attributed_revenue (net), so the rollup can never tell
--    a different revenue story than the dashboard and the invoice.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.build_daily_rollup(p_day date DEFAULT (CURRENT_DATE - 1))
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
  INSERT INTO vto_daily_store_rollups AS r
    (store_slug, day, product_views, pdp_sessions, widget_opens, widget_open_sessions,
     tryons_total, tryons_success, tryon_sessions, carts_total, cart_sessions,
     purchases, purchase_revenue, tryon_purchases, tryon_attributed_revenue)
  SELECT COALESCE(pv.store_slug, w.store_slug, t.store_slug, c.store_slug, p.store_slug), p_day,
         COALESCE(pv.views,0), COALESCE(pv.sessions,0),
         COALESCE(w.opens,0), COALESCE(w.open_sessions,0),
         COALESCE(t.total,0), COALESCE(t.success,0), COALESCE(t.sessions,0),
         COALESCE(c.total,0), COALESCE(c.sessions,0),
         COALESCE(p.n,0), COALESCE(p.rev,0), COALESCE(q.tryon_n,0), COALESCE(q.tryon_rev,0)
  FROM (SELECT store_slug, count(*) views, count(DISTINCT session_id) sessions
        FROM product_view_events WHERE created_at >= p_day AND created_at < p_day+1 GROUP BY 1) pv
  FULL JOIN (SELECT store_slug, count(*) FILTER (WHERE event_type='widget_open') opens,
             count(DISTINCT session_id) FILTER (WHERE event_type='widget_open') open_sessions
             FROM widget_events WHERE created_at >= p_day AND created_at < p_day+1 GROUP BY 1) w USING (store_slug)
  FULL JOIN (SELECT store_slug, count(*) total, count(*) FILTER (WHERE success) success,
             count(DISTINCT session_id) sessions
             FROM tryon_events WHERE created_at >= p_day AND created_at < p_day+1 GROUP BY 1) t USING (store_slug)
  FULL JOIN (SELECT store_slug, count(*) total, count(DISTINCT session_id) sessions
             FROM cart_events WHERE created_at >= p_day AND created_at < p_day+1 GROUP BY 1) c USING (store_slug)
  FULL JOIN (SELECT store_slug, count(*) n, sum(total_price) rev
             FROM purchase_events WHERE created_at >= p_day AND created_at < p_day+1 GROUP BY 1) p USING (store_slug)
  -- Qualified Revenue for the day, from the single source of truth. UTC day
  -- bounds match every other CTE in this rollup.
  LEFT JOIN LATERAL (
    SELECT a.attributed_orders AS tryon_n, a.attributed_revenue_net AS tryon_rev
    FROM public.get_vto_daily_attributed_revenue(
           COALESCE(pv.store_slug, w.store_slug, t.store_slug, c.store_slug, p.store_slug),
           p_day::timestamptz, (p_day+1)::timestamptz, 'UTC') a
    WHERE a.day = p_day
  ) q ON true
  ON CONFLICT (store_slug, day) DO UPDATE SET
    product_views=EXCLUDED.product_views, pdp_sessions=EXCLUDED.pdp_sessions,
    widget_opens=EXCLUDED.widget_opens, widget_open_sessions=EXCLUDED.widget_open_sessions,
    tryons_total=EXCLUDED.tryons_total, tryons_success=EXCLUDED.tryons_success, tryon_sessions=EXCLUDED.tryon_sessions,
    carts_total=EXCLUDED.carts_total, cart_sessions=EXCLUDED.cart_sessions,
    purchases=EXCLUDED.purchases, purchase_revenue=EXCLUDED.purchase_revenue,
    tryon_purchases=EXCLUDED.tryon_purchases, tryon_attributed_revenue=EXCLUDED.tryon_attributed_revenue;
$$;
