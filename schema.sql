-- Shopify App Token Sync Schema
-- Run this in your Supabase SQL Editor

-- 1. Ensure shopify_app schema exists for isolation
CREATE SCHEMA IF NOT EXISTS shopify_app;

-- 2. Storefront Tokens Table (Isolated)
CREATE TABLE IF NOT EXISTS shopify_app.storefront_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop VARCHAR(255) NOT NULL UNIQUE,
    storefront_access_token VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for fast lookups by shop
CREATE INDEX IF NOT EXISTS idx_storefront_tokens_shop ON shopify_app.storefront_tokens(shop);

-- 3. Update vto_stores with Sync Metadata
-- Add columns to track sync status directly on the store record
ALTER TABLE public.vto_stores 
ADD COLUMN IF NOT EXISTS sync_status VARCHAR(50) DEFAULT 'pending', -- 'connected', 'syncing', 'synced', 'failed'
ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS sync_request_id UUID,
ADD COLUMN IF NOT EXISTS sync_attempts INT DEFAULT 0,
ADD COLUMN IF NOT EXISTS sync_error TEXT;

-- 4. RLS Policies (If RLS is enabled, ensure service role can access)
ALTER TABLE shopify_app.storefront_tokens ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role full access on storefront_tokens"
ON shopify_app.storefront_tokens
TO service_role
USING (true)
WITH CHECK (true);

-- Grant usage on schema to service role (usually default, but good to be explicit)
GRANT USAGE ON SCHEMA shopify_app TO service_role;
GRANT ALL ON shopify_app.storefront_tokens TO service_role;

-- 5. Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION shopify_app.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_storefront_tokens_updated_at
BEFORE UPDATE ON shopify_app.storefront_tokens
FOR EACH ROW
EXECUTE PROCEDURE shopify_app.update_updated_at_column();
