import type { FastifyInstance } from "fastify";
/**
 * Force-close all open broadcast-v2 SSE connections.
 * Called during graceful shutdown before app.close() so the main.ts drain
 * loop can complete without waiting for the SHUTDOWN_DRAIN_MS timeout.
 */
export declare function closeAllSseSessions(): void;
/**
 * Broadcast a graceful-restart hint to all currently-connected SSE clients
 * WITHOUT closing the connections.  Called by main.ts immediately after
 * SIGTERM while the SHUTDOWN_PRECLOSE_DELAY_MS window is still open.
 *
 * Clients that receive this frame can schedule a reconnect timer for
 * `retryAfterMs` ms — cutting effective reconnect latency from the
 * 22 s dead-socket watchdog to a user-configured hint delay (typically
 * 5–15 s on production).
 */
export declare function broadcastReconnectHint(retryAfterMs: number): void;
export declare function getBroadcastV2SseViewerCount(): number;
export declare function sseRoutes(app: FastifyInstance): Promise<void>;
