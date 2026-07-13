# Ello VTO — Enterprise Readiness Audit
### Fable Execution Brief · Orchestrated multi-agent audit · Drafted 2026-07-12

> **You are Fable.** Run this audit by spawning a small set of focused subagents, then
> synthesize their findings into one decision. This brief is self-contained — every fact
> you need to avoid re-deriving is in Section 2. Do not exceed **5 agents total**
> (you as lead + 4 workstream subagents). Andrew has been burned by agent swarms; stay lean.

---

## 0. The one decision this audit produces

**Is Ello VTO ready to onboard its first large paying client (LA Apparel–class: ~$10M–$100M/yr apparel brand on Shopify) without falling over, leaking money, or improvising the paperwork?**

You must end with a **GO / GO-WITH-FIXES / NO-GO** verdict backed by:
1. A ranked **punch list** of what must ship before the first big client's traffic lands.
2. A **locked enterprise pricing decision** (numbers, not ranges).
3. A **repeatable client-onboarding runbook** (signed deal → live, with the custom-app + external-billing path proven compliant).
4. A **Day-0 switch list** — what flips the moment a deal signs.

Deliver these as a single Markdown report at `FABLE-ENTERPRISE-AUDIT-REPORT.md` in this repo root, plus (optional) a visual HTML artifact matching the house style of the prior audit.

---

## 1. Scope

### In scope (this is the whole job)
- **Load & performance** — can the stack take enterprise traffic and spikes?
- **Data & cost scalability** — does it stay up and stay profitable at volume?
- **Onboarding mechanics** — the custom-distribution-app + external-billing path, end to end.
- **Pricing & deal model** — finalize what we charge and prove the margin holds.

### Out of scope (deliberately)
- **No penetration testing / offensive security work. No probing live credentials or third-party systems.** The security tier was already audited and closed on 2026-07-11 (see §2) — the 4 enterprise security deal-blockers are fixed and live. If you *happen* to notice a security regression while reading code for a performance reason, note it in one line and move on. Do not open a security workstream, do not scan for exploits, do not touch auth beyond reading it. This audit is about **capacity and go-to-market**, not defense.
- No net-new features. No redesigns. You are measuring and hardening what exists.

---

## 2. What is already known — do NOT re-derive this

### 2a. Architecture (verified from repo `CLAUDE.md`)
- **One repo, one Docker image (Node 20, React Router v7), two Cloud Run services, two Shopify apps:**

| | **Public app** (App Store) | **Custom app** (single merchant) |
|---|---|---|
| Shopify name | "Ello VTO Public" | "Custom Ello App" |
| Config file | `shopify.app.toml` | `shopify.app.custom.toml` |
| Cloud Run env | `cloud_run_env.yaml` | `cloud_run_env_custom.yaml` |
| Cloud Run service | `ello-vto-public-13593516897` | `custom-ello-app-13593516897` |
| Billing | Shopify Billing API (`BILLING_TEST_MODE=false`, real charges live) | **None — Stripe/external** (`SKIP_BILLING=true`, `APP_DISTRIBUTION=SingleMerchant`) |

- **Render engine (separate service):** `ello-vto-13593516897` (FastAPI, source at `~/Desktop/ELLO VTOW/`, not git-tracked). Primary engine **Gemini Nano Banana 2** ($0.067/try-on @ 1K res), **FASHN** fallback. Both public + custom call it via `app/routes/tryon.tsx`.
- **Widget:** `public/widget-main.js` + `public/widget-loader.js`, served by **both** Cloud Run services. A widget fix needs both deploys.
- **CDN:** Cloudflare Worker `widget.ellotryon.com` proxies widget assets — **live for the public app only** (as of 2026-07-11). A custom app on its own Cloud Run service needs its own cloned worker (`cloudflare/widget-proxy-worker.js`, swap ORIGIN, add `widget-<client>.ellotryon.com`).
- **DB:** Supabase project `rwmvgwnebnsqcyhhurti`. Tables: `vto_accounts`, `vto_stores`, `vto_subscriptions`, `vto_usage_periods`, `vto_plans`. **Still on the free tier.** Migrations run manually by Andrew in the SQL editor — you draft, he runs.
- **Dashboard:** separate Lovable project (not this repo). Do not edit it; produce a Lovable prompt if dashboard changes are implied.

