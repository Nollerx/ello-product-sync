# Ello VTO — Scale-Up Switch List (Enterprise Capacity)

**Date:** 2026-07-22 · **Method:** July-12 audit re-verified against live infra (`gcloud`, repo code, live probes) + all vendor pricing/limits re-fetched from primary sources on 2026-07-22 (deep-research pass, 104 agents, 3-vote adversarial verification per claim). Nothing was deployed, no plans were flipped, no SQL was run — every switch below waits on Andrew's go.

---

## 1. The answer in one table

Fleet-wide monthly infra cost at each tier (excludes render COGS ~$0.067–0.075/try-on, which scales with usage and is priced into the deals):

| Switch | Trial (today) | 7th Earth production flip | LA-class ($80M/yr) |
|---|---|---|---|
| Supabase plan | Free — $0 ⚠️ **no backups** | **Pro — $25** (Micro compute via $10 credit) | Pro $25 + Small compute **+$5 net** |
| Supabase PITR (optional) | — | not needed | **+$100** only if <24h RPO is contractually required |
| Cloudflare Workers | Free — $0 ⚠️ 100K req/day account cap | **Paid — $5** | Paid — **~$8–11** (21–30M req/mo) |
| Cloud Run warm instances | none — $0 | seventhearth min 1 (2Gi) **+$19.71** | + public front door 1Gi ($13.14) + LA service 2Gi ($19.71) + 1 warm render engine ($13.14) + B1 /tryon split ($13.14) ≈ **$79 total warm** |
| Gemini | Tier 2, $0 fixed | $0 (monitor AI Studio) | Tier 3 auto-qualifies by spend; $0 fixed |
| FASHN | on-demand $0.075/credit, $0 fixed | $0 fixed | $0 fixed (Tier II $249/mo optional, −20%/credit) |
| **Fleet total** | **$0** (recommended: flip $30 now — see §2) | **~$50/mo** | **~$120/mo** (+$100 PITR optional) |

At LA steady-state fees of ~$24K/mo, the full LA-class infra bill is ~0.5% of revenue share. There is no infra-cost reason to hesitate on any of these switches.

**Verified fleet state 2026-07-22:** every Cloud Run service is min-instances 0 and on default request-based billing (cheap idle rates apply). Render engines are already 1Gi / concurrency 32 / max 40 (A8 applied). `ello-vto-seventhearth` is live at 2Gi awaiting the install click. Supabase is on Free. Workers is on Free. B7 offload job does **not** exist (zero Cloud Run jobs in the project).

---

## 2. Flip these two TODAY ($30/mo) — they protect the trial, not just production

The audit called these "Day-0 signing switches" (A6). Re-verification says they are actually **today** switches:

