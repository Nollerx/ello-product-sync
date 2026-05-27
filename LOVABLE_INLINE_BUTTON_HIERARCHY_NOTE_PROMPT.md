# Lovable Agent Prompt: Inline Try-On Button — Theme Editor Override Note

## Context

The Ello inline Try-On button can be configured from **two places**:

1. **This dashboard** (Widget Placements → Inline Try-On Button card) — sets the merchant-wide defaults via the `vto_stores.inline_button_*` columns in Supabase.
2. **The Shopify theme editor** — the merchant drags our "Ello Inline Try-On" block into their product template, and the block has its own per-block settings for **button text**, **background color**, and **text color**.

The storefront widget's resolution rule (already implemented and live):

> **If the merchant set a value in the theme editor, that value wins.** The dashboard value is only used when the theme-editor field is left blank.

Right now this hierarchy is undocumented for merchants. A merchant who tweaked the color in the theme editor weeks ago — and then later tries to change it from the dashboard — will see no visible change on their storefront and assume the dashboard is broken. They'll open a support ticket. We need to surface the hierarchy in the UI so they self-serve.

This is a **UI copy-only change**. No new Supabase columns, no new writes, no logic changes. Just an info note inside the existing Inline Try-On Button card.

## Where to put it

Inside the existing **Inline Try-On Button** card on the Widget Placements page. Position the note **between the master toggle and the four sub-controls** (button text input, background color picker, text color picker, hide-when-OOS checkbox). It should be visible whenever the master toggle is ON.

If the card has a `<CardDescription>` or similar slot, that also works — but the note should not be hidden behind a tooltip or "learn more" link. Merchants miss those.

## What it should say

Use this exact copy — short, friendly, no jargon:

> **Theme editor overrides take priority.** If you've set a button color or text inside Shopify's theme editor (on the Ello Inline Try-On block), those values will be used on your storefront instead of what you set here. Leave the theme-editor fields blank to use these dashboard settings.

## How to style it

- Use the dashboard's existing **info-style alert / callout component** (the same one used elsewhere for tips, e.g. the "Don't see the button on your storefront?" helper text already in this card).
- Pair it with an **info icon** (lucide-react `Info` or whichever icon library the dashboard uses).
- Subtle background — light blue/gray. **Do not use warning or error styling** — this is informational, not a problem.
- Body text in the same size as other helper text on this card, not heading-sized.

## Behavior

- Always visible when the master "Enable on product pages" toggle is ON.
- Hidden when the toggle is OFF (no point telling them about overrides for a disabled feature).
- Not dismissible — this is persistent reference info, not a one-time announcement.
- Static text. No data fetching, no Supabase reads.

## What NOT to do

- Don't add a "View in theme editor" button or deeplink — Shopify doesn't have a stable URL for landing on a specific block inside the theme editor, and a broken-feeling link is worse than no link.
- Don't try to read the merchant's theme-editor settings — those live in the merchant's theme, not in Supabase, and we have no API access to them from the dashboard.
- Don't change any existing field labels or helper text on the card. Just add the new note.
- Don't add the same note to the Floating Widget card or Preview Popup card — those don't have theme-editor overrides, only the Inline Try-On Button does.

## Notes

- The Inline Try-On Button is the only one of the three placements with this dual-source hierarchy. Floating widget and preview popup are dashboard-only.
- The same note could be added later to onboarding/help docs, but for now the in-card placement is the highest-value surface — that's where confused merchants will be looking.
