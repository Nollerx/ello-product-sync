-- ============================================================================
-- Product split test — per-product 50/50 shopper experiment  (2026-08-31)
--
-- The second experiment kind on the Proof page: the merchant picks products,
-- and on THOSE product pages every shopper is split 50/50 — half see the
-- try-on entry points, half don't. Conversion is compared on the SAME product
-- between the two groups, which is the statistically clean version of
-- "turn try-on on for only some items": splitting by product (on for A, off
-- for B) confounds the comparison with each product's own baseline rate.
--
-- Mechanics mirror the site-wide holdout exactly, with a product-salted hash:
--   widget:  elloAbFnvBucket(session_id, experiment_id + ':' + product_id)
--   SQL:     ello_ab_bucket(session_id, experiment_id::text || ':' || product_id)
-- (same FNV-1a pair, same anti-drift recompute-and-reject on ingest). Product
-- ids are NORMALIZED NUMERIC STRINGS everywhere (regexp_replace '^.*/' → ''),
-- matching purchase_events.line_items joins.
--
-- What this file does:
--   1. vto_experiments: kind ('sitewide'|'product') + test_products jsonb
--      (frozen [{id, handle, title}] at start time — the readout's labels)
--   2. vto_ab_exposures: product_id column; the unique index becomes a PAIR of
--      partial indexes (sitewide rows keep one-per-session, product rows get
--      one-per-session-per-product)
--   3. record_ab_exposure: re-created (same signature) so its ON CONFLICT
--      names the now-partial index, + a kind guard so a stale (pre-deploy,
--      edge-cached) loader can never log sitewide-salted rows into a product
--      experiment
--   4. record_ab_product_exposure: new ingest RPC for product exposures
--   5. get_ab_product_results: per-(product, variant) sessions / converters /
--      orders / line revenue — conversion = bought THAT product
--   6. get_vto_top_viewed_products: the "choose for me" suggestion list
--   7. vto_stores: ab_experiment_kind + ab_test_products (slim [{id, handle}]
--      copy for the widget) + get_widget_config DROP/CREATE/GRANT + version
--      trigger walk (checklist steps 1-3; steps 4 = widget-loader.js mapping
--      ships in the same deploy; step 5 widget-main N/A — suppression is
--      loader-level and widget-main never loads on suppressed pages; step 6
--      N/A — the setting lives on the Proof page, not Widget Design)
--
-- Apply by hand in the Supabase SQL editor. Idempotent: safe to re-run.
-- DEPLOY ORDER: apply this SQL + deploy the app (new loader) + purge the
-- Cloudflare widget cache BEFORE starting the first product test — an
-- edge-cached OLD loader treats a product experiment as a site-wide 50%
-- holdout (its exposures are rejected by the kind guard, but its shoppers
-- would browse without the widget until the cache turns over).
-- ============================================================================

-- 1 ▸ experiments: kind + frozen product list --------------------------------
ALTER TABLE public.vto_experiments
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'sitewide'
    CHECK (kind IN ('sitewide', 'product'));
ALTER TABLE public.vto_experiments
  ADD COLUMN IF NOT EXISTS test_products jsonb;

-- 2 ▸ exposures: product grain -----------------------------------------------
ALTER TABLE public.vto_ab_exposures
  ADD COLUMN IF NOT EXISTS product_id text;

-- The old one-row-per-(experiment, session) unique index must not block
-- product rows. Replace it with two partial indexes: sitewide rows keep the
-- old rule, product rows dedupe per (experiment, session, product).
DROP INDEX IF EXISTS public.uq_vto_ab_exposures_session;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vto_ab_exposures_session
  ON public.vto_ab_exposures (experiment_id, session_id)
  WHERE product_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vto_ab_exposures_session_product
  ON public.vto_ab_exposures (experiment_id, session_id, product_id)
  WHERE product_id IS NOT NULL;

-- 3 ▸ sitewide ingest re-created: partial-index arbiter + kind guard ---------
-- Same signature as 20260718 (CREATE OR REPLACE is safe); the ON CONFLICT
-- target must name the partial index's predicate now that the index carries
-- one, and a product-kind experiment must reject sitewide-salted rows (they
-- can only come from a stale pre-deploy loader).
CREATE OR REPLACE FUNCTION public.record_ab_exposure(
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
  IF NOT EXISTS (
    SELECT 1 FROM public.vto_experiments e
    WHERE e.id = p_experiment_id AND e.store_slug = p_store_slug AND e.status = 'running'
      AND e.kind = 'sitewide'
      AND public.ello_ab_bucket(p_session_id, p_experiment_id::text) = p_bucket
      AND ((p_bucket < e.holdout_percent) = (p_variant = 'holdout'))
  ) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'rejected');
  END IF;
  -- On conflict, ONLY saw_pdp may change, and only one-way false→true.
  INSERT INTO public.vto_ab_exposures (store_slug, experiment_id, session_id, variant, bucket, page_type, saw_pdp)
  VALUES (p_store_slug, p_experiment_id, p_session_id, p_variant, p_bucket, p_page_type, COALESCE(p_saw_pdp, false))
  ON CONFLICT (experiment_id, session_id) WHERE product_id IS NULL DO UPDATE
    SET saw_pdp = public.vto_ab_exposures.saw_pdp OR EXCLUDED.saw_pdp;
  RETURN jsonb_build_object('success', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.record_ab_exposure(text, text, uuid, text, integer, text, boolean) TO authenticated, service_role;

-- 4 ▸ product-exposure ingest -------------------------------------------------
-- One row per (experiment, session, product), minted when a shopper views a
-- test product's page. saw_pdp is definitionally true. The bucket recompute
-- uses the product-salted hash, and the product must be in the experiment's
-- frozen list — a beacon for a product outside the test is rejected.
CREATE OR REPLACE FUNCTION public.record_ab_product_exposure(
  p_store_slug text,
  p_session_id text,
  p_experiment_id uuid,
  p_product_id text,
  p_variant text,
  p_bucket integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF p_session_id IS NULL OR length(p_session_id) > 64
     OR p_store_slug IS NULL OR length(p_store_slug) > 100
     OR p_product_id IS NULL OR p_product_id !~ '^[0-9]{1,20}$'
     OR p_variant NOT IN ('exposed','holdout') OR p_bucket NOT BETWEEN 0 AND 99 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.vto_experiments e
    WHERE e.id = p_experiment_id AND e.store_slug = p_store_slug AND e.status = 'running'
      AND e.kind = 'product'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(e.test_products, '[]'::jsonb)) tp
        WHERE tp->>'id' = p_product_id
      )
      AND public.ello_ab_bucket(p_session_id, p_experiment_id::text || ':' || p_product_id) = p_bucket
      AND ((p_bucket < e.holdout_percent) = (p_variant = 'holdout'))
  ) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'rejected');
  END IF;
  INSERT INTO public.vto_ab_exposures (store_slug, experiment_id, session_id, variant, bucket, page_type, saw_pdp, product_id)
  VALUES (p_store_slug, p_experiment_id, p_session_id, p_variant, p_bucket, 'product', true, p_product_id)
  ON CONFLICT (experiment_id, session_id, product_id) WHERE product_id IS NOT NULL DO NOTHING;
  RETURN jsonb_build_object('success', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.record_ab_product_exposure(text, text, uuid, text, text, integer) TO authenticated, service_role;

-- 5 ▸ product results ---------------------------------------------------------
-- Per (product, variant): exposure sessions, sessions that bought THAT product,
-- order count, and the product's own line revenue (line_price net of
-- line_discount when present — deliberately line-grain, unlike the site-wide
-- test's whole-order gross, because the question here is per-product).
-- Purchases join on session_id within [first exposure, test end], same as the
-- site-wide readout. Pooling and significance happen in TypeScript.
DROP FUNCTION IF EXISTS public.get_ab_product_results(text, uuid);
CREATE FUNCTION public.get_ab_product_results(
  p_store_slug text,
  p_experiment_id uuid
) RETURNS TABLE(
  product_id text,
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
    SELECT id, COALESCE(ended_at, now()) AS ended_at
    FROM public.vto_experiments
    WHERE id = p_experiment_id AND store_slug = p_store_slug AND kind = 'product'
  ),
  x AS (
    SELECT e.product_id, e.variant, e.session_id, e.first_seen_at
    FROM public.vto_ab_exposures e
    JOIN exp ON e.experiment_id = exp.id
    WHERE e.product_id IS NOT NULL
  ),
  purch AS (
    SELECT DISTINCT x.product_id, x.variant, x.session_id,
           COALESCE(pe.order_id, pe.id::text) AS order_key,
           (SELECT COALESCE(sum(GREATEST(
                     COALESCE(NULLIF(li->>'line_price','')::numeric, 0)
                     - COALESCE(NULLIF(li->>'line_discount','')::numeric, 0), 0)), 0)
              FROM jsonb_array_elements(pe.line_items) li
             WHERE regexp_replace(li->>'product_id', '^.*/', '') = x.product_id) AS line_revenue
    FROM x
    JOIN public.purchase_events pe
      ON pe.session_id = x.session_id
     AND pe.store_slug = p_store_slug
     AND pe.created_at >= x.first_seen_at
     AND pe.created_at <= (SELECT ended_at FROM exp)
    WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements(pe.line_items) li
      WHERE regexp_replace(li->>'product_id', '^.*/', '') = x.product_id
    )
  ),
  order_dedup AS (
    SELECT product_id, variant, order_key, max(line_revenue) AS line_revenue
    FROM purch GROUP BY product_id, variant, order_key
  ),
  agg_sessions AS (
    SELECT product_id, variant, count(DISTINCT session_id) AS sessions
    FROM x GROUP BY product_id, variant
  ),
  agg_purch AS (
    SELECT product_id, variant, count(DISTINCT session_id) AS purchase_sessions
    FROM purch GROUP BY product_id, variant
  ),
  agg_orders AS (
    SELECT product_id, variant, count(*) AS orders, COALESCE(sum(line_revenue), 0) AS revenue
    FROM order_dedup GROUP BY product_id, variant
  )
  SELECT
    s.product_id,
    s.variant,
    s.sessions,
    COALESCE(p.purchase_sessions, 0) AS purchase_sessions,
    COALESCE(o.orders, 0)            AS orders,
    COALESCE(o.revenue, 0)           AS revenue,
    ROUND(100.0 * COALESCE(p.purchase_sessions, 0) / NULLIF(s.sessions, 0), 3) AS conversion_pct
  FROM agg_sessions s
  LEFT JOIN agg_purch  p USING (product_id, variant)
  LEFT JOIN agg_orders o USING (product_id, variant);
