/**
 * SFCC test harness — a fake Salesforce B2C Commerce (SFRA) storefront for
 * exercising public/ello-sfcc.js WITHOUT a real SFCC sandbox.
 *
 * What it fakes, faithfully enough to test against:
 *   - An SFRA PDP DOM contract: .product-detail[data-pid], hidden
 *     input.add-to-cart-url, color swatches + size <select> whose values are
 *     Product-Variation URLs, a .minicart badge, site jQuery.
 *   - GET  /on/demandware.store/Sites-test-Site/en_US/Product-Variation
 *     → the SFRA client-side product model JSON (variationAttributes,
 *       images.large, price.sales, readyToOrder, id).
 *   - POST /on/demandware.store/Sites-test-Site/en_US/Cart-AddProduct
 *     → SFRA JSON response ({error, message, quantityTotal, pliUUID, cart}).
 *   - A second PDP that carries schema.org ProductGroup JSON-LD instead
 *     (the PacSun/Tillys/Coach shape) to test the JSON-LD path.
 *
 * Run:  node dev/sfcc-harness.mjs          (port 8912)
 * Needs the widget served locally:  npm run vite   (port 3000)
 *   — or set ELLO_WIDGET_ORIGIN to a deployed origin.
 *
 * Pages set window.__ELLO_DEMO__ = true (same as the demo bookmarklet) and use
 * the ello-dev-store slug, so config + try-on auth resolve exactly like a demo.
 */
import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 8912);
const WIDGET_ORIGIN = process.env.ELLO_WIDGET_ORIGIN || 'http://localhost:3000';
const STORE_SLUG = process.env.ELLO_STORE_SLUG || 'ello-dev-store';

// Public image URLs on purpose: the render engine fetches garment images
// server-side, so localhost URLs could never produce an actual try-on.
const IMAGES = {
  M001: {
    BLACK: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=800&q=80',
    WHITE: 'https://images.unsplash.com/photo-1581655353564-df123a1eb820?w=800&q=80',
  },
  LD99: 'https://images.unsplash.com/photo-1551028719-00167b16eac5?w=800&q=80',
};

let cartCount = 0;
let pliSeq = 0;
const cartLog = [];

const SITE_BASE = '/on/demandware.store/Sites-test-Site/en_US';

function pvUrl(color, size) {
  const p = new URLSearchParams({ pid: 'M001', quantity: '1' });
  if (color) p.set('dwvar_M001_color', color);
  if (size) p.set('dwvar_M001_size', size);
  return `${SITE_BASE}/Product-Variation?${p.toString()}`;
}

// ── SFRA product model for M001 (Classic Tee: 2 colors × 3 sizes) ───────────
function productModel(color, size) {
  const colors = ['BLACK', 'WHITE'];
  const sizes = ['S', 'M', 'L'];
  const resolved = Boolean(color && size);
  return {
    action: 'Product-Variation',
    product: {
      id: resolved ? `M001_${color}_${size}` : 'M001',
      productName: 'Harness Classic Tee',
      productType: resolved ? 'variant' : 'master',
      readyToOrder: resolved,
      available: true,
      price: { sales: { value: 24, currency: 'USD', formatted: '$24.00' } },
      images: {
        large: [{ url: IMAGES.M001[color || 'BLACK'], alt: 'Harness Classic Tee' }],
        small: [{ url: IMAGES.M001[color || 'BLACK'], alt: 'Harness Classic Tee' }],
      },
      variationAttributes: [
        {
          attributeId: 'color', displayName: 'Color', id: 'color', swatchable: true,
          values: colors.map((c) => ({
            id: c, displayValue: c === 'BLACK' ? 'Black' : 'White',
            selected: c === color, selectable: true,
            url: pvUrl(c, size),
            images: { swatch: [{ url: IMAGES.M001[c], alt: c }] },
          })),
        },
        {
          attributeId: 'size', displayName: 'Size', id: 'size',
          values: sizes.map((s) => ({
            id: s, displayValue: s,
            selected: s === size,
            // L is deliberately sold out in BLACK to test availability gating.
            selectable: !(s === 'L' && (color || 'BLACK') === 'BLACK'),
            url: pvUrl(color, s),
          })),
        },
      ],
      selectedQuantity: 1,
    },
    resources: {},
  };
}

