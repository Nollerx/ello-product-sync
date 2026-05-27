# Lovable Agent Prompt: Add "Abandoned at File Picker" Row to Upload Friction

## Context

This is a follow-up to the earlier Upload Friction prompt that fixed the fail-reason label map. That prompt aligned the labels with what the widget actually emits.

The remaining gap: when a user clicks the upload tile and then **dismisses the OS file picker without choosing a file**, the widget fires `photo_upload_start` but never fires a matching `photo_upload_success` or `photo_upload_fail`. These users are correctly counted against the completion-rate denominator (so the headline number is accurate), but they're **invisible in the Failure Reasons card** — they vanish into the gap between "Started" and "Success + Failed."

If half the people who don't complete are actually backing out at the OS picker, the dashboard hides that, and the "Top Issue" badge can confidently misdiagnose the real problem.

## Change

In **`src/hooks/useFunnelAnalytics.ts`**, in the block that builds `uploadFriction` (around line 529), compute an abandoned count and inject it as a synthetic row into `failReasons` so the existing UI renders it with no other changes.

```ts
// Upload friction
const failReasonCounts = new Map<string, number>();
uploadFails.forEach(e => {
  const reason = (e.event_data as { reason?: string })?.reason || 'unknown';
  failReasonCounts.set(reason, (failReasonCounts.get(reason) || 0) + 1);
});

// Abandoned = started but never matched by a success or fail event.
// Most common cause: user clicked upload, OS file picker opened, they hit Cancel.
const abandonedCount = Math.max(
  0,
  uploadStarts.length - uploadSuccesses.length - uploadFails.length
);
if (abandonedCount > 0) {
  failReasonCounts.set('abandoned', abandonedCount);
}

const uploadFriction: UploadFrictionMetrics = {
  completionRate: uploadStarts.length > 0
    ? (uploadSuccesses.length / uploadStarts.length) * 100
    : 0,
  failReasons: Array.from(failReasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count),
  totalStarts: uploadStarts.length,
  totalSuccesses: uploadSuccesses.length,
  totalFails: uploadFails.length,
};
```

In **`src/components/advanced-metrics/UploadFriction.tsx`**, add `abandoned` to `failReasonLabels`:

```tsx
abandoned: {
  label: 'Abandoned at File Picker',
  fix: 'User clicked upload but never selected a file (likely cancelled the OS dialog). Add privacy-reassurance copy near the upload button or offer a "Use a model instead" fallback.',
  icon: <XCircle className="h-4 w-4" />
},
```

## Important: do not change the headline metric

- Do **not** change `completionRate`. It stays `successes / starts`.
- Do **not** change `totalFails`. The "Failed" stat tile and the "X total" badge in the Failure Reasons card both read this and should keep meaning "events with reason=fail," not "everything that didn't succeed."
- The new `abandoned` row is purely additive in the breakdown list.

## Why

Same data we already have, just stops hiding the abandoners. If "Abandoned at File Picker" lands as the Top Issue, the fix is privacy / trust copy near the upload button, not anything to do with file types or quality validation — totally different remediation than the existing fail reasons would suggest.