### 2b. Prior audit status (Enterprise Readiness Audit, 2026-07-11 — READ IT via `WebFetch` on `https://claude.ai/code/artifact/7b5228b9-82fd-4371-a82a-7a728547483e`)
Sizing target it used, **reuse this exact load profile**: ~100K store sessions/day, 5–10K try-ons/day, **5–10× spikes** on drops/email blasts.

- **Security deal-blockers: 4 → 0, fixed & live.** (RLS holes, exposed storefront tokens, forgeable analytics, per-shopper cap spoof.) Considered closed.
- **Money/reliability bugs: fixed, "staged for deploy" as of that date** — bounded fail-open billing, render-call 90s timeout, phone-photo compression + 8MB proxy guard. ⚠️ **You must verify these are actually LIVE now, not just staged.** Memory says a deploy shipped as public rev 00170 / custom rev 00144 — confirm against the running services, do not assume.
- **Widget payload cut 472KB → 84KB (81%)** via lazy `model-images.js` + esbuild minify — verify live.
- **Still OPEN (the capacity tier — this is your real work):**
  - Free 500MB Supabase DB **fills in ~2 days** at full scale; ~212MB/day growth. Pro's 8GB only buys ~37 days. **Needs Pro + a retention policy**, not Pro alone.
  - Free egress (5GB/mo) gone in ~8 days; browser reads Supabase directly (config + catalog). **Needs front-door caching + CDN.**
  - No CDN in front of the try-on/API path; static + revenue path share one 512MB service.
  - `/bootstrap` fires 3–4 Supabase ops on every page view including a useless write (~1M ops/day at scale).
  - Cloud Run recommendations from prior audit: front door → **1GB RAM + min-instances=1**; **split `/tryon` onto its own low-concurrency service** so a render spike can't starve widget-config traffic.
  - Standing cost to fix everything: **~$40/mo** (within budget).
- **Load test caveat to fix:** prior test used **43KB sample photos** and **spoofed IPs** — so it missed the real-photo OOM (est. failure at ~13–40 concurrent uncompressed uploads) and sailed past the shopper cap. **Re-test with realistic 2–5MB phone photos.**

### 2c. Deal model (Term Sheet v3, 2026-07-10 — the current pitch)
- **$20,000 launch deposit** at signing, **100% credited** against rev share (12-mo window).
- **30-day A/B holdout trial.** Lift proven → continue; no lift → refund deposit **minus $2,500** implementation cost.
- **Flat 15% of Qualified Revenue**, net of returns. (The old 5/10/15 tiers are retired to an internal concession.)
- **$1,000/mo minimum** after credit exhausted. **Annual cap** per client (LA reference: **$400K**). Month-to-month after trial.
- **License-buyout option** at renewal ≈ 75% of trailing rev-share run rate.
- **Qualified Revenue** = shopper used try-on on a product, then bought that product. System of record = Ello's attribution pixel, auditable against Shopify order IDs.

### 2d. Proof Engine (built, commit `0f93a93`, pending migration approval + deploy)
Answers the "they'd have bought anyway" objection with an A/B holdout. FNV-1a salted hash, bit-identical in JS + SQL, 200 sessions/group + 10 buyers + 95% confidence before "proven" shows. 30-day attribution window, 7-day session. **Only real measured stat: Atlas = 18.3% try-on→purchase.** (Read via `WebFetch` on `https://claude.ai/code/artifact/7868484b-0f30-4ea7-ad4b-8dc4e90344ce`.)

