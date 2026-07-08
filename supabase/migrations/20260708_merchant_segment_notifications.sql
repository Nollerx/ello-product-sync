-- Enterprise routing + install notifications (2026-07-08).
-- Already applied to production via Supabase MCP; kept here for the record.

-- Which size bucket the merchant picked in onboarding ('small' | 'mid' |
-- 'enterprise'), the shop's Shopify plan (Plus = enterprise signal), and
-- send-once markers for the Telegram install alert / 2h follow-up.
ALTER TABLE vto_stores
  ADD COLUMN IF NOT EXISTS merchant_segment text,
  ADD COLUMN IF NOT EXISTS shopify_plan text,
  ADD COLUMN IF NOT EXISTS install_alert_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS install_followup_sent_at timestamptz;

-- New onboarding steps: 'segment' (store-size question, after welcome) and
-- 'enterprise' ($1M+/yr branch that steers to a setup call).
ALTER TABLE vto_stores
  DROP CONSTRAINT IF EXISTS vto_stores_onboarding_step_check;

ALTER TABLE vto_stores
  ADD CONSTRAINT vto_stores_onboarding_step_check
  CHECK (onboarding_step IN ('welcome','segment','enterprise','activate_widget','configure','placements','billing','complete'));
