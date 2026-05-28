import type { FastifyInstance } from "fastify";
import { broadcastOrchestrator } from "../engine/broadcast-orchestrator.js";
import type { V2ClientFrame, V2EventType, V2ServerFrame } from "../domain/types.js";
import { eventLogRepo } from "../repository/event-log.repo.js";
import { playbackAnalytics } from "../engine/playback-analytics.js";
import { logger } from "../../../infrastructure/logger.js";
import { activeWsConnections, SERVICE_LABELS } from "../../../infrastructure/metrics.js";
import { wsCounter } from "../../../infrastructure/ws-counter.js";

/**
 * Per-IP WebSocket connection counter.
 *
 * Prevents a single bad actor (or reconnect storm from one device) from
 * exhausting file descriptors. Mirrors the same pattern used by the SSE
 * gateway. MAX_WS_PER_IP=0 disables the limit entirely (e.g. in tests).
 *
 * Counter decrements are registered as an idempotent releaseCounter()
 * closure immediately after increment — before any async work — so a
 * client that disconnects during the synchronous setup path still frees
 * its slot.
 */
const wsConnectionsPerIp = new Map<string, number>();
const MAX_WS_PER_IP = process.env["MAX_WS_PER_IP"] !== undefined
  ? Number(process.env["MAX_WS_PER_IP"])
  : 8;

// ── Periodic IP-map sweep ─────────────────────────────────────────────────────
// Safety net for long-lived servers: cleans any stale entries where the count
// never reached zero due to an edge-case disconnect (OS-level TCP RST) that
// bypassed the normal releaseCounter/close-event path. The heartbeat's 30 s
// zombie detector calls terminate() on dead sockets, which fires the close
// event and the normal releaseCounter path, so this sweep is belt-and-suspenders
// only. Runs every 10 minutes; unref'd so it does not delay graceful shutdown.
const _wsSweep = setInterval(() => {
  for (const [ip, count] of wsConnectionsPerIp) {
    if (count <= 0) wsConnectionsPerIp.delete(ip);
  }
}, 10 * 60_000);
(_wsSweep as unknown as { unref?: () => void }).unref?.();

