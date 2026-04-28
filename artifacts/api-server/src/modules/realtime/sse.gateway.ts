import type { FastifyInstance } from "fastify";
import { broadcastEngine } from "../broadcast/queue.engine.js";
import type { BroadcastEvent } from "../broadcast/queue.engine.js";

/**
 * Server-Sent Events stream for the live channel.
 *
 * One global engine → many connected clients. Each new client gets:
 *   1. An immediate `snapshot` event with the current state
 *   2. Every subsequent `snapshot | preload | advance | viewer-count`
 *
 * SSE is preferred over WebSocket here because it survives proxies/CDNs
 * cleanly and reconnects automatically in browsers.
 */
export async function sseRoutes(app: FastifyInstance) {
  app.get("/realtime/sse", async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (e: BroadcastEvent) => {
      reply.raw.write(`event: ${e.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(e.data)}\n\n`);
    };

    send({ type: "snapshot", data: broadcastEngine.snapshot() });

    const onEvent = (e: BroadcastEvent) => send(e);
    broadcastEngine.on("event", onEvent);

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: ping\n\n`);
      } catch {
        /* ignore — close handler will clean up */
      }
    }, 25_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      broadcastEngine.off("event", onEvent);
      try {
        reply.raw.end();
      } catch {
        /* ignore */
      }
    };

    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);
  });
}
