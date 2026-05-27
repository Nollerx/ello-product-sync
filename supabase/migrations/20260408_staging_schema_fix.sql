-- ============================================================================
-- Staging Schema Fix — Run this on the STAGING Supabase (ownudmezwphsquvtunju)
-- Date: 2026-04-08
-- Purpose: Add all missing columns the app code expects, create missing tables,
--          deploy RPC functions, and seed data so afterAuth + VTO work end-to-end.
--          Safe to re-run (all statements are idempotent).
-- ============================================================================

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 1: Missing columns on core tables
-- ═══════════════════════════════════════════════════════════════════════════════

-- vto_accounts: code upserts on shopify_shop_domain, needs billing_source
ALTER TABLE public.vto_accounts
ADD COLUMN IF NOT EXISTS shopify_shop_domain TEXT,
ADD COLUMN IF NOT EXISTS billing_source TEXT;

-- Add UNIQUE constraint on shopify_shop_domain if not already present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'vto_accounts' AND indexname = 'vto_accounts_shopify_shop_domain_key'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'vto_accounts' AND indexname = 'idx_vto_accounts_shopify_shop_domain'
  ) THEN
    CREATE UNIQUE INDEX idx_vto_accounts_shopify_shop_domain ON public.vto_accounts(shopify_shop_domain);
  END IF;
END $$;

-- vto_subscriptions: code upserts on shopify_subscription_id, needs billing_source
ALTER TABLE public.vto_subscriptions
ADD COLUMN IF NOT EXISTS billing_source TEXT,
ADD COLUMN IF NOT EXISTS shopify_subscription_id TEXT,
ADD COLUMN IF NOT EXISTS shopify_usage_line_item_id TEXT;

-- Add UNIQUE constraint on shopify_subscription_id if not already present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'vto_subscriptions' AND indexname = 'vto_subscriptions_shopify_subscription_id_key'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'vto_subscriptions' AND indexname = 'idx_vto_subscriptions_shopify_sub_id'
  ) THEN
    CREATE UNIQUE INDEX idx_vto_subscriptions_shopify_sub_id ON public.vto_subscriptions(shopify_subscription_id);
  END IF;
END $$;

-- vto_stores: overage columns (from 20260304 migration)
ALTER TABLE public.vto_stores
ADD COLUMN IF NOT EXISTS overage_auto_topup BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS overage_cap_credits INT DEFAULT 100,
ADD COLUMN IF NOT EXISTS overage_trigger_threshold INT DEFAULT 50,
ADD COLUMN IF NOT EXISTS overage_credits_used INT DEFAULT 0;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 2: Seed vto_plans (safe re-run via ON CONFLICT DO NOTHING)
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO public.vto_plans (id, code, name, monthly_price, annual_price, included_tryons_per_month, overage_usd_per_tryon) VALUES
  ('00000000-0000-0000-0000-000000000000', 'custom_distribution',     'Custom Plan',       0,        0,         500,   0.15),
  ('a7d8292a-b720-418c-9de7-70191bc9969d', 'developer_free',          'Developer Free',    0,        0,         9999,  0.00),
  ('acf413dc-bcb0-484a-b914-2d6f6491eb39', 'starter',                 'Ello Starter',      49,       529.20,    75,    0.15),
  ('75fa2215-7008-4242-aef5-40aa2b278968', 'launch',                  'Ello Launch',       97,       1047.60,   300,   0.15),
  ('48ce4579-3523-45e1-9cc5-7f2bb0134073', 'growth',                  'Ello Growth',       249,      2689.20,   1500,  0.15),
  ('6c203206-7f01-4ca2-b1f2-fabda7a6306f', 'scale',                   'Ello Scale',        649,      7009.20,   5000,  0.15),
  ('f5bc29c9-e69d-4e46-8442-5d8adb66e11e', 'enterprise',              'Ello Enterprise',   0,        0,         0,     0.15)
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 3: Create analytics tables (from 20260304 migration)
-- ═══════════════════════════════════════════════════════════════════════════════

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

-- Extra columns on widget_events (from 20260318 migration)
ALTER TABLE public.widget_events
ADD COLUMN IF NOT EXISTS store_id TEXT,
ADD COLUMN IF NOT EXISTS widget_view_id TEXT,
ADD COLUMN IF NOT EXISTS intro_view_id TEXT,
ADD COLUMN IF NOT EXISTS device TEXT,
ADD COLUMN IF NOT EXISTS page_path TEXT,
ADD COLUMN IF NOT EXISTS is_first_time BOOLEAN,
ADD COLUMN IF NOT EXISTS widget_version TEXT,
ADD COLUMN IF NOT EXISTS event_data JSONB,
ADD COLUMN IF NOT EXISTS url TEXT;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 4: Purchase tracking tables & views (from 20260407 migration)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS product_view_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_slug  TEXT        NOT NULL,
  session_id  TEXT        NOT NULL,
  product_id  TEXT,
  variant_id  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_view_events_store
  ON product_view_events (store_slug, created_at);

