import type { FastifyInstance } from "fastify";
import { makeHlsToken } from "../../shared/hls-token.js";
/**
 * Trim the HLS segment in-process LRU cache to at most `targetMb` MB of
 * Buffer memory.  Returns bytes freed.  Safe to call from the memory watchdog
 * even if the cache has not yet been initialised (returns 0 in that case).
 * The freed Buffers become eligible for GC on the next collection cycle.
 */
export declare function trimHlsSegmentCache(targetMb: number): number;
export { makeHlsToken };
export declare function videoServeRoutes(app: FastifyInstance): Promise<void>;
