import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { broadcastEngine } from "../broadcast/queue.engine.js";
import type { BroadcastEvent } from "../broadcast/queue.engine.js";
import { overrideBus } from "../live-overrides/override-bus.js";
import type { OverrideBusChange } from "../live-overrides/override-bus.js";
import { signalBus } from "../network/signal-bus.js";
import type { OmegaSignal } from "../network/signal-bus.js";
import { viewerTrackingService } from "../viewer-tracking/viewer-tracking.service.js";
import { wsCounter } from "../../infrastructure/ws-counter.js";
import { logger } from "../../infrastructure/logger.js";

/**
 * WebSocket gateway. Bidirectional channel for clients that prefer WS
 * over SSE (mobile native, smart-TV apps).
 *
 * Outbound: `BroadcastEvent` stream + override-change notifications +
 *           OMEGA typed signals (PROGRAM_CHANGED, STREAM_FAILED, etc.).
 * Inbound: `{ type: "ping" }` — respond `{ type: "pong" }` to keep
 *          the connection alive and to maintain accurate viewer counts.
 *
 * Viewer counting: each connection auto-registers a session with
 * `viewerTrackingService` (Redis-backed, TTL + sessionId dedup) and
 * refreshes it on VIEWER_HEARTBEAT_INTERVAL_MS. That service is the single
 * source of truth for the broadcast engine's viewer count — this gateway
 * does not write to it directly, so there is only ever one writer.
 */

const HEARTBEAT_INTERVAL_MS = 30_000;
const ZOMBIE_TIMEOUT_MS = 60_000;
// Must stay comfortably under the viewer-tracking session TTL (25 s default)
// so a session never expires between refreshes for a live connection.
const VIEWER_HEARTBEAT_INTERVAL_MS = 10_000;

/** All active sockets — used by closeAllRealtimeWsSessions() on shutdown. */
const _activeSockets = new Set<{ terminate?(): void }>();

/**
 * Force-close every active realtime WS session.
 * Called during graceful shutdown before app.close() so event-listener
 * registrations on broadcastEngine/overrideBus/signalBus are released
 * and do not delay GC of the socket objects.
 */
export function closeAllRealtimeWsSessions(): void {
  for (const s of _activeSockets) {
    try { s.terminate?.(); } catch { /* already gone */ }
  }
  _activeSockets.clear();
}

export async function wsRoutes(app: FastifyInstance) {
  app.get("/realtime/ws", { websocket: true }, (socket, _req) => {
    wsCounter.inc();
    // This gateway is shared by TV, mobile native, and admin clients, so the
    // platform tag is left unset here — per-platform breakdowns come from the
    // dedicated /viewer-tracking/heartbeat endpoint when a client wants one.
    const viewerSessionId = randomUUID();
    void viewerTrackingService
      .heartbeat({ sessionId: viewerSessionId, streamId: broadcastEngine.channelId })
      .catch(() => undefined);
    const viewerHeartbeat = setInterval(() => {
      void viewerTrackingService
        .heartbeat({ sessionId: viewerSessionId, streamId: broadcastEngine.channelId })
        .catch(() => undefined);
    }, VIEWER_HEARTBEAT_INTERVAL_MS);
    (viewerHeartbeat as unknown as { unref?: () => void }).unref?.();
    _activeSockets.add(socket as unknown as { terminate?(): void });

    // Track liveness for zombie detection (server-ping + native pong paths).
    let lastPongMs = Date.now();

    const send = (msg: unknown) => {
      try {
        socket.send(JSON.stringify(msg));
      } catch {
        /* ignore — close handler cleans up */
      }
    };

    const sendEvent = (e: BroadcastEvent) => send(e);

    send({ type: "snapshot", data: broadcastEngine.snapshot() });
    broadcastEngine.on("event", sendEvent);

    // Push a fresh engine snapshot whenever a live override starts or stops
    // so clients on this gateway get the same immediate notification that
    // the /playback/ws gateway delivers.
    const onOverrideChange = (_change: OverrideBusChange) => {
      broadcastEngine.pushSnapshot();
    };
    overrideBus.on("change", onOverrideChange);

    // Forward OMEGA typed signals to this client so it can surface emergency
    // overlays and force resyncs without waiting for the next engine tick.
    const onSignal = (signal: OmegaSignal) => {
      send({ type: "signal", signal });
    };
    signalBus.on("signal", onSignal);

    // ── Server-initiated heartbeat ─────────────────────────────────────────
    // Without this, half-open ("zombie") sockets that stop responding but
    // never close the TCP connection accumulate indefinitely, leaking:
    //   - event-listener slots on broadcastEngine / overrideBus / signalBus
    //   - a stuck viewer-tracking session (leave() never called)
    //   - wsCounter inflation (diagnostics panel shows wrong count)
    //
    // Strategy: send a JSON ping + native WS ping() every 30 s.
    // If neither a JSON "ping" message nor a native pong arrives within 60 s
    // (2 missed heartbeat cycles), classify the socket as a zombie and call
    // terminate() which immediately frees the file descriptor.
    const heartbeat = setInterval(() => {
      send({ type: "ping", serverTimeMs: Date.now() });
      try { (socket as unknown as { ping(): void }).ping(); } catch { /* gone */ }
      if (Date.now() - lastPongMs > ZOMBIE_TIMEOUT_MS) {
        logger.warn("[realtime/ws] terminating zombie session — no pong in 60 s");
        try {
          (socket as unknown as { terminate?(): void }).terminate?.();
        } catch { /* already gone */ }
      }
    }, HEARTBEAT_INTERVAL_MS);
    // unref() so the heartbeat timer does not prevent graceful shutdown from
    // proceeding if a socket is the last thing keeping the event loop alive.
    (heartbeat as unknown as { unref?: () => void }).unref?.();

    // Native WS pong: fired by the `ws` library when the remote responds to
    // our socket.ping() frames. Updates liveness timestamp.
    socket.on("pong", () => { lastPongMs = Date.now(); });

    socket.on("message", (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string };
        if (msg.type === "ping") {
          lastPongMs = Date.now();  // treat inbound ping as proof of liveness
          send({ type: "pong" });
        }
      } catch {
        /* ignore malformed */
      }
    });

    const cleanup = () => {
      wsCounter.dec();
      void viewerTrackingService.leave(viewerSessionId, broadcastEngine.channelId).catch(() => undefined);
      clearInterval(heartbeat);
      clearInterval(viewerHeartbeat);
      _activeSockets.delete(socket as unknown as { terminate?(): void });
      broadcastEngine.off("event", sendEvent);
      overrideBus.off("change", onOverrideChange);
      signalBus.off("signal", onSignal);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
}
