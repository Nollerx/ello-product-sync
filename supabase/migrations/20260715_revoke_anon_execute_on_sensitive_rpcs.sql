-- 2026-07-15 — Close the storefront-anon-key authorization hole.
--
-- The Supabase anon JWT is published in every merchant's widget bundle
-- (public/widget-main.js, public/widget-loader.js). That is fine on its own —
-- the anon key is meant to be public. The problem is that ~44 SECURITY DEFINER
-- functions in `public` were EXECUTE-granted to the `anon` role with no internal
-- authorization check, so anyone who reads that key out of a page source could,
-- over /rest/v1/rpc/<fn>, do things scoped only by a caller-supplied store slug:
--   * get_storefront_token        -> read ANY shop's Shopify storefront token
--   * get_vto_* / get_store_*      -> read ANY store's private sales/conversion data
--   * update_vto_store_settings    -> disable ANY store's widget, flip billing flags
--   * record_/reverse_/bump_*      -> forge or reverse the try-on/purchase/usage
--                                     events that metering + Qualified Revenue use
-- (Verified live 2026-07-15 by assuming the anon role: token read, analytics read,
--  and a rolled-back settings write all succeeded.)
--
-- Fix: revoke EXECUTE from `anon` on every SECURITY DEFINER function in `public`
-- EXCEPT the three the live storefront widget genuinely calls directly with the
-- anon key (verified: the only `rest/v1/rpc/<fn>` calls in the widget bundle):
--     get_widget_config, record_widget_event, record_cart_event
--
-- Safety:
--   * `authenticated` and `service_role` are NOT touched. The server (Remix
--     loaders, webhooks, /tryon, /bootstrap) calls these via service_role, which
--     bypasses grants entirely, so there is zero app impact. The admin dashboard
--     runs server-side / as authenticated and is unaffected.
--   * Reversible: re-run with GRANT to undo.
--
-- FOLLOW-UP (do after applying): the three still-anon functions plus the
-- unauthenticated /api/cart-purchase-event endpoint still let a caller forge
-- widget/cart/purchase events for a known slug. Move those behind the existing
-- authenticated server proxy and make purchase attribution authoritative from the
-- HMAC-verified Shopify orders/create webhook. And ROTATE every store's
-- storefront_access_token, since tokens were readable while this hole was open.

-- NOTE: EXECUTE on these functions is granted to PUBLIC by default, which anon
-- inherits — so REVOKE ... FROM anon alone is a no-op. We must REVOKE FROM PUBLIC
-- (and from anon, for the few with an explicit anon grant), then re-GRANT the
-- explicit authenticated + service_role grants so the dashboard and server are
-- provably unchanged. Verified applied live 2026-07-15: after this, only the 3
-- kept functions are anon-executable, service_role lost nothing, and the 3
-- attacks (token read / settings write / analytics read) return 42501 for anon.

DO $$
DECLARE
  r RECORD;
  keep TEXT[] := ARRAY['get_widget_config', 'record_widget_event', 'record_cart_event'];
BEGIN
  FOR r IN
    SELECT p.oid,
           p.proname,
           pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef                                  -- SECURITY DEFINER only
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
      AND NOT (p.proname = ANY(keep))
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC;', r.proname, r.args);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM anon;', r.proname, r.args);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO authenticated;', r.proname, r.args);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role;', r.proname, r.args);
    RAISE NOTICE 'Hardened %(%)', r.proname, r.args;
  END LOOP;
END $$;
