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
 *
 * DEBUGGING A BUG A REP HIT ON THEIR PHONE
 *   node demo-launch.mjs --deployed --mobile "<prospect PDP url>"
 * `--deployed --mobile` is the faithful repro of the iOS Shortcut: the LIVE
 * widget bundle, on an iPhone UA/viewport/touch profile, with devtools attached.
 * Then run `__elloDiag()` in the console after clicking "Try it on" to see which
 * hero-swap gate closed. Add --webkit if it only repros in real Safari.
 */
import { chromium, webkit, devices } from 'playwright';
import { Buffer } from 'node:buffer';

const DEFAULT_URL = 'https://spanx.com/products/spanx-airessentials-half-zip';
const LOCAL_ORIGIN = 'http://127.0.0.1:3000';   // where `npm run vite -- --host` serves the patched build (Node reaches this)
const PROXY_ORIGIN = 'https://ello-demo.test'; // fake https host the widget loads from (.test never resolves / no mDNS); fulfilled from LOCAL_ORIGIN below

// ── Flags (order-independent; the first non-flag arg is the URL) ────────────
//   --mobile   emulate an iPhone: iOS Safari UA + touch + 390px viewport.
//              This is what widget-main.js's detectDevice() keys `isMobile` off
//              (mobileUserAgents && isTouchDevice && viewport <= 768), so it is
//              the ONLY way to hit the phone code path with a console attached.
//              Reproduces layout/gallery/mobile-branch bugs.
//   --webkit   run the real Safari engine instead of Chromium. Pair with
//              --mobile for a true mobile-Safari repro. Needs a one-time
//              `npx playwright install webkit`. Use when a bug does NOT
//              reproduce under --mobile alone — that points at the engine
//              (WebKit image decoding, srcset picking, CSS) rather than layout.
//   --deployed inject the LIVE https://widget.ellotryon.com/demo-bookmarklet.js
//              instead of local vite. No `npm run vite` needed and no proxy —
//              this is byte-for-byte what the iOS Shortcut / bookmarklet runs on
//              a real phone, so it is the correct mode for reproducing a bug a
//              rep hit in the field. Use local (default) only when you are
//              testing an UNDEPLOYED code change.
const argv = process.argv.slice(2);
const MOBILE = argv.includes('--mobile');
const USE_WEBKIT = argv.includes('--webkit');
const DEPLOYED = argv.includes('--deployed');
const url = argv.find((a) => !a.startsWith('--')) || DEFAULT_URL;
// Where the demo engine (and therefore the whole widget chain) is loaded from.
const INJECT_ORIGIN = DEPLOYED ? 'https://widget.ellotryon.com' : PROXY_ORIGIN;

const log = (...a) => console.log('[ello-demo]', ...a);

// Preflight: a dead :3000 is the #1 cause of a blank demo. Fail loudly first.
// Skipped under --deployed, which never touches vite.
if (DEPLOYED) {
  log('source: DEPLOYED', INJECT_ORIGIN, '(vite not needed)');
} else {
  try {
    const ping = await fetch(`${LOCAL_ORIGIN}/widget.html`, { method: 'HEAD' });
    if (!ping.ok) throw new Error('HTTP ' + ping.status);
    log('vite is up on :3000 ✓');
  } catch (e) {
    console.error(`\n[ello-demo] ✗ ${LOCAL_ORIGIN} is not serving the widget (${e.message}).`);
    console.error('[ello-demo]   Start it first:  npm run vite -- --host   (leave it running), then re-run this.');
    console.error('[ello-demo]   Or reproduce against the LIVE widget instead:  node demo-launch.mjs --deployed "<url>"\n');
    process.exit(1);
  }
}

const engine = USE_WEBKIT ? webkit : chromium;
const browser = await engine.launch({
  headless: false,
  // Chromium-only flags; WebKit rejects unknown args, so only pass them there.
  args: USE_WEBKIT ? [] : (MOBILE ? [] : ['--start-maximized', '--disable-blink-features=AutomationControlled']),
});

