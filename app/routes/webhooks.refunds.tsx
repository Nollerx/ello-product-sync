import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../lib/supabase.server";

/**
 * refunds/create
 *
 * Returns netting for Qualified Revenue. Attribution bills only tried-on line
 * items; when a shopper returns one, the refunded line must come back out of
 * attributed_revenue_net (get_vto_conversion_summary) — and the same rows power
 * the tried-on vs store-wide return-rate comparison (get_vto_return_rates).
 *
 * Every refund is stored, not just refunds on attributed orders: the store-wide
 * baseline return rate needs the full picture, and the attribution join happens
 * read-side by order_id.
 *
 * Field mapping (refunds/create REST payload):
 *   payload.order_id                      -> order_id (bare numeric — same format
 *                                            the pixel stores on purchase_events)
 *   refund_line_items[].subtotal          -> refunded merchandise for the line,
 *                                            post-discount, pre-tax — the same
 *                                            basis as the pixel's line_price
 *   refund_line_items[].line_item.product_id -> matches line_items[].product_id
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const { data: store } = await supabaseAdmin
      .from("vto_stores")
      .select("store_slug")
      .eq("shop_domain", shop)
      .maybeSingle();

    if (!store?.store_slug) return new Response();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = payload as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lineItems = ((p?.refund_line_items ?? []) as any[]).map((rli) => ({
      product_id:
        rli?.line_item?.product_id != null ? String(rli.line_item.product_id) : null,
      variant_id:
        rli?.line_item?.variant_id != null ? String(rli.line_item.variant_id) : null,
      quantity: Number(rli?.quantity ?? 0),
      subtotal: rli?.subtotal != null ? Number(rli.subtotal) : null,
      title: rli?.line_item?.title ?? null,
    }));

    const refundedSubtotal = lineItems.reduce(
      (sum, li) => sum + (li.subtotal ?? 0),
      0,
    );

    const { error } = await supabaseAdmin.from("refund_events").upsert(
      {
        store_slug: store.store_slug,
        order_id: p?.order_id != null ? String(p.order_id) : null,
        refund_id: p?.id != null ? String(p.id) : null,
        refunded_subtotal: refundedSubtotal,
        currency:
          p?.refund_line_items?.[0]?.subtotal_set?.shop_money?.currency_code ?? null,
        line_items: lineItems,
        refunded_at: p?.created_at ?? null,
      },
      { onConflict: "refund_id", ignoreDuplicates: true },
    );
    if (error) {
      console.error(`[${topic}] Failed to store refund for ${shop}:`, error.message);
    }
  } catch (err) {
    console.error(`[${topic}] Exception storing refund for ${shop}:`, err);
    // Do not rethrow — Shopify expects a 200 response
  }

  return new Response();
};
