/**
 * Ello VTO — DEMO LAUNCHER for strict-CSP / headless stores (Spanx, etc.).
 * ---------------------------------------------------------------------------
 * TWO browser walls this clears:
 *   1. CSP — some stores ship a <meta http-equiv="Content-Security-Policy">
 *      (not just a header) that extensions can't strip. `bypassCSP: true`
 *      disables header AND meta CSP for the context.
 *   2. Loading the local widget onto an https store page. Pulling
 *      http://127.0.0.1:3000 subresources into an https page is blocked by
 *      mixed-content + Private Network Access, and launch flags don't reliably
 *      override it. So we DON'T load over the network: the widget is served from
 *      a fake **https** origin (PROXY_ORIGIN) that Playwright fulfills straight
 *      from the local vite server via route interception — no real network hop,
 *      so none of those rules apply. The loader derives its base URL from its own
 *      https origin, so config + /tryon route through the proxy too.
 *
 * PREREQ (one time)
 *   1. `npm i -D playwright`  →  `npx playwright install chromium`
 *   2. `npm run vite -- --host`  (serves the patched widget on :3000; leave running)
 *
 * RUN
 *   node demo-launch.mjs
 *   node demo-launch.mjs "https://spanx.com/products/spanx-airessentials-half-zip?Color=Powder&Size=XS"
 *
 * A real Chrome window opens on the prospect's page with the demo injected.
 * Upload your photo → Try it on → record. Close the window when done.
 */
import { chromium } from 'playwright';
import { Buffer } from 'node:buffer';

const DEFAULT_URL = 'https://spanx.com/products/spanx-airessentials-half-zip';
const LOCAL_ORIGIN = 'http://127.0.0.1:3000';   // where `npm run vite -- --host` serves the patched build (Node reaches this)
const PROXY_ORIGIN = 'https://ello-demo.test'; // fake https host the widget loads from (.test never resolves / no mDNS); fulfilled from LOCAL_ORIGIN below
const url = process.argv[2] || DEFAULT_URL;

const log = (...a) => console.log('[ello-demo]', ...a);

// Preflight: a dead :3000 is the #1 cause of a blank demo. Fail loudly first.
try {
  const ping = await fetch(`${LOCAL_ORIGIN}/widget.html`, { method: 'HEAD' });
  if (!ping.ok) throw new Error('HTTP ' + ping.status);
  log('vite is up on :3000 ✓');
} catch (e) {
  console.error(`\n[ello-demo] ✗ ${LOCAL_ORIGIN} is not serving the widget (${e.message}).`);
  console.error('[ello-demo]   Start it first:  npm run vite -- --host   (leave it running), then re-run this.\n');
  process.exit(1);
}

const browser = await chromium.launch({
  headless: false,
  args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
});

// bypassCSP kills header + <meta> CSP for the whole context. viewport:null uses
// the full maximized window.
const context = await browser.newContext({ bypassCSP: true, viewport: null });

// Proxy the fake https origin to the local vite server. This is what makes the
// local widget load onto an https store page without tripping mixed-content /
// Private Network Access — Playwright fulfills the request itself, no real hop.
await context.route(PROXY_ORIGIN + '/**', async (route) => {
  const req = route.request();
  const path = req.url().slice(PROXY_ORIGIN.length) || '/';
  try {
    const headers = { ...req.headers() };
    for (const h of ['host', 'origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest']) delete headers[h];
    const init = { method: req.method(), headers };
    if (!['GET', 'HEAD'].includes(req.method())) {
      const pd = req.postDataBuffer();
      if (pd) init.body = pd;
    }
    const r = await fetch(LOCAL_ORIGIN + path, init);
    const body = Buffer.from(await r.arrayBuffer());
    const outHeaders = {};
    r.headers.forEach((v, k) => {
      if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k.toLowerCase())) return;
      outHeaders[k] = v;
    });
    outHeaders['access-control-allow-origin'] = '*';
    await route.fulfill({ status: r.status, headers: outHeaders, body });
  } catch (e) {
    log('proxy error', path, e.message);
    try { await route.abort(); } catch (_) {}
  }
});

const page = await context.newPage();

// Surface the widget's own logs so you can see it working / failing.
page.on('console', (m) => {
  const t = m.text();
  if (/ello|widget|tryon|virtualTryon/i.test(t)) log('page:', t);
});

log('opening', url);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

// Default to MIRROR mode (result swaps onto the store's hero photo). Fresh
// profile each run, so set it explicitly. Change to 'popup' for the widget demo.
await page.evaluate(() => {
  try { localStorage.setItem('ello_demo_settings', JSON.stringify({ mode: 'mirror' })); } catch (e) {}
});

// Inject the demo engine from the PROXY origin (fire-and-forget, like the real
// bookmarklet). Everything downstream — widget-loader, widget-main.js,
// widget.html, /api/widget-config, /tryon — chains off this https origin and
// routes through the proxy to vite.
await page.evaluate((origin) => {
  var s = document.createElement('script');
  s.src = origin + '/demo-bookmarklet.js?t=' + Date.now();
  s.onerror = () => console.error('[ello-demo] demo-bookmarklet.js failed to load via proxy — check the terminal for "proxy error".');
  (document.head || document.documentElement).appendChild(s);
}, PROXY_ORIGIN);
log('demo engine injected via proxy →', LOCAL_ORIGIN);

log('----------------------------------------------------------------');
log('Ready. In the browser window: upload your photo → click "Try it on".');
log('To try a specific color, re-run with a ?Color=…&Size=… URL.');
log('Close the window (or press Ctrl-C here) when you are done recording.');
log('----------------------------------------------------------------');

// Keep the process alive until the window/browser is closed.
await new Promise((resolve) => {
  browser.on('disconnected', resolve);
  page.on('close', resolve);
});
log('window closed — exiting.');
process.exit(0);