$$;
GRANT EXECUTE ON FUNCTION public.get_ab_product_results(text, uuid) TO authenticated, service_role;

-- 6 ▸ suggestion list: most-viewed products -----------------------------------
-- Powers "choose for me" in the product-test setup. Normalized numeric ids so
-- the caller can build GIDs for the Storefront title/handle lookup.
DROP FUNCTION IF EXISTS public.get_vto_top_viewed_products(text, integer, integer);
CREATE FUNCTION public.get_vto_top_viewed_products(
  p_store_slug text,
  p_days integer DEFAULT 30,
  p_limit integer DEFAULT 20
) RETURNS TABLE(product_id text, views bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT regexp_replace(product_id, '^.*/', '') AS product_id, count(*) AS views
  FROM public.product_view_events
  WHERE store_slug = p_store_slug
    AND product_id IS NOT NULL
    AND created_at >= now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 30), 1), 90))
  GROUP BY 1
  ORDER BY views DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
$$;
GRANT EXECUTE ON FUNCTION public.get_vto_top_viewed_products(text, integer, integer) TO service_role;

-- 7 ▸ config plumbing (checklist steps 1-3) -----------------------------------
ALTER TABLE public.vto_stores
  ADD COLUMN IF NOT EXISTS ab_experiment_kind text NOT NULL DEFAULT 'sitewide'
    CHECK (ab_experiment_kind IN ('sitewide', 'product'));
