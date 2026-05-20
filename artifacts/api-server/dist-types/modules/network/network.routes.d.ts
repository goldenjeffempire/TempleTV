/**
 * network.routes — OMEGA Control Plane
 *
 * Implements the Network Operations Center (NOC):
 *   POST /api/network/broadcast/command  — dispatch a broadcast command
 *   GET  /api/network/heartbeat          — encoder + stream + CDN + player health
 *   GET  /api/network/status             — full NOC dashboard state
 *
 * Commands (OMEGA CONTROL PLANE):
 *   GO_LIVE    — start a live override immediately
 *   SWITCH     — switch the active stream source
 *   SYNC       — force all viewers to resync position
 *   EMERGENCY  — interrupt everything with emergency broadcast
 *   FAILOVER   — manually trigger the failover chain
 *   LOCK       — lock broadcast state (prevents further changes)
 *   UNLOCK     — release broadcast lock
 *   STOP       — stop the active live override
 *
 * Transport: all commands that change state emit an OMEGA signal via
 * the signal bus, which the WS and SSE gateways fan out to every client.
 */
import type { FastifyInstance } from "fastify";
declare let broadcastLocked: boolean;
export declare function networkRoutes(app: FastifyInstance): Promise<void>;
export { broadcastLocked };
