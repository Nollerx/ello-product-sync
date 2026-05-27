# Lovable Agent Prompt: New Placements Banner (Existing Merchants)

## Context

We just shipped a major upgrade to the Ello Virtual Try-On widget — merchants can now place a **Try-On button inline on product pages** (right next to Add to Cart), which converts 3–10× better than the existing floating bubble. Existing merchants need a non-intrusive way to discover and set up this new placement.

Add a dismissible banner that shows on the top of the main dashboard page until the merchant either sets up placements or dismisses the banner. The banner deep-links them to the Shopify-app onboarding placements screen (managed inside the Shopify embedded app, NOT the Lovable dashboard).

## Supabase Connection

The dashboard already connects to our Supabase project at `rwmvgwnebnsqcyhhurti.supabase.co`. Use the existing Supabase client.

## Data Source

The `vto_stores` table has a `placements_banner_dismissed_at` column:

- **Type**: `TIMESTAMPTZ` (nullable)
- **Default**: `NULL`
- **Semantics**: `NULL` = merchant has not dismissed the banner. Set to `NOW()` when dismissed.

### Reading

```typescript
const { data, error } = await supabase
  .from('vto_stores')
  .select('placements_banner_dismissed_at')
  .eq('store_slug', storeSlug)
  .single();

const shouldShowBanner = data?.placements_banner_dismissed_at == null;
```

### Writing (dismiss)

```typescript
const { error } = await supabase
  .from('vto_stores')
  .update({ placements_banner_dismissed_at: new Date().toISOString() })
  .eq('store_slug', storeSlug);
```

## UI Requirements

### Banner

Place at the very top of the main dashboard page (above any other content cards). Use a tone-info or tone-success style — this is good news, not a warning.

- **Title**: "New: Inline Try-On button on product pages"
- **Body**: "Add a Try-On button right next to your Add to Cart button. It converts 3–10× better than the floating widget alone. Set it up in two minutes."
- **Primary action button**: "Set it up →"
  - Opens the Shopify embedded app's placements onboarding screen. The merchant accesses this via their Shopify admin → Apps → Ello Virtual Try-On → and the onboarding screen is at the path `/app/onboarding/placements`. If your dashboard doesn't have a direct link, instruct the merchant: "Open your Ello app in Shopify admin and look for the new 'Placements' setup step."
  - Recommended: open a new tab to `https://admin.shopify.com/apps/ello-virtual-try-on` (or the equivalent app handle for the current merchant — adapt if you have a stored value), then let the merchant click into onboarding from there.
- **Secondary action**: "Dismiss" — clicking writes `placements_banner_dismissed_at = NOW()` and the banner disappears immediately (optimistic) without a page reload.

### Behavior

1. On dashboard mount, fetch `placements_banner_dismissed_at`. If `null`, render the banner. If non-null, render nothing.
2. The "Dismiss" button:
   - Optimistically removes the banner from the UI.
   - Fires the Supabase update in the background.
   - On error, restores the banner and shows a small error toast.
3. The "Set it up →" button does NOT dismiss the banner automatically — the merchant might leave the dashboard, finish setup, and come back; we want them to be able to re-find the link if they get distracted. The banner only goes away on explicit Dismiss.
4. Once the merchant has completed placements setup in the Shopify app (writes any of `inline_button_enabled`, `floating_widget_pdp_enabled`, or `floating_widget_non_pdp_enabled` from the new onboarding screen), the Shopify-app side ALSO marks `placements_banner_dismissed_at` so the banner doesn't keep haunting them. You don't need to handle that case in the dashboard — just read the column on every render.

## Notes

- This is a one-time-per-merchant banner. Once dismissed, it stays dismissed forever (no re-show logic, no expiry).
- For new installs going through onboarding for the first time after this banner ships, the onboarding screen on the Shopify-app side will write `placements_banner_dismissed_at`, so they never see the banner at all. That's intentional — the banner only catches existing merchants who pre-date the new placements feature.
- The store slug is available from the merchant's login session.
- The column was added in the same migration as the rest of the placements feature (`20260524_inline_tryon_button.sql`).
