---
name: Comprehensive platform audit sprint 60
description: 7 bugs fixed across admin broadcast-v2 page, TV ChatClient, and TV App error boundaries.
---

## realtimeStallCount double-counting
**Rule:** When an SSE stall event fires, it increments `realtimeStallCount` AND immediately invalidates `broadcast-v2-diagnostics`. When diagnostics refetches, the server-side `eventCounts["stall"]` now includes those same stalls — adding them again creates double-counting in StreamQualityPanel.

**Fix:** Track `prevDiagStallRef` (last seen server-side stall count). In a `useEffect` on `diagnostics`, subtract the delta from `realtimeStallCount` — `Math.max(0, n - delta)`. This means `realtimeStallCount` only holds stalls that occurred AFTER the last diagnostics snapshot.

**Why:** Without this, every stall shows twice in the grade calculation — stall rate inflated, grade degraded unnecessarily.

**How to apply:** Any live counter augmenting a periodically-refetched server count needs this drain pattern. The server count is authoritative; the live counter only covers the gap until the next server fetch.

## reorderInFlightRef — SSE order clobber during debounce
**Rule:** After `handleDragEnd`, `isDraggingRef.current` is set to `false` immediately but the debounced reorder mutation doesn't fire for 250ms. During this window, an SSE `broadcast-queue-updated` event causes `queueData` to update, triggering the `useEffect` that resets `localOrder` from server state — discarding the user's drag.

**Fix:** Add `reorderInFlightRef = useRef(false)`. Set it to `true` in `handleDragEnd` before the debounce timer. Clear it in mutation `onSuccess` and `onError`. Guard the `useEffect` with `!isDraggingRef.current && !reorderInFlightRef.current`.

**Why:** Without this, any broadcast active enough to fire SSE every ~2s will regularly clobber the operator's drag-reorder before the save completes.

## broadcast-schedule-updated SSE event was never subscribed to
The event was registered in `KNOWN_EVENTS` and fired server-side when schedule batch edits are saved, but no page had a `useSSEEvent("broadcast-schedule-updated", ...)` handler. Operators who saved a schedule would not see the queue update until the next 15s poll.

**Fix:** Add `useSSEEvent("broadcast-schedule-updated", ...)` in `broadcast-v2.tsx` invalidating `broadcast-queue` and `broadcast-v2-diagnostics`.

**Pattern:** Whenever a new SSE event is added to KNOWN_EVENTS, immediately add a matching subscription somewhere — an unsubscribed event is dead infrastructure.

## TV ChatClient.ts window.location.host → resolveApiOrigin()
`buildUrl()` used `window.location.host` to construct the WebSocket URL. On packaged TV apps (Samsung Tizen, LG webOS, Amazon FireTV) loaded via `file://`, `window.location.host` returns `""` or `"null"`, producing `ws:///api/chat/ws` — a valid-looking but completely broken URL. The WebSocket connection silently fails with a connection error.

**Fix:** Import `resolveApiOrigin()` from `../lib/api` and use it in `buildUrl()`. `resolveApiOrigin()` already handles the `file://` case by falling back to `https://api.templetv.org.ng` in production, and respects `VITE_API_URL` at build time.

**Why:** Every other TV module (LiveBroadcastV2, useEmergencyAlerts, useLiveSync) already uses `resolveApiOrigin()`. ChatClient.ts was the only outlier — likely copy-pasted from admin before the TV-specific resolver existed.

## TV OnAirOverlays outside ErrorBoundary
`<OnAirOverlays />` was rendered inside the screen `<div>` but outside any per-page ErrorBoundary. A crash in `useOnAirGraphics()` or `useEmergencyAlerts()` (e.g., malformed SSE payload, bad server response) would propagate to the outermost `<ErrorBoundary>` — tearing down `ConnectivityBanner`, `PipIndicator`, and `AuthGateModal` along with it.

**Fix:** Wrap `<OnAirOverlays />` in its own `<ErrorBoundary>`. A crash in graphics/alert hooks removes overlays silently, leaving the player and navigation intact.

## Mutation → remediation-report invalidation matrix
Any mutation that changes queue item state should also invalidate `broadcast-v2-remediation-report`:
- `syncLibraryMutation`: newly enqueued items may have source/transcoding issues immediately
- `reorderMutation`: order changes can resolve or introduce sequencing warnings
- `transcoding-update` SSE in `TranscodingProgressPanel`: `hls_ready` resolves "Missing HLS" alerts
- `transcoding-update` SSE in main page handler: same — added in Sprint 60

The remediation-report has a 60s server-side cache. Without client invalidation, operators see stale alerts for up to 60s after the underlying issue is resolved.
