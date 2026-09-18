import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabaseAdmin } from "../lib/supabase.server";
import { sendAlertMessage, escapeHtml } from "../lib/telegram.server";

// Per-store try-on health sweep.
//
// WHY THIS EXISTS: the Atlas incident (2026-09-13 → 09-18) failed 43% of one
// merchant's try-ons for five days and not one of the seven GCP alert policies
// fired. They are all burst-shaped — the tightest is ">20 engine errors in 5
// minutes", and the incident peaked at 10 errors in any 5-minute window and 14
// in any hour. One store breaking quietly never generates the fleet-wide volume
// an absolute counter needs. The signal that mattered was a RATE on one store,
// and that lives in tryon_events, not in Cloud Run logs — hence an app sweep.
//
// Deliberately NOT an error-count alert: some failures are normal and healthy
// (Gemini IMAGE_SAFETY refusals on swimwear, a shopper cancelling). What is
// never normal is a third of a store's renders dying.

// Rolling window. Long enough that a low-traffic store still reaches MIN_ATTEMPTS,
// short enough that a broken store is caught the same day rather than the next.
const WINDOW_HOURS = 6;
// Floor before a rate means anything: 1-of-2 failing is noise, 3-of-8 is a signal.
const MIN_ATTEMPTS = 8;
// Atlas sat at 43%. Healthy stores sit near 0-5%. 30% is clear of both.
const FAILURE_THRESHOLD = 0.3;
// Once a store has paged, stay quiet until it recovers or this passes, so a
// long outage is one message a day and not one every fifteen minutes.
const REALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000;

// Andrew's own surfaces. The dev store runs deliberate swimwear/lingerie test
// batches that fail on purpose (IMAGE_SAFETY) and would page him constantly.
const IGNORED_SLUGS = new Set(
  (process.env.HEALTH_ALERT_IGNORE || "ello-dev-store,default_store")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const isIgnored = (slug: string) =>
  IGNORED_SLUGS.has(slug) || slug.startsWith("app-review") || slug.includes("-test") || slug.startsWith("m-test");

interface EventRow {
  store_slug: string | null;
  success: boolean | null;
  product_id: string | null;
  created_at: string;
}

async function runSweep(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("x-cron-key") !== secret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const dryRun = new URL(request.url).searchParams.get("dry") === "1";
  const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from("tryon_events")
    .select("store_slug, success, product_id, created_at")
    .gte("created_at", since);

  if (error) {
    console.error("[StoreHealth] query failed:", error.message);
    return new Response(JSON.stringify({ ok: false, reason: error.message }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Aggregate per store, and track which product is failing most — that single
  // line is what turns "Atlas is failing" into something actionable.
  const byStore = new Map<string, { total: number; failed: number; products: Map<string, number> }>();
  for (const row of (data ?? []) as EventRow[]) {
    const slug = row.store_slug;
    if (!slug || isIgnored(slug)) continue;
    let s = byStore.get(slug);
    if (!s) {
      s = { total: 0, failed: 0, products: new Map() };
      byStore.set(slug, s);
    }
    s.total += 1;
    if (row.success === false) {
      s.failed += 1;
      if (row.product_id) s.products.set(row.product_id, (s.products.get(row.product_id) ?? 0) + 1);
    }
  }

  const { data: stores } = await supabaseAdmin
    .from("vto_stores")
    .select("store_slug, shop_domain, health_alert_sent_at");
  const stamp = new Map<string, string | null>(
    (stores ?? []).map((s) => [s.store_slug as string, (s.health_alert_sent_at as string | null) ?? null]),
  );
  const domains = new Map<string, string>(
    (stores ?? []).map((s) => [s.store_slug as string, (s.shop_domain as string) ?? ""]),
  );

  const alerted: string[] = [];
  const recovered: string[] = [];
  const checked: Array<{ store: string; total: number; failed: number; rate: number }> = [];

  for (const [slug, s] of byStore) {
    const rate = s.failed / s.total;
    checked.push({ store: slug, total: s.total, failed: s.failed, rate: Number(rate.toFixed(3)) });
    const last = stamp.get(slug) ?? null;
    const unhealthy = s.total >= MIN_ATTEMPTS && rate >= FAILURE_THRESHOLD;

    if (!unhealthy) {
      // Recovered: clear the stamp silently so the next genuine incident pages.
      if (last) {
        recovered.push(slug);
        if (!dryRun) {
          await supabaseAdmin
            .from("vto_stores")
            .update({ health_alert_sent_at: null })
            .eq("store_slug", slug);
        }
      }
      continue;
    }

    if (last && Date.now() - new Date(last).getTime() < REALERT_COOLDOWN_MS) continue;

    const [topProduct, topCount] = [...s.products.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    const lines = [
      `🔴 <b>Try-ons failing — ${escapeHtml(domains.get(slug) || slug)}</b>`,
      ``,
      `<b>${Math.round(rate * 100)}%</b> of the last ${s.total} try-ons failed (${s.failed} of ${s.total}, past ${WINDOW_HOURS}h).`,
    ];
    if (topProduct) {
      lines.push(``, `Worst product: <code>${escapeHtml(topProduct)}</code> — ${topCount} failure${topCount === 1 ? "" : "s"}.`);
    }
    lines.push(
      ``,
      `Check the engine log for that store, then the product's clothing_items row — a replaced photo leaves a dead CDN URL behind.`,
    );

    if (!dryRun) {
      const sent = await sendAlertMessage(lines.join("\n"));
      if (sent) {
        await supabaseAdmin
          .from("vto_stores")
          .update({ health_alert_sent_at: new Date().toISOString() })
          .eq("store_slug", slug);
      }
    }
    alerted.push(slug);
  }

  checked.sort((a, b) => b.rate - a.rate);
  console.log(`[StoreHealth] checked=${checked.length} alerted=${alerted.length} recovered=${recovered.length}`);

  return new Response(
    JSON.stringify({
      ok: true,
      dry_run: dryRun,
      window_hours: WINDOW_HOURS,
      min_attempts: MIN_ATTEMPTS,
      threshold: FAILURE_THRESHOLD,
      alerted,
      recovered,
      checked,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

export async function loader({ request }: LoaderFunctionArgs) {
  return runSweep(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return runSweep(request);
}
