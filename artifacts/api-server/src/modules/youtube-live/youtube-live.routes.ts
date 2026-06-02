import type { FastifyInstance, FastifyRequest } from "fastify";
import { ytPoller } from "./youtube-live.poller.js";
import { sseCorsHeaders } from "../../lib/sse-cors.js";

/**
 * YouTube live event stream — SSE channel the admin Live Monitor page
 * subscribes to for real-time YT poller state changes (live/offline,
 * viewer count, detection-method changes).
 *
 * The poller is started on first SSE connection (lazy init) and stays
 * running for the lifetime of the process. GET / and GET /status return
 * the current cached state; GET /events streams state-change events.
 */

export async function youtubeLiveRoutes(app: FastifyInstance) {
  // Start the poller on route registration so the first REST call has
  // a real answer within one poll interval rather than returning stale
  // "disabled" state.
  ytPoller.start();

  /**
   * Root live-status — consumed by mobile youtube.ts checkLiveViaApiServer().
   * Rate-limited to 120 req/min (= 2 req/s) — generous enough for all clients
   * polling at ≥30 s intervals while blocking accidental polling storms.
   */
  app.get("/", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async () => {
    const s = ytPoller.getState();
    return {
      isLive: s.isLive,
      videoId: s.videoId,
      title: s.title,
      viewerCount: s.viewerCount,
      checkedAt: s.checkedAt,
      detectionMethod: s.detectionMethod,
    };
  });

  /**
   * Polled-status sibling of /events. TV app's useLiveSync polls this
   * every 30 s as a fallback when SSE drops.
   * Rate-limited to 120 req/min — same budget as the root endpoint.
   */
  app.get("/status", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async () => {
    const s = ytPoller.getState();
    return {
      isLive: s.isLive,
      videoId: s.videoId,
      title: s.title,
      viewerCount: s.viewerCount,
      checkedAt: s.checkedAt,
      detectionMethod: s.detectionMethod,
    };
  });

  /**
   * List scheduled/upcoming YouTube broadcasts.
   * Admin Live YouTube page polls this to populate the broadcast selector.
   * Returns an empty array when the YouTube API is not configured.
   */
  app.get("/broadcasts", async () => {
    const s = ytPoller.getState();
    // When live, surface the current broadcast as the only entry so the
    // admin can toggle it off. When offline, return an empty list — the
    // admin will need to use the YouTube Studio to create broadcasts.
    if (s.isLive && s.videoId) {
      return {
        broadcasts: [
          {
            id: s.videoId,
            title: s.title ?? "Live Broadcast",
            status: "live" as const,
            scheduledStartTime: s.checkedAt ?? new Date().toISOString(),
          },
        ],
      };
    }
    return { broadcasts: [] };
  });

  /**
   * Transition a scheduled YouTube broadcast to "live" status.
   * Requires `YOUTUBE_API_KEY` + an OAuth refresh token — surfaces a clear
   * 501 when neither is configured so the admin UI can show a helpful error
   * rather than a silent timeout.
   */
  app.post("/:broadcastId/start", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req: FastifyRequest<{ Params: { broadcastId: string } }>, reply) => {
    const { broadcastId } = req.params;
    // YouTube broadcast transitions require OAuth, which is not yet wired.
    // Return a descriptive error so the admin UI shows a clear message.
    reply.code(501);
    return {
      ok: false,
      error: "YouTube broadcast control requires OAuth credentials. Configure YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET to enable this feature.",
      broadcastId,
    };
  });

  /**
   * Transition a live YouTube broadcast to "complete" status.
   */
  app.post("/:broadcastId/stop", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req: FastifyRequest<{ Params: { broadcastId: string } }>, reply) => {
    const { broadcastId } = req.params;
    reply.code(501);
    return {
      ok: false,
      error: "YouTube broadcast control requires OAuth credentials. Configure YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET to enable this feature.",
      broadcastId,
    };
  });

  /**
   * SSE stream — admin Live Monitor subscribes here. Emits:
   *   event: state   data: { isLive, videoId, title, viewerCount, checkedAt, detectionMethod }
   *
   * A keepalive comment (`: ping`) is sent every 25 s to prevent proxy
   * / load-balancer idle timeouts from silently closing the stream.
   */
  app.get("/events", async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...sseCorsHeaders(req),
    });

    let closed = false;

    const writeState = () => {
      if (closed) return;
      const s = ytPoller.getState();
      try {
        reply.raw.write(`event: state\ndata: ${JSON.stringify({
          isLive: s.isLive,
          videoId: s.videoId,
          title: s.title,
          viewerCount: s.viewerCount,
          checkedAt: s.checkedAt,
          detectionMethod: s.detectionMethod,
        })}\n\n`);
      } catch {
        /* ignore — cleanup runs */
      }
    };

    // Immediately emit current state so the client has data without
    // waiting for the next poller tick.
    writeState();

    // Subscribe to future state changes.
    const unsub = ytPoller.subscribe(() => writeState());

    const heartbeat = setInterval(() => {
      if (closed) return;
      try { reply.raw.write(": ping\n\n"); } catch { /* ignore */ }
    }, 25_000);

    const cleanup = () => {
      closed = true;
      unsub();
      clearInterval(heartbeat);
      try { reply.raw.end(); } catch { /* ignore */ }
    };
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);
  });
}
