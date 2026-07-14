-- CTL holdout size is merchant-chosen (was hardwired 50/50 last-char parity).
--
-- New bucketing contract (MUST stay in sync with widget-main.js):
--   bucket  = FNV-1a 32-bit of (session_id || ':ctl') mod 100  — via ello_ab_bucket(session_id, 'ctl')
--   holdout = bucket < vto_stores.ctl_holdout_percent (default 50)
-- Salt 'ctl' keeps CTL buckets independent of the widget-wide experiment's
-- per-experiment salt, so running both tests never cross-contaminates.
-- No CTL test was running anywhere when the split mechanics changed.
--
-- get_widget_config + bump trigger bodies below are the LIVE prod definitions
-- (fetched 2026-07-13, post security-hardening: SECURITY DEFINER + pinned
-- search_path) + the one new field. Do not trim fields without checking prod.

ALTER TABLE public.vto_stores
  ADD COLUMN IF NOT EXISTS ctl_holdout_percent integer NOT NULL DEFAULT 50;
ALTER TABLE public.vto_stores DROP CONSTRAINT IF EXISTS chk_ctl_holdout_percent;
ALTER TABLE public.vto_stores ADD CONSTRAINT chk_ctl_holdout_percent
  CHECK (ctl_holdout_percent BETWEEN 1 AND 50);

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
  ctl_holdout_enabled boolean, ctl_holdout_percent integer,
  lead_capture_enabled boolean, lead_capture_after_n integer,
  ab_experiment_enabled boolean, ab_experiment_id uuid, ab_holdout_percent integer,
  style_overrides jsonb,
  config_version bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
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
         s.ctl_holdout_enabled, s.ctl_holdout_percent,
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
      NEW.floating_widget_pdp_enabled, NEW.floating_widget_non_pdp_enabled,
      NEW.fitting_room_enabled, NEW.complete_the_look_enabled,
      NEW.pdp_image_swap_enabled, NEW.pdp_image_selector,
      NEW.tryon_targeting_mode, NEW.tryon_included_product_ids,
      NEW.tryon_included_collection_ids,
      NEW.ctl_holdout_enabled, NEW.ctl_holdout_percent,
      NEW.lead_capture_enabled, NEW.lead_capture_after_n,
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
      OLD.ctl_holdout_enabled, OLD.ctl_holdout_percent,
      OLD.lead_capture_enabled, OLD.lead_capture_after_n,
      OLD.ab_experiment_enabled, OLD.ab_experiment_id, OLD.ab_holdout_percent,
      OLD.style_overrides)
  THEN
    NEW.config_version := COALESCE(OLD.config_version, 0) + 1;
  END IF;
  RETURN NEW;
END;
$function$;

-- Percent-aware split (same return shape → CREATE OR REPLACE is safe).
CREATE OR REPLACE FUNCTION public.get_ctl_performance(p_store_slug text, p_from timestamptz, p_to timestamptz)
 RETURNS TABLE(
   ctl_tryons bigint,
   ctl_sessions bigint,
   orders_with_look bigint, revenue_with_look numeric, aov_with_look numeric,
   orders_without_look bigint, revenue_without_look numeric, aov_without_look numeric,
   holdout_active boolean, holdout_since timestamptz,
   t_sessions bigint, t_orders bigint, t_revenue numeric, t_aov numeric,
   h_sessions bigint, h_orders bigint, h_revenue numeric, h_aov numeric
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
    SELECT DISTINCT b.session_id, pe.order_id, pe.total_price
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
    SELECT order_id, MAX(total_price) AS total_price,
           BOOL_OR(session_id IN (SELECT session_id FROM ctl_sess)) AS with_look
    FROM attributed GROUP BY order_id
  ),
  store AS (
    SELECT s.ctl_holdout_enabled, s.ctl_holdout_enabled_at,
           COALESCE(s.ctl_holdout_percent, 50) AS pct
    FROM public.vto_stores s WHERE s.store_slug = p_store_slug
  ),
  h_base AS (
    SELECT b.session_id, b.pid, b.created_at
    FROM base b, store st
    WHERE st.ctl_holdout_enabled_at IS NOT NULL
      AND b.created_at >= GREATEST(p_from, st.ctl_holdout_enabled_at)
  ),
  -- Arm = FNV bucket of (session_id, salt 'ctl') vs the store's chosen
  -- holdout percent. EXACT mirror of widget-main.js elloCtlHoldoutBucket.
  h_sess AS (
    SELECT DISTINCT hb.session_id,
           (public.ello_ab_bucket(hb.session_id, 'ctl') >= st.pct) AS is_treatment
    FROM h_base hb, store st
  ),
  h_attributed AS (
    SELECT DISTINCT hb.session_id, pe.order_id, pe.total_price
    FROM h_base hb
    JOIN public.purchase_events pe
      ON pe.session_id = hb.session_id AND pe.store_slug = p_store_slug
     AND pe.created_at > hb.created_at
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(pe.line_items) li
       WHERE regexp_replace(li->>'product_id', '^.*/', '') = hb.pid
     )
  ),
  h_orders AS (
    SELECT ha.order_id, MAX(ha.total_price) AS total_price,
           (public.ello_ab_bucket(MIN(ha.session_id), 'ctl') >= (SELECT pct FROM store)) AS is_treatment
    FROM h_attributed ha GROUP BY ha.order_id
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
    (SELECT ROUND(AVG(total_price), 2) FROM h_orders WHERE NOT is_treatment);
$function$;

NOTIFY pgrst, 'reload schema';
