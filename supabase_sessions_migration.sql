-- Shopify session storage table (replaces ephemeral SQLite in Cloud Run)
CREATE TABLE IF NOT EXISTS shopify_sessions (
  id           TEXT PRIMARY KEY,
  shop         TEXT NOT NULL,
  state        TEXT NOT NULL,
  is_online    BOOLEAN NOT NULL DEFAULT FALSE,
  scope        TEXT,
  expires      TIMESTAMPTZ,
  access_token TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shopify_sessions_shop ON shopify_sessions(shop);

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_shopify_sessions_updated_at
  BEFORE UPDATE ON shopify_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
