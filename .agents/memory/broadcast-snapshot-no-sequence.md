---
name: BroadcastSnapshot has no sequence field
description: The v1 BroadcastSnapshot interface only has channelId/generatedAt/current/next/upcoming/preloadAt/failoverHlsUrl — no sequence.
---

## Rule
`BroadcastSnapshot` (defined in `lib/broadcast-types` and `modules/broadcast/queue.engine.ts`) does **not** have a `sequence` field. Using `snap.sequence` causes TS2339.

**Why:** The v1 broadcast engine tracks order via the queue position and `generatedAt` timestamp, not a monotonic counter. `sequence` is a v2 concept (`broadcastOrchestrator.snapshot()` returns a different shape).

**How to apply:**  
- For v1 guide ETags, encode `current?.id + next?.id`: `W/"g${snap.current?.id ?? "none"}-${snap.next?.id ?? "none"}"`.
- For v2 state ETags, cast: `(_stateCache.snap as { sequence?: number }).sequence ?? 0`.
- Never access `.sequence` directly on a typed `BroadcastSnapshot` variable.
