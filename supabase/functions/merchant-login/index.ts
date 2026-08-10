// merchant-login — exchange a validated store_slug + owner_email pair for a REAL
// Supabase Auth session, so the external dashboard's merchant pages run as the
// `authenticated` role (which kept its analytics grants through the 2026-07
// lockdown) instead of `anon` (which correctly has none).
//
// Flow: validate pair via merchant_dashboard_login (SECURITY DEFINER, returns null
// unless BOTH match) -> ensure an auth user exists for the owner email -> refuse
// admin accounts on this path -> stamp the store slug into app_metadata (for
// future per-store RPC hardening) -> mint a one-time magiclink token the client
// redeems with verifyOtp() for a session.
//
// Deployed with --no-verify-jwt: this endpoint IS the login, callers are
// unauthenticated by definition. Uses SB_SERVICE_ROLE_KEY (the sb_secret_ key;
// the auto-injected SUPABASE_SERVICE_ROLE_KEY is the disabled legacy JWT).

import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SB_URL")!;
const SB_SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY")!;

const admin = createClient(SB_URL, SB_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const { store_slug, owner_email } = await req.json();
    if (!store_slug || !owner_email) return json({ error: "Missing credentials" }, 400);

    // 1. Validate the credential pair. Null result = no info leaked about why.
    const { data: storeAuth, error: rpcErr } = await admin.rpc("merchant_dashboard_login", {
      p_store_slug: String(store_slug),
      p_owner_email: String(owner_email),
    });
    if (rpcErr) {
      console.error("[merchant-login] validation RPC failed:", rpcErr.message);
      return json({ error: "Login failed" }, 500);
    }
    if (!storeAuth) return json({ error: "Invalid credentials" }, 401);

    const email = String(storeAuth.ownerEmail).toLowerCase();
    const slug = String(storeAuth.storeSlug);

    // 2. Ensure an auth user exists for this merchant email.
    let userId: string | null = null;
    let existingMeta: Record<string, unknown> = {};
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      app_metadata: { merchant: true, store_slugs: [slug] },
    });
    if (!createErr && created?.user) {
      userId = created.user.id;
    } else {
      // Already registered — look the user up.
      const { data: list, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (listErr) {
        console.error("[merchant-login] listUsers failed:", listErr.message);
        return json({ error: "Login failed" }, 500);
      }
      const found = list.users.find((u) => (u.email ?? "").toLowerCase() === email);
      if (!found) {
        console.error("[merchant-login] createUser failed and user not found:", createErr?.message);
        return json({ error: "Login failed" }, 500);
      }
      userId = found.id;
      existingMeta = (found.app_metadata ?? {}) as Record<string, unknown>;

      // 3. NEVER mint merchant sessions for admin users via this passwordless path.
      const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", userId).limit(1);
      if (roles && roles.length > 0) {
        return json({ error: "This email requires the admin login" }, 403);
      }

      // 4. Record the store slug for future per-store authorization hardening.
      const slugs = new Set<string>(Array.isArray(existingMeta.store_slugs) ? existingMeta.store_slugs as string[] : []);
      if (!slugs.has(slug)) {
        slugs.add(slug);
        await admin.auth.admin.updateUserById(userId, {
          app_metadata: { ...existingMeta, merchant: true, store_slugs: [...slugs] },
        });
      }
    }

    // 5. Mint a one-time token the client redeems for a session.
    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email });
    const tokenHash = link?.properties?.hashed_token;
    if (linkErr || !tokenHash) {
      console.error("[merchant-login] generateLink failed:", linkErr?.message);
      return json({ error: "Login failed" }, 500);
    }

    return json({ storeAuth, token_hash: tokenHash });
  } catch (e) {
    console.error("[merchant-login] unexpected:", e instanceof Error ? e.message : String(e));
    return json({ error: "Login failed" }, 400);
  }
});
