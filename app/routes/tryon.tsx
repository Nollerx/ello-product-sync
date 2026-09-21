import { createHmac } from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { checkAndRecordUsage, createShopifyUsageCharge, releaseTryonCredit } from "../lib/usage-billing.server";
import { checkTryonOrigin } from "../lib/tryon-origin.server";
import { clientIpForRateLimit } from "../lib/client-ip.server";
import { supabaseAdmin } from "../lib/supabase.server";
import { healRottenSnapshot } from "../lib/print-scan.server";

// ─── Back-graphic split cards (2026-08-13) ───────────────────────────────────
// Where a product's design sits (clothing_items.print_side, filled by the
// catalogue vision scan or set by the merchant in Products). When the design is
// on the back and we have a back photo, the engine renders one front|back split
// card instead of a single front view. The widget stays dumb: it sends what it
// always sent, this proxy injects printSide/backImageUrl/hasFrontPhoto, and the
// widget only reacts to whether the response carries imageBackB64.
//
// The widget's productId arrives in whichever shape the surface had on hand —
// "gid://shopify/Product/123", plain "123", occasionally a variant gid — while
// clothing_items.item_id is just as inconsistent across sync paths. Query every
// spelling at once rather than guessing which one this store's rows use.
function productIdCandidates(raw: unknown): string[] {
    if (typeof raw !== "string" || !raw.trim()) return [];
    const id = raw.trim();
    const out = new Set<string>([id]);
    const tail = id.match(/(\d+)$/)?.[1];
    if (tail) {
        out.add(tail);
        out.add(`gid://shopify/Product/${tail}`);
    }
    return [...out];
}

interface PrintSideRow {
    print_side: string | null;
    front_image_url: string | null;
    back_image_url: string | null;
    // Which view the widget opens on. Presentation only — it never changes how
    // the render is produced, so it can never cause a wrong-side render.
    lead_view: string | null;
    // Handbags (2026-09-07): how the bag is carried + its listed size, from
    // the catalogue scan (app/lib/print-scan.server.ts → bag-carry.ts).
    carry_modes: string[] | null;
    bag_dimensions: Record<string, unknown> | null;
    carry_meta: Record<string, unknown> | null;
}

async function lookupPrintSide(
    storeSlug: string,
    productId: unknown,
): Promise<PrintSideRow | null> {
    const candidates = productIdCandidates(productId);
    if (candidates.length === 0) return null;
    // lead_view is newer than this code path. Selecting a column that does not
    // exist yet makes PostgREST fail the WHOLE query, which would return null
    // here and silently switch off every split card in the fleet — so the
    // deploy would have to land strictly after the migration. Ask for it, and
    // fall back to the columns that have always existed if it is not there.
    const BASE_COLS = "print_side, front_image_url, back_image_url, carry_modes, bag_dimensions, carry_meta";
    const run = (cols: string) =>
        supabaseAdmin
            .from("clothing_items")
            .select(cols)
            .eq("store_id", storeSlug)
            .in("item_id", candidates)
            .or("print_side.not.is.null,carry_modes.not.is.null,bag_dimensions.not.is.null")
            .limit(1);
    try {
        const first = await run(`${BASE_COLS}, lead_view`);
        let data = first.data;
        if (first.error) {
            const { data: d2, error: e2 } = await run(BASE_COLS);
            if (e2 || !d2?.length) return null;
            data = d2;
        }
        if (!data?.length) return null;
        return data[0] as unknown as PrintSideRow;
    } catch {
        // Lookup is best-effort: any failure means "no print data", which renders
        // exactly as today. A render must never fail because this table hiccuped.
        return null;
    }
}

// ML render service. Default = shared FASHN service; the custom app overrides
// via ML_API_URL (cloud_run_env_custom.yaml) to the Gemini engine (ello-vto-custom)
// so engine rollouts can be tested on the custom app before the public one.
const ML_API_URL =
    process.env.ML_API_URL ||
    "https://ello-vto-13593516897-13593516897.us-central1.run.app";

// Bound how long a single render may pin a front-door concurrency slot. Normal
// Gemini NB2 renders finish in 10–30s; 90s is generous headroom while preventing a
// degraded render engine from holding slots for the full 300s request timeout.
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS || 90_000);

