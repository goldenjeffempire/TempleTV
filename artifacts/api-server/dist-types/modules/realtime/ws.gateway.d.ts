import type { FastifyInstance } from "fastify";
/**
 * WebSocket gateway. Bidirectional channel for clients that prefer WS
 * over SSE (mobile native, smart-TV apps).
 *
 * Outbound: same `BroadcastEvent` stream as the SSE gateway.
 * Inbound: `{ type: "ping" }` — respond `{ type: "pong" }` to keep
 *          the connection alive and to maintain accurate viewer counts.
 */
export declare function wsRoutes(app: FastifyInstance): Promise<void>;
