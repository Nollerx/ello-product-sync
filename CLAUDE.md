# Ello VTO — Operating Brief

You are working in `~/ello-storefront-app/`. Read this end-to-end before doing anything. **Verified 2026-09-18.**

Authoritative (more detailed) source of truth: vault note `02-Areas/Ello/_context/Project-Map.md`. Search via `obsidian read file="Project-Map"`.

## What this repo deploys to

This single repo (`Nollerx/ello-product-sync`, branch `main`) builds **one Docker image** (Node 20, React Router v7) that gets deployed to **two different Cloud Run services**, bound to **two different Shopify apps**. The differentiator is which `cloud_run_env_*.yaml` file you pass on deploy.

|  | **Public app** (App Store) | **Custom app** (single merchant) |
|---|---|---|
| Shopify name | "Ello VTO Public" | "Custom Ello App" |
| Shopify client_id | `bf99e755a15b78cc0dc496d45f1cd75e` | `3ab87c3a17258dd8b44f288b81b7dfc7` |
| Shopify config file | `shopify.app.toml` | `shopify.app.custom.toml` |
| Cloud Run env file | `cloud_run_env.yaml` | `cloud_run_env_custom.yaml` |
| Cloud Run service | `ello-vto-public-13593516897` | `custom-ello-app-13593516897` |
| Billing | Shopify Billing API (`BILLING_TEST_MODE=false` — real charges live as of 2026-05-16) | None — Stripe-billed externally (`SKIP_BILLING=true`, `APP_DISTRIBUTION=SingleMerchant`) |
| Live merchants | **Atlas Apparel** (`ecmxv0-vh`, atlasapparel.store) — Ello Launch $97/mo, Shopify-billed, active. First recurring customer; treat it as production. | Formerly **Marcos Rivera / Kaizen Marketing** — no longer a customer; no active paying merchant on the custom app |

A parallel Cloud Run service `custom-ello-app-13593516897-13593516897` (doubled suffix) also exists and has received deploys recently. It responds at `https://custom-ello-app-13593516897-13593516897-13593516897.us-central1.run.app` (triple-suffix URL). Shopify routes the Custom Ello App to the **single-suffix** service via `shopify.app.custom.toml`'s `application_url`, so the doubled one is **not** what the Custom Ello App serves. Don't deploy to it without investigating where its existing deploys came from.

## ML / try-on inference service (separate)

- **Source:** `~/Desktop/ELLO VTOW/` (FastAPI Python, entrypoint `main.py`) — **not git-tracked**, edit with care
- **Cloud Run service:** `ello-vto-13593516897`
- **URL used in code:** `https://ello-vto-13593516897-13593516897.us-central1.run.app` (referenced near the top of `app/routes/tryon.tsx` — grep `ML_API_URL`, the line moves)
- **Affects every merchant** — public + custom both call this
- **Env:** `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` / `SUPABASE_URL` / `SCOPES` set inline; `FASHN_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `WIDGET_BOOTSTRAP_SECRET` pulled from Google Secret Manager. Env is preserved across `--source` redeploys — no env-vars file needed.
- ⚠️ The `SHOPIFY_API_KEY` on this service is `5a061b1380e2f426010459c372872b55`, which is the legacy `Ello Storefront App` client_id, not public or custom. May be vestigial — check before assuming it's wired to anything.

## Dashboard (NOT in this repo)

The merchant-facing dashboard is a Lovable project, not a Cloud Run deploy. It reads/writes the same Supabase project the apps use.

- **Production:** https://dashboard.ello.services
- **Lovable editor:** https://lovable.dev/projects/465507e3-121c-443b-9433-110fe1ed1d21
- **Preview (login):** https://id-preview--465507e3-121c-443b-9433-110fe1ed1d21.lovable.app
- **Published:** https://final-tryon-insights-dashboard.lovable.app
- **GitHub mirror (auto-synced both directions):** https://github.com/Nollerx/final-tryon-insights-dashboard
- **Backend:** same Supabase project (`rwmvgwnebnsqcyhhurti`), accessed via Lovable Cloud (no separate Supabase login)

**Handoff rule:** when dashboard work is needed, **do not edit the Lovable repo**. Produce a copy-pasteable Lovable prompt for Andrew to paste into the Lovable editor. Match the format of `LOVABLE_BILLING_PROMPT.md` and `LOVABLE_WIDGET_POSITION_PROMPT.md` in this repo's root.

## Supabase

- **Project ref:** `rwmvgwnebnsqcyhhurti`
- **URL:** `https://rwmvgwnebnsqcyhhurti.supabase.co`
- **Tables:** ~119 tables/views are exposed — the five billing ones (`vto_accounts`,
  `vto_stores`, `vto_subscriptions`, `vto_usage_periods`, `vto_plans`) are a small
  slice. The ones most work actually touches: `tryon_events` (every try-on, with
  `success`), `clothing_items` (the print-side/carry EXCEPTIONS table — NOT a
  catalogue mirror), `widget_events`, `purchase_events`, `cart_events`,
  `refund_events`, `vto_live_sessions`. Introspect rather than assuming this list
  is complete.
