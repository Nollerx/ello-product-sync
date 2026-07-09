import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { sendTelegramMessage, escapeHtml } from "../lib/telegram.server";

// Public endpoint the marketing site's Calendly embed calls when a visitor
// completes a booking (Calendly fires a `calendly.event_scheduled` postMessage
// in the parent page — no paid Calendly webhook needed). The message content is
// fixed server-side, so the worst an abuser can do is ping Andrew; a small
// per-instance rate limit keeps even that boring.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5;
let windowStart = 0;
let windowCount = 0;

const ALLOWED_SOURCES = new Set(["website", "app"]);

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  return json(405, { error: "Method not allowed" });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });

  const now = Date.now();
  if (now - windowStart > RATE_WINDOW_MS) {
    windowStart = now;
    windowCount = 0;
  }
  if (windowCount >= RATE_MAX) return json(429, { error: "Rate limited" });
  windowCount += 1;

  let source = "website";
  let shop = "";
  try {
    const body = await request.json();
    if (typeof body?.source === "string" && ALLOWED_SOURCES.has(body.source)) {
      source = body.source;
    }
    if (typeof body?.shop === "string") {
      shop = body.shop.slice(0, 100);
    }
  } catch {
    // Body optional — default source stands.
  }

  await sendTelegramMessage(
    `📅 <b>New Calendly booking</b> just came through via the ${source}${shop ? ` (${escapeHtml(shop)})` : ""}.\nCheck email for the invitee details.`,
  );

  return json(200, { ok: true });
}
