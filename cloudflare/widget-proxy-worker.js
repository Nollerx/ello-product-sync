/**
 * ello-widget-proxy — Cloudflare Worker fronting the PUBLIC VTO Cloud Run
 * service on widget.ellotryon.com.
 *
 * Why a Worker instead of an Origin Rule: Cloud Run's front end routes by
 * Host header, and Cloudflare's Host Header Override is Enterprise-only.
 * fetch()ing the run.app URL from a Worker sends the correct Host for free,
 * on the Free/Workers-Free plan.
 *
 * Caching happens HERE, not in zone Cache Rules:
 *   - /widget-main.js, /widget.html  → 1 day   (version-busted via ?v=WIDGET_VERSION)
 *   - /assets/*                      → 1 day   (files are effectively immutable;
 *                                               new models arrive as new filenames)
 *   - /widget-loader.js, /model-images.js → 10 min (UNVERSIONED entry points;
 *     this bounds post-deploy staleness to 10 minutes)
 *   - everything else (/tryon, /api/*, /bootstrap, all POST/OPTIONS) → pass-through,
 *     never cached.
 *
 * Deploy/staleness model: bumping WIDGET_VERSION in widget-loader.js busts
 * main/html immediately; the loader itself refreshes within 10 min. Worker
 * cache of a third-party origin is NOT purgeable from the zone dashboard —
 * an emergency rollback is reverting the theme extension to the run.app URL
 * (see CLOUDFLARE_CDN_DECISION.md).
 *
 * Free-plan note: Workers Free = 100K requests/day. Move to Workers Paid
 * ($5/mo) before any enterprise launch; set the route to FAIL CLOSED so an
 * over-quota day can never silently serve wrong-Host 404s from the fallback.
 */
const ORIGIN = "https://ello-vto-public-13593516897-u5htiuxfrq-uc.a.run.app";

const DAY = 86400;
const TEN_MIN = 600;

const LONG_CACHE = new Set(["/widget-main.js", "/widget.html"]);
const SHORT_CACHE = new Set(["/widget-loader.js", "/model-images.js"]);

function cacheTtlFor(request, path) {
  // HEAD included: Cloudflare answers HEAD from the cached GET object, and a
  // HEAD that skips cacheTtl would store the entry as already-stale.
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (LONG_CACHE.has(path) || path.startsWith("/assets/")) return DAY;
  if (SHORT_CACHE.has(path)) return TEN_MIN;
  return null;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const ttl = cacheTtlFor(request, url.pathname);
    const originRequest = new Request(ORIGIN + url.pathname + url.search, request);
    return fetch(
      originRequest,
      ttl ? { cf: { cacheEverything: true, cacheTtl: ttl } } : undefined,
    );
  },
};
