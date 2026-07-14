---
name: Broadcast continuity — all fixes applied
description: Complete set of fixes for seamless 24/7 broadcast through daemon restarts, API deployments, and crashes. Covers all 6 layers.
---

## Summary
Six-layer fix for seamless broadcast continuity through daemon restarts, API-only deployments, and crashes.

## Fix 1: Daemon/API process split (pre-existing)
- Broadcast Daemon (RUN_MODE=broadcast, port 9000) — permanent process, owns broadcast engine
- API (RUN_MODE=all, BROADCAST_DAEMON_URL=http://127.0.0.1:9000, port 8080) — proxy-only
- API restarts don't interrupt broadcast at all; only daemon restarts matter for continuity

## Fix 2: Checkpoint interval 15s → 5s
- File: `artifacts/api-server/src/modules/broadcast-v2/engine/broadcast-orchestrator.ts`
- `CHECKPOINT_INTERVAL_MS = 5_000` (was 15_000)
- Worst-case position loss on ungraceful crash: 5s (was 15s)
- `bump()` also triggers immediate persist on every state transition (item advance, override start/end)

## Fix 3: Resilient SSE proxy (pre-existing + already correct)
- `daemon-proxy.ts`: `sseDaemonProxy` retries daemon for 30s before failing
- Sends `: daemon reconnecting` SSE comments every 2s to keep client alive
- If daemon recovers within 30s, stream is piped transparently — invisible to viewers

## Fix 4: WebSocket proxy reconnect (newly fixed)
- File: `artifacts/api-server/src/modules/broadcast-v2/io/daemon-proxy.ts`
- `wsDaemonProxyHandler` now retries upstream WS for up to 30s when it drops
- Client WS is kept alive; buffered messages (cap 64) are replayed on reconnect
- Previously: upstream drop = immediate client close (1011 error)

## Fix 5: REST proxy retry (newly fixed)
- File: `artifacts/api-server/src/modules/broadcast-v2/io/daemon-proxy.ts`
- `httpDaemonProxy` retries 3×, 600ms×attempt backoff, 5s per-attempt timeout
- Admin operations during daemon restart return success instead of 502

## Fix 6: Boot-time YouTube shuffle fast-path (newly fixed — most impactful)
- File: `artifacts/api-server/src/modules/broadcast-v2/engine/broadcast-orchestrator.ts`
- At end of `start()`: if `items.length === 0 && !YOUTUBE_SHUFFLE_FALLBACK_DISABLE`, fire yt-shuffle `activate()` after 250ms (warm restart with hydrated state) or 500ms (cold start)
- File: `artifacts/api-server/src/modules/broadcast-v2/engine/youtube-shuffle-fallback.ts`
- Added `get hasHydratedState(): boolean` getter so orchestrator can distinguish warm vs cold restart
- `EMPTY_POLLS_BEFORE_LIBRARY_SCAN` reduced 6→2 for cold-start fallback (10s instead of 30s)

**Why:** Previously dead-air was 75s after daemon restart (YouTube-only deployment). After fix: 9ms.

## Verified results (from daemon logs after fix)
- Dead-air window on restart: **9ms** (was 75s)
- `resumeSource: "checkpoint"` ✓ (not cold_start)
- `resumeSeconds: 577` — exact timestamp restoration (9m37s into video, not 0:00)
- `[yt-shuffle] RESUMED after restart — same video continues from its last known position`

## Shutdown sequence (confirmed correct, no changes needed)
`daemonShutdown()` → `stopBroadcastV2()` → `flushCheckpointForShutdown()` → `daemonApp.close()` → `closeDb()` → `process.exit(0)`
The checkpoint IS flushed BEFORE Fastify server close and DB close. Correct order.

## yt-shuffle state persistence (confirmed working pre-existing)
- `yt_shuffle_state` JSONB column in `broadcast_runtime_state` table
- Saves: `playlist`, `playlistIndex`, `currentVideoId`, `currentVideoStartedAtMs`, `activatedAtMs`
- `persistState()` called on every activate/advance
- `tryResumeFromHydratedState()` restores exact video + elapsed position
- Embeddability re-verified on resume (YouTube can flip is_embeddable between saves)

**Why the fast-path matters:** `_hydratedState` was already loaded at boot but sat unused for 75s waiting for the empty-poll cycle. Fast-path collapses this to 250ms.
