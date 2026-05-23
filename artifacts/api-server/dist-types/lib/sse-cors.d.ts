import type { FastifyRequest } from "fastify";
/**
 * SSE handlers call reply.raw.writeHead() directly, which bypasses Fastify's
 * CORS plugin. This helper computes the CORS headers that should be injected
 * into writeHead() so browsers can read the event stream.
 *
 * Mirrors the same origin logic as the CORS plugin in app.ts:
 *  - CORS_ORIGINS="*" (default) → reflect the request Origin header
 *  - Specific list               → only reflect if origin is in the list
 *    (merged with CORS_ORIGINS_EXTRA — see note below)
 *  - No Origin header            → no CORS headers added
 *
 * MUST mirror app.ts's CORS allowlist construction exactly, including the
 * CORS_ORIGINS_EXTRA merge. The Fastify CORS plugin handles preflight
 * (OPTIONS) responses using the merged list, but the SSE GET response is
 * written via reply.raw.writeHead() and bypasses that plugin entirely. If
 * this helper falls out of sync with app.ts the symptom is:
 *   • preflight OPTIONS → 204 with Access-Control-Allow-Origin (passes)
 *   • SSE GET           → 200 without Access-Control-Allow-Origin
 *   • browser blocks the EventSource at the CORS layer, fires `error`
 *     immediately, admin/TV stuck in "Reconnecting" forever
 *   • curl works (no CORS enforcement) so the bug looks invisible server-side
 * Triggered most visibly when CORS_ORIGINS_EXTRA carries the Render
 * auto-generated *.onrender.com wildcard and the dashboard CORS_ORIGINS only
 * lists the operator custom domains.
 */
export declare function sseCorsHeaders(req: FastifyRequest): Record<string, string>;
