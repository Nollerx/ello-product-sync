import type { ActionFunctionArgs } from "react-router";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// OPTIONS pre-flight (browser sendBeacon doesn't need this, but fetch-based callers do)
export async function loader() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400, headers: CORS });
  }

  const { event_type, session_id, store_slug } = body as {
    event_type?: string;
    session_id?: string;
    store_slug?: string;
    [key: string]: unknown;
  };

  if (!event_type || !session_id || !store_slug) {
    return new Response("Missing required fields", {
      status: 400,
      headers: CORS,
    });
  }

  if (event_type === "view") {
    await supabase.rpc("record_product_view_event", {
      p_store_slug: store_slug,
      p_session_id: session_id,
      p_product_id: (body.product_id as string) ?? null,
      p_variant_id: (body.variant_id as string) ?? null,
    });
  } else if (event_type === "cart") {
    await supabase.rpc("record_cart_event", {
      p_store_slug: store_slug,
      p_session_id: session_id,
      p_product_id: (body.product_id as string) ?? null,
      p_variant_id: (body.variant_id as string) ?? null,
    });
  } else if (event_type === "purchase") {
    await supabase.rpc("record_purchase_event", {
      p_store_slug: store_slug,
      p_session_id: session_id,
      p_order_id: (body.order_id as string) ?? null,
      p_total_price: body.total_price
        ? parseFloat(body.total_price as string)
        : null,
      p_currency: (body.currency as string) ?? null,
      p_line_items: JSON.stringify(body.line_items ?? []),
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
