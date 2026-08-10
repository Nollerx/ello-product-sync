-- 2026-08-07 — Restore the external dashboard's merchant login (/login), broken since
-- the 2026-07-11 lockdown (REVOKE ALL ON public.vto_stores FROM anon) killed its direct
-- table reads. Applied live via Supabase MCP; committed for repo parity. Idempotent.
--
-- Same pattern as get_widget_config: a narrow SECURITY DEFINER RPC instead of a blanket
-- table grant. The slug+email PAIR is the credential — a caller learns nothing (not even
-- whether the store exists) unless both match, so there is no enumeration oracle and the
-- cross-tenant reads the July lockdown closed stay closed. The response is exactly the
-- storeAuth payload StoreLogin.tsx previously assembled from its two table queries.

CREATE OR REPLACE FUNCTION public.merchant_dashboard_login(
  p_store_slug text,
  p_owner_email text
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'storeId',                  s.id,
    'storeSlug',                s.store_slug,
    'storeName',                s.store_name,
    'accountId',                s.account_id,
    'accountName',              a.name,
    'accountType',              a.type,
    'ownerEmail',               a.owner_email,
    'clothing_population_type', s.clothing_population_type,
    'shop_domain',              s.shop_domain,
    'storefront_token',         s.storefront_token,
    'widget_primary_color',     s.widget_primary_color,
    'widget_accent_color',      s.widget_accent_color,
    'minimized_color',          s.minimized_color,
    'featured_item_id',         s.featured_item_id,
    'quick_picks_ids',          s.quick_picks_ids,
    'blockOverage',             COALESCE(s.block_overage, false)
  )
  FROM public.vto_stores s
  JOIN public.vto_accounts a ON a.id = s.account_id
  WHERE s.store_slug = trim(p_store_slug)
    AND lower(a.owner_email) = lower(trim(p_owner_email));
$$;

REVOKE ALL ON FUNCTION public.merchant_dashboard_login(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merchant_dashboard_login(text, text)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
