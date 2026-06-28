-- Real-user Core Web Vitals samples from the embedded admin (App Bridge
-- shopify.webVitals.onReport → /api/web-vitals). Lets us compute our own p75
-- for LCP/CLS/INP before Shopify's 100-call / 28-day threshold is reached, and
-- segment by route + shop so dev-store noise can be filtered out.

create table if not exists public.vto_web_vitals (
  id           bigint generated always as identity primary key,
  metric       text        not null check (metric in ('LCP','CLS','INP','FCP','TTFB')),
  value        double precision not null,
  path         text,
  shop_domain  text,
  metric_id    text,
  created_at   timestamptz not null default now()
);

-- p75-over-28-days queries filter by metric + recency.
create index if not exists vto_web_vitals_metric_created_idx
  on public.vto_web_vitals (metric, created_at desc);

-- Writes only ever come through the service-role client in /api/web-vitals,
-- which bypasses RLS. Enable RLS with no policies so the anon/auth keys can
-- neither read nor write this table (matches vto_leads' closed posture).
alter table public.vto_web_vitals enable row level security;

-- ── How to read your scores (run in the Supabase SQL editor) ──
-- Shopify scores the 75th percentile over the trailing 28 days. Targets:
--   LCP ≤ 2500ms · INP ≤ 200ms · CLS ≤ 0.1
--
-- select
--   metric,
--   count(*)                                                   as samples,
--   round(percentile_cont(0.75) within group (order by value)::numeric, 3) as p75,
--   case metric when 'LCP' then 2500 when 'INP' then 200
--               when 'CLS' then 0.1  when 'FCP' then 1800
--               when 'TTFB' then 800 end                       as target
-- from public.vto_web_vitals
-- where created_at > now() - interval '28 days'
--   -- and shop_domain <> 'your-dev-store.myshopify.com'  -- exclude dev noise
-- group by metric
-- order by metric;
