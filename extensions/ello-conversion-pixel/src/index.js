// `register` MUST be imported from @shopify/web-pixels-extension — it is NOT a
// runtime global. Relying on a global throws "register is not defined" inside the
// sandbox worker, which silently kills all event tracking.
import { register } from "@shopify/web-pixels-extension";

register(({ analytics, browser, settings }) => {
  const storeSlug = settings.store_slug;
  // backend_url is the FULL endpoint — afterAuth stores SHOPIFY_APP_URL + "/api/cart-purchase-event".
  // Do NOT append the path again here, or it doubles to
  // /api/cart-purchase-event/api/cart-purchase-event and 404s.
  const BACKEND =
    settings.backend_url ||
    "https://ello-vto-public-13593516897-u5htiuxfrq-uc.a.run.app/api/cart-purchase-event";

  // browser.cookie.get is ASYNC in the Web Pixels API — it returns Promise<string>
  // (the cookie value directly, no `.value` property). Must be awaited.
  async function getSessionId() {
    try {
      return (await browser.cookie.get("ello_session_id")) || null;
    } catch {
      return null;
    }
  }

  // The widget loader mints the ello_session_id cookie the moment its script
  // parses, but Shopify can deliver the first events of a brand-new session
  // before that script has run. Dropping those events on a missing cookie
  // silently erased the FIRST product view of every fresh session — the
  // biggest single hole in the funnel data. Instead, wait briefly for the
  // cookie to appear: checks at 0s / 0.5s / 1.5s / 3s, then give up.
  async function getSessionIdWithRetry() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const sid = await getSessionId();
      if (sid) return sid;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
    return getSessionId();
  }

  function send(payload) {
    browser.sendBeacon(BACKEND, JSON.stringify(payload));
  }

  // Track product page views — intent signal after a try-on.
  // Deduplicated server-side: only the first view per session+product is stored.
  analytics.subscribe("product_viewed", async (event) => {
    const sessionId = await getSessionIdWithRetry();
    if (!sessionId || !storeSlug) return;

    const product = event.data?.productVariant;
    send({
      event_type: "view",
      session_id: sessionId,
      store_slug: storeSlug,
      product_id: product?.product?.id ?? null,
      variant_id: product?.id ?? null,
    });
  });

  // Track any add-to-cart anywhere on the site (not just inside the widget).
  analytics.subscribe("product_added_to_cart", async (event) => {
    const sessionId = await getSessionIdWithRetry();
    if (!sessionId || !storeSlug) return;

    const item = event.data?.cartLine;
    send({
      event_type: "cart",
      session_id: sessionId,
      store_slug: storeSlug,
      product_id: item?.merchandise?.product?.id ?? null,
      variant_id: item?.merchandise?.id ?? null,
      quantity: item?.quantity ?? 1,
    });
  });

  // Track completed purchases.
  analytics.subscribe("checkout_completed", async (event) => {
    const checkout = event.data?.checkout;
    if (!checkout || !storeSlug) return;

    // Prefer cookie (works even without cart attributes); fall back to the
    // cart attribute the widget writes (checkout.attributes — NOT order.customAttributes).
    let sessionId = await getSessionId();
    if (!sessionId) {
      sessionId =
        checkout.attributes?.find((a) => a.key === "ello_session_id")?.value ??
        null;
    }
    if (!sessionId) return;

    // line_price = finalLinePrice: unit price × quantity after LINE-level
    // discounts, before shipping/taxes.
    //
    // CAUTION (Atlas audit 2026-07-31): finalLinePrice does NOT reflect
    // order-level discount codes (sitewide "10% off" etc.) — those only reduce
    // subtotalPrice and show up per line in discountAllocations. Billing on
    // line_price alone overstated Qualified Revenue ~21% on a store that runs
    // sitewide codes on most orders. So each line also carries line_discount =
    // the sum of its discountAllocations. The SQL basis cascade
    // (20260731_qualified_revenue_discount_netting.sql) uses it only when every
    // line has it AND Σ(line_price − line_discount) reconciles to
    // subtotal_price within $0.05 — so if a Pixels API version ever makes
    // finalLinePrice allocation-inclusive (double-count risk), the reconcile
    // check fails closed and billing falls back to proportional netting
    // against subtotal_price.
    //
    // line_discount is null (not 0) when the API doesn't expose allocations,
    // so SQL can tell "no discount" from "no data".
    const lineItems =
      checkout.lineItems?.map((li) => ({
        product_id: li.variant?.product?.id ?? null,
        variant_id: li.variant?.id ?? null,
        quantity: li.quantity ?? 1,
        line_price: li.finalLinePrice?.amount ?? null,
        line_discount: Array.isArray(li.discountAllocations)
          ? li.discountAllocations.reduce(
              (sum, d) => sum + (Number(d?.amount?.amount) || 0),
              0,
            )
          : null,
        title: li.title ?? null,
      })) ?? [];

    send({
      event_type: "purchase",
      session_id: sessionId,
      store_slug: storeSlug,
      order_id: checkout.order?.id ?? null,
      total_price: checkout.totalPrice?.amount ?? null,
      // Merchandise total after discounts, before shipping/taxes — the
      // order-level cross-check for the line_price sum.
      subtotal_price: checkout.subtotalPrice?.amount ?? null,
      currency: checkout.totalPrice?.currencyCode ?? null,
      line_items: lineItems,
    });
  });
});
