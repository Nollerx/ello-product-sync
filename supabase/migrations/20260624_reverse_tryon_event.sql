-- Migration: 20260624_reverse_tryon_event
-- Purpose:   Release a metered try-on credit when the render fails to produce an image.
--
--   record_tryon_event increments usage BEFORE the ML render runs, so the monthly
--   limit / overage gate can be enforced before we spend compute. If the render then
--   fails or returns no image, the reserved credit must be handed back so a try-on
--   that produced no photo never consumes the merchant's included or overage
--   allowance (and, for overage, is never billed — the proxy gates the Shopify
--   charge on a successful render).
--
--   This function reverses exactly one recorded try-on:
--     • decrements vto_usage_periods.tryons_used (and overage_quantity if overage)
--     • decrements vto_stores.overage_credits_used (if overage)
--     • flips the most recent matching success event in tryon_events to failed,
--       so the event log and the usage counter stay consistent.
--
--   Safe: purely additive. It does NOT modify record_tryon_event or any existing
--   object, so the live billing path is unchanged until the proxy starts calling it.

BEGIN;

CREATE OR REPLACE FUNCTION public.reverse_tryon_event(
  p_store_slug   TEXT,
  p_session_id   TEXT    DEFAULT NULL,
  p_was_overage  BOOLEAN DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_account_id      UUID;
  v_subscription_id UUID;
  v_event_id        UUID;
BEGIN
  SELECT s.account_id INTO v_account_id
  FROM public.vto_stores s
  WHERE s.store_slug = p_store_slug
  LIMIT 1;

  IF v_account_id IS NULL THEN
    RETURN jsonb_build_object('reversed', false, 'error', 'STORE_NOT_FOUND');
  END IF;

  SELECT sub.id INTO v_subscription_id
  FROM public.vto_subscriptions sub
  WHERE sub.account_id = v_account_id
    AND sub.status = 'active'
  ORDER BY sub.shopify_subscription_id DESC NULLS LAST
  LIMIT 1;

  IF v_subscription_id IS NULL THEN
    RETURN jsonb_build_object('reversed', false, 'error', 'NO_ACTIVE_SUBSCRIPTION');
  END IF;

  -- Release the metered credit from the current billing period (never below zero).
  UPDATE public.vto_usage_periods
  SET tryons_used = GREATEST(tryons_used - 1, 0),
      overage_quantity = CASE WHEN p_was_overage
                              THEN GREATEST(overage_quantity - 1, 0)
                              ELSE overage_quantity END
  WHERE subscription_id = v_subscription_id
    AND NOW() >= period_start
    AND NOW() < period_end;

  -- Release one overage credit on the store if the failed try-on was an overage.
  IF p_was_overage THEN
    UPDATE public.vto_stores
    SET overage_credits_used = GREATEST(overage_credits_used - 1, 0)
    WHERE store_slug = p_store_slug;
  END IF;

  -- Flip the just-logged success event to failed so the event log and the usage
  -- counter stay consistent. Matched by session when available for precision.
  SELECT te.id INTO v_event_id
  FROM public.tryon_events te
  WHERE te.store_slug = p_store_slug
    AND te.success = true
    AND (p_session_id IS NULL OR te.session_id = p_session_id)
  ORDER BY te.created_at DESC
  LIMIT 1;

  IF v_event_id IS NOT NULL THEN
    UPDATE public.tryon_events SET success = false WHERE id = v_event_id;
  END IF;

  RETURN jsonb_build_object('reversed', true);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.reverse_tryon_event(TEXT, TEXT, BOOLEAN)
  TO anon, authenticated, service_role;

COMMIT;