1. **Supabase Pro ($25/mo).** The project is on Free, which includes **zero backups of any kind** — verified on the live pricing page ("Not included") and backups doc. Everything — Atlas's attribution history (the 18.3% number quoted in every pitch), all 18 stores, the Proof Engine tables, the money tables that defend invoices — currently has no recovery path from a bad migration, a fat-fingered SQL paste, or Supabase-side corruption. Pro adds automatic daily backups with 7-day retention (RPO ≤24h) the moment it's flipped. This is the single highest-leverage data-loss switch in the entire stack, and it's live-exposed right now, before any client flips.
2. **Cloudflare Workers Paid ($5/mo).** Workers Free caps at **100,000 requests/day account-wide** (all workers combined, reset midnight UTC). Breach = Cloudflare **Error 1027 page** served to shoppers. Because `widget.ellotryon.com` is a *custom-domain worker* — the worker IS the origin — there is **no fail-open option for this topology**: cap breach means the widget (including `/tryon`) is hard-down for every store riding the CDN (Atlas and AYBL today, 7th Earth's clone tomorrow) until the UTC reset. One viral TikTok or email blast at ~35 requests/session gets there in ~3K sessions. Paid removes the daily cap entirely (10M req/mo included, $0.30/M after, no RPS ceiling).

No Cloudflare **zone** upgrade is needed at any tier — the zone stays Free. Caching lives inside the worker (`cacheTtl`), custom domains work on the Free zone plan, and the Enterprise-only Host-header-override problem was already solved by the worker architecture itself. One $5 Paid plan covers **all** workers on the account, including every per-client clone (§5C of the audit).

---

## 3. Supabase sizing (project `rwmvgwnebnsqcyhhurti`) — verified against live pricing 2026-07-22

| Fact | Free (today) | Pro ($25/mo) | Notes |
|---|---|---|---|
| DB size | 500 MB cap | 8 GB disk included, then $0.125/GB | Retention pack (applied) holds steady-state at 3–6.3 GB even at full LA traffic → **fits inside Pro's included 8 GB indefinitely** |
| Egress | 5 GB/mo | 250 GB/mo, then $0.09/GB | Measured server-side RPC egress 12–18 GB/mo at LA scale → trivial inside Pro; B2 edge-cache cuts ~98% of it anyway |
| Backups | **none** | Daily, 7-day retention, free | The core data-loss fix |
| PITR | not available | Add-on: $100/mo (7d) / $200 (14d) / $400 (28d); requires ≥Small compute | RPO 24h → ~2 min. Decision point at LA signing only |
| Compute | Nano (shared) | Micro via $10 credit; Small +$15 ($5 net), Medium +$60, Large +$110 | Throughput/RAM knob. Micro is fine through 7th Earth; add Small at LA-class (or earlier if dashboards feel slow) |
| Disk IOPS | — | gp3: 3,000 IOPS included, $0.024/IOPS beyond | Workload is a few hundred K queries/day — IOPS is nowhere near binding |
| Team plan | — | $599/mo | **Not needed.** Buys 14-day backups, SOC2 report access, SSO. Only revisit if an enterprise client's security questionnaire demands it |

**The connection-limit fear is a non-issue.** Verified in the repo: the app talks to Supabase exclusively through `supabase-js` (PostgREST over HTTPS) — there are zero direct Postgres connections from Cloud Run. Autoscaling to 40 instances multiplies HTTPS calls, not DB connections, so Supavisor pool math (60 direct / 200 pooled on Micro) never enters the picture. What actually scales Supabase throughput is compute size, and the B2 edge cache (below) removes most of the demand before it arrives.

---

## 4. The "graph API calls" bottleneck — investigated, and it isn't one

Full call-site map of the repo (every Shopify API call, verified 2026-07-22):

- **There is no Admin-API catalog sync.** `sync.server.ts` is a Storefront-token sync (zero Shopify calls). Install (`afterAuth`) makes **4–5 Admin calls flat** — token mint, shop query, pixel read/create — regardless of catalog size. A 10,000-product install costs the same 4–5 calls as an 83-product install. **Big-catalog installs cannot hit Admin throttles.**
- **The catalog crawl uses the Storefront API** (`api.catalog-handles.tsx`, 250 products/page, sequential cursors), and Shopify's own limits table lists Storefront API rate limits as **"None" on every plan**. It cannot be throttled in the classic sense. It's also lazy (widget-load triggered, single-flighted, 5-min cached) — not an install-time burst.
- **Product webhooks make zero Shopify calls** — they only bump `config_version` in Supabase. A bulk import firing thousands of webhooks costs thousands of Supabase writes and no API quota.
- **Admin API headroom is huge anyway:** cost-based throttling per app+store at 100 points/sec (standard), 200 (Advanced), **1,000 (Shopify Plus — LA would be here)**, 2,000 (Commerce Components). Ello's heaviest recurring Admin call is 2 queries per dashboard load plus one 10-point `appUsageRecordCreate` per overage try-on — you'd need >10 overage events *per second* on one store to throttle. Not a real scenario.

**Two real (small) defects found, neither urgent:**

1. **Silent 5,000-product cap** on the catalog crawl (`MAX_PAGES = 20`): products beyond 5,000 are silently dropped from the widget. Measured live: LA Apparel's storefront publishes **~1,653 products** (7 pages) — safely inside. 7th Earth: ~83 (1 page). Fix (raise the cap or page via Admin bulk query) only matters before signing a >5K-SKU brand. Group C.
2. **No THROTTLED/backoff handling anywhere** — no `THROTTLED` detection, no `extensions.cost` reads, no retry. Harmless at current call volumes, but a 20-line retry-on-throttle wrapper around `admin.graphql` is cheap insurance. Group C.

**What the bottleneck actually was:** Supabase RPC volume (~150–250K server-side calls/day at LA scale from widget-config reads), not Shopify. The fix is **B2** — edge-cache the 3 GET config endpoints in the CF worker. Verified today: the origin now sends `s-maxage=30` on `widget-config-resolved`, but the worker still passes `/api/*` through uncached (`widget-proxy-worker.js` caches only the static allowlist) — **B2 remains open at the layer that matters.** S-effort, ship during the 7th Earth pilot.

---

## 5. Cloud Run — warm instances are cheap; Andrew's fear is off by ~5×

Verified against live Cloud Run pricing (us-central1, request-based billing, which every Ello service is confirmed to be on):

- Idle min-instance rate: $0.0000025 per vCPU-sec **and** per GiB-sec →
  - **1 vCPU + 1 GiB warm 24/7 = $13.14/mo**
  - **1 vCPU + 2 GiB warm 24/7 = $19.71/mo** (before free-tier offsets, which shave a few dollars)
- The audit's "$10–20/mo per warm instance" was right. "Every live instance costs a lot" is not — a fully warm 5-service LA-class fleet is ~$79/mo.
- ⚠️ **Do not switch any service to instance-based billing.** Same warm instance there costs $52.56/mo (full rate for the entire lifecycle, no idle discount) — 4× more for nothing Ello needs.

Rollout order:

| When | Action | Cost |
|---|---|---|
| 7E production flip | `min-instances 1` on `ello-vto-seventhearth` | $19.71/mo |
| 7E flip (optional) | warm 1 instance of the shared render engine `ello-vto-custom` | $13.14/mo — softens first-render cold start; renders take 10–30s anyway, so optional |
| LA signing | `min-instances 1` on public front door (1Gi) + LA's dedicated 2Gi service | $32.85/mo |
| Before full LA traffic | **B1**: split `/tryon` onto its own service (conc 8, 1Gi, max 40) via a worker path rule, min 1 | $13.14/mo — this is the "render spikes can never starve config traffic" guarantee; needed before LA drop-day traffic, not before |

---

## 6. Render quota ceilings (Gemini / FASHN)

- **Gemini tier criteria verified** (ai.google.dev, 2026-07-22): Tier 2 = $100 paid + 3 days; **Tier 3 = $1,000 cumulative + 30 days** (spend cap rises to $20K–100K+). Google **no longer publishes per-model tier limits in the docs** — they're only visible in AI Studio, so the audit's A3 reading (Nano Banana 2: **500 RPM / 1M TPM / 10,000 RPD** at Tier 2, project-wide) stands as the operative numbers and must be re-checked in AI Studio, not the docs.
- **Where 10K RPD binds:** it is shared across **all** clients (one Google project). 7th Earth peaks at a few hundred renders/day — never binds. An LA drop day models at up to ~10K renders/day — exactly at the ceiling. Escape hatches in order: (1) Tier 3 — at ~$0.067/render, LA's first ~15K renders push cumulative spend past $1,000, so Tier 3 qualification lands during the pilot ramp on its own; (2) the paid-tier increase form (linked from the rate-limits doc — file it at LA signing, no guarantees); (3) Vertex AI switch (engine is ADC-ready) with per-project-region quotas.
- **FASHN (fallback):** pricing verified — on-demand $0.075/credit; commitment Tier II $249/mo (4,150 credits @ $0.06); Tier III $1,249/mo (25,594 @ $0.0488). **The 3/6/11-concurrent tier table is no longer in FASHN's public docs** (docs restructured) — the audit's ~33 renders/min fallback ceiling can no longer be cited from a public source. That upgrades **A4 (capacity letter in writing) from "should get" to "the only way to know the fallback's capacity."** Pre-LA requirement. Stay on-demand until fallback usage is real; Tier II is a cost optimization, not a capacity one.

---

## 7. Data-loss protection, end to end

| Layer | State (verified 2026-07-22) | Gap | Close it |
|---|---|---|---|
| Supabase backups | **NONE — Free plan** | total-loss exposure, today | Pro $25 → daily backups, 7-day retention (§2) |
| Retention windows | Applied + live: 180d raw events / 30d web vitals / 400d money tables / rollups kept forever, nightly crons | raw events older than 180d are deleted with no archive | B7 |
| **B7 GCS offload** | **Not built** (0 Cloud Run jobs in project) | raw-event forensics >180d; billing-dispute raw data >400d | Nightly export job → gzip NDJSON → GCS Nearline, ~$0.40/mo. **Build during the 7E pilot, before LA go-live.** Not a blocker for the 7E flip itself — the 180d clock means nothing ages out until ~Jan 2027 |
| PITR | Not available on Free; $100/mo add-on on Pro | RPO 24h → ~2 min | Optional at LA signing. Context: a worst-case 24h restore loses a day of try-on events, but purchases are reconstructible from Shopify order IDs, and invoices are defended by the 400d money tables + rollups. $100/mo buys comfort, not correctness — decide with the LA contract in hand |

---

## 8. Stale-audit flags (what changed since 2026-07-12)

1. **FASHN 3/6/11 concurrent-by-tier: stale as a citable fact** — removed from public docs. A4 letter is now mandatory pre-LA.
2. **Gemini docs no longer publish tier tables** — A3 monitoring must happen in AI Studio, not the docs page. Tier-3-at-$1,000+30d criteria confirmed still current.
3. **CLOUDFLARE_CDN_DECISION.md's "set the route to fail closed"** — moot: a custom-domain worker is inherently fail-closed (Error 1027 on cap breach). There's no knob; the only protection is Workers Paid. Sharper urgency than the audit conveyed.
4. **A6/A8 prices confirmed accurate:** Supabase Pro $25, Workers Paid $5 + 10M included, warm instance $13.14/$19.71 (audit said "$10–20"). A refuted red herring for the record: Cloudflare's marketing plans page now shows only per-unit rates, but the developer docs confirm the $5 minimum + 10M included framing is unchanged.
5. **New since audit:** origin `s-maxage=30` cache headers shipped on the config endpoint; the worker-side edge cache (B2) is still the open half. Complete-the-Look now reads the Storefront API — unthrottled (see §4), no capacity impact.

## 9. Priority order (all awaiting Andrew's go)

1. **Now, $30/mo:** Supabase Pro + Workers Paid (billing dashboards, 15 min). Closes the no-backup exposure and the widget-down-at-100K-req cliff — both are live risks *today*.
2. **7E production flip, +$20/mo:** min-instances 1 on seventhearth + CDN worker clone `widget-seventhearth.ellotryon.com` (needs #1) + per-client plan row + Proof holdout, per the audit §5 runbook.
3. **During the 7E pilot, ~$0:** B2 worker edge-cache (kills the real "API calls" bottleneck), B7 offload job, B4 timeout alignment.
4. **At LA signing, +$50–70/mo:** warm the front door + LA service + engine, B1 split before full traffic, file the Gemini increase form, get the FASHN letter (A4), decide PITR ($100/mo optional), add Small compute ($5 net).
5. **Group C, unhurried:** THROTTLED-retry wrapper, 5K-product crawl cap (only before a >5K-SKU client).
