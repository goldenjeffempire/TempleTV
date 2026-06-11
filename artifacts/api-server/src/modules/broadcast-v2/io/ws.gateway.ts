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

// ── Active-socket registry for graceful shutdown ──────────────────────────────
// All open broadcast-v2 WebSocket sockets. The graceful-shutdown path in main.ts
// must force-terminate these before app.close(); otherwise the established WS
// connections (and their orchestrator "frame" listener registrations) keep the
// HTTP server from closing, hanging the process until SHUTDOWN_DRAIN_MS elapses
// and the orchestrator (Render/K8s) escalates to SIGKILL — producing the restart
// loops observed in production. Mirrors closeAllRealtimeWsSessions() for the v1
// playback gateway. terminate() fires each socket's "close" handler so the normal
// cleanup (clearInterval, off("frame"), releaseCounter, counter dec) still runs.
const _activeSockets = new Set<{ terminate?(): void }>();

export function closeAllBroadcastV2WsSessions(): void {
  for (const s of _activeSockets) {
    try { s.terminate?.(); } catch { /* already closed */ }
  }
  _activeSockets.clear();
}

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
    // Register for graceful-shutdown termination. Removed in the close handler.
    const socketRef = socket as unknown as { terminate?(): void };
    _activeSockets.add(socketRef);

    // 512 KiB — if the client's receive buffer exceeds this the TCP window
    // is closed and every send() blocks Node's UV loop. Close proactively so
    // the kernel send-buffer is freed before it consumes process RSS.
    const WS_BUFFER_THRESHOLD = 512 * 1024;
    const send = (frame: V2ServerFrame) => {
      try {
        if ((socket.bufferedAmount ?? 0) > WS_BUFFER_THRESHOLD) {
          logger.warn(
            { ip, bufferedAmount: socket.bufferedAmount },
            "[broadcast-v2/ws] client receive buffer overflow — closing slow connection",
          );
          try { socket.close(1008, "Client receive buffer overflow"); } catch { /* already closed */ }
          return;
        }
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

    // Track which frame handler is currently registered on the orchestrator
    // so the "close" event always removes exactly the right function reference.
    //
    // Problem this solves: the `resume` message handler swaps onFrame → bufferFrame
    // on the emitter before an async DB await. If the socket closes while that
    // await is in-flight the close handler fires with the old `onFrame` reference,
    // finds nothing to remove (onFrame is no longer registered), and returns —
    // leaving `bufferFrame` permanently on the emitter. When the await eventually
    // resolves the code re-registers `onFrame` on a dead socket, creating a
    // second permanent leak. Together these two phantom listeners accumulate
    // for the lifetime of the process.
    //
    // Fix: one mutable pointer (`activeFrameHandler`) that always reflects
    // the currently-registered handler. The close handler removes whatever
    // is pointed at. The resume post-await path skips re-registration when
    // `socketClosed` is already true.
    let activeFrameHandler: (f: V2ServerFrame) => void = onFrame;
    let socketClosed = false;

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
        // Buffer any real-time frames that arrive while the DB replay is
        // awaiting so the client always receives events in strict order:
        //   recover (history) → snapshot (authoritative) → live frames.
        // Without this gate, an orchestrator "frame" event emitted during
        // the async replayFrom call can reach the client before the recover
        // and snapshot frames, causing out-of-order FSM transitions.
        //
        // FRAME_QUEUE_MAX: mirrors the SSE gateway's 500-frame cap. During
        // an unusually long DB replay (slow Postgres, high event volume) the
        // live "frame" events emitted by the orchestrator accumulate here.
        // Without a cap, a burst of thousands of events could exhaust heap
        // memory on the Node process. When the cap is exceeded we drop the
        // oldest frame (shift) so the client receives the most-recent events
        // and the post-replay snapshot re-aligns any skipped state.
        const FRAME_QUEUE_MAX = 500;
        const frameQueue: V2ServerFrame[] = [];
        const bufferFrame = (f: V2ServerFrame) => {
          if (frameQueue.length >= FRAME_QUEUE_MAX) frameQueue.shift();
          frameQueue.push(f);
        };
        broadcastOrchestrator.off("frame", activeFrameHandler);
        broadcastOrchestrator.on("frame", bufferFrame);
        activeFrameHandler = bufferFrame;
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

        // Socket may have closed while the DB await was in-flight.
        // If so, the close handler already removed `bufferFrame`
        // (via activeFrameHandler) — do NOT re-register onFrame on a
        // dead socket, and do NOT flush buffered frames to a gone client.
        if (socketClosed) return;

        // Concurrent-resume guard: a newer `resume` message may have arrived
        // while this DB replay was awaiting. If so, the newer handler has
        // already:
        //   1. Removed this `bufferFrame` from the orchestrator.
        //   2. Registered its own `bufferFrame2` as `activeFrameHandler`.
        // If we proceed here we would:
        //   a. Call `off("frame", bufferFrame)` — no-op (already removed).
        //   b. Call `on("frame", onFrame)` — but `onFrame` is now registered by
        //      the newer resume's post-await path, so it ends up DOUBLE-registered:
        //      every subsequent broadcast frame is sent twice to this client.
        // Solution: if we are no longer the current active handler, yield to
        // the newer resume and return without touching the emitter.
        if (activeFrameHandler !== bufferFrame) return;

        // After replay, send a fresh authoritative snapshot so the client
        // is aligned with server state even if the recover frame contained
        // no events (e.g. after a server restart that reset the event log).
        send({
          type: "snapshot",
          sequence: broadcastOrchestrator.getSequence(),
          state: broadcastOrchestrator.snapshot(),
        });
        // Flush any frames buffered during the DB await, then restore the
        // live listener so subsequent events flow normally.
        for (const f of frameQueue) send(f);
        broadcastOrchestrator.off("frame", bufferFrame);
        broadcastOrchestrator.on("frame", onFrame);
        activeFrameHandler = onFrame;
      }
    });

    socket.on("close", () => {
      // Signal any in-flight `resume` handler so it does not re-register
      // onFrame on a dead socket after its DB await resolves.
      socketClosed = true;
      _activeSockets.delete(socketRef);
      clearInterval(heartbeat);
      // Remove whichever handler is currently registered — either the live
      // `onFrame` listener or the `bufferFrame` buffering listener that was
      // swapped in during a concurrent `resume` message. Using `activeFrameHandler`
      // instead of the bare `onFrame` reference prevents the phantom-listener
      // accumulation where a close during a DB await left `bufferFrame` permanently
      // on the emitter (because `onFrame` was no longer registered at that point).
      broadcastOrchestrator.off("frame", activeFrameHandler);
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
