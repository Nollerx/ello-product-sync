-- 20260606_lead_capture.sql
--
-- Email lead capture: a one-time, dismissible email prompt shown by the widget
-- after a shopper's Nth successful try-on. Captured emails land in vto_leads.
--
--   • vto_leads                     → captured emails (service-role writes only)
--   • vto_stores.lead_capture_*     → per-store config (OFF by default)
--   • get_widget_config             → returns the two config fields to the widget
--
-- Safety: purely additive. lead_capture_enabled defaults FALSE, so no widget
-- behavior changes for any existing store (including Marcos / Kaizen) until a
-- merchant turns it on from the Leads page. No trigger change (these settings
-- propagate on the widget's next bootstrap), which keeps this migration
-- independent of run order vs. 20260606_tryon_product_targeting.sql.

BEGIN;

-- ─── 1. Leads table ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vto_leads (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_slug  TEXT        NOT NULL,
  email       TEXT        NOT NULL,
  session_id  TEXT,
  product_id  TEXT,
  source      TEXT        NOT NULL DEFAULT 'widget',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (store, email). The capture endpoint lowercases email before
-- writing, so this also dedupes case variants. Enables ON CONFLICT upserts.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vto_leads_store_email
  ON public.vto_leads (store_slug, email);

CREATE INDEX IF NOT EXISTS idx_vto_leads_store_created
  ON public.vto_leads (store_slug, created_at DESC);

-- Writes go through the app's /api/capture-lead route (service role), never the
-- anon client, so RLS stays closed by default.
ALTER TABLE public.vto_leads ENABLE ROW LEVEL SECURITY;

-- ─── 2. Per-store config columns ────────────────────────────────────────────
ALTER TABLE public.vto_stores
  ADD COLUMN IF NOT EXISTS lead_capture_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS lead_capture_after_n INT     NOT NULL DEFAULT 1;

-- ─── 3. Expose config to the widget via get_widget_config ───────────────────
-- Recreate with the current production columns (from 20260524_inline_tryon_button)
-- plus the two lead-capture fields. Order is irrelevant — the widget reads by
-- name from the JSON. DROP required because RETURNS TABLE shape changes.
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
  lead_capture_enabled            BOOLEAN,
  lead_capture_after_n            INT,
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
         s.lead_capture_enabled, s.lead_capture_after_n,
         s.config_version
    FROM vto_stores s
   WHERE (p_store_slug  IS NOT NULL AND s.store_slug  = p_store_slug)
      OR (p_shop_domain IS NOT NULL AND s.shop_domain = p_shop_domain)
   LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION get_widget_config(TEXT, TEXT) TO anon, authenticated, service_role;

-- Bump config_version on all rows so widgets re-fetch and pick up the new fields.
UPDATE public.vto_stores SET config_version = COALESCE(config_version, 0) + 1;

COMMIT;

NOTIFY pgrst, 'reload schema';
