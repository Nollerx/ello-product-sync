# Lovable Agent Prompt: Widget Position Toggle

## Context

The Ello Virtual Try-On widget renders as a floating button on the merchant's storefront. By default it appears in the bottom-**right** corner. We want merchants to be able to choose **bottom-left** or **bottom-right** from the Ello dashboard. The setting lives in our Supabase `vto_stores` table — the storefront widget reads it on load and positions itself accordingly. No Shopify-app changes are needed.

## Supabase Connection

The dashboard already connects to our Supabase project at `rwmvgwnebnsqcyhhurti.supabase.co`. Use the existing Supabase client.

## Data Source

The `vto_stores` table has a `widget_position` column:

- **Type**: `TEXT`
- **Allowed values**: `'left'` or `'right'`
- **Default**: `'right'`
- **Constraint**: `CHECK (widget_position IN ('left', 'right'))`

### Reading

```typescript
const { data, error } = await supabase
  .from('vto_stores')
  .select('widget_position')
  .eq('store_slug', storeSlug)
  .single();

// data.widget_position is 'left' or 'right'
```

### Writing

```typescript
const { error } = await supabase
  .from('vto_stores')
  .update({ widget_position: 'left' }) // or 'right'
  .eq('store_slug', storeSlug);
```

## UI Requirements

Add a **Widget Position** card to the dashboard (place it on the existing settings/widget page, or create a new "Widget Appearance" section if one doesn't exist).

### Card contents

- **Title**: "Widget Position"
- **Subtitle**: "Choose which bottom corner the try-on widget appears in on your storefront."
- **Two-button toggle** (segmented control style):
  - Button 1: **Bottom Left** — sets `widget_position = 'left'`
  - Button 2: **Bottom Right** — sets `widget_position = 'right'`
  - The currently-active position should be visually highlighted (filled background, the other ghost/outlined).
- **Optional preview**: a small browser-frame mockup with a circle in the selected corner — nice but not required.

### Behavior

1. On mount, read `widget_position` from `vto_stores` and highlight the matching button.
2. Clicking the inactive button:
   - Optimistically updates the UI (highlight switches immediately).
   - Calls the Supabase update.
   - Shows a success toast: "Widget position updated. Changes appear on your storefront within a minute."
   - On error, reverts the highlight and shows an error toast.
3. Disable both buttons while the request is in flight to prevent double-clicks.
4. Treat a `null`/missing value as `'right'` (the default).

## Notes

- The storefront widget caches config briefly. Tell merchants changes appear "within a minute" — don't promise instant.
- This is independent of all billing/usage settings. It's purely a display preference.
- The store slug is available from the merchant's login session (same source used by the existing billing page).
