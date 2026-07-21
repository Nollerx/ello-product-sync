-- A/B proof test: honest product-page denominator (saw_pdp)
--
-- WHY: exposure rows are minted on the session's FIRST pageview of ANY type
-- (the loader runs site-wide so both arms share one denominator — that part is
-- correct and stays). But that makes the readout's conversion_pct a
-- "% of ALL visitors" number (~1.4% on Atlas), which a merchant will compare
-- against their product-page conversion rate (~8-9%) and misread as the widget
-- tanking the store. page_type can't fix this: it freezes at the landing page
-- (92% 'other' on Atlas) and never learns the shopper browsed products later.
--
-- saw_pdp is a one-way flag stamped true the first time the session views any
-- /products/ page — sent by the loader for BOTH arms, so the product-page cut
-- stays symmetric. Historical rows keep saw_pdp=false and are deliberately NOT
-- backfilled from product_view_events: that table undercounts sessions ~4x-5x
-- pre-cookie-fix (pixel dropped events when the cookie hadn't been minted
-- yet), and a backfill from a biased source would bake the bias into the
-- readout. The product-page cut is simply empty until real stamps arrive.
--
-- The site-wide numbers remain the PRIMARY causal readout: conditioning on
-- saw_pdp is conditioning on post-assignment behavior (the widget itself may
-- change how many shoppers reach a product page), so the PDP cut is a
-- diagnostic view, not the verdict. The UI labels it accordingly.

ALTER TABLE public.vto_ab_exposures
  ADD COLUMN IF NOT EXISTS saw_pdp boolean NOT NULL DEFAULT false;

-- Adding a parameter changes the function signature, and CREATE OR REPLACE
-- would leave the old 6-arg overload behind — two candidates make PostgREST's
-- named-parameter dispatch ambiguous. Drop the old signature first; the new
-- one defaults p_saw_pdp so not-yet-redeployed callers keep working.
DROP FUNCTION IF EXISTS public.record_ab_exposure(text, text, uuid, text, integer, text);

CREATE FUNCTION public.record_ab_exposure(
  p_store_slug text,
  p_session_id text,
  p_experiment_id uuid,
  p_variant text,
  p_bucket integer,
  p_page_type text DEFAULT NULL,
  p_saw_pdp boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Length gates FIRST: ello_ab_bucket() below iterates per character, so an
  -- unbounded session_id would be a CPU amplifier.
  IF p_session_id IS NULL OR length(p_session_id) > 64
     OR p_store_slug IS NULL OR length(p_store_slug) > 100
     OR p_variant NOT IN ('exposed','holdout') OR p_bucket NOT BETWEEN 0 AND 99 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid');
  END IF;
  -- only accept exposures for a live experiment on this store, and only when
  -- the reported variant matches the server-computed bucket (anti-forgery /
  -- anti-drift: client and SQL must agree or the row is rejected)
  IF NOT EXISTS (
    SELECT 1 FROM public.vto_experiments e
    WHERE e.id = p_experiment_id AND e.store_slug = p_store_slug AND e.status = 'running'
      AND public.ello_ab_bucket(p_session_id, p_experiment_id::text) = p_bucket
      AND ((p_bucket < e.holdout_percent) = (p_variant = 'holdout'))
  ) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'rejected');
  END IF;
  -- On conflict, ONLY saw_pdp may change, and only one-way false→true.
  -- page_type stays the landing-page stamp; variant/bucket are immutable.
  INSERT INTO public.vto_ab_exposures (store_slug, experiment_id, session_id, variant, bucket, page_type, saw_pdp)
  VALUES (p_store_slug, p_experiment_id, p_session_id, p_variant, p_bucket, p_page_type, COALESCE(p_saw_pdp, false))
  ON CONFLICT (experiment_id, session_id) DO UPDATE
    SET saw_pdp = public.vto_ab_exposures.saw_pdp OR EXCLUDED.saw_pdp;
  RETURN jsonb_build_object('success', true);
END;
$$;
-- Mirror live grants (anon was stripped by 20260715_revoke_anon_execute):
GRANT EXECUTE ON FUNCTION public.record_ab_exposure(text, text, uuid, text, integer, text, boolean) TO authenticated, service_role;

-- Results readout: same site-wide primary columns as before, plus the
-- product-page cut per arm. Return shape changes, so drop + recreate.
DROP FUNCTION IF EXISTS public.get_ab_experiment_results(text, uuid);

CREATE FUNCTION public.get_ab_experiment_results(
  p_store_slug text,
  p_experiment_id uuid
) RETURNS TABLE(
  variant text,
  sessions bigint,
  purchase_sessions bigint,
  orders bigint,
  revenue numeric,
  conversion_pct numeric,
  pdp_sessions bigint,
  pdp_purchase_sessions bigint,
  pdp_conversion_pct numeric
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH exp AS (
    SELECT id, started_at, COALESCE(ended_at, now()) AS ended_at
    FROM public.vto_experiments
    WHERE id = p_experiment_id AND store_slug = p_store_slug
  ),
  x AS (
    SELECT e.variant, e.session_id, e.first_seen_at, e.saw_pdp
    FROM public.vto_ab_exposures e
    JOIN exp ON e.experiment_id = exp.id
  ),
  purch AS (
    SELECT DISTINCT x.variant, x.session_id, x.saw_pdp,
           COALESCE(pe.order_id, pe.id::text) AS order_key,
           pe.total_price
    FROM x
    JOIN public.purchase_events pe
      ON pe.session_id = x.session_id
     AND pe.store_slug = p_store_slug
     AND pe.created_at >= x.first_seen_at
     AND pe.created_at <= (SELECT ended_at FROM exp)
  ),
  order_dedup AS (
    SELECT variant, order_key, max(total_price) AS total_price
    FROM purch GROUP BY variant, order_key
  ),
  agg_sessions AS (
    SELECT variant,
           count(DISTINCT session_id) AS sessions,
           count(DISTINCT session_id) FILTER (WHERE saw_pdp) AS pdp_sessions
    FROM x GROUP BY variant
  ),
  agg_purch AS (
    SELECT variant,
           count(DISTINCT session_id) AS purchase_sessions,
           count(DISTINCT session_id) FILTER (WHERE saw_pdp) AS pdp_purchase_sessions
    FROM purch GROUP BY variant
  ),
  agg_orders AS (
    SELECT variant, count(*) AS orders, COALESCE(sum(total_price), 0) AS revenue
    FROM order_dedup GROUP BY variant
  )
  SELECT
    s.variant,
    s.sessions,
    COALESCE(p.purchase_sessions, 0) AS purchase_sessions,
    COALESCE(o.orders, 0)            AS orders,
    COALESCE(o.revenue, 0)           AS revenue,
    ROUND(100.0 * COALESCE(p.purchase_sessions, 0) / NULLIF(s.sessions, 0), 3) AS conversion_pct,
    s.pdp_sessions,
    COALESCE(p.pdp_purchase_sessions, 0) AS pdp_purchase_sessions,
    ROUND(100.0 * COALESCE(p.pdp_purchase_sessions, 0) / NULLIF(s.pdp_sessions, 0), 3) AS pdp_conversion_pct
  FROM agg_sessions s
  LEFT JOIN agg_purch  p USING (variant)
  LEFT JOIN agg_orders o USING (variant);
$$;
GRANT EXECUTE ON FUNCTION public.get_ab_experiment_results(text, uuid) TO authenticated, service_role;
