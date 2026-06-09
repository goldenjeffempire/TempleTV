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

export async function midnightPrayersRoutes(app: FastifyInstance) {

  // ── GET /state ────────────────────────────────────────────────────────────
  // Compatible with V2Transport: returns { state: V2Snapshot }.
  // Accepts ?epochMs=<number> so each viewer can request a cycle anchored to
  // their own local midnight — the server stays stateless w.r.t. timezone.
  app.get("/state", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const query = req.query as Record<string, string>;
    const epochMs = query["epochMs"] ? Number(query["epochMs"]) : undefined;
    const snapshot = midnightPrayersService.getSnapshot(epochMs);
    return reply.send({ state: snapshot });
  });

  // ── GET /config ───────────────────────────────────────────────────────────
  // Public: clients need this to decide whether / when to switch channel.
  app.get("/config", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (_req, reply) => {
    return reply.send(midnightPrayersService.getConfig());
  });

  // ── PATCH /config ─────────────────────────────────────────────────────────
  const PatchConfigBody = z.object({
    enabled:   z.boolean().optional(),
    startHour: z.number().int().min(0).max(23).optional(),
    endHour:   z.number().int().min(1).max(24).optional(),
    timezone:  z.string().min(1).max(100).optional(),
  });

  app.patch("/config", { ...editorGuard, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const result = PatchConfigBody.safeParse(req.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Invalid config", details: result.error.flatten() });
    }
    const updated = await midnightPrayersService.saveConfig(result.data);
    return reply.send(updated);
  });

  // ── GET /queue ────────────────────────────────────────────────────────────
  app.get("/queue", { ...editorGuard, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (_req, reply) => {
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
  app.post("/queue/refresh", { ...editorGuard, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (_req, reply) => {
    await midnightPrayersService.loadVideos();
    const videos = midnightPrayersService.getVideos();
    return reply.send({ ok: true, videoCount: videos.length });
  });

  // ── GET /events (SSE) ─────────────────────────────────────────────────────
  // Compatible with V2Transport SSE path.
  // Rate-limit the initial connection (30/min per IP) to prevent SSE exhaustion.
  app.get("/events", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type":    "text/event-stream",
      "Cache-Control":   "no-cache, no-transform",
      Connection:        "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const query = req.query as Record<string, string>;
    const epochMs = query["epochMs"] ? Number(query["epochMs"]) : undefined;

    const send = (frame: MPServerFrame) => {
      try {
        const seq = "sequence" in frame ? frame.sequence : Date.now();
        reply.raw.write(`id: ${seq}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
      } catch { /* client gone */ }
    };

    // Immediately send hello + current snapshot
    const snapshot = midnightPrayersService.getSnapshot(epochMs);
    send({ type: "hello", serverTimeMs: Date.now(), sequence: snapshot.sequence });
    send({ type: "snapshot", sequence: snapshot.sequence, state: snapshot });

    const unsubscribe = midnightPrayersService.subscribeSSE(send);

    req.raw.on("close", () => {
      unsubscribe();
    });

    // Keep the handler alive (Fastify won't auto-close the stream)
    await new Promise<void>((resolve) => {
      req.raw.on("close", resolve);
    });
  });

  // ── GET /ws (WebSocket) ───────────────────────────────────────────────────
  // Compatible with V2Transport WS path.
  // Rate-limit the initial WS upgrade (30/min per IP) to prevent exhaustion.
  app.get("/ws", { websocket: true, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, (socket, req) => {
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
