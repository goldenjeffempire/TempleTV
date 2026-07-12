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
import WebSocket from "ws";
import type { RawData } from "ws";
import { logger } from "../../../infrastructure/logger.js";
import { env } from "../../../config/env.js";
import { startDaemonLivenessMonitor, stopDaemonLivenessMonitor } from "../engine/daemon-liveness-monitor.js";

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

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no",
  "Content-Encoding": "identity",
} as const;

// How long to retry a daemon connection before giving up (daemon restart window)
const SSE_RETRY_MAX_MS = 30_000;
// Interval between retry attempts
const SSE_RETRY_INTERVAL_MS = 2_000;
// Per-probe connect timeout
const SSE_PROBE_TIMEOUT_MS = 5_000;

/**
 * Stream-proxy an SSE connection to the daemon, with resilient retry.
 *
 * When the daemon is temporarily unreachable (crash, restart, rolling deploy):
 *   1. Commit SSE headers immediately to keep the client connection alive.
 *   2. Send `:keepalive` SSE comments every 2 s while retrying.
 *   3. Retry the daemon connection for up to 30 s (covers typical restart time).
 *   4. If the daemon recovers within the window, pipe the new stream transparently.
 *   5. If still unavailable after 30 s, send a `reconnect` frame and close.
 *
 * This makes daemon restarts invisible to viewers in most cases — no blank
 * screen, no loading spinner — instead of the immediate 502 that the naive
 * passthrough would return.
 */
