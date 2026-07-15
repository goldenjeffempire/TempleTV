---
name: Replit deployment SHUTDOWN_PRECLOSE_DELAY_MS parity gap
description: .replit's [deployment] run command was missing SHUTDOWN_PRECLOSE_DELAY_MS (defaulted to 0) while render.yaml (real prod) already set it to 10000; fixed via deployConfig for parity.
---

## Finding
Real production runs on Render (render.yaml, RUN_MODE=all single free-tier instance — no separate daemon service, since Render has no free-tier worker plan). Render already sets `SHUTDOWN_PRECLOSE_DELAY_MS=10000`, `SHUTDOWN_DRAIN_MS=10000`, `SHUTDOWN_FORCE_EXIT_BUDGET_MS=28000`, and `BROADCAST_DEADAIR_FALLBACK_URL` — a fully-tuned graceful-shutdown + dead-air story.

Replit's own `.replit` `[deployment]` run command (used if the user publishes via Replit instead of/alongside Render) only set `SHUTDOWN_DRAIN_MS=10000` and omitted `SHUTDOWN_PRECLOSE_DELAY_MS`, which defaults to 0. This meant the graceful-restart reconnect hint (SSE/WS "reconnect" frame, consumed by `lib/player-core/src/transport.ts`) fired but had ~0ms to actually reach connected clients before the process began tearing down sockets on a Replit-published redeploy.

**Why:** `main.ts` broadcasts the reconnect hint to clients, THEN waits `SHUTDOWN_PRECLOSE_DELAY_MS` before closing anything — with 0ms, hard closure follows almost immediately, so most clients miss the graceful hint and fall back to the slower ~22s dead-socket-watchdog reconnect path instead of the fast hinted reconnect.

**How to apply:** Fixed by adding `SHUTDOWN_PRECLOSE_DELAY_MS=5000` to the Replit deployment run command via `deployConfig()` (matching Render's proven value order-of-magnitude). Don't add this to *dev* workflow run commands — dev workflow restarts should stay instant (0ms) per existing code comment.

## Broader context (verified already fully implemented, no further action needed)
Every other layer of the broadcast-continuity requirement set was already implemented and confirmed present in code during a full audit (daemon/API split, 5s checkpoint interval + event-driven bump(), hydrate()-from-checkpoint exact-timestamp resume, SSE/WS/REST daemon-proxy retry+buffering, restart-log table, daemon liveness monitor, yt-shuffle state persistence, no worker-supervisor overlap between RUN_MODE=all and RUN_MODE=broadcast, client-side "reconnect" hint handling in player-core mirrored to mobile vendor). See `broadcast-continuity-fixes.md`, `broadcast-deployment-resilience.md`, `broadcast-daemon-architecture.md` for full detail — this file only documents the one net-new gap found and closed.
</content>
