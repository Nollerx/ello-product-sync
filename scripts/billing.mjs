#!/usr/bin/env node
// Rev-share billing CLI. NOT wired into the app — run by hand when it is time
// to invoice a client through Stripe.
//
// The app's /app/statement page is the CLIENT's self-serve view. This is the
// operator's side: it can read any store without a Shopify admin session, and
// it is where deals get written down.
//
//   node scripts/billing.mjs deals
//       List every store's billing terms.
//
//   node scripts/billing.mjs deal <slug> --rate 10 --trial 7
//       Set a rev-share deal: 10% of attributed revenue, first 7 days free.
//       Trial starts at install unless --start is given. Re-running updates.
//
//   node scripts/billing.mjs deal <slug> --flat 400 --tryons 400 --trial 7
//       Set a flat deal: $400/mo including 400 try-ons, first 7 days free.
//
//   node scripts/billing.mjs invoice <slug> <YYYY-MM> [--tz Zone] [--csv]
//       Print what to charge for that month, and with --csv write the
//       itemized backup to attach to the Stripe invoice.
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the environment, falling
// back to .env then cloud_run_env.yaml so the service key never leaves the box.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fromFile(file, key) {
  try {
    const text = readFileSync(join(ROOT, file), "utf8");
    const m = text.match(new RegExp(`^${key}[:=]\\s*"?([^"\\n]+)"?`, "m"));
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}
const SUPABASE_URL =
  process.env.SUPABASE_URL || fromFile(".env", "SUPABASE_URL") || fromFile("cloud_run_env.yaml", "SUPABASE_URL");
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  fromFile(".env", "SUPABASE_SERVICE_ROLE_KEY") ||
  fromFile("cloud_run_env.yaml", "SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (env, .env, or cloud_run_env.yaml)");
  process.exit(1);
}

const HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function rpc(name, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${name} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: HEADERS, ...init });
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── month boundaries on the merchant's clock ────────────────────────────────
// Mirrors app/lib/billing-period.ts. Two passes because the offset can change
// across a DST boundary inside the month.
function zonedStartOfDay(year, month, day, timeZone) {
  const wanted = Date.UTC(year, month - 1, day, 0, 0, 0);
  let instant = wanted;
  for (let pass = 0; pass < 2; pass++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(instant));
    const g = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const readAs = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
    const offset = readAs - instant;
    if (offset === 0) break;
    instant = wanted - offset;
  }
  return new Date(instant);
}

function monthRange(monthKey, timeZone) {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey || "");
  if (!m) throw new Error(`Bad month "${monthKey}" — expected YYYY-MM, e.g. 2026-08`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`Bad month "${monthKey}" — month must be 01-12`);
  const from = zonedStartOfDay(year, month, 1, timeZone);
  const to = zonedStartOfDay(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1, timeZone);
  return { from, to };
}

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith("--") ? (i++, next) : true;
  }
  return out;
}

const usd = (n, cur = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur || "USD" }).format(Number(n ?? 0));

function csvEscape(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function stamp(iso, tz) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
  }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")} ${g("timeZoneName")}`;
}

// ── commands ───────────────────────────────────────────────────────────────

async function cmdDeals() {
  const rows = await rest("vto_billing_deals?select=*&order=store_slug");
  if (!rows.length) {
    console.log("No billing deals on file yet.\n");
    console.log("Add one:  node scripts/billing.mjs deal <slug> --rate 10 --trial 7");
    return;
  }
  console.log(`\n${rows.length} billing deal(s) on file:\n`);
  for (const d of rows) {
    const terms =
      d.deal_type === "rev_share"
        ? `${Number(d.rev_share_percent)}% of attributed revenue`
        : `${usd(d.flat_amount, d.currency)}/mo${d.included_tryons ? ` incl. ${d.included_tryons} try-ons` : ""}`;
    const trial = d.trial_days > 0
      ? `${d.trial_days} free days from ${d.trial_starts_at ? d.trial_starts_at.slice(0, 10) : "install"}`
      : "no free trial";
    console.log(`  ${d.store_slug}`);
    console.log(`      ${terms}`);
    console.log(`      ${trial}`);
    if (d.notes) console.log(`      note: ${d.notes}`);
    console.log("");
  }
}

