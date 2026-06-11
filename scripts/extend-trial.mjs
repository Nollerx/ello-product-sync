#!/usr/bin/env node
// One-off pilot trial extender. NOT wired into the app — run by hand.
//
// Usage:
//   node scripts/extend-trial.mjs <shop> <subscriptionId> <days>
//
// Example (Atlas Apparel, add 23 days -> 7-day trial becomes 30 total):
//   node scripts/extend-trial.mjs ecmxv0-vh.myshopify.com 75767382342 23
//
// NOTE on `days`: appSubscriptionTrialExtend ADDS this many days to the
// CURRENT trial. Atlas is on a 7-day trial, so:
//   days=23 -> 30-day trial total
//   days=30 -> 37-day trial total
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the environment, or
// falls back to cloud_run_env.yaml so the access token never leaves the box.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const API_VERSION = "2025-10"; // matches ApiVersion.October25 in shopify.server.ts

const [shop, subId, daysArg] = process.argv.slice(2);
if (!shop || !subId || !daysArg) {
  console.error("Usage: node scripts/extend-trial.mjs <shop> <subscriptionId> <days>");
  process.exit(1);
}
const days = Number(daysArg);
if (!Number.isInteger(days) || days < 1 || days > 1000) {
  console.error("days must be an integer between 1 and 1000");
  process.exit(1);
}

// --- resolve Supabase creds (env first, then cloud_run_env.yaml) ---
function fromYaml(key) {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const yaml = readFileSync(join(root, "cloud_run_env.yaml"), "utf8");
    const m = yaml.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?`, "m"));
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}
const SUPABASE_URL = process.env.SUPABASE_URL || fromYaml("SUPABASE_URL");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || fromYaml("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (env or cloud_run_env.yaml)");
  process.exit(1);
}

// --- fetch the offline access token for this shop ---
const sel = new URL(`${SUPABASE_URL}/rest/v1/shopify_sessions`);
sel.searchParams.set("shop", `eq.${shop}`);
sel.searchParams.set("is_online", "eq.false");
sel.searchParams.set("select", "access_token");
const sessResp = await fetch(sel, {
  headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
});
if (!sessResp.ok) {
  console.error(`Supabase lookup failed: ${sessResp.status} ${await sessResp.text()}`);
  process.exit(1);
}
const rows = await sessResp.json();
const token = rows?.[0]?.access_token;
if (!token) {
  console.error(`No offline session/token found for ${shop}`);
  process.exit(1);
}

// --- fire appSubscriptionTrialExtend ---
const id = `gid://shopify/AppSubscription/${subId}`;
const mutation = `
  mutation Extend($id: ID!, $days: Int!) {
    appSubscriptionTrialExtend(id: $id, days: $days) {
      appSubscription { id name status trialDays }
      userErrors { field message code }
    }
  }`;
const resp = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
  body: JSON.stringify({ query: mutation, variables: { id, days } }),
});
const json = await resp.json();
const result = json?.data?.appSubscriptionTrialExtend;
const errs = result?.userErrors ?? [];
if (json.errors?.length || errs.length) {
  console.error("FAILED:", JSON.stringify(json.errors ?? errs, null, 2));
  process.exit(1);
}
console.log(`Extended trial for ${shop} by ${days} days.`);
console.log(JSON.stringify(result.appSubscription, null, 2));
