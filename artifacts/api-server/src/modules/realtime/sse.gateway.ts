import type { FastifyInstance } from "fastify";
import { broadcastEngine } from "../broadcast/queue.engine.js";
import type { BroadcastEvent } from "../broadcast/queue.engine.js";
import { overrideBus } from "../live-overrides/override-bus.js";
import { bumpSseViewers } from "./viewer-tracker.js";
import { env } from "../../config/env.js";
import { sseCounter } from "../../infrastructure/sse-counter.js";
import { sseCorsHeaders } from "../../lib/sse-cors.js";

/**
 * Server-Sent Events stream for the live channel.
 *
 * One global engine → many connected clients. Each new client gets:
 *   1. An immediate `snapshot` event with the current state
 *   2. Every subsequent `snapshot | preload | advance | viewer-count`
 *
 * SSE is preferred over WebSocket here because it survives proxies/CDNs
 * cleanly and reconnects automatically in browsers.
 *
 * Connection limiting (RT-01):
 *   Rate-limit plugins count completed requests per minute, which makes
 *   them unsuitable for long-lived SSE connections (a connection stays
 *   open for the entire session). Instead we track concurrent connections
 *   per source IP in a Map and reject above MAX_SSE_PER_IP.
 *
 *   Limit is deliberately generous (8 / IP) to cover:
 *     - One TV + one mobile + one web tab + one admin tab per household
 *     - A multi-tab home user — still unlikely to need more than 4–5
 *     - Load-balancers / CDN proxies that NAT many clients → one IP
 *       (those callers typically do not open SSE; they forward HTTP)
 *
 *   Tune downward if memory pressure from idle open sockets becomes a
 *   concern on the free-plan container.
 */

const MAX_SSE_PER_IP = env.MAX_SSE_PER_IP;

// How often we check whether the underlying TCP socket is still writable.
// If the socket is not writable for ZOMBIE_TIMEOUT_MS we close the connection.
const SSE_ZOMBIE_CHECK_MS = 30_000;
const SSE_ZOMBIE_TIMEOUT_MS = 90_000;

// Map<sourceIP, openConnectionCount>
const sseConnections = new Map<string, number>();

function sseIncrement(ip: string): number {
  const cur = sseConnections.get(ip) ?? 0;
  sseConnections.set(ip, cur + 1);
  return cur + 1;
}

function sseDecrement(ip: string): void {
  const cur = sseConnections.get(ip) ?? 1;
  if (cur <= 1) sseConnections.delete(ip);
  else sseConnections.set(ip, cur - 1);
}

// Force-close registry: populated by the SSE handler for each open connection.
// closeAllRealtimeSseSessions() is called during graceful shutdown so the
// server drain loop completes in O(ms) instead of waiting for the timeout.
const openRealtimeSseCleanups = new Set<() => void>();
export function closeAllRealtimeSseSessions(): void {
  for (const cleanup of openRealtimeSseCleanups) {
    try { cleanup(); } catch { /* ignore */ }
  }
}

export async function sseRoutes(app: FastifyInstance) {
  app.get("/realtime/sse", async (req, reply) => {
    const ip = req.ip ?? "unknown";
    const count = sseIncrement(ip);

    if (count > MAX_SSE_PER_IP) {
      // Immediately release the slot we just claimed — this request is
      // rejected; no ongoing connection will be opened.
      sseDecrement(ip);
      reply.code(429).header("Content-Type", "application/json").send({
        error: "Too many SSE connections from this address",
        max: MAX_SSE_PER_IP,
      });
      return;
    }

    bumpSseViewers(+1);
    sseCounter.inc();

    reply.raw.socket?.setNoDelay(true);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Content-Encoding": "identity",
      ...sseCorsHeaders(req),
    });

    const send = (e: BroadcastEvent) => {
      try {
        reply.raw.write(`event: ${e.type}\n`);
        reply.raw.write(`data: ${JSON.stringify(e.data)}\n\n`);
      } catch {
        /* ignore — close handler will clean up */
      }
    };

    send({ type: "snapshot", data: broadcastEngine.snapshot() });

    const onEvent = (e: BroadcastEvent) => send(e);
    broadcastEngine.on("event", onEvent);

    // Push a fresh engine snapshot whenever an admin starts or stops a live
    // override so SSE clients get an immediate "something changed" signal and
    // can refetch /live/status to surface the override state. Without this,
    // SSE clients would not learn about override changes until the next engine
    // tick (up to 30 s later).
    const onOverrideChange = () => {
      broadcastEngine.pushSnapshot();
    };
    overrideBus.on("change", onOverrideChange);

    // Track last successful write for zombie detection.
    let lastWriteOkMs = Date.now();

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
        lastWriteOkMs = Date.now();
      } catch {
        /* ignore — close handler will clean up */
      }
    }, 10_000);
    heartbeat.unref?.();

    // Zombie detection: SSE has no native ping/pong mechanism. If the TCP
    // connection goes half-open (silent disconnect without a FIN), the server
    // continues to hold the socket and event listeners for hours. We check
    // writability every SSE_ZOMBIE_CHECK_MS and force-close connections that
    // have not had a successful write in SSE_ZOMBIE_TIMEOUT_MS.
    const zombieCheck = setInterval(() => {
      const idleMs = Date.now() - lastWriteOkMs;
      const socketWritable = !reply.raw.socket?.destroyed && reply.raw.socket?.writable;
      if (!socketWritable || idleMs > SSE_ZOMBIE_TIMEOUT_MS) {
        cleanup();
      }
    }, SSE_ZOMBIE_CHECK_MS);
    zombieCheck.unref?.();

    let realtimeSseClosed = false;
    const cleanup = () => {
      if (realtimeSseClosed) return;
      realtimeSseClosed = true;
      openRealtimeSseCleanups.delete(cleanup);
      clearInterval(heartbeat);
      clearInterval(zombieCheck);
      broadcastEngine.off("event", onEvent);
      overrideBus.off("change", onOverrideChange);
      bumpSseViewers(-1);
      sseDecrement(ip);
      sseCounter.dec();
      try {
        reply.raw.end();
      } catch {
        /* ignore */
      }
    };

    openRealtimeSseCleanups.add(cleanup);
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);
  });
}
