# Lovable Agent Prompt: Admin "View a client's dashboard" (impersonate/POV)

## Context

The admin dashboard (`/admin`, gated by `useAdminAuth`) shows an all-clients overview table. We want the admin (org owner) to pick any client's store from a dropdown and drop into **that store's normal dashboard POV** — the same per-store views a merchant sees (conversion, usage, revenue, etc.) — then return to the admin view. This is read-only "view as," not a login as them.

Do NOT redesign or remove anything that already works. Add only what's described. Do NOT change any Supabase Row-Level Security, table grants, or database functions — this works entirely through the admin's existing authenticated session.

## How it works (important — build to this design)

- The per-store dashboard already renders whatever store is in `StoreContext` (`useStore()` → `storeData`), which the per-store hooks (e.g. `useConversionMetrics`) read as `storeData.storeSlug` and pass to the `get_vto_*` Supabase RPCs.
- Those RPCs are callable by any **authenticated** session, and the admin is authenticated. So if we set `StoreContext` to any store, the per-store analytics load for that store. No backend permission change is needed.
- `ProtectedRoute` gates `/` on `useStore().isAuthenticated` (i.e., `storeData` is set). Setting `storeData` satisfies it. The admin's Supabase Auth session is independent of `storeData`, so it stays logged in.

## Part 1 — Backend: extend the `admin-dashboard` edge function

The edge function (`supabase/functions/admin-dashboard/index.ts`) already uses the service-role key and reads `vto_stores` + `vto_accounts`. It currently returns per-account aggregates (with `store_count`) but not the individual stores. **Add a top-level `stores` array to its JSON response**, one entry per row in `vto_stores`, joined to its `vto_accounts` row, with exactly these fields (these are the fields `StoreContext`'s `StoreData` needs):

```ts
stores: [
  {
    storeId: store.id,                        // vto_stores.id (uuid)
    storeSlug: store.store_slug,
    storeName: store.store_name,
    accountId: store.account_id,
    accountName: account?.name ?? '',
    accountType: account?.type ?? 'brand',    // 'brand' | 'agency'
    ownerEmail: account?.owner_email ?? '',
    planCode: <the account's active plan code, same value already used in the clients table>,
    shop_domain: store.shop_domain ?? null,
    storefront_token: store.storefront_token ?? null,
    clothing_population_type: store.clothing_population_type ?? null,
    widget_primary_color: store.widget_primary_color ?? null,
    widget_accent_color: store.widget_accent_color ?? null,
    minimized_color: store.minimized_color ?? null,
    featured_item_id: store.featured_item_id ?? null,
    quick_picks_ids: store.quick_picks_ids ?? null,
    block_overage: store.block_overage ?? null,
  },
  ...
]
```

Keep the existing response fields unchanged; just add `stores`. Redeploy the edge function.

## Part 2 — Frontend: surface it in `useAdminDashboard`

`useAdminDashboard` already calls `supabase.functions.invoke('admin-dashboard')`. Expose the new `stores` array from the hook (e.g. return `{ ...existing, stores }`).

## Part 3 — Frontend: the picker on the admin page

On `AdminDashboard.tsx`, above the `AdminClientsTable`, add a **"View a client's dashboard"** control:

- A searchable dropdown/combobox listing every store from `stores`.
- Label each option as `storeName — ownerEmail (planCode)`. Group options by `planCode` (a heading per plan) so it reads as "a dropdown of all my plans," with each client's store under its plan.
- On select, call a `viewAsStore(store)` action (below). Also make each row in `AdminClientsTable` open its store the same way (if an account has multiple stores, open the first, or expand to list them) — optional but nice.

`viewAsStore(store)` implementation:

```ts
const { setStoreData } = useStore();
const navigate = useNavigate();

function viewAsStore(store) {
  setStoreData({
    storeId: store.storeId,
    storeSlug: store.storeSlug,
    storeName: store.storeName,
    accountId: store.accountId,
    accountName: store.accountName,
    accountType: store.accountType,
    ownerEmail: store.ownerEmail,
    shop_domain: store.shop_domain ?? undefined,
    storefront_token: store.storefront_token ?? undefined,
    clothing_population_type: store.clothing_population_type ?? undefined,
    widget_primary_color: store.widget_primary_color ?? undefined,
    widget_accent_color: store.widget_accent_color ?? undefined,
    minimized_color: store.minimized_color ?? undefined,
    featured_item_id: store.featured_item_id ?? undefined,
    quick_picks_ids: store.quick_picks_ids ?? undefined,
    blockOverage: store.block_overage ?? undefined,
  });
  navigate('/'); // renders that store's normal dashboard
}
```

## Part 4 — "Viewing as" banner + exit

Add a persistent top banner shown whenever an **admin is impersonating** — condition: `useAdminAuth().isAdmin === true && storeData !== null`. Put it in the app shell/header so it shows on every per-store page.

- Text: `Viewing as {storeData.storeName} — you're seeing this client's dashboard.`
- A button **"Exit to admin"** that runs:
  ```ts
  navigate('/admin');
  setStoreData(null);
  ```
  (navigate first, then clear, so `ProtectedRoute` on `/` doesn't bounce to the store-login page mid-transition.)

## Guardrails

- Only admins can reach `/admin` (existing `useAdminAuth` gate), so only admins can start a "view as." Don't expose the picker anywhere a non-admin store session can see it.
- Do not add the service-role key anywhere in the client. The store list comes only from the `admin-dashboard` edge function.
- The analytics views (conversion, usage, revenue, receipts, returns) load via the `get_vto_*` RPCs and will populate. A few settings panels that read `vto_stores`/`vto_accounts` tables directly may be limited for other clients' stores (that's expected RLS behavior for a read-only POV) — that's fine; don't loosen RLS to "fix" it.