- **PostgREST caps an unlimited select at 1000 rows.** Aggregate in SQL (an RPC)
  for anything that scales, or a query silently returns a truncated slice and the
  code computes confidently wrong numbers.
- **Edge functions:** in `supabase/functions/`. Deploy: `supabase functions deploy <name> --project-ref rwmvgwnebnsqcyhhurti --no-verify-jwt`
- **Migrations:** in `supabase/migrations/`. Andrew runs them manually in the Supabase SQL editor. Lovable Cloud manages permissions, so do not assume Supabase MCP can execute against this project without explicit per-statement authorization.

### Adding a widget-config field (checklist — every step, or the field silently no-ops)
A merchant-facing widget setting travels: `vto_stores` column → `get_widget_config` RPC → `/api/widget-config` → widget-loader.js `ELLO_STORE_CONFIG` mapping → widget-main.js consumer, with `config_version` as the cache key. Miss one link and the dashboard preview looks right while every storefront serves the old config. Incident 2026-07-25: `ctl_intro_style` + button border saved to the DB but never appeared on the test store because step 3 was missed. Update ALL of:
1. `vto_stores` column (+ CHECK constraint)
2. `get_widget_config` RPC — typed TABLE, so DROP + CREATE and re-GRANT EXECUTE to anon/authenticated/service_role
3. **`bump_vto_store_config_version()` trigger — add the column to BOTH watched tuples (NEW.* and OLD.*).** A save that changes only an unwatched column never bumps `config_version`, so cached storefronts never refetch.
4. widget-loader.js config mapping
5. widget-main.js consumer
6. `app.widget-design.tsx` loader + action

## Live Try-On (Decart realtime mirror) — added 2026-08-02

Camera → WebRTC → Decart `lucy-vton-3` → full-screen mirror overlay. The whole
session auto-records (MediaRecorder on the transformed stream, on-device only)
and replays at the end so shoppers can spin 360 and scrub back — no capture
button (Andrew 2026-08-02). Static 2D try-on is untouched; live failures
degrade to it silently.

- **Server:** `app/routes/api.live-token.tsx` (gates on `vto_stores.live_tryon_enabled`
  + daily/shopper caps, mints a short-lived Decart client token scoped to model +
  origin + `maxSessionDuration` — Decart kills the stream at the cap server-side);
  `app/routes/api.live-session-end.tsx` (sendBeacon close-out into `vto_live_sessions`).
- **Widget:** overlay markup/CSS in `widget-template.html` (`#elloLiveOverlay`, `.elive-*`),
  controller in `widget-main.js` (search `elloLive`), config flag `tryOnLiveEnabled`
  mapped in `widget-loader.js` (+ forced off in the A/B holdout block).
- **SDK:** `public/ello-live-sdk.js` is GENERATED (vendored @decartai/sdk, ~900KB,
  lazy-loaded on first use). Rebuild with `npm run build:live-sdk`; eslint-ignored.
  Cached LONG (1 day) by the Cloudflare worker — worker redeploy needed once.
- **Env:** `DECART_API_KEY` in both cloud_run_env yamls + local `.env` (gitignored).
- **Migration:** `supabase/migrations/20260802_live_tryon.sql` (columns + `vto_live_sessions`
  + get_widget_config/trigger walk). Rollout = flag defaults false fleet-wide; enable
  per store via one SQL UPDATE (demo store first).
- **Billing caveat:** live seconds are metered in `vto_live_sessions` only — NOT yet
  wired into plan quotas or Shopify usage charges. Decart costs ~$0.02/sec realtime.

## Deploy commands (use exactly these)

### Public app
```bash
cd ~/ello-storefront-app
gcloud run deploy ello-vto-public-13593516897 \
  --source . \
  --region us-central1 \
  --project ello-vto \
  --allow-unauthenticated
```
⚠️ **Do NOT pass `--env-vars-file cloud_run_env.yaml` to the public service.** It
fails outright: `Cannot update environment variable [SHOPIFY_API_SECRET] to string
literal because it has already been set with a different type`. Five keys in that
yaml (`SHOPIFY_API_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`,
`DECART_API_KEY`, `GEMINI_API_KEY`) are Secret Manager references on the live
service, and the file would downgrade them to plaintext literals. `--source`
preserves env, so omit the file. Verified 2026-09-18: omitting it kept all 21
entries and 7 secret-refs intact. The CUSTOM command below is unaffected — none of
its yaml keys are secret-refs there.

