-- Migration: vto_billing_deals + deal-aware statement/invoice RPCs.
--
-- WHY: rev-share clients are billed through Stripe on negotiated terms, not a
-- single company-wide rate. 4Winners closed at 10% with 7 free days; the v5
-- term sheet default is 15%; Option B clients pay a flat monthly fee instead.
-- Until now nothing in the system knew any of that, so a fee could only be
-- computed by hand — which is exactly how a client gets billed the wrong number.
-- This table is the single place a deal is written down, and the invoice RPC
-- reads it so the bill and the client-facing statement can never disagree.
--
-- TRIAL: a free window is part of the deal, not an afterthought — the signed
-- doc says "sales during the free days are never billed", so those sales must
-- appear on the statement (the client wants to see the widget working) while
-- contributing ZERO to the fee. Hence `in_trial` and `billable_net` as separate
-- columns from `net_attributed`.
--
-- trial_starts_at defaults to the store's install date when left NULL, so the
-- normal case needs no date wrangling: write the percent and the number of free
-- days, and the clock starts the moment they install.
--
-- SECURITY: commercial terms are the most sensitive rows in the database — one
-- client learning another's rate is a real business problem. RLS is enabled with
-- NO policies, so PostgREST returns nothing for anon/authenticated no matter
-- what; only service_role (which bypasses RLS) and the SECURITY DEFINER RPCs
-- below can read it. The RPCs are scoped to a single store_slug, and the app
-- only ever passes the authenticated shop's own slug.

CREATE TABLE IF NOT EXISTS public.vto_billing_deals (
  store_slug         TEXT PRIMARY KEY,
  deal_type          TEXT        NOT NULL DEFAULT 'rev_share'
                       CHECK (deal_type IN ('rev_share', 'flat')),
  -- Percent of net attributed revenue, e.g. 10.00. Required for rev_share.
  rev_share_percent  NUMERIC(5,2)
                       CHECK (rev_share_percent IS NULL
                              OR (rev_share_percent > 0 AND rev_share_percent <= 100)),
  -- Flat-deal terms (Option B): a fixed monthly fee and an included try-on quota.
  flat_amount        NUMERIC(10,2) CHECK (flat_amount IS NULL OR flat_amount >= 0),
  included_tryons    INTEGER       CHECK (included_tryons IS NULL OR included_tryons >= 0),
  -- Free window. NULL start = begins at install (see effective start below).
  trial_starts_at    TIMESTAMPTZ,
  trial_days         INTEGER     NOT NULL DEFAULT 0 CHECK (trial_days >= 0),
  currency           TEXT        NOT NULL DEFAULT 'USD',
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A rev_share deal without a percent would silently bill $0; a flat deal
  -- without an amount would do the same. Refuse both at write time.
  CONSTRAINT deal_terms_present CHECK (
    (deal_type = 'rev_share' AND rev_share_percent IS NOT NULL)
    OR (deal_type = 'flat' AND flat_amount IS NOT NULL)
  )
);

COMMENT ON TABLE public.vto_billing_deals IS
  'Negotiated billing terms per store. Read by get_vto_invoice / get_vto_billing_statement. RLS on with no policies: service_role and SECURITY DEFINER RPCs only.';

ALTER TABLE public.vto_billing_deals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.vto_billing_deals FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.vto_billing_deals TO service_role;

CREATE OR REPLACE FUNCTION public.vto_billing_deals_touch()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vto_billing_deals_touch ON public.vto_billing_deals;
CREATE TRIGGER vto_billing_deals_touch
  BEFORE UPDATE ON public.vto_billing_deals
  FOR EACH ROW EXECUTE FUNCTION public.vto_billing_deals_touch();


-- ── Statement, now deal-aware ───────────────────────────────────────────────
-- Same per-line ledger as 20260804_billing_statement.sql, plus the two columns
-- a fee actually depends on. Rebuilt rather than altered because RETURNS TABLE
-- is part of the signature.

DROP FUNCTION IF EXISTS public.get_vto_billing_statement(TEXT, TIMESTAMPTZ, TIMESTAMPTZ);

