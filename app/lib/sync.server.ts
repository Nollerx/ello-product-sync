import { supabaseAdmin } from "./supabase.server";

// Sync Status Types
export type SyncStatus = 'connected' | 'syncing' | 'synced' | 'retrying' | 'failed_non_retryable';

export interface SyncResult {
    success: boolean;
    shop: string;
    code?: string;
    message?: string;
    requestId: string;
    retryable?: boolean;
    attempts?: number;
}

// Error Codes
export const SYNC_ERRORS = {
    CONFIG_MISSING: 'SUPABASE_CONFIG_MISSING',
    UNREACHABLE: 'SUPABASE_UNREACHABLE',
    AUTH_FAILED: 'SUPABASE_AUTH_FAILED',
    SCHEMA_ERROR: 'SUPABASE_SCHEMA_ERROR',
    SHOPIFY_FETCH_FAILED: 'SHOPIFY_TOKEN_FETCH_FAILED',
    SHOPIFY_AUTH_MISSING: 'SHOPIFY_AUTH_MISSING',
    UNKNOWN: 'UNKNOWN_ERROR'
};

const RETRY_DELAYS = [1000, 3000, 7000]; // 1s, 3s, 7s

/**
 * Core Sync Engine
 * Handles the token exchange and database persistence with retries.
 */
export async function runTokenSync(shop: string, accessToken: string, requestId: string = crypto.randomUUID()): Promise<SyncResult> {
    console.log(`[SyncEngine:${requestId}] Starting sync for ${shop}`);

    // 1. Env Validation
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error(`[SyncEngine:${requestId}] ❌ Missing Supabase Env Vars`);
        return {
            success: false,
            shop,
            code: SYNC_ERRORS.CONFIG_MISSING,
            message: "Database configuration missing on server.",
            requestId,
            retryable: false
        };
    }

    let attempts = 0;
    let lastError: any = null;

    // 2. Retry Loop
    for (const delay of [0, ...RETRY_DELAYS]) {
        attempts++;
        if (delay > 0) await new Promise(r => setTimeout(r, delay));

        try {
            console.log(`[SyncEngine:${requestId}] Attempt ${attempts} -> Upserting token...`);

            // Use upsert to be idempotent
            const { error } = await supabaseAdmin
                .schema('shopify_app')
                .from('storefront_tokens')
                .upsert(
                    { shop, storefront_access_token: accessToken },
                    { onConflict: 'shop' }
                );

            if (error) {
                lastError = error;
                // Check if retryable
                if (isRetryableError(error)) {
                    console.warn(`[SyncEngine:${requestId}] Attempt ${attempts} failed (retryable): ${error.message}`);
                    continue;
                } else {
                    // Fatal error (schema, auth)
                    console.error(`[SyncEngine:${requestId}] Fatal DB Error: ${error.code} - ${error.message}`);
                    return mapDbErrorToResult(error, shop, requestId, attempts);
                }
            }

            // Success! Update vto_stores metadata
            console.log(`[SyncEngine:${requestId}] ✅ Token Synced. Updating Store Metadata...`);
            await updateStoreMetadata(shop, 'synced', requestId, attempts);

            return {
                success: true,
                shop,
                requestId,
                attempts
            };

        } catch (err: any) {
            console.error(`[SyncEngine:${requestId}] Network/System Exception attempt ${attempts}:`, err);
            lastError = err;
            // Network errors are usually retryable
            if (attempts <= RETRY_DELAYS.length) continue;
        }
    }

    // Failed after retries
    console.error(`[SyncEngine:${requestId}] ❌ All ${attempts} attempts failed.`);
    await updateStoreMetadata(shop, 'failed_non_retryable', requestId, attempts, lastError?.message);

    return {
        success: false,
        shop,
        code: SYNC_ERRORS.UNREACHABLE,
        message: "Database unreachable after multiple attempts.",
        requestId,
        retryable: true, // It was retryable, but we ran out of retries
        attempts
    };
}

// Helpers

function isRetryableError(error: any): boolean {
    // Retry on network/timeout or 5xx specific codes if available
    // PGRST106 (schema missing) and 42501 (perms) are NOT retryable
    if (error.code === 'PGRST106' || error.code === '42501') return false;
    return true; // Default to retry for unknown/network glitches
}

function mapDbErrorToResult(error: any, shop: string, requestId: string, attempts: number): SyncResult {
    let code = SYNC_ERRORS.UNKNOWN;
    let msg = error.message;

    if (error.code === 'PGRST106') {
        code = SYNC_ERRORS.SCHEMA_ERROR;
        msg = "Database Schema 'shopify_app' not exposed.";
    } else if (error.code === '42501') {
        code = SYNC_ERRORS.AUTH_FAILED;
        msg = "Database Permission Denied (RLS).";
    }

    return {
        success: false,
        shop,
        code,
        message: msg,
        requestId,
        retryable: false,
        attempts
    };
}

async function updateStoreMetadata(shop: string, status: SyncStatus, requestId: string, attempts: number, errorMsg?: string) {
    // Best-effort update of public.vto_stores
    try {
        await supabaseAdmin.from('vto_stores').update({
            sync_status: status,
            last_sync_at: new Date().toISOString(),
            sync_request_id: requestId,
            sync_attempts: attempts,
            sync_error: errorMsg || null,
            // Also ensure/create slug if needed, but usually we just update
        }).eq('shop_domain', shop);
    } catch (e) {
        console.warn(`[SyncEngine] Failed to update metadata for ${shop}`, e);
    }
}
