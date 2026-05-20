import type { FastifyInstance } from "fastify";
/**
 * YouTube live event stream — SSE channel the admin Live Monitor page
 * subscribes to for real-time YT poller state changes (live/offline,
 * viewer count, detection-method changes).
 *
 * The poller is started on first SSE connection (lazy init) and stays
 * running for the lifetime of the process. GET / and GET /status return
 * the current cached state; GET /events streams state-change events.
 */
export declare function youtubeLiveRoutes(app: FastifyInstance): Promise<void>;
