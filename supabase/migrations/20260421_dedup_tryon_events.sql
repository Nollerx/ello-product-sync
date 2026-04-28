-- ============================================================================
-- Dedup Try-On Events — Prevent duplicate billing rows
-- Date: 2026-04-21
-- Purpose: The ML backend (ello-vto-13593516897) independently calls
--          record_tryon_event after render, ~4s after the Node.js proxy
--          (ello-vto-public-13593516897) already recorded it. This causes
--          every try-on to appear twice in tryon_events with matching
--          (session_id, product_id, store_slug) 0.6–5s apart.
--
--          Fix: Add a 30-second dedup window inside record_tryon_event.
--          If the same (store_slug, session_id, product_id) was already
--          recorded as success within the last 30s, skip the insert and
--          counter increment, returning allowed=true so the caller sees
--          no error.
--
-- Safe to re-run: Uses CREATE OR REPLACE.
-- ============================================================================

-- 1. Add index to speed up the dedup lookup
CREATE INDEX IF NOT EXISTS idx_tryon_events_dedup
  ON public.tryon_events (store_slug, session_id, product_id, created_at DESC)
  WHERE success = true;

-- 2. Replace the function with dedup logic added between steps 4 and 5
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

  -- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  -- 4b. DEDUP CHECK — 30-second window
  -- If the same (store_slug, session_id, product_id) was already recorded
  -- as a successful try-on within the last 30 seconds, this is a duplicate
  -- call (from the ML backend echoing the proxy's earlier recording).
  -- Return allowed=true without incrementing counters or inserting a row.
  -- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  IF p_success AND p_session_id IS NOT NULL THEN
    PERFORM 1 FROM public.tryon_events
    WHERE store_slug = p_store_slug
      AND session_id = p_session_id
      AND COALESCE(product_id, '') = COALESCE(p_product_id, '')
      AND success = true
      AND created_at > NOW() - INTERVAL '30 seconds'
    LIMIT 1;

    IF FOUND THEN
      -- Duplicate detected — return current stats without any writes
      RETURN jsonb_build_object(
        'allowed', true,
        'deduplicated', true,
        'is_overage', (v_tryons_used >= v_included_tryons),
        'tryons_used', v_tryons_used,
        'included_tryons', v_included_tryons,
        'overage_credits_used', v_overage_credits_used,
        'overage_cap_credits', v_overage_cap_credits,
        'shop_domain', v_shop_domain,
        'shopify_usage_line_item_id', v_shopify_usage_line_item_id
      );
    END IF;
  END IF;

  -- 5. Check limits
  IF p_success AND v_tryons_used >= v_included_tryons THEN
    v_is_overage := true;

    IF NOT v_overage_auto_topup THEN
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
    'tryons_used', v_tryons_used + (CASE WHEN p_success THEN 1 ELSE 0 END),
    'included_tryons', v_included_tryons,
    'overage_credits_used', CASE WHEN v_is_overage THEN v_overage_credits_used + 1 ELSE v_overage_credits_used END,
    'overage_cap_credits', v_overage_cap_credits,
    'shop_domain', v_shop_domain,
    'shopify_usage_line_item_id', v_shopify_usage_line_item_id
  );
END;
$$;

-- 3. Re-grant execute permission to anon role
GRANT EXECUTE ON FUNCTION public.record_tryon_event(TEXT, BOOLEAN, TEXT, TEXT, TEXT) TO anon;

-- Force PostgREST to pick up the schema change
NOTIFY pgrst, 'reload schema';