// ── Shared page chrome ──────────────────────────────────────────────────────
function pageShell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta property="og:title" content="${title}">
<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
<style>
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; margin: 0; color: #111; }
  header { display: flex; justify-content: space-between; align-items: center; padding: 14px 22px; border-bottom: 1px solid #e5e7eb; }
  .minicart { position: relative; font-weight: 600; }
  .minicart-quantity { display: inline-block; min-width: 22px; text-align: center; background: #111; color: #fff; border-radius: 999px; padding: 2px 7px; margin-left: 6px; }
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; max-width: 980px; margin: 32px auto; padding: 0 22px; }
  main img { width: 100%; border-radius: 10px; background: #f4f4f5; }
  .swatches a { display: inline-block; width: 34px; height: 34px; border-radius: 50%; border: 2px solid #d4d4d8; margin-right: 8px; }
  .swatches a.selected { border-color: #111; }
  select, button { font: inherit; padding: 10px 14px; border-radius: 8px; border: 1px solid #d4d4d8; }
  button.add-to-cart { background: #111; color: #fff; border: none; cursor: pointer; }
  button[data-ello-tryon] { background: #2563eb; color: #fff; border: none; cursor: pointer; }
  #harness-log { grid-column: 1 / -1; background: #0b1220; color: #a5f3fc; font: 12px/1.6 ui-monospace, monospace; border-radius: 10px; padding: 14px 16px; min-height: 90px; white-space: pre-wrap; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin: 14px 0; }
</style>
</head>
<body>
<header>
  <strong>HARNESS&nbsp;SFCC&nbsp;STORE</strong>
  <div class="minicart">Cart<span class="minicart-quantity">${cartCount}</span></div>
</header>
${body}
<script>
  window.__ELLO_DEMO__ = true;   // same posture as the demo bookmarklet
  window.__ELLO_DEBUG__ = true;
  // The loader's localhost dev-mode derives its base from the PAGE origin —
  // which is this harness, not the widget server. Same override the demo
  // bookmarklet uses to pin every widget asset/API call to the vite origin.
  try { localStorage.setItem('ello_dev_origin', '${WIDGET_ORIGIN}'); } catch (e) { }
  function hlog(msg) {
    var el = document.getElementById('harness-log');
    if (el) el.textContent += '[' + new Date().toISOString().slice(11, 19) + '] ' + msg + '\\n';
  }
  // Prove the adapter re-fires the site's OWN jQuery events after add-to-cart —
  // this is exactly what a brand's minicart drawer listens for.
  $('.minicart').on('count:update', function (e, data) {
    hlog('jQuery count:update fired · quantityTotal=' + (data && data.quantityTotal));
    if (data && data.quantityTotal != null) $('.minicart-quantity').text(data.quantityTotal);
  });
  $('body').on('product:afterAddToCart', function (e, data) {
    hlog('jQuery product:afterAddToCart fired · pliUUID=' + (data && data.pliUUID));
  });
</script>
<script src="${WIDGET_ORIGIN}/widget-loader.js" data-store-slug="${STORE_SLUG}" defer></script>
<script src="${WIDGET_ORIGIN}/ello-sfcc.js" data-store-slug="${STORE_SLUG}" defer></script>
</body>
</html>`;
}

// ── PDP #1: pure SFRA (NO JSON-LD) → exercises the Product-Variation path ───
function sfraPdp() {
  const body = `
<main>
  <div>
    <img id="pdp-hero" src="${IMAGES.M001.BLACK}" alt="Harness Classic Tee">
  </div>
  <div class="product-detail product-wrapper" data-pid="M001">
    <h1 class="product-name">Harness Classic Tee</h1>
    <div class="prices"><span class="value">$24.00</span></div>
    <div class="attribute swatches" data-attr="color">
      <a href="javascript:void(0)" class="color-attribute selected" aria-checked="true"
         data-url="${pvUrl('BLACK', null)}" style="background:#111" title="Black"></a>
      <a href="javascript:void(0)" class="color-attribute"
         data-url="${pvUrl('WHITE', null)}" style="background:#fafafa" title="White"></a>
    </div>
    <div class="attribute" data-attr="size" style="margin:14px 0">
      <select class="select-size" id="size-select">
        <option value="">Select size</option>
        <option value="${pvUrl('BLACK', 'S')}">S</option>
        <option value="${pvUrl('BLACK', 'M')}">M</option>
        <option value="${pvUrl('BLACK', 'L')}" disabled>L — sold out</option>
      </select>
    </div>
    <input type="hidden" class="add-to-cart-url" value="${SITE_BASE}/Cart-AddProduct">
    <div class="row">
      <button class="add-to-cart">Add to Cart (native)</button>
      <button data-ello-tryon="1">✨ Try it on — Ello</button>
    </div>
    <div class="row">
      <button id="t-debug">debug()</button>
      <button id="t-hook-m">ELLO_CART_HOOK size M</button>
      <button id="t-order">trackOrder()</button>
    </div>
  </div>
  <pre id="harness-log"></pre>
</main>
<script>
  // Native site behavior stub: swatch/select clicks just log (a real SFRA site
  // AJAX-rerenders; the adapter listens to the same events and rebuilds).
  $('.add-to-cart').on('click', function () {
    hlog('native add-to-cart clicked (harness stub — does nothing)');
  });
  document.getElementById('t-debug').addEventListener('click', function () {
    var d = window.ElloSFCC && window.ElloSFCC.debug();
    hlog('debug: ' + JSON.stringify(d && {
      sfcc: d.sfcc, site: d.site, source: d.source, handle: d.handle, atcUrl: d.atcUrl,
      product: d.product && { name: d.product.name, image: d.product.image_url, variants: d.product.variants.length },
      options: d.productJson && d.productJson.options
    }, null, 1));
  });
  document.getElementById('t-hook-m').addEventListener('click', function () {
    var d = window.ElloSFCC.debug();
    var m = d.productJson && d.productJson.variants.find(function (v) { return v.option1 === 'M'; });
    if (!m) return hlog('no size-M variant in productJson yet — click debug() first');
    hlog('calling ELLO_CART_HOOK with ' + m.id.slice(0, 60) + '…');
    window.ELLO_CART_HOOK({ variantId: m.id, quantity: 1 })
      .then(function (r) { hlog('cart hook OK · quantityTotal=' + r.quantityTotal + ' pliUUID=' + r.pliUUID); })
      .catch(function (e) { hlog('cart hook FAILED: ' + e.message); });
  });
  document.getElementById('t-order').addEventListener('click', function () {
    var ok = window.ElloSFCC.trackOrder({
      orderId: 'HARNESS-' + Date.now(), total: 24, subtotal: 24, currency: 'USD',
      items: [{ variantId: 'M001_BLACK_M', quantity: 1, linePrice: 24, title: 'Harness Classic Tee' }]
    });
    hlog('trackOrder → ' + ok + ' (check vite /api/cart-purchase-event logs)');
  });
</script>`;
  return pageShell('Harness Classic Tee | HARNESS SFCC', body);
}

// ── PDP #2: JSON-LD ProductGroup (the PacSun/Tillys/Coach shape) ────────────
function ldPdp() {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'ProductGroup',
    name: 'Harness Varsity Jacket',
    productGroupID: 'LD99',
    url: `http://localhost:${PORT}/p/varsity-jacket-LD99.html`,
    image: IMAGES.LD99,
    variesBy: ['size'],
    hasVariant: ['S', 'M', 'L'].map((s) => ({
      '@type': 'Product',
      name: 'Harness Varsity Jacket',
      sku: `LD99_NAVY_${s}`,
      size: s,
      color: 'Navy',
      image: IMAGES.LD99,
      offers: { '@type': 'Offer', price: 89, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
    })),
  };
  const body = `
<main>
  <div><img src="${IMAGES.LD99}" alt="Harness Varsity Jacket"></div>
  <div class="product-detail" data-pid="LD99">
    <h1>Harness Varsity Jacket</h1>
    <div class="prices"><span class="value">$89.00</span></div>
    <input type="hidden" class="add-to-cart-url" value="${SITE_BASE}/Cart-AddProduct">
    <div class="row">
      <button data-ello-tryon="1">✨ Try it on — Ello</button>
      <button id="t-debug">debug()</button>
      <button id="t-hook">ELLO_CART_HOOK size M</button>
    </div>
  </div>
  <pre id="harness-log"></pre>
</main>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<script>
  document.getElementById('t-debug').addEventListener('click', function () {
    var d = window.ElloSFCC && window.ElloSFCC.debug();
    hlog('debug: ' + JSON.stringify(d && {
      source: d.source, handle: d.handle,
      product: d.product && { name: d.product.name, variants: d.product.variants.length },
      options: d.productJson && d.productJson.options
    }));
  });
  document.getElementById('t-hook').addEventListener('click', function () {
    window.ELLO_CART_HOOK({ variantId: 'LD99_NAVY_M', quantity: 1 })
      .then(function (r) { hlog('cart hook OK · quantityTotal=' + r.quantityTotal); })
      .catch(function (e) { hlog('cart hook FAILED: ' + e.message); });
  });
</script>`;
  return pageShell('Harness Varsity Jacket | HARNESS SFCC', body);
}

function indexPage() {
  return pageShell('HARNESS SFCC STORE', `
<main>
  <div style="grid-column:1/-1">
    <h1>SFCC harness</h1>
    <p>Widget origin: <code>${WIDGET_ORIGIN}</code> · slug: <code>${STORE_SLUG}</code> · cart adds so far: ${cartCount}</p>
    <ul>
      <li><a href="/p/classic-tee-M001.html">Classic Tee — SFRA path (data-pid + Product-Variation, no JSON-LD)</a></li>
      <li><a href="/p/varsity-jacket-LD99.html">Varsity Jacket — JSON-LD ProductGroup path</a></li>
    </ul>
    <p>Cart log: <code>${JSON.stringify(cartLog.slice(-5))}</code></p>
  </div>
</main>`);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, type, body) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };

  if (u.pathname === '/') return send(200, 'text/html', indexPage());
  if (u.pathname === '/p/classic-tee-M001.html') return send(200, 'text/html', sfraPdp());
  if (u.pathname === '/p/varsity-jacket-LD99.html') return send(200, 'text/html', ldPdp());

  if (u.pathname === `${SITE_BASE}/Product-Variation`) {
    const color = u.searchParams.get('dwvar_M001_color');
    const size = u.searchParams.get('dwvar_M001_size');
    return send(200, 'application/json', JSON.stringify(productModel(color, size)));
  }

  if (u.pathname === `${SITE_BASE}/Cart-AddProduct` && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const form = new URLSearchParams(raw);
      const pid = form.get('pid');
      const qty = Number(form.get('quantity') || 1);
      // A resolved variant pid looks like M001_BLACK_M / LD99_NAVY_M — reject
      // masters exactly like real SFRA cartHelpers would.
      if (!pid || !/_(S|M|L)$/.test(pid)) {
        cartLog.push({ pid, ok: false });
        return send(200, 'application/json', JSON.stringify({
          error: true, message: `Not a purchasable variant: ${pid}`,
        }));
      }
      cartCount += qty;
      pliSeq += 1;
      cartLog.push({ pid, qty, ok: true });
      console.log(`[harness] Cart-AddProduct pid=${pid} qty=${qty} → total ${cartCount}`);
      return send(200, 'application/json', JSON.stringify({
        error: false,
        message: 'Product added to basket',
        quantityTotal: cartCount,
        pliUUID: `harness-pli-${pliSeq}`,
        cart: { numItems: cartCount },
        reportingURL: `/harness/reporting?pid=${encodeURIComponent(pid)}`,
        minicartCountOfItems: `${cartCount} items`,
      }));
    });
    return;
  }

  if (u.pathname === '/harness/reporting') {
    console.log(`[harness] reporting beacon fired: ${u.searchParams.get('pid')}`);
    return send(204, 'text/plain', '');
  }

  send(404, 'text/plain', 'not found');
});

server.listen(PORT, () => {
  console.log(`[harness] fake SFCC store on http://localhost:${PORT}`);
  console.log(`[harness] widget origin: ${WIDGET_ORIGIN} (run \`npm run vite\` for local widget)`);
});
