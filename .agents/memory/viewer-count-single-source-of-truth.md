---
name: Viewer count single source of truth
description: How the dual viewer-counting systems were unified; read before touching viewer counts, ws.gateway.ts, sse.gateway.ts, or viewer-tracking.service.ts.
---

Previously two independent viewer-counting systems existed: a raw in-memory
socket counter (`realtime/viewer-tracker.ts`, wsCount+sseCount) that wrote
directly to `broadcastEngine.setViewerCount()`, and a fully-built Redis-backed
heartbeat/dedup service (`viewer-tracking.service.ts`) that no client ever
called — so it was accurate but empty, while the raw counter was live but
double-counted reconnects/tabs.

**Fix:** `realtime/viewer-tracker.ts` was deleted. `ws.gateway.ts`,
`realtime/sse.gateway.ts`, and the legacy SSE endpoint in
`broadcast/broadcast.routes.ts` now each auto-register a heartbeat session
with `viewerTrackingService` on connect (random sessionId, streamId =
`broadcastEngine.channelId`), refresh it every 10s (must stay under
`VIEWER_TRACKING_SESSION_TTL_S`, default 25s), and call
`viewerTrackingService.leave()` on cleanup. `viewerTrackingService`'s
`_maybeNotifyAdmin` now unconditionally bridges the deduped count into
`broadcastEngine.setViewerCount()` for the primary channel, so every existing
consumer (admin ops routes, health routes, SSE `viewer-count` event) reads the
corrected number automatically.

**Why:** the client-side apps (mobile/TV/admin) never needed to change —
wiring the heartbeat at the gateway level (piggybacking on each gateway's
existing ping/heartbeat interval) is far more robust than depending on every
client to correctly call a heartbeat endpoint.

**How to apply:** any new realtime transport (another WS/SSE endpoint) that
represents "a viewer watching the broadcast" must register/refresh/leave a
`viewerTrackingService` session the same way. Never write to
`broadcastEngine.setViewerCount()` from anywhere else — there must be exactly
one writer (the bridge inside `viewerTrackingService`) or counts will race.
