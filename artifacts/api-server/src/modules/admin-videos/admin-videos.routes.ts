import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, asc, count, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";
import { invalidateVideosCatalogCache } from "../videos/videos.routes.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { storage } from "../../infrastructure/storage.js";
import { enqueueTranscode } from "../transcoder/transcoder.queue.js";
import { transcoderDispatcher } from "../transcoder/transcoder.dispatcher.js";
import { runFaststart } from "../transcoder/faststart.service.js";
import { isUndefinedColumnError, SAFE_VIDEO_COLS } from "../../infrastructure/db-schema-guard.js";

/**
 * Admin video listing + metadata management.
 *
 * GET  /admin/videos          — paginated, searchable, filterable library
 * PATCH /admin/videos/:id     — update metadata (title, desc, category, preacher,
 *                               featured, metadataLocked)
 * DELETE /admin/videos/:id    — hard-delete: removes DB row + purges all stored
 *                               objects (raw source, HLS tree, thumbnail) and
 *                               cleans up orphan broadcast_queue / transcoding_jobs rows.
 */

const videos = schema.videosTable;

const VideoRowSchema = z.object({
  id: z.string(),
  youtubeId: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  thumbnailUrl: z.string(),
  duration: z.string().nullable(),
  category: z.string().nullable(),
  preacher: z.string().nullable(),
  publishedAt: z.string().nullable(),
  importedAt: z.string(),
  viewCount: z.number().int().nonnegative(),
  featured: z.boolean(),
  metadataLocked: z.boolean(),
  broadcastOnly: z.boolean(),
  videoSource: z.string(),
  localVideoUrl: z.string().nullable(),
  hlsMasterUrl: z.string().nullable(),
  transcodingStatus: z.string(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  mimeType: z.string().nullable(),
  originalFilename: z.string().nullable(),
  /**
   * Whether the source video file is still available in object storage.
   * - true  → source file exists; "Retry Transcoding" is safe to call.
   * - false → source was deleted or never stored; re-upload is required.
   * - null  → not applicable (YouTube-sourced video, no local bytes).
   * Computed from objectPath + sourceCleanupStatus + sourceDeletedAt —
   * does NOT require a storage round-trip; purely DB-derived.
   */
  sourceAvailable: z.boolean().nullable(),
  /**
   * Human-readable reason for the most recent transcoding failure.
   * Set when transcodingStatus transitions to 'failed'; cleared on re-queue.
   * null when the video has never failed or was successfully re-queued.
   * Distinguishes recoverable failures (e.g. "disk full — retry") from
   * unrecoverable ones (e.g. "moov atom missing — re-upload required").
   */
  transcodingErrorMessage: z.string().nullable(),
  /**
   * Machine-readable error code for the most recent terminal transcoding failure.
   *   'CORRUPT_SOURCE' — moov atom absent; re-upload the source file to fix.
   *   'DISK_FULL'      — ENOSPC/EDQUOT at encode time; free storage and retry.
   *   null             — no specific code, not failed, or cleared on re-queue.
   * Use this field (not regex on errorMessage) to branch on failure type.
   */
  transcodingErrorCode: z.string().nullable(),
  /**
   * YouTube live broadcast status for this video.
   *   'live'         — stream is actively airing on YouTube right now.
   *   'rebroadcast'  — stream has ended; video is available as a VOD/replay.
   *   null           — not applicable (non-YouTube) or never went live.
   */
  youtubeLiveStatus: z.enum(["live", "rebroadcast"]).nullable(),
});

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // Accept "limit" (canonical) or "pageSize" (legacy admin SPA param name).
  limit: z.coerce.number().int().min(1).max(200).default(20),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  search: z.string().trim().max(200).optional(),
  category: z.string().trim().max(100).optional(),
  source: z.enum(["youtube", "local", "hls"]).optional(),
  featured: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === true || v === "true")),
  transcodingStatus: z
    .enum(["none", "queued", "encoding", "processing", "hls_ready", "ready", "failed"])
    .optional(),
  sort: z.enum(["newest", "oldest", "published", "views", "title"]).default("newest"),
  // Optional opaque cursor for keyset pagination. When provided with sort=newest
  // or sort=oldest the handler uses (imported_at, id) keyset logic and skips the
  // COUNT query. Ignored for other sort modes (published, views, title) which
  // still use classic offset pagination.
  cursor: z.string().max(256).optional(),
});

