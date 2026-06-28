import type { ActionFunctionArgs } from "react-router";
import { supabaseAdmin } from "../lib/supabase.server";

// Telemetry sink for App Bridge Web Vitals (see components/web-vitals.tsx).
// Anonymous on purpose — it's fire-and-forget RUM from the embedded admin and
// must stay cheap. Always returns 204 so a failed insert never surfaces an
// error in the merchant's app.

const METRICS = new Set(["LCP", "CLS", "INP", "FCP", "TTFB"]);

function noContent() {
  return new Response(null, { status: 204 });
}

export async function loader() {
  return new Response(null, { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  // No DB configured (e.g. local dev) → console logging still works client-side.
  if (!process.env.SUPABASE_URL) return noContent();

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return noContent();
  }

  const metric = String(body.name ?? "");
  const value = Number(body.value);
  if (!METRICS.has(metric) || !Number.isFinite(value)) return noContent();

  const row = {
    metric,
    // Clamp to a sane range (0–600s) so a bad sample can't skew aggregates.
    value: Math.max(0, Math.min(value, 600_000)),
    path: body.path ? String(body.path).slice(0, 200) : null,
    shop_domain: body.shop ? String(body.shop).slice(0, 255) : null,
    metric_id: body.id ? String(body.id).slice(0, 100) : null,
  };

  // Best-effort. If the table doesn't exist yet, Supabase returns an error
  // (it doesn't throw) — log and move on so the app is unaffected. Run
  // supabase/migrations/20260613_web_vitals.sql to enable storage.
  const { error } = await supabaseAdmin.from("vto_web_vitals").insert(row);
  if (error) {
    console.error("[web-vitals] insert skipped (non-fatal):", error.message);
  }
  return noContent();
}
