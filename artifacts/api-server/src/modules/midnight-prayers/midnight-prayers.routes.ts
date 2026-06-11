/**
 * Midnight Prayers Routes
 *
 * Mounts under /api/midnight-prayers (registered in app.ts).
 *
 * Endpoints consumed by the player-core V2Transport (same contract as
 * /api/broadcast-v2 so the transport works unchanged):
 *   GET /state         – REST snapshot (initial load + cache fallback)
 *   GET /events        – SSE stream (heartbeats + snapshot frames)
 *   GET /ws            – WebSocket stream (same frames over WS)
 *
 * Admin-only management endpoints:
 *   GET  /config       – read schedule config (public)
 *   PATCH /config      – update schedule config (editor+)
 *   GET  /queue        – list midnight-prayers videos (editor+)
 *   POST /queue/refresh – force video list reload (editor+)
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { midnightPrayersService, type MPServerFrame } from "./midnight-prayers.service.js";
import { requireAuth } from "../../middleware/auth.js";
import { logger } from "../../infrastructure/logger.js";

const editorGuard = { preHandler: requireAuth("editor") } as const;

// All open midnight-prayers SSE connections. Populated by the /events handler
// and force-closed by closeAllMidnightPrayersSseSessions() during shutdown.
const openMidnightPrayersSseCleanups = new Set<() => void>();

export function closeAllMidnightPrayersSseSessions(): void {
  for (const cleanup of openMidnightPrayersSseCleanups) {
    try { cleanup(); } catch { /* ignore */ }
  }
}

