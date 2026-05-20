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
 * Closes the Redis fan-out subscriber and stops the leader renewal timer.
 * Called from main.ts shutdown handler.
 */
export declare function stopBroadcastV2(): Promise<void>;
export { broadcastOrchestrator, broadcastFanout };
