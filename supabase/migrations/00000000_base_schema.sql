-- ============================================================================
-- Base Schema — Run this FIRST on any new Supabase project (staging or prod).
-- Creates all core tables, indexes, RLS policies, and seeds vto_plans.
-- After this: run migrations in order (20260304, 20260318, 20260407).
-- ============================================================================

-- ─── Sessions (Shopify App Bridge session storage) ───────────────────────────

CREATE TABLE IF NOT EXISTS shopify_sessions (
  id           TEXT        PRIMARY KEY,
  shop         TEXT        NOT NULL,
  state        TEXT        NOT NULL,
  is_online    BOOLEAN     NOT NULL DEFAULT FALSE,
  scope        TEXT,
  expires      TIMESTAMPTZ,
  access_token TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shopify_sessions_shop ON shopify_sessions(shop);

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_shopify_sessions_updated_at ON shopify_sessions;
CREATE TRIGGER update_shopify_sessions_updated_at
  BEFORE UPDATE ON shopify_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── vto_accounts ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.vto_accounts (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT        NOT NULL,
  type                  TEXT        NOT NULL,
  owner_email           TEXT        NOT NULL,
  stripe_customer_id    TEXT        UNIQUE,
  billing_email         TEXT,
  store_slug            TEXT        UNIQUE,
  shopify_shop_domain   TEXT        UNIQUE,
  billing_source        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── vto_plans ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.vto_plans (
  id                          UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  code                        TEXT           NOT NULL UNIQUE,
  name                        TEXT           NOT NULL,
  monthly_price               NUMERIC(10, 2) NOT NULL,
  annual_price                NUMERIC(10, 2) NOT NULL,
  included_tryons_per_month   INT            NOT NULL,
  overage_usd_per_tryon       NUMERIC(10, 4) NOT NULL DEFAULT 0.15,
  stripe_price_id             TEXT           UNIQUE,
  overage_stripe_price_id     TEXT,
  created_at                  TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vto_plans_stripe_price_id ON public.vto_plans(stripe_price_id);

-- Seed plan rows with the exact UUIDs the app hardcodes in shopify-billing.server.ts.
-- ON CONFLICT DO NOTHING makes this safe to re-run.
INSERT INTO public.vto_plans (id, code, name, monthly_price, annual_price, included_tryons_per_month, overage_usd_per_tryon) VALUES
  ('00000000-0000-0000-0000-000000000000', 'custom_distribution',     'Custom Plan',       0,        0,         500,   0.15),
  ('a7d8292a-b720-418c-9de7-70191bc9969d', 'developer_free',          'Developer Free',    0,        0,         9999,  0.00),
  ('acf413dc-bcb0-484a-b914-2d6f6491eb39', 'starter',                 'Ello Starter',      49,       529.20,    75,    0.15),
  ('75fa2215-7008-4242-aef5-40aa2b278968', 'launch',                  'Ello Launch',       97,       1047.60,   300,   0.15),
  ('48ce4579-3523-45e1-9cc5-7f2bb0134073', 'growth',                  'Ello Growth',       249,      2689.20,   1500,  0.15),
  ('6c203206-7f01-4ca2-b1f2-fabda7a6306f', 'scale',                   'Ello Scale',        649,      7009.20,   5000,  0.15),
  ('f5bc29c9-e69d-4e46-8442-5d8adb66e11e', 'enterprise',              'Ello Enterprise',   0,        0,         0,     0.15)
ON CONFLICT (id) DO NOTHING;

-- ─── vto_stores ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.vto_stores (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id               UUID        NOT NULL REFERENCES public.vto_accounts(id) ON DELETE CASCADE,
  store_slug               TEXT        NOT NULL UNIQUE,
  store_name               TEXT        NOT NULL,
  shop_domain              TEXT,
  storefront_token         TEXT,
  clothing_population_type TEXT        NOT NULL DEFAULT 'shopify',
  minimized_color          TEXT        NOT NULL DEFAULT '#000000',
  featured_item_id         TEXT,
  quick_picks_ids          TEXT[]      NOT NULL DEFAULT '{}',
  widget_primary_color     TEXT        DEFAULT '#111827',
  widget_accent_color      TEXT        DEFAULT '#6EE7B7',
  widget_enabled           BOOLEAN     DEFAULT true,
  block_overage            BOOLEAN     NOT NULL DEFAULT true,
  overage_auto_topup       BOOLEAN     DEFAULT false,
  overage_cap_credits      INT         DEFAULT 100,
  overage_trigger_threshold INT        DEFAULT 50,
  overage_credits_used     INT         DEFAULT 0,
  desktop_preview_enabled  BOOLEAN     DEFAULT true,
  preview_delay_seconds    INT         NOT NULL DEFAULT 3,
  preview_theme            TEXT        DEFAULT 'light',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vto_stores_account      ON public.vto_stores(account_id);
CREATE INDEX IF NOT EXISTS idx_vto_stores_store_slug   ON public.vto_stores(store_slug);
CREATE INDEX IF NOT EXISTS idx_vto_stores_widget_enabled ON public.vto_stores(widget_enabled);

-- ─── vto_subscriptions ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.vto_subscriptions (
  id                              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                      UUID        NOT NULL REFERENCES public.vto_accounts(id) ON DELETE CASCADE,
  plan_id                         UUID        NOT NULL REFERENCES public.vto_plans(id),
  previous_plan_id                UUID        REFERENCES public.vto_plans(id),
  stripe_subscription_id          TEXT        UNIQUE,
  shopify_subscription_id         TEXT        UNIQUE,
  shopify_usage_line_item_id      TEXT,
  billing_source                  TEXT,
  billing_interval                TEXT        NOT NULL,
  status                          TEXT        NOT NULL DEFAULT 'active',
  current_period_start            TIMESTAMPTZ NOT NULL,
  current_period_end              TIMESTAMPTZ NOT NULL,
  stripe_price_id                 TEXT,
  stripe_status                   TEXT,
  stripe_overage_item_id          TEXT,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vto_subscriptions_account         ON public.vto_subscriptions(account_id);
CREATE INDEX IF NOT EXISTS idx_vto_subscriptions_stripe_sub_id   ON public.vto_subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_vto_subscriptions_overage_item    ON public.vto_subscriptions(stripe_overage_item_id);

-- ─── vto_usage_periods ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.vto_usage_periods (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             UUID        NOT NULL REFERENCES public.vto_accounts(id) ON DELETE CASCADE,
  subscription_id        UUID        NOT NULL REFERENCES public.vto_subscriptions(id) ON DELETE CASCADE,
  period_start           TIMESTAMPTZ NOT NULL,
  period_end             TIMESTAMPTZ NOT NULL,
  tryons_used            INT         NOT NULL DEFAULT 0,
  overage_quantity       INT         DEFAULT 0,
  overage_billed         BOOLEAN     NOT NULL DEFAULT false,
  stripe_usage_record_id TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT vto_usage_periods_subscription_period_unique UNIQUE (subscription_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_vto_usage_periods_subscription  ON public.vto_usage_periods(subscription_id, period_start);
CREATE INDEX IF NOT EXISTS idx_vto_usage_periods_account_period ON public.vto_usage_periods(account_id, period_start, period_end);

-- ─── vto_tryon_events ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.vto_tryon_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID        REFERENCES public.vto_accounts(id) ON DELETE CASCADE,
  subscription_id UUID        REFERENCES public.vto_subscriptions(id),
  store_id        UUID        NOT NULL REFERENCES public.vto_stores(id) ON DELETE CASCADE,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  success         BOOLEAN     NOT NULL,
  product_id      TEXT,
  variant_id      TEXT,
  session_id      TEXT,
  ip_address      TEXT
);

CREATE INDEX IF NOT EXISTS idx_tryon_events_rate_limit          ON public.vto_tryon_events(store_id, ip_address, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_tryon_events_rate_limit_session  ON public.vto_tryon_events(store_id, session_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_vto_tryon_events_account_time    ON public.vto_tryon_events(account_id, occurred_at);

-- ─── vto_cart_events ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.vto_cart_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID        REFERENCES public.vto_accounts(id),
  subscription_id UUID        REFERENCES public.vto_subscriptions(id),
  store_id        UUID        NOT NULL REFERENCES public.vto_stores(id),
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  product_id      TEXT,
  variant_id      TEXT,
  session_id      TEXT,
  ip_address      TEXT,
  tryon_event_id  UUID        REFERENCES public.vto_tryon_events(id),
  quantity        INT         NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_vto_cart_events_session         ON public.vto_cart_events(session_id);
CREATE INDEX IF NOT EXISTS idx_vto_cart_events_store_occurred  ON public.vto_cart_events(store_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_vto_cart_events_tryon           ON public.vto_cart_events(tryon_event_id);

-- ─── vto_preview_events ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.vto_preview_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    UUID        REFERENCES public.vto_stores(id) ON DELETE CASCADE,
  session_id  TEXT,
  event_name  TEXT        NOT NULL,
  occurred_at TIMESTAMPTZ DEFAULT NOW(),
  metadata    JSONB       DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_vto_preview_events_store       ON public.vto_preview_events(store_id);
CREATE INDEX IF NOT EXISTS idx_vto_preview_events_occurred_at ON public.vto_preview_events(occurred_at);

-- ─── Storefront token sync (shopify_app schema) ───────────────────────────────

CREATE SCHEMA IF NOT EXISTS shopify_app;

CREATE TABLE IF NOT EXISTS shopify_app.storefront_tokens (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop                    VARCHAR(255) NOT NULL UNIQUE,
  storefront_access_token VARCHAR(255) NOT NULL,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_storefront_tokens_shop ON shopify_app.storefront_tokens(shop);

ALTER TABLE shopify_app.storefront_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on storefront_tokens" ON shopify_app.storefront_tokens;
CREATE POLICY "Service role full access on storefront_tokens"
  ON shopify_app.storefront_tokens TO service_role
  USING (true) WITH CHECK (true);

GRANT USAGE ON SCHEMA shopify_app TO service_role;
GRANT ALL ON shopify_app.storefront_tokens TO service_role;

CREATE OR REPLACE FUNCTION shopify_app.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_storefront_tokens_updated_at ON shopify_app.storefront_tokens;
CREATE TRIGGER update_storefront_tokens_updated_at
  BEFORE UPDATE ON shopify_app.storefront_tokens
  FOR EACH ROW EXECUTE PROCEDURE shopify_app.update_updated_at_column();

-- ─── RLS: enable on core tables (service role gets full access via SECURITY DEFINER RPCs) ──

ALTER TABLE public.vto_accounts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vto_plans        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vto_stores       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vto_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vto_usage_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vto_tryon_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vto_cart_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vto_preview_events ENABLE ROW LEVEL SECURITY;

-- Service role full access on all tables
DO $$
DECLARE tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'vto_accounts','vto_plans','vto_stores','vto_subscriptions',
    'vto_usage_periods','vto_tryon_events','vto_cart_events','vto_preview_events'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Service role full access" ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY "Service role full access" ON public.%I TO service_role USING (true) WITH CHECK (true)',
      tbl
    );
  END LOOP;
END $$;

-- vto_plans readable by anon (widget needs to look up plan limits indirectly via RPCs)
DROP POLICY IF EXISTS "Anon read vto_plans" ON public.vto_plans;
CREATE POLICY "Anon read vto_plans" ON public.vto_plans FOR SELECT TO anon USING (true);
