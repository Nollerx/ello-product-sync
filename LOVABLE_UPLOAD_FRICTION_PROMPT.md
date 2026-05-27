# Lovable Agent Prompt: Sync Upload Friction Fail-Reason Labels

## Context

The Upload Friction Diagnostics card on the dashboard groups `photo_upload_fail` events by `event_data.reason` and shows a label + suggested fix for each. The reason labels in `src/components/advanced-metrics/UploadFriction.tsx` were defined speculatively and don't match what the storefront widget actually emits today.

I just audited the widget (`public/widget-main.js` in the storefront app). These are the **only** reasons the widget ever emits:

| `reason` value | When it fires |
|---|---|
| `invalid_type` | Basic file-type validation rejected the file (wrong MIME / extension) |
| `quality_fail` | Image passed type check but failed brightness / contrast / aspect-ratio quality validation |
| `read_error` | `FileReader` threw while reading the file |
| `unknown` | Caught exception during post-read processing |

Reasons currently in the dashboard map that the widget **never emits** (dead labels):

- `too_large`
- `cancelled`
- `network_error`

Because the widget actually emits `quality_fail` and `read_error`, but the dashboard map doesn't list them, those failures fall through to the generic `unknown` ("Unknown Error") label — and the dashboard's "Top Issue" card can confidently recommend the wrong fix.

## Change

Update the `failReasonLabels` constant in `src/components/advanced-metrics/UploadFriction.tsx` to match what the widget actually sends. Replace the existing object with:

```tsx
const failReasonLabels: Record<string, { label: string; fix: string; icon: React.ReactNode }> = {
  invalid_type: {
    label: 'Invalid File Type',
    fix: 'Accept HEIC, show supported formats upfront, or auto-convert',
    icon: <FileWarning className="h-4 w-4" />
  },
  quality_fail: {
    label: 'Image Quality Rejected',
    fix: 'Photos failed brightness / contrast / aspect-ratio checks. Loosen thresholds or surface clearer guidance before upload.',
    icon: <FileWarning className="h-4 w-4" />
  },
  read_error: {
    label: 'File Read Error',
    fix: 'Browser FileReader failed. Likely corrupt file or permission issue — add a retry hint.',
    icon: <AlertCircle className="h-4 w-4" />
  },
  unknown: {
    label: 'Unknown Error',
    fix: 'Review error logs for more details',
    icon: <AlertCircle className="h-4 w-4" />
  },
};
```

That is: **keep** `invalid_type` and `unknown`, **add** `quality_fail` and `read_error`, **remove** `too_large`, `cancelled`, and `network_error`.

No other files should change. Don't touch the hook or the metric formula — only the label/fix map in `UploadFriction.tsx`.

## Why

Aligning the labels with reality means:
- The "Top Issue" badge surfaces the actual dominant failure mode, not a misclassified one.
- The hardcoded fix suggestions stop pointing at problems the widget can't even report.
- We'll see if `quality_fail` is the real driver — historically a lot of "unknown" likely was this.

## Out of scope (handled separately on the widget side)

- Adding a real `cancelled` event when users dismiss the OS file picker.
- Fixing mobile camera/gallery paths that weren't emitting `photo_upload_start`.

Both of those are widget changes shipping in `WIDGET_VERSION = '2.4.6'` of the storefront app.
