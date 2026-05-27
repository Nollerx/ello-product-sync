# Lovable Agent Prompt: Shopify App Dashboard Bridge

## Context

We have a Shopify app (Ello Virtual Try-On) that's embedded inside the Shopify admin. As part of onboarding, we want to show the merchant their Ello dashboard **inside an iframe within the Shopify app** so they can see insights without leaving Shopify.

The dashboard (this Lovable app) currently uses a custom passwordless auth: `StoreLogin` looks up `vto_accounts` / `vto_stores` by email and writes the store record to `localStorage` under the key `storeAuth`. `StoreContext` reads it on mount; `ProtectedRoute` gates `/`, `/advanced-metrics`, `/account`, etc.

We need a new **activation endpoint** that lets the Shopify app hand off a merchant into the dashboard without making them log in again — and we need the dashboard to be embeddable in an iframe from Shopify admin.

## What to build

### 1. New route: `/auth/activate`

A page (not a layout — render in plain JSX, no `ProtectedRoute`) that:

1. Reads four query params from the URL: `email`, `store_id`, `exp`, `token`.
2. Verifies the HMAC signature (see "Token format" below). If invalid or expired, render a clean error state ("This activation link is invalid or expired. Open the Ello app from your Shopify admin to try again.") and stop.
3. Looks up the store in Supabase: `vto_stores` where `id = store_id` AND store email matches `email` (the column in `vto_stores` that ties to the merchant's email — match whatever shape `StoreLogin` already uses). If not found, render the same error state.
4. Writes the resulting store record to `localStorage` under the key `storeAuth`, in the **exact same shape** that the existing `StoreLogin` writes. **Read `StoreLogin.tsx` and `StoreContext.tsx` before writing this — the shape must match exactly so `StoreContext` rehydrates correctly. Do not invent a new shape.**
5. Redirects to `/` (or to a `redirect` query param if present, but only allow same-origin paths starting with `/`).

The route should be very fast — show a tiny "Activating your dashboard…" spinner, nothing more. No nav, no chrome.

### Token format

The Shopify app signs the activation URL server-side. The dashboard verifies it using the same shared secret. **The secret is in env var `SHOPIFY_BRIDGE_SECRET`** (add this to Lovable Cloud env — Andrew will provide the value).

- **Message to sign:** `${email}:${store_id}:${exp}` (literal colons, no JSON, no spaces).
- **Algorithm:** HMAC-SHA256.
- **Encoding:** hex string (lowercase).
- **Expiry:** `exp` is a unix timestamp in **seconds**. Reject if `exp < now()` or if `exp` is more than 10 minutes in the future (sanity bound).
- **Comparison:** use a constant-time compare (e.g., `crypto.subtle` or a `timingSafeEqual` polyfill). Don't use plain `===`.

Verification reference (TypeScript, runs in the browser via Web Crypto):

```typescript
async function verifyToken(email: string, storeId: string, exp: string, token: string, secret: string): Promise<boolean> {
  const expNum = Number(exp);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(expNum) || expNum < now || expNum > now + 600) return false;

  const message = `${email}:${storeId}:${exp}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const expected = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // constant-time compare
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
```

Note: the secret reaches the browser here, which is acceptable **only because** this whole endpoint runs in a serverless/edge function. **If Lovable Cloud supports running this verification server-side (e.g., as an edge function or RPC), do that instead** — `SHOPIFY_BRIDGE_SECRET` should never reach the merchant's browser. Pick whichever pattern matches how the rest of this dashboard already handles secrets. If unsure, ask before exposing the secret client-side.

### 2. Allow iframe embedding from Shopify admin

The dashboard must be embeddable inside `https://admin.shopify.com` and `https://*.myshopify.com`.

- Add a `Content-Security-Policy` header with `frame-ancestors 'self' https://admin.shopify.com https://*.myshopify.com` to all dashboard responses (or at minimum to `/auth/activate` and the routes it redirects to).
- Remove any `X-Frame-Options: DENY` / `SAMEORIGIN` header if present — `frame-ancestors` supersedes it on modern browsers, and `X-Frame-Options` with `DENY` will block the iframe even if CSP allows it.
- If Lovable's hosting doesn't let you set response headers directly, use a `<meta http-equiv="Content-Security-Policy" content="...">` tag in `index.html` as a fallback (note: `frame-ancestors` is **not** enforceable via meta tag per the CSP spec, so headers are strongly preferred — flag this back to Andrew if headers aren't configurable).

### 3. Iframe-aware UI polish (small)

When the dashboard is rendered inside an iframe (detect via `window.self !== window.top`):

- Hide the top nav bar / logo header (the merchant already sees the Shopify app shell around it).
- Hide the "Log out" button (logout inside the iframe would break the parent app's flow — they log out via the Shopify app).
- Keep everything else identical.

A simple `useIsEmbedded()` hook + conditional class on the root layout is fine.

## Acceptance criteria

- [ ] Visiting `/auth/activate?email=…&store_id=…&exp=…&token=…` with a valid signed token writes `storeAuth` to localStorage and redirects to `/`, landing the user inside the authenticated dashboard.
- [ ] An expired or tampered token shows the error state and does **not** write to localStorage.
- [ ] The dashboard loads cleanly inside an iframe served from `https://admin.shopify.com` (no `X-Frame-Options` block, no CSP block).
- [ ] When embedded, the top nav and logout are hidden; otherwise they render normally.
- [ ] `SHOPIFY_BRIDGE_SECRET` is read from Lovable Cloud env, not hardcoded.
- [ ] The localStorage shape written by `/auth/activate` is byte-for-byte the same as what `StoreLogin` writes — `StoreContext` should not need any changes.

## Notes for the agent

- **Do not** touch `StoreContext`, `ProtectedRoute`, or `StoreLogin` logic. The activation route should produce the same localStorage entry those existing components already expect.
- **Do not** introduce a second auth model. This is just a different *way* of obtaining the same `storeAuth` blob.
- The Shopify app side (signing the URL, rendering the iframe) is being built in parallel — you don't need to touch it. Just make `/auth/activate` and the iframe headers correct.
- Andrew will provide `SHOPIFY_BRIDGE_SECRET` after this PR is built. Use a placeholder during development.
