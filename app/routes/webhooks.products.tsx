import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../lib/supabase.server";
import { kickPrintScan, shouldRescanProduct, type ProductWebhookPayload } from "../lib/print-scan.server";

/**
 * products/create | products/delete | products/update
 *
 * The widget's enabled-handles list (/api/catalog-handles) and resolved config
 * (/api/widget-config-resolved) are cached behind an ETag keyed on
 * vto_stores.config_version. That version only moves when a merchant edits
 * settings — so a catalog change (new product added while targeting mode is
 * 'all', product published into an included collection, product deleted)
 * never invalidated the cache and the try-on button wouldn't appear on new
 * products until the merchant re-saved settings. Bumping config_version here
 * feeds the existing invalidation path: next widget revalidation misses the
 * ETag, refetches handles from Shopify, and picks up the catalog change.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const { data: store } = await supabaseAdmin
      .from("vto_stores")
      .select("config_version")
      .eq("shop_domain", shop)
      .maybeSingle();

    if (store) {
      const { error } = await supabaseAdmin
        .from("vto_stores")
        .update({ config_version: (Number(store.config_version) || 0) + 1 })
        .eq("shop_domain", shop);
      if (error) {
        console.error(
          `[${topic}] Failed to bump config_version for ${shop}:`,
          error.message,
        );
      }
    }
  } catch (err) {
    console.error(`[${topic}] Exception bumping config_version for ${shop}:`, err);
    // Do not rethrow — Shopify expects a 200 response
  }

  // New or changed product → re-read the print side, but ONLY when the product's
  // photos actually moved. products/update also fires on inventory, price, tags,
  // publish state and app metafield writes; kicking a scan on those burnt a
  // catalog enumeration and a classifier call to reach the answer it already
  // had. shouldRescanProduct answers from the payload plus one indexed row read,
  // and rejects a non-garment without touching the database at all.
  if (topic === "PRODUCTS_CREATE" || topic === "PRODUCTS_UPDATE") {
    try {
      const decision = await shouldRescanProduct(shop, (payload ?? {}) as ProductWebhookPayload, {
        isCreate: topic === "PRODUCTS_CREATE",
      });
      console.log(
        `[${topic}] print scan ${decision.kick ? "KICK" : "skip"} for ${shop} ${decision.gid ?? "?"}: ${decision.reason}`,
      );
      if (decision.kick) kickPrintScan(shop, "webhook", decision.gid);
    } catch (err) {
      // The gate is an optimisation, never a gatekeeper on correctness: if it
      // throws, fall back to the old behaviour rather than skipping a product
      // whose photo really did change.
      console.error(`[${topic}] rescan gate failed for ${shop}, kicking anyway:`, err);
      const gid = (payload as { admin_graphql_api_id?: string } | null)?.admin_graphql_api_id ?? null;
      kickPrintScan(shop, "webhook", gid);
    }
  }

  return new Response();
};