const ListResponseSchema = z.object({
  videos: z.array(VideoRowSchema),
  total: z.number().int(),
  totalPages: z.number().int(),
  page: z.number().int().min(1),
  limit: z.number().int().min(1),
  // Opaque cursor pointing to the start of the next page. null when the
  // current page is the last page (fewer rows returned than `limit`).
  // Only populated in cursor mode (sort=newest|oldest + cursor param provided).
  nextCursor: z.string().nullable(),
});

const PatchBodySchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).optional(),
  category: z.string().max(64).optional(),
  preacher: z.string().max(255).optional(),
  featured: z.boolean().optional(),
  metadataLocked: z.boolean().optional(),
  broadcastOnly: z.boolean().optional(),
}).strict();

// ── Keyset cursor helpers ──────────────────────────────────────────────────
// Cursor = base64url( JSON { ts: importedAt.getTime(), id } ).
// Opaque to callers — internals may change without breaking the contract.
interface AdminCursor { ts: number; id: string }

function encodeAdminCursor(ts: Date | string, id: string): string {
  const ms = ts instanceof Date ? ts.getTime() : new Date(ts).getTime();
  return Buffer.from(JSON.stringify({ ts: ms, id })).toString("base64url");
}

function decodeAdminCursor(raw: string): AdminCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p.ts !== "number" || typeof p.id !== "string") return null;
    return { ts: p.ts, id: p.id };
  } catch {
    return null;
  }
}

function toDto(row: typeof videos.$inferSelect): z.infer<typeof VideoRowSchema> {
  const yt = row.youtubeId?.startsWith("local-") ? null : row.youtubeId;

  // Determine whether the source video file is still in storage without
  // making a live storage round-trip. We derive this purely from DB columns:
  //   • objectPath null     → file was never stored (e.g. legacy import)
  //   • sourceCleanupStatus === 'done' OR sourceDeletedAt set → file purged
  //   • otherwise           → file should still be present in object storage
  // Only meaningful for local-sourced videos; null for YouTube.
  let sourceAvailable: boolean | null = null;
  if (row.videoSource === "local") {
    if (!row.objectPath) {
      sourceAvailable = false;
    } else if (row.sourceCleanupStatus === "done" || row.sourceDeletedAt !== null) {
      sourceAvailable = false;
    } else {
      sourceAvailable = true;
    }
  }

  return {
    id: row.id,
    youtubeId: yt,
    title: row.title,
    description: row.description ?? "",
    thumbnailUrl: row.thumbnailUrl ?? "",
    duration: row.duration || null,
    category: row.category || null,
    preacher: row.preacher || null,
    publishedAt: row.publishedAt,
    importedAt: row.importedAt.toISOString(),
    viewCount: row.viewCount,
    featured: row.featured,
    metadataLocked: row.metadataLocked,
    broadcastOnly: row.broadcastOnly,
    videoSource: row.videoSource,
    localVideoUrl: row.localVideoUrl,
    hlsMasterUrl: row.hlsMasterUrl,
    transcodingStatus: row.transcodingStatus ?? "none",
    sizeBytes: row.sizeBytes ?? null,
    mimeType: row.mimeType,
    originalFilename: row.originalFilename,
    sourceAvailable,
    transcodingErrorMessage: row.transcodingErrorMessage ?? null,
    transcodingErrorCode: row.transcodingErrorCode ?? null,
    youtubeLiveStatus: (row.youtubeLiveStatus === "live" || row.youtubeLiveStatus === "rebroadcast")
      ? row.youtubeLiveStatus as "live" | "rebroadcast"
      : null,
  };
}

