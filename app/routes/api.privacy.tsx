import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
    let topic, shop, session, admin, payload;
    try {
        const result = await authenticate.webhook(request);
        topic = result.topic;
        shop = result.shop;
        session = result.session;
        admin = result.admin;
        payload = result.payload;
    } catch (error) {
        console.error("Webhook authentication failed:", error);
        return new Response("Unauthorized", { status: 401 });
    }

    if (!topic) {
        return new Response("No topic header", { status: 404 });
    }

    // Mandatory GDPR Webhooks
    // These must return 200 OK to pass App Store review.

    switch (topic) {
        case "CUSTOMERS_DATA_REQUEST":
            console.log(`[GDPR] Customer Data Request for ${shop}`);
            // Payload has customer info. 
            // If we stored PII, we would email it to them. 
            // Since we only store tokens, we effectively have no customer PII to report.
            break;

        case "CUSTOMERS_REDACT":
            console.log(`[GDPR] Customer Redact Request for ${shop}`);
            // Remove customer PII if we had any.
            break;

        case "SHOP_REDACT":
            console.log(`[GDPR] Shop Redact Request for ${shop}`);
            // 48 hours after uninstall, redact shop data.
            // We rely on 'app/uninstalled' to clear sessions immediately.
            // We could optionally clear the Supabase token here too if verified.
            break;

        default:
            // Other webhooks
            break;
    }

    return new Response("GDPR Request Received", { status: 200 });
};
