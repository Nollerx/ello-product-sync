-- ─────────────────────────────────────────────────────────────────────────────
-- Per-shopper try-on limit (merchant-configurable abuse protection)
--
-- Lets a merchant cap how many try-ons a single shopper can run inside a time
-- window, so one person can't burn through the store's monthly credits.
--
--   • vto_stores gains: shopper_limit_enabled / shopper_limit_count /
--     shopper_limit_window_hours (default off, 15 per 24h when enabled)
--   • tryon_events gains ip_address so the limit survives localStorage resets
--   • record_tryon_event gains p_ip_address and blocks with
--     error = 'SHOPPER_RATE_LIMITED' when the shopper is over the limit.
--     The /tryon proxy maps that to HTTP 429, which the widget already
--     handles (handleRateLimitError → disabled button + message).
--
-- Enforcement model:
--   session_id (per-browser, localStorage) is the merchant-facing limit.
--   ip_address is a backstop at 3× the limit — loose enough that shared
--   networks (offices, cellular NAT) don't block legit shoppers, tight
--   enough to stop incognito / cleared-storage abuse.
--
-- DEPLOY ORDER: run this migration BEFORE deploying the app build that sends
-- p_ip_address. (Old app builds keep working against the new function because
-- the new parameter has a DEFAULT.)
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ─── 1. Merchant settings on vto_stores ──────────────────────────────────────

ALTER TABLE public.vto_stores
  ADD COLUMN IF NOT EXISTS shopper_limit_enabled      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shopper_limit_count        INT     NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS shopper_limit_window_hours INT     NOT NULL DEFAULT 24;

-- ─── 2. IP column + window-scan indexes on tryon_events ─────────────────────

ALTER TABLE public.tryon_events
  ADD COLUMN IF NOT EXISTS ip_address TEXT;

CREATE INDEX IF NOT EXISTS idx_tryon_events_session_window
  ON public.tryon_events (store_slug, session_id, created_at DESC)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tryon_events_ip_window
  ON public.tryon_events (store_slug, ip_address, created_at DESC)
  WHERE ip_address IS NOT NULL;

-- ─── 3. record_tryon_event: add p_ip_address + shopper-limit gate ───────────
-- Drop the old 10-arg signature first — CREATE OR REPLACE with a new arg list
-- would create an ambiguous overload instead of replacing it.

DROP FUNCTION IF EXISTS public.record_tryon_event(
  TEXT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT
);

