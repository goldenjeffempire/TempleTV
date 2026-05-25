import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq, inArray, and } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";
import { broadcastService } from "../broadcast/broadcast.service.js";
import { broadcastEngine } from "../broadcast/queue.engine.js";
import { clearSuspended, clearBadUrl } from "../broadcast-v2/repository/queue.repo.js";
import { NotFoundError, BadRequestError } from "../../shared/errors.js";
import { boostTranscodePriority } from "../transcoder/transcoder.queue.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { logger } from "../../infrastructure/logger.js";

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
  youtubeId: z.string().nullable(),
  title: z.string(),
  thumbnailUrl: z.string(),
  durationSecs: z.number().int().nonnegative(),
  localVideoUrl: z.string().nullable(),
  videoSource: z.string(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  addedAt: z.string(),
  /** Transcoding pipeline status ('queued' | 'encoding' | 'hls_ready' | 'failed' | null). */
  transcodingStatus: z.string().nullable(),
  /** True when the video has a complete HLS master playlist ready to stream. */
  hasHls: z.boolean(),
  /** Error message from the last failed transcoding job, or null when not failed. */
  transcodingError: z.string().nullable(),
});

/** Queue row optionally enriched with HLS + job error fields. */
type EnrichedQueueRow = typeof queueTable.$inferSelect & {
  transcodingStatus?: string | null | undefined;
  hlsMasterUrl?: string | null | undefined;
  transcodingError?: string | null | undefined;
};

function toDto(row: EnrichedQueueRow): z.infer<typeof QueueRowSchema> {
  return {
    id: row.id,
    videoId: row.videoId,
    youtubeId: row.youtubeId,
    title: row.title,
    // DB column is nullable; coerce null → "" so z.string() serializer never throws 500.
    thumbnailUrl: row.thumbnailUrl ?? "",
    durationSecs: row.durationSecs,
    localVideoUrl: row.localVideoUrl,
    videoSource: row.videoSource,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    addedAt: row.addedAt.toISOString(),
    transcodingStatus: row.transcodingStatus ?? null,
    hasHls: !!(row.hlsMasterUrl),
    transcodingError: row.transcodingError ?? null,
  };
}

// Two acceptable POST bodies — convenience (`videoId` only, server pulls
// the rest from `managed_videos`) and explicit (full item payload). The
// admin SPA's "add from library" flow uses the convenience form.
const AddByVideoIdSchema = z.object({
  videoId: z.string().min(1),
  durationSecs: z.number().int().positive().max(60 * 60 * 12).optional(),
  /**
   * When true, skip the "transcoding in flight" rejection. The row is
   * inserted immediately; the v2 orchestrator's loadActive() WHERE clause
   * will silently exclude it until HLS lands, at which point the
   * transcoder's `broadcast-queue-updated` event triggers a reload that
   * picks it up. Used by the upload-and-auto-queue flow on the broadcast
   * page so freshly uploaded videos appear in the admin queue list right
   * away instead of failing with a "wait for transcoding" error.
   */
  allowPending: z.boolean().optional(),
});

