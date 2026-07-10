-- ═════════════════════════════════════════════════════════════════════════════
-- Billing-period anchor fix (2026-07-04)
--
-- BUG: record_tryon_event created each new usage period with
--        period_start = NOW(),  period_end = NOW() + INTERVAL '1 month'
--      i.e. anchored to the wall-clock moment of the first try-on after the
--      previous window expired. Ello's period boundaries therefore drifted away
--      from Shopify's real billing cycle, and every drift RESET the included
--      allowance — so overage was under-counted (Atlas: 375 try-ons in one
--      Shopify cycle split across two windows, 2 billed instead of 75).
--
-- FIX: anchor every usage period to the subscription's Shopify cycle
--      (current_period_start + whole billing intervals), so Ello's window always
--      lines up with the cycle Shopify actually bills — with no wall-clock drift.
--
-- TRANSITION-SAFE: the first try-on after this deploys does NOT reset a live
--      store's counter. If a legacy NOW()-anchored period is currently active,
--      it is re-anchored IN PLACE (period_start/end moved to the Shopify window,
--      tryons_used preserved). Only genuinely new windows start at 0.
--
-- Signature is unchanged, so CREATE OR REPLACE (no DROP) keeps the GRANTs.
-- ═════════════════════════════════════════════════════════════════════════════
BEGIN;

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
  -- Billing-window anchoring (2026-07-04)
  v_anchor_start TIMESTAMPTZ;
  v_interval TEXT;
  v_billing_source TEXT;
  v_step INTERVAL;
  v_period_start TIMESTAMPTZ;
  v_period_end TIMESTAMPTZ;
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

  -- 2. Get active subscription (+ its Shopify billing anchor)
  SELECT sub.id, sub.plan_id, sub.shopify_usage_line_item_id,
         sub.current_period_start, sub.billing_interval, sub.billing_source
  INTO v_subscription_id, v_plan_id, v_shopify_usage_line_item_id,
       v_anchor_start, v_interval, v_billing_source
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

  -- 4. Determine the current billing window, ANCHORED to Shopify's cycle
  --    (current_period_start + whole billing intervals). No wall-clock drift.
  -- Shopify app subscriptions bill EVERY_30_DAYS (not a calendar month), so a
  -- Shopify monthly cycle steps by 30 days or Ello drifts ~1 day/cycle off
  -- Shopify's anchor. Stripe bills calendar months. Annual = 1 year either way.
  v_step := CASE
              WHEN v_interval = 'year' THEN INTERVAL '1 year'
              WHEN COALESCE(v_billing_source, '') = 'shopify' THEN INTERVAL '30 days'
              ELSE INTERVAL '1 month'
            END;

  IF v_anchor_start IS NULL OR v_anchor_start > NOW() THEN
    -- No usable anchor — fall back to a NOW()-anchored window (legacy behaviour,
    -- so we never fail closed on a subscription missing its period start).
    v_period_start := date_trunc('second', NOW());
    v_period_end := v_period_start + v_step;
  ELSE
    v_period_start := v_anchor_start;
    -- Advance whole intervals until the window contains NOW(). Bounded so a bad
    -- anchor can never spin (600 monthly steps = 50 years).
    FOR _i IN 1..600 LOOP
      EXIT WHEN v_period_start + v_step > NOW();
      v_period_start := v_period_start + v_step;
    END LOOP;
    v_period_end := v_period_start + v_step;
  END IF;

  -- Get-or-create the usage period for [v_period_start, v_period_end) — RACE-SAFE.
  SELECT up.tryons_used
  INTO v_tryons_used
  FROM public.vto_usage_periods up
  WHERE up.subscription_id = v_subscription_id
    AND up.period_start = v_period_start
  LIMIT 1;

  IF v_tryons_used IS NULL THEN
    PERFORM pg_advisory_xact_lock(48291, hashtext(v_subscription_id::text));

    SELECT up.tryons_used
    INTO v_tryons_used
    FROM public.vto_usage_periods up
    WHERE up.subscription_id = v_subscription_id
      AND up.period_start = v_period_start
    LIMIT 1;

    IF v_tryons_used IS NULL THEN
      -- TRANSITION: adopt a legacy NOW()-anchored period that still contains
      -- NOW() by re-anchoring it IN PLACE — preserves tryons_used so a live
      -- store's allowance is NOT reset when this fix first runs. Only one row
      -- can hold v_period_start (unique), so guard against a pre-existing one.
      UPDATE public.vto_usage_periods up
      SET period_start = v_period_start,
          period_end   = v_period_end
      WHERE up.ctid = (
        SELECT up2.ctid FROM public.vto_usage_periods up2
        WHERE up2.subscription_id = v_subscription_id
          AND up2.period_start <> v_period_start
          AND NOW() >= up2.period_start
          AND NOW() <  up2.period_end
        ORDER BY up2.period_start DESC
        LIMIT 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.vto_usage_periods up3
        WHERE up3.subscription_id = v_subscription_id
          AND up3.period_start = v_period_start
      )
      RETURNING up.tryons_used INTO v_tryons_used;

      IF v_tryons_used IS NULL THEN
        -- Genuinely a fresh window → start at 0 and reset the cap counter.
        INSERT INTO public.vto_usage_periods (
          account_id, subscription_id, period_start, period_end,
          tryons_used, overage_quantity, overage_billed
        ) VALUES (
          v_account_id, v_subscription_id, v_period_start, v_period_end,
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

  -- 6. Record usage (match the SAME anchored window we resolved above)
  IF p_success THEN
    UPDATE public.vto_usage_periods
    SET tryons_used = tryons_used + 1,
        overage_quantity = CASE WHEN v_is_overage THEN overage_quantity + 1 ELSE overage_quantity END
    WHERE subscription_id = v_subscription_id
      AND period_start = v_period_start;

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

COMMIT;
