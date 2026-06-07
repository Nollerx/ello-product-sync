-- Purchase attribution: normalize product_id across event sources.
--
-- Root cause of "0 conversions / $0 attributed revenue" in the dashboard even
-- though events were landing: product_id is stored in TWO different formats.
--   * tryon_events.product_id      -> GID form  ("gid://shopify/Product/123")  (widget sends GIDs)
--   * product_view_events / cart_events / purchase_events.line_items[].product_id
--                                  -> bare numeric ("123")                      (Web Pixels API sends numeric IDs)
-- The attribution joins compared product_id = product_id (and used a jsonb @>
-- containment check), so GID-vs-numeric never matched. tryon_sessions counted
-- (no join) but viewed / carted / purchased / revenue were always 0.
--
-- Fix: normalize both sides with regexp_replace(x, '^.*/', '') which strips the
-- "gid://shopify/Product/" prefix and leaves an already-numeric id unchanged.
-- This is a read-side fix (no data backfill) and is correct for existing + future rows.

CREATE OR REPLACE FUNCTION public.get_vto_conversion_summary(
  p_store_slug text,
  p_from timestamp with time zone,
  p_to timestamp with time zone
)
RETURNS TABLE(
  tryon_sessions bigint,
  sessions_viewed_product bigint,
  sessions_added_to_cart bigint,
  sessions_purchased bigint,
  attributed_revenue numeric,
  purchase_conversion_pct numeric,
  cart_conversion_pct numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  attributed AS (
    SELECT b.session_id, pe.order_id, pe.total_price FROM base b
    JOIN public.purchase_events pe
      ON pe.session_id = b.session_id AND pe.store_slug = p_store_slug
     AND pe.created_at > b.created_at
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(pe.line_items) li
       WHERE regexp_replace(li->>'product_id', '^.*/', '') = b.pid
     )
  ),
  purch_sess AS (SELECT DISTINCT session_id FROM attributed),
  revenue AS (
    SELECT COALESCE(SUM(total_price), 0) AS rev
    FROM (SELECT DISTINCT order_id, total_price FROM attributed) d
  )
  SELECT
    (SELECT count(*) FROM tryon_sess),
    (SELECT count(*) FROM viewed),
    (SELECT count(*) FROM carted),
    (SELECT count(*) FROM purch_sess),
    (SELECT rev FROM revenue),
    ROUND(100.0 * (SELECT count(*) FROM purch_sess) / NULLIF((SELECT count(*) FROM tryon_sess), 0), 2),
    ROUND(100.0 * (SELECT count(*) FROM carted)     / NULLIF((SELECT count(*) FROM tryon_sess), 0), 2);
$function$;

CREATE OR REPLACE FUNCTION public.get_vto_product_conversion(
  p_store_slug text,
  p_from timestamp with time zone,
  p_to timestamp with time zone
)
RETURNS TABLE(
  product_id text,
  tryons bigint,
  tryon_sessions bigint,
  purchased_sessions bigint,
  attributed_revenue numeric,
  conversion_pct numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(pe.line_items) li
       WHERE regexp_replace(li->>'product_id', '^.*/', '') = regexp_replace(b.product_id, '^.*/', '')
     )
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
$function$;
