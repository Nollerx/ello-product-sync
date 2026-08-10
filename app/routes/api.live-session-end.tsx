import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabaseAdmin } from "../lib/supabase.server";

// Close-out beacon for Live Try-On sessions. Fired via navigator.sendBeacon on
// disconnect/close, so it must accept a bare text/plain JSON body (sendBeacon
// can't set headers). Metering only — enforcement is the token's server-side
// maxSessionDuration; a lost beacon just means the row keeps counting at its
// reserved cap (fail-closed).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

export async function loader({ request }: LoaderFunctionArgs) {
    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    return new Response("Method not allowed", { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
        const body = await request.json().catch(() => null);
        const liveSessionId = body?.liveSessionId || body?.live_session_id;
        const seconds = Number(body?.seconds);

        if (!liveSessionId || !UUID_RE.test(String(liveSessionId)) || !Number.isFinite(seconds)) {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        // Clamp to the reserved cap — the client can only report less spend than
        // reserved, never more (an inflated beacon can't grow the store's bill,
        // a deflated one only frees budget the shopper genuinely didn't use).
        const { data: row } = await supabaseAdmin
            .from("vto_live_sessions")
            .select("id, seconds_cap, ended_at")
            .eq("id", liveSessionId)
            .maybeSingle();

        if (row && !row.ended_at) {
            const clamped = Math.max(0, Math.min(Math.round(seconds), row.seconds_cap));
            await supabaseAdmin
                .from("vto_live_sessions")
                .update({ seconds_used: clamped, ended_at: new Date().toISOString() })
                .eq("id", row.id);
        }

        return new Response(null, { status: 204, headers: CORS_HEADERS });
    } catch (error) {
        console.error("[LiveSessionEnd] Error:", error);
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
}
