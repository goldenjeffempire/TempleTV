import type { FastifyInstance } from "fastify";
/**
 * WebSocket gateway. Bidirectional channel for clients that prefer WS
 * over SSE (mobile native, smart-TV apps).
 *
 * Outbound: `BroadcastEvent` stream + override-change notifications +
 *           OMEGA typed signals (PROGRAM_CHANGED, STREAM_FAILED, etc.).
 * Inbound: `{ type: "ping" }` — respond `{ type: "pong" }` to keep
 *          the connection alive and to maintain accurate viewer counts.
 *
 * Viewer counting is delegated to `viewer-tracker.ts` which combines
 * WS + SSE counts and feeds the sum into the broadcast engine.
 */
export declare function wsRoutes(app: FastifyInstance): Promise<void>;
