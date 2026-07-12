-- Applied live via Supabase MCP on 2026-07-11. Committed for repo parity. Idempotent.
--
-- Hygiene: pin search_path on all public functions (clears function_search_path_mutable
-- advisor; hardens the SECURITY DEFINER functions against search_path hijacking), and
-- index the two unindexed foreign keys on vto_subscriptions.

ALTER FUNCTION public.bump_usage_for_tryon() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_store_usage(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_widget_funnel_by_page(text, timestamp with time zone, timestamp with time zone) SET search_path = public, pg_temp;
ALTER FUNCTION public.record_cart_event(text, text, text, text, integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.record_preview_event(text, text, text, text, jsonb) SET search_path = public, pg_temp;
ALTER FUNCTION public.record_tryon_event(text, boolean, text, text, text, text, text, text, boolean, text, text) SET search_path = public, pg_temp;
ALTER FUNCTION public.record_widget_event(text, text, text, text, text, text, text, text, text, boolean, text, jsonb, text, text, boolean) SET search_path = public, pg_temp;
ALTER FUNCTION public.record_widget_open(text, text, text, text) SET search_path = public, pg_temp;
ALTER FUNCTION public.bump_vto_store_config_version() SET search_path = public, pg_temp;
ALTER FUNCTION public.ello_ab_bucket(text, text) SET search_path = public, pg_temp;
ALTER FUNCTION public.update_updated_at_column() SET search_path = public, pg_temp;

CREATE INDEX IF NOT EXISTS idx_vto_subscriptions_plan_id
  ON public.vto_subscriptions(plan_id);
CREATE INDEX IF NOT EXISTS idx_vto_subscriptions_previous_plan_id
  ON public.vto_subscriptions(previous_plan_id);
