-- ============================================================================
-- Widget Opens Summary — Pre-aggregated analytics RPC
-- Date: 2026-04-21
-- Purpose: Replace raw-row widget open queries with server-side aggregation.
--          The old approach returns individual event rows, which hit Supabase's
--          default 1000-row limit and break totals on busy stores.
--
-- Data sources:
--   1. widget_events  WHERE event_type = 'widget_open'  (current, live writes)
--   2. vto_widget_opens                                  (legacy, 186 rows, stopped 2026-03-03)
--
-- Dedup: (session_id, created_at truncated to second) — IDs are independent
--        UUIDs across the two tables, so id-based dedup would be a no-op.
-- ============================================================================

-- Drop any existing overloads
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT oid::regprocedure::text AS sig
    FROM pg_proc
    WHERE proname = 'get_widget_opens_summary'
      AND pronamespace = 'public'::regnamespace
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.get_widget_opens_summary(
  p_store_slug TEXT,
  p_from       TIMESTAMPTZ,
  p_to         TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result JSONB;
BEGIN
  WITH
  -- ── Step 1: UNION ALL both tables ─────────────────────────────────────────
  all_opens AS (
    SELECT session_id, device, created_at
    FROM public.widget_events
    WHERE store_slug  = p_store_slug
      AND event_type  = 'widget_open'
      AND created_at >= p_from
      AND created_at <  p_to

    UNION ALL

    SELECT session_id, device, created_at
    FROM public.vto_widget_opens
    WHERE store_slug  = p_store_slug
      AND created_at >= p_from
      AND created_at <  p_to
  ),

  -- ── Step 2: Dedup by (session_id, created_at::second) ─────────────────────
  -- Rows with session_id: keep one per (session_id, second)
  -- Rows without session_id: keep every row (no dedup possible)
  deduped AS (
    SELECT DISTINCT ON (session_id, date_trunc('second', created_at))
           session_id, device, created_at
    FROM all_opens
    WHERE session_id IS NOT NULL

    UNION ALL

    SELECT session_id, device, created_at
    FROM all_opens
    WHERE session_id IS NULL
  ),

  -- ── Step 3: Compute all aggregates in one pass ────────────────────────────
  totals AS (
    SELECT
      COUNT(*)                     AS total_opens,
      COUNT(DISTINCT session_id)   AS unique_sessions
    FROM deduped
  ),

  device_counts AS (
    SELECT
      COALESCE(LOWER(device), 'unknown') AS device_cat,
      COUNT(DISTINCT session_id)          AS cnt
    FROM deduped
    WHERE session_id IS NOT NULL
    GROUP BY COALESCE(LOWER(device), 'unknown')
  ),

  daily AS (
    SELECT
      created_at::date             AS d,
      COUNT(*)                     AS t,
      COUNT(DISTINCT session_id)   AS u
    FROM deduped
    GROUP BY created_at::date
  )

  -- ── Step 4: Assemble single JSONB result ──────────────────────────────────
  SELECT jsonb_build_object(
    'total_opens',     t.total_opens,
    'unique_sessions', t.unique_sessions,
    'by_device',       jsonb_build_object(
      'mobile',  COALESCE((SELECT cnt FROM device_counts WHERE device_cat = 'mobile'),  0),
      'desktop', COALESCE((SELECT cnt FROM device_counts WHERE device_cat = 'desktop'), 0),
      'tablet',  COALESCE((SELECT cnt FROM device_counts WHERE device_cat = 'tablet'),  0),
      'unknown', COALESCE((SELECT cnt FROM device_counts WHERE device_cat = 'unknown'), 0)
    ),
    'by_day',          COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('date', TO_CHAR(d, 'YYYY-MM-DD'), 'total', t, 'unique', u)
        ORDER BY d
      )
      FROM daily
    ), '[]'::JSONB)
  )
  INTO v_result
  FROM totals t;

  RETURN COALESCE(v_result, jsonb_build_object(
    'total_opens', 0,
    'unique_sessions', 0,
    'by_device', jsonb_build_object('mobile', 0, 'desktop', 0, 'tablet', 0, 'unknown', 0),
    'by_day', '[]'::JSONB
  ));
END;
$$;

-- Grant to authenticated (dashboard login) and anon (fallback)
GRANT EXECUTE ON FUNCTION public.get_widget_opens_summary(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_widget_opens_summary(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO anon;

-- Force PostgREST to pick up the new function
NOTIFY pgrst, 'reload schema';
