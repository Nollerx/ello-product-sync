-- Applied live via Supabase MCP on 2026-07-11. Committed for repo parity. Idempotent.
--
-- "Anyone can read store configuration" let any anon key SELECT EVERY merchant's
-- full vto_stores row (storefront_token + all config for all tenants). get_widget_config
-- was SECURITY INVOKER and relied on that blanket read, so flip it to SECURITY DEFINER
-- FIRST (so the widget still gets its own store's config), THEN drop the blanket read.
-- The widget only reads config through this RPC / the server's service_role endpoint.

ALTER FUNCTION public.get_widget_config(text, text) SECURITY DEFINER;
ALTER FUNCTION public.get_widget_config(text, text) SET search_path = public, pg_temp;

DROP POLICY IF EXISTS "Anyone can read store configuration" ON public.vto_stores;

-- Legacy stores table carried the same blanket public read (and storefront_token).
DROP POLICY IF EXISTS "Widget can read store configuration" ON public.stores;

-- Strip anon's direct table privileges on vto_stores (the definer RPC runs as owner;
-- authenticated keeps its scoped "read own stores" policy).
REVOKE ALL ON public.vto_stores FROM anon;
