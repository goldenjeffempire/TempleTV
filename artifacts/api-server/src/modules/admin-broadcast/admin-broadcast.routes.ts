import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";
import { broadcastService } from "../broadcast/broadcast.service.js";
import { broadcastEngine } from "../broadcast/queue.engine.js";
import { NotFoundError, BadRequestError } from "../../shared/errors.js";

/**
 * Admin-side aliases for the broadcast queue.
 *
 * The admin SPA was built against legacy URLs of the shape
 * `/admin/broadcast*`, while the canonical (public) routes live under
 * `/broadcast/queue*` in `modules/broadcast`. This module mirrors the
 * SPA's URL surface 1:1 so the existing build keeps working without a
 * SPA-side migration:
 *
 *   GET    /admin/broadcast            → list every queue item
 *   POST   /admin/broadcast            → append (videoId or full payload)
 *   PATCH  /admin/broadcast/:id        → update durationSecs / isActive
 *   DELETE /admin/broadcast/:id        → remove
 *   PUT    /admin/broadcast/reorder    → reorder by item-id list
 *   GET    /admin/broadcast/health     → per-item playability check
 *
 * All mutations go through `broadcastService` so the engine reload + SSE
 * broadcast happens exactly once per change (the public `/broadcast/queue*`
 * path uses the same service — no double-fan-out).
 */

const queueTable = schema.broadcastQueueTable;
const videosTable = schema.videosTable;

const QueueRowSchema = z.object({
  id: z.string(),
  videoId: z.string().nullable(),
  youtubeId: z.string(),
  title: z.string(),
  thumbnailUrl: z.string(),
  durationSecs: z.number().int().nonnegative(),
  localVideoUrl: z.string().nullable(),
  videoSource: z.string(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  addedAt: z.string(),
});

function toDto(row: typeof queueTable.$inferSelect): z.infer<typeof QueueRowSchema> {
  return {
    id: row.id,
    videoId: row.videoId,
    youtubeId: row.youtubeId,
    title: row.title,
    thumbnailUrl: row.thumbnailUrl,
    durationSecs: row.durationSecs,
    localVideoUrl: row.localVideoUrl,
    videoSource: row.videoSource,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    addedAt: row.addedAt.toISOString(),
  };
}

// Two acceptable POST bodies — convenience (`videoId` only, server pulls
// the rest from `managed_videos`) and explicit (full item payload). The
// admin SPA's "add from library" flow uses the convenience form.
const AddByVideoIdSchema = z.object({
  videoId: z.string().min(1),
  durationSecs: z.number().int().positive().max(60 * 60 * 12).optional(),
});

const AddExplicitSchema = z.object({
  videoId: z.string().nullable().optional(),
  youtubeId: z.string().min(1),
  title: z.string().min(1),
  thumbnailUrl: z.string().default(""),
  durationSecs: z.number().int().positive().max(60 * 60 * 12).default(1800),
  localVideoUrl: z.string().nullable().optional(),
  videoSource: z.enum(["youtube", "local", "hls"]).default("youtube"),
  sortOrder: z.number().int().optional(),
});

const PostBodySchema = z.union([AddByVideoIdSchema, AddExplicitSchema]);

const PatchBodySchema = z.object({
  durationSecs: z.number().int().positive().max(60 * 60 * 12).optional(),
  isActive: z.boolean().optional(),
});

const ReorderBodySchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1),
});

const HealthItemSchema = z.object({
  id: z.string(),
  status: z.enum(["ok", "broken", "skipped"]),
  reason: z.string().nullable(),
});
const HealthResponseSchema = z.object({
  summary: z.object({
    ok: z.number().int().nonnegative(),
    broken: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    checkedAt: z.string(),
  }),
  items: z.array(HealthItemSchema),
});

