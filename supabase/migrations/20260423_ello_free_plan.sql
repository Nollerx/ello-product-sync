-- ============================================================================
-- Ello Free Plan Migration
-- Date: 2026-04-23
-- Purpose: Add ello_free plan (10 try-ons/month), extend record_tryon_event
--          to return plan_code and a distinct MONTHLY_LIMIT_REACHED error for
--          free-plan cap hits, and extend get_store_usage to return plan_code.
-- ============================================================================

-- ─── 1. Insert / upsert the ello_free plan ──────────────────────────────────

INSERT INTO public.vto_plans (
  id, code, name, monthly_price, annual_price,
  included_tryons_per_month, overage_usd_per_tryon
)
VALUES (
  'ab69eb9e-648c-4777-a6f6-6482f8b780a7',
  'ello_free',
  'Ello Free',
  0,
  0,
  10,
  0
)
ON CONFLICT (code) DO UPDATE
  SET included_tryons_per_month = EXCLUDED.included_tryons_per_month,
      monthly_price             = EXCLUDED.monthly_price,
      annual_price              = EXCLUDED.annual_price,
      overage_usd_per_tryon     = EXCLUDED.overage_usd_per_tryon,
      name                      = EXCLUDED.name;

-- ─── 2. record_tryon_event — add plan_code + MONTHLY_LIMIT_REACHED branch ───

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT oid::regprocedure::text AS sig
    FROM pg_proc
    WHERE proname = 'record_tryon_event'
      AND pronamespace = 'public'::regnamespace
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.record_tryon_event(
  p_store_slug TEXT,
  p_success BOOLEAN DEFAULT true,
  p_product_id TEXT DEFAULT NULL,
  p_variant_id TEXT DEFAULT NULL,
  p_session_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
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
BEGIN
  -- 1. Look up store
  SELECT s.account_id, s.shop_domain, s.overage_auto_topup, s.overage_cap_credits, s.overage_credits_used
  INTO v_account_id, v_shop_domain, v_overage_auto_topup, v_overage_cap_credits, v_overage_credits_used
  FROM public.vto_stores s
  WHERE s.store_slug = p_store_slug
  LIMIT 1;

  IF v_account_id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'error', 'STORE_NOT_FOUND');
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

  -- 4. Get or create current usage period
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

  -- 5. Check limits
  IF p_success AND v_tryons_used >= v_included_tryons THEN
    -- Free plan: no overage path at all — hard block with MONTHLY_LIMIT_REACHED
    IF v_plan_code = 'ello_free' THEN
      INSERT INTO public.tryon_events (store_slug, success, is_overage, product_id, variant_id, session_id)
      VALUES (p_store_slug, false, false, p_product_id, p_variant_id, p_session_id);

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

    -- Paid plans: existing overage behavior
    v_is_overage := true;

    IF NOT v_overage_auto_topup THEN
      INSERT INTO public.tryon_events (store_slug, success, is_overage, product_id, variant_id, session_id)
      VALUES (p_store_slug, false, true, p_product_id, p_variant_id, p_session_id);

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
      INSERT INTO public.tryon_events (store_slug, success, is_overage, product_id, variant_id, session_id)
      VALUES (p_store_slug, false, true, p_product_id, p_variant_id, p_session_id);

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

  -- 6. Record the try-on (allowed)
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

  -- 7. Log the event
  INSERT INTO public.tryon_events (store_slug, success, is_overage, product_id, variant_id, session_id)
  VALUES (p_store_slug, p_success, v_is_overage, p_product_id, p_variant_id, p_session_id);

  -- 8. Return result
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
$$;

GRANT EXECUTE ON FUNCTION public.record_tryon_event TO anon;

-- ─── 3. get_store_usage — add plan_code ─────────────────────────────────────

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT oid::regprocedure::text AS sig
    FROM pg_proc
    WHERE proname = 'get_store_usage'
      AND pronamespace = 'public'::regnamespace
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.get_store_usage(
  p_store_slug TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_account_id UUID;
  v_subscription_id UUID;
  v_plan_id UUID;
  v_plan_code TEXT;
  v_plan_name TEXT;
  v_included_tryons INT;
  v_tryons_used INT;
  v_period_start TIMESTAMPTZ;
  v_period_end TIMESTAMPTZ;
  v_overage_auto_topup BOOLEAN;
  v_overage_cap_credits INT;
  v_overage_credits_used INT;
  v_overage_trigger_threshold INT;
BEGIN
  SELECT s.account_id, s.overage_auto_topup, s.overage_cap_credits,
         s.overage_credits_used, s.overage_trigger_threshold
  INTO v_account_id, v_overage_auto_topup, v_overage_cap_credits,
       v_overage_credits_used, v_overage_trigger_threshold
  FROM public.vto_stores s
  WHERE s.store_slug = p_store_slug
  LIMIT 1;

  IF v_account_id IS NULL THEN
    RETURN jsonb_build_object('error', 'STORE_NOT_FOUND');
  END IF;

  SELECT sub.id, sub.plan_id
  INTO v_subscription_id, v_plan_id
  FROM public.vto_subscriptions sub
  WHERE sub.account_id = v_account_id AND sub.status = 'active'
  LIMIT 1;

  IF v_subscription_id IS NULL THEN
    RETURN jsonb_build_object('error', 'NO_ACTIVE_SUBSCRIPTION');
  END IF;

  SELECT p.code, p.name, p.included_tryons_per_month
  INTO v_plan_code, v_plan_name, v_included_tryons
  FROM public.vto_plans p
  WHERE p.id = v_plan_id;

  SELECT up.tryons_used, up.period_start, up.period_end
  INTO v_tryons_used, v_period_start, v_period_end
  FROM public.vto_usage_periods up
  WHERE up.subscription_id = v_subscription_id
    AND NOW() >= up.period_start
    AND NOW() < up.period_end
  LIMIT 1;

  RETURN jsonb_build_object(
    'plan_code', COALESCE(v_plan_code, 'unknown'),
    'plan_name', COALESCE(v_plan_name, 'Unknown'),
    'included_tryons', COALESCE(v_included_tryons, 0),
    'tryons_used', COALESCE(v_tryons_used, 0),
    'tryons_remaining', GREATEST(0, COALESCE(v_included_tryons, 0) - COALESCE(v_tryons_used, 0)),
    'period_start', v_period_start,
    'period_end', v_period_end,
    'overage_auto_topup', COALESCE(v_overage_auto_topup, false),
    'overage_cap_credits', COALESCE(v_overage_cap_credits, 100),
    'overage_credits_used', COALESCE(v_overage_credits_used, 0),
    'overage_credits_remaining', GREATEST(0, COALESCE(v_overage_cap_credits, 100) - COALESCE(v_overage_credits_used, 0)),
    'overage_trigger_threshold', COALESCE(v_overage_trigger_threshold, 50),
    'overage_rate', 0.15
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_store_usage TO anon;
