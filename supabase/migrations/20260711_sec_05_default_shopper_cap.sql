-- Applied live via Supabase MCP on 2026-07-11. Committed for repo parity. Idempotent.
--
-- The per-shopper abuse cap existed but defaulted OFF, leaving /tryon an
-- unauthenticated $0.067/request faucet on new installs. Default it ON for NEW
-- installs (existing merchants intentionally left unchanged). The un-spoofable IP
-- fix (last X-Forwarded-For hop) shipped in app/routes/tryon.tsx.

ALTER TABLE public.vto_stores ALTER COLUMN shopper_limit_enabled SET DEFAULT true;
