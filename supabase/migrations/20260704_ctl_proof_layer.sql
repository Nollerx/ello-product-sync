-- CTL proof layer: 50/50 holdout flag + the performance RPC the dashboard's
-- "Complete the Look" card reads.
--
-- Bucketing contract (MUST stay in sync with widget-main.js elloCtlHoldoutBucket):
--   treatment = ascii(last char of ello_session_id) is EVEN
--   holdout   = odd
-- The widget suppresses the upsell for holdout shoppers while
-- ctl_holdout_enabled is true; this RPC derives the same buckets in SQL, so no
-- extra event data is needed and the widget and report can never disagree.

ALTER TABLE public.vto_stores
  ADD COLUMN IF NOT EXISTS ctl_holdout_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ctl_holdout_enabled_at timestamptz;

-- Extend get_widget_config with ctl_holdout_enabled. Return shape changes, so
-- DROP + CREATE (CREATE OR REPLACE cannot alter RETURNS TABLE). Body below is
-- the CURRENT production definition (fetched 2026-07-04) + the one new field —
-- do not remove fields here without checking prod first.
DROP FUNCTION IF EXISTS public.get_widget_config(text, text);
CREATE FUNCTION public.get_widget_config(p_store_slug text DEFAULT NULL::text, p_shop_domain text DEFAULT NULL::text)
 RETURNS TABLE(store_slug text, shop_domain text, storefront_token text, clothing_population_type text, widget_primary_color text, widget_accent_color text, minimized_color text, featured_item_id text, quick_picks_ids text[], desktop_preview_enabled boolean, preview_delay_seconds integer, preview_theme text, widget_position text, widget_visibility_mode text, inline_button_enabled boolean, inline_button_text text, inline_button_color text, inline_button_text_color text, inline_button_hide_when_oos boolean, floating_widget_pdp_enabled boolean, floating_widget_non_pdp_enabled boolean, fitting_room_enabled boolean, complete_the_look_enabled boolean, pdp_image_swap_enabled boolean, ctl_holdout_enabled boolean, lead_capture_enabled boolean, lead_capture_after_n integer, config_version bigint)
 LANGUAGE sql
 STABLE
AS $function$
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
         s.ctl_holdout_enabled,
         s.lead_capture_enabled, s.lead_capture_after_n,
         s.config_version
    FROM vto_stores s
   WHERE (p_store_slug  IS NOT NULL AND s.store_slug  = p_store_slug)
      OR (p_shop_domain IS NOT NULL AND s.shop_domain = p_shop_domain)
   LIMIT 1;
$function$;

-- Proof-layer aggregates. Attribution join mirrors get_vto_conversion_summary
-- exactly (session + product match, purchase after try-on, order-deduped
-- revenue) so the numbers reconcile with the main dashboard.
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
    SELECT s.ctl_holdout_enabled, s.ctl_holdout_enabled_at
    FROM public.vto_stores s WHERE s.store_slug = p_store_slug
  ),
  h_base AS (
    SELECT b.session_id, b.pid, b.created_at
    FROM base b, store st
    WHERE st.ctl_holdout_enabled_at IS NOT NULL
      AND b.created_at >= GREATEST(p_from, st.ctl_holdout_enabled_at)
  ),
  h_sess AS (
    SELECT DISTINCT session_id,
           (ascii(right(session_id, 1)) % 2 = 0) AS is_treatment
    FROM h_base
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
    SELECT order_id, MAX(total_price) AS total_price,
           (ascii(right(MIN(session_id), 1)) % 2 = 0) AS is_treatment
    FROM h_attributed GROUP BY order_id
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
