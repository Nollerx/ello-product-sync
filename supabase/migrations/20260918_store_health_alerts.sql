-- 2026-09-18 — Per-store try-on health alerting
--
-- WHY: the 09-13→09-18 Atlas incident (stale clothing_items image URLs, 43% of
-- that store's try-ons failing) ran for five days without a single alert. The
-- seven existing GCP policies are all burst-shaped — the tightest is ">20 engine
-- errors in 5 minutes" and the incident peaked at 10 in any 5-minute window, 14
-- in any hour. A single merchant quietly breaking never produces enough fleet-wide
-- volume to trip an absolute counter, so the signal has to be a per-store FAILURE
-- RATE instead. That lives in tryon_events, not in Cloud Run logs, which is why
-- this is an app sweep rather than another GCP policy.
--
-- One column, same dedup pattern as install_followup_sent_at: stamped when a
-- store is alerted, cleared when it recovers, so each incident pages once.

ALTER TABLE public.vto_stores
  ADD COLUMN IF NOT EXISTS health_alert_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN public.vto_stores.health_alert_sent_at IS
  'Last time a try-on failure-rate alert fired for this store. NULL = healthy (or recovered); set = already paged, suppresses repeats until it recovers or the cooldown passes.';

-- The sweep reads recent events per store; this keeps it cheap as volume grows.
CREATE INDEX IF NOT EXISTS tryon_events_created_store_idx
  ON public.tryon_events (created_at DESC, store_slug);