export async function adminVideosRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── GET /videos ─────────────────────────────────────────────────────────────
  r.get(
    "/videos",
    {
      preHandler: requireAuth("editor"),
      // The library listing runs a paginated full-text search across the
      // managed_videos table (GIN index). Without a rate limit a compromised
      // editor token can drive arbitrarily many expensive search queries.
      // 60/min covers heavy admin usage (fast typing in the search box, bulk
      // picker opens) while still blocking automated enumeration.
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },      schema: {
        tags: ["admin"],
        summary: "Paginated, searchable video library for the admin picker",
        querystring: ListQuerySchema,
        response: { 200: ListResponseSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const q = req.query;
      const effectiveLimit = q.pageSize ?? q.limit;

      // ── Cursor / offset decision ────────────────────────────────────────────
      // Cursor mode activates when `cursor` param is supplied AND sort is
      // amenable to keyset pagination (newest / oldest use imported_at + id as
      // anchor). All other sorts (published, views, title) fall back to classic
      // offset pagination — their sort keys aren't monotonic enough for reliable
      // keyset behaviour.
      const parsedCursor = q.cursor ? decodeAdminCursor(q.cursor) : null;
      const useCursor = !!(parsedCursor && (q.sort === "newest" || q.sort === "oldest"));
      const offset = useCursor ? 0 : (q.page - 1) * effectiveLimit;

      // Always exclude YouTube videos published more than 2 years ago.
      // Non-YouTube (local/HLS) content is always visible regardless of date.
      // IMPORTANT: use the same SAFE_PUB_AT guard as the public videos route —
      // a direct ::timestamptz cast on malformed published_at strings will throw
      // "invalid input syntax for type timestamp" and 500 the entire listing.
      const ADMIN_SAFE_PUB_AT = sql`CASE WHEN ${videos.publishedAt} ~ '^[0-9]{4}' THEN NULLIF(${videos.publishedAt}, '')::timestamptz ELSE NULL END`;
      const filters: SQL[] = [
        sql`(${videos.videoSource} != 'youtube' OR ${videos.publishedAt} IS NULL OR ${ADMIN_SAFE_PUB_AT} >= NOW() - INTERVAL '2 years')`,
      ];
      if (q.search) {
        // Full-text search via GIN tsvector index (title + preacher + description).
        // Falls back cleanly to zero results when the query resolves to only stop-words.
        // youtubeId prefix-match kept as a secondary OR so admins can look up by ID.
        const term = q.search.trim();
        filters.push(
          sql`(
            to_tsvector('english', coalesce(${videos.title},'') || ' ' || coalesce(${videos.preacher},'') || ' ' || coalesce(${videos.description},''))
              @@ plainto_tsquery('english', ${term})
            OR lower(coalesce(${videos.youtubeId},'')) LIKE lower(${"%" + term + "%"})
          )`,
        );
      }
      if (q.category) filters.push(eq(videos.category, q.category));
      if (q.source) filters.push(eq(videos.videoSource, q.source));
      if (q.featured !== undefined) filters.push(eq(videos.featured, q.featured));
      if (q.transcodingStatus) {
        const statusMap: Record<string, string[]> = {
          hls_ready:  ["hls_ready", "ready"],
          ready:      ["ready", "hls_ready"],
          encoding:   ["encoding", "processing"],
          processing: ["processing", "encoding"],
          none:       ["none"],
          queued:     ["queued"],
          failed:     ["failed"],
        };
        const vals = statusMap[q.transcodingStatus] ?? [q.transcodingStatus];
        filters.push(inArray(videos.transcodingStatus, vals));
      }

      // Cursor keyset filter (imported_at + id tie-break), applied only when
      // cursor mode is active. Uses the same operator pattern as the public
      // /videos route so both surfaces behave consistently.
      if (useCursor && parsedCursor) {
        const anchorTs = new Date(parsedCursor.ts);
        if (q.sort === "oldest") {
          filters.push(
            or(
              sql`${videos.importedAt} > ${anchorTs}`,
              and(
                sql`${videos.importedAt} = ${anchorTs}`,
                sql`${videos.id} > ${parsedCursor.id}`,
              ),
            ) as SQL,
          );
        } else {
          // newest (DESC)
          filters.push(
            or(
              sql`${videos.importedAt} < ${anchorTs}`,
              and(
                sql`${videos.importedAt} = ${anchorTs}`,
                sql`${videos.id} < ${parsedCursor.id}`,
              ),
            ) as SQL,
          );
        }
      }

      const where = filters.length > 0 ? and(...filters) : undefined;

      let orderBy: SQL;
      switch (q.sort) {
        case "oldest":
          orderBy = useCursor
            ? sql`${videos.importedAt} ASC, ${videos.id} ASC`
            : asc(videos.importedAt);
          break;
        case "published":
          // Must use the same SAFE_PUB_AT guard — direct ::timestamptz on a
          // malformed published_at value throws and 500s the entire admin list.
          orderBy = sql`${ADMIN_SAFE_PUB_AT} DESC NULLS LAST`;
          break;
        case "views":
          orderBy = desc(videos.viewCount);
          break;
        case "title":
          orderBy = asc(videos.title);
          break;
        default:
          // newest
          orderBy = useCursor
            ? sql`${videos.importedAt} DESC, ${videos.id} DESC`
            : desc(videos.importedAt);
      }

      // Primary path: full SELECT * (fast, includes every column).
      // Fallback path: explicit safe projection when the production DB is missing
      // late-added columns (metadata_locked, faststart_applied). The fallback uses
      // hardcoded `false` for those columns so PostgreSQL never sees their names.
      // Cursor mode skips the COUNT query (returns total=-1 as sentinel).
      type VideoRow = typeof videos.$inferSelect;
      const [rows, totalRows] = await (async (): Promise<[VideoRow[], { c: number | bigint }[]]> => {
        const countPromise = useCursor
          ? Promise.resolve([{ c: -1 as number | bigint }])
          : db.select({ c: count() }).from(videos).where(where as SQL | undefined);
        try {
          return await Promise.all([
            db
              .select()
              .from(videos)
              .where(where as SQL | undefined)
              .orderBy(orderBy)
              .limit(effectiveLimit)
              .offset(offset),
            countPromise,
          ]);
        } catch (err: unknown) {
          if (!isUndefinedColumnError(err)) throw err;
          req.log.warn("[admin-videos] DB schema missing column — falling back to safe projection");
          const countFallback = useCursor
            ? Promise.resolve([{ c: -1 as number | bigint }])
            : db.select({ c: count() }).from(videos).where(where as SQL | undefined);
          return [
            await db
              .select(SAFE_VIDEO_COLS)
              .from(videos)
              .where(where as SQL | undefined)
              .orderBy(orderBy)
              .limit(effectiveLimit)
              .offset(offset) as unknown as VideoRow[],
            await countFallback,
          ];
        }
      })();

      const total = Number(totalRows[0]?.c ?? 0);
      const totalPages = useCursor ? -1 : Math.max(1, Math.ceil(total / effectiveLimit));

      // Build next cursor from the last row's importedAt + id (keyset anchor).
      // Generated for ALL newest/oldest responses (not only cursor mode) so that
      // first-page (no cursor) clients receive a cursor they can use for the
      // next page — enabling zero-offset traversal from page 1.
      // null when the result set is smaller than `limit` (last page reached).
      let nextCursor: string | null = null;
      const isCursorableSort = q.sort === "newest" || q.sort === "oldest";
      if (isCursorableSort && rows.length === effectiveLimit) {
        const lastRow = rows[rows.length - 1];
        if (lastRow) {
          nextCursor = encodeAdminCursor(lastRow.importedAt, lastRow.id);
        }
      }

      return {
        videos: rows.map(toDto),
        total,
        totalPages,
        page: useCursor ? 1 : q.page,
        limit: effectiveLimit,
        nextCursor,
      };
    },
  );

  // ── PATCH /videos/:id ────────────────────────────────────────────────────────
  r.patch(
    "/videos/:id",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["admin"],
        summary: "Update video metadata (title, description, category, preacher, featured, metadataLocked)",
        params: z.object({ id: z.string().min(1).max(128) }),
        body: PatchBodySchema,
        response: {
          200: VideoRowSchema,
          404: z.object({ error: z.string() }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const body = req.body;

      type VideoRow = typeof videos.$inferSelect;

      if (Object.keys(body).length === 0) {
        // No-op PATCH — just fetch and return the current row.
        // Use the same safe-fallback pattern for SELECT * in case DB is pre-migration.
        const existing = await db
          .select()
          .from(videos)
          .where(eq(videos.id, id))
          .limit(1)
          .catch(async (err: unknown) => {
            if (!isUndefinedColumnError(err)) throw err;
            return db
              .select(SAFE_VIDEO_COLS)
              .from(videos)
              .where(eq(videos.id, id))
              .limit(1) as unknown as VideoRow[];
          })
          .then((r) => r[0]);
        if (!existing) return reply.code(404).send({ error: `Video not found: ${id}` });
        return toDto(existing);
      }

      // Build the SET clause. metadataLocked is guarded separately because the
      // column may not yet exist in the production DB (added after initial deploy).
      const baseSet = {
        ...(body.title !== undefined       ? { title: body.title }             : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.category !== undefined    ? { category: body.category }       : {}),
        ...(body.preacher !== undefined    ? { preacher: body.preacher }       : {}),
        ...(body.featured !== undefined    ? { featured: body.featured }       : {}),
        ...(body.metadataLocked !== undefined ? { metadataLocked: body.metadataLocked } : {}),
        ...(body.broadcastOnly !== undefined  ? { broadcastOnly: body.broadcastOnly }   : {}),
      };

      let updated: VideoRow[];
      try {
        // Happy path: full UPDATE … RETURNING * (works once migration ran).
        updated = await db
          .update(videos)
          .set(baseSet)
          .where(eq(videos.id, id))
          .returning();
      } catch (err: unknown) {
        if (!isUndefinedColumnError(err)) throw err;
        // Fallback: drop late-added columns from SET (absent on pre-migration DBs)
        // and use the safe RETURNING projection that substitutes false for them.
        const { metadataLocked: _m, broadcastOnly: _b, ...safeSet } = baseSet as typeof baseSet & { metadataLocked?: boolean; broadcastOnly?: boolean };
        updated = await db
          .update(videos)
          .set(safeSet)
          .where(eq(videos.id, id))
          .returning(SAFE_VIDEO_COLS) as unknown as VideoRow[];
      }

      const row = updated[0];
      if (!row) return reply.code(404).send({ error: `Video not found: ${id}` });

      void invalidateVideosCatalogCache();
      adminEventBus.push("videos-library-updated", { videoId: id, reason: "metadata-updated" });

      return toDto(row);
    },
  );

  // ── DELETE /videos/:id ───────────────────────────────────────────────────────
  r.delete(
    "/videos/:id",
    {
      preHandler: requireAuth("editor"),
      // Hard delete removes the DB row AND purges storage blobs.
      // 10/min prevents a runaway script from wiping the library in bulk.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },      schema: {
        tags: ["admin"],
        summary: "Delete a video from the library",
        params: z.object({ id: z.string().min(1).max(128) }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          404: z.object({ error: z.string() }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params;

      // Capture storage fields first, then delete — all in one round-trip
      // via .returning() so the cleanup runs with the pre-delete values.
      const [deleted] = await db
        .delete(videos)
        .where(eq(videos.id, id))
        .returning({
          id: videos.id,
          objectPath: videos.objectPath,
          hlsMasterUrl: videos.hlsMasterUrl,
          thumbnailUrl: videos.thumbnailUrl,
          videoSource: videos.videoSource,
        });

      if (!deleted) return reply.code(404).send({ error: `Video not found: ${id}` });

      void invalidateVideosCatalogCache();
      adminEventBus.push("videos-library-updated", { videoId: id, reason: "video-deleted" });

      // ── Fire-and-forget storage + orphan cleanup ──────────────────────────
      // Failures are logged but must not affect the 200 response — the DB row
      // is already gone. Any leftover blobs are swept by the storage GC.
      void (async () => {
        const s = storage();
        const log = req.log;

        // 1. Raw source file (objectPath is the direct storage key).
        if (deleted.objectPath) {
          await s.deleteObject(deleted.objectPath).catch((err) =>
            log.warn({ err, id, objectPath: deleted.objectPath }, "video-delete: failed to remove source object"),
          );
        }

        // 2. HLS tree: master.m3u8 + all rendition playlists + .ts segments.
        //    Transcoder stores everything under `transcoded/{videoId}/`.
        //    Runs even if hlsMasterUrl is null — zero-row delete is safe.
        const hlsDeleted = await s.deleteByPrefix(`transcoded/${id}/`).catch((err) => {
          log.warn({ err, id }, "video-delete: failed to purge HLS tree");
          return 0;
        });
        if (hlsDeleted > 0) {
          log.info({ id, hlsDeleted }, "video-delete: purged HLS segments");
        }

        // 3. Thumbnail — local thumbnails are served at `/api/v1/uploads/{key}`.
        //    Skip external URLs (YouTube CDN, etc.) and empty strings.
        const thumbUrl = deleted.thumbnailUrl ?? "";
        if (thumbUrl.startsWith("/api/v1/uploads/")) {
          const thumbKey = thumbUrl.slice("/api/v1/uploads/".length);
          await s.deleteObject(thumbKey).catch((err) =>
            log.warn({ err, id, thumbKey }, "video-delete: failed to remove thumbnail"),
          );
        }

        // 4. Orphan broadcast_queue rows (no FK cascade on videoId column).
        //    These ghost items cause the v2 orchestrator to loop-skip forever.
        const removedQueueItems = await db
          .delete(schema.broadcastQueueTable)
          .where(eq(schema.broadcastQueueTable.videoId, id))
          .returning({ qid: schema.broadcastQueueTable.id })
          .catch((err) => {
            log.warn({ err, id }, "video-delete: failed to remove orphan broadcast_queue rows");
            return [] as { qid: string }[];
          });

        if (removedQueueItems.length > 0) {
          log.info({ id, removedCount: removedQueueItems.length }, "video-delete: removed orphan queue items");
          // Reload the v2 orchestrator so it doesn't keep resolving a deleted item.
          adminEventBus.push("broadcast-queue-updated", { reason: "video-deleted", videoId: id });
        }

        // 5. Orphan transcoding jobs (no FK cascade on video_id column).
        //    Ghost queued/encoding jobs would retry forever on a missing video row.
        await db
          .delete(schema.transcodingJobsTable)
          .where(eq(schema.transcodingJobsTable.videoId, id))
          .catch((err) => log.warn({ err, id }, "video-delete: failed to remove transcoding jobs"));

        // 6. Orphan series_episodes rows (no FK cascade on videoId column).
        //    Without this, the series listing shows episode slots pointing at
        //    a non-existent video — the join returns null and the episode card
        //    can't render a title, thumbnail, or playback URL.
        const removedEpisodes = await db
          .delete(schema.seriesEpisodesTable)
          .where(eq(schema.seriesEpisodesTable.videoId, id))
          .returning({ eid: schema.seriesEpisodesTable.id })
          .catch((err) => {
            log.warn({ err, id }, "video-delete: failed to remove orphan series_episodes rows");
            return [] as { eid: string }[];
          });
        if (removedEpisodes.length > 0) {
          log.info({ id, removedEpisodeCount: removedEpisodes.length }, "video-delete: removed orphan series_episodes");
        }

        // 7. Orphan playlist_videos rows (no FK cascade on videoId column).
        //    playlist_videos.videoId references managed_videos but without a
        //    Postgres FK + cascade, deleting the video leaves ghost entries.
        //    These ghost entries surface as "Video not found" 404s when the
        //    player tries to resolve the playlist item's source URL.
        const removedPlaylistItems = await db
          .delete(schema.playlistVideosTable)
          .where(eq(schema.playlistVideosTable.videoId, id))
          .returning({ pid: schema.playlistVideosTable.id })
          .catch((err) => {
            log.warn({ err, id }, "video-delete: failed to remove orphan playlist_videos rows");
            return [] as { pid: string }[];
          });
        if (removedPlaylistItems.length > 0) {
          log.info({ id, removedPlaylistCount: removedPlaylistItems.length }, "video-delete: removed orphan playlist_videos");
        }
      })().catch((err) =>
        req.log.warn({ err, id }, "video-delete: unexpected error in cleanup IIFE (non-fatal)"),
      );

      return { ok: true as const };
    },
  );

  // ── POST /videos/:id/transcode ───────────────────────────────────────────────
  // Queue a locally-uploaded video for HLS transcoding. Idempotent: if a job
  // already exists for this video it is re-armed rather than duplicated.
  // Returns the job ID and a `reused` flag (true when an existing job was
  // recycled, false when a brand-new row was inserted).
  r.post(
    "/videos/:id/transcode",
    {
      preHandler: requireAuth("editor"),
      // Spawns a real FFmpeg process. 10/min prevents editors from
      // flooding the transcoder queue via the UI.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },      schema: {
        tags: ["admin"],
        summary: "Queue a locally-uploaded video for HLS transcoding",
        params: z.object({ id: z.string().min(1).max(128) }),
        response: {
          200: z.object({ jobId: z.string(), reused: z.boolean() }),
          400: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params;

      const [row] = await db
        .select({
          id: videos.id,
          objectPath: videos.objectPath,
          videoSource: videos.videoSource,
        })
        .from(videos)
        .where(eq(videos.id, id))
        .limit(1);

      if (!row) {
        return reply.code(404).send({ error: `Video not found: ${id}` });
      }
      if (row.videoSource !== "local") {
        return reply.code(400).send({
          error: "Only locally-uploaded videos can be transcoded. YouTube videos stream via YouTube.",
        });
      }
      if (!row.objectPath) {
        return reply.code(400).send({
          error: "Video has no stored source file — it may still be uploading or was imported without a local blob.",
        });
      }

      const { id: jobId, reused } = await enqueueTranscode({
        videoId: row.id,
        videoPath: row.objectPath,
        priority: 1,
      });

      req.log.info({ videoId: id, jobId, reused }, "admin: manually queued HLS transcode job");
      transcoderDispatcher.nudge();
      return { jobId, reused };
    },
  );

  // ── POST /videos/:id/faststart ───────────────────────────────────────────────
  // Re-run MP4 faststart (moov-atom relocation) on a locally-uploaded video.
  // Useful for videos stuck in `queued` or `failed` state when the HLS
  // transcoder is disabled. Runs in the background — returns 202 immediately.
  r.post(
    "/videos/:id/faststart",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },      schema: {
        tags: ["admin"],
        summary: "Re-apply MP4 faststart optimisation to a locally-uploaded video",
        params: z.object({ id: z.string().min(1).max(128) }),
        response: {
          202: z.object({ ok: z.literal(true), videoId: z.string() }),
          400: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
          409: z.object({ error: z.string() }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params;

      const [row] = await db
        .select({
          id: videos.id,
          objectPath: videos.objectPath,
          videoSource: videos.videoSource,
          transcodingStatus: videos.transcodingStatus,
        })
        .from(videos)
        .where(eq(videos.id, id))
        .limit(1);

      if (!row) {
        return reply.code(404).send({ error: `Video not found: ${id}` });
      }
      if (row.videoSource !== "local") {
        return reply.code(400).send({ error: "Faststart only applies to locally-uploaded videos." });
      }
      if (!row.objectPath) {
        return reply.code(400).send({ error: "Video has no stored source file — it may still be uploading." });
      }
      if (row.transcodingStatus === "processing") {
        return reply.code(409).send({ error: "Faststart is already running for this video." });
      }
      if (row.transcodingStatus === "hls_ready") {
        return reply.code(400).send({ error: "Video has completed HLS transcoding — faststart is not applicable." });
      }

      void (async () => {
        try {
          await runFaststart(id, row.objectPath!, { skipStatusUpdate: false });
        } catch (err) {
          req.log.warn({ err, videoId: id }, "admin: manual faststart failed (non-fatal)");
        }
      })().catch((err) => {
        // Defensive: ensures the void promise never escapes as an
        // unhandledRejection if the inner try/catch itself faults
        // (e.g. logger.warn throws during shutdown).
        req.log.error({ err, videoId: id }, "admin: faststart task crashed outside inner handler");
      });

      req.log.info({ videoId: id, objectPath: row.objectPath }, "admin: manual faststart triggered");
      return reply.code(202).send({ ok: true as const, videoId: id });
    },
  );

  // ── POST /videos/:id/reset-for-reupload ─────────────────────────────────────
  // Clears a CORRUPT_SOURCE failure so the admin can re-upload the source file.
  // Nulls objectPath + localVideoUrl (orphaned corrupt blob stays in storage for
  // the GC sweep) and resets transcodingStatus → 'none'.  Returns the current
  // video metadata so the caller can pre-fill the upload form without a second
  // round-trip.
  r.post(
    "/videos/:id/reset-for-reupload",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },      schema: {
        tags: ["admin"],
        summary: "Reset a corrupt-source video so its source file can be re-uploaded",
        params: z.object({ id: z.string().min(1).max(128) }),
        response: {
          200: z.object({
            ok: z.literal(true),
            videoId: z.string(),
            title: z.string(),
            category: z.string().nullable(),
            preacher: z.string().nullable(),
            description: z.string(),
          }),
          400: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params;

      const [row] = await db
        .select({
          id: videos.id,
          title: videos.title,
          description: videos.description,
          category: videos.category,
          preacher: videos.preacher,
          videoSource: videos.videoSource,
          transcodingErrorCode: videos.transcodingErrorCode,
          transcodingStatus: videos.transcodingStatus,
        })
        .from(videos)
        .where(eq(videos.id, id))
        .limit(1);

      if (!row) return reply.code(404).send({ error: `Video not found: ${id}` });
      if (row.videoSource !== "local") {
        return reply.code(400).send({ error: "Re-upload only applies to locally-uploaded videos." });
      }
      if (row.transcodingErrorCode !== "CORRUPT_SOURCE" && row.transcodingErrorCode !== "SOURCE_MISSING") {
        return reply.code(400).send({
          error: `Video is not in a re-uploadable failure state (CORRUPT_SOURCE/SOURCE_MISSING; current: ${row.transcodingErrorCode ?? "none"}).`,
        });
      }

      await db
        .update(videos)
        .set({
          transcodingStatus: "none",
          transcodingErrorCode: null,
          transcodingErrorMessage: null,
          objectPath: null,
          localVideoUrl: null,
        })
        .where(eq(videos.id, id));

      adminEventBus.push("videos-library-updated", { videoId: id, reason: "reset-for-reupload" });
      req.log.info({ videoId: id }, "admin: corrupt video reset for re-upload");

      return reply.code(200).send({
        ok: true as const,
        videoId: id,
        title: row.title,
        category: row.category ?? null,
        preacher: row.preacher ?? null,
        description: row.description ?? "",
      });
    },
  );

  // ── POST /videos/bulk-transcode ───────────────────────────────────────────────
  // Queue every local video that does not yet have a completed HLS master URL.
  // Skips videos where objectPath is null (YouTube imports, broken rows).
  // Admin-only because bulk queuing can pin CPU for extended periods.
  r.post(
    "/videos/bulk-transcode",
    {
      preHandler: requireAuth("admin"),
      // Bulk queuing can pin CPU for extended periods. 2/min is a hard
      // guard — the UI's "Transcode All" button has its own confirm dialog.
      config: { rateLimit: { max: 2, timeWindow: "1 minute" } },      schema: {
        tags: ["admin"],
        summary: "Queue all local videos without HLS for transcoding",
        response: {
          200: z.object({
            queued: z.number().int(),
            skipped: z.number().int(),
            message: z.string(),
          }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const rows = await db
        .select({ id: videos.id, objectPath: videos.objectPath })
        .from(videos)
        .where(
          and(
            eq(videos.videoSource, "local"),
            or(isNull(videos.hlsMasterUrl), eq(videos.hlsMasterUrl, "")),
          ),
        );

      let queued = 0;
      let skipped = 0;

      for (const row of rows) {
        if (!row.objectPath) {
          skipped++;
          continue;
        }
        try {
          await enqueueTranscode({ videoId: row.id, videoPath: row.objectPath });
          queued++;
        } catch (err) {
          req.log.warn({ err, videoId: row.id }, "bulk-transcode: enqueue failed for video (skipping)");
          skipped++;
        }
      }

      if (queued > 0) transcoderDispatcher.nudge();
      req.log.info({ queued, skipped }, "admin: bulk HLS transcode queued");
      return {
        queued,
        skipped,
        message: `${queued} video${queued === 1 ? "" : "s"} queued for HLS transcoding${skipped > 0 ? `, ${skipped} skipped (no source file)` : ""}.`,
      };
    },
  );
}
