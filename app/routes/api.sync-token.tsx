import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { runTokenSync, SYNC_ERRORS } from "../lib/sync.server";

export const action = async ({ request }: ActionFunctionArgs) => {
    // Generate Request ID early
    const requestId = crypto.randomUUID();

    try {
        const { admin, session } = await authenticate.admin(request);
        const shop = session.shop;

        console.log(`[API:Sync:${requestId}] Triggered for ${shop}`);

        // 1. Mint Token from Shopify
        const mutation = `#graphql
          mutation CreateStorefrontToken($input: StorefrontAccessTokenInput!) {
            storefrontAccessTokenCreate(input: $input) {
              storefrontAccessToken { accessToken }
              userErrors { field message }
            }
          }
        `;

        const resp = await admin.graphql(mutation, {
            variables: { input: { title: "Ello VTO Sync" } },
        });

        const jsonResp = await resp.json();
        const token = jsonResp?.data?.storefrontAccessTokenCreate?.storefrontAccessToken?.accessToken;
        const errs = jsonResp?.data?.storefrontAccessTokenCreate?.userErrors;

        if ((errs && errs.length > 0) || !token) {
            console.error(`[API:Sync:${requestId}] ❌ Shop Mint Failed:`, errs);
            return new Response(JSON.stringify({
                success: false,
                shop,
                code: SYNC_ERRORS.SHOPIFY_FETCH_FAILED,
                message: errs?.[0]?.message || "Shopify returned no token",
                requestId,
                retryable: false
            }), { 
                status: 500,
                headers: { "Content-Type": "application/json" }
            });
        }

        // 2. Delegate to Sync Engine
        const result = await runTokenSync(shop, token, requestId);

        // 3. Return structured result
        return new Response(JSON.stringify(result), {
            status: result.success ? 200 : 500,
            headers: { "Content-Type": "application/json" }
        });

    } catch (err: any) {
        // IMPORTANT: authenticate.admin() throws a Response when redirecting to auth.
        // Re-throw it so React Router / Shopify can handle the auth flow correctly.
        if (err instanceof Response) {
            throw err;
        }
        console.error(`[API:Sync:${requestId}] Critical Endpoint Error:`, err);
        const detailedMessage = `${err.message || err.toString()} | Stack: ${err.stack || ''} | Cause: ${(err.cause as any)?.message || ''}`;
        return new Response(JSON.stringify({
            success: false,
            code: 'INTERNAL_ERROR',
            message: detailedMessage,
            requestId
        }), { 
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }
};