export async function midnightPrayersRoutes(app: FastifyInstance) {

  // ── GET /state ────────────────────────────────────────────────────────────
  // Compatible with V2Transport: returns { state: V2Snapshot }.
  // Accepts ?epochMs=<number> so each viewer can request a cycle anchored to
  // their own local midnight — the server stays stateless w.r.t. timezone.
  app.get("/state", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } }, schema: { response: { 429: z.object({ error: z.string() }) } } }, async (req, reply) => {
    const query = req.query as Record<string, string>;
    const epochMs = query["epochMs"] ? Number(query["epochMs"]) : undefined;
    const snapshot = midnightPrayersService.getSnapshot(epochMs);
    return reply.send({ state: snapshot });
  });

  // ── GET /config ───────────────────────────────────────────────────────────
  // Public: clients need this to decide whether / when to switch channel.
  app.get("/config", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } }, schema: { response: { 429: z.object({ error: z.string() }) } } }, async (_req, reply) => {
    return reply.send(midnightPrayersService.getConfig());
  });

  // ── PATCH /config ─────────────────────────────────────────────────────────
  const PatchConfigBody = z.object({
    enabled:   z.boolean().optional(),
    startHour: z.number().int().min(0).max(23).optional(),
    endHour:   z.number().int().min(1).max(24).optional(),
    timezone:  z.string().min(1).max(100).optional(),
  });

  app.patch("/config", { ...editorGuard, config: { rateLimit: { max: 10, timeWindow: "1 minute" } }, schema: { response: { 400: z.object({ error: z.string(), details: z.unknown() }), 429: z.object({ error: z.string() }) } } }, async (req, reply) => {
    const result = PatchConfigBody.safeParse(req.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Invalid config", details: result.error.flatten() });
    }
    const updated = await midnightPrayersService.saveConfig(result.data);
    return reply.send(updated);
  });

  // ── GET /queue ────────────────────────────────────────────────────────────
  app.get("/queue", { ...editorGuard, config: { rateLimit: { max: 30, timeWindow: "1 minute" } }, schema: { response: { 429: z.object({ error: z.string() }) } } }, async (_req, reply) => {
    const videos = midnightPrayersService.getVideos();
    const config = midnightPrayersService.getConfig();
    const totalDurationSecs = videos.reduce((a, v) => a + v.durationSecs, 0);
    return reply.send({
      config,
      videos,
      totalVideos: videos.length,
      totalDurationSecs,
      cycleLengthHours: +(totalDurationSecs / 3600).toFixed(2),
    });
  });

  // ── POST /queue/refresh ───────────────────────────────────────────────────
  app.post("/queue/refresh", { ...editorGuard, config: { rateLimit: { max: 10, timeWindow: "1 minute" } }, schema: { response: { 429: z.object({ error: z.string() }) } } }, async (_req, reply) => {
    await midnightPrayersService.loadVideos();
    const videos = midnightPrayersService.getVideos();
    return reply.send({ ok: true, videoCount: videos.length });
  });

  // ── GET /events (SSE) ─────────────────────────────────────────────────────
  // Compatible with V2Transport SSE path.
  // Rate-limit the initial connection (30/min per IP) to prevent SSE exhaustion.
  app.get("/events", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } }, schema: { response: { 429: z.object({ error: z.string() }) } } }, async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type":    "text/event-stream",
      "Cache-Control":   "no-cache, no-transform",
      Connection:        "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const query = req.query as Record<string, string>;
    const epochMs = query["epochMs"] ? Number(query["epochMs"]) : undefined;

    let lastMpSseWriteOkMs = Date.now();
    const send = (frame: MPServerFrame) => {
      try {
        const seq = "sequence" in frame ? frame.sequence : Date.now();
        const ok = reply.raw.write(`id: ${seq}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
        if (ok) lastMpSseWriteOkMs = Date.now();
      } catch { /* client gone */ }
    };

    // Immediately send hello + current snapshot
    const snapshot = midnightPrayersService.getSnapshot(epochMs);
    send({ type: "hello", serverTimeMs: Date.now(), sequence: snapshot.sequence });
    send({ type: "snapshot", sequence: snapshot.sequence, state: snapshot });

    const unsubscribe = midnightPrayersService.subscribeSSE(send);

    // Keepalive ping every 25 s — prevents proxy/LB idle-timeout from silently
    // closing the stream. .unref() so this never blocks graceful SIGTERM drain.
    const heartbeat = setInterval(() => {
      try {
        const ok = reply.raw.write(": ping\n\n");
        if (ok) lastMpSseWriteOkMs = Date.now();
      } catch { /* client gone */ }
    }, 25_000);
    heartbeat.unref();

    // Zombie detection: half-open TCP (no FIN) keeps the socket open
    // indefinitely. Check writability every 30 s; destroy the socket if no
    // successful write has occurred in 90 s (= 3.6× the heartbeat period).
    // Destroying fires the "close" event, unblocking the Promise below and
    // triggering the close handler that calls unsubscribe() + clearInterval().
    const zombieCheck = setInterval(() => {
      const idleMs = Date.now() - lastMpSseWriteOkMs;
      const writable = !reply.raw.socket?.destroyed && reply.raw.socket?.writable;
      if (!writable || idleMs > 90_000) {
        clearInterval(zombieCheck);
        try { reply.raw.destroy(); } catch { /* ignore */ }
      }
    }, 30_000);
    zombieCheck.unref();

    let mpSseClosed = false;
    const mpCleanup = () => {
      if (mpSseClosed) return;
      mpSseClosed = true;
      openMidnightPrayersSseCleanups.delete(mpCleanup);
      unsubscribe();
      clearInterval(heartbeat);
      clearInterval(zombieCheck);
    };
    openMidnightPrayersSseCleanups.add(mpCleanup);
    req.raw.on("close", mpCleanup);
    req.raw.on("error", mpCleanup);

    // Keep the handler alive (Fastify won't auto-close the stream)
    await new Promise<void>((resolve) => {
      req.raw.on("close", resolve);
    });
  });

  // ── GET /ws (WebSocket) ───────────────────────────────────────────────────
  // Compatible with V2Transport WS path.
  // Rate-limit the initial WS upgrade (30/min per IP) to prevent exhaustion.
  app.get("/ws", { websocket: true, config: { rateLimit: { max: 30, timeWindow: "1 minute" } }, schema: { response: { 429: z.object({ error: z.string() }) } } }, (socket, req) => {
    const send = (frame: MPServerFrame) => {
      try {
        socket.send(JSON.stringify(frame));
      } catch { /* client gone */ }
    };

    const query = req.query as Record<string, string>;
    // epochMs can come from the WS query string (passed by client at connect time)
    const epochMs = query["epochMs"] ? Number(query["epochMs"]) : undefined;

    const snapshot = midnightPrayersService.getSnapshot(epochMs);
    send({ type: "hello", serverTimeMs: Date.now(), sequence: snapshot.sequence });
    send({ type: "snapshot", sequence: snapshot.sequence, state: snapshot });

    const unsubscribe = midnightPrayersService.subscribeWS(send);

    socket.on("message", (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (msg["type"] === "resume") {
          // Send a fresh snapshot on resume (no event-log for this channel)
          const fresh = midnightPrayersService.getSnapshot(epochMs);
          send({ type: "snapshot", sequence: fresh.sequence, state: fresh });
        }
      } catch { /* ignore malformed messages */ }
    });

    socket.on("close", () => {
      unsubscribe();
    });

    socket.on("error", (err: Error) => {
      logger.debug({ err }, "[midnight-prayers/ws] socket error");
      unsubscribe();
    });
  });
}
