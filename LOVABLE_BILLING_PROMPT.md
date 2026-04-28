# Lovable Agent Prompt: Billing & Usage Management Page

## Context

We have a Shopify app (Ello Virtual Try-On) that tracks try-on usage per merchant. The Shopify app stores all billing and usage data in our Supabase database. We need a "Billing & Usage" page in the Ello dashboard (this Lovable app) where merchants can:

1. See their current plan, usage, and remaining try-ons
2. Control their auto top-up settings for overage try-ons
3. See their overage credits balance

## Supabase Connection

The dashboard already connects to our Supabase project at `rwmvgwnebnsqcyhhurti.supabase.co`. Use the existing Supabase client.

## Data Sources

### Reading Usage Data

Call the Supabase RPC function `get_store_usage` with the merchant's store slug:

```typescript
const { data, error } = await supabase.rpc('get_store_usage', {
  p_store_slug: storeSlug  // the logged-in merchant's store slug
});
```

This returns:
```json
{
  "plan_name": "Ello Growth",
  "included_tryons": 750,
  "tryons_used": 342,
  "tryons_remaining": 408,
  "period_start": "2026-03-01T00:00:00Z",
  "period_end": "2026-04-01T00:00:00Z",
  "overage_auto_topup": false,
  "overage_cap_credits": 100,
  "overage_credits_used": 0,
  "overage_credits_remaining": 100,
  "overage_trigger_threshold": 50,
  "overage_rate": 0.15
}
```

### Reading/Writing Overage Settings

Read overage settings from the `vto_stores` table:
```typescript
const { data } = await supabase
  .from('vto_stores')
  .select('overage_auto_topup, overage_cap_credits, overage_trigger_threshold, overage_credits_used')
  .eq('store_slug', storeSlug)
  .single();
```

Update overage settings:
```typescript
await supabase
  .from('vto_stores')
  .update({
    overage_auto_topup: true,
    overage_cap_credits: 200,
    overage_trigger_threshold: 50,
  })
  .eq('store_slug', storeSlug);
```

**There is also a REST API endpoint** on the Shopify app for reading/writing these settings (if you prefer):
- `GET https://{SHOPIFY_APP_URL}/api/overage-settings?store_slug={slug}`
- `POST https://{SHOPIFY_APP_URL}/api/overage-settings` with JSON body

## Page Design

Create a page that looks similar to FASHN's billing page (reference design). The page should have these sections:

### Section 1: Current Plan Card (top-left)

Display:
- Plan name (e.g., "Ello Growth") with a badge
- Monthly/Annual indicator
- Price per month
- "Manage on Shopify" link that opens the merchant's Shopify admin billing page

### Section 2: API Credits Card (top-right)

Display:
- **Monthly Subscription Credits**: "{tryons_used} of {included_tryons} used"
- Progress bar showing usage percentage
- Color coding: green < 60%, yellow 60-80%, red > 80%
- **Topped-up credits** (overage credits): Show `overage_cap_credits - overage_credits_used` remaining
- "View Analytics" button (can link to a future analytics page)
- Period reset date: "Resets {period_end formatted}"

### Section 3: Credit Auto Top-up Card (bottom-left)

This is the key section. Display:
- **Auto Top-up toggle** (on/off)
  - Maps to `overage_auto_topup` boolean
  - When OFF: merchant's try-ons are blocked at their plan limit
  - When ON: overage try-ons are allowed up to the cap, charged at $0.15 each

- **Purchase Amount**: Number input for credits
  - Maps to `overage_cap_credits`
  - Label: "credits"
  - Default: 100
  - This is the maximum number of overage try-ons allowed per billing period

- **Trigger Threshold**: Number input
  - Maps to `overage_trigger_threshold`
  - Label: "credits remaining"
  - This is when to notify the merchant they're running low
  - Default: 50

- **"Update Settings" button**
  - Saves all three values to `vto_stores` via Supabase update
  - Show success/error toast on save

- Info text at bottom: "Each overage try-on costs $0.15. Your total overage budget is ${overage_cap_credits * 0.15} per billing period. Shopify will bill overages at the end of your billing cycle."

### Section 4: Payment Methods Card (bottom-right)

Display:
- Text: "Payment methods are managed through your Shopify account."
- "Manage Billing on Shopify" button
  - Links to: `https://admin.shopify.com/store/{store_handle}/settings/billing`
  - Where `store_handle` = shop domain without `.myshopify.com`

## UX Requirements

1. Page should load with a skeleton/loading state while fetching data
2. Auto-top-up toggle should immediately show the expanded settings when ON
3. When auto top-up is OFF, hide/collapse the Purchase Amount and Trigger Threshold inputs
4. Show a warning banner if `tryons_remaining` is 0 and auto top-up is OFF
5. Show the overage cost prominently: "$0.15 per additional try-on"
6. All number inputs should have validation (min 0, integers only)
7. The page should be responsive (2-column on desktop, single column on mobile)

## Route

Add this page at `/billing` or `/settings/billing` in the dashboard routing, and add a "Billing" link in the sidebar navigation.

## Important Notes

- The `overage_rate` is always $0.15 (hardcoded, not user-configurable)
- Payment is handled by Shopify, not by us - we don't collect credit cards
- The auto top-up doesn't charge immediately - Shopify bills at end of billing cycle
- The `overage_credits_used` resets to 0 at the start of each billing period (handled by the Shopify app, not the dashboard)
- The store slug is available from the merchant's login session
