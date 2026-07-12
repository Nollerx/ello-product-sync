-- Applied live via Supabase MCP on 2026-07-11 (enterprise-readiness security pass).
-- Committed here for repo parity. Idempotent.
--
-- The anon (public widget) key could READ and DELETE every merchant's account,
-- subscription, and usage rows. All server access uses the service_role key
-- (supabaseAdmin, bypasses RLS), so removing public access has no app impact.

DROP POLICY IF EXISTS "Anyone can delete accounts"      ON public.vto_accounts;
DROP POLICY IF EXISTS "Anyone can read account data"    ON public.vto_accounts;
DROP POLICY IF EXISTS "Anyone can delete subscriptions" ON public.vto_subscriptions;
DROP POLICY IF EXISTS "Anyone can read subscriptions"   ON public.vto_subscriptions;
DROP POLICY IF EXISTS "Anyone can delete usage periods" ON public.vto_usage_periods;
DROP POLICY IF EXISTS "Anyone can read usage periods"   ON public.vto_usage_periods;

REVOKE ALL ON public.vto_accounts      FROM anon, authenticated;
REVOKE ALL ON public.vto_subscriptions FROM anon, authenticated;
REVOKE ALL ON public.vto_usage_periods FROM anon, authenticated;
