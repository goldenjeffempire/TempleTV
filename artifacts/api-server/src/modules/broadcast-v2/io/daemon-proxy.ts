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

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../../../infrastructure/logger.js";
import { env } from "../../../config/env.js";

/** Build the full daemon URL for a given absolute path. */
function daemonUrl(path: string): string {
  return `${env.BROADCAST_DAEMON_URL!.replace(/\/$/, "")}${path}`;
}

/** Forward selected safe client headers to the upstream daemon. */
function proxyRequestHeaders(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  const auth = req.headers["authorization"];
  if (typeof auth === "string") out["authorization"] = auth;
  const lastEventId = req.headers["last-event-id"];
  if (typeof lastEventId === "string") out["last-event-id"] = lastEventId;
  return out;
}

// ── SSE Proxy ────────────────────────────────────────────────────────────────

/**
 * Stream-proxy an SSE connection to the daemon.
 *
 * Opens a fetch() to the daemon's /events endpoint, then pipes the response
 * body (a ReadableStream of SSE chunks) directly to the client response.
 * The Last-Event-ID and lastSequence query-param are forwarded so the daemon
 * can replay missed frames on reconnect, giving clients seamless continuity
 * across API restarts.
 */
async function sseDaemonProxy(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const qs = req.query as Record<string, string>;
  const params = new URLSearchParams();
  if (qs["lastSequence"]) params.set("lastSequence", qs["lastSequence"]!);

  const targetUrl = daemonUrl(
    `/api/v1/broadcast-v2/events${params.size ? `?${params.toString()}` : ""}`,
  );

  const headers = proxyRequestHeaders(req);
  const abort = new AbortController();
  const onClose = () => abort.abort();
  req.raw.on("close", onClose);
  req.raw.on("error", onClose);

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(targetUrl, { headers, signal: abort.signal });
  } catch (err) {
    req.raw.off("close", onClose);
    req.raw.off("error", onClose);
    if ((err as { name?: string }).name !== "AbortError") {
      logger.warn({ err, targetUrl }, "[broadcast-daemon-proxy] SSE connect failed");
    }
    if (!reply.sent) reply.code(502).send({ error: "broadcast daemon unavailable" });
    return;
  }

  if (!upstreamRes.ok || !upstreamRes.body) {
    req.raw.off("close", onClose);
    req.raw.off("error", onClose);
    const status = upstreamRes.status;
    logger.warn({ status, targetUrl }, "[broadcast-daemon-proxy] SSE upstream returned error");
    if (!reply.sent) reply.code(502).send({ error: "broadcast daemon SSE error" });
    return;
  }

  // Commit SSE response headers before streaming — must happen before any write.
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Content-Encoding": "identity",
  });

  const reader = upstreamRes.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const ok = reply.raw.write(value);
      if (!ok) break; // client backpressure / disconnect
    }
  } catch (err) {
    if ((err as { name?: string }).name !== "AbortError") {
      logger.debug({ err }, "[broadcast-daemon-proxy] SSE pipe ended unexpectedly");
    }
  } finally {
    try { reader.cancel(); } catch { /* noop */ }
    req.raw.off("close", onClose);
    req.raw.off("error", onClose);
    try { reply.raw.end(); } catch { /* noop */ }
  }
}

// ── HTTP REST Proxy ───────────────────────────────────────────────────────────

/**
 * Generic HTTP proxy handler for all non-SSE broadcast-v2 REST routes.
 *
 * Forwards the request method, body, and auth headers to the daemon and
 * returns the daemon's status code + response body verbatim to the client.
 * No caching — every request is proxied in real time.
 */
async function httpDaemonProxy(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // req.url in Fastify is the *full* path including outer prefix scopes and any
  // query string (e.g. "/api/v1/broadcast-v2/state" or "/api/broadcast-v2/skip?reason=…").
  // Forward it verbatim so the daemon can resolve it against its own route table.
  const targetUrl = daemonUrl(req.url);

  const headers: Record<string, string> = {};
  Object.assign(headers, proxyRequestHeaders(req));
  if (req.body) headers["content-type"] = "application/json";

  const init: RequestInit = { method: req.method, headers };
  if (req.body && ["POST", "PUT", "PATCH"].includes(req.method)) {
    init.body = JSON.stringify(req.body);
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(targetUrl, init);
  } catch (err) {
    logger.warn({ err, targetUrl }, "[broadcast-daemon-proxy] REST forward failed");
    if (!reply.sent) reply.code(502).send({ error: "broadcast daemon unavailable" });
    return;
  }

  const body = await upstreamRes.text();
  reply.code(upstreamRes.status);
  const ct = upstreamRes.headers.get("content-type");
  if (ct) reply.header("content-type", ct);
  reply.send(body);
}

// ── Fastify Plugin ────────────────────────────────────────────────────────────

/**
 * Fastify plugin that replaces the live broadcastV2Routes with proxy routes.
 *
 * Mount under the SAME prefix as broadcastV2Routes would use ("/broadcast-v2"):
 *
 *   await instance.register(broadcastDaemonProxyRoutes, { prefix: "/broadcast-v2" });
 *
 * Route priority (Fastify evaluates in registration order):
 *   1. GET /events  → SSE streaming proxy
 *   2. GET|POST|… /* → generic HTTP proxy (catch-all wildcard)
 *
 * WebSocket (/ws) is NOT registered here — it is handled by the raw server
 * upgrade-event TCP proxy installed in app.ts. If the daemon is down, WS
 * clients will see a connection error and retry (normal WS reconnect behaviour).
 */
export async function broadcastDaemonProxyRoutes(app: FastifyInstance): Promise<void> {
  // SSE — streaming passthrough (must be registered before wildcard)
  app.get("/events", sseDaemonProxy);

  // REST catch-all — handles /state, /rehydrate, /skip, /override/*, /reload,
  // /force-failover, /clear-failover, /natural-end, /report-stall, /health,
  // /diagnostics, /autoheal/*, /queue/*, and everything else.
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
    const m = method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
    app[m]("/*", httpDaemonProxy);
    app[m]("/", httpDaemonProxy);
  }
}
