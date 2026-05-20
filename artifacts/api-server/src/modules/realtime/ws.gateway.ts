import type { FastifyInstance } from "fastify";
import { broadcastEngine } from "../broadcast/queue.engine.js";
import type { BroadcastEvent } from "../broadcast/queue.engine.js";
import { overrideBus } from "../live-overrides/override-bus.js";
import type { OverrideBusChange } from "../live-overrides/override-bus.js";
import { signalBus } from "../network/signal-bus.js";
import type { OmegaSignal } from "../network/signal-bus.js";
import { bumpWsViewers } from "./viewer-tracker.js";

/**
 * WebSocket gateway. Bidirectional channel for clients that prefer WS
 * over SSE (mobile native, smart-TV apps).
 *
 * Outbound: `BroadcastEvent` stream + override-change notifications +
 *           OMEGA typed signals (PROGRAM_CHANGED, STREAM_FAILED, etc.).
 * Inbound: `{ type: "ping" }` — respond `{ type: "pong" }` to keep
 *          the connection alive and to maintain accurate viewer counts.
 *
 * Viewer counting is delegated to `viewer-tracker.ts` which combines
 * WS + SSE counts and feeds the sum into the broadcast engine.
 */
export async function wsRoutes(app: FastifyInstance) {
  app.get("/realtime/ws", { websocket: true }, (socket, _req) => {
    bumpWsViewers(+1);

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
    // the /playback/ws gateway delivers. Without this, realtime WS clients
    // would miss override transitions until the next engine tick.
    const onOverrideChange = (_change: OverrideBusChange) => {
      broadcastEngine.pushSnapshot();
    };
    overrideBus.on("change", onOverrideChange);

    // Forward OMEGA typed signals (PROGRAM_CHANGED, STREAM_FAILED,
    // SYNC_REQUIRED, EMERGENCY_BROADCAST, FAILOVER_ACTIVATED, etc.)
    // to this client so it can surface emergency overlays and force
    // resyncs without waiting for the next engine tick.
    const onSignal = (signal: OmegaSignal) => {
      send({ type: "signal", signal });
    };
    signalBus.on("signal", onSignal);

    socket.on("message", (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string };
        if (msg.type === "ping") send({ type: "pong" });
      } catch {
        /* ignore malformed */
      }
    });

    const cleanup = () => {
      bumpWsViewers(-1);
      broadcastEngine.off("event", sendEvent);
      overrideBus.off("change", onOverrideChange);
      signalBus.off("signal", onSignal);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
}
