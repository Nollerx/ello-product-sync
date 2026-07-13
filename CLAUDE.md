# Ello VTO — Operating Brief

You are working in `~/ello-storefront-app/`. Read this end-to-end before doing anything. **Verified 2026-04-25.**

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
| Live merchants | App Store installs (no paying merchants yet) | Formerly **Marcos Rivera / Kaizen Marketing** — no longer a customer; no active paying merchant on the custom app |

A parallel Cloud Run service `custom-ello-app-13593516897-13593516897` (doubled suffix) also exists and has received deploys recently. It responds at `https://custom-ello-app-13593516897-13593516897-13593516897.us-central1.run.app` (triple-suffix URL). Shopify routes the Custom Ello App to the **single-suffix** service via `shopify.app.custom.toml`'s `application_url`, so the doubled one is **not** what the Custom Ello App serves. Don't deploy to it without investigating where its existing deploys came from.

## ML / try-on inference service (separate)

- **Source:** `~/Desktop/ELLO VTOW/` (FastAPI Python, entrypoint `main.py`) — **not git-tracked**, edit with care
- **Cloud Run service:** `ello-vto-13593516897`
- **URL used in code:** `https://ello-vto-13593516897-13593516897.us-central1.run.app` (referenced in `app/routes/tryon.tsx:72`)
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
- **Tables:** `vto_accounts`, `vto_stores`, `vto_subscriptions`, `vto_usage_periods`, `vto_plans`
- **Edge functions:** in `supabase/functions/`. Deploy: `supabase functions deploy <name> --project-ref rwmvgwnebnsqcyhhurti --no-verify-jwt`
- **Migrations:** in `supabase/migrations/`. Andrew runs them manually in the Supabase SQL editor. Lovable Cloud manages permissions, so do not assume Supabase MCP can execute against this project without explicit per-statement authorization.

## Deploy commands (use exactly these)

### Public app
```bash
cd ~/ello-storefront-app
gcloud run deploy ello-vto-public-13593516897 \
  --source . \
  --region us-central1 \
  --env-vars-file cloud_run_env.yaml \
  --project ello-vto \
  --allow-unauthenticated
```

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
yamls. A Cloud Scheduler job `ello-install-followup` (us-central1, every 15
min) POSTs to `/api/install-followup` on the public service with header
`x-cron-key=$CRON_SECRET` to drive the 2h post-install Telegram check-ins.

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

Run all three; deploy only if all pass:
```bash
npm run lint
npm run typecheck
npm run build
```
There is no `test` script in this repo.

## Workflow rules (non-negotiable)

1. **Always** run the pre-deploy gate (lint + typecheck + build) before any `gcloud run deploy`. If any fails, stop and fix.
2. **Always** show the diff first and ask: "Deploy to public, custom, or both?" Never assume both.
3. Each deploy target requires an explicit **"go"** from Andrew before you run the command:
   - **Custom app** — single-merchant production service (Marcos / Kaizen churned; no active paying merchant). Still get an explicit "go" before deploying.
   - **Public app** — live on the App Store.
   - **ML service** — hits every merchant.
4. **Public-app billing flag:** `cloud_run_env.yaml` has `BILLING_TEST_MODE: "false"` — real Shopify charges are live (as of 2026-05-16). Do not flip this without an explicit instruction. Surface its current value before each public deploy and ask whether to keep or flip.
5. **SQL:** Draft the statement, hand it to Andrew to paste into the Supabase SQL editor. Do not run via MCP unless Andrew explicitly authorizes per-statement.
6. **Dashboard:** Produce a Lovable prompt; do not edit the dashboard repo directly.
7. **Git:** Direct commits to `main` and push (solo workflow). No PR/branch flow unless Andrew asks.
8. **Accuracy bar:** If you're not 100% sure of a fact, say so and verify (read the file, run the gcloud command, curl the URL). Never guess about deploy targets, service names, or URLs.

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

## Env-var names (yaml files in repo root, plaintext secrets)

`NODE_ENV, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SCOPES, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, SHOPIFY_APP_URL, SKIP_BILLING, DEFAULT_INCLUDED_TRYONS, BILLING_TEST_MODE`. Custom adds `APP_DISTRIBUTION`. Local `.env` has only the first five.

## Other folders on Desktop (context, not deploy sources)

- `~/Desktop/ELLO VTOW/` — ML service source (above)
- `~/Desktop/N8N VTOW/` — n8n workflows, not part of the app
- `~/Desktop/Vault/` — Andrew's Obsidian second brain. Authoritative project map: `02-Areas/Ello/_context/Project-Map.md`. Use `obsidian search` / `obsidian read` to query it (CLI installed).
- `~/Desktop/Ello-Work/` — pitch deck + screenshots
- `~/Desktop/RepoVault/` — git mirror of the vault
