# Dashboard Update: Widget Opens Analytics

## What Changed (2026-04-21)

A new Supabase RPC `get_widget_opens_summary` replaces raw-row queries for widget open analytics. This fixes the 1000-row cap that was causing undercounting on busy stores.

## Migration

Run `supabase/migrations/20260421_get_widget_opens_summary.sql` in your Supabase SQL editor (or via CLI).

## New RPC Signature

```sql
get_widget_opens_summary(p_store_slug TEXT, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
-- Returns: JSONB (single row)
```

## Return Shape

```json
{
  "total_opens": 5432,
  "unique_sessions": 2187,
  "by_device": {
    "mobile": 1200,
    "desktop": 800,
    "tablet": 150,
    "unknown": 37
  },
  "by_day": [
    { "date": "2026-04-01", "total": 180, "unique": 92 },
    { "date": "2026-04-02", "total": 205, "unique": 110 }
  ]
}
```

## Dashboard Hook Update

### Before (broken)

```typescript
// Raw row query — capped at 1000 rows by Supabase
const { data } = await supabase
  .from('widget_events')
  .select('*')
  .eq('store_slug', storeSlug)
  .eq('event_type', 'widget_open')
  .gte('created_at', from)
  .lt('created_at', to);

// Client-side aggregation (breaks at scale)
const totalOpens = data.length;
const uniqueSessions = new Set(data.map(r => r.session_id)).size;
const byDevice = data.reduce(/* ... */);
```

### After (fixed)

```typescript
const { data, error } = await supabase.rpc('get_widget_opens_summary', {
  p_store_slug: storeSlug,
  p_from: from,   // ISO 8601 string, e.g. '2026-04-01T00:00:00Z'
  p_to: to,       // ISO 8601 string, e.g. '2026-05-01T00:00:00Z'
});

if (error) {
  console.error('Widget opens fetch failed:', error);
  return;
}

// data is already aggregated — use directly:
const { total_opens, unique_sessions, by_device, by_day } = data;

// by_device = { mobile: int, desktop: int, tablet: int, unknown: int }
// by_day    = [{ date: 'YYYY-MM-DD', total: int, unique: int }, ...]
```

### What to Remove

- Remove **all client-side aggregation** (counting, grouping, deduplication).
- Remove any `.limit()` or pagination logic for widget open queries.
- Remove the `useWidgetOpens` hook's raw-data state — replace with the typed summary object.

## Data Guarantees

- **No row limit**: Returns exactly one JSONB row regardless of event volume.
- **Cross-table dedup**: UNIONs `widget_events` (live) and `vto_widget_opens` (legacy, 186 rows from before 2026-03-03). Deduplicates by `(session_id, created_at)` truncated to the second.
- **Device uniqueness**: `by_device` counts use `COUNT(DISTINCT session_id)`, not raw row counts.
- **NULL sessions**: Events without `session_id` are counted in `total_opens` and `by_day.total` but excluded from `unique_sessions`, `by_device`, and `by_day.unique`.

## Verification

After deploying, test with a store that has >1000 widget opens. The `total_opens` value should exceed 1000 (the old cap).

```sql
-- Quick sanity check: should match total_opens from the RPC
SELECT COUNT(*) FROM widget_events
WHERE store_slug = 'your-store' AND event_type = 'widget_open';
```