export async function wsRoutes(app: FastifyInstance) {
  app.get("/ws", { websocket: true }, (socket, req) => {
    const ip = (req.ip ?? req.socket?.remoteAddress ?? "unknown") as string;

    // Idempotent counter release — declared outside the if-block so the
    // final socket.on("close") handler below can always call it safely.
    let released = false;
    const releaseCounter = () => {
      if (released || MAX_WS_PER_IP <= 0) return;
      released = true;
      const n = wsConnectionsPerIp.get(ip) ?? 1;
      if (n <= 1) wsConnectionsPerIp.delete(ip);
      else wsConnectionsPerIp.set(ip, n - 1);
    };

    if (MAX_WS_PER_IP > 0) {
      const current = wsConnectionsPerIp.get(ip) ?? 0;
      if (current >= MAX_WS_PER_IP) {
        // 1008 = Policy Violation — the standard close code for rate-limit
        // rejections on WebSocket. Clients should back off before retrying.
        socket.close(1008, "Too many connections from your IP — retry after 10 s");
        return;
      }
      wsConnectionsPerIp.set(ip, current + 1);
      // Register decrement immediately (before any awaits) so a premature
      // close during synchronous setup still releases the counter.
      socket.on("close", releaseCounter);
    }
    activeWsConnections.inc({ surface: "broadcast-v2", ...SERVICE_LABELS });
    wsCounter.inc();

    const send = (frame: V2ServerFrame) => {
      try {
        socket.send(JSON.stringify(frame));
      } catch {
        /* client gone */
      }
    };

    // Track session for analytics and dead-connection detection.
    const sessionOpenAtMs = Date.now();
    let lastPongAtMs = Date.now();
    playbackAnalytics.record({
      type: "session_open",
      itemId: null,
      itemTitle: null,
      ts: sessionOpenAtMs,
      meta: { ip },
    });

    send({ type: "hello", serverTimeMs: Date.now(), sequence: broadcastOrchestrator.getSequence() });
    send({
      type: "snapshot",
      sequence: broadcastOrchestrator.getSequence(),
      state: broadcastOrchestrator.snapshot(),
    });

    const onFrame = (frame: V2ServerFrame) => send(frame);
    broadcastOrchestrator.on("frame", onFrame);

    const heartbeat = setInterval(() => {
      send({ type: "heartbeat", serverTimeMs: Date.now(), sequence: broadcastOrchestrator.getSequence() });

      // Native WS-level ping frame. This serves two purposes:
      //   1. Load balancers (AWS ALB, Nginx, Cloudflare) keep the upstream
      //      WebSocket connection alive — they typically drop idle WS connections
      //      after 60-120 s of no WS-level traffic, even if TCP is alive.
      //   2. The `ws` library uses these pings to detect dead TCP connections
      //      at the OS level; the peer's WS stack auto-responds with a native
      //      pong frame without any application code involvement.
      try { socket.ping(); } catch { /* client already gone */ }

      // Terminate zombie sessions: if neither an app-level pong (from the
      // client's heartbeat response) nor a native WS pong has arrived within
      // 3× the heartbeat interval (30 s = 3 missed beats), the session is dead
      // at the application layer. `terminate()` skips the WS close handshake
      // and immediately frees the file descriptor — the `close` event fires
      // normally so the cleanup below (clearInterval, off("frame"), releaseCounter)
      // still executes in full.
      if (Date.now() - lastPongAtMs > 30_000) {
        logger.debug(
          { ip, sessionAgeMs: Date.now() - sessionOpenAtMs },
          "[broadcast-v2/ws] terminating zombie session — no pong for 30 s",
        );
        try { socket.terminate(); } catch { /* already closed */ }
      }
    }, 10_000);
    heartbeat.unref?.();

    // Native WS pong handler — fires automatically when the client's WS
    // stack responds to our socket.ping() calls above. Update lastPongAtMs
    // so the terminate check above sees this as a live session.
    socket.on("pong", () => {
      lastPongAtMs = Date.now();
    });

    socket.on("message", async (raw: Buffer | string) => {
      let msg: V2ClientFrame;
      try {
        msg = JSON.parse(raw.toString()) as V2ClientFrame;
      } catch {
        return;
      }
      if (msg.type === "pong") {
        // Client acknowledged our heartbeat frame — connection is alive.
        lastPongAtMs = Date.now();
        return;
      }
      if (msg.type === "resume") {
        try {
          const events = await eventLogRepo.replayFrom(broadcastOrchestrator.channelId, msg.lastSequence, 500);
          send({
            type: "recover",
            fromSequence: msg.lastSequence,
            events: events.map((e) => ({
              type: "event" as const,
              sequence: e.sequence,
              eventType: e.eventType as V2EventType,
              payload: e.payload,
            })),
          });
        } catch {
          // DB failure during replay — send an empty recover frame so the
          // client knows the resume was processed. The authoritative snapshot
          // below will re-align state without a full event history.
          send({
            type: "recover",
            fromSequence: msg.lastSequence,
            events: [],
          });
        }
        // After replay, send a fresh authoritative snapshot so the client
        // is aligned with server state even if the recover frame contained
        // no events (e.g. after a server restart that reset the event log).
        // The client's transport will call /state anyway but this saves a
        // round-trip and closes the race window where the WS snapshot and
        // the REST /state response could interleave with different sequences.
        send({
          type: "snapshot",
          sequence: broadcastOrchestrator.getSequence(),
          state: broadcastOrchestrator.snapshot(),
        });
      }
    });

    socket.on("close", () => {
      clearInterval(heartbeat);
      broadcastOrchestrator.off("frame", onFrame);
      // releaseCounter is idempotent — safe even if the early handler above
      // already fired (e.g. client disconnected during synchronous setup).
      releaseCounter();
      activeWsConnections.dec({ surface: "broadcast-v2", ...SERVICE_LABELS });
      wsCounter.dec();
      playbackAnalytics.record({
        type: "session_close",
        itemId: null,
        itemTitle: null,
        ts: Date.now(),
        meta: { ip, sessionDurationMs: Date.now() - sessionOpenAtMs },
      });
    });
  });
}
