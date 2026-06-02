import type { FastifyInstance } from "fastify";
import { broadcastOrchestrator } from "./engine/broadcast-orchestrator.js";
import { broadcastFanout } from "./io/broadcast-fanout.js";
/**
 * Broadcast v2 — server-authoritative streaming control plane.
 *
 * Mount under `/broadcast-v2` (in app.ts). Provides:
 *   - REST: GET /state, GET /rehydrate, POST /skip, /override/start|stop, /force-failover, /clear-failover, /reload
 *   - SSE:  GET /events
 *   - WS:   GET /ws
 *
 * Coexists with the v1 broadcast module until the cut-over (T008).
 */
export declare function broadcastV2Routes(app: FastifyInstance): Promise<void>;
/**
 * /health-visible bootstrap status. Lets external monitors and the
 * operator distinguish "bridge installed but start() throwing" from
 * "neither was ever attempted" — both surface as `sequence: 0` on
 * the snapshot endpoint without this.
 */
export declare function getBroadcastV2BootStatus(): {
    started: boolean;
    busBridgeInstalled: boolean;
    startAttempts: number;
    lastStartError: string | null;
    lastStartAttemptAtMs: number | null;
};
export declare function ensureBroadcastV2Started(): Promise<void>;
/**
 * Graceful shutdown for the broadcast-v2 module.
 *
 * Order of operations matters:
 *  1. Cancel pending boot/fanout retry timers so they never fire after
 *     shutdown begins (prevents a re-init race during app.close()).
 *  2. Force-close all open SSE streams so main.ts drain loop completes
 *     promptly (each connection is in sseCounter — ending them decrements
 *     the counter so the drain loop exits cleanly instead of timing out).
 *  3. Stop all supervised workers (media-scanner, orphan-cleanup,
 *     queue-validator, faststart-recovery, viewer-count-updater) — each
 *     runs on a timer and may hold open DB connections.
 *  4. Stop the orchestrator — clears its 7 internal timers (tick,
 *     checkpoint, trim, keepAlive, selfHealEmpty, selfHealStale,
 *     currentItemProbe) so the event loop can drain.
 *  5. Flush the final checkpoint so restarts resume from the exact
 *     playback position rather than the last periodic boundary.
 *  6. Close the Redis fan-out subscriber and leader renewal timer.
 *
 * Called from main.ts shutdown handler before app.close().
 */
export declare function stopBroadcastV2(): Promise<void>;
export { broadcastOrchestrator, broadcastFanout };
