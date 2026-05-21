import type { FastifyRequest } from "fastify";
/**
 * SSE handlers call reply.raw.writeHead() directly, which bypasses Fastify's
 * CORS plugin. This helper computes the CORS headers that should be injected
 * into writeHead() so browsers can read the event stream.
 *
 * Mirrors the same origin logic as the CORS plugin in app.ts:
 *  - CORS_ORIGINS="*" (default) → reflect the request Origin header
 *  - Specific list               → only reflect if origin is in the list
 *  - No Origin header            → no CORS headers added
 */
export declare function sseCorsHeaders(req: FastifyRequest): Record<string, string>;
