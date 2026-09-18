-- 2026-09-18 — Aggregate try-on health in the DB, not in the app.
--
-- WHY: /api/store-health originally pulled raw tryon_events rows and aggregated
-- in JS. PostgREST caps an unlimited select at 1000 rows, so once a single store
-- does >1000 try-ons inside the 6h window (LA Apparel will), the sweep would have
-- silently computed failure rates from a truncated, unordered slice — a wrong
-- alert, which is worse than no alert. Aggregating here makes the sweep O(1) in
-- rows returned and correct at any volume.

CREATE OR REPLACE FUNCTION public.store_tryon_health(p_hours INT DEFAULT 6)
RETURNS TABLE (
  store_slug TEXT,
  total BIGINT,
  failed BIGINT,
  top_product TEXT,
  top_product_failures BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH w AS (
    SELECT e.store_slug, e.success, e.product_id
    FROM public.tryon_events e
    WHERE e.created_at >= NOW() - make_interval(hours => GREATEST(p_hours, 1))
  ),
  agg AS (
    SELECT w.store_slug,
           COUNT(*)                                    AS total,
           COUNT(*) FILTER (WHERE w.success IS FALSE)   AS failed
    FROM w
    WHERE w.store_slug IS NOT NULL
    GROUP BY w.store_slug
  ),
  worst AS (
    SELECT DISTINCT ON (t.store_slug) t.store_slug, t.product_id, t.c
    FROM (
      SELECT w.store_slug, w.product_id, COUNT(*) AS c
      FROM w
      WHERE w.success IS FALSE AND w.product_id IS NOT NULL AND w.store_slug IS NOT NULL
      GROUP BY w.store_slug, w.product_id
    ) t
    ORDER BY t.store_slug, t.c DESC, t.product_id
  )
  SELECT a.store_slug, a.total, a.failed, worst.product_id, worst.c
  FROM agg a
  LEFT JOIN worst ON worst.store_slug = a.store_slug;
$function$;

REVOKE ALL ON FUNCTION public.store_tryon_health(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_tryon_health(INT) TO service_role;
