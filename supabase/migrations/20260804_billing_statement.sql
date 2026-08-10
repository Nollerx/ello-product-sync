-- Migration: get_vto_billing_statement — the line-by-line proof behind an invoice.
--
-- WHY: rev-share clients are billed a percentage of Attributed Revenue through
-- Stripe, and the promise made on sales calls is that the invoice can be audited
-- back to real Shopify orders. Until now the only per-order surface was the Proof
-- page's receipts CSV, which exports the ORDER TOTAL (`total_price`) rather than
-- the attributed line amount the fee is actually computed from — so a client
-- reconciling that CSV against their bill would find two different numbers and
-- reasonably conclude they were being overcharged. This RPC is the billing-grade
-- version: one row per (order, tried-on product) with the exact dollars the
-- percentage is applied to, so the statement lines SUM to the invoice total.
--
-- SOURCE OF TRUTH: built on the `vto_attributed_purchases` view rather than
-- re-deriving attribution, so the statement can never drift from the ledger. The
-- view already carries the 4-branch revenue basis cascade from
-- 20260731_qualified_revenue_discount_netting.sql (line_alloc → line_scaled →
-- line_unscaled → prorated_*) and the hard 7-day try-on→purchase pair cap.
--
-- ROUNDING, and why the invoice is the authority: the view ROUNDs each line to
-- cents; get_vto_daily_attributed_revenue sums first and rounds the order. On a
-- window with many part-line orders those differ by a cent or two (measured:
-- ecmxv0-vh July 2026 = $1,481.53 here vs $1,481.52 on the daily RPC, same 28
-- orders). Per-line rounding is the correct choice for a document a client adds
-- up by hand: every printed line is a real 2dp amount and the printed lines sum
-- to the printed total. Bill from THIS function, not from the daily RPC.
--
-- WINDOWING is by PURCHASE time — the money landed in the billing period — with
-- the earning try-on allowed to sit up to 7 days before p_from, matching the
-- daily RPC so a purchase straddling the period boundary is not orphaned.
--
-- REFUNDS net per (order, product) inside the 45-day billing window locked in
-- 20260713, capped at that line's attributed revenue so a line can never go
-- negative. Refunds landing after 45 days still show in return-rate stats
-- elsewhere but never reopen a closed invoice.
--
-- PRODUCT NAME cascade, because "product 15557856100678" is not proof a merchant
-- can check: the store's synced catalog (item_id is a GID on most stores and a
-- bare id on others, so both sides are normalized — an unnormalized join here
-- silently returns zero matches), then the title on the order line the shopper
-- actually bought, then the PDP handle prettified, then NULL for the caller to
-- fall back to the id. Measured on ecmxv0-vh July 2026: 32/32 lines resolve to a
-- readable name with zero bare ids.
--
-- Security posture matches every other dashboard RPC: SECURITY DEFINER with a
-- pinned search_path, EXECUTE revoked from PUBLIC (which `anon` inherits) and
-- granted only to authenticated + service_role. Idempotent: safe to re-run.

DROP FUNCTION IF EXISTS public.get_vto_billing_statement(TEXT, TIMESTAMPTZ, TIMESTAMPTZ);

CREATE FUNCTION public.get_vto_billing_statement(
  p_store_slug TEXT,
  p_from       TIMESTAMPTZ,
  p_to         TIMESTAMPTZ
) RETURNS TABLE (
  order_id           TEXT,
  product_id         TEXT,
  product_name       TEXT,     -- NULL only if every naming source missed
  tried_on_at        TIMESTAMPTZ,
  purchased_at       TIMESTAMPTZ,
  hours_to_purchase  NUMERIC,
  attributed_revenue NUMERIC,  -- gross, this line only
  refunded_amount    NUMERIC,  -- netted within 45 days, capped at the line
  net_attributed     NUMERIC,  -- what the percentage is charged on
  revenue_basis      TEXT,     -- how this line was priced (audit breadcrumb)
  currency           TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH ledger AS (
    SELECT a.order_id,
           a.tried_on_product,
           a.tried_on_at,
           a.purchased_at,
           a.seconds_to_purchase,
           a.attributed_line_revenue,
           a.revenue_basis,
           a.currency
    FROM public.vto_attributed_purchases a
    WHERE a.store_slug = p_store_slug
      AND a.purchased_at >= p_from
      AND a.purchased_at <  p_to
  ),
  priced AS (
    SELECT l.*,
           -- Refunds on THIS product in THIS order, inside the 45-day window.
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
             -- 1. The merchant's own synced catalog. Normalize BOTH sides:
             --    item_id is a GID on most stores, bare numeric on others.
             (SELECT ci.name FROM public.clothing_items ci
               WHERE ci.store_id = p_store_slug
                 AND regexp_replace(ci.item_id, '^.*/', '') = l.tried_on_product
                 AND ci.name IS NOT NULL
               LIMIT 1),
             -- 2. The title on the order line the shopper actually bought.
             (SELECT li.value ->> 'title'
                FROM public.purchase_events pe
                CROSS JOIN LATERAL jsonb_array_elements(pe.line_items) li
               WHERE pe.store_slug = p_store_slug
                 AND pe.order_id = l.order_id
                 AND regexp_replace(li.value ->> 'product_id', '^.*/', '')
                       = l.tried_on_product
                 AND NULLIF(li.value ->> 'title', '') IS NOT NULL
               LIMIT 1),
             -- 3. The PDP handle the try-on happened on: "atlas-summer-tank"
             --    reads as "Atlas Summer Tank", which is enough for a merchant
             --    to recognize the item on an invoice.
             (SELECT initcap(replace(te.page_handle, '-', ' '))
                FROM public.tryon_events te
               WHERE te.store_slug = p_store_slug
                 AND te.success IS TRUE
                 AND regexp_replace(te.product_id, '^.*/', '') = l.tried_on_product
                 AND NULLIF(te.page_handle, '') IS NOT NULL
               LIMIT 1)
           ) AS product_name
    FROM ledger l
  )
  SELECT p.order_id,
         p.tried_on_product,
         p.product_name,
         p.tried_on_at,
         p.purchased_at,
         ROUND((p.seconds_to_purchase / 3600.0)::NUMERIC, 2),
         ROUND(COALESCE(p.attributed_line_revenue, 0), 2),
         ROUND(LEAST(COALESCE(p.refunded_raw, 0),
                     COALESCE(p.attributed_line_revenue, 0)), 2),
         ROUND(GREATEST(COALESCE(p.attributed_line_revenue, 0)
                        - LEAST(COALESCE(p.refunded_raw, 0),
                                COALESCE(p.attributed_line_revenue, 0)), 0), 2),
         p.revenue_basis,
         p.currency
  FROM priced p
  ORDER BY p.purchased_at, p.order_id, p.tried_on_product;
$$;

-- EXECUTE defaults to PUBLIC, which `anon` inherits — the exact hole
-- 20260715_revoke_anon_execute_on_sensitive_rpcs.sql closed. Revoke first, then
-- grant only the two roles the dashboard and server actually use.
REVOKE ALL ON FUNCTION public.get_vto_billing_statement(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_vto_billing_statement(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_vto_billing_statement(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;
