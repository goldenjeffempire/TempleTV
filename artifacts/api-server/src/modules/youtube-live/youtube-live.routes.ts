import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ytPoller } from "./youtube-live.poller.js";
import { sseCorsHeaders } from "../../lib/sse-cors.js";
import { requireAuth } from "../../middleware/auth.js";

/**
 * YouTube live event stream — SSE channel the admin Live Monitor page
 * subscribes to for real-time YT poller state changes (live/offline,
 * viewer count, detection-method changes).
 *
 * The poller is started on first SSE connection (lazy init) and stays
 * running for the lifetime of the process. GET / and GET /status return
 * the current cached state; GET /events streams state-change events.
 */

// All open youtube-live SSE connections. Populated by the /events handler
// and force-closed by closeAllYoutubeLiveSseSessions() during shutdown.
const openYoutubeLiveSseCleanups = new Set<() => void>();

export function closeAllYoutubeLiveSseSessions(): void {
  for (const cleanup of openYoutubeLiveSseCleanups) {
    try { cleanup(); } catch { /* ignore */ }
  }
}

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
  app.get("/", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } }, schema: { response: { 429: z.object({ error: z.string() }) } } }, async (_req, reply) => {
    // Same short public cache as /status — consumed by mobile as a fallback
    // check. stale-if-error=60 prevents a brief origin blip from showing an
    // incorrect "offline" state for up to 60 seconds.
    reply
      .header("Cache-Control", "public, max-age=5, s-maxage=5, stale-while-revalidate=10, stale-if-error=60")
      .header("Vary", "Accept-Encoding");
    const s = ytPoller.getState();
    return {
      isLive: s.isLive,
      videoId: s.videoId,
      title: s.title,
      viewerCount: s.viewerCount,
      checkedAt: s.checkedAt,
      detectionMethod: s.detectionMethod,
      isUpcoming: s.isUpcoming,
      upcomingVideoId: s.upcomingVideoId,
      upcomingTitle: s.upcomingTitle,
    };
  });

  /**
   * Polled-status sibling of /events. TV app's useLiveSync polls this
   * every 30 s as a fallback when SSE drops.
   * Rate-limited to 120 req/min — same budget as the root endpoint.
   */
  app.get("/status", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } }, schema: { response: { 429: z.object({ error: z.string() }) } } }, async (_req, reply) => {
    // Short public cache — TV fallback polls this every 30 s when SSE drops.
    // 5 s max-age is safe: live-status SSE fires immediately on actual changes.
    // stale-if-error=60 prevents a brief origin blip from causing an
    // erroneous "offline" banner for up to 60 seconds.
    reply
      .header("Cache-Control", "public, max-age=5, s-maxage=5, stale-while-revalidate=10, stale-if-error=60")
      .header("Vary", "Accept-Encoding");
    const s = ytPoller.getState();
    return {
      isLive: s.isLive,
      videoId: s.videoId,
      title: s.title,
      viewerCount: s.viewerCount,
      checkedAt: s.checkedAt,
      detectionMethod: s.detectionMethod,
      isUpcoming: s.isUpcoming,
      upcomingVideoId: s.upcomingVideoId,
      upcomingTitle: s.upcomingTitle,
    };
  });

  /**
   * List scheduled/upcoming YouTube broadcasts.
   * Admin Live YouTube page polls this to populate the broadcast selector.
   * Returns an empty array when the YouTube API is not configured.
   */
  app.get("/broadcasts", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async () => {
    const s = ytPoller.getState();
    // When live, surface the current broadcast as the only entry.
    // When offline but an upcoming stream is detected, surface it so
    // operators can see it in the admin panel.
    // When neither, return an empty list.
    if (s.isLive && s.videoId) {
      return {
        broadcasts: [
          {
            id: s.videoId,
            title: s.title ?? "Live Broadcast",
            status: "live" as const,
            scheduledStartTime: null as string | null,
          },
        ],
      };
    }
    if (s.isUpcoming && s.upcomingVideoId) {
      return {
        broadcasts: [
          {
            id: s.upcomingVideoId,
            title: s.upcomingTitle ?? "Upcoming Broadcast",
            status: "upcoming" as const,
            scheduledStartTime: null as string | null,
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
  app.post("/:broadcastId/start", { preHandler: requireAuth("editor"), config: { rateLimit: { max: 10, timeWindow: "1 minute" } }, schema: { response: { 429: z.object({ error: z.string() }) } } }, async (req: FastifyRequest<{ Params: { broadcastId: string } }>, reply) => {
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
  app.post("/:broadcastId/stop", { preHandler: requireAuth("editor"), config: { rateLimit: { max: 10, timeWindow: "1 minute" } }, schema: { response: { 429: z.object({ error: z.string() }) } } }, async (req: FastifyRequest<{ Params: { broadcastId: string } }>, reply) => {
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
  // SSE long-poll: rate-limit new connections to 20/min per IP to prevent
  // resource exhaustion from connection storms while allowing normal
  // multi-tab admin usage.
  app.get("/events", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...sseCorsHeaders(req),
    });

    let closed = false;
    let lastYtLiveSseWriteOkMs = Date.now();

    const writeState = () => {
      if (closed) return;
      const s = ytPoller.getState();
      try {
        const ok = reply.raw.write(`event: state\ndata: ${JSON.stringify({
          isLive: s.isLive,
          videoId: s.videoId,
          title: s.title,
          viewerCount: s.viewerCount,
          checkedAt: s.checkedAt,
          detectionMethod: s.detectionMethod,
          isUpcoming: s.isUpcoming,
          upcomingVideoId: s.upcomingVideoId,
          upcomingTitle: s.upcomingTitle,
        })}\n\n`);
        if (ok) lastYtLiveSseWriteOkMs = Date.now();
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
      try {
        const ok = reply.raw.write(": ping\n\n");
        if (ok) lastYtLiveSseWriteOkMs = Date.now();
      } catch { /* ignore */ }
    }, 25_000);
    // Unref so this timer never blocks graceful shutdown — the req.raw
    // "close" / "error" handlers will clearInterval if the client disconnects,
    // and SIGTERM will drain the server regardless of this timer.
    heartbeat.unref();

    // Zombie detection: half-open TCP keeps socket open silently.
    // Close if no successful write in 90 s (= 3.6× the 25 s heartbeat).
    const zombieCheck = setInterval(() => {
      const idleMs = Date.now() - lastYtLiveSseWriteOkMs;
      const writable = !reply.raw.socket?.destroyed && reply.raw.socket?.writable;
      if (!writable || idleMs > 90_000) cleanup();
    }, 30_000);
    zombieCheck.unref();

    const cleanup = () => {
      if (closed) return;
      closed = true;
      openYoutubeLiveSseCleanups.delete(cleanup);
      unsub();
      clearInterval(heartbeat);
      clearInterval(zombieCheck);
      try { reply.raw.end(); } catch { /* ignore */ }
    };
    openYoutubeLiveSseCleanups.add(cleanup);
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);
  });
}
