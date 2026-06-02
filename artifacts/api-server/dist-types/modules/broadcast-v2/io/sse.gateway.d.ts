import type { FastifyInstance } from "fastify";
/**
 * Force-close all open broadcast-v2 SSE connections.
 * Called during graceful shutdown before app.close() so the main.ts drain
 * loop can complete without waiting for the SHUTDOWN_DRAIN_MS timeout.
 */
export declare function closeAllSseSessions(): void;
export declare function sseRoutes(app: FastifyInstance): Promise<void>;
