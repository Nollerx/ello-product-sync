import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../lib/supabase.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
    // 1. Admin Auth (ensure only app users can check)
    await authenticate.admin(request);

    const start = performance.now();
    const requestId = crypto.randomUUID();

    try {
        // 2. Simple Ping
        const { error } = await supabaseAdmin.from('vto_stores').select('count', { count: 'exact', head: true }).limit(1);
        
        const duration = Math.round(performance.now() - start);

        if (error) {
            return new Response(JSON.stringify({
                status: 'error',
                ok: false,
                latency_ms: duration,
                error_code: error.code,
                message: error.message,
                requestId
            }), { 
                status: 503,
                headers: { "Content-Type": "application/json" }
            });
        }

        return new Response(JSON.stringify({
            status: 'healthy',
            ok: true,
            latency_ms: duration,
            requestId
        }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
        });

    } catch (err: any) {
        return new Response(JSON.stringify({
            status: 'crash',
            ok: false,
            latency_ms: Math.round(performance.now() - start),
            error: err.message,
            requestId
        }), { 
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }
};
