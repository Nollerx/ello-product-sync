import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../lib/supabase.server";

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
  const { shop, topic } = await authenticate.webhook(request);

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

  return new Response();
};
