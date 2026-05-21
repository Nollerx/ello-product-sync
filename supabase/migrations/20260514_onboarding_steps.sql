-- Onboarding flow state on vto_stores.
-- Run manually in Supabase SQL editor (already executed on prod 2026-05-14).

ALTER TABLE vto_stores
  ADD COLUMN IF NOT EXISTS onboarding_step text NOT NULL DEFAULT 'welcome'
    CHECK (onboarding_step IN ('welcome','activate_widget','configure','billing','complete')),
  ADD COLUMN IF NOT EXISTS onboarding_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS widget_enabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;

-- Existing merchants (incl. Marcos / custom app) skip the new onboarding flow.
UPDATE vto_stores
  SET onboarding_step = 'complete',
      onboarding_completed_at = COALESCE(onboarding_completed_at, now())
  WHERE onboarding_step = 'welcome';
