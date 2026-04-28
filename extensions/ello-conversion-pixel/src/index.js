// register is a global provided by Shopify's web pixel runtime — no import needed
register(({ analytics, browser, settings }) => {
  const storeSlug = settings.store_slug;
  const BACKEND =
    settings.backend_url ||
    "https://ello-vto-public-13593516897-u5htiuxfrq-uc.a.run.app";

  function getSessionId() {
    return browser.cookie.get("ello_session_id")?.value ?? null;
  }

  function send(payload) {
    browser.sendBeacon(
      `${BACKEND}/api/cart-purchase-event`,
      JSON.stringify(payload)
    );
  }

  // Track product page views — intent signal after a try-on.
  // Deduplicated server-side: only the first view per session+product is stored.
  analytics.subscribe("product_viewed", (event) => {
    const sessionId = getSessionId();
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
  analytics.subscribe("product_added_to_cart", (event) => {
    const sessionId = getSessionId();
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
  analytics.subscribe("checkout_completed", (event) => {
    const checkout = event.data?.checkout;
    if (!checkout || !storeSlug) return;

    // Prefer cookie (works even without cart attributes); fall back to order attribute.
    let sessionId = getSessionId();
    if (!sessionId) {
      sessionId =
        checkout.order?.customAttributes?.find(
          (a) => a.key === "ello_session_id"
        )?.value ?? null;
    }
    if (!sessionId) return;

    const lineItems =
      checkout.lineItems?.map((li) => ({
        product_id: li.variant?.product?.id ?? null,
        variant_id: li.variant?.id ?? null,
        quantity: li.quantity ?? 1,
      })) ?? [];

    send({
      event_type: "purchase",
      session_id: sessionId,
      store_slug: storeSlug,
      order_id: checkout.order?.id ?? null,
      total_price: checkout.totalPrice?.amount ?? null,
      currency: checkout.totalPrice?.currencyCode ?? null,
      line_items: lineItems,
    });
  });
});
