/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  // ✅ Custom auth header (avoid Supabase JWT parsing issues)
  const provided = req.headers.get("x-outreach-cron-token") || "";
  const expected = Deno.env.get("OUTREACH_CRON_TOKEN") || "";

  if (!expected) {
    return json(500, { ok: false, error: "Missing OUTREACH_CRON_TOKEN secret" });
  }
  if (provided !== expected) {
    return json(401, { ok: false, error: "Unauthorized" });
  }

  // ✅ Supabase injected env vars (you do NOT set these manually)
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const nowIso = new Date().toISOString();

  // ✅ Read-only test query: pull up to 10 due outreach contacts
  const { data, error } = await supabase
    .from("outreach_contacts")
    .select("id, program_id, need_id, preceptor_id, status, step_number, next_scheduled_at, automation_paused, replied")
    .lte("next_scheduled_at", nowIso)
    .eq("automation_paused", false)
    .eq("replied", false)
    .limit(10);

  if (error) {
    return json(500, { ok: false, error: error.message });
  }

  return json(200, {
    ok: true,
    now: nowIso,
    checked: data?.length ?? 0,
    rows: data ?? [],
  });
});