### Custom app
```bash
cd ~/ello-storefront-app
gcloud run deploy custom-ello-app-13593516897 \
  --source . \
  --region us-central1 \
  --env-vars-file cloud_run_env_custom.yaml \
  --project ello-vto \
  --allow-unauthenticated
```

Both web services also bind `TELEGRAM_BOT_TOKEN` from Secret Manager (secret
`telegram-bot-token`, project `ello-vto` — same bot the social poster uses).
The binding persists across the plain deploys above; only re-add
`--update-secrets=TELEGRAM_BOT_TOKEN=telegram-bot-token:latest` if it's ever
cleared. `TELEGRAM_CHAT_ID` and `CRON_SECRET` live in the (gitignored) env
yamls. Two Cloud Scheduler jobs (us-central1, both `*/15 * * * *`, both POSTing to the
public service with header `x-cron-key=$CRON_SECRET`): `ello-install-followup`
→ `/api/install-followup` (2h post-install Telegram check-ins), and
`ello-store-health` → `/api/store-health` (per-store try-on failure-rate pager;
alerts at >=30% failures over 6h with an 8-attempt floor, one page per incident).

### ML service
```bash
cd ~/Desktop/ELLO\ VTOW
gcloud run deploy ello-vto-13593516897 \
  --source . \
  --region us-central1 \
  --project ello-vto \
  --allow-unauthenticated
```
(No env-vars file — service env is preserved across `--source` redeploys.)

The widget (`public/widget-main.js`, `public/widget-loader.js`) is served by both Cloud Run services, so a widget fix requires **both** public + custom deploys.

## Pre-deploy gate

```bash
npm run typecheck   # must be clean — this is a real gate
npm run build       # must be clean — this is a real gate
npm run lint        # ~413 PRE-EXISTING errors; see below
```
There is no `test` script in this repo.

⚠️ **`npm run lint` cannot go green and never blocks a deploy.** It carries ~413
pre-existing errors repo-wide — mostly `supabase/functions/*` (Deno `jsr:` /
`https://` imports eslint cannot resolve) and empty `catch {}` blocks in the
legacy `public/widget-main.js`. The usable gate is: **typecheck and build clean,
plus `npx eslint <the files you touched>` clean.** If a whole-repo lint is treated
as a blocker, nothing ever ships.

## Workflow rules (non-negotiable)

1. **Always** run the pre-deploy gate (lint + typecheck + build) before any `gcloud run deploy`. If any fails, stop and fix.
2. STANDING AUTHORIZATION (Andrew, 2026-08-31): when Andrew asks to ship/make something live, deploy WITHOUT re-asking per target — widget changes go to BOTH services (they serve the same widget files), admin/server-only changes may go public-only when custom is irrelevant. Summarize the true delta (build-archive diff) in the wrap-up instead of asking first. gcloud auth expires periodically; if a deploy fails on reauth, hand Andrew `gcloud auth login` — never try to complete a browser auth flow for him.
3. Deploy targets (context, not per-deploy gates anymore):
   - **Custom app** — single-merchant production service (Marcos / Kaizen churned; no active paying merchant). Still get an explicit "go" before deploying.
   - **Public app** — live on the App Store.
   - **ML service** — hits every merchant.
