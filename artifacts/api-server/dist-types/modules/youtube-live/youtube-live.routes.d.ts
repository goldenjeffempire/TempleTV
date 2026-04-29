import type { FastifyInstance } from "fastify";
/**
 * YouTube live event stream — SSE channel the admin Live Monitor page
 * subscribes to for real-time YT poller state changes (live/offline,
 * viewer count, detection-method changes).
 *
 * The underlying YouTube live-poller subsystem is in a deliberately
 * skipped phase, so this gateway:
 *   - Holds the SSE connection open with proper headers and a 25s
 *     keep-alive so the admin's `EventSource` doesn't churn.
 *   - Emits a single `state: disabled` event on connect so the page
 *     can render a clean "poller off" badge instead of spinning.
 *   - Never emits further events.
 *
 * When the YT poller lands, this handler will pipe its EventEmitter
 * out the SSE stream the same way `sse.gateway.ts` pipes the
 * broadcast engine.
 */
export declare function youtubeLiveRoutes(app: FastifyInstance): Promise<void>;
