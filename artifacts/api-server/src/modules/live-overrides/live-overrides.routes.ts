import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import {
  LiveOverrideSchema,
  LiveStatusSchema,
  StartOverrideBodySchema,
} from "./live-overrides.schemas.js";
import { liveOverridesService } from "./live-overrides.service.js";
import { overrideBus } from "./override-bus.js";
import { broadcastEngine } from "../broadcast/queue.engine.js";

const ListResponseSchema = z.object({
  items: z.array(LiveOverrideSchema),
  total: z.number().int().nonnegative(),
});

export async function liveOverridesRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/status",
    {
      schema: {
        tags: ["live"],
        summary: "Public: is a live override currently active?",
        response: { 200: LiveStatusSchema },
      },
    },
    async () => liveOverridesService.getStatus(),
  );

  r.get(
    "/recent",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["live"],
        summary: "Admin: list recent live overrides for audit",
        response: { 200: ListResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => liveOverridesService.listRecent(),
  );

  r.post(
    "/start",
    {
      preHandler: requireAuth("editor"),
      // Fans out an SSE/WS PROGRAM_CHANGED signal to every connected client.
      // 5/min is ample for legitimate use; rapid starts would confuse viewers.
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["live"],
        summary: "Admin: start a live override (deactivates any prior)",
        body: StartOverrideBodySchema,
        response: { 201: LiveOverrideSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const created = await liveOverridesService.start(req.body);
      // Tell the v1 broadcast engine to reload — the /stop route already does
      // this; without it the engine keeps playing the queued item in the
      // background while the live override is active, potentially emitting
      // stale PROGRAM_CHANGED signals to connected clients.
      await broadcastEngine.reload().catch((err) =>
        req.log.warn({ err }, "live-overrides /start: broadcastEngine.reload() failed (non-fatal)"),
      );
      // Notify all connected WS and SSE clients so they switch to the live
      // stream immediately without waiting for their next poll cycle.
      overrideBus.notifyStarted({
        id: created.id,
        title: created.title,
        hlsStreamUrl: created.hlsStreamUrl,
        youtubeVideoId: created.youtubeVideoId,
        startedAt: created.startedAt,
        endsAt: created.endsAt,
      });
      reply.code(201);
      return created;
    },
  );

  r.post(
    "/stop",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["live"],
        summary: "Admin: stop the currently active live override",
        response: { 200: LiveOverrideSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const stopped = await liveOverridesService.stop();
      await broadcastEngine.reload();
      // Notify connected clients to fall back to the broadcast queue.
      overrideBus.notifyStopped();
      return stopped;
    },
  );

  r.post(
    "/extend",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["live"],
        summary: "Admin: extend the active live override's end time",
        // Cap at 12 h (720 min) — prevents a typo from scheduling an
        // override that will never auto-expire in any meaningful timeframe.
        body: z.object({ extraMinutes: z.number().int().positive().max(720) }),
        response: { 200: LiveOverrideSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const updated = await liveOverridesService.extend(req.body.extraMinutes);
      // Re-notify with the updated endsAt so clients that display a countdown
      // get an accurate end time pushed to them immediately.
      overrideBus.notifyStarted({
        id: updated.id,
        title: updated.title,
        hlsStreamUrl: updated.hlsStreamUrl,
        youtubeVideoId: updated.youtubeVideoId,
        startedAt: updated.startedAt,
        endsAt: updated.endsAt,
      });
      return updated;
    },
  );

  r.get(
    "/scheduled",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["live"],
        summary: "Admin: list upcoming scheduled live overrides",
        response: { 200: ListResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => liveOverridesService.listScheduled(),
  );

  r.post(
    "/schedule",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["live"],
        summary: "Admin: schedule a future live override",
        body: StartOverrideBodySchema,
        response: { 201: LiveOverrideSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const created = await liveOverridesService.schedule(req.body);
      reply.code(201);
      return created;
    },
  );

  r.delete(
    "/scheduled/:id",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["live"],
        summary: "Admin: cancel a scheduled (not yet active) override",
        params: z.object({ id: z.string().min(1).max(128) }),
        response: { 200: z.object({ ok: z.literal(true), id: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => liveOverridesService.cancelScheduled(req.params.id),
  );

  // ── POST /live/report-failure ─────────────────────────────────────────────
  // Mobile/TV clients call this when they detect a stream playback failure.
  // Logged for operator awareness; non-fatal — always returns 202.
  // No auth required so unauthenticated devices can still report failures.
  r.post(
    "/report-failure",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["live"],
        summary: "Client: report a stream playback failure",
        body: z.object({
          videoId: z.string().max(256).optional(),
          deviceId: z.string().max(128).optional(),
          surface: z.enum(["mobile", "tv", "web"]).optional(),
          errorCode: z.string().max(64).optional(),
          errorMessage: z.string().max(1024).optional(),
        }),
        response: { 202: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req, reply) => {
      req.log.warn(
        { body: req.body },
        "[live] client reported stream failure",
      );
      reply.code(202);
      return { ok: true as const };
    },
  );
}