CREATE FUNCTION public.get_vto_billing_statement(
  p_store_slug TEXT,
  p_from       TIMESTAMPTZ,
  p_to         TIMESTAMPTZ
) RETURNS TABLE (
  order_id           TEXT,
  product_id         TEXT,
  product_name       TEXT,
  tried_on_at        TIMESTAMPTZ,
  purchased_at       TIMESTAMPTZ,
  hours_to_purchase  NUMERIC,
  attributed_revenue NUMERIC,
  refunded_amount    NUMERIC,
  net_attributed     NUMERIC,
  in_trial           BOOLEAN,  -- inside the free window: shown, never billed
  billable_net       NUMERIC,  -- net_attributed, or 0 during the trial
  revenue_basis      TEXT,
  currency           TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH deal AS (
    SELECT d.trial_days,
           COALESCE(
             d.trial_starts_at,
             (SELECT MIN(s.created_at) FROM public.vto_stores s
               WHERE s.store_slug = p_store_slug)
           ) AS trial_from
    FROM public.vto_billing_deals d
    WHERE d.store_slug = p_store_slug
  ),
  ledger AS (
    SELECT a.order_id, a.tried_on_product, a.tried_on_at, a.purchased_at,
           a.seconds_to_purchase, a.attributed_line_revenue, a.revenue_basis, a.currency
    FROM public.vto_attributed_purchases a
    WHERE a.store_slug = p_store_slug
      AND a.purchased_at >= p_from
      AND a.purchased_at <  p_to
  ),
  priced AS (
    SELECT l.*,
           (SELECT SUM((rli.value ->> 'subtotal')::NUMERIC)
              FROM public.refund_events re
              CROSS JOIN LATERAL jsonb_array_elements(re.line_items) rli
             WHERE re.store_slug = p_store_slug
               AND re.order_id = l.order_id
               AND COALESCE(re.refunded_at, re.created_at)
                     < l.purchased_at + INTERVAL '45 days'
               AND regexp_replace(rli.value ->> 'product_id', '^.*/', '')
                     = l.tried_on_product
           ) AS refunded_raw,
           COALESCE(
             (SELECT ci.name FROM public.clothing_items ci
               WHERE ci.store_id = p_store_slug
                 AND regexp_replace(ci.item_id, '^.*/', '') = l.tried_on_product
                 AND ci.name IS NOT NULL
               LIMIT 1),
             (SELECT li.value ->> 'title'
                FROM public.purchase_events pe
                CROSS JOIN LATERAL jsonb_array_elements(pe.line_items) li
               WHERE pe.store_slug = p_store_slug
                 AND pe.order_id = l.order_id
                 AND regexp_replace(li.value ->> 'product_id', '^.*/', '')
                       = l.tried_on_product
                 AND NULLIF(li.value ->> 'title', '') IS NOT NULL
               LIMIT 1),
             (SELECT initcap(replace(te.page_handle, '-', ' '))
                FROM public.tryon_events te
               WHERE te.store_slug = p_store_slug
                 AND te.success IS TRUE
                 AND regexp_replace(te.product_id, '^.*/', '') = l.tried_on_product
                 AND NULLIF(te.page_handle, '') IS NOT NULL
               LIMIT 1)
           ) AS product_name,
           -- No deal row, or zero free days, means nothing is in trial.
           COALESCE(
             (SELECT d.trial_days > 0
                     AND d.trial_from IS NOT NULL
                     AND l.purchased_at >= d.trial_from
                     AND l.purchased_at <  d.trial_from + make_interval(days => d.trial_days)
              FROM deal d),
             FALSE
           ) AS in_trial
    FROM ledger l
  ),
  netted AS (
    SELECT p.*,
           ROUND(GREATEST(COALESCE(p.attributed_line_revenue, 0)
                          - LEAST(COALESCE(p.refunded_raw, 0),
                                  COALESCE(p.attributed_line_revenue, 0)), 0), 2) AS net_val
    FROM priced p
  )
  SELECT n.order_id,
         n.tried_on_product,
         n.product_name,
         n.tried_on_at,
         n.purchased_at,
         ROUND((n.seconds_to_purchase / 3600.0)::NUMERIC, 2),
         ROUND(COALESCE(n.attributed_line_revenue, 0), 2),
         ROUND(LEAST(COALESCE(n.refunded_raw, 0),
                     COALESCE(n.attributed_line_revenue, 0)), 2),
         n.net_val,
         n.in_trial,
         CASE WHEN n.in_trial THEN 0::NUMERIC ELSE n.net_val END,
         n.revenue_basis,
         n.currency
  FROM netted n
  ORDER BY n.purchased_at, n.order_id, n.tried_on_product;
$$;

REVOKE ALL ON FUNCTION public.get_vto_billing_statement(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_vto_billing_statement(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_vto_billing_statement(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;


-- ── The invoice header ──────────────────────────────────────────────────────
-- One row: the deal terms, the period totals, and the amount to charge. Totals
-- are summed from the SAME per-line function the statement renders, so the
-- header can never disagree with the rows printed beneath it.

DROP FUNCTION IF EXISTS public.get_vto_invoice(TEXT, TIMESTAMPTZ, TIMESTAMPTZ);

CREATE FUNCTION public.get_vto_invoice(
  p_store_slug TEXT,
  p_from       TIMESTAMPTZ,
  p_to         TIMESTAMPTZ
) RETURNS TABLE (
  store_slug         TEXT,
  deal_type          TEXT,
  rev_share_percent  NUMERIC,
  flat_amount        NUMERIC,
  included_tryons    INTEGER,
  trial_days         INTEGER,
  trial_from         TIMESTAMPTZ,
  trial_until        TIMESTAMPTZ,
  sales_count        BIGINT,
  orders_count       BIGINT,
  tryons_used        BIGINT,
  gross_attributed   NUMERIC,
  refunded           NUMERIC,
  net_attributed     NUMERIC,
  trial_excluded     NUMERIC,  -- net that fell inside the free window
  billable_net       NUMERIC,  -- what the percentage is applied to
  amount_due         NUMERIC,
  currency           TEXT,
  has_deal           BOOLEAN   -- FALSE = no terms on file, amount_due is NULL
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH deal AS (
    SELECT d.*,
           COALESCE(
             d.trial_starts_at,
             (SELECT MIN(s.created_at) FROM public.vto_stores s
               WHERE s.store_slug = p_store_slug)
           ) AS eff_trial_from
    FROM public.vto_billing_deals d
    WHERE d.store_slug = p_store_slug
  ),
  lines AS (
    SELECT * FROM public.get_vto_billing_statement(p_store_slug, p_from, p_to)
  ),
  agg AS (
    SELECT COUNT(*)::BIGINT                                   AS sales_count,
           COUNT(DISTINCT order_id)::BIGINT                   AS orders_count,
           ROUND(COALESCE(SUM(attributed_revenue), 0), 2)     AS gross_attributed,
           ROUND(COALESCE(SUM(refunded_amount), 0), 2)        AS refunded,
           ROUND(COALESCE(SUM(net_attributed), 0), 2)         AS net_attributed,
           ROUND(COALESCE(SUM(net_attributed) FILTER (WHERE in_trial), 0), 2) AS trial_excluded,
           ROUND(COALESCE(SUM(billable_net), 0), 2)           AS billable_net,
           MAX(currency)                                      AS currency
    FROM lines
  ),
  tryons AS (
    SELECT COUNT(*)::BIGINT AS used
    FROM public.tryon_events
    WHERE store_slug = p_store_slug AND success IS TRUE
      AND created_at >= p_from AND created_at < p_to
  )
  SELECT p_store_slug,
         d.deal_type,
         d.rev_share_percent,
         d.flat_amount,
         d.included_tryons,
         d.trial_days,
         d.eff_trial_from,
         CASE WHEN d.trial_days > 0 AND d.eff_trial_from IS NOT NULL
              THEN d.eff_trial_from + make_interval(days => d.trial_days) END,
         a.sales_count,
         a.orders_count,
         t.used,
         a.gross_attributed,
         a.refunded,
         a.net_attributed,
         a.trial_excluded,
         a.billable_net,
         CASE
           WHEN d.store_slug IS NULL THEN NULL
           WHEN d.deal_type = 'rev_share'
             THEN ROUND(a.billable_net * d.rev_share_percent / 100.0, 2)
           -- Flat deals bill the fixed amount, but never for a period that sits
           -- entirely inside the free window.
           WHEN d.deal_type = 'flat'
             THEN CASE
                    WHEN d.trial_days > 0 AND d.eff_trial_from IS NOT NULL
                         AND p_to <= d.eff_trial_from + make_interval(days => d.trial_days)
                    THEN 0::NUMERIC
                    ELSE d.flat_amount
                  END
         END,
         COALESCE(d.currency, a.currency, 'USD'),
         (d.store_slug IS NOT NULL)
  FROM agg a
  CROSS JOIN tryons t
  LEFT JOIN deal d ON TRUE;
$$;

REVOKE ALL ON FUNCTION public.get_vto_invoice(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_vto_invoice(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_vto_invoice(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;
