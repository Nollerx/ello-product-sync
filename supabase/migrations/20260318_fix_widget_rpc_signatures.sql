-- ============================================================================
-- Fix Widget RPC Signatures
-- Date: 2026-03-18
-- Purpose: Update record_widget_event and record_widget_open to accept
--          all parameters the widget JS actually sends.
--          PostgREST returns 404 when extra/missing params don't match.
-- ============================================================================

-- ─── 1. Add columns to widget_events for the extra data ─────────────────────

ALTER TABLE public.widget_events
ADD COLUMN IF NOT EXISTS store_id TEXT,
ADD COLUMN IF NOT EXISTS widget_view_id TEXT,
ADD COLUMN IF NOT EXISTS intro_view_id TEXT,
ADD COLUMN IF NOT EXISTS device TEXT,
ADD COLUMN IF NOT EXISTS page_path TEXT,
ADD COLUMN IF NOT EXISTS is_first_time BOOLEAN,
ADD COLUMN IF NOT EXISTS widget_version TEXT,
ADD COLUMN IF NOT EXISTS event_data JSONB,
ADD COLUMN IF NOT EXISTS url TEXT;

-- ─── 2. Drop and recreate record_widget_event ──────────────────────────────

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT oid::regprocedure::text AS sig
    FROM pg_proc
    WHERE proname = 'record_widget_event'
      AND pronamespace = 'public'::regnamespace
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.record_widget_event(
  p_store_slug TEXT,
  p_event_name TEXT DEFAULT 'generic',
  p_event_type TEXT DEFAULT 'generic',
  p_store_id TEXT DEFAULT NULL,
  p_session_id TEXT DEFAULT NULL,
  p_widget_view_id TEXT DEFAULT NULL,
  p_intro_view_id TEXT DEFAULT NULL,
  p_device TEXT DEFAULT NULL,
  p_page_path TEXT DEFAULT NULL,
  p_is_first_time BOOLEAN DEFAULT NULL,
  p_widget_version TEXT DEFAULT NULL,
  p_event_data JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.widget_events (
    store_slug, event_type, store_id, session_id,
    widget_view_id, intro_view_id, device, page_path,
    is_first_time, widget_version, event_data
  ) VALUES (
    p_store_slug, COALESCE(p_event_name, p_event_type, 'generic'), p_store_id, p_session_id,
    p_widget_view_id, p_intro_view_id, p_device, p_page_path,
    p_is_first_time, p_widget_version, p_event_data
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─── 3. Drop and recreate record_widget_open ────────────────────────────────

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT oid::regprocedure::text AS sig
    FROM pg_proc
    WHERE proname = 'record_widget_open'
      AND pronamespace = 'public'::regnamespace
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.record_widget_open(
  p_store_slug TEXT,
  p_session_id TEXT DEFAULT NULL,
  p_device TEXT DEFAULT NULL,
  p_url TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.widget_events (store_slug, event_type, session_id, device, url)
  VALUES (p_store_slug, 'widget_open', p_session_id, p_device, p_url);

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─── 4. Re-grant execute to anon ────────────────────────────────────────────

GRANT EXECUTE ON FUNCTION public.record_widget_event(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, JSONB) TO anon;
GRANT EXECUTE ON FUNCTION public.record_widget_open(TEXT, TEXT, TEXT, TEXT) TO anon;

-- ─── 5. Force PostgREST schema reload ───────────────────────────────────────

NOTIFY pgrst, 'reload schema';
