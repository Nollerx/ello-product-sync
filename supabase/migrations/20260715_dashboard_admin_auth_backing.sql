-- 2026-07-15 — Restore the external dashboard (dashboard.ello.services) after the
-- anon-RPC lockdown, the RIGHT way (authenticate it instead of re-opening anon).
--
-- Root cause: the Lovable dashboard's client.ts uses the public anon key, and its
-- useAdminAuth hook checks a `user_roles` table + the get_admin_* roll-ups call
-- public.has_role() — but NEITHER was ever created in this database. So the
-- login/role gate silently no-op'd and the dashboard read everything as the
-- public anon key (i.e. all clients' revenue was world-readable via the widget
-- key). The 2026-07-15 revoke closed that, which is why the dashboard went dark.
--
-- Fix: create the auth backing the dashboard was already built for. Once Andrew
-- logs in (acnoller54@gmail.com), supabase-js attaches his JWT, calls run as the
-- `authenticated` role (which retains EXECUTE on the analytics fns; anon does
-- not), and isAdmin resolves true. No dashboard code change required.

CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Exactly the query useAdminAuth runs: a logged-in user reads their own roles.
DROP POLICY IF EXISTS "users read own roles" ON public.user_roles;
CREATE POLICY "users read own roles" ON public.user_roles
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- SECURITY DEFINER so the get_admin_* roll-ups can check membership without
-- exposing the table. Locked to authenticated + service_role (never anon).
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role); $$;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.has_role(uuid, text) TO authenticated, service_role;

-- Andrew = org admin.
INSERT INTO public.user_roles (user_id, role)
VALUES ('92c2c275-b0dc-4770-8e3f-380852495c43', 'admin')  -- acnoller54@gmail.com
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';

-- NOTE: the get_admin_* aggregate roll-ups (get_admin_dashboard_stats etc.) also
-- reference a table `vto_tryon_events` that does not exist in this schema — a
-- pre-existing schema-drift bug, independent of auth. The per-client analytics
-- (get_vto_conversion_summary / _receipts / _return_rates) work fine once
-- authenticated; the aggregate roll-ups need a separate rewrite vs the live schema.
