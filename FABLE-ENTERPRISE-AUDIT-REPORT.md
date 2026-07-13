# Ello VTO — Enterprise Readiness Audit (Fable)

**Date:** 2026-07-12 · **Scope:** capacity + go-to-market (security tier closed 2026-07-11, not reopened)
**Method:** 4 parallel workstreams (load/perf, data/cost, onboarding/compliance, pricing) + lead synthesis. Every claim below is grounded in a file path, a live command output, a measured query, or a fetched primary source. Ground truth was re-verified live on 2026-07-12 — several prior-audit beliefs were corrected (see §8).

---

## 1. VERDICT: **GO-WITH-FIXES**

**Ello VTO can onboard an LA Apparel–class client.** The economics are excellent (92–94% gross margin at the measured attribution rate, profitable down to 18× worse), the Stripe billing path is not just allowed but *prescribed* by Shopify for custom-distribution apps, the 2026-07-11 hardening deploy genuinely shipped (verified byte-for-byte and by live probes), and the data layer holds indefinitely for ~$30/mo plus one pasted SQL migration.

**What "WITH-FIXES" means:** ~1 week of small items, almost all S-effort. Two SQL pastes, two dashboard upgrades, three `gcloud` commands, one quota confirmation, four contract clauses, and a templating pass on the deploy scripts. Nothing structural. The single biggest *unknown* (not defect) is the Gemini image-generation quota on drop day — item A3 — which must be confirmed before the first trial goes live, because the FASHN fallback's documented capacity (~33 renders/min) cannot absorb a drop spike.

**Would it survive an LA Apparel drop today, unfixed?** No — but it now fails politely instead of catastrophically. Shoppers would see a working widget with a rising share of "try-on took too long" errors during the spike (Gemini quota + 512Mi front door), not OOM loops or unmetered spend. After Group A ships: yes, cleanly.

