-- Align Supabase plan metadata with the public Shopify pricing ladder.
-- Main paid plans: Starter, Launch, Growth, Scale. Enterprise is handled manually.

UPDATE public.vto_plans
SET
  name = 'Ello Starter',
  monthly_price = 49,
  annual_price = 529.20,
  included_tryons_per_month = 75,
  overage_usd_per_tryon = 0.15
WHERE id = 'acf413dc-bcb0-484a-b914-2d6f6491eb39';

UPDATE public.vto_plans
SET
  name = 'Ello Launch',
  monthly_price = 97,
  annual_price = 1047.60,
  included_tryons_per_month = 300,
  overage_usd_per_tryon = 0.15
WHERE id = '75fa2215-7008-4242-aef5-40aa2b278968';

UPDATE public.vto_plans
SET
  name = 'Ello Growth',
  monthly_price = 249,
  annual_price = 2689.20,
  included_tryons_per_month = 1500,
  overage_usd_per_tryon = 0.15
WHERE id = '48ce4579-3523-45e1-9cc5-7f2bb0134073';

UPDATE public.vto_plans
SET
  code = 'scale',
  name = 'Ello Scale',
  monthly_price = 649,
  annual_price = 7009.20,
  included_tryons_per_month = 5000,
  overage_usd_per_tryon = 0.15
WHERE id = '6c203206-7f01-4ca2-b1f2-fabda7a6306f';
