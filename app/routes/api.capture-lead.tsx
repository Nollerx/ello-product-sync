import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabaseAdmin } from "../lib/supabase.server";

// Public endpoint called by the storefront widget (cross-origin). Writes go
// through the service-role client here, never the anon client, so vto_leads RLS
// stays closed.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  return json(405, { error: "Method not allowed" });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const storeSlug = String(body.store_slug ?? body.storeSlug ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const sessionId = body.session_id ? String(body.session_id) : null;
  const productId = body.product_id ? String(body.product_id) : null;
  const source = body.source ? String(body.source).slice(0, 40) : "widget";

  if (!storeSlug) return json(400, { error: "Missing store_slug" });
  if (!EMAIL_RE.test(email) || email.length > 320) return json(400, { error: "Invalid email" });

  // Upsert so repeat submissions from the same shopper don't pile up rows.
  const { error } = await supabaseAdmin
    .from("vto_leads")
    .upsert(
      { store_slug: storeSlug, email, session_id: sessionId, product_id: productId, source },
      { onConflict: "store_slug,email", ignoreDuplicates: true },
    );

  if (error) {
    console.error("[capture-lead] insert error:", error.message);
    return json(500, { error: "Failed to save" });
  }
  return json(200, { ok: true });
}