async function cmdDeal(slug, f) {
  if (!slug) throw new Error("Usage: node scripts/billing.mjs deal <slug> --rate 10 --trial 7");

  const isFlat = f.flat !== undefined;
  const body = {
    store_slug: slug,
    deal_type: isFlat ? "flat" : "rev_share",
    trial_days: f.trial !== undefined ? Number(f.trial) : 0,
    notes: typeof f.notes === "string" ? f.notes : null,
  };

  if (isFlat) {
    body.flat_amount = Number(f.flat);
    body.included_tryons = f.tryons !== undefined ? Number(f.tryons) : null;
    body.rev_share_percent = null;
    if (!Number.isFinite(body.flat_amount) || body.flat_amount < 0) throw new Error("--flat must be a non-negative number");
  } else {
    if (f.rate === undefined) throw new Error("Give --rate <percent> for a rev-share deal, or --flat <amount> for a flat one");
    body.rev_share_percent = Number(f.rate);
    if (!(body.rev_share_percent > 0 && body.rev_share_percent <= 100)) throw new Error("--rate must be between 0 and 100");
  }
  if (!Number.isInteger(body.trial_days) || body.trial_days < 0) throw new Error("--trial must be a whole number of days");
  // Explicit start date, otherwise the trial clock begins at install.
  if (typeof f.start === "string") {
    const d = new Date(f.start);
    if (Number.isNaN(d.getTime())) throw new Error(`--start "${f.start}" is not a date`);
    body.trial_starts_at = d.toISOString();
  }

  await rest("vto_billing_deals?on_conflict=store_slug", {
    method: "POST",
    headers: { ...HEADERS, Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(body),
  });

  console.log(`\nSaved billing terms for ${slug}:`);
  if (isFlat) {
    console.log(`   ${usd(body.flat_amount)} per month${body.included_tryons ? `, ${body.included_tryons} try-ons included` : ""}`);
  } else {
    console.log(`   ${body.rev_share_percent}% of attributed revenue (net of returns)`);
  }
  console.log(
    body.trial_days > 0
      ? `   First ${body.trial_days} days free, starting ${body.trial_starts_at ? body.trial_starts_at.slice(0, 10) : "when they install"}`
      : "   No free trial",
  );
  console.log(`\nCheck it any time:  node scripts/billing.mjs deals`);
}

async function cmdInvoice(slug, monthKey, f) {
  if (!slug || !monthKey) throw new Error("Usage: node scripts/billing.mjs invoice <slug> <YYYY-MM> [--tz Zone] [--csv]");
  const tz = typeof f.tz === "string" ? f.tz : "America/Chicago";
  const { from, to } = monthRange(monthKey, tz);

  const inv = (await rpc("get_vto_invoice", {
    p_store_slug: slug,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  }))?.[0];

  if (!inv) throw new Error(`No invoice data returned for ${slug}`);
  const cur = inv.currency || "USD";

  console.log(`\n  INVOICE  ${slug}  ${monthKey}   (${tz})`);
  console.log(`  ${"─".repeat(58)}`);

  if (!inv.has_deal) {
    console.log(`  NO BILLING TERMS ON FILE for "${slug}" — nothing can be charged.\n`);
    console.log(`  Set them first:`);
    console.log(`      node scripts/billing.mjs deal ${slug} --rate 10 --trial 7\n`);
    if (Number(inv.sales_count) === 0) {
      console.log(`  (This store also has no attributed sales in ${monthKey}.`);
      console.log(`   If they have not installed the app yet, that is expected.)\n`);
    }
    return;
  }

  const terms =
    inv.deal_type === "rev_share"
      ? `${Number(inv.rev_share_percent)}% of attributed revenue`
      : `${usd(inv.flat_amount, cur)}/mo flat${inv.included_tryons ? ` incl. ${inv.included_tryons} try-ons` : ""}`;
  console.log(`  Deal            ${terms}`);
  if (inv.trial_until) {
    console.log(`  Free until      ${String(inv.trial_until).slice(0, 10)}  (${inv.trial_days} days)`);
  }
  console.log(`  Try-ons run     ${inv.tryons_used}`);
  console.log(`  Sales counted   ${inv.sales_count} across ${inv.orders_count} orders`);
  console.log(`  ${"─".repeat(58)}`);
  console.log(`  Attributed      ${usd(inv.gross_attributed, cur)}`);
  if (Number(inv.refunded) > 0) console.log(`  Returned        -${usd(inv.refunded, cur)}`);
  if (Number(inv.trial_excluded) > 0) {
    console.log(`  Free trial      -${usd(inv.trial_excluded, cur)}   (not billed)`);
  }
  console.log(`  Billable        ${usd(inv.billable_net, cur)}`);
  console.log(`  ${"─".repeat(58)}`);
  console.log(`  CHARGE          ${usd(inv.amount_due, cur)}`);
  console.log(`  ${"─".repeat(58)}`);

  if (inv.deal_type === "rev_share") {
    console.log(`\n  Stripe line item:`);
    console.log(`      Ello attributed revenue fee, ${monthKey}`);
    console.log(`      ${Number(inv.rev_share_percent)}% of ${usd(inv.billable_net, cur)} attributed revenue`);
    console.log(`      ${usd(inv.amount_due, cur)}`);
  }
  if (inv.included_tryons && Number(inv.tryons_used) > Number(inv.included_tryons)) {
    console.log(`\n  NOTE: ${inv.tryons_used} try-ons run vs ${inv.included_tryons} included.`);
  }

  if (f.csv) {
    const lines = await rpc("get_vto_billing_statement", {
      p_store_slug: slug,
      p_from: from.toISOString(),
      p_to: to.toISOString(),
    });
    const header = [
      "shopify_order_id", "product_tried_on", "tried_on_at", "purchased_at",
      "attributed_revenue", "refunded", "net_attributed", "free_trial", "billed_on", "currency",
    ].join(",");
    const rows = lines.map((l) =>
      [
        csvEscape(l.order_id ?? ""),
        csvEscape(l.product_name ?? (l.product_id ? `Product ${l.product_id}` : "")),
        csvEscape(stamp(l.tried_on_at, tz)),
        csvEscape(stamp(l.purchased_at, tz)),
        Number(l.attributed_revenue).toFixed(2),
        Number(l.refunded_amount).toFixed(2),
        Number(l.net_attributed).toFixed(2),
        l.in_trial ? "yes" : "no",
        Number(l.billable_net).toFixed(2),
        csvEscape(l.currency ?? ""),
      ].join(","),
    );
    const totalRow = [
      csvEscape(`TOTAL (${lines.length} sales across ${inv.orders_count} orders)`),
      "", "", "",
      Number(inv.gross_attributed).toFixed(2),
      Number(inv.refunded).toFixed(2),
      Number(inv.net_attributed).toFixed(2),
      "",
      Number(inv.billable_net).toFixed(2),
      csvEscape(cur),
    ].join(",");
    const out = join(ROOT, `ello-statement-${slug}-${monthKey}.csv`);
    writeFileSync(out, [header, ...rows, totalRow].join("\n"), "utf8");
    console.log(`\n  Itemized backup written to:\n      ${out}`);
    console.log(`  Attach that to the Stripe invoice.`);
  } else if (Number(inv.sales_count) > 0) {
    console.log(`\n  Add --csv to write the itemized backup for the client.`);
  }
  console.log("");
}

// ── dispatch ───────────────────────────────────────────────────────────────
const [cmd, ...rest_] = process.argv.slice(2);
const f = flags(rest_);
const positional = rest_.filter((a) => !a.startsWith("--"));
// Drop values that belong to flags so positional args stay clean.
const flagValues = new Set();
for (let i = 0; i < rest_.length; i++) {
  if (rest_[i].startsWith("--") && rest_[i + 1] && !rest_[i + 1].startsWith("--")) flagValues.add(i + 1);
}
const args = rest_.filter((a, i) => !a.startsWith("--") && !flagValues.has(i));

try {
  if (cmd === "deals") await cmdDeals();
  else if (cmd === "deal") await cmdDeal(args[0], f);
  else if (cmd === "invoice") await cmdInvoice(args[0], args[1], f);
  else {
    console.log(`
Ello rev-share billing

  node scripts/billing.mjs deals
      Show every store's billing terms.

  node scripts/billing.mjs deal <slug> --rate 10 --trial 7
      10% of attributed revenue, first 7 days free (clock starts at install).
      Add --start 2026-08-11 to pin the trial start, --notes "..." for context.

  node scripts/billing.mjs deal <slug> --flat 400 --tryons 400 --trial 7
      $400/month including 400 try-ons, first 7 days free.

  node scripts/billing.mjs invoice <slug> 2026-08 --csv
      What to charge for August, plus the itemized CSV for the client.
      Months are cut on the store's local clock (--tz, default America/Chicago).
`);
    process.exit(positional.length ? 1 : 0);
  }
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}
