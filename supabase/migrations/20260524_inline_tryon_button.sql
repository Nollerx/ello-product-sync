-- 20260524_inline_tryon_button.sql
--
-- Three-surface placement system: inline button (new), floating widget
-- (existing, now split into PDP / non-PDP toggles), preview popup (existing).
--
-- Adds:
--   • Seven new vto_stores columns for per-surface configuration
--   • placements_banner_dismissed_at — one-time "new feature" banner for existing merchants
--   • entry_source on tryon_events so we can attribute every try-on to a surface
--
-- Updates:
--   • bump_vto_store_config_version trigger — extended IS DISTINCT FROM list so cache
--     invalidates whenever any new placement setting changes
--   • get_widget_config RPC — returns the new columns
--
-- Migrates:
--   • Pre-existing merchants (e.g., Marcos / Kaizen) keep floating_widget_pdp_enabled = true
--     so their storefronts don't change behavior. New installs get the cleaner inline-only
--     PDP default.
--
-- ALL existing rows have config_version bumped at the end so cached browsers refresh.

BEGIN;

-- ─── 1. New vto_stores columns ──────────────────────────────────────────────
ALTER TABLE vto_stores
    ADD COLUMN IF NOT EXISTS inline_button_enabled         BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS inline_button_text            TEXT    NOT NULL DEFAULT 'Try On',
    ADD COLUMN IF NOT EXISTS inline_button_color           TEXT,
    ADD COLUMN IF NOT EXISTS inline_button_text_color      TEXT,
    ADD COLUMN IF NOT EXISTS inline_button_hide_when_oos   BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS floating_widget_pdp_enabled       BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS floating_widget_non_pdp_enabled   BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS placements_banner_dismissed_at    TIMESTAMPTZ;

-- ─── 2. Preserve existing-merchant behavior ─────────────────────────────────
-- Anyone already using the widget had the floating bubble showing on PDPs
-- (smart-visibility or always-on). Keep that visible for them so nothing
-- visibly changes on Marcos's storefront. Brand-new installs (< 1 day old)
-- fall through to the new clean default of PDP off.
UPDATE vto_stores
   SET floating_widget_pdp_enabled = true
 WHERE widget_visibility_mode IN ('smart', 'always')
   AND created_at < NOW() - INTERVAL '1 day';

-- ─── 3. Extend the version-bump trigger ─────────────────────────────────────
-- Mirrors the existing trigger body from 20260523_widget_config_versioning.sql,
-- adds the seven new placement columns to the IS DISTINCT FROM check so
-- merchant edits propagate through the same SWR cache path everything else uses.
CREATE OR REPLACE FUNCTION bump_vto_store_config_version() RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.widget_primary_color, NEW.widget_accent_color, NEW.minimized_color,
      NEW.featured_item_id, NEW.quick_picks_ids, NEW.desktop_preview_enabled,
      NEW.preview_delay_seconds, NEW.preview_theme, NEW.widget_position,
      NEW.widget_visibility_mode, NEW.clothing_population_type,
      NEW.storefront_token, NEW.shop_domain,
      NEW.inline_button_enabled, NEW.inline_button_text, NEW.inline_button_color,
      NEW.inline_button_text_color, NEW.inline_button_hide_when_oos,
      NEW.floating_widget_pdp_enabled, NEW.floating_widget_non_pdp_enabled)
     IS DISTINCT FROM
     (OLD.widget_primary_color, OLD.widget_accent_color, OLD.minimized_color,
      OLD.featured_item_id, OLD.quick_picks_ids, OLD.desktop_preview_enabled,
      OLD.preview_delay_seconds, OLD.preview_theme, OLD.widget_position,
      OLD.widget_visibility_mode, OLD.clothing_population_type,
      OLD.storefront_token, OLD.shop_domain,
      OLD.inline_button_enabled, OLD.inline_button_text, OLD.inline_button_color,
      OLD.inline_button_text_color, OLD.inline_button_hide_when_oos,
      OLD.floating_widget_pdp_enabled, OLD.floating_widget_non_pdp_enabled)
  THEN
    NEW.config_version := COALESCE(OLD.config_version, 0) + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── 4. Extend get_widget_config RPC ────────────────────────────────────────
-- Returns the seven new placement columns alongside the existing config.
-- Storefront widget-loader.js reads these via /api/widget-config-resolved.
--
-- Postgres won't allow CREATE OR REPLACE FUNCTION when RETURNS TABLE shape
-- changes — must DROP first. Safe because the function is recreated immediately
-- below with the same name and an extended (additive-only) return shape.
DROP FUNCTION IF EXISTS get_widget_config(TEXT, TEXT);

