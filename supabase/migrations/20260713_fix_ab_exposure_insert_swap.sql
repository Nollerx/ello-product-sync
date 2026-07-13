-- Fix: record_ab_exposure() inserted p_session_id into experiment_id and
-- p_experiment_id into session_id (swapped VALUES order). PL/pgSQL defers
-- type checks to runtime, so the function created cleanly but EVERY insert
-- raised 42804 (text into uuid column). The API route ignores RPC errors,
-- so exposures were silently lost — a proof test would collect zero
-- denominators forever. Found 2026-07-13 during the live A/B audit; the
-- original 20260710_ab_holdout_proof.sql is fixed in-repo for fresh
-- environments, this migration repairs already-provisioned databases.
CREATE OR REPLACE FUNCTION public.record_ab_exposure(
  p_store_slug text,
  p_session_id text,
  p_experiment_id uuid,
  p_variant text,
  p_bucket integer,
  p_page_type text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Length gates FIRST: ello_ab_bucket() below iterates per character, so an
  -- unbounded session_id from this anon-callable RPC would be a CPU amplifier.
  -- Real widget session ids are ~17 chars; slugs are shop domains at most.
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
  INSERT INTO public.vto_ab_exposures (store_slug, experiment_id, session_id, variant, bucket, page_type)
  VALUES (p_store_slug, p_experiment_id, p_session_id, p_variant, p_bucket, p_page_type)
  ON CONFLICT (experiment_id, session_id) DO NOTHING;
  RETURN jsonb_build_object('success', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.record_ab_exposure(text, text, uuid, text, integer, text) TO anon, authenticated, service_role;
