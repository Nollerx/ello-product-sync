-- Live theme-status cache for the storefront widget.
--
-- Until now the admin Dashboard trusted `vto_stores.widget_enabled` (a flag set
-- true at install/billing, false only at uninstall) to decide whether the
-- widget was "enabled on the storefront" — so it stayed green even after a
-- merchant toggled the app embed OFF in their theme editor.
--
-- The app now reads the merchant's PUBLISHED theme via the GraphQL Admin API
-- (themes(roles:[MAIN]) -> OnlineStoreTheme.files) to get the real state. These
-- columns cache the latest read so onboarding/billing surfaces can render the
-- last-known status instantly without a live theme call on every page.
--
-- NOTE: `widget_enabled` is left untouched — it remains the merchant's master
-- on/off toggle (see app/routes/app.widget-design.tsx). These columns are the
-- separate theme-truth signal.

ALTER TABLE vto_stores
  ADD COLUMN IF NOT EXISTS app_embed_enabled        boolean,
  ADD COLUMN IF NOT EXISTS inline_button_added      boolean,
  ADD COLUMN IF NOT EXISTS theme_status_checked_at  timestamptz,
  ADD COLUMN IF NOT EXISTS theme_status_reason      text;

COMMENT ON COLUMN vto_stores.app_embed_enabled IS
  'Live theme read: floating-widget app embed present in settings_data.json and not disabled. NULL = not yet checked / could not determine.';
COMMENT ON COLUMN vto_stores.inline_button_added IS
  'Live theme read: inline Try-On app block present in a product template JSON. NULL = not checked / vintage .liquid template (undetectable).';
COMMENT ON COLUMN vto_stores.theme_status_checked_at IS
  'When the live theme status was last successfully read.';
COMMENT ON COLUMN vto_stores.theme_status_reason IS
  'Outcome of the last theme read: ok | missing_scope | no_published_theme | graphql_error | no_json_product_template.';
