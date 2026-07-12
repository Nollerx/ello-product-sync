# Cloudflare CDN for the VTO Widget — Decision Doc

_Last updated: 2026-07-11_

## The decision in one line
Put the widget's assets (and, by consequence, all widget traffic) behind Cloudflare
so shoppers load the widget from a global edge instead of a single US Cloud Run region.

**Status:** not started. This is a "before a big global client goes live" item, **not** a
blocker. After the 472→86 KB widget cut + server-side caching, the two findings this
closes (`Cache-Control: max-age=0`, "no CDN") dropped from *fire* to *polish*.

---

## What it actually improves (ranked by real impact)

| # | Benefit | Who it helps | Size of win |
|---|---|---|---|
| 1 | **International load speed** — edge node near the shopper (~10–30 ms) instead of a trans-oceanic round trip to Iowa (~100–150 ms × several requests) | Overseas shoppers (LA Apparel ships globally) | **Big** if global; ~0 for US-only |
| 2 | **Egress cost** — Cloud Run premium egress (~$0.12/GB) → Cloudflare (≈ free). ~8–9 GB/day of widget at 100K sessions ≈ **~$1/day** | You | ~**$30/mo** at scale |
| 3 | **Spike resilience** — static serving moves off the instance that also proxies `/tryon`, freeing concurrency during email-blast spikes | Render path under load | **Minor now** (was big at 472 KB) |
| 4 | **Cache headers** — kills the per-pageview 304 revalidation round-trip | Returning shoppers | Small |
| 5 | **Enterprise pitch** — "served from a global CDN" tests better on the Lighthouse / Core-Web-Vitals audits big clients run | Closing deals | Soft but real |

## What it does NOT improve
- **Try-on render speed** — that's Gemini (~9–14 s), unchanged.
- **Conversion** — no direct effect.
- **Anything at current traffic** — every win above is scale- and international-dependent.

## Bottom line
Worth doing **before a big global client goes live** (~$30/mo egress + faster overseas
UX + better enterprise story). At current traffic it changes almost nothing you'd notice.
If LA Apparel isn't signed yet, park it and go close them — the infra is already ready to
say yes.

---

## The risk (read before touching anything)
The theme extension has **one** `ello_backend_url` that the loader derives *everything*
from. So a Cloudflare hostname doesn't just cache JS — it sits in front of **every**
widget request, including the `/tryon` render call Atlas and Marcos depend on.

➡️ A Cloudflare misconfig doesn't *slow* the widget, it **breaks** it for paying customers.