const AddExplicitSchema = z.object({
  videoId: z.string().nullable().optional(),
  youtubeId: z.string().min(1).nullable().optional(),
  title: z.string().min(1).max(500),
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
      // Enrich each row with HLS readiness data from managed_videos.
      // One batched IN query is far cheaper than N individual lookups.
      const videoIds = rows.filter((r) => r.videoId).map((r) => r.videoId!);
      const hlsMap = new Map<string, { transcodingStatus: string | null; hlsMasterUrl: string | null; transcodingError: string | null }>();
      if (videoIds.length > 0) {
        const vids = await db
          .select({
            id: videosTable.id,
            transcodingStatus: videosTable.transcodingStatus,
            hlsMasterUrl: videosTable.hlsMasterUrl,
          })
          .from(videosTable)
          .where(inArray(videosTable.id, videoIds));
        for (const v of vids) {
          hlsMap.set(v.id, { transcodingStatus: v.transcodingStatus, hlsMasterUrl: v.hlsMasterUrl, transcodingError: null });
        }

        // For items whose transcoding_status is 'failed', fetch the last error
        // message from the transcoding_jobs table so the admin UI can surface it
        // in the "HLS failed" badge tooltip and offer a one-click Retry.
        const failedVideoIds = vids
          .filter((v) => v.transcodingStatus === "failed")
          .map((v) => v.id);
        if (failedVideoIds.length > 0) {
          const jobsTable = schema.transcodingJobsTable;
          const failedJobs = await db
            .select({ videoId: jobsTable.videoId, errorMessage: jobsTable.errorMessage })
            .from(jobsTable)
            .where(and(inArray(jobsTable.videoId, failedVideoIds), eq(jobsTable.status, "failed")));
          for (const j of failedJobs) {
            const existing = hlsMap.get(j.videoId);
            if (existing && j.errorMessage) {
              existing.transcodingError = j.errorMessage;
            }
          }
        }
      }
      return {
        items: rows.map((row) =>
          toDto({ ...row, ...(row.videoId ? (hlsMap.get(row.videoId) ?? {}) : {}) }),
        ),
      };
    },
  );

  // ── POST /admin/broadcast ────────────────────────────────────────────────
  r.post(
    "/broadcast",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["admin"],
        summary: "Admin alias: append an item to the queue",
        body: PostBodySchema,
        response: { 200: QueueRowSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const body = req.body;

      // Convenience form: hydrate from `managed_videos` so the SPA can
      // post just `{ videoId }` and the server fills title / source / etc.
      if (
        "videoId" in body &&
        Object.keys(body).every(
          (k) => k === "videoId" || k === "durationSecs" || k === "allowPending",
        )
      ) {
        const slim = body as z.infer<typeof AddByVideoIdSchema>;
        const [video] = await db
          .select()
          .from(videosTable)
          .where(eq(videosTable.id, slim.videoId))
          .limit(1);
        if (!video) throw new NotFoundError(`videoId ${slim.videoId} not found in managed_videos`);

        // ── Dedupe ───────────────────────────────────────────────────────
        // If this videoId is already in the queue, return the existing row
        // instead of creating a duplicate. The admin UI sees a normal 200
        // response and refreshes — exactly what they'd want either way.
        // Prevents accidental dup-add from rapid double-clicks, retries of
        // the upload auto-queue path, or re-adding from the library picker.
        const [existing] = await db
          .select()
          .from(queueTable)
          .where(eq(queueTable.videoId, slim.videoId))
          .limit(1);
        if (existing) {
          const existingHls = await db
            .select({ transcodingStatus: videosTable.transcodingStatus, hlsMasterUrl: videosTable.hlsMasterUrl })
            .from(videosTable)
            .where(eq(videosTable.id, slim.videoId))
            .then((r) => r[0]);
          return toDto({ ...existing, ...existingHls });
        }

        // Enforce strict READY-only broadcast pipeline: block any video whose
        // asset is in an in-flight transcoding state AND has no HLS master URL.
        // During 'queued' the raw blob is pre-faststart (not seekable from byte 0).
        // During 'encoding' ffmpeg may be mid-rewrite (corrupt partial reads).
        // During 'processing' the moov-atom relocation causes a transient 404.
        // The v2 orchestrator's loadActive() WHERE clause would silently exclude
        // the item anyway — we surface the error here so the admin knows immediately.
        //
        // Exception: `allowPending` bypasses this guard. Used by the
        // upload-and-auto-queue flow where we *want* the row to appear in
        // the queue list immediately. The transcoder will fire
        // `broadcast-queue-updated` when HLS lands, which triggers an
        // orchestrator reload that starts airing it.
        const inFlightStates = ["queued", "encoding", "processing"] as const;
        if (
          !slim.allowPending &&
          video.videoSource !== "youtube" &&
          inFlightStates.includes(video.transcodingStatus as (typeof inFlightStates)[number]) &&
          !video.hlsMasterUrl
        ) {
          throw new BadRequestError(
            `Video "${video.title}" is currently ${video.transcodingStatus} — ` +
              "wait for transcoding to complete before adding it to the broadcast queue.",
          );
        }

        const inserted = await broadcastService.addToQueue({
          videoId: video.id,
          youtubeId: video.youtubeId ?? "",
          title: video.title,
          // Coerce null → "" — AddQueueItemSchema.thumbnailUrl is z.string()
          // (non-nullable) and the DB column may also be NOT NULL.
          thumbnailUrl: video.thumbnailUrl ?? "",
          durationSecs:
            slim.durationSecs ??
            (Number.parseFloat(video.duration ?? "") || 1800),
          localVideoUrl: video.localVideoUrl ?? null,
          videoSource: (video.videoSource as "youtube" | "local" | "hls") ?? "youtube",
        });
        // Boost transcoding priority so broadcast-queue items get HLS encoded
        // ahead of library videos that are not yet in the active rotation.
        if (inserted.videoId) {
          void boostTranscodePriority(inserted.videoId, 10);
        }
        const hlsById = inserted.videoId
          ? await db
              .select({ transcodingStatus: videosTable.transcodingStatus, hlsMasterUrl: videosTable.hlsMasterUrl })
              .from(videosTable)
              .where(eq(videosTable.id, inserted.videoId))
              .then((r) => r[0])
          : undefined;
        return toDto({ ...inserted, ...hlsById });
      }

      const explicit = body as z.infer<typeof AddExplicitSchema>;
      // Also guard the explicit path when a videoId resolves to a managed
      // platform video that is still in an in-flight transcoding state.
      if (explicit.videoId && explicit.videoSource !== "youtube") {
        const [vid] = await db
          .select({ transcodingStatus: videosTable.transcodingStatus, hlsMasterUrl: videosTable.hlsMasterUrl, title: videosTable.title })
          .from(videosTable)
          .where(eq(videosTable.id, explicit.videoId))
          .limit(1);
        const inFlightStates = ["queued", "encoding", "processing"] as const;
        if (
          vid &&
          inFlightStates.includes(vid.transcodingStatus as (typeof inFlightStates)[number]) &&
          !vid.hlsMasterUrl
        ) {
          throw new BadRequestError(
            `Video "${vid.title}" is currently ${vid.transcodingStatus} — ` +
              "wait for transcoding to complete before adding it to the broadcast queue.",
          );
        }
      }
      const insertedExplicit = await broadcastService.addToQueue(explicit);
      if (insertedExplicit.videoId) {
        void boostTranscodePriority(insertedExplicit.videoId, 10);
      }
      const hlsExplicit = insertedExplicit.videoId
        ? await db
            .select({ transcodingStatus: videosTable.transcodingStatus, hlsMasterUrl: videosTable.hlsMasterUrl })
            .from(videosTable)
            .where(eq(videosTable.id, insertedExplicit.videoId))
            .then((r) => r[0])
        : undefined;
      return toDto({ ...insertedExplicit, ...hlsExplicit });
    },
  );

  // ── PATCH /admin/broadcast/:id ───────────────────────────────────────────
  r.patch(
    "/broadcast/:id",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
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
      const { id } = req.params;
      const patch = req.body;
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
      // When an operator re-enables a previously auto-suspended item:
      //  1. Clear the in-memory skip counter + recentlySuspended list.
      //  2. Clear the bad-URL cache for the item's localVideoUrl so the item
      //     can air on the very next orchestrator tick rather than waiting for
      //     the 5-min suspension TTL to expire on its own.
      if (patch.isActive === true) {
        clearSuspended(id);
        const url = updated[0]!.localVideoUrl;
        if (url) clearBadUrl(url);
      }
      // Either change affects the active rotation — both engines need to reload.
      // V1: broadcastEngine.reload() recomputes the queue snapshot.
      // V2: adminEventBus fires the bus bridge that calls orchestrator.reload().
      await broadcastEngine.reload();
      adminEventBus.push("broadcast-queue-updated", { reason: "item-patched", id });
      const patchRow = updated[0]!;
      const patchHls = patchRow.videoId
        ? await db
            .select({ transcodingStatus: videosTable.transcodingStatus, hlsMasterUrl: videosTable.hlsMasterUrl })
            .from(videosTable)
            .where(eq(videosTable.id, patchRow.videoId))
            .then((r) => r[0])
        : undefined;
      return toDto({ ...patchRow, ...patchHls });
    },
  );

  // ── DELETE /admin/broadcast/:id ──────────────────────────────────────────
  r.delete(
    "/broadcast/:id",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["admin"],
        summary: "Admin alias: remove a queue item",
        params: z.object({ id: z.string().min(1) }),
        response: {
          200: z.object({ ok: z.literal(true), id: z.string() }),
          404: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      try {
        await broadcastService.removeFromQueue(id);
      } catch (e: unknown) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404) return reply.code(404).send({ error: `Queue item not found: ${id}` });
        throw e;
      }
      return { ok: true as const, id };
    },
  );

  // ── PUT /admin/broadcast/reorder ─────────────────────────────────────────
  r.put(
    "/broadcast/reorder",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
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
      const { itemIds } = req.body;
      // Look up which IDs actually exist in the DB.
      const existing = await db
        .select({ id: queueTable.id })
        .from(queueTable)
        .where(inArray(queueTable.id, itemIds));
      const existingSet = new Set(existing.map((r) => r.id));
      const missing = itemIds.filter((id) => !existingSet.has(id));
      // Lenient mode: ignore unknown IDs rather than aborting. A race between
      // prod-sync upserts or a concurrent delete and the client's drag-reorder
      // can produce stale IDs in the payload. Throwing a hard 400 here forces
      // the admin to retry the whole operation; silently dropping the unknown
      // entries and reordering the rest is safe — sortOrder is relative.
      if (missing.length > 0) {
        logger.warn(
          { missing, total: itemIds.length },
          "[broadcast] reorder: ignoring unknown item ids (race condition or stale client state)",
        );
      }
      const filteredIds = itemIds.filter((id) => existingSet.has(id));
      if (filteredIds.length === 0) {
        throw new BadRequestError(
          "Reorder failed: none of the submitted item ids exist in the queue.",
        );
      }
      await broadcastService.reorder(filteredIds);
      return { ok: true as const, count: filteredIds.length };
    },
  );

  // ── GET /admin/broadcast/continuity ──────────────────────────────────────
  // Single-probe endpoint that surfaces the broadcast engine's internal
  // cycle timing so operators can verify that queue mutations (add/remove/
  // reorder) preserved the 24/7 position correctly.
  //
  // Response fields:
  //   checkedAt            — ISO timestamp of this response
  //   cycle.startedAt      — wall-clock anchor (set/preserved by reload())
  //   cycle.durationMs     — sum of all active item durations
  //   cycle.elapsedMs      — ms elapsed since cycle anchor
  //   cycle.progressPercent— how far through the cycle we are (0–100)
  //   engine.*             — timer and health flags
  //   current.*            — currently-airing item with live position
  //   msUntilTransition    — ms until the next PROGRAM_CHANGED fires
  //   upcoming             — next ≤5 items with projected start/end times
  r.get(
    "/broadcast/continuity",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Broadcast cycle continuity probe — wall-clock anchor, position, upcoming items",
        response: {
          200: z.object({
            checkedAt: z.string(),
            cycle: z.object({
              startedAt: z.string(),
              durationMs: z.number().int().nonnegative(),
              elapsedMs: z.number().int().nonnegative(),
              progressPercent: z.number().nonnegative(),
            }),
            engine: z.object({
              running: z.boolean(),
              timerArmed: z.boolean(),
              preloadTimerArmed: z.boolean(),
              lastSnapshotAgeMs: z.number().int().nonnegative(),
              healthy: z.boolean(),
              itemCount: z.number().int().nonnegative(),
            }),
            current: z
              .object({
                id: z.string(),
                title: z.string(),
                positionSecs: z.number().nonnegative(),
                totalSecs: z.number().nonnegative(),
                progressPercent: z.number().nonnegative(),
                startsAt: z.string(),
                endsAt: z.string(),
                msUntilTransition: z.number(),
                sourceKind: z.string().nullable(),
              })
              .nullable(),
            upcoming: z.array(
              z.object({
                position: z.number().int().nonnegative(),
                id: z.string(),
                title: z.string(),
                durationSecs: z.number().nonnegative(),
                startsAt: z.string(),
                endsAt: z.string(),
              }),
            ),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const now = Date.now();
      const cycleState = broadcastEngine.getContinuityState();
      const snap = broadcastEngine.snapshot();

      let current: null | {
        id: string;
        title: string;
        positionSecs: number;
        totalSecs: number;
        progressPercent: number;
        startsAt: string;
        endsAt: string;
        msUntilTransition: number;
        sourceKind: string | null;
      } = null;

      if (snap.current) {
        const endsAtMs = new Date(snap.current.endsAt).getTime();
        const startsAtMs = new Date(snap.current.startsAt).getTime();
        const totalMs = snap.current.durationSecs * 1000;
        const positionMs = now - startsAtMs;
        const positionSecs = Math.max(0, positionMs / 1000);
        const progressPercent =
          totalMs > 0 ? Math.round((positionMs / totalMs) * 10000) / 100 : 0;
        // Infer source kind: HLS master URL → "hls", local MP4 → "local", else "youtube"
        const sourceKind = snap.current.hlsMasterUrl
          ? "hls"
          : snap.current.localVideoUrl
            ? "local"
            : snap.current.youtubeId && !snap.current.youtubeId.startsWith("local-")
              ? "youtube"
              : null;
        current = {
          id: snap.current.id,
          title: snap.current.title,
          positionSecs: Math.round(positionSecs * 1000) / 1000,
          totalSecs: snap.current.durationSecs,
          progressPercent,
          startsAt: snap.current.startsAt,
          endsAt: snap.current.endsAt,
          msUntilTransition: endsAtMs - now,
          sourceKind,
        };
      }

      const upcoming = snap.upcoming.map((item, idx) => ({
        position: idx + 1,
        id: item.id,
        title: item.title,
        durationSecs: item.durationSecs,
        startsAt: item.startsAt,
        endsAt: item.endsAt,
      }));

      const healthy =
        cycleState.engineRunning &&
        cycleState.lastSnapshotAgeMs < 90_000 &&
        cycleState.timerArmed;

      return {
        checkedAt: new Date(now).toISOString(),
        cycle: {
          startedAt: cycleState.cycleStartedAt,
          durationMs: cycleState.cycleDurationMs,
          elapsedMs: cycleState.cycleElapsedMs,
          progressPercent: cycleState.cycleProgressPercent,
        },
        engine: {
          running: cycleState.engineRunning,
          timerArmed: cycleState.timerArmed,
          preloadTimerArmed: cycleState.preloadTimerArmed,
          lastSnapshotAgeMs: cycleState.lastSnapshotAgeMs,
          healthy,
          itemCount: cycleState.itemCount,
        },
        current,
        upcoming,
      };
    },
  );

  // ── GET /admin/broadcast/health ──────────────────────────────────────────
  // Per-item "is this playable" check the broadcast page surfaces in its
  // health-pill UI. We classify each item by the strongest source it has:
  //   - hls    : videoId's managed_video has a hlsMasterUrl     → ok (best)
  //   - local  : has a populated localVideoUrl                  → ok
  //   - youtube: has a non-empty, non-synthetic youtubeId       → ok
  //   - else                                                    → broken
  // Inactive rows are reported as `skipped` so they don't pollute the
  // alert pill but still show in the UI's per-row badge.
  //
  // We LEFT JOIN managed_videos to pick up hlsMasterUrl — the queue table
  // itself never stores it (it lives on the video record). An item whose
  // raw upload is still transcoding is still considered "ok" because
  // localVideoUrl is present; it just doesn't have HLS yet.
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
      // Join with managed_videos to get hlsMasterUrl for each item.
      const rows = await db
        .select({
          id: queueTable.id,
          videoId: queueTable.videoId,
          youtubeId: queueTable.youtubeId,
          localVideoUrl: queueTable.localVideoUrl,
          isActive: queueTable.isActive,
          hlsMasterUrl: videosTable.hlsMasterUrl,
        })
        .from(queueTable)
        .leftJoin(videosTable, eq(queueTable.videoId, videosTable.id))
        .orderBy(queueTable.sortOrder);

      const items: z.infer<typeof HealthItemSchema>[] = rows.map((row) => {
        if (!row.isActive) {
          return { id: row.id, status: "skipped" as const, reason: "inactive" };
        }
        // HLS master URL from the joined video row — strongest signal.
        const hlsOk = typeof row.hlsMasterUrl === "string" && row.hlsMasterUrl.length > 0;
        // Raw local upload URL on the queue row itself.
        const localOk = typeof row.localVideoUrl === "string" && row.localVideoUrl.length > 0;
        // Real YouTube videoId (exclude synthetic "local-…" ids used by native uploads).
        const youtubeOk = typeof row.youtubeId === "string" && row.youtubeId.length > 0
          && !row.youtubeId.startsWith("local-");

        if (hlsOk || localOk || youtubeOk) {
          const reason = hlsOk ? "hls" : localOk ? "local" : "youtube";
          return { id: row.id, status: "ok" as const, reason };
        }
        return {
          id: row.id,
          status: "broken" as const,
          reason: "no playable source (missing hlsMasterUrl + localVideoUrl + youtubeId)",
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
