import type { FastifyInstance } from "fastify";

/**
 * YouTube live event stream — SSE channel the admin Live Monitor page
 * subscribes to for real-time YT poller state changes (live/offline,
 * viewer count, detection-method changes).
 *
 * The underlying YouTube live-poller subsystem is in a deliberately
 * skipped phase, so this gateway:
 *   - Holds the SSE connection open with proper headers and a 25s
 *     keep-alive so the admin's `EventSource` doesn't churn.
 *   - Emits a single `state: disabled` event on connect so the page
 *     can render a clean "poller off" badge instead of spinning.
 *   - Never emits further events.
 *
 * When the YT poller lands, this handler will pipe its EventEmitter
 * out the SSE stream the same way `sse.gateway.ts` pipes the
 * broadcast engine.
 */
export async function youtubeLiveRoutes(app: FastifyInstance) {
  app.get("/events", async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    reply.raw.write(`event: state\n`);
    reply.raw.write(
      `data: ${JSON.stringify({
        enabled: false,
        reason: "youtube-live-poller-disabled-in-build",
        ts: Date.now(),
      })}\n\n`,
    );

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: ping\n\n`);
      } catch {
        /* ignore — close handler runs */
      }
    }, 25_000);

    const cleanup = () => {
      clearInterval(heartbeat);
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