### 2e. Deal Simulator (internal model — `WebFetch` `https://claude.ai/code/artifact/2cdbf77c-ce35-453b-8000-27752c652a34`)
Sliders + monthly model. Defaults worth knowing: store $3M/mo, 3% through try-on, 20% returns, 2-mo ramp, $20K deposit, 15% share, $1K min, no cap, 12-mo window, **$10 qualified-sales per try-on** (the one measured store, n=1), **$0.067 COGS/try-on**. It already computes Ello year-1 gross profit and margin — use its formulas as the backbone for WS-4, don't rebuild them.

### 2f. THE SHOPIFY BILLING ANSWER (research done 2026-07-12 — treat as a strong hypothesis, verify once)
- **App Store apps** and **unlisted/public install-link apps** → **must** use Shopify Billing API / Managed Pricing. The old "limited visibility" exemption for external billing is **no longer granted** (Shopify staff, April 2026). **Stripe is not an option on a public app.**
- **Custom-distribution apps** → **"Not subject to billing API requirements or app review."** External billing (Stripe/invoice/ACH) is the *only* option and is expected. **This is the enterprise lane, and Ello already runs it** (`SKIP_BILLING=true`, `APP_DISTRIBUTION=SingleMerchant`).
- **Known caveats to confirm in WS-3:** custom apps are limited to **one per store** (unless Shopify Plus org); the merchant-created-in-admin "custom app" vs Partner-Dashboard "custom distribution" distinction; exact mechanics of generating a single-store install link.
- Sources to re-verify: `shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements` and `community.shopify.dev/t/unlisted-public-app-is-shopify-billing-api-mandatory-or-can-we-use-stripe/32021`.

---

## 3. Orchestration model

Spawn **4 subagents in parallel** (single message, multiple `Agent` tool calls), each `general-purpose` (they must read code, run `gcloud describe`, `curl` endpoints, and compute models — not just search). Give each the relevant slice of Section 2 plus its charter below. When all 4 return, **you** (lead) run the synthesis in Section 5.

Do not spawn sub-subagents. Do not exceed 5 agents total. If a workstream is too big, narrow its scope rather than adding agents.

**Shared rules for every subagent** (paste into each):
- Read-and-measure only. **Do NOT deploy, do NOT run SQL against Supabase, do NOT flip env flags.** Propose changes as diffs/commands for Andrew to run.
- Ground every claim in a file path, a command output, or a fetched source. If unsure, say so — never guess about service names, URLs, or numbers.
- Return a structured findings list: each finding = {severity, category, what breaks, the fix, effort, file/evidence ref}. Match the prior audit's card format.

---

## 4. The four workstreams

### WS-1 — Load & Performance Verification
**Question:** At the §2b load profile *with realistic inputs*, does the stack hold — and are the prior audit's reliability fixes actually live?

**Tasks:**
1. **Verify, don't trust.** Confirm which Group A/B fixes are live in prod vs still staged: widget payload (target 84KB gzip), photo compression at `/tryon`, 8MB proxy 413 guard, `AbortSignal.timeout(90s)` on the render fetch, bounded fail-open billing, cache headers on `widget-main.js`. Check the running services (fetch the widget, inspect headers, read the deployed code paths in `app/routes/tryon.tsx`, `app/lib/usage-billing.server.ts`, `public/widget-main.js`).
2. **Cloud Run reality check.** `gcloud run services describe` both web services + the render service: RAM, concurrency, min/max instances, CPU. Compare to prior recommendations (front door 1GB + min=1; split `/tryon`). State the current values and the gap.
3. **Realistic load model.** Design (and if safe, dry-run at low volume against a dev/test target only) a load scenario using **2–5MB phone photos** and honest concurrency, including a 5–10× spike. Estimate the concurrency at which the front door OOMs *today* vs *after* the compression fix is confirmed live. Do not hammer production.
4. **Render-engine capacity.** Establish Gemini NB2 throughput/rate limits and the FASHN failover path. What happens at 500 concurrent try-ons (the verbal Fashn enterprise number)? Is there a documented capacity letter? Flag the dependency.

**Deliverable:** a load-readiness scorecard (pass/fail per capacity wall), the exact Cloud Run config changes to make, and a verdict: *would this survive an LA-Apparel drop today?*