CREATE OR REPLACE FUNCTION public.record_tryon_event(
  p_store_slug TEXT,
  p_success BOOLEAN DEFAULT true,
  p_product_id TEXT DEFAULT NULL,
  p_variant_id TEXT DEFAULT NULL,
  p_session_id TEXT DEFAULT NULL,
  p_page_type TEXT DEFAULT NULL,
  p_page_path TEXT DEFAULT NULL,
  p_page_handle TEXT DEFAULT NULL,
  p_page_in_catalog BOOLEAN DEFAULT NULL,
  p_entry_source TEXT DEFAULT NULL,
  p_ip_address TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_account_id UUID;
  v_shop_domain TEXT;
  v_subscription_id UUID;
  v_plan_id UUID;
  v_plan_code TEXT;
  v_included_tryons INT;
  v_tryons_used INT;
  v_overage_auto_topup BOOLEAN;
  v_overage_cap_credits INT;
  v_overage_credits_used INT;
  v_is_overage BOOLEAN := false;
  v_shopify_usage_line_item_id TEXT;
  v_shopper_limit_enabled BOOLEAN;
  v_shopper_limit_count INT;
  v_shopper_limit_window_hours INT;
  v_session_tryons INT := 0;
  v_ip_tryons INT := 0;
BEGIN
  -- 1. Look up store
  SELECT s.account_id, s.shop_domain, s.overage_auto_topup, s.overage_cap_credits, s.overage_credits_used,
         s.shopper_limit_enabled, s.shopper_limit_count, s.shopper_limit_window_hours
  INTO v_account_id, v_shop_domain, v_overage_auto_topup, v_overage_cap_credits, v_overage_credits_used,
       v_shopper_limit_enabled, v_shopper_limit_count, v_shopper_limit_window_hours
  FROM public.vto_stores s
  WHERE s.store_slug = p_store_slug
  LIMIT 1;

  IF v_account_id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'error', 'STORE_NOT_FOUND');
  END IF;

  -- 1b. Per-shopper limit (before any usage accounting — a blocked shopper
  --     must not consume credits or create usage periods)
  IF p_success
     AND COALESCE(v_shopper_limit_enabled, false)
     AND COALESCE(v_shopper_limit_count, 0) > 0
     AND (p_session_id IS NOT NULL OR p_ip_address IS NOT NULL) THEN

    IF p_session_id IS NOT NULL THEN
      SELECT COUNT(*) INTO v_session_tryons
      FROM public.tryon_events e
      WHERE e.store_slug = p_store_slug
        AND e.session_id = p_session_id
        AND e.success = true
        AND e.created_at >= NOW() - make_interval(hours => COALESCE(v_shopper_limit_window_hours, 24));
    END IF;

    IF p_ip_address IS NOT NULL THEN
      SELECT COUNT(*) INTO v_ip_tryons
      FROM public.tryon_events e
      WHERE e.store_slug = p_store_slug
        AND e.ip_address = p_ip_address
        AND e.success = true
        AND e.created_at >= NOW() - make_interval(hours => COALESCE(v_shopper_limit_window_hours, 24));
    END IF;

    IF v_session_tryons >= v_shopper_limit_count
       OR v_ip_tryons >= v_shopper_limit_count * 3 THEN
      INSERT INTO public.tryon_events (
        store_slug, success, is_overage, product_id, variant_id, session_id,
        page_type, page_path, page_handle, page_in_catalog, entry_source, ip_address
      )
      VALUES (
        p_store_slug, false, false, p_product_id, p_variant_id, p_session_id,
        p_page_type, p_page_path, p_page_handle, p_page_in_catalog, p_entry_source, p_ip_address
      );

      RETURN jsonb_build_object(
        'allowed', false,
        'error', 'SHOPPER_RATE_LIMITED',
        'is_overage', false,
        'shopper_limit_count', v_shopper_limit_count,
        'shopper_limit_window_hours', COALESCE(v_shopper_limit_window_hours, 24),
        'shop_domain', v_shop_domain
      );
    END IF;
  END IF;

  -- 2. Get active subscription
  SELECT sub.id, sub.plan_id, sub.shopify_usage_line_item_id
  INTO v_subscription_id, v_plan_id, v_shopify_usage_line_item_id
  FROM public.vto_subscriptions sub
  WHERE sub.account_id = v_account_id AND sub.status = 'active'
  LIMIT 1;

  IF v_subscription_id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'error', 'NO_ACTIVE_SUBSCRIPTION');
  END IF;

  -- 3. Get plan code + included tryons
  SELECT p.code, p.included_tryons_per_month
  INTO v_plan_code, v_included_tryons
  FROM public.vto_plans p
  WHERE p.id = v_plan_id;

  IF v_included_tryons IS NULL THEN
    v_included_tryons := 9999;
  END IF;

  -- 4. Get or create current usage period (RACE-SAFE)
  SELECT up.tryons_used
  INTO v_tryons_used
  FROM public.vto_usage_periods up
  WHERE up.subscription_id = v_subscription_id
    AND NOW() >= up.period_start
    AND NOW() < up.period_end
  LIMIT 1;

  IF v_tryons_used IS NULL THEN
    PERFORM pg_advisory_xact_lock(48291, hashtext(v_subscription_id::text));

    SELECT up.tryons_used
    INTO v_tryons_used
    FROM public.vto_usage_periods up
    WHERE up.subscription_id = v_subscription_id
      AND NOW() >= up.period_start
      AND NOW() < up.period_end
    LIMIT 1;

    IF v_tryons_used IS NULL THEN
      INSERT INTO public.vto_usage_periods (
        account_id, subscription_id, period_start, period_end,
        tryons_used, overage_quantity, overage_billed
      ) VALUES (
        v_account_id, v_subscription_id, NOW(),
        NOW() + INTERVAL '1 month',
        0, 0, false
      )
      ON CONFLICT (subscription_id, period_start) DO NOTHING;
      v_tryons_used := 0;

      UPDATE public.vto_stores
      SET overage_credits_used = 0
      WHERE store_slug = p_store_slug;
      v_overage_credits_used := 0;
    END IF;
  END IF;

  -- 5. Check limits
  IF p_success AND v_tryons_used >= v_included_tryons THEN
    IF v_plan_code = 'ello_free' THEN
      INSERT INTO public.tryon_events (
        store_slug, success, is_overage, product_id, variant_id, session_id,
        page_type, page_path, page_handle, page_in_catalog, entry_source, ip_address
      )
      VALUES (
        p_store_slug, false, false, p_product_id, p_variant_id, p_session_id,
        p_page_type, p_page_path, p_page_handle, p_page_in_catalog, p_entry_source, p_ip_address
      );

      RETURN jsonb_build_object(
        'allowed', false,
        'error', 'MONTHLY_LIMIT_REACHED',
        'is_overage', false,
        'plan_code', v_plan_code,
        'tryons_used', v_tryons_used,
        'included_tryons', v_included_tryons,
        'shop_domain', v_shop_domain
      );
    END IF;

    v_is_overage := true;

    IF NOT v_overage_auto_topup THEN
      INSERT INTO public.tryon_events (
        store_slug, success, is_overage, product_id, variant_id, session_id,
        page_type, page_path, page_handle, page_in_catalog, entry_source, ip_address
      )
      VALUES (
        p_store_slug, false, true, p_product_id, p_variant_id, p_session_id,
        p_page_type, p_page_path, p_page_handle, p_page_in_catalog, p_entry_source, p_ip_address
      );

      RETURN jsonb_build_object(
        'allowed', false,
        'error', 'OVERAGE_BLOCKED',
        'is_overage', true,
        'plan_code', v_plan_code,
        'tryons_used', v_tryons_used,
        'included_tryons', v_included_tryons,
        'overage_auto_topup', false,
        'shop_domain', v_shop_domain
      );
    END IF;

    IF v_overage_credits_used >= v_overage_cap_credits THEN
      INSERT INTO public.tryon_events (
        store_slug, success, is_overage, product_id, variant_id, session_id,
        page_type, page_path, page_handle, page_in_catalog, entry_source, ip_address
      )
      VALUES (
        p_store_slug, false, true, p_product_id, p_variant_id, p_session_id,
        p_page_type, p_page_path, p_page_handle, p_page_in_catalog, p_entry_source, p_ip_address
      );

      RETURN jsonb_build_object(
        'allowed', false,
        'error', 'OVERAGE_CAP_REACHED',
        'is_overage', true,
        'plan_code', v_plan_code,
        'tryons_used', v_tryons_used,
        'included_tryons', v_included_tryons,
        'overage_credits_used', v_overage_credits_used,
        'overage_cap_credits', v_overage_cap_credits,
        'shop_domain', v_shop_domain
      );
    END IF;
  END IF;

  -- 6. Record usage
  IF p_success THEN
    UPDATE public.vto_usage_periods
    SET tryons_used = tryons_used + 1,
        overage_quantity = CASE WHEN v_is_overage THEN overage_quantity + 1 ELSE overage_quantity END
    WHERE subscription_id = v_subscription_id
      AND NOW() >= period_start
      AND NOW() < period_end;

    IF v_is_overage THEN
      UPDATE public.vto_stores
      SET overage_credits_used = overage_credits_used + 1
      WHERE store_slug = p_store_slug;
    END IF;
  END IF;

  -- 7. Log the event with page context + surface attribution
  INSERT INTO public.tryon_events (
    store_slug, success, is_overage, product_id, variant_id, session_id,
    page_type, page_path, page_handle, page_in_catalog, entry_source, ip_address
  )
  VALUES (
    p_store_slug, p_success, v_is_overage, p_product_id, p_variant_id, p_session_id,
    p_page_type, p_page_path, p_page_handle, p_page_in_catalog, p_entry_source, p_ip_address
  );

  -- 8. Return result (unchanged shape)
  RETURN jsonb_build_object(
    'allowed', true,
    'is_overage', v_is_overage,
    'plan_code', v_plan_code,
    'tryons_used', v_tryons_used + (CASE WHEN p_success THEN 1 ELSE 0 END),
    'included_tryons', v_included_tryons,
    'overage_credits_used', CASE WHEN v_is_overage THEN v_overage_credits_used + 1 ELSE v_overage_credits_used END,
    'overage_cap_credits', v_overage_cap_credits,
    'shop_domain', v_shop_domain,
    'shopify_usage_line_item_id', v_shopify_usage_line_item_id
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.record_tryon_event(
  TEXT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT
) TO anon, authenticated, service_role;

COMMIT;

-- ─── Post-migration sanity check (run separately) ────────────────────────────
-- SELECT shop_domain, shopper_limit_enabled, shopper_limit_count,
--        shopper_limit_window_hours
--   FROM vto_stores;