> ### ⚡ Status after execution + live re-verification — 2026-07-12 evening
> Every remaining "open" claim was re-checked against the live database and live services (not documentation). Two audit errors found and corrected, two items executed.
>
> **Corrections (the audit was wrong, live state was already fine):**
> - **A1 — Proof Engine migration was ALREADY APPLIED.** Verified live: `vto_experiments` + `vto_ab_exposures` (RLS on, FK intact), all four functions incl. anti-forgery length gates, ab fields in `get_widget_config`, normalized `vto_attributed_purchases` view. The "unapplied" call was inferred from a missing comment header. **The Proof Engine is ready — start a holdout from Analytics → Proof.**
> - **A2 — the OVERAGE_BLOCKED landmine was ALREADY DEFUSED.** The live `custom_distribution` plan row has **1,000,000 included try-ons/month** (the audit reasoned from the code default, not the live row). At LA scale (~150–300K/mo) it can never bind. `enterprise` (13,000) and `enterprise_plus` (25,000) plan codes also already exist. A2 downgrades to optional per-client hygiene at signing.
>
> **Executed (Andrew's go):**
> - **A7 — DONE.** Migration `retention_rollups_and_prune`: 4 delete-path indexes, `vto_daily_store_rollups` + `build_daily_rollup()`, batched `prune_events()` (90d events / 30d vitals / 400d money tables), cron jobs at 08:50 + 09:10 UTC. **Rollups backfilled for all history** (212 rows / 17 stores; purchases 402 and revenue $27,959 match raw exactly). First prune touches only 1,672 aged rows, all preserved as aggregates.
> - **A8 — DONE, amended.** Public front door → rev 00172: **1Gi, min-instances 0** (RAM protects the OOM wall and is free while idle; the warm instance was reverted at Andrew's call — no idle billing at current traffic). Render engine → rev 00011: **1Gi, concurrency 32, max-instances 40**. All smoke-checked 200. **Idle cost added: $0.** `min-instances 1` is now Day-0 signing switch 9 (~$10–20/mo when client traffic is imminent).
>
> **New finding from the re-verification — RESOLVED same day (Andrew's call):**
> - ~~Shopper cap OFF on 17/18 stores~~ **Now ON fleet-wide at 12/day** (all 18 stores + new-store default 12; migration `shopper_cap_default_on_12_purchase_reward`). **Purchase reward added:** a session with a try-on→purchase in the last 30 days earns a doubled cap (24/day; IP backstop scales to 3×) — enforced in the live `record_tryon_event` RPC, verified end-to-end with synthetic rows (blocked at 12 → purchase → gate opened), cleaned up after. The render engine's hardcoded 15/24h backstop was made env-tunable (`SESSION_TRYON_CAP`, default 40) and deployed as rev 00012 so it never clips the reward — merchant caps are authoritative in the Node RPC. The $0.067/hit faucet is closed.
>
> **Genuinely still open:** A3 Gemini quota (Andrew, AI Studio), A4 FASHN letter (Andrew), A5 contract clauses + deposit-policy conflict (Andrew), A6 Supabase Pro + Workers Paid (Andrew, billing dashboards), A9 templating pack (Claude, no deploy needed), A10 CDN clone (at signing), Group B items B1–B8 (Claude, deploys on go). B4 detail confirmed: `GEMINI_TIMEOUT_SEC` is env-tunable but `FASHN_TIMEOUT_SEC=60` is hardcoded — worst-case engine path 90+60=150s vs the 90s front-door abort.

---

## 2. Ranked punch list

### GROUP A — before the first client signs / goes live

| # | Item | Owner | Effort | Why it blocks |
|---|------|-------|--------|---------------|
| A1 | ~~Apply the Proof Engine migration~~ **✅ RESOLVED — was already applied** (verified live 2026-07-12 evening: tables, RLS, functions, config fields, view all present). Audit error; see ⚡ block. Proof Engine is ready to start from `/app/proof`. | — | 0 | — |
| A2 | ~~Per-client enterprise plan row~~ **✅ DEFUSED — live `custom_distribution` plan already includes 1,000,000 try-ons/mo** (verified live; audit reasoned from the code default, not the row). Can never bind at LA scale. Per-client row remains *optional* hygiene at signing for reporting/limits. | optional, at signing | 10 min | — |
| A3 | ~~Confirm the Gemini quota~~ **✅ RESOLVED 2026-07-12 (Andrew checked AI Studio): the project is TIER 2** — Nano Banana 2 at **500 RPM / 1M TPM / 10,000 RPD** (peak 28-day usage: 30 RPM, 77 RPD). The audit's Tier-1 fear was wrong. RPM covers drop-day demand (70–210/min) with 2.4–7× headroom. **Residual ceiling: 10K requests/DAY, per-project (all stores share it)** — binds only at the top of the load profile or multi-client scale. Escape hatches, in order: Tier 3 is AUTOMATIC at $1,000 cumulative spend + 30 days from first payment; Google's paid-tier increase form; Vertex switch (engine ADC-ready) at signing. | monitoring only | — | — |
| A4 | **Get FASHN capacity in writing.** Public docs show 3/6/11 concurrent by tier (~33 renders/min ceiling); the verbal "500 concurrent enterprise" appears in no public doc. | Andrew | S | The fallback collapses exactly when Gemini browns out. A capacity letter (or enterprise contract) is a pre-pilot requirement, not a nice-to-have. |
| A5 | **Term-sheet edits (4 clauses)** — see §3 guardrails: (1) lift bar = 95% confidence + 200 sessions/group + 10 buyers, verbatim (term sheet's open item says 90%; the shipped engine gates at 95% — if they disagree, the refund trigger and the dashboard fight); (2) compute allowance 45 try-ons per $100 Qualified Revenue, $0.10/try-on beyond; (3) failed-trial retention = max($2,500, $0.10 × trial try-ons); (4) credit expires at month 12 regardless of cancellation status. | Andrew | S (paper) | Closes the only exposed corners of Term Sheet v3: contract/product mismatch, low-rpt margin grind, big-brand failed-pilot compute, and the dormant-client credit landmine. |
| A6 | **Day-0 money switches:** Supabase Pro (**$25/mo**) + Cloudflare Workers Paid (**$5/mo**). | Andrew | 15 min | Free DB fills in **2.2–4.6 days** at full LA traffic; Workers Free (100K req/day) dies by mid-morning of an LA-class day (~700K–1M worker req/day). |
| A7 | **Retention pack SQL** (delete-path indexes + `vto_daily_store_rollups` + nightly `prune_events()` via pg_cron — full runnable SQL in §6B). | Andrew (paste) | 20 min | Pro alone buys only 33–70 days at full traffic. Pro + 30/90-day retention = indefinite. pg_cron already installed and in use. |
| A8 | **Cloud Run config** (commands below, run on "go"): public front door → 1Gi + min-instances=1; custom → min-instances=1 (already 2Gi); render engines → 1Gi + concurrency 32 + max 40. Adds ~$15–30/mo. | Andrew (paste) | 10 min | Public front door is still 512Mi/min-0: OOM at ~40–60 concurrent renders on a hot instance; cold starts in drop minute 1. Render engines OOM ~50–60 concurrent at 512Mi before their 80-slot cap. |
| A9 | ~~Templating pack~~ **✅ DONE 2026-07-12 evening.** Built + tested: `scripts/new-client.sh` (scaffolds TOML + env with compliance flags carried over, secrets blanked, `SUPABASE_ANON_KEY` auto-added, prints the fill-in checklist), `scripts/deploy-client.sh` (fail-loud URL swap — refuses to deploy on placeholder configs or sed no-op; both guards test-verified), `scripts/verify-client.sh` (7-check go-live sweep incl. CDN/origin byte parity + 413 probe — ran clean 7/7 against the live public stack), `cloudflare/wrangler-client.toml.template`. Client #1 onboarding is now scripted end to end. | — | — | — |
| A10 | **CDN worker clone for the client** (`widget-<client>.ellotryon.com` → client's service; procedure §5C). Prerequisite: A6's Workers Paid. | Andrew (dashboard) / scriptable via A9 | 20 min | The worker fronts only the public service. A custom client with no CDN pays ~$40/mo raw egress and every drop spike hits Cloud Run directly — and the loader derives `/tryon` from this hostname, so it's correctness, not just speed. |

### GROUP B — before full traffic (during the 30-day pilot)

| # | Item | Effort | Notes |
|---|------|--------|-------|
| B1 | **Split `/tryon` onto its own service** (`ello-tryon-13593516897`, concurrency 8, 1Gi, max 40) routed by a Cloudflare Worker path rule — zero widget/theme change (the loader derives everything from the script origin: `widget-loader.js:245-253`). | M | Render spikes can never starve widget-config traffic again. 8×40 = 320 render slots. |
| B2 | **Edge-cache the 3 GET config endpoints** (`/api/widget-config-resolved`, `/api/catalog-handles`, `/api/widget-preview`) in the worker with `cacheTtl: 30` + per-instance memo on widget-config-resolved (pattern already exists at `api.catalog-handles.tsx:9`). | S | Collapses ~150–250K Supabase RPC/day and 12–18GB/mo egress by ~98%. Note: the RPC currently runs even on the 304 path (`api.widget-config-resolved.tsx:53`). |
| B3 | **Fix origin cache headers** on widget assets (both services serve `cache-control: public, max-age=0`; serve versioned `widget-main.js` as `max-age=31536000, immutable`, loader as `max-age=600`). | S | CDN masks it for the public app only; custom origins revalidate 338KB per pageview. |
| B4 | **Align the timeout budget:** front door aborts at 90s but the engine's worst case is ~90s Gemini + 60s FASHN polling. Shrink engine budgets to ≤80s total (or raise `RENDER_TIMEOUT_MS`). | S | Today a timeout releases the credit while the engine keeps rendering — wasted COGS and a completed image nobody receives. `tryon.tsx:15` vs `main.py:37,56`. |
| B5 | **Engine backpressure:** asyncio semaphore + 503-with-Retry-After in the render engine so overload degrades politely instead of stampeding FASHN. | S | Complements A8's concurrency cap. |
| B6 | **Point analytics at rollups** (admin analytics pages full-window scans of raw event rows — tens of MB and multi-second queries at 3–6M rows/mo; `app/lib/analytics.server.ts:214,385`). External dashboard: Lovable prompt, not a repo edit. | M | Rollup table ships in A7. |
| B7 | **GCS/BigQuery offload job** (nightly export before the 90-day delete horizon; ~$0.40/mo Nearline for a year of full-scale raw events). | M | Build during pilot; spec in §6B. |
| B8 | Optional: fold `/bootstrap` payload into the cached config endpoint — removes ~100K uncacheable POSTs/day (the server side is already cached/memoized; this kills the request itself). | S | |

### GROUP C — hardening (batch after go-live)

- Widget version constant drift: served widget reports `2.4.0`, loader is `2.8.1` — confuses stale-widget forensics (`widget-main.js:2247` vs `widget-loader.js:258`).
- Render-engine Dockerfile installs unpinned latest pip packages despite requirements.txt — nondeterministic rebuilds of a production COGS service.
- Engine's own hardcoded 15/24h per-session cap silently overrides any merchant cap set higher (`main.py:1055-1078`).
- Custom TOML webhooks `api_version` 2026-01 vs public 2026-04 — align in the A9 template.
- Move plaintext Shopify/Supabase secrets in env yamls to Secret Manager refs (multiplies per client otherwise).
- 2h install-followup cron targets the public service only; custom clients get no onboarding check-in.
- `clothing_items.updated_at` doesn't exist → catalog-handles version probe silently fails (5-min stale net only); `CLOTHING_SELECT_COLUMNS` selects nonexistent columns (latent 400 for any future supabase-population store); `vto_stores` unindexed on `shop_domain` (harmless at 18 rows); Supabase advisor hygiene (RLS initplan, duplicate policies, ~10 unused indexes).
- Cloud Run naming hygiene: 3 sibling `custom-ello-app*` services + legacy orphans invite wrong-target deploys — adopt `ello-vto-<client>`, document/clean orphans.
- Verify which theme-extension version existing custom-app merchants run (repo blocks point ALL apps at `widget.ellotryon.com` → public backend; moot for client #1, which gets a per-client hostname via the runbook).

---

## 3. The locked pricing decision

### What Andrew quotes on a call (final numbers)

1. **"$20,000 at signing — and 100% of it comes back as credit against your revenue share over 12 months. You never pay extra, you just pay early."** Standard at $10M+/yr brands. $10K concession floor at $7M+/yr. Below ~$6.7M/yr the deposit exceeds plausible year-1 fees — no enterprise deal; the honest answer there is self-serve Scale ($649/mo).
2. **"Flat 15% of Qualified Revenue, net of returns."** Qualified = tried it on, then bought that product; auditable line-by-line against Shopify order IDs. The 5/10/15 tiers exist only as an internal concession.
3. **"30-day holdout trial. No lift at 95% confidence, you get the deposit back minus $2,500."** Contract paper says retention = max($2,500, $0.10 × trial try-ons); quote "$2,500" on the call.
4. **"$1,000/month minimum after the credit, and a hard annual cap set at signing."** Cap = 0.5% of brand annual revenue (LA: $400K on $80M — exactly the quoted number). At normal adoption the cap never binds; it's CFO comfort that costs ~nothing (binds only above ~$111M/yr or >3.33% adoption at $100M, and even binding, worst-case margin is 58%).
5. **"At renewal, buy out to a flat license at 75% of trailing run rate."** $80M brand at defaults ≈ $216K/yr.

> **One policy conflict Andrew must settle:** the 2026-07-10 intake-wizard update redefined the deposit as computed-per-brand cost coverage (3 months compute + $2,500, floor $5K, cap $100K), but the vault term sheet and this audit's brief both still say $20K standard. **Recommendation: keep the flat $20K for $10M+/yr brands** — it's quotable without a wizard, it's 100% credited so the client's economics are identical, it's ≈6× the steady monthly fee (a real commitment filter), and the wizard formula produces deposits too small to cover implementation + seriousness at enterprise scale ($5K on a $10M brand). Keep the computed formula as the internal *concession calculator* only. Whichever way this lands, update the term sheet and the wizard to agree.

### Why it's safe (the margin math, cross-validated by two independent workstreams)

Gross margin is brand-size independent: **GM = 1 − 0.5583/rpt** (rpt = qualified $ per try-on; netF = 0.8, 15% share, $0.067 COGS).

| rpt | $2 | $3 | $5 | **$10 (measured, Atlas)** | $15 | $25 |
|-----|----|----|----|--------------------------|-----|-----|
| Margin | 72% | 81% | 89% | **94.4%** | 96% | 98% |

Failure corners: margin crosses 80% at rpt = $2.79, 50% at $1.12, **0% at $0.56** — 18× worse than measured, 3.6× below the plausible floor. Dormant deals stay profitable (Ello keeps the deposit; the $1K minimum is profitable at any rpt > $0.56). Year-1 gross profit at defaults: $10M brand → ~$28K, $50M → ~$141K, $100M → ~$282K (92–94% margin including a $55/mo infra allocation).

### Contract guardrails (write these in — they close every exposed corner)

- **Compute allowance:** 45 included try-ons per $100 of Qualified Revenue; beyond it, $0.10/try-on (cost + 49%). Never triggers above rpt $2.79; the measured store runs 3.6× inside it.
- **Failed-trial retention:** max($2,500, $0.10 × trial try-ons). Flat $2,500 stops covering pilot compute above ~$30M/yr brands at bad ratios (an LA-scale failed pilot at rpt=$2 runs −$4,200 before labor).
- **Cap floor:** never sign a cap below 0.5% of brand annual revenue.
- **Deposit sizing:** ≈ 6× expected steady monthly fee (≈ 0.2% of brand annual revenue).
- **Credit expiry:** credit expires at month 12 whether or not the client cancels (current v3 wording covers early-cancel only). Internal concession: one-time 6-month extension.
- **Lift bar:** 95% confidence, 200 sessions/group, 10 buyers/group, 30-day attribution — verbatim, matching the shipped Proof Engine.

### Two-lane routing rule

- **Under $1M/yr:** self-serve only (Free 10 → $49/75 → $97/300 → $249/1,500 → $649/5,000 try-ons; overage $0.15/try-on, auto-enabled on paid plans — note: the code auto-enables at subscribe, `app/lib/shopify-billing.server.ts:261-284`; older notes saying "default OFF" are stale for paid plans).
- **$1M–$10M/yr:** the book-a-call gate fires (as built), but the offer on that call is **Scale/Growth annual + assisted onboarding**, not the term sheet — at $5M/yr, year-1 fees ≈ $15K < the $20K deposit; the deal is dead on arrival. Two-track call script needed.
- **$10M+/yr:** Term Sheet v3.
- **Graduation trigger (self-serve → enterprise):** two consecutive months over 5,000 try-ons, or identified $10M+/yr. The honest flip pitch is **risk transfer, not price** — at rpt=$10, rev share costs the merchant ~$1.20/try-on vs $0.15 on Scale overage; enterprise is for brands that want it proven on their own traffic with downside capped at $2,500.

### External one-pager (ready to lift verbatim; render light-mode-first, Primary Blue #3B63D4, Ink #0B1220 per vault Brand-Palette.md; zero em dashes by design)

```markdown
# Ello Enterprise: Virtual Try-On, Priced on Proof

Ello puts a virtual try-on experience on your Shopify store. Your shoppers
try your pieces on a photo of themselves before they buy. You pay a share
of the sales it demonstrably creates, and nothing else.

## What it costs

**$20,000 launch deposit at signing.** This is a prepayment, not a fee.
Every dollar of it comes back to you as credit against the revenue share
over the first 12 months. It funds implementation, the measured trial, and
launch support. No cash invoice is sent until the credit is used up.

**15% of Qualified Revenue, net of returns.** A sale qualifies only when a
shopper used the try-on on a product and then bought that product. Cart
adds that never convert do not count. Returns and refunds are netted out
monthly. Shipping and taxes are excluded.

**$1,000 per month minimum**, and only after the deposit credit is
exhausted. **An annual cap**, set at signing, gives your finance team a
hard ceiling on what a year can cost. After the trial the agreement is
month to month with 30 days written notice.

Your total cost in year one is exactly what the revenue share alone would
have been. You pay early. You never pay extra.

## What the trial proves

For 30 days we split your traffic. Most shoppers see the try-on. A holdout
group, selected by a deterministic algorithm, never sees it at all. That
answers "they would have bought anyway" with your own data instead of
argument. The verdict requires a real sample (hundreds of sessions and
real buyers in each group) and 95% statistical confidence before we call
it, and you see the readout from your own dashboard.

**If the trial shows no measurable lift, you get the deposit back minus
$2,500.** Your total downside is $2,500 and thirty days. If lift is
proven, we continue on the terms above.

During the trial you promote the feature on your own channels (three texts
a week to your list and one Instagram story). We supply all copy and
creative. This makes sure the test sees representative traffic.

## What you can audit

The system of record is Ello's attribution pixel. Every qualified sale
appears line by line in your dashboard with its Shopify order ID, so your
team can reconcile our invoice against your own order data any month they
want. The attribution window and returns window are stated in the
contract, not left vague.

For honesty about the evidence so far: in the one store where we have
measured it, 18.3% of try-on sessions led to a purchase of that product
(21 of 115 sessions over 30 days). That is a single store and a small
sample. The point of your trial is to produce your number, on your
traffic, before you owe anything.

## The path off the meter

After 6 to 12 months of data, you can convert to a flat annual license at
roughly 75% of your trailing revenue-share run rate. Predictable line item
for your CFO, priced on value that has already been proven on your store.

## The deal in one paragraph

$20,000 at signing, fully credited back against fees. Thirty-day split
test on your own traffic. No lift, you walk with all but $2,500. Proven
lift, you pay 15% of the sales the try-on creates, net of returns, with a
monthly minimum of $1,000 after the credit and a hard annual cap your
finance team sets with us at signing.
```

### Internal margin table (glance at mid-call)

Defaults: 3% through try-on, 20% returns, rpt=$10, 15% share.

| Brand/yr | Deposit | Steady fee/mo | Try-ons/mo | COGS/mo | Margin | Yr-1 client pays | Cap (0.5% rev) | Buyout at renewal |
|----------|---------|---------------|------------|---------|--------|------------------|----------------|-------------------|
| $10M | $20K (floor $10K) | $3,000 | 2,500 | $168 | 94.4% | $30,000 | $50K | $27K/yr |
| $25M | $20K | $7,500 | 6,250 | $419 | 94.4% | $75,000 | $125K | $67.5K/yr |
| $50M | $20K | $15,000 | 12,500 | $838 | 94.4% | $150,000 | $250K | $135K/yr |
| $80M (LA) | $20K | $24,000 | 20,000 | $1,340 | 94.4% | $260,000 | $400K (as quoted) | $216K/yr |
| $100M | $20K | $30,000 | 25,000 | $1,675 | 94.4% | $300,000 | $500K | $270K/yr |

---

## 4. Billing-compliance ruling (settled)

**Billing an enterprise client via Stripe/invoice is allowed if and only if the client installs a custom-distribution app — which is exactly the architecture Ello already runs (`SKIP_BILLING=true`, `APP_DISTRIBUTION=SingleMerchant`). It is prohibited on the public app, including "unlisted" direct-install-link distribution.**

- Shopify App Store requirements §1.2.1: apps using off-platform billing cannot be distributed through the App Store; public apps must use Shopify App Pricing or the Billing API. No "limited visibility" carve-out exists any more.
- Shopify staff (Donal-Shopify) on the community thread, April 2, 2026: the March advice to request a Billing API exemption was retracted — all public apps, including unlisted ones on direct install links, must use the Billing API or Managed Pricing.
- Shopify distribution docs: custom-distribution apps **"can't use the Billing API"** and require no app review — external billing is the *only* mechanism, by design.

**Caveats resolved:**
1. **One app per client** — but a single custom app covers multiple storefronts *within one Shopify Plus organization* (checkbox at install-link generation). Ask the Plus-org question before creating the app.
2. Admin-created "custom apps" are token-based (no OAuth, no theme extensions, no embedded admin) — **only Partner-Dashboard custom distribution works** for Ello.
3. Install link: Partner Dashboard → App distribution → Custom → enter the client's myshopify.com domain → generate link. **The distribution choice is permanent** and the target store likely can't be re-pointed — treat the Kaizen-era "Custom Ello App" as non-reusable; create a fresh app per client.

**Consequence:** Term Sheet v3's Stripe model *requires* the custom-distribution lane. The public app must never carry an external-billing deal.

---

## 5. Onboarding runbook: signed deal → live

**Architecture decision: DEDICATED Cloud Run service per custom client** (not shared). One service carries exactly one Shopify app's credentials (`app/shopify.server.ts:25-30`), and each client is necessarily a separate Shopify app. Cost ≈ $0 idle (scale-to-zero until A8's min-instances); blast-radius isolation; per-client RAM/quota. Everything stays on the one Supabase project (rows keyed by shop domain/slug; provisioning is automatic on install).

**Total: ~4–5 hours Ello-side hands-on; 1–2 business days elapsed** (gated on client install click + theme access).

| # | Step | Owner | Time |
|---|------|-------|------|
| 1 | Partner Dashboard: create app "Ello VTO — \<Client\>", **Custom distribution**, enter client's myshopify domain (multi-store checkbox iff Plus org), generate link, record client_id/secret. Distribution choice is permanent — verify the domain first. | Andrew | 20 min |
| 2 | Repo config from template (A9): `shopify.app.<client>.toml` + `cloud_run_env_<client>.yaml`. Must-keep: `SKIP_BILLING=true`, `BILLING_TEST_MODE=true`, `APP_DISTRIBUTION=SingleMerchant`. Must-change: client_id/secret, app URL ×2, `ML_API_URL`; add `SUPABASE_ANON_KEY` (missing from the current custom yaml). api_version 2026-04. | Scriptable | 20 min |
| 3 | Pre-deploy gate: `npm run lint && npm run typecheck && npm run build`. | Scriptable | 10 min |
| 4 | Deploy: `gcloud run deploy ello-vto-<client> --source . --region us-central1 --env-vars-file cloud_run_env_<client>.yaml --project ello-vto --allow-unauthenticated --memory 2Gi` + `--update-secrets=TELEGRAM_BOT_TOKEN=telegram-bot-token:latest` on first deploy. (Chicken-and-egg: deploy once to learn the URL, fill TOML/env, redeploy.) | Scriptable; Andrew's explicit "go" | 15 min |
| 5 | Clone CDN worker per §5C below (Workers Paid first). | Andrew / scriptable via wrangler | 20 min |
| 6 | Theme-extension deploy: parametrized deploy script with `CUSTOM_URL=https://widget-<client>.ellotryon.com` and `--config <client>`. Watch the sed silent-no-op trap until A9 lands. | Scriptable | 10 min |
| 7 | Send install link; client installs. `afterAuth` auto-provisions Supabase (`vto_accounts`/`vto_stores`/`vto_subscriptions` on plan `custom_distribution`), mints storefront token, activates pixel, fires Telegram alert. Confirm alert + `vto_stores` row. | Client + Andrew | 15 min + client latency |
| 8 | **SQL (Andrew pastes — never auto-run):** per-client plan + repoint + cap check:<br>`INSERT INTO vto_plans (code, display_name, included_tryons_per_month, …) VALUES ('enterprise_<client>', '<Client> Enterprise', 1000000, …) RETURNING id;`<br>`UPDATE vto_subscriptions SET plan_id='<new id>' WHERE account_id=(SELECT id FROM vto_accounts WHERE shopify_shop_domain='<client>.myshopify.com');`<br>`SELECT store_slug, shopper_limit_enabled, shopper_limit_count FROM vto_stores WHERE shop_domain='<client>.myshopify.com';` (cap defaults ON at 15/24h since sec_05; term sheet requires ON — force `true` if the row predates). | Andrew | 15 min |
| 9 | **Stripe:** Customer + one-off Invoice for the $20K deposit ("Enterprise Launch Deposit"), due on signing, **bank transfer/ACH** (card fees ≈ $580 at $20K). **Manual monthly invoices, not a subscription** — variable rev-share + credit burn + post-credit minimum + cap don't fit Stripe subscriptions. Monthly flow: `/app/proof` receipts CSV export → compute 15% → decrement the credit ledger (one canonical sheet) → $0-due statements until credit exhausts, then real invoices. | Andrew | 20 min setup, ~30 min/mo |
| 10 | **Proof Engine trial:** A1's migration must be applied. Start the experiment from `/app/proof` (10% holdout default) the day the widget goes live — this is the Term Sheet §4 trial clock. | Andrew (SQL) + verify | 20 min |
| 11 | Client-side theme enable: app embed + inline button block in the theme editor; placement/products in embedded admin. Verify on the live PDP, not the editor preview. | Client + Andrew | 20 min |
| 12 | **Go-live verification:** (a) `curl -I https://widget-<client>.ellotryon.com/widget-main.js` → 200 + cf-cache-status; (b) config pass-through 200; (c) one real render end-to-end through the client hostname; (d) PDP network tab shows client-hostname assets; (e) shopper cap test → 429; (f) exposure rows landing in `vto_ab_exposures`; (g) Cloud Run + Worker error rates through first traffic day. | Claude | 45 min |
| 13 | Day-0 paid switches (A6) if not already done. | Andrew | 15 min |

### 5B. Hardcoded values a new client requires changed (why A9 exists)

15 items traced: client_id + application_url + redirect_urls + api_version (`shopify.app.custom.toml:3,5,12,34`); API key/secret + `SHOPIFY_APP_URL` + `ML_API_URL` (`cloud_run_env_custom.yaml:2-3,7,15`); missing `SUPABASE_ANON_KEY`; `PUBLIC_URL`/`CUSTOM_URL`/`--config` (`scripts/deploy-custom.sh:15,16,46` — **silent-break sed**); `ello_backend_url` in 3 liquid blocks; the shared `custom_distribution` plan row (A2); Telegram cron (public-only); Cloud Run naming trap (3 sibling `custom-ello-app*` services exist).

### 5C. CDN clone procedure (per client)

1. Workers Paid first ($5/mo covers all workers; Free = 100K req/day, fail-closed rule per `CLOUDFLARE_CDN_DECISION.md:199-200`).
2. Copy `cloudflare/widget-proxy-worker.js` → worker `ello-widget-proxy-<client>`; change only `ORIGIN` (line 29). Keep TTL logic untouched.
3. Cloudflare dashboard → add **Custom Domain** `widget-<client>.ellotryon.com` to the worker (auto DNS + cert on the zone; apex/www stay DNS-only Lovable).
4. Disable workers.dev subdomain; Bot Fight Mode stays OFF.
5. Deploy the theme extension with `CUSTOM_URL="https://widget-<client>.ellotryon.com"` — the loader derives everything from this hostname **including `/tryon` renders**; a CDN misconfig breaks the widget, not just slows it.
6. Verify: HIT/MISS on loader+main, byte parity CF↔origin, CORS preflight, config pass-through, one real render. Confirm the new service's build includes `client-ip.server.ts` before trusting the shopper cap behind CF (else all shoppers share one rate-limit bucket).
7. Rollback: revert liquid to the raw run.app URL + `shopify app deploy`; worst-case staleness 10 min.

---

## 6. Supporting evidence (capacity + data layer)

### 6A. Load-readiness scorecard (WS-1)

Model: 100K sessions/day ≈ 250K widget boots/day (~3/s avg, ~90/s momentary at 10× drop — light, since statics ride the CDN and bootstrap/config are instance-cached). Try-ons 10K/day → **25–70 concurrent renders at a 5–10× drop** (10–30s render), or 105–315 concurrent if the engine degrades toward the 90s timeout.

| Wall | Today | Failure number → after fixes |
|------|-------|------------------------------|
| Front-door memory (512Mi) | **FAIL at drop** | OOM ~40–60 concurrent renders/instance (compressed bodies); ~10–15 with stale-widget 5–8MB bodies → at 1Gi: past the 80-slot cap for compressed traffic → with B1 split: RAM can't be the killer |
| Front-door CPU/slots | PASS | 1,600 cluster slots ≫ ~335 worst case; only wound is min-0 cold starts in drop minute 1 (fixed by A8) |
| Render engine (512Mi, conc 80, no semaphore) | MARGINAL | OOM ~50–60 concurrent/instance → 1Gi + conc 32 (A8) makes it slot-bound |
| **Gemini quota** (AI Studio key, Tier-1-class) | **FAIL at drop — biggest unknown** | Demand ~70–210 images/min at drop vs likely ~10–20/min tier limit → A3 |
| **FASHN fallback** | **FAIL as spike absorber** | Documented 3/6/11 concurrent ≈ 33 renders/min ceiling; "500 concurrent" verbal only → A4 |

**Verified live (2026-07-12):** all three widget copies byte-identical (sha256 `3c882c92950a…`, 338,700 B raw / ~85.6KB gzip); photo compression `compressImage(…, 1280, 0.85)` in the served JS immediately before the /tryon POST; **8MB 413 guard probed live on both services** (9MB junk POST → HTTP 413 in ~0.5s); `AbortSignal.timeout(90s)` + credit release, `boundedFailOpen()` (30/store/min → 503 + Telegram), CF-aware last-hop client IP — all in the deployed image (commit `4c9526a` ⇄ revs 00170/00145). Shopper-cap-ON migration attested applied (sec_05 header).

**Cloud Run commands (A8 — run on Andrew's "go"):**

```bash
gcloud run services update ello-vto-public-13593516897 \
  --region us-central1 --project ello-vto --memory 1Gi --min-instances 1

gcloud run services update custom-ello-app-13593516897 \
  --region us-central1 --project ello-vto --min-instances 1

gcloud run services update ello-vto-13593516897 \
  --region us-central1 --project ello-vto --memory 1Gi --concurrency 32 --max-instances 40
```

(The custom render engine `ello-vto-custom` gets the same treatment if/when a custom client routes to it; note the custom app's `ML_API_URL` points there today, while the public app uses the hardcoded default engine — the render fleet is four services, not three.)

### 6B. Data layer (WS-2 — measured, not estimated)

**Correction to the prior audit: the DB is 44 MB, not ~457 MB** (`pg_database_size`, history intact to 2026-03-05 — the old figure didn't reproduce; likely a different metric). Growth recompute from measured per-row sizes and event rates: **~100 MB/day central / ~210 MB/day worst** at full LA traffic (the prior 212 was the upper bound, not the central case; key correction — widget_events fires on interaction, not per page view).

| Runway | Full LA traffic | 20% pilot |
|--------|-----------------|-----------|
| Free (today) | **2.2–4.6 days** | 11–23 days |
| Pro, no retention | 33–70 days | 165–350 days |
| **Pro + 30-day retention** | **indefinite** (steady 3.0–6.3 GB) | indefinite (0.6–1.3 GB) |

**Retention pack (A7, revised 2026-07-12 late per Andrew — "summarize, don't just delete"):** delete-path indexes → `vto_daily_store_rollups` (store-level funnel, kept forever) + `vto_daily_product_rollups` (per-product daily: views/try-ons/carts/units/orders-touched/order-revenue-touched — note "revenue touched" = total of orders containing the product, since line items carry no per-item price; don't sum that column across products) nightly at 08:50/08:55 UTC → batched `prune_events()` at 09:10 UTC (**180d raw events** — widened from 90 as the export window until the GCS raw-archive job ships — 30d web vitals, **400d tryon/purchase tables for billing-dispute defense**). Both rollups backfilled over full history with exact parity to raw (store: purchases/revenue exact; product: 1,311/1,311 try-ons). pg_cron 1.6 already installed (the `usage-cron` job proves the pattern). Full runnable SQL is in **Appendix A** below — Andrew pastes, never auto-run. Offload: nightly Cloud Run job → gzip NDJSON → `gs://ello-vto-events-archive/<table>/dt=…` (→ optional BigQuery), ≈ $0.40/mo Nearline at full scale.

**Egress:** the prior audit's headline browser→Supabase config reads are **already fixed and deployed** (loader uses localStorage keyed by `config_version` + the Cloud Run proxy; verified live on both origins). Remaining: ~150–250K server-side RPC/day + 12–18 GB/mo egress — dies on Free in ~8–12 days, trivial inside Pro's 250 GB, and B2's 30s edge cache collapses ~98% of it.

**/bootstrap:** the 3-ops-per-pageview + write-every-time UPDATE is **already fixed and deployed** (30s per-instance cache + memoized stamp, commit `4c9526a`): cache-hit = 0 Supabase ops, ~6K ops/day residual vs the prior ~1M/day.

**Standing cost after all fixes: ~$50–75/mo** (Supabase Pro $25 + Workers Paid $5–11 + Cloud Run warm instances/RAM ~$15–30 + storage cents). Within budget.

---

## 7. Day-0 switch list (delta to vault `Client-Signing-Day0-Runbook.md`)

The note's 4 switches stand. Edits applied as a dated addendum to the vault note (2026-07-12):

1. Switch 4 reframed: Stripe/invoice deals **must** be custom distribution (April 2026 ruling) — "standard: public app" remains valid only for Shopify-billed deals.
2. Switch 4: always a **dedicated** Cloud Run service (one service = one app's credentials).
3. Switch 4: install-link mechanics + permanence + "old Custom Ello App is not reusable."
4. **New Switch 5:** per-client enterprise plan row + subscription repoint (the `OVERAGE_BLOCKED` landmine).
5. **New Switch 6:** apply the Proof Engine migration before the trial clock starts.
6. **New Switch 7:** Stripe deposit invoice ($20K, bank transfer) + credit ledger opened.
7. Verify list: run the 12-check CF sweep against the per-client hostname; confirm the client-IP helper is in the new service's build before enabling the shopper cap.

---

## 8. Corrections to prior beliefs (re-baseline)

| Prior belief | Reality (verified 2026-07-12) |
|--------------|-------------------------------|
| Money/reliability fixes "staged for deploy" | **Live** — commit `4c9526a` in revs 00170 (public) / 00145 (custom); 413 guard probed live on both |
| Supabase "~457 MB used" | **44 MB**, history intact since March — prior runway pessimism ~10× on current usage (growth math still directionally right) |
| `/bootstrap` 3–4 ops/page view incl. useless write — "still open" | **Fixed & deployed** (30s cache + memoized stamp) |
| Browser reads Supabase directly for config/catalog — "still open" | **Fixed & deployed** (config_version + proxy); residual is server-side RPC volume (B2) |
| Render fleet = 1 engine | **2 engines** — custom app's `ML_API_URL` → `ello-vto-custom`; public uses the hardcoded default |
| Overage top-up "defaults OFF" | Auto-**enabled** at subscribe for paid self-serve plans (`shopify-billing.server.ts:261-284`); free/dev/custom stay opt-in-OFF |
| 212 MB/day DB growth | Conservative upper bound; central case ~100 MB/day (widget_events is interaction-gated, not per-pageview) |
| Term sheet lift bar 90% (open item) | Shipped Proof Engine gates at **95%** + 200/group + 10 buyers — contract must match (A5) |

---

## 9. The three things only Andrew can do — updated 2026-07-12 evening

*(The original item 1 — SQL pastes — is done or was already live; see the ⚡ status block.)*

1. **Flip the paid switches (~$30/mo, 15 min):** Supabase Pro ($25) and Cloudflare Workers Paid ($5) in their billing dashboards. These are the two capacity cliffs at enterprise traffic; everything else data-layer is now in place and waiting on them.
2. **Confirm the render dependency:** read the actual Gemini `gemini-3.1-flash-image` limits in AI Studio, file the paid-tier increase (and start the Vertex path if limits are Tier-1), and get FASHN's concurrency in writing. This is the single biggest unknown left in the stack (A3 + A4).
3. **Lock the paper + one product decision:** approve the four term-sheet clauses (95% bar, compute allowance, trial-retention formula, credit expiry), settle the $20K-vs-computed deposit conflict — and decide whether the shopper cap goes ON fleet-wide for existing stores (one reversible SQL; currently OFF on 17/18 stores including Atlas).

---

*Fable orchestrated audit — 4 workstreams, 5 agents total. Workstream evidence: WS-1 (load/perf incl. live probes + Gemini/FASHN research), WS-2 (measured Supabase state + retention SQL + unit economics), WS-3 (Shopify compliance ruling + runbook + gap list), WS-4 (deal simulator stress test + one-pager + routing rule). Deploy targets are never assumed: nothing was deployed, no SQL was run, no flags were flipped during this audit.*

---

## Appendix A — Retention pack SQL (HISTORICAL — already applied 2026-07-12)

> **Status:** applied live as migrations `retention_rollups_and_prune` + `product_rollups_and_180d_raw_window`. Two deltas vs the text below: raw-event horizon is now **180 days** (not 90 — Andrew's summarize-don't-delete call, until the GCS archive job ships), and a second permanent rollup `vto_daily_product_rollups` (per-product daily funnel) runs at 08:55 UTC. Kept for reference only — do not re-run.

**Step 1 — delete-path indexes.** Run one statement at a time; `CONCURRENTLY` can't run inside a transaction. (Event tables only have `(store_slug, created_at)` composites; a bare `created_at` predicate can't use them.)

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_widget_events_created_at ON public.widget_events (created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_product_view_events_created_at ON public.product_view_events (created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cart_events_created_at ON public.cart_events (created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tryon_events_created_at ON public.tryon_events (created_at);
-- vto_preview_events already has idx_vto_preview_events_occurred_at; vto_web_vitals is tiny.
```

**Step 2 — rollup table + nightly rollup** (runs BEFORE the deletes; purchases/try-ons kept 400 days for billing/attribution disputes):

```sql
CREATE TABLE IF NOT EXISTS public.vto_daily_store_rollups (
  store_slug text NOT NULL,
  day date NOT NULL,
  product_views int DEFAULT 0, pdp_sessions int DEFAULT 0,
  widget_opens int DEFAULT 0, widget_open_sessions int DEFAULT 0,
  tryons_total int DEFAULT 0, tryons_success int DEFAULT 0, tryon_sessions int DEFAULT 0,
  previews_shown int DEFAULT 0,
  carts_total int DEFAULT 0, cart_sessions int DEFAULT 0,
  purchases int DEFAULT 0, purchase_revenue numeric(14,2) DEFAULT 0,
  tryon_purchases int DEFAULT 0, tryon_attributed_revenue numeric(14,2) DEFAULT 0,
  ab_exposed int DEFAULT 0, ab_holdout int DEFAULT 0,
  PRIMARY KEY (store_slug, day)
);
ALTER TABLE public.vto_daily_store_rollups ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.build_daily_rollup(p_day date DEFAULT (current_date - 1))
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
  INSERT INTO vto_daily_store_rollups AS r
    (store_slug, day, product_views, pdp_sessions, widget_opens, widget_open_sessions,
     tryons_total, tryons_success, tryon_sessions, carts_total, cart_sessions,
     purchases, purchase_revenue, tryon_purchases, tryon_attributed_revenue)
  SELECT COALESCE(pv.store_slug, w.store_slug, t.store_slug, c.store_slug, p.store_slug), p_day,
         COALESCE(pv.views,0), COALESCE(pv.sessions,0),
         COALESCE(w.opens,0), COALESCE(w.open_sessions,0),
         COALESCE(t.total,0), COALESCE(t.success,0), COALESCE(t.sessions,0),
         COALESCE(c.total,0), COALESCE(c.sessions,0),
         COALESCE(p.n,0), COALESCE(p.rev,0), COALESCE(p.tryon_n,0), COALESCE(p.tryon_rev,0)
  FROM (SELECT store_slug, count(*) views, count(DISTINCT session_id) sessions
        FROM product_view_events WHERE created_at >= p_day AND created_at < p_day+1 GROUP BY 1) pv
  FULL JOIN (SELECT store_slug, count(*) FILTER (WHERE event_type='widget_open') opens,
             count(DISTINCT session_id) FILTER (WHERE event_type='widget_open') open_sessions
             FROM widget_events WHERE created_at >= p_day AND created_at < p_day+1 GROUP BY 1) w USING (store_slug)
  FULL JOIN (SELECT store_slug, count(*) total, count(*) FILTER (WHERE success) success,
             count(DISTINCT session_id) sessions
             FROM tryon_events WHERE created_at >= p_day AND created_at < p_day+1 GROUP BY 1) t USING (store_slug)
  FULL JOIN (SELECT store_slug, count(*) total, count(DISTINCT session_id) sessions
             FROM cart_events WHERE created_at >= p_day AND created_at < p_day+1 GROUP BY 1) c USING (store_slug)
  FULL JOIN (SELECT pe.store_slug, count(*) n, sum(pe.total_price) rev,
             count(*) FILTER (WHERE ts.session_id IS NOT NULL) tryon_n,
             sum(pe.total_price) FILTER (WHERE ts.session_id IS NOT NULL) tryon_rev
             FROM purchase_events pe
             LEFT JOIN LATERAL (SELECT session_id FROM tryon_events te
               WHERE te.session_id = pe.session_id AND te.success LIMIT 1) ts ON true
             WHERE pe.created_at >= p_day AND pe.created_at < p_day+1 GROUP BY 1) p USING (store_slug)
  ON CONFLICT (store_slug, day) DO UPDATE SET
    product_views=EXCLUDED.product_views, pdp_sessions=EXCLUDED.pdp_sessions,
    widget_opens=EXCLUDED.widget_opens, widget_open_sessions=EXCLUDED.widget_open_sessions,
    tryons_total=EXCLUDED.tryons_total, tryons_success=EXCLUDED.tryons_success, tryon_sessions=EXCLUDED.tryon_sessions,
    carts_total=EXCLUDED.carts_total, cart_sessions=EXCLUDED.cart_sessions,
    purchases=EXCLUDED.purchases, purchase_revenue=EXCLUDED.purchase_revenue,
    tryon_purchases=EXCLUDED.tryon_purchases, tryon_attributed_revenue=EXCLUDED.tryon_attributed_revenue;
$$;

SELECT cron.schedule('vto-daily-rollup', '50 8 * * *', $$SELECT public.build_daily_rollup();$$);
```

**Step 3 — nightly retention deletes** (09:10 UTC = off-peak; batched, no long locks; 90d raw events, 30d web vitals, 400d money tables):

```sql
CREATE OR REPLACE FUNCTION public.prune_events()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE n int;
BEGIN
  LOOP DELETE FROM widget_events WHERE id IN (SELECT id FROM widget_events WHERE created_at < now()-interval '90 days' LIMIT 50000);
    GET DIAGNOSTICS n = ROW_COUNT; EXIT WHEN n = 0; END LOOP;
  LOOP DELETE FROM product_view_events WHERE id IN (SELECT id FROM product_view_events WHERE created_at < now()-interval '90 days' LIMIT 50000);
    GET DIAGNOSTICS n = ROW_COUNT; EXIT WHEN n = 0; END LOOP;
  LOOP DELETE FROM vto_preview_events WHERE id IN (SELECT id FROM vto_preview_events WHERE occurred_at < now()-interval '90 days' LIMIT 50000);
    GET DIAGNOSTICS n = ROW_COUNT; EXIT WHEN n = 0; END LOOP;
  LOOP DELETE FROM cart_events WHERE id IN (SELECT id FROM cart_events WHERE created_at < now()-interval '90 days' LIMIT 50000);
    GET DIAGNOSTICS n = ROW_COUNT; EXIT WHEN n = 0; END LOOP;
  DELETE FROM vto_web_vitals WHERE created_at < now()-interval '30 days';
  DELETE FROM tryon_events WHERE created_at < now()-interval '400 days';
  DELETE FROM purchase_events WHERE created_at < now()-interval '400 days';
END $$;

SELECT cron.schedule('vto-event-retention', '10 9 * * *', $$SELECT public.prune_events();$$);
```

Notes: deletes reuse space via autovacuum but don't shrink the file (disk is a high-water mark; pg_repack exists if ever needed). Revisit native partitioning only if sustained growth exceeds ~500 MB/day. The GCS/BigQuery offload job (B7) should archive each day's rows before they age past the 90-day delete horizon.