4. **Public-app billing flag:** `cloud_run_env.yaml` has `BILLING_TEST_MODE: "false"` — real Shopify charges are live (as of 2026-05-16). Do not flip this without an explicit instruction. Surface its current value before each public deploy and ask whether to keep or flip.
5. **SQL:** STANDING AUTHORIZATION (Andrew, 2026-08-31): run SQL against this project directly via the Supabase MCP — reads, migrations, and function changes — without asking per statement. Always announce what ran and keep writing the .sql file to `supabase/migrations/` first so the repo stays the source of truth. Destructive data operations (DELETE/TRUNCATE/DROP TABLE on real rows) still require an explicit ask. Note: the harness permission classifier may still block DDL until Andrew's settings allowlist includes the Supabase MCP server — if blocked, hand him the SQL to paste instead of working around it.
6. **Dashboard:** Produce a Lovable prompt; do not edit the dashboard repo directly.
7. **Git:** Direct commits to `main` and push (solo workflow). No PR/branch flow unless Andrew asks.
8. **Accuracy bar:** If you're not 100% sure of a fact, say so and verify (read the file, run the gcloud command, curl the URL). Never guess about deploy targets, service names, or URLs.
9. **Evidence bar (added 2026-09-18, after the Atlas outage).** One verified fact beats three plausible explanations. Before claiming something works, **measure it — do not estimate**; open the query, run the render, read the log, count the rows. Before shipping, ask two questions out loud: *what breaks at 100x current volume?* and *what happens if this deploys before its migration?* After touching shared logic, ask *what existing behaviour could this silently overwrite?* When an explanation sounds clean, check it against real data before repeating it — the clean answer is where I am most likely wrong.

   Why this rule exists. Every bug worth finding that day was found by a question that forced measurement rather than by carefulness:
   - A **cost** question ("how much does this cost?") made me read the sweep's query and find that PostgREST silently caps a select at 1000 rows — the alert would have computed failure rates from a truncated slice the first time LA Apparel got busy, and reported them confidently.
   - **"Why didn't the scan work, it usually does?"** proved my own first answer wrong: the scan was fine, and `print_side='back'` had never once been written in production, so the engine path was simply untested.
   - Checking whether a fix would **survive a re-scan** found that merchant print-side corrections were being silently overwritten — a bug the same day's webhook change had just made far easier to hit.
   - Checking the **existing** alerts before building new ones showed all seven were burst-shaped and structurally could not catch one store failing quietly.

   The counterweight: this standard is slow, and slow is sometimes wrong. When Andrew says "quick fix", "don't audit", or "just ship it", take him at his word and skip it. The failure mode is not being insufficiently careful — it is being careful about the wrong thing.

## Brand palette (authoritative)

**Source of truth:** `~/Desktop/Vault/02-Areas/Ello/_context/Brand-Palette.md`. Read this before styling ANY surface — marketing site, app dashboard, Shopify app UI, anything user-facing.

Quick reference (do not memorize from here — always reconcile against the doc):
- **Primary Blue** `#3B63D4` — CTAs, links, accents (logo-sampled)
- **Ink** `#0B1220` — headings, dark surfaces
- **Default backgrounds** — White `#FFFFFF` or Off-white `#FAFBFC`
- **Overall feel** — crisp blue + near-black + lots of white. Light-mode-first. Avoid heavy dark hero gradients — they conflict with the brand identity.

**Rules:**
1. Never invent hex values. If you need a color not in the palette doc, propose it as an addition and wait for approval.
2. Never save palette decisions to ephemeral agent memory. Palette state lives in `Brand-Palette.md` — update the doc, don't carry it in your head.
3. If a hero, gradient, or color choice in the existing code looks off-brand, flag it to Andrew before changing it — don't make stylistic judgment calls unilaterally.

## Env-var names (yaml files in repo root — NOT the whole picture)

`cloud_run_env.yaml` (16): `NODE_ENV, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SCOPES,
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, SHOPIFY_APP_URL,
SKIP_BILLING, DEFAULT_INCLUDED_TRYONS, BILLING_TEST_MODE, TELEGRAM_CHAT_ID,
CRON_SECRET, DECART_API_KEY, GEMINI_API_KEY, PRINT_SCAN_CUTOFF`. Custom adds
`APP_DISTRIBUTION` + `ML_API_URL`.

**The yaml is not the source of truth for the live service.** The public service
runs 21 env entries, 7 of them Secret Manager refs that appear in no yaml:
`TELEGRAM_BOT_TOKEN`, `WIDGET_BOOTSTRAP_SECRET`, `PRINT_SCAN_GEMINI_API_KEY`
(catalogue scanning, deliberately a DIFFERENT Google project from the render key
so a big scan cannot eat the render quota), plus `ALERTS_TELEGRAM_BOT_TOKEN` /
`ALERTS_TELEGRAM_CHAT_ID` (the @Elloalertbot pager). Always read the live service
with `gcloud run services describe` before reasoning about env.

Local `.env` (7): `SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SCOPES, SUPABASE_URL,
SUPABASE_SERVICE_ROLE_KEY, DECART_API_KEY, LIVE_SHOPPER_DAILY_SESSIONS`.

## Other folders on Desktop (context, not deploy sources)

- `~/Desktop/ELLO VTOW/` — ML service source (above)
- `~/Desktop/N8N VTOW/` — n8n workflows, not part of the app
- `~/Desktop/Vault/` — Andrew's Obsidian second brain. Authoritative project map: `02-Areas/Ello/_context/Project-Map.md`. Use `obsidian search` / `obsidian read` to query it (CLI installed).
- `~/Desktop/Ello-Work/` — pitch deck + screenshots
- `~/Desktop/RepoVault/` — git mirror of the vault