The easiest thing to get wrong: **the Host-header override** (Cloud Run rejects any
request whose Host isn't its own `*.run.app` hostname). That's Step 2 below and it's
make-or-break.

**Cost:** Cloudflare Free plan covers this (Origin Rules + Cache Rules are on Free).

---

## Safe rollout sequence (do NOT skip the order)
1. **You** — set up + test the Cloudflare hostname (checklist below).
2. **Me** — run a *real try-on* through the new hostname to prove the revenue path works.
3. **Me** — repoint the 3 `.liquid` files and deploy the theme extension.
4. **Me** — verify the live widget on a store page.
5. **Rollback** — if anything's off, revert the `.liquid` URL and redeploy (minutes).

Start with the **PUBLIC** app only (that's where enterprise / global scale lives). The
**custom** app uses a different backend (`custom-ello-app-13593516897`) and can stay on
its direct URL until later — CDN'ing it would need its own CF hostname.

---

## ☑️ Your part — Cloudflare checklist (~15 calm minutes)
Pick a hostname, e.g. `widget.ellotryon.com`.

- [ ] **1. DNS** — add CNAME `widget` → `ello-vto-public-13593516897-u5htiuxfrq-uc.a.run.app`, **Proxied** (orange cloud).
- [ ] **2. ⚠️ Origin Rules (critical)** — Rules → Origin Rules → create rule for hostname `widget.ellotryon.com`, set **Host Header → `ello-vto-public-13593516897-u5htiuxfrq-uc.a.run.app`**. Without this, every request 404s.
- [ ] **3. SSL/TLS → Overview** — set encryption mode to **Full**.
- [ ] **4. Caching → Cache Rules** — match **URI Path** = `/widget-main.js` OR `/widget-loader.js` OR `/model-images.js` OR *starts with* `/assets/` → **Eligible for cache**, **Edge TTL: override → 1 day**. Leave everything else default so `/tryon`, `/api/*`, `/bootstrap` pass through **uncached**.
- [ ] **5. Test:**
  ```bash
  curl -I https://widget.ellotryon.com/widget-main.js
  # expect: HTTP 200 + a cf-cache-status header
  curl -s -o /dev/null -w "%{http_code}\n" \
    "https://widget.ellotryon.com/api/widget-config-resolved?store_slug=ecmxv0-vh"
  # expect: 200 (pass-through works)
  ```
- [ ] **6.** Tell Claude "CF is up" → verification + repoint begins.

---

## My part (staged, runs after your part is verified)
Repoint `ello_backend_url` from the run.app URL to `https://widget.ellotryon.com` in:
- `extensions/ello-theme-extension/blocks/widget.liquid` (line 15)
- `extensions/ello-theme-extension/blocks/inline-tryon-button.liquid` (line 67)
- `extensions/ello-theme-extension/blocks/fitting-room.liquid` (line 89)

Then `shopify app deploy` (theme-extension config push — **not** a Cloud Run deploy).

## Verification I run after repoint
- Real try-on through `widget.ellotryon.com` → 200, image returned
- `cf-cache-status: HIT` on `widget-main.js` after a warm-up fetch
- Config + bootstrap resolve through the CDN hostname
- Live widget loads + renders on a real store page
- No 5xx in Cloud Run logs

## Rollback
Revert the 3 `.liquid` files to the `run.app` URL, `shopify app deploy` again. Widget is
back on the direct front door in minutes. (Cloud Run itself is never touched by this
change, so there's nothing to roll back server-side.)

---

## Decision checklist
- [ ] Is a global-shipping enterprise client (LA Apparel / AYBL) actually close? → if **yes**, do it pre-launch.
- [ ] Do I have a calm 15 min in the Cloudflare dashboard (not mid-spike)? 
- [ ] Am I OK that CF is now in the `/tryon` path (very reliable, but a new dependency)?
- [ ] Start with **public only**; custom later.

_If "no" to the first box: park this and go sell. The widget is enterprise-ready as-is._

---

# ⚙️ Execution log — 2026-07-11 (decision: GO)

**Decision rationale:** AYBL (UK, uncapped eval) is already a live global-shopper client and
LA Apparel is in play → the doc's own first checkbox is a yes.

## Plan change: Worker proxy instead of Origin Rule
Cloudflare's **Host Header Override is Enterprise-only** (the doc's "Free plan covers
this" was wrong — port override is free, host override is not). Same outcome, new
mechanism: a ~50-line Worker (`cloudflare/widget-proxy-worker.js`) on
`widget.ellotryon.com` fetches the run.app URL directly, which sets the correct Host
automatically. Consequences:
- **No Origin Rule, no zone SSL-mode change, no Cache Rules** — caching lives in the
  Worker (TTLs below). Fewer zone-level knobs than the original plan.
- Workers Free = 100K req/day. **Before enterprise scale: Workers Paid ($5/mo) + route
  set to fail closed.**

## Cache design (differs from original step 4 — loader is unversioned)
The loader is fetched **without** `?v=`, so a 1-day edge TTL would leave deploys stale
for a day. Split TTLs:
- `widget-main.js`, `widget.html` (both `?v=`-busted) + `/assets/*` → **1 day**
- `widget-loader.js`, `model-images.js` (unversioned) → **10 min** (bounds post-deploy staleness)
- everything else → pass-through, uncached

## Pre-flight verified (all green)
- 3 liquid files confirmed as the only repoint sites; `_tryonBase` in widget-main.js
  derives from loader script src → `/tryon` really does follow the repoint.
- CORS is `access-control-allow-origin: *` on widget.html + config API → no
  cross-merchant cache-poisoning risk from edge caching.
- `RENDER_TIMEOUT_MS` = 90s < Cloudflare's 100s proxy ceiling.
- Shopify CLI authenticated; bare `shopify app deploy` targets **Ello VTO Public**.
- `ellotryon.com` zone is on Cloudflare NS; apex/www are DNS-only (Lovable) → adding
  the proxied `widget` subdomain touches nothing live.
- **Rate-limit landmine defused:** the uncommitted audit fix keyed the per-shopper cap
  on the LAST X-Forwarded-For hop, which becomes a CF edge IP behind the CDN (all
  shoppers would share ~one bucket → false 429s). New `app/lib/client-ip.server.ts`
  unwraps `CF-Connecting-IP` only when the Google-verified peer is a real Cloudflare
  IP (27/27 unit tests pass). Ships with the audit work — nothing deployed today.

## Revised rollout (Worker path)
1. Cloudflare dashboard (needs login): create Worker `ello-widget-proxy` with
   `cloudflare/widget-proxy-worker.js`, add **Custom Domain** `widget.ellotryon.com`
   (auto-creates DNS + cert; no manual CNAME needed). Confirm Bot Fight Mode stays OFF.
2. Run `verify-cf.sh` (scratchpad): headers, HIT/MISS, byte parity, CORS preflight,
   config pass-through, then `--tryon` = one real render through the CDN hostname
   billed to `ello-dev-store` (Blue Dress + model_1).
3. Repoint the 3 liquid files **and** `scripts/deploy-custom.sh`'s `PUBLIC_URL`
   (its sed must match the new hostname or the next custom deploy pushes the public
   CDN URL to custom-app merchants).
4. `shopify app deploy` (public config) → live verify on a real store page + Cloud Run logs.
5. Rollback unchanged: revert liquid → redeploy extension (minutes). Worker cache of a
   third-party origin isn't zone-purgeable — worst-case staleness is 10 min (loader TTL),
   or roll back to run.app which bypasses the Worker entirely.

## ✅ SHIPPED 2026-07-11 — live and verified
- Worker `ello-widget-proxy` (account f42496ad…) + custom domain `widget.ellotryon.com`
  (zone 9bb6ebda…, auto DNS + cert). Deployed via the dash same-origin API from the
  browser pane (editor iframe rejects synthetic keyboard input; the API path is
  actually more repeatable).
- One worker nuance found in verification: `cacheTtl` must also apply to **HEAD**
  requests — a HEAD that skips it stores the object as already-stale (REVALIDATED
  instead of HIT). Fixed; repo copy is in sync.
- Verification: 12/12 checks green (HIT on loader+main, dynamic pass-through uncached,
  byte parity CF↔origin, CORS preflight) + **real render through the CDN hostname:
  13s, image returned** (billed to ello-dev-store) + Bot Fight Mode confirmed off.
- Theme extension **ello-vto-public-47** released; confirmed live on Atlas's production
  PDP (`ELLO_WIDGET_BASE_URL = widget.ellotryon.com`, Try On button + bubble render,
  zero console errors) and zero Cloud Run 5xx after the switch.
- Custom app untouched (still direct to its run.app URL, by design).
- workers.dev subdomain disabled for the worker (2026-07-11) — `widget.ellotryon.com` is
  the only public entrance; re-enable in Worker → Settings → Domains & Routes if ever
  needed for debugging.

## Rollback (current, Worker path)
1. Revert the 3 `.liquid` `ello_backend_url` lines to the run.app URL **and**
   `scripts/deploy-custom.sh` `PUBLIC_URL` (one commit — they move together).
2. `shopify app deploy --force` → stores are back on the direct front door in minutes.
3. The Worker/domain can stay up indefinitely (harmless) or be detached in
   Workers → ello-widget-proxy → Settings → Domains & Routes.
Worker cache of a third-party origin is not zone-purgeable; worst-case staleness after
any emergency change is 10 min (loader TTL) — the liquid rollback bypasses it entirely.

## Follow-ups
- **Before enterprise scale (AYBL ramp / LA Apparel launch): Workers Paid ($5/mo)** —
  Free is 100K req/day — and set the route to **fail closed**.
- The XFF/CF-Connecting-IP helper (`app/lib/client-ip.server.ts`) ships with the next
  server deploy alongside the audit work; until then the deployed first-entry XFF
  behavior is unchanged behind CF.
- Optional later: edge-cache `/api/widget-config-resolved` (30s TTL, respect-origin) for
  another international boot-time win; and a CF hostname for the custom app.
