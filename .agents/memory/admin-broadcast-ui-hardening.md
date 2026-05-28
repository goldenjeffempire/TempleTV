---
name: Admin broadcast UI hardening
description: 6 targeted fixes to the broadcast-v2.tsx Master Control page and the transcode-remote server endpoint.
---

## Fixes applied

**1. Thumbnail fallback icon**
Queue row thumbnails previously left a gray `bg-muted` box on `onError`. Fix: always render a `<Radio>` icon behind the `<img>`; on error, set `opacity: 0` on the img to reveal the icon. Both the icon and img live in a `relative` container.

**2. Transcoding panel shows failed jobs**
`TranscodingProgressPanel` `select` previously filtered to `queued|encoding|processing` only. Now returns `{ active, recentFailed }` (last 3 failed). Panel renders a "Recent Failures" section with the error message when `recentFailed.length > 0`. Panel now stays visible when there are only failed jobs (previously returned `null`).

**3. `bufferUtilizationPct` metric added**
The `/broadcast-v2/diagnostics` endpoint already returns `analytics.bufferUtilizationPct` (ring-buffer fill %). Added it to the `DiagnosticsReport` analytics interface and displayed it in the Session Analytics row. Shows amber if > 80%.

**4. Checklist API error state**
Destructured `isError: engineHealthError` from the engineHealth query. When `engineHealth == null && engineHealthError`, the checklist dialog shows a red error message instead of "Loading engine status…" indefinitely.

**5. Rate limit on `transcode-remote`**
`POST /broadcast-v2/queue/:id/transcode-remote` now has `config: { rateLimit: { max: 10, timeWindow: "10 minutes" } }` to prevent accidental multi-dispatch.

**6. `broadcastOnly: true` on remote-transcode managed_videos INSERT**
Videos created by the remote-transcode endpoint are mirror/local-HLS copies of prod-sync items. Setting `broadcastOnly: true` prevents them from appearing in the public video library catalog.

**Why:**
Each fix addresses a visible operator pain point during live broadcast management — stuck-loading states, hidden failures, missing metrics, and accidental duplicate transcodes are all high-friction events during a live service window.

**How to apply:**
All changes are in `artifacts/admin/src/pages/broadcast-v2.tsx` (UI) and `artifacts/api-server/src/modules/broadcast-v2/io/rest.routes.ts` (server). No schema changes required.