async function sseDaemonProxy(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const qs = req.query as Record<string, string>;
  const params = new URLSearchParams();
  if (qs["lastSequence"]) params.set("lastSequence", qs["lastSequence"]!);

  const targetUrl = daemonUrl(
    `/api/v1/broadcast-v2/events${params.size ? `?${params.toString()}` : ""}`,
  );

  const headers = proxyRequestHeaders(req);

  // clientAbort fires when the client disconnects — aborts all pending retries
  const clientAbort = new AbortController();
  const onClientClose = () => clientAbort.abort();
  req.raw.on("close", onClientClose);
  req.raw.on("error", onClientClose);

  const retryDeadline = Date.now() + SSE_RETRY_MAX_MS;
  let headersWritten = false;
  let upstreamRes: Response | null = null;

  // Commit SSE response headers exactly once. Returns false if the write fails
  // (client gone), in which case the caller should bail out immediately.
  function ensureHeaders(): boolean {
    if (headersWritten) return true;
    headersWritten = true;
    try {
      reply.raw.writeHead(200, SSE_HEADERS);
      return true;
    } catch {
      return false;
    }
  }

  // Try to connect to the daemon, retrying until connected or deadline reached.
  while (!clientAbort.signal.aborted) {
    // Each probe has its own short timeout, linked to the client abort signal.
    const probeAbort = new AbortController();
    const probeTimeout = setTimeout(() => probeAbort.abort(), SSE_PROBE_TIMEOUT_MS);
    const onClientAbort = () => probeAbort.abort();
    clientAbort.signal.addEventListener("abort", onClientAbort, { once: true });

    try {
      upstreamRes = await fetch(targetUrl, { headers, signal: probeAbort.signal });
    } catch {
      upstreamRes = null;
    } finally {
      clearTimeout(probeTimeout);
      clientAbort.signal.removeEventListener("abort", onClientAbort);
    }

    if (upstreamRes?.ok && upstreamRes.body) break; // Connected!
    upstreamRes = null;

    if (clientAbort.signal.aborted) break;
    if (Date.now() >= retryDeadline) break;

    // First failure: commit SSE headers so the client connection stays open.
    if (!ensureHeaders()) break;

    // Send an SSE comment to prevent proxy/browser keepalive timeout.
    try {
      reply.raw.write(": daemon reconnecting\n\n");
    } catch {
      break; // Client disconnected during write
    }

    // Wait before the next retry, interruptible by client disconnect.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, SSE_RETRY_INTERVAL_MS);
      clientAbort.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  // Unregister client-close listeners before piping or closing.
  req.raw.off("close", onClientClose);
  req.raw.off("error", onClientClose);

  if (!upstreamRes || !upstreamRes.body) {
    // Daemon still unavailable after retry window.
    if (headersWritten) {
      // Tell connected clients to reconnect after a short delay.
      try {
        reply.raw.write(`data: ${JSON.stringify({ type: "reconnect", retryAfterMs: 5_000 })}\n\n`);
        reply.raw.end();
      } catch { /* noop */ }
    } else if (!reply.sent) {
      logger.warn({ targetUrl }, "[broadcast-daemon-proxy] SSE daemon unavailable after retry");
      reply.code(502).send({ error: "broadcast daemon unavailable" });
    }
    return;
  }

  // Successfully connected — commit SSE headers if not already done.
  if (!ensureHeaders()) {
    try { upstreamRes.body.cancel(); } catch { /* noop */ }
    return;
  }

  // Pipe the daemon's SSE stream directly to the client.
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

// ── WebSocket Proxy ──────────────────────────────────────────────────────────

/**
 * Application-level WebSocket proxy: bridges the client's Fastify-managed
 * `ws` socket to a real outbound `ws` client connection to the daemon.
 *
 * IMPORTANT: this must be a genuine `{ websocket: true }` Fastify route, not
 * a raw `net.Socket`/TCP-level splice. @fastify/websocket installs its own
 * `upgrade` listener on the shared HTTP server and — because Node's
 * EventEmitter invokes every registered `upgrade` listener for a given
 * request regardless of what earlier listeners did with the socket — any
 * unmatched or non-websocket-marked route on this same Fastify instance
 * causes @fastify/websocket's `noHandle()` to complete the handshake and
 * immediately close the socket out from under a competing raw TCP proxy.
 * That race made every /broadcast-v2/ws connection get killed on arrival
 * (see git history: raw `net.createConnection` splice in app.ts). Routing
 * the proxy entirely through Fastify's own websocket machinery — as a real
 * matched `{ websocket: true }` route — eliminates the second listener
 * entirely, so there is no race.
 */
function wsDaemonProxyHandler(clientSocket: WebSocket, request: FastifyRequest): void {
  const daemonWsUrl = daemonUrl(request.raw.url ?? "/ws").replace(/^http/, "ws");
  const headers = proxyRequestHeaders(request);
  const upstream = new WebSocket(daemonWsUrl, { headers });

  let upstreamOpen = false;
  let closed = false;
  const pending: RawData[] = [];

  const closeBoth = (code?: number, reason?: string) => {
    if (closed) return;
    closed = true;
    try { clientSocket.close(code, reason); } catch { /* already closed */ }
    try { upstream.close(); } catch { /* already closed */ }
  };

  upstream.on("open", () => {
    upstreamOpen = true;
    for (const msg of pending.splice(0)) {
      try { upstream.send(msg); } catch { /* upstream gone */ }
    }
  });

  clientSocket.on("message", (data: RawData) => {
    if (upstreamOpen) {
      try { upstream.send(data); } catch { /* upstream gone */ }
    } else {
      pending.push(data);
    }
  });

  upstream.on("message", (data: RawData) => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      try { clientSocket.send(data); } catch { /* client gone */ }
    }
  });

  upstream.on("error", (err) => {
    logger.debug({ err, daemonWsUrl }, "[broadcast-daemon-proxy] WS upstream error");
    closeBoth(1011, "broadcast daemon unavailable");
  });
  upstream.on("close", () => closeBoth());
  clientSocket.on("error", () => closeBoth());
  clientSocket.on("close", () => closeBoth());
}

// ── Fastify Plugin ────────────────────────────────────────────────────────────

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
export async function broadcastDaemonProxyRoutes(app: FastifyInstance): Promise<void> {
  // Start daemon liveness monitor when the server is ready; stop on close.
  // Safe if BROADCAST_DAEMON_URL is not set (no-op).
  app.addHook("onReady", async () => { startDaemonLivenessMonitor(); });
  app.addHook("onClose", async () => { stopDaemonLivenessMonitor(); });

  // WebSocket — real Fastify-managed proxy (must be registered as an actual
  // `{ websocket: true }` route; see wsDaemonProxyHandler doc comment above).
  app.get("/ws", { websocket: true }, wsDaemonProxyHandler);

  // SSE — resilient streaming proxy with 30 s retry window (must be before wildcard)
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