**Done when:** every prior "staged" reliability fix is confirmed live-or-not, and the OOM/concurrency ceiling is quantified with real photo sizes.

---

### WS-2 — Data & Cost Scalability
**Question:** Will the data layer fall over, and does Ello stay profitable at volume?

**Tasks:**
1. **DB runway + retention.** Confirm the ~212MB/day growth math against current table sizes. Design the retention policy: partition + drop `widget_events`/`tryon_events`/`cart_events` older than 30–90 days (or nightly delete), and an offload path (BigQuery/GCS) keeping only rollups. Write the exact SQL/migration for Andrew to run. Answer precisely: Supabase Pro alone buys how many days, and Pro + retention buys what.
2. **Egress + caching.** Quantify browser→Supabase direct reads (config + catalog, ~70-col store row). Specify the front-door cache (keyed by store + `config_version`) and confirm CDN coverage — public app on `widget.ellotryon.com`, and the **gap**: a custom client on its own service has no worker yet.
3. **`/bootstrap` waste.** Confirm the 3–4 ops/page-view including the useless UPDATE; propose the memoize + fold-into-cached-config fix.
4. **Unit economics at scale.** Using $0.067/try-on and the deal model, build a cost-vs-revenue table across brand sizes ($10M / $50M / $100M/yr). At the 15% flat rev share, what is Ello's gross margin at each size, and where is the try-ons-per-sale ratio that turns a deal unprofitable? (Lower "$ per try-on" = more compute per sale = margin risk — stress this.)

**Deliverable:** a cost-at-scale model + the retention/caching implementation spec (with runnable SQL) + the exact Day-0 dashboard upgrades (Supabase Pro $25/mo, Cloudflare Workers Paid $5/mo) and what each unlocks.

**Done when:** there is a written answer to "does the DB survive 90 days of LA traffic" and "at what point does a deal lose money."

---

### WS-3 — Custom-App Onboarding & Billing Compliance
**Question:** Can we turn on a big Shopify client repeatably, and is billing them via Stripe actually allowed?

**Tasks:**
1. **Lock the billing-compliance answer.** Verify §2f against the two Shopify sources. Write the definitive one-paragraph ruling: *custom-distribution app = no Billing API requirement = bill via Stripe/invoice, expected and allowed; public/unlisted = must use Shopify billing.* Resolve the caveats: one-custom-app-per-store, Plus-org exceptions, and exactly how a single-store custom-distribution install link is generated in the Partner Dashboard.
2. **Prove the existing path end-to-end.** Trace the custom app today: `shopify.app.custom.toml`, `scripts/deploy-custom.sh` (the widget-URL swap), `cloud_run_env_custom.yaml` (`SKIP_BILLING`, `APP_DISTRIBUTION`), and how it previously ran for Marcos/Kaizen. Identify every manual step and every place it could break for a *new* client.
3. **The CDN clone gap.** Document cloning `cloudflare/widget-proxy-worker.js` for a new client service (`widget-<client>.ellotryon.com`) — the piece that is not yet templated.
4. **Write the runbook.** Produce a step-by-step "spin up a new enterprise client" runbook: create custom-distribution app → point at a Cloud Run service (shared vs dedicated — recommend which, when) → deploy via the custom flow → clone CDN worker → set SKIP_BILLING/flags → set up Stripe billing + the deposit invoice → configure per-shopper cap ON → go live + verify. Time-estimate each step.

