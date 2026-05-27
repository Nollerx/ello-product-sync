-- Allow the onboarding flow to pause on the placements step before billing.
-- Run manually in Supabase SQL editor before deploying the app code that
-- writes onboarding_step = 'placements'.

ALTER TABLE vto_stores
  DROP CONSTRAINT IF EXISTS vto_stores_onboarding_step_check;

ALTER TABLE vto_stores
  ADD CONSTRAINT vto_stores_onboarding_step_check
  CHECK (onboarding_step IN ('welcome','activate_widget','configure','placements','billing','complete'));
