import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
    // 1. Handle CORS Preflight (OPTIONS)
    if (request.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
            },
        });
    }

    // 2. Only allow POST
    if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
    }

    try {
        // 3. Parse Backend Payload
        const body = await request.json();

        // 4. Forward to Ello Cloud Run
        // NOTE: authenticate.admin(request) is optional here depending on if you want to enforce shopify auth.
        // For a public widget, valid CORS + rate limiting (future) is usually what protects it.
        // We'll just proxy directly for now.

        const externalResponse = await fetch("https://ello-vto-13593516897.us-central1.run.app/tryon", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });

        // 5. Return External Response to Widget
        const data = await externalResponse.json();

        return new Response(JSON.stringify(data), {
            status: externalResponse.status,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*", // Allow widget to read response
            },
        });

    } catch (error) {
        console.error("Proxy Error:", error);
        return new Response(JSON.stringify({ error: "Proxy Failed", details: String(error) }), {
            status: 500,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
            },
        });
    }
};
