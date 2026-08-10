// Which image does mirror mode target on gohaus — desktop vs iPhone?
// Uses demo-launch.mjs's proxy trick so the LOCAL widget (which has
// debugPdpSwap) can load onto an https store page. No try-on needed:
// elloFindPdpImage() does not depend on the selected garment.
import { chromium, devices } from 'playwright';
import { Buffer } from 'node:buffer';

const URL = process.argv[2] || 'https://gohaus.com/products/baselayer-shortsleeve';
const LOCAL = 'http://127.0.0.1:3000';
const PROXY = 'https://ello-demo.test';

async function run(label, ctxOpts) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ...ctxOpts, bypassCSP: true });
  await context.route(PROXY + '/**', async (route) => {
    const req = route.request();
    const path = req.url().slice(PROXY.length) || '/';
    try {
      const headers = { ...req.headers() };
      for (const h of ['host', 'origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest']) delete headers[h];
      const init = { method: req.method(), headers };
      if (!['GET', 'HEAD'].includes(req.method())) { const pd = req.postDataBuffer(); if (pd) init.body = pd; }
      const r = await fetch(LOCAL + path, init);
      const body = Buffer.from(await r.arrayBuffer());
      const out = {};
      r.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k.toLowerCase())) out[k] = v; });
      out['access-control-allow-origin'] = '*';
      await route.fulfill({ status: r.status, headers: out, body });
    } catch (e) { try { await route.abort(); } catch (_) {} }
  });
  await context.addInitScript((o) => {
    if (window.top !== window.self) return;
    if (!/^https?:$/.test(location.protocol)) return;
    const go = () => {
      if (window.__ELLO_DEMO_BOOTED__) return;
      try { localStorage.setItem('ello_demo_settings_v2', JSON.stringify({ mode: 'mirror' })); } catch (e) {}
      const s = document.createElement('script');
      s.src = o + '/demo-bookmarklet.js?t=' + Date.now();
      (document.head || document.documentElement).appendChild(s);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
  }, PROXY);

  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  let ok = false;
  for (let i = 0; i < 50; i++) {
    ok = await page.evaluate(() => !!(window.__elloWidget && window.__elloWidget.debugPdpSwap));
    if (ok) break;
    await page.waitForTimeout(500);
  }

  const out = await page.evaluate((loaded) => {
    const d = loaded ? window.__elloWidget.debugPdpSwap() : { ERROR: 'widget-main.js never loaded' };
    // Is the image the swap targets actually ON SCREEN? On a full-width mobile
    // carousel every slide ties on area, so "largest wins" can pick an offscreen
    // slide — the swap would fire correctly and be invisible to the shopper.
    const vw = window.innerWidth, vh = window.innerHeight;
    const describe = (i, idx) => {
      const r = i.getBoundingClientRect();
      return {
        idx, w: i.clientWidth, h: i.clientHeight,
        x: Math.round(r.left), y: Math.round(r.top),
        onScreen: r.right > 0 && r.left < vw && r.bottom > 0 && r.top < vh,
        file: (i.currentSrc || i.src || '').split('/').pop().split('?')[0].slice(0, 32),
      };
    };
    const imgs = [...document.images];
    d.candidates = imgs.map(describe).filter((i) => i.w > 30 && i.h > 30).slice(0, 8);
    const heroFile = d.resolvedHero && d.resolvedHero.src ? d.resolvedHero.src.split('?')[0] : null;
    d.heroOnScreen = heroFile ? (d.candidates.find((c) => c.file === heroFile) || null) : null;
    d.viewportH = vh;
    return d;
  }, ok);

  console.log('\n===== ' + label + ' =====');
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
}

const { defaultBrowserType, ...iphone } = devices['iPhone 13'];
await run('DESKTOP 1280x800', { viewport: { width: 1280, height: 800 } });
await run('MOBILE iPhone 13', iphone);