CREATE INDEX IF NOT EXISTS idx_product_view_events_session
  ON product_view_events (session_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_product_view_session_product'
  ) THEN
    ALTER TABLE product_view_events
      ADD CONSTRAINT uq_product_view_session_product UNIQUE (session_id, product_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS purchase_events (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  store_slug  TEXT         NOT NULL,
  session_id  TEXT         NOT NULL,
  order_id    TEXT,
  total_price NUMERIC(10, 2),
  currency    TEXT,
  line_items  JSONB        NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchase_events_store
  ON purchase_events (store_slug, created_at);

CREATE INDEX IF NOT EXISTS idx_purchase_events_session
  ON purchase_events (session_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 5: RPC Functions (drop all overloads then recreate)
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── record_tryon_event ──────────────────────────────────────────────────────

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

-- ── record_widget_event (with extended params from 20260318) ────────────────

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
  p_event_name TEXT DEFAULT 'generic',
  p_event_type TEXT DEFAULT 'generic',
  p_store_id TEXT DEFAULT NULL,
  p_session_id TEXT DEFAULT NULL,
  p_widget_view_id TEXT DEFAULT NULL,
  p_intro_view_id TEXT DEFAULT NULL,
  p_device TEXT DEFAULT NULL,
  p_page_path TEXT DEFAULT NULL,
  p_is_first_time BOOLEAN DEFAULT NULL,
  p_widget_version TEXT DEFAULT NULL,
  p_event_data JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.widget_events (
    store_slug, event_type, store_id, session_id,
    widget_view_id, intro_view_id, device, page_path,
    is_first_time, widget_version, event_data
  ) VALUES (
    p_store_slug, COALESCE(p_event_name, p_event_type, 'generic'), p_store_id, p_session_id,
    p_widget_view_id, p_intro_view_id, p_device, p_page_path,
    p_is_first_time, p_widget_version, p_event_data
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ── record_widget_open (with extended params from 20260318) ─────────────────

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
  p_session_id TEXT DEFAULT NULL,
  p_device TEXT DEFAULT NULL,
  p_url TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.widget_events (store_slug, event_type, session_id, device, url)
  VALUES (p_store_slug, 'widget_open', p_session_id, p_device, p_url);

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ── record_cart_event ───────────────────────────────────────────────────────

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

-- ── get_store_usage ─────────────────────────────────────────────────────────

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

  SELECT p.name, p.included_tryons_per_month
  INTO v_plan_name, v_included_tryons
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

-- ── record_product_view_event (from 20260407) ──────────────────────────────

CREATE OR REPLACE FUNCTION record_product_view_event(
  p_store_slug TEXT,
  p_session_id TEXT,
  p_product_id TEXT DEFAULT NULL,
  p_variant_id TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO product_view_events (store_slug, session_id, product_id, variant_id)
  VALUES (p_store_slug, p_session_id, p_product_id, p_variant_id)
  ON CONFLICT (session_id, product_id) DO NOTHING;
  RETURN '{"success": true}'::JSONB;
END;
$$;

-- ── record_purchase_event (from 20260407) ──────────────────────────────────

CREATE OR REPLACE FUNCTION record_purchase_event(
  p_store_slug  TEXT,
  p_session_id  TEXT,
  p_order_id    TEXT    DEFAULT NULL,
  p_total_price NUMERIC DEFAULT NULL,
  p_currency    TEXT    DEFAULT NULL,
  p_line_items  TEXT    DEFAULT '[]'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO purchase_events (store_slug, session_id, order_id, total_price, currency, line_items)
  VALUES (p_store_slug, p_session_id, p_order_id, p_total_price, p_currency, p_line_items::JSONB);
  RETURN '{"success": true}'::JSONB;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 6: Views (from 20260407)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW vto_attributed_purchases AS
SELECT
  t.store_slug,
  t.session_id,
  t.product_id                                              AS tried_on_product,
  pe.order_id,
  pe.total_price,
  pe.currency,
  pe.created_at                                             AS purchased_at,
  t.created_at                                              AS tried_on_at,
  EXTRACT(EPOCH FROM (pe.created_at - t.created_at))       AS seconds_to_purchase
FROM tryon_events t
JOIN purchase_events pe
  ON  pe.session_id  = t.session_id
  AND pe.store_slug  = t.store_slug
  AND pe.created_at  > t.created_at
  AND pe.line_items @> jsonb_build_array(
        jsonb_build_object('product_id', t.product_id)
      );

CREATE OR REPLACE VIEW vto_conversion_summary AS
SELECT
  t.store_slug,
  COUNT(DISTINCT t.session_id)  AS tryon_sessions,
  COUNT(DISTINCT v.session_id)  AS sessions_viewed_product,
  COUNT(DISTINCT c.session_id)  AS sessions_added_to_cart,
  COUNT(DISTINCT ap.session_id) AS sessions_purchased,
  ROUND(
    100.0 * COUNT(DISTINCT ap.session_id)
      / NULLIF(COUNT(DISTINCT t.session_id), 0),
    2
  )                             AS purchase_conversion_pct
FROM tryon_events t
LEFT JOIN product_view_events v
  ON  v.session_id = t.session_id
  AND v.store_slug = t.store_slug
  AND v.product_id = t.product_id
  AND v.created_at > t.created_at
LEFT JOIN cart_events c
  ON  c.session_id = t.session_id
  AND c.store_slug = t.store_slug
  AND c.product_id = t.product_id
  AND c.created_at > t.created_at
LEFT JOIN vto_attributed_purchases ap
  ON  ap.session_id = t.session_id
  AND ap.store_slug = t.store_slug
GROUP BY t.store_slug;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 7: RLS policies + grants
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.tryon_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cart_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_view_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_events ENABLE ROW LEVEL SECURITY;

-- Service role full access
DROP POLICY IF EXISTS "Service role full access on tryon_events" ON public.tryon_events;
CREATE POLICY "Service role full access on tryon_events"
  ON public.tryon_events TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on widget_events" ON public.widget_events;
CREATE POLICY "Service role full access on widget_events"
  ON public.widget_events TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on cart_events" ON public.cart_events;
CREATE POLICY "Service role full access on cart_events"
  ON public.cart_events TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on product_view_events" ON public.product_view_events;
CREATE POLICY "Service role full access on product_view_events"
  ON public.product_view_events TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on purchase_events" ON public.purchase_events;
CREATE POLICY "Service role full access on purchase_events"
  ON public.purchase_events TO service_role USING (true) WITH CHECK (true);

-- Anon insert policies (widget calls RPCs with anon key; SECURITY DEFINER bypasses
-- RLS but direct REST inserts need the policy)
DROP POLICY IF EXISTS "Anon insert on tryon_events" ON public.tryon_events;
CREATE POLICY "Anon insert on tryon_events"
  ON public.tryon_events FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS "Anon insert on widget_events" ON public.widget_events;
CREATE POLICY "Anon insert on widget_events"
  ON public.widget_events FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS "Anon insert on cart_events" ON public.cart_events;
CREATE POLICY "Anon insert on cart_events"
  ON public.cart_events FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS "Anon insert on product_view_events" ON public.product_view_events;
CREATE POLICY "Anon insert on product_view_events"
  ON public.product_view_events FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS "Anon insert on purchase_events" ON public.purchase_events;
CREATE POLICY "Anon insert on purchase_events"
  ON public.purchase_events FOR INSERT TO anon WITH CHECK (true);

-- Anon select on vto_stores (widget fetches config with anon key)
DROP POLICY IF EXISTS "Anon read vto_stores" ON public.vto_stores;
CREATE POLICY "Anon read vto_stores"
  ON public.vto_stores FOR SELECT TO anon USING (true);

-- Anon read on vto_plans (widget may need plan info)
DROP POLICY IF EXISTS "Anon read vto_plans" ON public.vto_plans;
CREATE POLICY "Anon read vto_plans"
  ON public.vto_plans FOR SELECT TO anon USING (true);

-- Grant execute on all RPC functions to anon (widget uses anon key)
GRANT EXECUTE ON FUNCTION public.record_tryon_event(TEXT, BOOLEAN, TEXT, TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.record_widget_event(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, JSONB) TO anon;
GRANT EXECUTE ON FUNCTION public.record_widget_open(TEXT, TEXT, TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.record_cart_event(TEXT, TEXT, TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.get_store_usage(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.record_product_view_event(TEXT, TEXT, TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.record_purchase_event(TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT) TO anon;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 8: Clean up any bad manual data & let afterAuth re-provision correctly
-- ═══════════════════════════════════════════════════════════════════════════════

-- Delete manually-inserted data for ello-dev-store that may have wrong slug format.
-- afterAuth will recreate everything correctly once the schema is fixed.
-- Comment these out if you want to keep existing manual data.
DELETE FROM public.vto_usage_periods
WHERE account_id IN (
  SELECT id FROM public.vto_accounts WHERE shopify_shop_domain = 'ello-dev-store.myshopify.com'
);

DELETE FROM public.vto_subscriptions
WHERE account_id IN (
  SELECT id FROM public.vto_accounts WHERE shopify_shop_domain = 'ello-dev-store.myshopify.com'
);

DELETE FROM public.vto_stores
WHERE account_id IN (
  SELECT id FROM public.vto_accounts WHERE shopify_shop_domain = 'ello-dev-store.myshopify.com'
);

DELETE FROM public.vto_accounts
WHERE shopify_shop_domain = 'ello-dev-store.myshopify.com';

-- Force PostgREST to pick up schema changes
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- DONE. Next steps:
-- 1. Reinstall the app on ello-dev-store (or open it to trigger afterAuth)
-- 2. afterAuth will call syncShopifyMerchantToSupabase() which creates:
--    - vto_accounts row (shopify_shop_domain = 'ello-dev-store.myshopify.com')
--    - vto_stores row (store_slug = 'ello-dev-store', shop_domain = 'ello-dev-store.myshopify.com')
--    - vto_subscriptions row (developer_free plan)
--    - vto_usage_periods row
-- 3. Widget will fetch config by shop_domain → get correct store_slug → VTO works
-- ============================================================================