ALTER TABLE public.vto_stores
  ADD COLUMN IF NOT EXISTS ab_test_products jsonb;

-- get_widget_config: typed TABLE return → DROP + CREATE + re-GRANT. Full
-- definition from 20260818_polish_pass_widget_settings.sql plus the two new
-- fields (appended right after the other ab_* fields).
DROP FUNCTION IF EXISTS public.get_widget_config(text, text);

CREATE FUNCTION public.get_widget_config(p_store_slug text DEFAULT NULL::text, p_shop_domain text DEFAULT NULL::text)
 RETURNS TABLE(store_slug text, shop_domain text, storefront_token text, clothing_population_type text, widget_primary_color text, widget_accent_color text, minimized_color text, featured_item_id text, quick_picks_ids text[], desktop_preview_enabled boolean, preview_delay_seconds integer, preview_theme text, widget_position text, widget_visibility_mode text, inline_button_enabled boolean, inline_button_text text, inline_button_color text, inline_button_text_color text, inline_button_hide_when_oos boolean, inline_button_border_style text, inline_button_border_color text, floating_widget_pdp_enabled boolean, floating_widget_non_pdp_enabled boolean, fitting_room_enabled boolean, complete_the_look_enabled boolean, ctl_intro_style text, pdp_image_swap_enabled boolean, pdp_image_selector text, ctl_holdout_enabled boolean, ctl_holdout_percent integer, lead_capture_enabled boolean, lead_capture_after_n integer, ab_experiment_enabled boolean, ab_experiment_id uuid, ab_holdout_percent integer, ab_experiment_kind text, ab_test_products jsonb, style_overrides jsonb, live_tryon_enabled boolean, inline_button_placement text, corner_launch_corner text, corner_launch_style text, ctl_in_result_enabled boolean, photo_tips_fitted_enabled boolean, attribution_window_days integer, config_version bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT s.store_slug, s.shop_domain, s.storefront_token, s.clothing_population_type,
         s.widget_primary_color, s.widget_accent_color, s.minimized_color,
         s.featured_item_id, s.quick_picks_ids, s.desktop_preview_enabled,
         s.preview_delay_seconds, s.preview_theme, s.widget_position,
         s.widget_visibility_mode,
         s.inline_button_enabled, s.inline_button_text, s.inline_button_color,
         s.inline_button_text_color, s.inline_button_hide_when_oos,
         s.inline_button_border_style,
         s.inline_button_border_color,
         s.floating_widget_pdp_enabled, s.floating_widget_non_pdp_enabled,
         s.fitting_room_enabled,
         s.complete_the_look_enabled,
         s.ctl_intro_style,
         s.pdp_image_swap_enabled,
         s.pdp_image_selector,
         s.ctl_holdout_enabled, s.ctl_holdout_percent,
         s.lead_capture_enabled, s.lead_capture_after_n,
         s.ab_experiment_enabled, s.ab_experiment_id, s.ab_holdout_percent,
         s.ab_experiment_kind, s.ab_test_products,
         s.style_overrides,
         s.live_tryon_enabled,
         s.inline_button_placement,
         s.corner_launch_corner,
         s.corner_launch_style,
         s.ctl_in_result_enabled,
         s.photo_tips_fitted_enabled,
         s.attribution_window_days,
         s.config_version
    FROM vto_stores s
   WHERE (p_store_slug  IS NOT NULL AND s.store_slug  = p_store_slug)
      OR (p_shop_domain IS NOT NULL AND s.shop_domain = p_shop_domain)
   LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.get_widget_config(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_widget_config(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_widget_config(text, text) TO service_role;

-- Version-bump trigger: watch the two new fields in BOTH tuples (checklist
-- step 3 — miss one and a product-test start silently never reaches cached
-- storefronts; 2026-07-25 ctl_intro_style incident).
CREATE OR REPLACE FUNCTION public.bump_vto_store_config_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF (NEW.widget_primary_color, NEW.widget_accent_color, NEW.minimized_color,
      NEW.featured_item_id, NEW.quick_picks_ids, NEW.desktop_preview_enabled,
      NEW.preview_delay_seconds, NEW.preview_theme, NEW.widget_position,
      NEW.widget_visibility_mode, NEW.clothing_population_type,
      NEW.storefront_token, NEW.shop_domain,
      NEW.inline_button_enabled, NEW.inline_button_text, NEW.inline_button_color,
      NEW.inline_button_text_color, NEW.inline_button_hide_when_oos,
      NEW.inline_button_border_style, NEW.inline_button_border_color,
      NEW.floating_widget_pdp_enabled, NEW.floating_widget_non_pdp_enabled,
      NEW.fitting_room_enabled, NEW.complete_the_look_enabled,
      NEW.ctl_intro_style,
      NEW.pdp_image_swap_enabled, NEW.pdp_image_selector,
      NEW.tryon_targeting_mode, NEW.tryon_included_product_ids,
      NEW.tryon_included_collection_ids,
      NEW.ctl_holdout_enabled, NEW.ctl_holdout_percent,
      NEW.lead_capture_enabled, NEW.lead_capture_after_n,
      NEW.ab_experiment_enabled, NEW.ab_experiment_id, NEW.ab_holdout_percent,
      NEW.ab_experiment_kind, NEW.ab_test_products,
      NEW.style_overrides,
      NEW.live_tryon_enabled,
      NEW.inline_button_placement, NEW.corner_launch_corner,
      NEW.corner_launch_style,
      NEW.ctl_in_result_enabled,
      NEW.photo_tips_fitted_enabled,
      NEW.attribution_window_days)
     IS DISTINCT FROM
     (OLD.widget_primary_color, OLD.widget_accent_color, OLD.minimized_color,
      OLD.featured_item_id, OLD.quick_picks_ids, OLD.desktop_preview_enabled,
      OLD.preview_delay_seconds, OLD.preview_theme, OLD.widget_position,
      OLD.widget_visibility_mode, OLD.clothing_population_type,
      OLD.storefront_token, OLD.shop_domain,
      OLD.inline_button_enabled, OLD.inline_button_text, OLD.inline_button_color,
      OLD.inline_button_text_color, OLD.inline_button_hide_when_oos,
      OLD.inline_button_border_style, OLD.inline_button_border_color,
      OLD.floating_widget_pdp_enabled, OLD.floating_widget_non_pdp_enabled,
      OLD.fitting_room_enabled, OLD.complete_the_look_enabled,
      OLD.ctl_intro_style,
      OLD.pdp_image_swap_enabled, OLD.pdp_image_selector,
      OLD.tryon_targeting_mode, OLD.tryon_included_product_ids,
      OLD.tryon_included_collection_ids,
      OLD.ctl_holdout_enabled, OLD.ctl_holdout_percent,
      OLD.lead_capture_enabled, OLD.lead_capture_after_n,
      OLD.ab_experiment_enabled, OLD.ab_experiment_id, OLD.ab_holdout_percent,
      OLD.ab_experiment_kind, OLD.ab_test_products,
      OLD.style_overrides,
      OLD.live_tryon_enabled,
      OLD.inline_button_placement, OLD.corner_launch_corner,
      OLD.corner_launch_style,
      OLD.ctl_in_result_enabled,
      OLD.photo_tips_fitted_enabled,
      OLD.attribution_window_days)
  THEN
    NEW.config_version := COALESCE(OLD.config_version, 0) + 1;
  END IF;
  RETURN NEW;
END;
$function$;

NOTIFY pgrst, 'reload schema';
