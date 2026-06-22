/**
 * Viewer Tracking Routes
 *
 * POST /viewer-tracking/heartbeat   — unauthenticated, rate-limited
 *   Called every ~10 s by every active player (TV, mobile, web).
 *   No DB write — pure Redis.
 *
 * GET  /viewer-tracking/stats       — requireAuth("editor")
 *   Returns current viewer counts, peak, and 5-min trend per stream.
 *
 * GET  /viewer-tracking/stats/:streamId — requireAuth("editor")
 *   Per-stream view.
 */

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { viewerTrackingService } from "./viewer-tracking.service.js";

const HeartbeatBodySchema = z.object({
  sessionId: z.string().min(1).max(128),
  streamId:  z.string().min(1).max(128),
  userId:    z.string().min(1).max(128).optional(),
  platform:  z.enum(["tv", "mobile", "web"]).optional(),
  clientTs:  z.number().int().nonnegative().optional(),
});

const TrendPointSchema = z.object({
  ts:    z.number(),
  count: z.number(),
});

const ViewerStatsSchema = z.object({
  streamId:    z.string(),
  current:     z.number(),
  peak:        z.number(),
  trend:       z.array(TrendPointSchema),
  updatedAtMs: z.number(),
});

const AggregateStatsSchema = z.object({
  streams:      z.array(ViewerStatsSchema),
  totalCurrent: z.number(),
  totalPeak:    z.number(),
});

const HeartbeatResponseSchema = z.object({
  ok:           z.boolean(),
  viewers:      z.number(),
  isNewSession: z.boolean(),
  streamId:     z.string(),
});

export async function viewerTrackingRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── POST /viewer-tracking/heartbeat ────────────────────────────────────
  // High-frequency endpoint — every active viewer calls this every ~10 s.
  // Rate-limited at 60/min per IP (ample for 10 streams × 1 hb/6s).
  // Intentionally public (no auth) — players are anonymous on TV/web.
  r.post(
    "/heartbeat",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
      schema: {
        tags: ["viewer-tracking"],
        summary: "Record a viewer heartbeat. Called every ~10 s by active players. No DB write — Redis only.",
        body: HeartbeatBodySchema,
        response: {
          200: HeartbeatResponseSchema,
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const { viewers, isNewSession } = await viewerTrackingService.heartbeat(req.body);
      return reply.code(200).send({
        ok:           true,
        viewers,
        isNewSession,
        streamId:     req.body.streamId,
      });
    },
  );

  // ── GET /viewer-tracking/stats ──────────────────────────────────────────
  // Aggregate across all known streams.
  r.get(
    "/stats",
    {
      preHandler: [requireAuth("editor")],
      schema: {
        tags: ["viewer-tracking"],
        summary: "Aggregate viewer stats across all streams — current, peak, 5-min trend.",
        response: {
          200: AggregateStatsSchema,
        },
      },
    },
    async (_req, reply) => {
      const stats = await viewerTrackingService.getStats();
      return reply.code(200).send(stats);
    },
  );

  // ── GET /viewer-tracking/stats/:streamId ────────────────────────────────
  r.get(
    "/stats/:streamId",
    {
      preHandler: [requireAuth("editor")],
      schema: {
        tags: ["viewer-tracking"],
        summary: "Per-stream viewer stats — current, peak, 5-min trend.",
        params: z.object({ streamId: z.string().min(1).max(128) }),
        response: {
          200: AggregateStatsSchema,
        },
      },
    },
    async (req, reply) => {
      const stats = await viewerTrackingService.getStats(req.params.streamId);
      return reply.code(200).send(stats);
    },
  );
}