**Deliverable:** the onboarding runbook + the billing-compliance ruling + a gap list (what's manual today that must be scripted/templated before client #1).

**Done when:** Andrew could hand the runbook to a competent operator and get a client live without reverse-engineering the repo.

---

### WS-4 — Pricing & Deal Model Finalization
**Question:** What exactly do we charge, does it stay profitable, and who goes self-serve vs custom?

**Tasks:**
1. **Stress-test Term Sheet v3.** Using the Deal Simulator's formulas (§2e) and WS-2's COGS numbers, confirm the $20K deposit + flat 15% + $1K min + per-client cap stays profitable across brand sizes and across the "$ per try-on" range (2–25). Find the failure corner and state the guardrail (minimum cap? floor on $ per try-on written into the contract?).
2. **Two-lane routing rule.** Reconcile the **self-serve public-app pricing ladder** (Tier I/II/III + free tier + "contact for enterprise," Shopify-billed) with the **custom enterprise deal** (Stripe, rev-share). Write the rule: which prospect goes which lane, and the revenue threshold where a brand graduates from self-serve to a custom deal.
3. **Produce the external one-pager.** The LA Apparel project note has "pricing one-pager for enterprise tier" as an open deliverable — produce it: clean, brand-correct (palette in `~/Desktop/Vault/02-Areas/Ello/_context/Brand-Palette.md`), walk-a-prospect-through-it clear. No zombie stats (only verified numbers; the one real proof stat is Atlas 18.3%).
4. **Internal margin table.** The private version: per brand size, expected deposit, monthly rev-share, COGS, gross margin, and cap.

**Deliverable:** the enterprise pricing one-pager (external) + the internal margin/floor table + the self-serve-vs-custom routing rule.

**Done when:** Andrew can quote a live prospect a number on a call without recomputing anything.

---

## 5. Synthesis (lead / Fable does this after all 4 return)

1. **Reconcile & dedupe** findings across workstreams. Rank the full punch list by "blocks the first client / needed before full traffic / hardening-later" (mirror the prior audit's Group A/B/C tiers).
2. **Write the GO / GO-WITH-FIXES / NO-GO verdict.** Be decisive. If GO-WITH-FIXES, the fixes are the top of the punch list with owners and effort.
3. **Assemble the four deliverables** into `FABLE-ENTERPRISE-AUDIT-REPORT.md`:
   - The verdict + ranked punch list.
   - The locked pricing decision (one-pager + internal table + routing rule).
   - The onboarding runbook + billing-compliance ruling.
   - The Day-0 switch list (extend the existing `Client-Signing-Day0-Runbook.md` in the vault — don't duplicate it, reference and update it).
4. **Optional:** render the report as an HTML artifact in the house style of the prior audit (same CSS system: verdict banner, stat tiles, severity cards, progress track).
5. **Surface the top 3 things Andrew must personally decide or pay for** (e.g., approve Proof Engine migration + deploy, upgrade Supabase Pro, lock the cap policy). Keep it to 3.

---

## 6. Rules of engagement (non-negotiable)
- **≤5 agents total.** No sub-subagents. No swarms.
- **No deploys.** Show diffs and the exact `gcloud`/`shopify` command; Andrew runs it after an explicit "go." Deploy targets are never assumed — public, custom, and ML are separate decisions.
- **No direct SQL.** Draft it; Andrew pastes into the Supabase SQL editor.
- **No dashboard edits.** Produce a Lovable prompt instead.
- **Pre-deploy gate exists** (`npm run lint && npm run typecheck && npm run build`) — reference it in any change you propose; there is no test script.
- **Accuracy bar:** if not 100% sure, verify (read the file, run the describe, curl the URL) or flag it. Never guess service names, URLs, flags, or numbers.
- **Security:** measurement only, no offensive testing. The security deal-blockers are already closed — do not reopen that work.
- **Brand:** any user-facing surface reconciles against `Brand-Palette.md` (Primary Blue `#3B63D4`, Ink `#0B1220`, light-mode-first). Never invent hex values.

---

## 7. Suggested kickoff (how Fable starts)
1. Read this brief fully. `WebFetch` the three artifacts in §2b/§2d/§2e for full detail.
2. Confirm the current live state of both web services (`gcloud run services describe …`) and the widget headers — so WS-1 starts from truth, not the 2026-07-11 snapshot.
3. Spawn WS-1…WS-4 in parallel with their charters.
4. On return, synthesize per §5 and write the report.

*Load profile, deal numbers, architecture, and the Shopify billing ruling are all in §2 — start there, don't rediscover them.*