// bypassCSP kills header + <meta> CSP for the whole context. viewport:null uses
// the full maximized window (desktop only — a device descriptor sets its own).
// `defaultBrowserType` is dropped: it's metadata for the device registry, not a
// newContext option.
let contextOpts = { bypassCSP: true, viewport: null };
if (MOBILE) {
  const { defaultBrowserType, ...device } = devices['iPhone 13'];
  contextOpts = { ...device, bypassCSP: true };
}
const context = await browser.newContext(contextOpts);

// Proxy the fake https origin to the local vite server. This is what makes the
// local widget load onto an https store page without tripping mixed-content /
// Private Network Access — Playwright fulfills the request itself, no real hop.
if (!DEPLOYED) await context.route(PROXY_ORIGIN + '/**', async (route) => {
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

// Re-inject the demo engine on EVERY navigation so the widget survives clicking
// around the store (a full-page nav drops the old injection). addInitScript runs
// on each fresh document before the page's own scripts; bypassCSP lets the
// external <script> load. Guard to the top frame + boot-once per document.
await context.addInitScript((origin) => {
  if (window.top !== window.self) return;               // top frame only
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return;  // skip about:blank startup doc
  var inject = function () {
    if (window.__ELLO_DEMO_BOOTED__ || window.__elloDemo) return;
    var s = document.createElement('script');
    s.src = origin + '/demo-bookmarklet.js?t=' + Date.now();
    (document.head || document.documentElement).appendChild(s);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();
}, INJECT_ORIGIN);

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
// KEY NOTE: demo-bookmarklet.js reads `ello_demo_settings_v2` — the unversioned
// `ello_demo_settings` this used to write was silently ignored (harmless while
// the v2 DEFAULT is already 'mirror', but it meant this line never did anything).
await page.evaluate(() => {
  try { localStorage.setItem('ello_demo_settings_v2', JSON.stringify({ mode: 'mirror' })); } catch (e) {}
});

// Inject the demo engine from the PROXY origin (fire-and-forget, like the real
// bookmarklet). Everything downstream — widget-loader, widget-main.js,
// widget.html, /api/widget-config, /tryon — chains off this https origin and
// routes through the proxy to vite.
await page.evaluate((origin) => {
  if (window.__ELLO_DEMO_BOOTED__ || window.__elloDemo) return;   // addInitScript already handled this document
  var s = document.createElement('script');
  s.src = origin + '/demo-bookmarklet.js?t=' + Date.now();
  s.onerror = () => console.error('[ello-demo] demo-bookmarklet.js failed to load via proxy — check the terminal for "proxy error".');
  (document.head || document.documentElement).appendChild(s);
}, INJECT_ORIGIN);
log("demo engine injected from", INJECT_ORIGIN);

// ── __elloDiag() — why did/didn't the hero swap fire? ──────────────────────
// elloPdpSwapOn() has four independent ways to return false, and when it does
// the try-on silently falls back to the in-panel result ("add it to your
// wardrobe") with no hero swap and no badge — indistinguishable symptoms.
// widget-main.js runs inside an IIFE, so its internals are NOT on window; the
// real numbers come from window.__elloWidget.debugPdpSwap(), added for this.
// NOTE: that export ships with widget-main.js, so under --deployed it only
// exists once the app is deployed. Local (default) mode has it immediately.
await page.evaluate(() => {
  window.__elloDiag = function () {
    var w = window.__elloWidget;
    if (!w) { console.log('[ello-diag] widget-main.js has not loaded yet.'); return null; }
    if (!w.debugPdpSwap) { console.log('[ello-diag] this widget build predates debugPdpSwap() — run without --deployed, or deploy first.'); return null; }
    var d = w.debugPdpSwap();
    console.log('[ello-diag]', JSON.stringify(d, null, 2));
    return d;
  };
});

log('----------------------------------------------------------------');
log(`mode: ${MOBILE ? 'MOBILE (iPhone 13 emulation)' : 'desktop'} · engine: ${USE_WEBKIT ? 'WebKit (Safari)' : 'Chromium'}`);
log('Ready. In the browser window: upload your photo → click "Try it on".');
if (MOBILE) log('Debugging: open devtools and run  __elloDiag()  AFTER clicking Try it on.');
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
