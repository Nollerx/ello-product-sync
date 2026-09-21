import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { resolveStore, scanStoreCatalog } from "../lib/print-scan.server";
import { sendTelegramMessage, escapeHtml } from "../lib/telegram.server";

// Per-store catalogue print-side scan (see app/lib/print-scan.server.ts).
// No cron: this is kicked per store — by afterAuth at install, by the products
// webhook on catalog changes, or manually. One invocation classifies a bounded
// batch and, if the store isn't drained, fires the next hop at itself, so a
// big catalog finishes across a short chain of requests.
//
//   ?store=<slug or myshopify domain>   required
//   ?src=install|webhook|admin|selfheal gate selector; omitted = manual kick
//   ?limit=<n>                          classifier calls per hop (cap 60)
//   ?hop=<n>                            internal chain counter

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 60;
// The service timeout is 300s; leave room for the batch in flight to finish.
const DEADLINE_MS = 220_000;
const MAX_HOPS = 25; // 25 × 60 = enough for any real catalog; hard runaway stop
// Stores installed before this date never scan from a webhook kick — flipping
// automation on must not silently change catalogs that predate it (Atlas runs
// an A/B holdout). Install kicks and manual kicks are deliberate, so they pass.
const DEFAULT_CUTOFF = "2026-08-29";

async function runScan(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("x-cron-key") !== secret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }
  if (!process.env.GEMINI_API_KEY) {
    // Deployed without the key (the custom app's service) — a no-op, not an
    // error, so a stray kick can never page anyone.
    return new Response(JSON.stringify({ ok: false, reason: "GEMINI_API_KEY not set" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("store")?.trim();
  if (!target) {
    return new Response(JSON.stringify({ error: "store parameter required" }), { status: 400 });
  }
  const src = url.searchParams.get("src");
  const product = url.searchParams.get("product")?.trim() || null;
  const hop = Number(url.searchParams.get("hop")) || 0;
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(limitParam, MAX_LIMIT)
    : DEFAULT_LIMIT;

  try {
    const store = await resolveStore(target);
    if (!store) {
      return new Response(JSON.stringify({ ok: false, reason: `no vto_stores row for "${target}"` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // A named product means a named product. clothing_items holds point-in-time
    // Shopify CDN URLs, and replacing a photo deletes the file behind the stored
    // URL, so the row has to be re-read — but re-reading it is all that is owed
    // (Atlas, 2026-09-17: a dead link took out ~43% of that store's try-ons).
    // onlyForced holds the blast radius to exactly that product on EVERY store,
    // legacy or not. A catalog-wide sweep belongs to install, to the merchant's
    // own Rescan button, and to a manual kick — never to routine traffic.
    let onlyForced = false;
    if (src === "selfheal") {
      if (!product) {
        return new Response(JSON.stringify({ ok: true, skipped: "self-heal kick without a product" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      onlyForced = true;
    } else if (src === "webhook") {
      if (product) {
        onlyForced = true;
      } else {
        // No product id in the payload. A legacy catalog must still never
        // vision-scan itself off a webhook — that cost gate is the entire
        // reason the cutoff exists.
        const cutoff = process.env.PRINT_SCAN_CUTOFF || DEFAULT_CUTOFF;
        if (!store.createdAt || store.createdAt.slice(0, 10) < cutoff) {
          return new Response(JSON.stringify({ ok: true, skipped: "pre-cutoff store" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
    }

    const { stats, error } = await scanStoreCatalog(store, {
      limit,
      deadlineMs: DEADLINE_MS,
      force: product ? [product] : undefined,
      onlyForced,
    });

    if (error) {
      console.error(`[PrintScan] ${store.slug}: ${error}`);
      // Surface install-time failures — a back-first catalog with no scan is
      // exactly the silent-wrong-render case this system exists to prevent.
      if (src === "install") {
        await sendTelegramMessage(
          `⚠️ <b>Print scan couldn't run for ${escapeHtml(store.slug)}</b>\n${escapeHtml(error)}\nKick it manually: /api/print-scan-sweep?store=${escapeHtml(store.slug)}`,
        ).catch(() => {});
      }
      return new Response(JSON.stringify({ ok: false, reason: error }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const drained = stats.remaining === 0;
    if (!drained && hop < MAX_HOPS) {
      // Fire-and-forget the next hop before returning — this request still has
      // CPU while the response is being written, and the next hop runs as its
      // own request with its own allocation. Base URL from SHOPIFY_APP_URL:
      // request.url sits behind the HTTPS proxy and can carry the wrong scheme.
      const base = (process.env.SHOPIFY_APP_URL || url.origin).replace(/\/$/, "");
      const next = new URL(`${base}/api/print-scan-sweep`);
      next.searchParams.set("store", store.slug);
      if (src) next.searchParams.set("src", src);
      if (limitParam) next.searchParams.set("limit", String(limit));
      next.searchParams.set("hop", String(hop + 1));
      fetch(next.toString(), { headers: { "x-cron-key": secret } }).catch(() => {});
    }

    // One Telegram summary per DELIBERATE sweep — install, the merchant's Rescan
    // button, or a manual kick. Webhook and self-heal passes are single products
    // and fire with ordinary store traffic; a ping for each one is noise, and it
    // read as "why is it scanning a bunch of things?" when the number in the
    // message was the catalog size, not the number scanned.
    const announce = src !== "webhook" && src !== "selfheal";
    if (drained && stats.written > 0 && announce) {
      await sendTelegramMessage(
        `🧵 <b>Print scan: ${escapeHtml(store.slug)}</b>\n${stats.written} configured (${stats.split} split-enabled${stats.bags ? `, ${stats.bags} handbags` : ""}) of ${stats.catalog} products${stats.parked ? ` · ${stats.parked} parked` : ""}`,
      ).catch(() => {});
    }

    return new Response(JSON.stringify({ ok: true, drained, hop, scope: onlyForced ? "product" : "catalog", stats }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[PrintScan] failed:", err);
    return new Response(JSON.stringify({ error: "Scan failed" }), { status: 500 });
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  return runScan(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return runScan(request);
}
