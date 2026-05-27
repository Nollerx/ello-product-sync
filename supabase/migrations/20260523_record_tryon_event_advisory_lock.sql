-- Migration: 20260523_record_tryon_event_advisory_lock
-- Purpose:   Make record_tryon_event race-safe for first-of-period try-ons.
-- Context:   The bad partial-unique index `uq_vto_usage_periods_subscription`
--            was dropped manually on 2026-05-23 to fix a latent Day-31 rollover
--            bug. That drop re-opened a small race window where two concurrent
--            try-ons for a brand-new subscription could each create their own
--            vto_usage_periods row (because period_start = NOW() differs across
--            statements, so ON CONFLICT (subscription_id, period_start) doesn't
--            fire). This migration closes that window with a transaction-scoped
--            advisory lock + double-checked re-read pattern.
--
-- Notes:
--   * 5-param overload of record_tryon_event exists in prod as an orphan and is
--     not touched here. To be cleaned up in a separate migration once we've
--     confirmed no caller references it.
--   * Signature, return shape, and all existing behavior preserved verbatim.
--   * Lock namespace 48291 is arbitrary; only requirement is uniqueness within
--     this database's advisory-lock space.

CREATE OR REPLACE FUNCTION public.record_tryon_event(
  p_store_slug TEXT,
  p_success BOOLEAN DEFAULT true,
  p_product_id TEXT DEFAULT NULL,
  p_variant_id TEXT DEFAULT NULL,
  p_session_id TEXT DEFAULT NULL,
  p_page_type TEXT DEFAULT NULL,
  p_page_path TEXT DEFAULT NULL,
  p_page_handle TEXT DEFAULT NULL,
  p_page_in_catalog BOOLEAN DEFAULT NULL
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

  -- 4. Get or create current usage period (RACE-SAFE)
  SELECT up.tryons_used
  INTO v_tryons_used
  FROM public.vto_usage_periods up
  WHERE up.subscription_id = v_subscription_id
    AND NOW() >= up.period_start
    AND NOW() < up.period_end
  LIMIT 1;

  IF v_tryons_used IS NULL THEN
    -- Serialize concurrent period creation for this subscription only.
    -- Transaction-scoped lock; auto-released when this RPC call returns.
    PERFORM pg_advisory_xact_lock(48291, hashtext(v_subscription_id::text));

    -- Re-check under lock: a concurrent call may have just created the row.
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
        page_type, page_path, page_handle, page_in_catalog
      )
      VALUES (
        p_store_slug, false, false, p_product_id, p_variant_id, p_session_id,
        p_page_type, p_page_path, p_page_handle, p_page_in_catalog
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
        page_type, page_path, page_handle, page_in_catalog
      )
      VALUES (
        p_store_slug, false, true, p_product_id, p_variant_id, p_session_id,
        p_page_type, p_page_path, p_page_handle, p_page_in_catalog
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
        page_type, page_path, page_handle, page_in_catalog
      )
      VALUES (
        p_store_slug, false, true, p_product_id, p_variant_id, p_session_id,
        p_page_type, p_page_path, p_page_handle, p_page_in_catalog
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

  -- 7. Log the event with page context
  INSERT INTO public.tryon_events (
    store_slug, success, is_overage, product_id, variant_id, session_id,
    page_type, page_path, page_handle, page_in_catalog
  )
  VALUES (
    p_store_slug, p_success, v_is_overage, p_product_id, p_variant_id, p_session_id,
    p_page_type, p_page_path, p_page_handle, p_page_in_catalog
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
  TEXT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN
) TO anon, authenticated, service_role;
