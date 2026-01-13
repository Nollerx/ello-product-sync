import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import crypto from "crypto";

export const loader = async ({ request }: LoaderFunctionArgs) => {
    return new Response("Privacy Webhook Endpoint Active", { status: 200 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
    try {
        const topic = request.headers.get("x-shopify-topic") || "UNKNOWN";
        const shop = request.headers.get("x-shopify-shop-domain") || "UNKNOWN";
        const hmac = request.headers.get("x-shopify-hmac-sha256");

        // 1. Get raw body text
        const rawBody = await request.text();

        // 2. Manual HMAC Verification
        // Use the Public App Secret (since this is deployed to the public service)
        const secret = process.env.SHOPIFY_API_SECRET || "";
        if (!secret || !hmac) {
            console.error("Missing secret or HMAC header");
            return new Response("Unauthorized", { status: 401 });
        }

        const generatedHash = crypto
            .createHmac("sha256", secret)
            .update(rawBody, "utf8")
            .digest("base64");

        if (generatedHash !== hmac) {
            console.error("❌ HMAC Validation failed in api.privacy.tsx");
            console.error(`Expected: ${hmac}, Got: ${generatedHash}`);
            return new Response("Unauthorized", { status: 401 });
        }

        // 3. Handle Topics (using rawBody JSON)
        console.log(`✅ [GDPR] Verified webhook ${topic} for ${shop}`);

        // We don't parse the body unless needed, to avoid errors.
        // Since we just need to return 200 for compliance:
        return new Response("GDPR Request Received", { status: 200 });

    } catch (error) {
        console.error("Webhook processing error:", error);
        return new Response("Server Error", { status: 500 });
    }
};
