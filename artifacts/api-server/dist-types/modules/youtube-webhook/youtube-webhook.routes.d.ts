import type { FastifyInstance } from "fastify";
/**
 * Start the periodic webhook lease auto-renewal. Safe to call multiple times —
 * subsequent calls are no-ops if the timer is already running.
 *
 * @param baseUrl  The same baseUrl passed to `subscribeToYouTubePubSubHubbub`.
 */
export declare function startWebhookAutoRenewal(baseUrl: string): void;
/**
 * Subscribe to YouTube's PubSubHubbub hub.
 * Called once on server startup from app.ts after the server is ready.
 * Fire-and-forget — subscription failure does not block startup.
 *
 * @param baseUrl  The publicly-reachable base URL of this server,
 *                 e.g. "https://api.templetv.org.ng".
 *                 Must NOT have a trailing slash.
 */
export declare function subscribeToYouTubePubSubHubbub(baseUrl: string): Promise<void>;
export declare function youtubeWebhookRoutes(app: FastifyInstance): Promise<void>;
