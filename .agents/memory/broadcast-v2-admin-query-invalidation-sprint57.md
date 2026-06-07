---
name: Broadcast-v2 admin query invalidation audit sprint 57
description: 12 fixes across admin SSE handlers, REST endpoints, and a shutdown timer unref — remediation-report and transcoding-panel invalidation gaps, cross-client bus event gaps, Vite HMR incompatibility.
---

## Fixes applied

**Admin SSE handler invalidation gaps (broadcast-v2.tsx):**
- `transcoding-update` was missing `["broadcast-v2-transcoding-panel"]` invalidation — the panel went stale for up to 30 s after every job state change (queued→encoding→hls_ready), the most-used realtime panel.
- `broadcast-queue-updated` was missing `["broadcast-v2-remediation-report"]` invalidation — queue mutations (reprobe, transcode-remote, deactivate) didn't flush the 60 s server-side cache immediately.
- `dead-air-escalation` was missing `["broadcast-v2-remediation-report"]` invalidation — auto-suspend triggered by dead-air cycles left stale health data.
- `broadcast-v2-stall` with `autoSuspended=true` was missing `["broadcast-v2-remediation-report"]` invalidation.
- `broadcast-v2-queue-issues` was missing `["broadcast-v2-remediation-report"]` invalidation — same issue categories as the remediation report.

**Admin mutation onSuccess invalidation gaps:**
- `retryHlsMutation.onSuccess` was missing `["broadcast-v2-remediation-report"]`.
- `transcodeLocallyMutation.onSuccess` was missing `["broadcast-v2-remediation-report"]`.
- `playNowMutation.onSuccess` was missing `["broadcast-v2-queue-sync-status"]`.

**REST endpoint cross-client bus event gaps (rest.routes.ts):**
- `POST /broadcast-v2/queue/:id/reprobe` — called `broadcastOrchestrator.reload()` but never pushed `adminEventBus.push("broadcast-queue-updated", ...)`. Other admin sessions saw the duration change only on their next poll (up to 60 s).
- `POST /broadcast-v2/queue/:id/transcode-remote` — missing both `adminEventBus.push("videos-library-updated", ...)` and `adminEventBus.push("broadcast-queue-updated", ...)`.

**Shutdown timer unref (queue-integrity-validator.ts):**
- `probeDurationFromUrl`: `proc.unref()` was present but the 45 s kill-timer `t` was not. During SIGTERM, the timer held the event loop alive for up to 45 s. Fix: `t.unref?.()` added after the `setTimeout` call.

**Vite Fast Refresh HMR incompatibility (sse-context.tsx / dashboard.tsx):**
- `useRecentActivity` exported from `sse-context.tsx` (a file that also exports `SSEProvider` component) broke Vite Fast Refresh, causing full-page reloads instead of HMR on every edit to that file. Fix: removed the export, inlined as `recentActivity: activity` destructure from `useSSE()` in dashboard.tsx (the only consumer).

## Rules
- **Every mutation onSuccess that changes item health/transcoding state must invalidate `["broadcast-v2-remediation-report"]`.** The server-side TTL is 60 s — without client-side invalidation, the panel shows stale data for a full minute after every operator action.
- **Every SSE event that represents a state change must invalidate ALL panels that reflect that state**, not just the primary one. Use the query invalidation matrix pattern.
- **Any REST endpoint that calls `broadcastOrchestrator.reload()` or writes to the broadcast queue must also push `adminEventBus.push("broadcast-queue-updated", ...)`.** Without the event push, other concurrent admin sessions miss the change until their next poll.
- **Files that export both React components (uppercase) and hooks/utilities must not mix them** — put hooks in separate files or inline them at the call site. Vite's Fast Refresh plugin invalidates the full module, not just the component, when a non-component export is present.
- **Always unref both the child process AND its kill-timer** in ffprobe/spawn wrappers: `proc.unref(); t.unref?.();`. Unreffing only one still holds the event loop open during graceful shutdown.
