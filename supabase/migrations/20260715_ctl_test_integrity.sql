-- A/B audit fixes (AB-TESTING-AUDIT-REPORT.md findings 3, 5, and the CTL half
-- of 4): the outfit-upsell holdout gets the same test integrity the widget-wide
-- proof test already has.
--
--   1. End-of-test clamp: vto_stores.ctl_holdout_disabled_at is stamped when a
--      test stops. Without it, rolling windows kept classifying post-stop
--      sessions into a "holdout" arm even though everyone saw the rail again.
--   2. Frozen per-test parameters: get_ctl_performance now accepts the pinned
--      test's percent + active window (p_pct / p_active_from / p_active_to).
--      Arms were previously recomputed from CURRENT store state, so restarting
--      a test with a different percent silently rewrote historical readouts.
--   3. NULL order ids no longer collapse: orders group by
--      COALESCE(order_id, id::text) — the same key the widget-test RPC uses.
--      GROUP BY order_id merged every NULL-order purchase into one pseudo-order
--      with an arbitrary MIN(session_id) arm assignment.
--   4. Per-arm AOV stddev columns feed the dashboard's Welch t-test so the
--      "causal AOV lift" verdict can be significance-gated instead of stamped
--      at face value.
--   5. vto_experiments.ctl_attached records, per test, whether the outfit
--      split rode along with the unified start — so past tests only render
--      outfit arms when an outfit test actually ran.

ALTER TABLE public.vto_stores
  ADD COLUMN IF NOT EXISTS ctl_holdout_disabled_at timestamptz;

ALTER TABLE public.vto_experiments
  ADD COLUMN IF NOT EXISTS ctl_attached boolean NOT NULL DEFAULT false;

-- New parameters change the signature; drop the old 3-arg form so PostgREST
-- never sees an ambiguous overload.
DROP FUNCTION IF EXISTS public.get_ctl_performance(text, timestamptz, timestamptz);

