import type { FastifyInstance } from "fastify";
import { broadcastOrchestrator } from "../engine/broadcast-orchestrator.js";
import type { V2ClientFrame, V2EventType, V2ServerFrame } from "../domain/types.js";
import { eventLogRepo } from "../repository/event-log.repo.js";
import { playbackAnalytics } from "../engine/playback-analytics.js";
import { logger } from "../../../infrastructure/logger.js";
import { activeWsConnections, SERVICE_LABELS } from "../../../infrastructure/metrics.js";

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
      // Detect dead connections: if no pong received in 2× heartbeat interval
      // (20 s), log a warning. The TCP stack / WS ping/pong at the transport
      // layer will eventually close truly dead sockets; this is for observability.
      if (Date.now() - lastPongAtMs > 20_000) {
        logger.debug({ ip, sessionAgeMs: Date.now() - sessionOpenAtMs }, "[broadcast-v2/ws] session may be dead — no pong for 20 s");
      }
    }, 10_000);
    heartbeat.unref?.();

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
          const events = await eventLogRepo.replayFrom(broadcastOrchestrator.channelId, msg.lastSequence, 200);
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
