---
name: SSE zombie detection — all endpoints
description: Zombie detection pattern applied to all SSE endpoints; which endpoints use which pattern; shutdown closeAll wiring.
---

## Rule
Every SSE endpoint must have zombie detection (half-open TCP prevention) and be registered in the shutdown drain sequence.

**Why:** Half-open TCP keeps sockets alive indefinitely — Node never gets a "close" event. SSE bus listeners accumulate, EventEmitter MaxListeners warnings fire, RSS climbs, and the sseCounter drain loop at shutdown never completes.

## Endpoints and their patterns

| Endpoint | File | Pattern |
|---|---|---|
| `/api/broadcast-v2/events` | `broadcast-v2/io/sse.gateway.ts` | writeStallCount ≥ 3 consecutive write()→false → close |
| `/api/v1/channel/events` (realtime) | `realtime/sse.gateway.ts` | lastWriteOkMs + zombieCheck (30s/90s) |
| `/api/broadcast/events` (v1) | `broadcast/broadcast.routes.ts` | lastBcastSseWriteOkMs + zombieCheck (30s/90s) |
| `/api/admin-ops/events` | `admin-ops/admin-ops.routes.ts` | lastAdminSseWriteOkMs + zombieCheck (30s/90s) |
| `/api/graphics/events` | `graphics/graphics.routes.ts` | lastGraphicsSseWriteOkMs + zombieCheck (30s/90s) |
| `/api/midnight-prayers/events` | `midnight-prayers/midnight-prayers.routes.ts` | lastMpSseWriteOkMs + zombieCheck; destroy() to unblock the await-Promise |
| `/api/youtube-live/events` | `youtube-live/youtube-live.routes.ts` | lastYtLiveSseWriteOkMs + zombieCheck (30s/90s) |

## Standard pattern

```ts
let lastXxxSseWriteOkMs = Date.now();
const send = (...) => {
  try {
    const ok = reply.raw.write(`event: ...\ndata: ...\n\n`);
    if (ok) lastXxxSseWriteOkMs = Date.now();
  } catch { /* client gone */ }
};

// heartbeat also updates lastXxxSseWriteOkMs

const zombieCheck = setInterval(() => {
  const idleMs = Date.now() - lastXxxSseWriteOkMs;
  const writable = !reply.raw.socket?.destroyed && reply.raw.socket?.writable;
  if (!writable || idleMs > 90_000) cleanup();
}, 30_000);
zombieCheck.unref?.();

let xxxSseClosed = false;
const cleanup = () => {
  if (xxxSseClosed) return;
  xxxSseClosed = true;
  openXxxSseCleanups.delete(cleanup);
  clearInterval(heartbeat);
  clearInterval(zombieCheck);
  // ... remove bus listeners ...
  try { reply.raw.end(); } catch { /* ignore */ }
};
openXxxSseCleanups.add(cleanup);
req.raw.on("close", cleanup);
req.raw.on("error", cleanup);
```

## midnight-prayers special case
The handler uses `await new Promise<void>((resolve) => { req.raw.on("close", resolve); })` to keep the Fastify handler alive. Zombie detection must call `reply.raw.destroy()` (not `cleanup()`) so the "close" event fires and unblocks the Promise. The mpCleanup is registered on "close" so it runs after destroy fires.

## Shutdown wiring in main.ts

All six closeAll functions are called during shutdown (before the sseCounter drain loop):
- `closeAllBroadcastSseSessions()` — v1 broadcast
- `closeAllRealtimeSseSessions()` — realtime
- `closeAllAdminSseSessions()` — admin-ops
- `closeAllGraphicsSseSessions()` — graphics
- `closeAllMidnightPrayersSseSessions()` — midnight-prayers
- `closeAllYoutubeLiveSseSessions()` — youtube-live

Note: graphics, midnight-prayers, youtube-live do NOT increment sseCounter — they are closed explicitly before the drain loop so the loop completes in O(ms).

## How to apply
Any new SSE endpoint must: (1) use the standard pattern above, (2) export a closeAllXxxSseSessions(), (3) wire that export into the shutdown sequence in main.ts, (4) decide whether to track in sseCounter (use it if the endpoint is a high-traffic consumer surface; skip it for low-volume admin/ops endpoints that are closed explicitly).
