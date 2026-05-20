import type { FastifyInstance } from "fastify";
/**
 * Exported so admin video mutation routes can proactively evict the
 * catalogue cache after any write. Bumps the generation counter so all
 * cached pages become stale on the next request without explicit key deletion.
 */
export declare function invalidateVideosCatalogCache(): Promise<void>;
export declare function videosRoutes(app: FastifyInstance): Promise<void>;
