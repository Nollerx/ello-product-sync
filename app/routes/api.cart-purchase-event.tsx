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
      p_subtotal_price: body.subtotal_price
        ? parseFloat(body.subtotal_price as string)
        : null,
      p_currency: (body.currency as string) ?? null,
      p_line_items: JSON.stringify(body.line_items ?? []),
    });
  } else if (event_type === "ab_exposure") {
    // Widget-loader A/B holdout exposure beacon. The RPC re-computes the
    // bucket server-side and rejects rows whose variant doesn't match the
    // hash or whose experiment isn't running — forged/drifted rows never land.
    const experimentId = body.experiment_id as string | undefined;
    const variant = body.variant as string | undefined;
    const bucket = Number(body.bucket);
    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      experimentId &&
      UUID_RE.test(experimentId) &&
      (variant === "exposed" || variant === "holdout") &&
      Number.isInteger(bucket) &&
      bucket >= 0 &&
      bucket <= 99 &&
      // Length caps: real session ids are ~17 chars; the RPC hashes
      // session_id char-by-char, so unbounded input is a CPU amplifier.
      session_id.length <= 64 &&
      store_slug.length <= 100
    ) {
      // Beacons always get 200 (the client can't act on failure), but a
      // dropped exposure must at least be loud in the logs — a silent RPC
      // error here cost us every exposure row until 2026-07-13.
      const { data: abResult, error: abError } = await supabase.rpc(
        "record_ab_exposure",
        {
          p_store_slug: store_slug,
          p_session_id: session_id,
          p_experiment_id: experimentId,
          p_variant: variant,
          p_bucket: bucket,
          p_page_type: (body.page_type as string) ?? null,
        },
      );
      if (abError) {
        console.error("[ab] exposure RPC failed:", abError.message);
      } else if (abResult && (abResult as { success?: boolean }).success === false) {
        console.warn("[ab] exposure rejected:", JSON.stringify(abResult));
      }
    }
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
