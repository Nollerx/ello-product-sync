import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { checkAndRecordUsage, createShopifyUsageCharge } from "../lib/usage-billing.server";

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
        const usageResult = await checkAndRecordUsage(
            storeSlug,
            true,
            body.productId || body.product_id || null,
            body.variantId || body.variant_id || null,
            body.sessionId || body.session_id || null,
            body.pageContext || null,
        );

        if (!usageResult.allowed) {
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

        // 3. Forward to ML API service
        const res = await fetch(
            "https://ello-vto-13593516897-13593516897.us-central1.run.app/tryon",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            }
        );

        const data = await res.json().catch(() => ({}));

        // 4. If overage, create Shopify usage charge (fire-and-forget)
        //    Skip when SKIP_BILLING is enabled (custom distribution — billed via Stripe)
        if (process.env.SKIP_BILLING !== "true" && usageResult.is_overage && usageResult.shop_domain && usageResult.shopify_usage_line_item_id) {
            createShopifyUsageCharge(
                usageResult.shop_domain,
                usageResult.shopify_usage_line_item_id,
                `Virtual try-on overage (try-on #${usageResult.tryons_used})`,
            ).catch((err) => {
                console.error("[TryOn Proxy] Failed to create overage charge:", err);
            });
        }

        // 5. Return response with CORS headers
        return new Response(JSON.stringify(data), {
            status: res.status,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });

    } catch (error) {
        console.error("[TryOn Proxy] Error:", error);
        return new Response(JSON.stringify({ error: "Internal Server Error", detail: String(error) }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
    }
}
