import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AddQueueItemSchema,
  BroadcastSnapshotSchema,
  ReorderQueueSchema,
} from "./broadcast.schemas.js";
import { broadcastService } from "./broadcast.service.js";
import { broadcastEngine } from "./queue.engine.js";
import { requireAuth } from "../../middleware/auth.js";

export async function broadcastRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/current",
    {
      schema: {
        tags: ["broadcast"],
        summary: "Current channel state — what is airing now and what's next",
        response: { 200: BroadcastSnapshotSchema },
      },
    },
    async () => broadcastService.snapshot(),
  );

  r.get(
    "/queue",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["broadcast"],
        summary: "Admin: list every program in the queue (active + inactive)",
        security: [{ bearerAuth: [] }],
      },
    },
    async () => broadcastService.listQueue(),
  );

  r.post(
    "/queue",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["broadcast"],
        summary: "Admin: append a program to the queue",
        body: AddQueueItemSchema,
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const created = await broadcastService.addToQueue(req.body);
      reply.code(201);
      return created;
    },
  );

  r.delete(
    "/queue/:id",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["broadcast"],
        summary: "Admin: remove a program from the queue",
        params: z.object({ id: z.string() }),
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => broadcastService.removeFromQueue(req.params.id),
  );

  r.post(
    "/queue/reorder",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["broadcast"],
        summary: "Admin: reorder the active queue",
        body: ReorderQueueSchema,
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => broadcastService.reorder(req.body.itemIds),
  );

  r.patch(
    "/queue/:id/active",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["broadcast"],
        summary: "Admin: toggle whether a queue item is in rotation",
        params: z.object({ id: z.string() }),
        body: z.object({ isActive: z.boolean() }),
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => broadcastService.toggleActive(req.params.id, req.body.isActive),
  );

  r.get(
    "/viewers",
    {
      schema: {
        tags: ["broadcast"],
        summary: "Live viewer count for the channel",
        response: {
          200: z.object({ channelId: z.string(), count: z.number().int().nonnegative() }),
        },
      },
    },
    async () => ({ channelId: broadcastEngine.channelId, count: broadcastEngine.getViewerCount() }),
  );

  // ── Guide / EPG ─────────────────────────────────────────────────────────
  // Lightweight EPG projection of the broadcast snapshot — what the TV
  // bundle's `useGuide()` polls to populate the channel guide overlay.
  // We use the engine's existing `upcoming` projection (already 5 items
  // forward) and stitch `current` onto the front, so the wire shape is
  // a flat list of programs with absolute start/end timestamps the
  // client can sort and group by hour.

  const GuideEntrySchema = z.object({
    id: z.string(),
    title: z.string(),
    thumbnailUrl: z.string(),
    durationSecs: z.number().int().positive(),
    startsAt: z.string(),
    endsAt: z.string(),
    isCurrent: z.boolean(),
  });
  const GuideResponseSchema = z.object({
    channelId: z.string(),
    generatedAt: z.string(),
    entries: z.array(GuideEntrySchema),
  });

  r.get(
    "/guide",
    {
      schema: {
        tags: ["broadcast"],
        summary: "Channel guide — current + upcoming programs",
        response: { 200: GuideResponseSchema },
      },
    },
    async () => {
      const snap = broadcastService.snapshot();
      const entries: z.infer<typeof GuideEntrySchema>[] = [];
      if (snap.current) {
        entries.push({
          id: snap.current.id,
          title: snap.current.title,
          thumbnailUrl: snap.current.thumbnailUrl,
          durationSecs: snap.current.durationSecs,
          startsAt: snap.current.startsAt,
          endsAt: snap.current.endsAt,
          isCurrent: true,
        });
      }
      for (const it of snap.upcoming) {
        entries.push({
          id: it.id,
          title: it.title,
          thumbnailUrl: it.thumbnailUrl,
          durationSecs: it.durationSecs,
          startsAt: it.startsAt,
          endsAt: it.endsAt,
          isCurrent: false,
        });
      }
      return {
        channelId: snap.channelId,
        generatedAt: snap.generatedAt,
        entries,
      };
    },
  );

  // ── Playback-quality telemetry ──────────────────────────────────────────
  // The TV's `HlsVideoPlayer` POSTs periodic playback-health samples
  // (buffer level, dropped frames, bitrate, stalls) to this endpoint.
  // We log them through the request logger — same firehose pattern as
  // `/client-errors` — and ack 202. No DB write; aggregates can be
  // computed by tailing the structured logs.

  const PlaybackTelemetrySchema = z
    .object({
      videoId: z.string().max(256).optional(),
      sessionId: z.string().max(128).optional(),
      platform: z.string().max(32).optional(),
      bufferedSecs: z.number().nonnegative().optional(),
      droppedFrames: z.number().int().nonnegative().optional(),
      bitrateKbps: z.number().nonnegative().optional(),
      stalls: z.number().int().nonnegative().optional(),
      currentTimeSecs: z.number().nonnegative().optional(),
      occurredAt: z.string().datetime().optional(),
    })
    .passthrough();

  r.post(
    "/playback-telemetry",
    {
      schema: {
        tags: ["broadcast"],
        summary: "Ingest a playback-quality sample from a TV/mobile client",
        body: PlaybackTelemetrySchema,
        response: {
          202: z.object({ ok: z.literal(true), receivedAt: z.string() }),
        },
      },
    },
    async (req, reply) => {
      req.log.info({ playbackTelemetry: req.body }, "[playback-telemetry]");
      reply.code(202);
      return { ok: true as const, receivedAt: new Date().toISOString() };
    },
  );
}
