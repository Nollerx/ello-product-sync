import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabaseAdmin } from "../lib/supabase.server";

// Live Try-On (Decart realtime mirror) token mint.
//
// The widget is unauthenticated (storeSlug-only, same trust model as /tryon),
// so the permanent Decart key must never reach the browser. This route gates on
// the per-store flag + caps, reserves a metering row, and mints a short-lived
// Decart client token whose model, origin, and max session duration are
// embedded in the token itself — Decart enforces the duration server-side and
// kills the stream at the cap even if our client dies.
const DECART_API_URL = process.env.DECART_API_URL || "https://api.decart.ai";
const DECART_MODEL = "lucy-vton-3";
// Token only needs to outlive the connect handshake; expiry doesn't cut off an
// already-active session, so keep it tight.
const TOKEN_TTL_SECONDS = 120;
// Per-shopper live-session count per rolling day. Live is a premium moment,
// not a faucet — static try-on stays the workhorse. Env-tunable so dev/demo
// environments can run repeated sessions (a sales-demo day burns through 3
// fast); production default stays tight.
const SHOPPER_DAILY_LIVE_SESSIONS = Number(process.env.LIVE_SHOPPER_DAILY_SESSIONS || 3);

const SLUG_RE = /^[a-zA-Z0-9._-]{1,80}$/;

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

function json(status: number, body: Record<string, unknown>) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}

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

    if (!process.env.DECART_API_KEY) {
        return json(503, {
            error: "LIVE_NOT_CONFIGURED",
            message: "Live try-on isn't available right now.",
        });
    }

    try {
        const body = await request.json();
        const storeSlug = body.storeSlug || body.store_slug || "";
        const sessionId = body.sessionId || body.session_id || null;
        const productId = body.productId || body.product_id || null;
        const entrySource = typeof body.entrySource === "string" ? body.entrySource.slice(0, 40) : null;

        if (!SLUG_RE.test(storeSlug)) {
            return json(400, { error: "BAD_REQUEST", message: "Missing store." });
        }

        const { data: store, error: storeErr } = await supabaseAdmin
            .from("vto_stores")
            .select("store_slug, live_tryon_enabled, live_tryon_session_seconds, live_tryon_daily_seconds_cap")
            .eq("store_slug", storeSlug)
            .maybeSingle();

        if (storeErr) {
            console.error("[LiveToken] store lookup failed:", storeErr);
            return json(503, { error: "SERVICE_DEGRADED", message: "Please try again in a moment." });
        }
        // Server-enforced gate: the dashboard toggle is cosmetic without this.
        if (!store || !store.live_tryon_enabled) {
            return json(403, {
                error: "LIVE_TRYON_DISABLED",
                message: "Live try-on isn't enabled for this store.",
            });
        }

        const sessionSeconds = store.live_tryon_session_seconds || 60;
        const dailyCap = store.live_tryon_daily_seconds_cap || 900;
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

        // Store daily budget: unclosed sessions count at their full reserved cap
        // (fail-closed — mirrors Decart's own kill-at-cap behavior).
        const { data: recent, error: recentErr } = await supabaseAdmin
            .from("vto_live_sessions")
            .select("session_id, seconds_cap, seconds_used")
            .eq("store_slug", storeSlug)
            .gte("created_at", dayAgo)
            .limit(2000);

        if (recentErr) {
            console.error("[LiveToken] usage lookup failed:", recentErr);
            return json(503, { error: "SERVICE_DEGRADED", message: "Please try again in a moment." });
        }

        const spentSeconds = (recent || []).reduce(
            (sum, r) => sum + (r.seconds_used ?? r.seconds_cap ?? 0),
            0,
        );
        if (spentSeconds + sessionSeconds > dailyCap) {
            return json(429, {
                error: "LIVE_DAILY_CAP_REACHED",
                message: "The live mirror is resting. Try the photo try-on instead.",
            });
        }

        if (sessionId) {
            const shopperCount = (recent || []).filter((r) => r.session_id === sessionId).length;
            if (shopperCount >= SHOPPER_DAILY_LIVE_SESSIONS) {
                return json(429, {
                    error: "LIVE_SHOPPER_LIMITED",
                    message: "You've used today's live sessions. Photo try-on is still available.",
                });
            }
        }

        // Reserve the metering row before minting — same record-before-spend
        // ordering as /tryon.
        const { data: liveRow, error: insertErr } = await supabaseAdmin
            .from("vto_live_sessions")
            .insert({
                store_slug: storeSlug,
                session_id: sessionId,
                product_id: productId ? String(productId).slice(0, 80) : null,
                entry_source: entrySource,
                seconds_cap: sessionSeconds,
            })
            .select("id")
            .single();

        if (insertErr || !liveRow) {
            console.error("[LiveToken] session insert failed:", insertErr);
            return json(503, { error: "SERVICE_DEGRADED", message: "Please try again in a moment." });
        }

        // Scope the token to the calling page's origin when the browser sent one
        // (bookmarklet demos land on prospect origins, so this stays dynamic).
        const origin = request.headers.get("Origin");
        const mintBody: Record<string, unknown> = {
            expiresIn: TOKEN_TTL_SECONDS,
            allowedModels: [DECART_MODEL],
            constraints: { realtime: { maxSessionDuration: sessionSeconds } },
            metadata: { store: storeSlug, live_session: liveRow.id },
        };
        if (origin && /^https?:\/\//.test(origin)) {
            mintBody.allowedOrigins = [origin];
        }

        const mintRes = await fetch(`${DECART_API_URL}/v1/client/tokens`, {
            method: "POST",
            headers: {
                "x-api-key": process.env.DECART_API_KEY,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(mintBody),
            signal: AbortSignal.timeout(10_000),
        });

        if (!mintRes.ok) {
            const detail = await mintRes.text().catch(() => "");
            console.error(`[LiveToken] Decart mint failed (${mintRes.status}):`, detail.slice(0, 300));
            await supabaseAdmin
                .from("vto_live_sessions")
                .update({ seconds_used: 0, ended_at: new Date().toISOString() })
                .eq("id", liveRow.id);
            return json(502, {
                error: "LIVE_UNAVAILABLE",
                message: "The live mirror is busy. Please try again shortly.",
            });
        }

        const mint = await mintRes.json();
        return json(200, {
            token: mint.apiKey,
            model: DECART_MODEL,
            maxSeconds: sessionSeconds,
            liveSessionId: liveRow.id,
        });
    } catch (error) {
        console.error("[LiveToken] Error:", error);
        return json(500, { error: "Internal Server Error" });
    }
}
