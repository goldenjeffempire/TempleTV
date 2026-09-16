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
import { attachPrincipal, requireAuth } from "../../middleware/auth.js";
import { viewerTrackingService } from "./viewer-tracking.service.js";
import { broadcastEngine } from "../broadcast/queue.engine.js";

const HeartbeatBodySchema = z.object({
  sessionId: z.string().min(1).max(128),
  streamId:  z.string().min(1).max(128),
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

  // There is currently one supported public broadcast stream. Keeping this
  // allowlist server-side prevents arbitrary Redis namespaces/count inflation.
  const supportedStream = broadcastEngine.channelId;
  const IssueBodySchema = z.object({
    streamId: z.literal(supportedStream),
    platform: z.enum(["tv", "mobile", "web"]).optional(),
  });
  const CredentialResponseSchema = z.object({
    sessionId: z.string(),
    streamId: z.literal(supportedStream),
  });

  r.post("/issue", {
    preHandler: [attachPrincipal()],
    config: {
      // Anonymous viewers need a credential, but issuance must not be an
      // unlimited session-minting endpoint. Heartbeats remain independently
      // validated against the issued opaque credential.
      rateLimit: { max: 30, timeWindow: "1 minute" },
    },
    schema: {
      tags: ["viewer-tracking"],
      summary: "Issue an opaque viewer session credential",
      body: IssueBodySchema,
      response: {
        200: CredentialResponseSchema,
        429: z.object({ error: z.string() }),
      },
    },
  }, async (req, reply) => {
    const sessionId = await viewerTrackingService.issueCredential(req.principal?.id);
    return reply.code(200).send({ sessionId, streamId: req.body.streamId });
  });

  // ── POST /viewer-tracking/heartbeat ────────────────────────────────────
  // High-frequency endpoint — every active viewer calls this every ~10 s.
  // Rate-limited as abuse defense in depth; the opaque credential remains the
  // authority and prevents callers from inventing identities or stream IDs.
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
          400: z.object({ error: z.string() }),
          401: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      if (req.body.streamId !== supportedStream) {
        return reply.code(400).send({ error: "Unsupported broadcast stream" });
      }
      let result: { viewers: number; isNewSession: boolean };
      try {
        result = await viewerTrackingService.heartbeat(req.body);
      } catch {
        return reply.code(401).send({ error: "Invalid or expired viewer session credential" });
      }
      const { viewers, isNewSession } = result;
      return reply.code(200).send({
        ok:           true,
        viewers,
        isNewSession,
        streamId:     req.body.streamId,
      });
    },
  );

  r.post("/leave", {
    schema: {
      tags: ["viewer-tracking"],
      body: z.object({ sessionId: z.string().min(1).max(128), streamId: z.literal(supportedStream) }),
      response: {
        204: z.null(),
        401: z.object({ error: z.string() }),
      },
    },
  }, async (req, reply) => {
    try {
      await viewerTrackingService.leave(req.body.sessionId, req.body.streamId);
    } catch {
      return reply.code(401).send({ error: "Invalid or expired viewer session credential" });
    }
    return reply.code(204).send(null);
  });

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