CREATE FUNCTION public.get_ctl_performance(
  p_store_slug text,
  p_from timestamptz,
  p_to timestamptz,
  p_pct integer DEFAULT NULL,
  p_active_from timestamptz DEFAULT NULL,
  p_active_to timestamptz DEFAULT NULL
)
 RETURNS TABLE(
   ctl_tryons bigint,
   ctl_sessions bigint,
   orders_with_look bigint, revenue_with_look numeric, aov_with_look numeric,
   orders_without_look bigint, revenue_without_look numeric, aov_without_look numeric,
   holdout_active boolean, holdout_since timestamptz,
   t_sessions bigint, t_orders bigint, t_revenue numeric, t_aov numeric,
   h_sessions bigint, h_orders bigint, h_revenue numeric, h_aov numeric,
   t_aov_stddev numeric, h_aov_stddev numeric
 )
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT DISTINCT session_id, regexp_replace(product_id, '^.*/', '') AS pid, created_at
    FROM public.tryon_events
    WHERE store_slug = p_store_slug AND success IS TRUE
      AND created_at >= p_from AND created_at < p_to
  ),
  ctl_events AS (
    SELECT session_id, created_at FROM public.tryon_events
    WHERE store_slug = p_store_slug AND success IS TRUE
      AND entry_source = 'complete_the_look'
      AND created_at >= p_from AND created_at < p_to
  ),
  ctl_sess AS (SELECT DISTINCT session_id FROM ctl_events),
  attributed AS (
    SELECT DISTINCT b.session_id,
           COALESCE(pe.order_id, pe.id::text) AS order_key,
           pe.total_price
    FROM base b
    JOIN public.purchase_events pe
      ON pe.session_id = b.session_id AND pe.store_slug = p_store_slug
     AND pe.created_at > b.created_at
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(pe.line_items) li
       WHERE regexp_replace(li->>'product_id', '^.*/', '') = b.pid
     )
  ),
  orders_dedup AS (
    SELECT order_key, MAX(total_price) AS total_price,
           BOOL_OR(session_id IN (SELECT session_id FROM ctl_sess)) AS with_look
    FROM attributed GROUP BY order_key
  ),
  -- Caller-pinned test parameters win; live view falls back to the store's
  -- stamps, with disabled_at closing the window once a test stops. A
  -- disabled_at older than enabled_at belongs to a PREVIOUS test (a restart
  -- clears it, but stay defensive) and is ignored.
  store AS (
    SELECT s.ctl_holdout_enabled, s.ctl_holdout_enabled_at,
           COALESCE(p_pct, s.ctl_holdout_percent, 50) AS pct,
           COALESCE(p_active_from, s.ctl_holdout_enabled_at) AS active_from,
           COALESCE(p_active_to,
             CASE WHEN s.ctl_holdout_disabled_at > s.ctl_holdout_enabled_at
                  THEN s.ctl_holdout_disabled_at END) AS active_to
    FROM public.vto_stores s WHERE s.store_slug = p_store_slug
  ),
  h_base AS (
    SELECT b.session_id, b.pid, b.created_at
    FROM base b, store st
    WHERE st.active_from IS NOT NULL
      AND b.created_at >= GREATEST(p_from, st.active_from)
      AND b.created_at <  LEAST(p_to, COALESCE(st.active_to, p_to))
  ),
  -- Arm = FNV bucket of (session_id, salt 'ctl') vs the test's percent.
  -- EXACT mirror of widget-main.js elloCtlHoldoutBucket.
  h_sess AS (
    SELECT DISTINCT hb.session_id,
           (public.ello_ab_bucket(hb.session_id, 'ctl') >= st.pct) AS is_treatment
    FROM h_base hb, store st
  ),
  -- Purchases clamp to the test window too (mirrors the widget test's
  -- ended_at cap): after the stop, holdout shoppers see the rail again, so
  -- later purchases can no longer be attributed to either arm honestly.
  h_attributed AS (
    SELECT DISTINCT hb.session_id,
           COALESCE(pe.order_id, pe.id::text) AS order_key,
           pe.total_price
    FROM h_base hb
    CROSS JOIN store st
    JOIN public.purchase_events pe
      ON pe.session_id = hb.session_id AND pe.store_slug = p_store_slug
     AND pe.created_at > hb.created_at
     AND pe.created_at < LEAST(p_to, COALESCE(st.active_to, p_to))
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(pe.line_items) li
       WHERE regexp_replace(li->>'product_id', '^.*/', '') = hb.pid
     )
  ),
  h_orders AS (
    SELECT ha.order_key, MAX(ha.total_price) AS total_price,
           (public.ello_ab_bucket(MIN(ha.session_id), 'ctl') >= (SELECT pct FROM store)) AS is_treatment
    FROM h_attributed ha GROUP BY ha.order_key
  )
  SELECT
    (SELECT count(*) FROM ctl_events),
    (SELECT count(*) FROM ctl_sess),
    (SELECT count(*) FROM orders_dedup WHERE with_look),
    (SELECT COALESCE(SUM(total_price), 0) FROM orders_dedup WHERE with_look),
    (SELECT ROUND(AVG(total_price), 2) FROM orders_dedup WHERE with_look),
    (SELECT count(*) FROM orders_dedup WHERE NOT with_look),
    (SELECT COALESCE(SUM(total_price), 0) FROM orders_dedup WHERE NOT with_look),
    (SELECT ROUND(AVG(total_price), 2) FROM orders_dedup WHERE NOT with_look),
    (SELECT COALESCE(ctl_holdout_enabled, false) FROM store),
    (SELECT ctl_holdout_enabled_at FROM store),
    (SELECT count(*) FROM h_sess WHERE is_treatment),
    (SELECT count(*) FROM h_orders WHERE is_treatment),
    (SELECT COALESCE(SUM(total_price), 0) FROM h_orders WHERE is_treatment),
    (SELECT ROUND(AVG(total_price), 2) FROM h_orders WHERE is_treatment),
    (SELECT count(*) FROM h_sess WHERE NOT is_treatment),
    (SELECT count(*) FROM h_orders WHERE NOT is_treatment),
    (SELECT COALESCE(SUM(total_price), 0) FROM h_orders WHERE NOT is_treatment),
    (SELECT ROUND(AVG(total_price), 2) FROM h_orders WHERE NOT is_treatment),
    (SELECT ROUND(stddev_samp(total_price), 2) FROM h_orders WHERE is_treatment),
    (SELECT ROUND(stddev_samp(total_price), 2) FROM h_orders WHERE NOT is_treatment);
$function$;

-- Match the 2026-07-15 anon-hardening pass: a freshly created function gets
-- PUBLIC EXECUTE by default, which would quietly re-open the reporting leak.
REVOKE EXECUTE ON FUNCTION public.get_ctl_performance(text, timestamptz, timestamptz, integer, timestamptz, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_ctl_performance(text, timestamptz, timestamptz, integer, timestamptz, timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_ctl_performance(text, timestamptz, timestamptz, integer, timestamptz, timestamptz) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
