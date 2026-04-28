import type { FastifyInstance } from "fastify";
/**
 * Server-Sent Events stream for the live channel.
 *
 * One global engine → many connected clients. Each new client gets:
 *   1. An immediate `snapshot` event with the current state
 *   2. Every subsequent `snapshot | preload | advance | viewer-count`
 *
 * SSE is preferred over WebSocket here because it survives proxies/CDNs
 * cleanly and reconnects automatically in browsers.
 */
export declare function sseRoutes(app: FastifyInstance): Promise<void>;
