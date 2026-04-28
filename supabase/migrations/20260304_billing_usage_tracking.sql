-- ============================================================================
-- Billing & Usage Tracking Migration
-- Date: 2026-03-04
-- Purpose: Create RPC functions for try-on tracking, overage enforcement,
--          and supporting analytics RPCs
-- ============================================================================

-- ─── 1. Schema Alterations ──────────────────────────────────────────────────

-- Add overage settings to vto_stores
ALTER TABLE public.vto_stores
ADD COLUMN IF NOT EXISTS overage_auto_topup BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS overage_cap_credits INT DEFAULT 100,
ADD COLUMN IF NOT EXISTS overage_trigger_threshold INT DEFAULT 50,
ADD COLUMN IF NOT EXISTS overage_credits_used INT DEFAULT 0;

-- Add Shopify usage line item ID to vto_subscriptions
ALTER TABLE public.vto_subscriptions
ADD COLUMN IF NOT EXISTS shopify_usage_line_item_id TEXT;

-- ─── 2. Try-On Events Logging Table ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tryon_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_slug TEXT NOT NULL,
  success BOOLEAN DEFAULT false,
  is_overage BOOLEAN DEFAULT false,
  product_id TEXT,
  variant_id TEXT,
  session_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tryon_events_store_created
  ON public.tryon_events(store_slug, created_at);

-- ─── 3. Widget Analytics Tables ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.widget_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_slug TEXT NOT NULL,
  event_type TEXT NOT NULL,
  session_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_widget_events_store
  ON public.widget_events(store_slug, created_at);

CREATE TABLE IF NOT EXISTS public.cart_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_slug TEXT NOT NULL,
  product_id TEXT,
  variant_id TEXT,
  session_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cart_events_store
  ON public.cart_events(store_slug, created_at);

-- ─── 4. RPC: record_tryon_event ─────────────────────────────────────────────
-- Called by the try-on proxy to track usage and enforce limits.
-- Returns JSON: {allowed, is_overage, tryons_used, included_tryons, shop_domain}