CREATE OR REPLACE FUNCTION get_widget_config(
  p_store_slug  TEXT DEFAULT NULL,
  p_shop_domain TEXT DEFAULT NULL
) RETURNS TABLE (
  store_slug                      TEXT,
  shop_domain                     TEXT,
  storefront_token                TEXT,
  clothing_population_type        TEXT,
  widget_primary_color            TEXT,
  widget_accent_color             TEXT,
  minimized_color                 TEXT,
  featured_item_id                TEXT,
  quick_picks_ids                 TEXT[],
  desktop_preview_enabled         BOOLEAN,
  preview_delay_seconds           INT,
  preview_theme                   TEXT,
  widget_position                 TEXT,
  widget_visibility_mode          TEXT,
  inline_button_enabled           BOOLEAN,
  inline_button_text              TEXT,
  inline_button_color             TEXT,
  inline_button_text_color        TEXT,
  inline_button_hide_when_oos     BOOLEAN,
  floating_widget_pdp_enabled     BOOLEAN,
  floating_widget_non_pdp_enabled BOOLEAN,
  config_version                  BIGINT
) LANGUAGE sql STABLE AS $$
  SELECT s.store_slug, s.shop_domain, s.storefront_token, s.clothing_population_type,
         s.widget_primary_color, s.widget_accent_color, s.minimized_color,
         s.featured_item_id, s.quick_picks_ids, s.desktop_preview_enabled,
         s.preview_delay_seconds, s.preview_theme, s.widget_position,
         s.widget_visibility_mode,
         s.inline_button_enabled, s.inline_button_text, s.inline_button_color,
         s.inline_button_text_color, s.inline_button_hide_when_oos,
         s.floating_widget_pdp_enabled, s.floating_widget_non_pdp_enabled,
         s.config_version
    FROM vto_stores s
   WHERE (p_store_slug  IS NOT NULL AND s.store_slug  = p_store_slug)
      OR (p_shop_domain IS NOT NULL AND s.shop_domain = p_shop_domain)
   LIMIT 1;
$$;

-- ─── 5. Surface attribution on tryon_events ─────────────────────────────────
-- Lets us measure conversion per surface (inline vs floating vs preview).
-- 'unknown' is permitted so we can still record events from older widget
-- versions that haven't been updated to tag the source.
ALTER TABLE tryon_events
    ADD COLUMN IF NOT EXISTS entry_source TEXT
        CHECK (entry_source IN ('inline_button', 'floating_widget', 'preview_popup', 'unknown'));

CREATE INDEX IF NOT EXISTS idx_tryon_events_entry_source ON tryon_events(entry_source);

-- ─── 5b. Extend record_tryon_event RPC with entry_source ────────────────────
-- Adds p_entry_source as a new trailing optional parameter (DEFAULT NULL) so
-- pre-existing callers continue to work without modification. All four
-- INSERT INTO tryon_events statements in this RPC now persist entry_source.
--
-- Body otherwise preserved verbatim from 20260523_record_tryon_event_advisory_lock.sql
-- including the advisory-lock race-safety pattern. ONLY signature and the
-- INSERT column lists change.
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
  p_entry_source TEXT DEFAULT NULL
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
        page_type, page_path, page_handle, page_in_catalog, entry_source
      )
      VALUES (
        p_store_slug, false, false, p_product_id, p_variant_id, p_session_id,
        p_page_type, p_page_path, p_page_handle, p_page_in_catalog, p_entry_source
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
        page_type, page_path, page_handle, page_in_catalog, entry_source
      )
      VALUES (
        p_store_slug, false, true, p_product_id, p_variant_id, p_session_id,
        p_page_type, p_page_path, p_page_handle, p_page_in_catalog, p_entry_source
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
        page_type, page_path, page_handle, page_in_catalog, entry_source
      )
      VALUES (
        p_store_slug, false, true, p_product_id, p_variant_id, p_session_id,
        p_page_type, p_page_path, p_page_handle, p_page_in_catalog, p_entry_source
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
    page_type, page_path, page_handle, page_in_catalog, entry_source
  )
  VALUES (
    p_store_slug, p_success, v_is_overage, p_product_id, p_variant_id, p_session_id,
    p_page_type, p_page_path, p_page_handle, p_page_in_catalog, p_entry_source
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
  TEXT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT
) TO anon, authenticated, service_role;

-- ─── 6. Cache-bust every existing row ───────────────────────────────────────
-- Bumps config_version so any browser holding a cached config in localStorage
-- refreshes on next pageview. Required because we added new fields that the
-- widget needs to render correctly.
UPDATE vto_stores SET config_version = COALESCE(config_version, 0) + 1;

COMMIT;

-- ─── Post-migration sanity check (run separately, not part of transaction) ──
-- SELECT shop_domain,
--        inline_button_enabled, inline_button_text,
--        floating_widget_pdp_enabled, floating_widget_non_pdp_enabled,
--        config_version
--   FROM vto_stores;
--
-- Marcos / Kaizen rows should show floating_widget_pdp_enabled = true.
-- All rows should show inline_button_enabled = true (kill-switch defaults on).
