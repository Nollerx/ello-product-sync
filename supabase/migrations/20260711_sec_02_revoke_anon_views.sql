-- Applied live via Supabase MCP on 2026-07-11. Committed for repo parity. Idempotent.
--
-- These SECURITY DEFINER views bypass RLS and were readable by the anon key:
--   storefront_tokens_public -> every store's live Shopify storefront_access_token
--   vto_attributed_purchases -> cross-tenant order ids + totals
--   vto_conversion_summary   -> per-store revenue / conversion
-- The app never reads them with the public key (server reads tokens via
-- getStoredStorefrontToken / conversion via the get_vto_conversion_summary RPC),
-- so revoking anon+authenticated closes the leak with no app impact.

REVOKE ALL ON public.storefront_tokens_public FROM anon, authenticated;
REVOKE ALL ON public.vto_attributed_purchases FROM anon, authenticated;
REVOKE ALL ON public.vto_conversion_summary   FROM anon, authenticated;
