/**
 * Broadcast Daemon Proxy
 *
 * When BROADCAST_DAEMON_URL is configured, the API server proxies all
 * broadcast-v2 traffic (SSE, REST) to the long-lived broadcast daemon process
 * instead of handling it locally. This decouples API deployments from the
 * broadcast engine — the daemon keeps running while the API restarts, so
 * there is zero broadcast interruption during deployments.
 *
 * Proxy strategy:
 *   SSE  (/events)  — streaming fetch pipe: preserves chunked text/event-stream
 *   REST (all else)  — simple fetch() round-trip, forwards status + body verbatim
 *
 * WebSocket (/ws) is handled at the raw server upgrade-event level in app.ts
 * (TCP-level proxy via net.createConnection) so it is NOT registered here.
 *
 * The daemon is expected at BROADCAST_DAEMON_URL (default http://127.0.0.1:9000).
 * It is internal-only — never exposed to the public internet.
 */
import type { FastifyInstance } from "fastify";
/**
 * Fastify plugin that replaces the live broadcastV2Routes with proxy routes.
 *
 * Mount under the SAME prefix as broadcastV2Routes would use ("/broadcast-v2"):
 *
 *   await instance.register(broadcastDaemonProxyRoutes, { prefix: "/broadcast-v2" });
 *
 * Route priority (Fastify evaluates static/exact routes before wildcards
 * regardless of registration order, but /ws is listed first for clarity):
 *   1. GET /ws      → WebSocket proxy (real `ws` client to the daemon)
 *   2. GET /events  → SSE streaming proxy
 *   3. GET|POST|… /* → generic HTTP proxy (catch-all wildcard)
 */
export declare function broadcastDaemonProxyRoutes(app: FastifyInstance): Promise<void>;