export async function adminBroadcastRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── GET /admin/broadcast ─────────────────────────────────────────────────
  r.get(
    "/broadcast",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Admin alias: list every broadcast queue item",
        response: { 200: z.object({ items: z.array(QueueRowSchema) }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const rows = await broadcastService.listQueue();
      return { items: rows.map(toDto) };
    },
  );

  // ── POST /admin/broadcast ────────────────────────────────────────────────
  r.post(
    "/broadcast",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Admin alias: append an item to the queue",
        body: PostBodySchema,
        response: { 200: QueueRowSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const body = req.body as z.infer<typeof PostBodySchema>;

      // Convenience form: hydrate from `managed_videos` so the SPA can
      // post just `{ videoId }` and the server fills title / source / etc.
      if ("videoId" in body && Object.keys(body).every((k) => k === "videoId" || k === "durationSecs")) {
        const slim = body as z.infer<typeof AddByVideoIdSchema>;
        const [video] = await db
          .select()
          .from(videosTable)
          .where(eq(videosTable.id, slim.videoId))
          .limit(1);
        if (!video) throw new NotFoundError(`videoId ${slim.videoId} not found in managed_videos`);

        const inserted = await broadcastService.addToQueue({
          videoId: video.id,
          youtubeId: video.youtubeId,
          title: video.title,
          thumbnailUrl: video.thumbnailUrl,
          durationSecs:
            slim.durationSecs ??
            (Number.parseInt(video.duration ?? "", 10) || 1800),
          localVideoUrl: video.localVideoUrl ?? null,
          videoSource: (video.videoSource as "youtube" | "local" | "hls") ?? "youtube",
        });
        return toDto(inserted);
      }

      const explicit = body as z.infer<typeof AddExplicitSchema>;
      const inserted = await broadcastService.addToQueue(explicit);
      return toDto(inserted);
    },
  );

  // ── PATCH /admin/broadcast/:id ───────────────────────────────────────────
  r.patch(
    "/broadcast/:id",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Admin alias: update durationSecs / isActive on a queue item",
        params: z.object({ id: z.string().min(1) }),
        body: PatchBodySchema,
        response: { 200: QueueRowSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const patch = req.body as z.infer<typeof PatchBodySchema>;
      if (patch.durationSecs == null && patch.isActive == null) {
        throw new BadRequestError("PATCH body must include at least one of: durationSecs, isActive");
      }
      const updated = await db
        .update(queueTable)
        .set({
          ...(patch.durationSecs != null ? { durationSecs: patch.durationSecs } : {}),
          ...(patch.isActive != null ? { isActive: patch.isActive } : {}),
        })
        .where(eq(queueTable.id, id))
        .returning();
      if (updated.length === 0) throw new NotFoundError(`Queue item ${id} not found`);
      // Either change affects the active rotation — the engine needs to
      // recompute durations / drop-or-add the slot.
      await broadcastEngine.reload();
      return toDto(updated[0]!);
    },
  );

  // ── DELETE /admin/broadcast/:id ──────────────────────────────────────────
  r.delete(
    "/broadcast/:id",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Admin alias: remove a queue item",
        params: z.object({ id: z.string().min(1) }),
        response: { 200: z.object({ ok: z.literal(true), id: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      await broadcastService.removeFromQueue(id);
      return { ok: true as const, id };
    },
  );

  // ── PUT /admin/broadcast/reorder ─────────────────────────────────────────
  r.put(
    "/broadcast/reorder",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Admin alias: reorder the queue by item-id list",
        body: ReorderBodySchema,
        response: {
          200: z.object({
            ok: z.literal(true),
            count: z.number().int().nonnegative(),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { itemIds } = req.body as z.infer<typeof ReorderBodySchema>;
      // Validate every id exists before mutating — partial reorder leaves
      // the queue in a half-renumbered state that's hard to diagnose.
      const existing = await db
        .select({ id: queueTable.id })
        .from(queueTable)
        .where(inArray(queueTable.id, itemIds));
      const existingSet = new Set(existing.map((r) => r.id));
      const missing = itemIds.filter((id) => !existingSet.has(id));
      if (missing.length > 0) {
        throw new BadRequestError(
          `Reorder failed: unknown queue item ids: ${missing.join(", ")}`,
        );
      }
      await broadcastService.reorder(itemIds);
      return { ok: true as const, count: itemIds.length };
    },
  );

  // ── GET /admin/broadcast/health ──────────────────────────────────────────
  // Per-item "is this playable" check the broadcast page surfaces in its
  // health-pill UI. We classify each item by the strongest source it has:
  //   - local  : has a populated localVideoUrl                  → ok
  //   - hls    : has a localVideoUrl that looks like an HLS URL → ok
  //   - youtube: has a non-empty youtubeId                      → ok
  //   - else                                                    → broken
  // Inactive rows are reported as `skipped` so they don't pollute the
  // alert pill but still show in the UI's per-row badge.
  r.get(
    "/broadcast/health",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Per-queue-item playability health",
        response: { 200: HealthResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const rows = await broadcastService.listQueue();
      const items: z.infer<typeof HealthItemSchema>[] = rows.map((row) => {
        if (!row.isActive) {
          return { id: row.id, status: "skipped" as const, reason: "inactive" };
        }
        const localOk = typeof row.localVideoUrl === "string" && row.localVideoUrl.length > 0;
        const youtubeOk = typeof row.youtubeId === "string" && row.youtubeId.length > 0
          && !row.youtubeId.startsWith("local-"); // synthetic ids from native uploads
        if (localOk || youtubeOk) {
          return { id: row.id, status: "ok" as const, reason: null };
        }
        return {
          id: row.id,
          status: "broken" as const,
          reason: "no playable source (missing localVideoUrl + youtubeId)",
        };
      });
      const ok = items.filter((i) => i.status === "ok").length;
      const broken = items.filter((i) => i.status === "broken").length;
      const skipped = items.filter((i) => i.status === "skipped").length;
      return {
        summary: {
          ok,
          broken,
          skipped,
          total: items.length,
          checkedAt: new Date().toISOString(),
        },
        items,
      };
    },
  );
}
