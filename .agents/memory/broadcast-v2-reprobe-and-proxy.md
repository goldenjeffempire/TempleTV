---
name: Broadcast-v2 reprobe endpoint & Vite proxy completeness
description: Schema gotcha when writing duration to managed_videos; Vite proxy rules required for broadcast-v2 SSE/WS to work reliably in dev.
---

## managed_videos.duration is text, not integer

`videosTable` (managed_videos) stores duration as `duration: text("duration")` — a string like "1800" or "3723" (seconds as a string). It does NOT have a `durationSecs` column. When writing ffprobe-derived duration to managed_videos, use `{ duration: String(roundedSecs) }`.

The `broadcastQueueTable` (broadcast_queue) uses `durationSecs: integer("duration_secs")` — integer, not text.

**Why:** The two tables evolved separately. `broadcast_queue` was purpose-built for the v2 orchestrator and got an integer; `managed_videos` inherited a text column from the original YouTube-sync era that stores YouTube's ISO 8601 duration or a raw seconds string.

**How to apply:** Any code that probes a video duration and writes it to both tables must use two different field names and types.

## Vite dev proxy rules required for broadcast-v2

The generic `/api` catch-all proxy has no explicit timeout configuration. Without specific rules, broadcast-v2 streaming connections get disconnected in dev:

- `/api/broadcast-v2/events` — SSE stream needs `timeout: 0, proxyTimeout: 0` (same as other SSE endpoints)
- `/api/broadcast-v2/ws` — WebSocket needs explicit `ws: true` rule
- `/api/broadcast-v2/queue` — reprobe endpoint spawns ffprobe (45 s), add `timeout: 60_000, proxyTimeout: 60_000`

These rules MUST appear before the generic `/api` catch-all in `artifacts/admin/vite.config.ts`.

**Why:** Vite's http-proxy default timeout is short (~2 min but idle), and SSE connections look idle (no data until an event fires). Without `timeout: 0` the proxy closes the event stream.
