-- Applied live via Supabase MCP on 2026-07-11. Committed for repo parity. Idempotent.
--
-- anon could INSERT arbitrary rows into the analytics tables (WITH CHECK true) and
-- forge/flood any merchant's paid analytics. The widget writes events exclusively via
-- the SECURITY DEFINER record_* RPCs (rest/v1/rpc), which run as owner, so removing
-- anon's direct table access does not affect real analytics.

DROP POLICY IF EXISTS "Anon insert on widget_events" ON public.widget_events;
DROP POLICY IF EXISTS "Anon insert on cart_events"   ON public.cart_events;
DROP POLICY IF EXISTS "Anon insert on tryon_events"  ON public.tryon_events;

REVOKE ALL ON public.widget_events       FROM anon, authenticated;
REVOKE ALL ON public.cart_events         FROM anon, authenticated;
REVOKE ALL ON public.tryon_events        FROM anon, authenticated;
REVOKE ALL ON public.product_view_events FROM anon, authenticated;
REVOKE ALL ON public.purchase_events     FROM anon, authenticated;

-- Stale grant cleanup: legacy stores read is already denied by RLS (policy dropped).
REVOKE ALL ON public.stores FROM anon;
