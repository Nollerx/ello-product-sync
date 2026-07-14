-- The entry_source allowlist check silently discards whole try-on events for
-- surfaces added after it was written: complete_the_look, fitting_room,
-- fitting_room_hub, nav_link all violate it, and record_tryon_event() throws
-- mid-call — the event is lost, the usage counter rolls back, and CTL usage
-- analytics stay empty forever. Found 2026-07-13 while seeding demo data.
--
-- Replace the allowlist with a length cap: keeps the anti-abuse intent while
-- being future-proof — an unrecognized source becomes a new dimension value
-- in analytics ("Other"), never a lost event or a failed try-on.
ALTER TABLE public.tryon_events DROP CONSTRAINT IF EXISTS tryon_events_entry_source_check;
ALTER TABLE public.tryon_events ADD CONSTRAINT tryon_events_entry_source_check
  CHECK (entry_source IS NULL OR char_length(entry_source) <= 40);
