import type { FastifyInstance } from "fastify";
import { broadcastEngine } from "../broadcast/queue.engine.js";
import type { BroadcastEvent } from "../broadcast/queue.engine.js";

/**
 * WebSocket gateway. Bidirectional channel for clients that prefer WS
 * over SSE (mobile native, smart-TV apps).
 *
 * Outbound: same `BroadcastEvent` stream as the SSE gateway.
 * Inbound: `{ type: "ping" }` — respond `{ type: "pong" }` to keep
 *          the connection alive and to maintain accurate viewer counts.
 */
export async function wsRoutes(app: FastifyInstance) {
  app.get("/api/v1/realtime/ws", { websocket: true }, (socket, _req) => {
    bumpViewerCount(+1);

    const send = (e: BroadcastEvent) => {
      try {
        socket.send(JSON.stringify(e));
      } catch {
        /* ignore — close handler cleans up */
      }
    };

    send({ type: "snapshot", data: broadcastEngine.snapshot() });
    const onEvent = (e: BroadcastEvent) => send(e);
    broadcastEngine.on("event", onEvent);

    socket.on("message", (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string };
        if (msg.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
      } catch {
        /* ignore malformed */
      }
    });

    const cleanup = () => {
      bumpViewerCount(-1);
      broadcastEngine.off("event", onEvent);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
}

let liveCount = 0;
function bumpViewerCount(delta: number) {
  liveCount = Math.max(0, liveCount + delta);
  broadcastEngine.setViewerCount(liveCount);
}
