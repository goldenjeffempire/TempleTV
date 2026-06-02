---
name: Broadcast polling reduction and WS zombie hardening
description: Admin polling intervals, playback WS zombie detection, YouTube quota SSE alerting — patterns and decisions.
---

## Rule: /api/playback/ws needs native ping + zombie termination

`playback.routes.ts` sends app-level JSON pings every 25 s but previously had no zombie detection. On half-open TCP (phone sleep, NAT drop), dangling event listeners for 4 buses (broadcastEngine, overrideBus, signalBus, adminEventBus) accumulated indefinitely.

**Fix pattern** (matches broadcast-v2/ws.gateway.ts):
- Track `lastPongAtMs = Date.now()` per socket
- In heartbeat: call `socket.ping()` (native WS) + check `Date.now() - lastPongAtMs > 60_000` → `socket.terminate()`
- Handle `socket.on("pong", ...)` for native pong + set `lastPongAtMs` on any message
- Cast: `(socket as { terminate?: () => void }).terminate?.()` since Fastify WS typing omits it

**Why:** broadcast-v2 WS gateway already had this; playback WS was the gap. TV/mobile clients connect here for queue state.

## Rule: Admin polling intervals — safe minimums with SSE coverage

All admin pages use TanStack Query + SSE invalidation. After audit (June 2026), safe polling minimums:

| Resource type | With SSE | Without SSE |
|---|---|---|
| Transcoding queue | 60 s | — |
| Chat messages | 90 s | — |
| Live viewer count | 30 s | — |
| Engine health | 30 s | 30 s |
| Admin stats | 60 s | — |
| Readyz/health | 60 s | — |
| Source health | 30 s (bad-URL TTL is 90 s) | — |
| Network status | 60 s | — |
| Diagnostics | 30 s | — |
| Live monitor | 30 s | — |

**Why:** Server-side rate limits (e.g. 30 req/min on `/broadcast-v2/health`, 8 conn/IP on SSE) are hit when 5+ admin tabs are open with 10 s polling. SSE already delivers real-time accuracy; polling is only a safety net for missed frames.

## Rule: YouTube quota warning — SSE push in trackQuota()

Two-tier threshold in `youtube-sync.service.ts → trackQuota()`:
- 80% → push `youtube-quota-warning` with `level: "warning"` (fires once per UTC day)
- 95% → push `youtube-quota-warning` with `level: "critical"` (fires once per UTC day)
- Flags `_quotaWarnFired` / `_quotaCritFired` reset on midnight roll-over

Frontend: `YouTubeQuotaMonitor` component in `App.tsx` renders inside `<SSEProvider>`, handles event with `useSSEEvent`, shows `toast.warning` / `toast.error` with `id` dedup so toasts don't stack.

**Why:** Previously operators only discovered quota exhaustion when sync silently fell back to RSS (last 15 videos only). With QUOTA_TOTAL=10000 and ~400 videos × 15-min sync, quota can exhaust mid-day.
