-- ============================================================================
-- Add Quantity to Cart Events
-- Date: 2026-04-21
-- Purpose: Update the record_cart_event function to accept and record
--          the quantity of items added to the cart, preventing the UI
--          quantity from being dropped silently.
-- ============================================================================

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT oid::regprocedure::text AS sig
    FROM pg_proc
    WHERE proname = 'record_cart_event'
      AND pronamespace = 'public'::regnamespace
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.record_cart_event(
  p_store_slug TEXT,
  p_product_id TEXT DEFAULT NULL,
  p_variant_id TEXT DEFAULT NULL,
  p_session_id TEXT DEFAULT NULL,
  p_quantity INT DEFAULT 1
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.cart_events (store_slug, product_id, variant_id, session_id, quantity)
  VALUES (p_store_slug, p_product_id, p_variant_id, p_session_id, p_quantity);

  RETURN jsonb_build_object('success', true);
END;
$$;

-- Re-grant execute permission to anon role
GRANT EXECUTE ON FUNCTION public.record_cart_event(TEXT, TEXT, TEXT, TEXT, INT) TO anon;

-- Force PostgREST to pick up the schema change
NOTIFY pgrst, 'reload schema';
