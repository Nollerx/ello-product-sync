import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { checkAndRecordUsage, createShopifyUsageCharge, releaseTryonCredit } from "../lib/usage-billing.server";

// ML render service. Default = shared FASHN service; the custom app overrides
// via ML_API_URL (cloud_run_env_custom.yaml) to the Gemini engine (ello-vto-custom)
// so engine rollouts can be tested on the custom app before the public one.
const ML_API_URL =
    process.env.ML_API_URL ||
    "https://ello-vto-13593516897-13593516897.us-central1.run.app";

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
    // 1. Handle CORS Preflight (OPTIONS)
    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
        const body = await request.json();
        const storeSlug = body.storeSlug || body.store_slug || "default_store";

        console.log(`[TryOn Proxy] Forwarding request for store: ${storeSlug}`);

        // 2. Check usage limits and record the try-on attempt
        //    pageContext: { type, path, handle, in_catalog } — sent by widget so the
        //    dashboard's Page-Type Breakdown can bucket each try-on by surface.
        //    entrySource: 'inline_button' | 'floating_widget' | 'preview_popup' | 'unknown' —
        //    which UI surface fired this try-on. Lets the dashboard A/B placements.
        //    Defaults to null (RPC stores NULL) when widget version pre-dates the field.
        const rawEntrySource = body.entrySource || body.entry_source;
        const allowedSources = new Set([
            "inline_button",
            "floating_widget",
            "preview_popup",
            // Upsell layer pass — the proof layer segments AOV by this tag.
            "complete_the_look",
            // Fitting Room surfaces (the widget was already sending these;
            // they were silently dropped to null before).
            "fitting_room",
            "fitting_room_hub",
            "unknown",
        ]);
        const entrySource = allowedSources.has(rawEntrySource) ? rawEntrySource : null;

        // Client IP for the per-shopper limit. Cloud Run's LB appends its own
        // hop to X-Forwarded-For, so the first entry is the real client.
        const clientIp =
            request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;

        const usageResult = await checkAndRecordUsage(
            storeSlug,
            true,
            body.productId || body.product_id || null,
            body.variantId || body.variant_id || null,
            body.sessionId || body.session_id || null,
            body.pageContext || null,
            entrySource,
            clientIp,
        );

        if (!usageResult.allowed) {
            // Merchant-configured per-shopper limit: 429 → the widget's
            // handleRateLimitError() shows `message` and disables the button.
            if (usageResult.error === "SHOPPER_RATE_LIMITED") {
                const hours = usageResult.shopper_limit_window_hours ?? 24;
                const windowLabel =
                    hours === 1 ? "hour" : hours === 24 ? "day" : hours === 168 ? "week" : `${hours} hours`;
                const count = usageResult.shopper_limit_count;
                return new Response(
                    JSON.stringify({
                        error: "SHOPPER_RATE_LIMITED",
                        message: count
                            ? `You've reached this store's try-on limit (${count} per ${windowLabel}). Please come back later.`
                            : "You've reached this store's try-on limit. Please come back later.",
                        shopper_limit_count: count ?? null,
                        shopper_limit_window_hours: hours,
                    }),
                    {
                        status: 429,
                        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                    },
                );
            }

            // Free plan: hard block with distinct error + 403 so the widget can render
            // an "upgrade to continue" message instead of a paid-overage prompt.
            if (usageResult.error === "MONTHLY_LIMIT_REACHED") {
                return new Response(
                    JSON.stringify({
                        error: "MONTHLY_LIMIT_REACHED",
                        message: "Monthly try-on limit reached. Upgrade to continue.",
                        plan_code: usageResult.plan_code,
                        tryons_used: usageResult.tryons_used,
                        included_tryons: usageResult.included_tryons,
                    }),
                    {
                        status: 403,
                        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                    },
                );
            }

            const errorMessage = usageResult.error === "OVERAGE_CAP_REACHED"
                ? "OVERAGE_BLOCKED: Your overage credit limit has been reached. Please increase your auto top-up cap or upgrade your plan."
                : "OVERAGE_BLOCKED: Your try-on limit has been reached. Enable auto top-up or upgrade your plan to continue.";

            return new Response(
                JSON.stringify({ error: errorMessage }),
                {
                    status: 402,
                    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                },
            );
        }

        // 3. Forward to ML API service. The usage credit was already reserved in
        //    step 2 (we record before rendering so the limit gate runs before we
        //    spend compute), so any failure path below must hand the credit back.
        const sessionId = body.sessionId || body.session_id || null;
        try {
            const res = await fetch(
                `${ML_API_URL}/tryon`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                }
            );

            const data = await res.json().catch(() => ({}));

            // Did the render actually return an image? Mirror the widget's own
            // success check (widget-main.js: data.imageB64 || data.image_b64 || data.image).
            const renderSucceeded =
                res.ok && Boolean(data?.imageB64 || data?.image_b64 || data?.image);

            // 4. Failed/empty render → release the reserved credit so a try-on that
            //    produced no photo doesn't consume the merchant's included/overage
            //    usage. Skip when usage wasn't actually recorded (RPC failed open).
            if (!renderSucceeded && !usageResult.error) {
                await releaseTryonCredit(storeSlug, sessionId, usageResult.is_overage);
            }

            // 5. Only on a successful overage render, create the Shopify usage charge
            //    (fire-and-forget). Skip when SKIP_BILLING is on (custom = billed via Stripe).
            if (renderSucceeded && process.env.SKIP_BILLING !== "true" && usageResult.is_overage && usageResult.shop_domain && usageResult.shopify_usage_line_item_id) {
                createShopifyUsageCharge(
                    usageResult.shop_domain,
                    usageResult.shopify_usage_line_item_id,
                    `Virtual try-on overage (try-on #${usageResult.tryons_used})`,
                ).catch((err) => {
                    console.error("[TryOn Proxy] Failed to create overage charge:", err);
                });
            }

            // 6. Return response with CORS headers
            return new Response(JSON.stringify(data), {
                status: res.status,
                headers: { "Content-Type": "application/json", ...CORS_HEADERS },
            });
        } catch (mlErr) {
            // ML service unreachable (transport error) — release the reserved credit,
            // then bubble up to the outer handler so the shopper still gets a 500.
            if (!usageResult.error) {
                await releaseTryonCredit(storeSlug, sessionId, usageResult.is_overage);
            }
            throw mlErr;
        }

    } catch (error) {
        console.error("[TryOn Proxy] Error:", error);
        return new Response(JSON.stringify({ error: "Internal Server Error", detail: String(error) }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
    }
}
