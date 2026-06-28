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

        const TOKEN_TITLE = "Ello VTO Sync";

        // 1. Reuse the existing sync token when one exists. Shopify caps
        //    storefront access tokens at 100 per shop — minting a fresh one on
        //    every health check eventually fails every sync with
        //    "Reached storefront access token limit of 100".
        let token: string | undefined;
        let extraTokenIds: string[] = [];
        try {
            const listResp = await admin.graphql(`#graphql
              query ExistingStorefrontTokens {
                shop {
                  storefrontAccessTokens(first: 100) {
                    edges { node { id title accessToken } }
                  }
                }
              }
            `);
            const listJson = await listResp.json();
            const edges = listJson?.data?.shop?.storefrontAccessTokens?.edges ?? [];
            const ours = edges
                .map((e: any) => e?.node)
                .filter((n: any) => n?.title === TOKEN_TITLE && n?.accessToken);
            if (ours.length > 0) {
                token = ours[0].accessToken;
                extraTokenIds = ours.slice(1).map((n: any) => n.id);
                console.log(`[API:Sync:${requestId}] Reusing existing token (${ours.length} found)`);
            }
        } catch (listErr) {
            // Listing is an optimization — fall through to minting on failure.
            console.warn(`[API:Sync:${requestId}] Token list failed, will mint:`, listErr);
        }

        // 1b. Mint only when no reusable token exists (first sync for the shop)
        if (!token) {
            const mutation = `#graphql
              mutation CreateStorefrontToken($input: StorefrontAccessTokenInput!) {
                storefrontAccessTokenCreate(input: $input) {
                  storefrontAccessToken { accessToken }
                  userErrors { field message }
                }
              }
            `;

            const resp = await admin.graphql(mutation, {
                variables: { input: { title: TOKEN_TITLE } },
            });

            const jsonResp = await resp.json();
            token = jsonResp?.data?.storefrontAccessTokenCreate?.storefrontAccessToken?.accessToken;
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
        }

        // 1c. Prune duplicate tokens left by the old mint-every-time behavior.
        //     Best-effort and capped per run to stay inside API rate limits —
        //     a shop at the 100-token cap drains over a few syncs.
        if (extraTokenIds.length > 0) {
            const toDelete = extraTokenIds.slice(0, 25);
            console.log(`[API:Sync:${requestId}] Pruning ${toDelete.length} of ${extraTokenIds.length} duplicate tokens`);
            for (const id of toDelete) {
                try {
                    await admin.graphql(`#graphql
                      mutation DeleteStorefrontToken($input: StorefrontAccessTokenDeleteInput!) {
                        storefrontAccessTokenDelete(input: $input) {
                          deletedStorefrontAccessTokenId
                          userErrors { field message }
                        }
                      }
                    `, { variables: { input: { id } } });
                } catch (delErr) {
                    console.warn(`[API:Sync:${requestId}] Token prune failed for ${id}:`, delErr);
                    break;
                }
            }
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