-- Drop all overloads of record_tryon_event
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
  v_included_tryons INT;
  v_tryons_used INT;
  v_period_id UUID;
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

  -- 3. Get plan's included tryons
  SELECT p.included_tryons_per_month
  INTO v_included_tryons
  FROM public.vto_plans p
  WHERE p.id = v_plan_id;

  IF v_included_tryons IS NULL THEN
    -- Fallback: if plan not found in DB, allow (shouldn't happen)
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
    -- No usage period exists for current time - create one
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

    -- Reset the store-level overage counter for the new billing period
    UPDATE public.vto_stores
    SET overage_credits_used = 0
    WHERE store_slug = p_store_slug;
    v_overage_credits_used := 0;
  END IF;

  -- 5. Check limits
  IF p_success AND v_tryons_used >= v_included_tryons THEN
    -- Over the plan limit - check overage settings
    v_is_overage := true;

    IF NOT v_overage_auto_topup THEN
      -- Auto top-up is OFF → block
      -- Still log the event as blocked
      INSERT INTO public.tryon_events (store_slug, success, is_overage, product_id, variant_id, session_id)
      VALUES (p_store_slug, false, true, p_product_id, p_variant_id, p_session_id);

      RETURN jsonb_build_object(
        'allowed', false,
        'error', 'OVERAGE_BLOCKED',
        'is_overage', true,
        'tryons_used', v_tryons_used,
        'included_tryons', v_included_tryons,
        'overage_auto_topup', false,
        'shop_domain', v_shop_domain
      );
    END IF;

    IF v_overage_credits_used >= v_overage_cap_credits THEN
      -- Overage cap reached → block
      INSERT INTO public.tryon_events (store_slug, success, is_overage, product_id, variant_id, session_id)
      VALUES (p_store_slug, false, true, p_product_id, p_variant_id, p_session_id);

      RETURN jsonb_build_object(
        'allowed', false,
        'error', 'OVERAGE_CAP_REACHED',
        'is_overage', true,
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
    -- Increment usage period
    UPDATE public.vto_usage_periods
    SET tryons_used = tryons_used + 1,
        overage_quantity = CASE WHEN v_is_overage THEN overage_quantity + 1 ELSE overage_quantity END
    WHERE subscription_id = v_subscription_id
      AND NOW() >= period_start
      AND NOW() < period_end;

    -- Increment store-level overage counter if overage
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
    'tryons_used', v_tryons_used + (CASE WHEN p_success THEN 1 ELSE 0 END),
    'included_tryons', v_included_tryons,
    'overage_credits_used', CASE WHEN v_is_overage THEN v_overage_credits_used + 1 ELSE v_overage_credits_used END,
    'overage_cap_credits', v_overage_cap_credits,
    'shop_domain', v_shop_domain,
    'shopify_usage_line_item_id', v_shopify_usage_line_item_id
  );
END;
$$;

-- ─── 5. RPC: record_widget_event ────────────────────────────────────────────

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT oid::regprocedure::text AS sig
    FROM pg_proc
    WHERE proname = 'record_widget_event'
      AND pronamespace = 'public'::regnamespace
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.record_widget_event(
  p_store_slug TEXT,
  p_event_type TEXT DEFAULT 'generic',
  p_session_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.widget_events (store_slug, event_type, session_id)
  VALUES (p_store_slug, p_event_type, p_session_id);

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─── 6. RPC: record_widget_open ─────────────────────────────────────────────

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT oid::regprocedure::text AS sig
    FROM pg_proc
    WHERE proname = 'record_widget_open'
      AND pronamespace = 'public'::regnamespace
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.record_widget_open(
  p_store_slug TEXT,
  p_session_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.widget_events (store_slug, event_type, session_id)
  VALUES (p_store_slug, 'widget_open', p_session_id);

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─── 7. RPC: record_cart_event ──────────────────────────────────────────────

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT oid::regprocedure::text AS sig
    FROM pg_proc
    WHERE proname = 'record_cart_event'
      AND pronamespace = 'public'::regnamespace
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.record_cart_event(
  p_store_slug TEXT,
  p_product_id TEXT DEFAULT NULL,
  p_variant_id TEXT DEFAULT NULL,
  p_session_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.cart_events (store_slug, product_id, variant_id, session_id)
  VALUES (p_store_slug, p_product_id, p_variant_id, p_session_id);

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─── 8. RPC: get_store_usage ────────────────────────────────────────────────
-- Used by dashboard to display current usage stats

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
  -- Get store + overage settings
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

  -- Get active subscription + plan
  SELECT sub.id, sub.plan_id
  INTO v_subscription_id, v_plan_id
  FROM public.vto_subscriptions sub
  WHERE sub.account_id = v_account_id AND sub.status = 'active'
  LIMIT 1;

  IF v_subscription_id IS NULL THEN
    RETURN jsonb_build_object('error', 'NO_ACTIVE_SUBSCRIPTION');
  END IF;

  -- Get plan details
  SELECT p.name, p.included_tryons_per_month
  INTO v_plan_name, v_included_tryons
  FROM public.vto_plans p
  WHERE p.id = v_plan_id;

  -- Get current usage period
  SELECT up.tryons_used, up.period_start, up.period_end
  INTO v_tryons_used, v_period_start, v_period_end
  FROM public.vto_usage_periods up
  WHERE up.subscription_id = v_subscription_id
    AND NOW() >= up.period_start
    AND NOW() < up.period_end
  LIMIT 1;

  RETURN jsonb_build_object(
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

-- ─── 9. RLS Policies ────────────────────────────────────────────────────────

-- Allow anon key to call RPC functions (widget uses anon key)
ALTER TABLE public.tryon_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cart_events ENABLE ROW LEVEL SECURITY;

-- Service role gets full access
DROP POLICY IF EXISTS "Service role full access on tryon_events" ON public.tryon_events;
CREATE POLICY "Service role full access on tryon_events"
  ON public.tryon_events TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on widget_events" ON public.widget_events;
CREATE POLICY "Service role full access on widget_events"
  ON public.widget_events TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on cart_events" ON public.cart_events;
CREATE POLICY "Service role full access on cart_events"
  ON public.cart_events TO service_role
  USING (true) WITH CHECK (true);

-- Anon role can insert events (the RPC functions run as SECURITY DEFINER so they bypass RLS)
-- But for direct REST API calls from the widget, we need insert access:
DROP POLICY IF EXISTS "Anon insert on tryon_events" ON public.tryon_events;
CREATE POLICY "Anon insert on tryon_events"
  ON public.tryon_events FOR INSERT TO anon
  WITH CHECK (true);

DROP POLICY IF EXISTS "Anon insert on widget_events" ON public.widget_events;
CREATE POLICY "Anon insert on widget_events"
  ON public.widget_events FOR INSERT TO anon
  WITH CHECK (true);

DROP POLICY IF EXISTS "Anon insert on cart_events" ON public.cart_events;
CREATE POLICY "Anon insert on cart_events"
  ON public.cart_events FOR INSERT TO anon
  WITH CHECK (true);

-- Grant execute on RPC functions to anon (for widget calls)
GRANT EXECUTE ON FUNCTION public.record_tryon_event TO anon;
GRANT EXECUTE ON FUNCTION public.record_widget_event TO anon;
GRANT EXECUTE ON FUNCTION public.record_widget_open TO anon;
GRANT EXECUTE ON FUNCTION public.record_cart_event TO anon;
GRANT EXECUTE ON FUNCTION public.get_store_usage TO anon;
