import { createClient } from "@supabase/supabase-js";

// Fallback to empty strings if env vars are missing during build/startup
// This prevents the container from crashing immediately if secrets aren't loaded yet
const SUPABASE_URL = process.env.SUPABASE_URL || "https://placeholder-url.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder-key";

// Server-only client (service role bypasses RLS)
export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  db: { schema: 'public' } // Default to public, but we can override in queries
});
