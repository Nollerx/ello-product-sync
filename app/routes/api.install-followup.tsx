import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabaseAdmin } from "../lib/supabase.server";
import { sendTelegramMessage, escapeHtml } from "../lib/telegram.server";

// Cron-driven follow-up: ~2 hours after a store installs, send Andrew a
// Telegram report of how far it got through onboarding. Cloud Scheduler hits
// this every 15 minutes with the shared secret; each store is reported once
// (install_followup_sent_at). Only stores from the last 7 days are considered
// so pre-existing rows never trigger a backlog flood.

const FOLLOWUP_DELAY_MS = 2 * 60 * 60 * 1000;
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH_LIMIT = 20;

const STEP_DESCRIPTIONS: Record<string, string> = {
  welcome: "hasn't gotten past the welcome screen",
  segment: "is on the store-size question",
  enterprise: "picked $1M+/yr — sitting on the enterprise book-a-call screen 🔥",
  configure: "is configuring the widget (color/position)",
  activate_widget: "is on the legacy activate-widget step",
  placements: "is on the theme placements step",
  billing: "reached the pricing page but hasn't picked a paid plan",
  complete: "finished onboarding ✅",
};

async function runFollowups(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("x-cron-key") !== secret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const now = Date.now();
  const { data: stores, error } = await supabaseAdmin
    .from("vto_stores")
    .select(
      "id, account_id, shop_domain, store_name, onboarding_step, merchant_segment, shopify_plan, widget_enabled, app_embed_enabled, created_at",
    )
    .is("install_followup_sent_at", null)
    .lt("created_at", new Date(now - FOLLOWUP_DELAY_MS).toISOString())
    .gt("created_at", new Date(now - LOOKBACK_MS).toISOString())
    .limit(BATCH_LIMIT);

  if (error) {
    console.error("[InstallFollowup] store query failed:", error.message);
    return new Response(JSON.stringify({ error: "Query failed" }), { status: 500 });
  }

  let sent = 0;
  for (const store of stores ?? []) {
    try {
      let planName = "unknown";
      let tryonsUsed: number | null = null;
      if (store.account_id) {
        const { data: sub } = await supabaseAdmin
          .from("vto_subscriptions")
          .select("id, vto_plans(name)")
          .eq("account_id", store.account_id)
          .eq("status", "active")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const planRel = sub?.vto_plans as { name?: string } | { name?: string }[] | null;
        planName = (Array.isArray(planRel) ? planRel[0]?.name : planRel?.name) ?? "unknown";
        if (sub?.id) {
          const { data: period } = await supabaseAdmin
            .from("vto_usage_periods")
            .select("tryons_used")
            .eq("subscription_id", sub.id)
            .lte("period_start", new Date(now).toISOString())
            .gte("period_end", new Date(now).toISOString())
            .maybeSingle();
          tryonsUsed = period?.tryons_used ?? null;
        }
      }

      const step = String(store.onboarding_step ?? "unknown");
      const stepDesc = STEP_DESCRIPTIONS[step] ?? `is on step "${step}"`;
      const segment = store.merchant_segment
        ? ` · size: ${store.merchant_segment}`
        : "";
      const plus = (store.shopify_plan ?? "").toLowerCase().includes("plus")
        ? " ⭐ Shopify Plus"
        : "";

      const lines = [
        `⏱ <b>2h install check-in: ${escapeHtml(store.store_name || store.shop_domain)}</b>${plus}`,
        `${escapeHtml(store.shop_domain)} ${stepDesc}${segment}`,
        `Widget enabled: ${store.widget_enabled ? "yes" : "no"} · App embed: ${store.app_embed_enabled ? "yes" : "no"}`,
        `Plan: ${escapeHtml(planName)}${tryonsUsed !== null ? ` · Try-ons used: ${tryonsUsed}` : ""}`,
      ];

      const ok = await sendTelegramMessage(lines.join("\n"));
      if (ok) {
        await supabaseAdmin
          .from("vto_stores")
          .update({ install_followup_sent_at: new Date().toISOString() })
          .eq("id", store.id);
        sent += 1;
      }
    } catch (err) {
      console.error(`[InstallFollowup] failed for ${store.shop_domain}:`, err);
    }
  }

  return new Response(JSON.stringify({ ok: true, checked: stores?.length ?? 0, sent }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  return runFollowups(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return runFollowups(request);
}