// ─── Engine auth ──────────────────────────────────────────────────────────────
// The render engine used to accept unauthenticated POSTs from anywhere, so anyone
// who learned its run.app URL could bill full Gemini renders (~$0.067 each) to our
// Google Cloud credits. The engine now requires an HMAC header on /tryon; this is
// the signer. Shared secret is WIDGET_BOOTSTRAP_SECRET, which both engine services
// already hold — mount the same Secret Manager secret on this service.
//
// Signed payload is "<unix_seconds>.<storeSlug>": the timestamp bounds replay to the
// engine's skew window (5 min) and the slug pins a captured header to one store.
// This runs server-side only — the secret must never reach widget JS.
const ENGINE_AUTH_SECRET = process.env.WIDGET_BOOTSTRAP_SECRET;
if (!ENGINE_AUTH_SECRET) {
    console.error(
        "[TryOn Proxy] WIDGET_BOOTSTRAP_SECRET is not set — renders will be rejected 401 by the engine.",
    );
}

function engineAuthHeaders(storeSlug: string): Record<string, string> {
    if (!ENGINE_AUTH_SECRET) return {};
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", ENGINE_AUTH_SECRET)
        .update(`${ts}.${storeSlug}`)
        .digest("hex");
    return { "X-Ello-Auth": `t=${ts},v1=${sig}` };
}

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

    // Reject oversized bodies BEFORE buffering them into memory. The widget now
    // compresses uploads to well under 2MB, but a stale cached widget (old version)
    // could still send a multi-MB raw photo that would OOM this 512Mi instance under
    // concurrency. 8MB gives generous headroom over a compressed photo.
    const contentLength = Number(request.headers.get("content-length") || 0);
    const MAX_BODY_BYTES = Number(process.env.MAX_TRYON_BODY_BYTES || 8_000_000);
    if (contentLength > MAX_BODY_BYTES) {
        return new Response(
            JSON.stringify({
                error: "PAYLOAD_TOO_LARGE",
                message: "That photo is too large. Please try a smaller image.",
            }),
            { status: 413, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
        );
    }

    try {
        const body = await request.json();
        const storeSlug = body.storeSlug || body.store_slug || "default_store";

        console.log(`[TryOn Proxy] Forwarding request for store: ${storeSlug}`);

        // 1.5 Origin allowlist (enterprise stores opt in via vto_stores.allowed_origins):
        //     a render for such a store must come from a page on their storefront.
        //     Rejected BEFORE the usage gate so a scripted burn never even reserves
        //     a credit. Stores without a list are unaffected.
        const originCheck = await checkTryonOrigin(storeSlug, request);
        if (!originCheck.ok) {
            console.warn(`[TryOn Proxy] Origin rejected: store=${storeSlug} host=${originCheck.host ?? "(none)"}`);
            return new Response(
                JSON.stringify({
                    error: "ORIGIN_NOT_ALLOWED",
                    message: "Try-on is only available on this store's website.",
                }),
                { status: 403, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
            );
        }

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

        // Client IP for the per-shopper limit. GFE appends the verified peer as
        // the LAST X-Forwarded-For entry (earlier entries are spoofable). When
        // the widget rides the Cloudflare CDN hostname that peer is a CF edge
        // IP, so the helper unwraps CF-Connecting-IP — but only when the
        // verified peer really is Cloudflare, so direct run.app hits can't
        // spoof their way past the cap either.
        const clientIp = clientIpForRateLimit(request);

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

            // Velocity + abuse gates (2026-09-18): all 429 so the widget's
            // handleRateLimitError() path shows `message` and backs off.
            //   VELOCITY_LIMITED   — same session fired again within the store's
            //                        minimum interval (a real render takes ~11s).
            //   IP_HOURLY_LIMITED  — one address past its hourly render cap.
            //   DAILY_CAP_REACHED  — the store's own daily ceiling (their budget
            //                        circuit breaker), rolling 24h.
            //   STORE_RPM_LIMITED  — store-wide renders-per-minute ceiling; 503 +
            //                        Retry-After so real shoppers simply retry.
            if (usageResult.error === "VELOCITY_LIMITED" || usageResult.error === "IP_HOURLY_LIMITED") {
                return new Response(
                    JSON.stringify({
                        error: usageResult.error,
                        message: usageResult.error === "VELOCITY_LIMITED"
                            ? "One moment — your last try-on is still finishing. Please try again in a few seconds."
                            : "You've reached this store's try-on limit for now. Please come back in an hour.",
                    }),
                    { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "10", ...CORS_HEADERS } },
                );
            }
            if (usageResult.error === "DAILY_CAP_REACHED") {
                return new Response(
                    JSON.stringify({
                        error: "DAILY_CAP_REACHED",
                        message: "Try-on is taking a break for today. Please come back tomorrow.",
                    }),
                    { status: 429, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
                );
            }
            if (usageResult.error === "STORE_RPM_LIMITED") {
                return new Response(
                    JSON.stringify({
                        error: "STORE_RPM_LIMITED",
                        message: "Try-on is busy right now. Please try again in a moment.",
                    }),
                    { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "20", ...CORS_HEADERS } },
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

            // Metering RPC degraded past the bounded fail-open burst — tell the
            // shopper to retry rather than silently dropping or over-spending.
            if (usageResult.error === "SERVICE_DEGRADED") {
                return new Response(
                    JSON.stringify({
                        error: "SERVICE_DEGRADED",
                        message: "Try-on is briefly busy. Please try again in a moment.",
                    }),
                    {
                        status: 503,
                        headers: { "Content-Type": "application/json", "Retry-After": "30", ...CORS_HEADERS },
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

        // 2.5 Back-graphic lookup: if this product's design lives on the back,
        //     tell the engine so it renders a front|back split card. Best-effort —
        //     a null row leaves the body untouched and the render identical to
        //     today. When the catalogue has a proper front photo it also replaces
        //     productImageUrl, because on back-print catalogues the PDP primary
        //     image (what the widget sends) is usually the back view, and that is
        //     exactly the wrong garment source for the front panel.
        //     clothing_items is a snapshot, not a live mirror: a merchant who
        //     replaces a product photo deletes the file behind the stored URL and
        //     every render for that product 404s at the garment fetch (Atlas,
        //     2026-09-17 — 7 of 17 catalogued products, ~43% of try-ons). Keep the
        //     widget's own PDP image so step 3 can fall back to it.
        const widgetProductImageUrl = body.productImageUrl;
        let usedCatalogImages = false;
        let leadView: "front" | "back" | null = null;
        const printRow = await lookupPrintSide(storeSlug, body.productId || body.product_id);
        if (printRow?.print_side && ["back", "both"].includes(printRow.print_side) && printRow.back_image_url) {
            usedCatalogImages = true;
            body.printSide = printRow.print_side;
            body.backImageUrl = printRow.back_image_url;
            body.hasFrontPhoto = Boolean(printRow.front_image_url);
            // A back-graphic garment should open on the back: that print is the
            // reason the shopper is looking at it. The Front/Back toggle the
            // widget already renders still gives them the front.
            leadView = printRow.lead_view === "back" ? "back" : "front";
            if (printRow.front_image_url) {
                body.productImageUrl = printRow.front_image_url;
            }
            console.log(
                `[TryOn Proxy] Split card: store=${storeSlug} side=${printRow.print_side} hasFront=${body.hasFrontPhoto}`,
            );
        } else if (printRow?.print_side === "front" && printRow.front_image_url) {
            // Front-only print on a catalogue whose PDP primary is a back view
            // (common on back-first stores): no split card, but the garment
            // source must still be the front photo or the render is a blank tee.
            body.productImageUrl = printRow.front_image_url;
            usedCatalogImages = true;
            console.log(`[TryOn Proxy] Front-source swap: store=${storeSlug}`);
        }

        // 2.6 Handbag carry modes + true-scale dimensions (2026-09-07): the
        //     catalogue scan's read of how this bag is carried (with its best
        //     strap-attached / by-the-handles photos) and its listed W x H x D.
        //     The engine renders a strap|handheld split card from these and
        //     labels the widget's toggle (viewLabels). Without a row it falls
        //     back to the listing text the widget sends (productDescription),
        //     which is shopper-controlled — cap it here; the engine only needs
        //     the measurement sentences.
        if (printRow && ((printRow.carry_modes && printRow.carry_modes.length) || printRow.bag_dimensions)) {
            if (printRow.carry_modes && printRow.carry_modes.length) body.carryModes = printRow.carry_modes;
            if (printRow.bag_dimensions) body.bagDimensions = printRow.bag_dimensions;
            const meta = printRow.carry_meta || {};
            const strap = typeof meta.strap_image_url === "string" ? meta.strap_image_url : null;
            const handle = typeof meta.handle_image_url === "string" ? meta.handle_image_url : null;
            if (strap || handle) body.carryImages = { strap, handle };
            if (typeof meta.strap_removable === "boolean") body.strapRemovable = meta.strap_removable;
            console.log(
                `[TryOn Proxy] Bag carry: store=${storeSlug} modes=${(printRow.carry_modes || []).join("+") || "-"} dims=${printRow.bag_dimensions ? "yes" : "no"}`,
            );
        }
        if (typeof body.productDescription === "string") {
            body.productDescription = body.productDescription.slice(0, 2000);
        } else if (body.productDescription != null) {
            delete body.productDescription;
        }

        // 3. Forward to ML API service. The usage credit was already reserved in
        //    step 2 (we record before rendering so the limit gate runs before we
        //    spend compute), so any failure path below must hand the credit back.
        const sessionId = body.sessionId || body.session_id || null;
        const callEngine = (payload: Record<string, unknown>) =>
            fetch(
                `${ML_API_URL}/tryon`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        // Signed with the slug the engine will read off the forwarded
                        // body (body.storeSlug), so the signature matches what it verifies.
                        ...engineAuthHeaders(storeSlug),
                    },
                    body: JSON.stringify(payload),
                    signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
                }
            );
        const gotImage = (r: Response, d: Record<string, unknown>) =>
            r.ok && Boolean(d?.imageB64 || d?.image_b64 || d?.image);

        try {
            let res = await callEngine(body);
            let data = await res.json().catch(() => ({}));

            // Did the render actually return an image? Mirror the widget's own
            // success check (widget-main.js: data.imageB64 || data.image_b64 || data.image).
            let renderSucceeded = gotImage(res, data);

            // 3b. Self-heal a rotten catalogue snapshot. The stored front/back URLs
            //     are a point-in-time copy of the merchant's Files; when they
            //     replace a photo the old URL 404s and the engine's garment fetch
            //     raises, so EVERY try-on on that product dies. One retry with the
            //     widget's own live PDP image costs nothing on the happy path and
            //     turns a hard zero into a plain (un-split) render. Only retried
            //     when the engine actually answered — a timeout must not be doubled.
            if (!renderSucceeded && usedCatalogImages) {
                const plain = { ...body };
                delete plain.printSide;
                delete plain.backImageUrl;
                delete plain.hasFrontPhoto;
                plain.productImageUrl = widgetProductImageUrl;
                console.warn(
                    `[TryOn Proxy] Catalogue image render failed (status=${res.status}) — retrying with the live PDP image: store=${storeSlug} product=${body.productId || body.product_id}`,
                );
                try {
                    const retryRes = await callEngine(plain);
                    const retryData = await retryRes.json().catch(() => ({}));
                    if (gotImage(retryRes, retryData)) {
                        res = retryRes;
                        data = retryData;
                        renderSucceeded = true;
                        console.warn(
                            `[TryOn Proxy] Stale catalogue image for store=${storeSlug} product=${body.productId || body.product_id} — served from the live PDP image; clothing_items needs a re-scan.`,
                        );
                        // Don't just log it. Clear the dead URLs so the NEXT
                        // shopper skips the failed first attempt entirely, and
                        // kick a rescan for this one product to refill them.
                        // Fire-and-forget: the shopper already has their render.
                        healRottenSnapshot(storeSlug, body.productId || body.product_id).catch(
                            (healErr) => console.error("[TryOn Proxy] self-heal failed:", healErr),
                        );
                    }
                } catch (retryErr) {
                    console.error("[TryOn Proxy] Live-image retry failed:", retryErr);
                }
            }

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

            // 6. Return response with CORS headers. leadView is added HERE rather
            //    than in the engine: the proxy already read the catalogue row, so
            //    the widget can be told which view to open on without an engine
            //    change. Only ever sent when a real back panel came back.
            const payload =
                leadView && (data?.imageBackB64 || data?.image_back_b64)
                    ? { ...data, leadView }
                    : data;
            return new Response(JSON.stringify(payload), {
                status: res.status,
                headers: { "Content-Type": "application/json", ...CORS_HEADERS },
            });
        } catch (mlErr) {
            // Render timed out (AbortSignal) or the ML service was unreachable —
            // release the reserved credit so the shopper isn't charged for a try-on
            // they never received, then return a clean, retryable status instead of a
            // generic 500 (and instead of hanging for the full 300s request timeout).
            if (!usageResult.error) {
                await releaseTryonCredit(storeSlug, sessionId, usageResult.is_overage);
            }
            const isTimeout =
                mlErr instanceof Error &&
                (mlErr.name === "TimeoutError" || mlErr.name === "AbortError");
            console.error(
                `[TryOn Proxy] Render ${isTimeout ? "timed out" : "transport error"}:`,
                mlErr,
            );
            return new Response(
                JSON.stringify({
                    error: isTimeout ? "RENDER_TIMEOUT" : "RENDER_UNAVAILABLE",
                    message: "The try-on took too long. Please try again.",
                }),
                {
                    status: isTimeout ? 504 : 502,
                    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                },
            );
        }

    } catch (error) {
        console.error("[TryOn Proxy] Error:", error);
        // Internal detail stays in the logs — never in a shopper-facing response.
        return new Response(JSON.stringify({ error: "Internal Server Error" }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
    }
}
