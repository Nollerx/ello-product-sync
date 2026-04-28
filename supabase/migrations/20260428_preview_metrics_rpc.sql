-- Daily aggregate of preview events for a single store, used by the
-- "Floating Widget: Impressions vs Engagements" chart and the preview funnel.
-- Aggregating server-side avoids the PostgREST 1000-row cap that was
-- truncating recent days when the raw event count over the date range
-- exceeded the limit.

CREATE OR REPLACE FUNCTION public.get_preview_metrics_daily(p_store_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(day date, impressions bigint, engagements bigint, photo_uploaded bigint, tryon_completed bigint, tryon_failed bigint)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    date_trunc('day', occurred_at)::DATE AS day,
    count(*) FILTER (WHERE event_name = 'preview_shown')                                 AS impressions,
    count(*) FILTER (WHERE event_name IN ('upload_clicked','tryon_clicked'))             AS engagements,
    count(*) FILTER (WHERE event_name = 'photo_uploaded')                                AS photo_uploaded,
    count(*) FILTER (WHERE event_name = 'tryon_completed')                               AS tryon_completed,
    count(*) FILTER (WHERE event_name = 'tryon_failed')                                  AS tryon_failed
  FROM public.vto_preview_events
  WHERE store_id = p_store_id
    AND occurred_at >= p_from
    AND occurred_at <  p_to
  GROUP BY 1
  ORDER BY 1;
$function$;

GRANT EXECUTE ON FUNCTION public.get_preview_metrics_daily(uuid, timestamp with time zone, timestamp with time zone) TO authenticated;
