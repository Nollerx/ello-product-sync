-- ============================================================
-- Widget-wide A/B holdout + proof reporting layer  (2026-07-10)
--
-- 1. vto_experiments            experiment lifecycle history (per store)
-- 2. vto_ab_exposures           one row per (experiment, session) — denominators
-- 3. ello_ab_bucket()           FNV-1a 32-bit bucket 0-99, EXACT mirror of the
--                               JS implementation in public/widget-loader.js.
--                               Salted with experiment_id so buckets reshuffle
--                               per experiment and are independent of the CTL
--                               last-char-parity split.
-- 4. record_ab_exposure()       anon-callable ingest RPC (dedupes on conflict)
-- 5. get_ab_experiment_results  per-variant sessions / converters / revenue
-- 6. get_vto_receipts           attributed order ledger (normalized product ids,
--                               order-deduped, 30-day try-on lookback)
-- 7. vto_stores ab_* columns + get_widget_config + version-bump trigger
--    (trigger also gains the previously-missing ctl_holdout_enabled and
--    lead_capture fields so those toggles finally propagate to shoppers)
-- 8. vto_attributed_purchases view fixed to use normalized product ids
--    (the old jsonb containment join never matched GID-form try-on rows)
-- ============================================================

-- 1 ▸ experiments ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vto_experiments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_slug       text NOT NULL,
  name             text NOT NULL DEFAULT 'Widget holdout test',
  holdout_percent  integer NOT NULL DEFAULT 10 CHECK (holdout_percent BETWEEN 1 AND 50),
  status           text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vto_experiments_store ON public.vto_experiments (store_slug, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vto_experiments_one_running
  ON public.vto_experiments (store_slug) WHERE status = 'running';
ALTER TABLE public.vto_experiments ENABLE ROW LEVEL SECURITY;

-- 2 ▸ exposures -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vto_ab_exposures (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_slug     text NOT NULL,
  experiment_id  uuid NOT NULL REFERENCES public.vto_experiments(id) ON DELETE CASCADE,
  session_id     text NOT NULL,
  variant        text NOT NULL CHECK (variant IN ('exposed','holdout')),
  bucket         integer NOT NULL CHECK (bucket BETWEEN 0 AND 99),
  page_type      text,
  first_seen_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vto_ab_exposures_session
  ON public.vto_ab_exposures (experiment_id, session_id);
CREATE INDEX IF NOT EXISTS idx_vto_ab_exposures_store
  ON public.vto_ab_exposures (store_slug, experiment_id, variant);
ALTER TABLE public.vto_ab_exposures ENABLE ROW LEVEL SECURITY;

-- 3 ▸ deterministic bucket (FNV-1a 32-bit, mod 100) ------------------------
-- JS mirror (widget-loader.js):
--   var h = 0x811c9dc5;
--   for (i) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
--   return (h >>> 0) % 100;
CREATE OR REPLACE FUNCTION public.ello_ab_bucket(p_session_id text, p_experiment_id text)
RETURNS integer
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  s text := p_session_id || ':' || p_experiment_id;
  h bigint := 2166136261;
  i integer;
BEGIN
  FOR i IN 1..length(s) LOOP
    h := h # ascii(substr(s, i, 1));
    h := (h * 16777619) % 4294967296;
  END LOOP;
  RETURN (h % 100)::integer;
END;
$$;

-- 4 ▸ exposure ingest ------------------------------------------------------
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
  VALUES (p_store_slug, p_session_id, p_experiment_id, p_variant, p_bucket, p_page_type)
  ON CONFLICT (experiment_id, session_id) DO NOTHING;
  RETURN jsonb_build_object('success', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.record_ab_exposure(text, text, uuid, text, integer, text) TO anon, authenticated, service_role;

-- 5 ▸ experiment results ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_ab_experiment_results(
  p_store_slug text,
  p_experiment_id uuid
) RETURNS TABLE(
  variant text,
  sessions bigint,
  purchase_sessions bigint,
  orders bigint,
  revenue numeric,
  conversion_pct numeric
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
    SELECT e.variant, e.session_id, e.first_seen_at
    FROM public.vto_ab_exposures e
    JOIN exp ON e.experiment_id = exp.id
  ),
  purch AS (
    SELECT DISTINCT x.variant, x.session_id,
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
    SELECT variant, count(DISTINCT session_id) AS sessions FROM x GROUP BY variant
  ),
  agg_purch AS (
    SELECT variant, count(DISTINCT session_id) AS purchase_sessions FROM purch GROUP BY variant
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
    ROUND(100.0 * COALESCE(p.purchase_sessions, 0) / NULLIF(s.sessions, 0), 3) AS conversion_pct
  FROM agg_sessions s
  LEFT JOIN agg_purch  p USING (variant)
  LEFT JOIN agg_orders o USING (variant);
$$;
GRANT EXECUTE ON FUNCTION public.get_ab_experiment_results(text, uuid) TO service_role;

-- 6 ▸ receipts ledger -------------------------------------------------------
-- Attributed order receipts: purchase in window, same session, order contains
-- the tried-on product (ids normalized on BOTH sides), try-on strictly before
-- purchase and within a 30-day lookback. One row per order (earliest try-on).
CREATE OR REPLACE FUNCTION public.get_vto_receipts(
  p_store_slug text,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer DEFAULT 100
) RETURNS TABLE(
  order_id text,
  product_id text,
  tried_on_at timestamptz,
  purchased_at timestamptz,
  seconds_to_purchase numeric,
  total_price numeric,
  currency text,
  session_id text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH matched AS (
    SELECT DISTINCT ON (COALESCE(pe.order_id, pe.id::text))
      pe.order_id,
      regexp_replace(t.product_id, '^.*/', '') AS product_id,
      t.created_at  AS tried_on_at,
      pe.created_at AS purchased_at,
      EXTRACT(epoch FROM (pe.created_at - t.created_at)) AS seconds_to_purchase,
      pe.total_price,
      pe.currency,
      pe.session_id
    FROM public.purchase_events pe
    JOIN public.tryon_events t
      ON t.session_id = pe.session_id
     AND t.store_slug = pe.store_slug
     AND t.success IS TRUE
     AND t.created_at < pe.created_at
     AND t.created_at >= pe.created_at - interval '30 days'
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(pe.line_items) li
       WHERE regexp_replace(li->>'product_id', '^.*/', '') = regexp_replace(t.product_id, '^.*/', '')
     )
    WHERE pe.store_slug = p_store_slug
      AND pe.created_at >= p_from AND pe.created_at < p_to
    ORDER BY COALESCE(pe.order_id, pe.id::text), t.created_at ASC
  )
  SELECT * FROM matched
  ORDER BY purchased_at DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 500);
$$;
GRANT EXECUTE ON FUNCTION public.get_vto_receipts(text, timestamptz, timestamptz, integer) TO service_role;

-- 7 ▸ config plumbing -------------------------------------------------------
-- ORDER-PROOF vs 20260710_style_overrides.sql: both migrations recreate
-- get_widget_config + the version-bump trigger with the FULL superset of each
-- other's fields (style_overrides pre-created here with an identical def).
-- Whichever runs last, the final state is identical.
ALTER TABLE public.vto_stores ADD COLUMN IF NOT EXISTS ab_experiment_enabled boolean DEFAULT false;
ALTER TABLE public.vto_stores ADD COLUMN IF NOT EXISTS ab_experiment_id uuid;
ALTER TABLE public.vto_stores ADD COLUMN IF NOT EXISTS ab_holdout_percent integer DEFAULT 10;
ALTER TABLE public.vto_stores ADD COLUMN IF NOT EXISTS style_overrides jsonb;

DROP FUNCTION IF EXISTS public.get_widget_config(text, text);
CREATE FUNCTION public.get_widget_config(p_store_slug text DEFAULT NULL::text, p_shop_domain text DEFAULT NULL::text)
RETURNS TABLE(
  store_slug text, shop_domain text, storefront_token text, clothing_population_type text,
  widget_primary_color text, widget_accent_color text, minimized_color text,
  featured_item_id text, quick_picks_ids text[], desktop_preview_enabled boolean,
  preview_delay_seconds integer, preview_theme text, widget_position text,
  widget_visibility_mode text, inline_button_enabled boolean, inline_button_text text,
  inline_button_color text, inline_button_text_color text, inline_button_hide_when_oos boolean,
  floating_widget_pdp_enabled boolean, floating_widget_non_pdp_enabled boolean,
  fitting_room_enabled boolean, complete_the_look_enabled boolean,
  pdp_image_swap_enabled boolean, pdp_image_selector text,
  ctl_holdout_enabled boolean, lead_capture_enabled boolean, lead_capture_after_n integer,
  ab_experiment_enabled boolean, ab_experiment_id uuid, ab_holdout_percent integer,
  style_overrides jsonb,
  config_version bigint
)
LANGUAGE sql STABLE
AS $$
  SELECT s.store_slug, s.shop_domain, s.storefront_token, s.clothing_population_type,
         s.widget_primary_color, s.widget_accent_color, s.minimized_color,
         s.featured_item_id, s.quick_picks_ids, s.desktop_preview_enabled,
         s.preview_delay_seconds, s.preview_theme, s.widget_position,
         s.widget_visibility_mode,
         s.inline_button_enabled, s.inline_button_text, s.inline_button_color,
         s.inline_button_text_color, s.inline_button_hide_when_oos,
         s.floating_widget_pdp_enabled, s.floating_widget_non_pdp_enabled,
         s.fitting_room_enabled,
         s.complete_the_look_enabled,
         s.pdp_image_swap_enabled,
         s.pdp_image_selector,
         s.ctl_holdout_enabled,
         s.lead_capture_enabled, s.lead_capture_after_n,
         s.ab_experiment_enabled, s.ab_experiment_id, s.ab_holdout_percent,
         s.style_overrides,
         s.config_version
    FROM vto_stores s
   WHERE (p_store_slug  IS NOT NULL AND s.store_slug  = p_store_slug)
      OR (p_shop_domain IS NOT NULL AND s.shop_domain = p_shop_domain)
   LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.get_widget_config(text, text) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.bump_vto_store_config_version()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF (NEW.widget_primary_color, NEW.widget_accent_color, NEW.minimized_color,
      NEW.featured_item_id, NEW.quick_picks_ids, NEW.desktop_preview_enabled,
      NEW.preview_delay_seconds, NEW.preview_theme, NEW.widget_position,
      NEW.widget_visibility_mode, NEW.clothing_population_type,
      NEW.storefront_token, NEW.shop_domain,
      NEW.inline_button_enabled, NEW.inline_button_text, NEW.inline_button_color,
      NEW.inline_button_text_color, NEW.inline_button_hide_when_oos,
      NEW.floating_widget_pdp_enabled, NEW.floating_widget_non_pdp_enabled,
      NEW.fitting_room_enabled, NEW.complete_the_look_enabled,
      NEW.pdp_image_swap_enabled, NEW.pdp_image_selector,
      NEW.tryon_targeting_mode, NEW.tryon_included_product_ids,
      NEW.tryon_included_collection_ids,
      NEW.ctl_holdout_enabled, NEW.lead_capture_enabled, NEW.lead_capture_after_n,
      NEW.ab_experiment_enabled, NEW.ab_experiment_id, NEW.ab_holdout_percent,
      NEW.style_overrides)
     IS DISTINCT FROM
     (OLD.widget_primary_color, OLD.widget_accent_color, OLD.minimized_color,
      OLD.featured_item_id, OLD.quick_picks_ids, OLD.desktop_preview_enabled,
      OLD.preview_delay_seconds, OLD.preview_theme, OLD.widget_position,
      OLD.widget_visibility_mode, OLD.clothing_population_type,
      OLD.storefront_token, OLD.shop_domain,
      OLD.inline_button_enabled, OLD.inline_button_text, OLD.inline_button_color,
      OLD.inline_button_text_color, OLD.inline_button_hide_when_oos,
      OLD.floating_widget_pdp_enabled, OLD.floating_widget_non_pdp_enabled,
      OLD.fitting_room_enabled, OLD.complete_the_look_enabled,
      OLD.pdp_image_swap_enabled, OLD.pdp_image_selector,
      OLD.tryon_targeting_mode, OLD.tryon_included_product_ids,
      OLD.tryon_included_collection_ids,
      OLD.ctl_holdout_enabled, OLD.lead_capture_enabled, OLD.lead_capture_after_n,
      OLD.ab_experiment_enabled, OLD.ab_experiment_id, OLD.ab_holdout_percent,
      OLD.style_overrides)
  THEN
    NEW.config_version := COALESCE(OLD.config_version, 0) + 1;
  END IF;
  RETURN NEW;
END;
$function$;

-- 8 ▸ fix the stale attribution view (normalized ids) -----------------------
CREATE OR REPLACE VIEW public.vto_attributed_purchases AS
  SELECT t.store_slug,
         t.session_id,
         regexp_replace(t.product_id, '^.*/', '') AS tried_on_product,
         pe.order_id,
         pe.total_price,
         pe.currency,
         pe.created_at AS purchased_at,
         t.created_at  AS tried_on_at,
         EXTRACT(epoch FROM (pe.created_at - t.created_at)) AS seconds_to_purchase
    FROM public.tryon_events t
    JOIN public.purchase_events pe
      ON pe.session_id = t.session_id
     AND pe.store_slug = t.store_slug
     AND pe.created_at > t.created_at
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(pe.line_items) li
       WHERE regexp_replace(li->>'product_id', '^.*/', '') = regexp_replace(t.product_id, '^.*/', '')
     )
   WHERE t.success IS TRUE;

NOTIFY pgrst, 'reload schema';
