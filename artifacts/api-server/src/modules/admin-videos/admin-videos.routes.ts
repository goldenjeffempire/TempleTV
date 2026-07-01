import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { cache } from "../../infrastructure/cache.js";
import { requireAuth } from "../../middleware/auth.js";
import { invalidateVideosCatalogCache } from "../videos/videos.routes.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { storage } from "../../infrastructure/storage.js";
import { enqueueTranscode } from "../transcoder/transcoder.queue.js";
import { enqueueIfMissing } from "../broadcast/auto-enqueue.service.js";
import { transcoderDispatcher } from "../transcoder/transcoder.dispatcher.js";
import { runFaststart } from "../transcoder/faststart.service.js";
import { isUndefinedColumnError, SAFE_VIDEO_COLS } from "../../infrastructure/db-schema-guard.js";
import { generateThumbnailForVideo } from "./thumbnail-generator.service.js";
import { runVideoValidation, scheduleVideoValidation, getStoredValidationReport } from "../transcoder/video-validation.service.js";

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
  // ── Technical metadata (populated by ffprobe after upload assembly) ───────
  // Available as soon as the upload is confirmed assembled — no transcoding needed.
  videoCodec: z.string().nullable(),
  audioCodec: z.string().nullable(),
  /** Bitrate in kbps from format.bit_rate, or null if not yet probed. */
  videoBitrate: z.number().int().nullable(),
  videoWidth: z.number().int().nullable(),
  videoHeight: z.number().int().nullable(),
  /**
   * Real-time transcoding progress percentage (0–100) for the active job.
   * null when no transcoding job is currently in progress.
   * Sourced from the most recent transcoding_jobs row for this video.
   */
  transcodingProgress: z.number().int().nullable(),
  /** ISO-8601 UTC — auto-publish (set broadcastOnly=false) at this time. null = not scheduled. */
  scheduledPublishAt: z.string().nullable(),
  /** ISO-8601 UTC — auto-unpublish (set broadcastOnly=true) at this time. null = not scheduled. */
  scheduledUnpublishAt: z.string().nullable(),
  /** Ordered chapter markers. Each entry: { startSecs: number, title: string }. null = none. */
  chapters: z.array(z.object({ startSecs: z.number().nonnegative(), title: z.string().max(200) })).nullable(),
  /** Free-form admin-assigned tags. null = no tags. */
  tags: z.array(z.string()).nullable(),
  /**
   * Whether the MP4 moov atom has been relocated to the start of the file.
   * - true  → faststart applied; video plays from byte 0 on all surfaces.
   * - false → faststart explicitly ran and failed (moov still at end-of-file).
   * - null  → never attempted (pre-migration DBs) or not applicable (YouTube).
   */
  faststartApplied: z.boolean().nullable(),
  /**
   * Number of faststart processing attempts made so far.
   * 0 = never attempted; 1–2 = in-progress retries; 3 = max attempts reached (failed).
   * The recovery worker caps retries at 3 and marks the video permanently failed.
   */
  faststartAttempts: z.number().int().nonnegative(),
  /**
   * Result of the comprehensive 9-check broadcast validation pipeline.
   * null      — never validated (pre-feature rows or YouTube videos).
   * 'pending' — validation scheduled, not yet started.
   * 'running' — validation is currently in progress.
   * 'passed'  — all checks passed; safe to broadcast on all surfaces.
   * 'warn'    — non-fatal issues (e.g. HEVC codec, wide keyframe interval).
   * 'failed'  — one or more fatal checks failed; blocked from broadcast.
   */
  validationStatus: z.enum(["pending", "running", "passed", "warn", "failed"]).nullable(),
  /** ISO-8601 UTC timestamp of the most recent completed validation run. */
  validationCompletedAt: z.string().nullable(),
});

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // Accept "limit" (canonical) or "pageSize" (legacy admin SPA param name).
  limit: z.coerce.number().int().min(1).default(20).catch(20).transform(v => Math.min(v, 200)),
  pageSize: z.coerce.number().int().min(1).max(200).optional().catch(undefined),
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
  // Filter to videos that contain this tag (exact match, case-sensitive).
  tag: z.string().trim().max(100).optional(),
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
  /** ISO-8601 string or null to clear. */
  scheduledPublishAt: z.union([z.string().datetime(), z.null()]).optional(),
  /** ISO-8601 string or null to clear. */
  scheduledUnpublishAt: z.union([z.string().datetime(), z.null()]).optional(),
  /** Replace the video's tag list. Empty array clears all tags. Null = no change. */
  tags: z.array(z.string().max(100)).max(20).nullable().optional(),
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

function toDto(row: typeof videos.$inferSelect, progress: number | null = null): z.infer<typeof VideoRowSchema> {
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
    videoCodec: row.videoCodec ?? null,
    audioCodec: row.audioCodec ?? null,
    videoBitrate: row.videoBitrate ?? null,
    videoWidth: row.videoWidth ?? null,
    videoHeight: row.videoHeight ?? null,
    transcodingProgress: progress,
    scheduledPublishAt: (row as { scheduledPublishAt?: Date | null }).scheduledPublishAt?.toISOString() ?? null,
    scheduledUnpublishAt: (row as { scheduledUnpublishAt?: Date | null }).scheduledUnpublishAt?.toISOString() ?? null,
    chapters: (() => {
      const raw = (row as { chapters?: unknown }).chapters;
      if (!Array.isArray(raw)) return null;
      return (raw as Array<unknown>).filter(
        (c): c is { startSecs: number; title: string } =>
          typeof c === "object" && c !== null &&
          typeof (c as Record<string, unknown>).startSecs === "number" &&
          typeof (c as Record<string, unknown>).title === "string",
      );
    })(),
    tags: (() => {
      const raw = (row as { tags?: unknown }).tags;
      if (!Array.isArray(raw)) return null;
      const filtered = raw.filter((t): t is string => typeof t === "string");
      return filtered.length > 0 ? filtered : null;
    })(),
    faststartApplied: row.faststartApplied ?? null,
    faststartAttempts: (row as { faststartAttempts?: number | null }).faststartAttempts ?? 0,
    validationStatus: (() => {
      const vs = (row as { validationStatus?: string | null }).validationStatus;
      if (vs === "pending" || vs === "running" || vs === "passed" || vs === "warn" || vs === "failed") return vs;
      return null;
    })(),
    validationCompletedAt: (row as { validationCompletedAt?: Date | null }).validationCompletedAt?.toISOString() ?? null,
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
      // newest / oldest sort: keyset (cursor) semantics by default.
      //
      // Page→cursor aliasing via server-side page-cursor cache (same mechanism
      // as the public /videos route):
      //   • Page 1 (no cursor)  → first page, no keyset filter (start of list).
      //   • Page N (no cursor)  → look up cached anchor for page N stored from
      //                           the prior traversal of page N-1. If found →
      //                           keyset query (no OFFSET). If not found (cold
      //                           deep-link, cache expired) → OFFSET fallback.
      //   • Any page + cursor   → keyset filter from the explicit cursor anchor.
      //
      // After each cursor-mode response nextCursor is cached as the anchor for
      // page N+1 (TTL 5 min). Sequential traversal (1→2→3→…) stays OFFSET-free
      // after the first pass. Other sorts always use OFFSET (non-monotonic keys).
      //
      // Cursor anchor column: imported_at (not published_at).  published_at is
      // nullable and non-monotonic; imported_at is always populated and indexed.
      const isCursorSort = q.sort === "newest" || q.sort === "oldest";

      const adminPageCursorKey = (p: number) =>
        `pgcursor:admin:v1:${q.sort}:${effectiveLimit}:${q.search ?? ""}:${q.category ?? ""}:${q.source ?? ""}:${q.featured ?? ""}:${q.transcodingStatus ?? ""}:p${p}`;

      const parsedCursor = q.cursor ? decodeAdminCursor(q.cursor) : null;

      // Resolve effective cursor: explicit param > cached anchor > none (page 1).
      let effectiveCursor = parsedCursor;
      let useOffsetFallback = false;
      if (isCursorSort && !parsedCursor && q.page > 1) {
        const storedCursor = await cache().get<string>(adminPageCursorKey(q.page)).catch(() => null);
        if (storedCursor) {
          effectiveCursor = decodeAdminCursor(storedCursor);
        } else {
          // Cold deep-link → OFFSET fallback. Next sequential request will be
          // cursor-based once we cache the anchor for q.page+1 below.
          useOffsetFallback = true;
        }
      }

      const useCursor = isCursorSort && !useOffsetFallback;
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
      if (q.tag) {
        // ANY() operator: check if the tag is present in the tags array column.
        // NULL tags → ANY(NULL) = NULL (falsy) so untagged rows are excluded naturally.
        filters.push(sql`${q.tag} = ANY(${videos.tags})`);
      }

      // Cursor keyset filter (imported_at + id tie-break), applied when an
      // effective cursor is available AND sort is keyset-eligible. Non-keyset
      // sorts (published, views, title) never apply a cursor filter — any
      // `cursor` query param is silently ignored for those sort modes.
      if (isCursorSort && effectiveCursor) {
        const anchorTs = new Date(effectiveCursor.ts);
        if (q.sort === "oldest") {
          filters.push(
            or(
              sql`${videos.importedAt} > ${anchorTs}`,
              and(
                sql`${videos.importedAt} = ${anchorTs}`,
                sql`${videos.id} > ${effectiveCursor.id}`,
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
                sql`${videos.id} < ${effectiveCursor.id}`,
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
      // Skip the COUNT query only on DEEP cursor pages (page > 1). The first
      // page always runs COUNT so the library header shows an accurate total
      // instead of the −1 sentinel; on page 1 no cursor filter is applied, so
      // COUNT(*) equals the true library total. Cheap and client-cached (30 s).
      const skipCount = useCursor && q.page > 1;
      const [rows, totalRows] = await (async (): Promise<[VideoRow[], { c: number | bigint }[]]> => {
        const countPromise = skipCount
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
          const countFallback = skipCount
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
      // Generated for ALL newest/oldest responses (offset-fallback AND cursor
      // mode) so clients always receive a cursor for the next page.
      // null when the result set is smaller than effectiveLimit (last page).
      let nextCursor: string | null = null;
      if (isCursorSort && rows.length === effectiveLimit) {
        const lastRow = rows[rows.length - 1];
        if (lastRow) {
          nextCursor = encodeAdminCursor(lastRow.importedAt, lastRow.id);
        }
      }

      // Store nextCursor as the keyset anchor for page+1 (TTL 5 min) so the
      // next sequential page request stays OFFSET-free.
      if (isCursorSort && !useOffsetFallback && nextCursor !== null) {
        void cache().set(adminPageCursorKey(q.page + 1), nextCursor, 300).catch(() => {});
      }

      // Batch-query live transcoding progress for any 'encoding' or 'processing'
      // videos in this page.  A single IN query is far cheaper than N sub-selects;
      // non-fatal so a DB blip never prevents the list from rendering.
      const encodingIds = rows
        .filter((r) => r.transcodingStatus === "encoding" || r.transcodingStatus === "processing")
        .map((r) => r.id);
      const progressMap = new Map<string, number>();
      if (encodingIds.length > 0) {
        try {
          const jobs = await db
            .select({
              videoId: schema.transcodingJobsTable.videoId,
              progress: schema.transcodingJobsTable.progress,
            })
            .from(schema.transcodingJobsTable)
            .where(
              and(
                inArray(schema.transcodingJobsTable.videoId, encodingIds),
                eq(schema.transcodingJobsTable.status, "encoding"),
              ),
            );
          for (const j of jobs) {
            if (j.videoId) progressMap.set(j.videoId, j.progress);
          }
        } catch (err) {
          req.log.warn({ err }, "[admin-videos] transcodingProgress batch query failed (non-fatal)");
        }
      }

      return {
        videos: rows.map((r) => toDto(r, progressMap.get(r.id) ?? null)),
        total,
        totalPages,
        page: q.page,
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
        ...(body.scheduledPublishAt !== undefined
          ? { scheduledPublishAt: body.scheduledPublishAt ? new Date(body.scheduledPublishAt) : null }
          : {}),
        ...(body.scheduledUnpublishAt !== undefined
          ? { scheduledUnpublishAt: body.scheduledUnpublishAt ? new Date(body.scheduledUnpublishAt) : null }
          : {}),
        ...(body.tags !== undefined && body.tags !== null
          ? { tags: body.tags }
          : {}),
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

  // ── PUT /videos/:id/chapters ─────────────────────────────────────────────────
  r.put(
    "/videos/:id/chapters",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["admin"],
        summary: "Replace chapter markers for a video",
        params: z.object({ id: z.string().min(1).max(128) }),
        body: z.object({
          chapters: z.array(
            z.object({
              startSecs: z.number().nonnegative(),
              title: z.string().min(1).max(200),
            }),
          ).max(200),
        }),
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
      // Sort ascending by startSecs before saving.
      const sorted = [...req.body.chapters].sort((a, b) => a.startSecs - b.startSecs);

      const [updated] = await db
        .update(videos)
        .set({ chapters: sorted })
        .where(eq(videos.id, id))
        .returning();

      if (!updated) return reply.code(404).send({ error: `Video not found: ${id}` });

      void invalidateVideosCatalogCache();
      adminEventBus.push("videos-library-updated", { videoId: id, reason: "chapters-updated" });

      return toDto(updated as typeof videos.$inferSelect);
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

      // ── Step 1: Hard-delete the video row ─────────────────────────────────
      // Capture storage fields via .returning() so the async blob cleanup has
      // the pre-delete values even after the row is gone.
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

      // ── Step 2: Synchronous DB reference cleanup ───────────────────────────
      // These tables have no PostgreSQL FK cascades on videoId, so orphaned
      // rows must be removed manually.  They run synchronously (before the 200
      // response) because:
      //   a) broadcast_queue orphans cause the orchestrator to loop-skip
      //      forever on a video that no longer exists.
      //   b) transcoding_jobs orphans would retry encoding on a missing row.
      //   c) series_episodes / playlist_videos orphans surface as 404 gaps
      //      in the UI and in the player's playlist resolver.
      //   d) upload_sessions / upload_chunks orphans waste BYTEA storage.
      //   e) broadcast-queue-updated MUST fire after queue rows are gone so
      //      the orchestrator's reload() reads the already-cleaned DB state.
      // Failures are logged as warnings but do not block the 200 response —
      // the integrity monitor and orphan-cleanup worker sweep residual rows.

      const log = req.log;

      // 2a. broadcast_queue — must be deleted and signalled BEFORE returning.
      //     The orchestrator's bus-bridge listens for broadcast-queue-updated
      //     and calls reload(), which re-reads the queue from DB. If queue rows
      //     were still present when reload() ran, the deleted video would remain
      //     in rotation. We delete first, then signal.
      const removedQueueItems = await db
        .delete(schema.broadcastQueueTable)
        .where(eq(schema.broadcastQueueTable.videoId, id))
        .returning({ qid: schema.broadcastQueueTable.id })
        .catch((err) => {
          log.warn({ err, id }, "video-delete: failed to remove orphan broadcast_queue rows");
          return [] as { qid: string }[];
        });
      if (removedQueueItems.length > 0) {
        log.info(
          { id, removedCount: removedQueueItems.length },
          "video-delete: removed orphan broadcast_queue items",
        );
      }

      // 2b. transcoding_jobs — ghost jobs retry forever on a missing video row.
      await db
        .delete(schema.transcodingJobsTable)
        .where(eq(schema.transcodingJobsTable.videoId, id))
        .catch((err) =>
          log.warn({ err, id }, "video-delete: failed to remove transcoding jobs"),
        );

      // 2c. series_episodes — orphan slots render as broken episode cards.
      const removedEpisodes = await db
        .delete(schema.seriesEpisodesTable)
        .where(eq(schema.seriesEpisodesTable.videoId, id))
        .returning({ eid: schema.seriesEpisodesTable.id })
        .catch((err) => {
          log.warn({ err, id }, "video-delete: failed to remove orphan series_episodes rows");
          return [] as { eid: string }[];
        });
      if (removedEpisodes.length > 0) {
        log.info(
          { id, count: removedEpisodes.length },
          "video-delete: removed orphan series_episodes",
        );
      }

      // 2d. playlist_videos — orphan entries cause 404s in the playlist resolver.
      const removedPlaylistItems = await db
        .delete(schema.playlistVideosTable)
        .where(eq(schema.playlistVideosTable.videoId, id))
        .returning({ pid: schema.playlistVideosTable.id })
        .catch((err) => {
          log.warn({ err, id }, "video-delete: failed to remove orphan playlist_videos rows");
          return [] as { pid: string }[];
        });
      if (removedPlaylistItems.length > 0) {
        log.info(
          { id, count: removedPlaylistItems.length },
          "video-delete: removed orphan playlist_videos",
        );
      }

      // 2e. upload_sessions + upload_chunks — BYTEA parts waste storage.
      //     Look up by completedVideoId (the FK linking a finished session to
      //     its managed_videos row). Chunks cascade via upload_sessions.session_id
      //     IF the FK exists; otherwise we delete them explicitly.
      const removedSessions = await db.execute(sql`
        DELETE FROM upload_sessions
        WHERE completed_video_id = ${id}
        RETURNING session_id
      `).catch((err) => {
        log.warn({ err, id }, "video-delete: failed to remove upload_sessions");
        return { rows: [] as { session_id: string }[] };
      });
      const sessionRows = (removedSessions as unknown as { rows: { session_id: string }[] }).rows;
      if (sessionRows.length > 0) {
        log.info(
          { id, count: sessionRows.length },
          "video-delete: removed upload_sessions for deleted video",
        );
        // Also purge any upload_chunks rows for the removed sessions.
        const sessionIds = sessionRows.map((r) => r.session_id);
        await db.execute(sql`
          DELETE FROM upload_chunks
          WHERE session_id = ANY(${sql.param(sessionIds)}::text[])
        `).catch((err) =>
          log.warn({ err, id }, "video-delete: failed to remove upload_chunks (non-fatal)"),
        );
      }

      // ── Step 3: Cache + catalog invalidation ──────────────────────────────
      // Bust the paginated video listing cache so the deleted video disappears
      // from all subsequent GET /api/v1/videos responses immediately.
      void invalidateVideosCatalogCache();

      // Notify admin SSE listeners so the library panel refreshes instantly
      // without waiting for the next polling interval.
      adminEventBus.push("videos-library-updated", { videoId: id, reason: "video-deleted" });

      // ── Step 4: Broadcast orchestrator reload ──────────────────────────────
      // Always fire broadcast-queue-updated, regardless of whether queue rows
      // were found. Even when no queue items existed for this video, the signal
      // forces the orchestrator to flush its internal hash cache and re-read the
      // DB, which is the correct action after any library mutation.
      //
      // The bus bridge in broadcast-v2/index.ts converts this event to
      // broadcastOrchestrator.reload(), which re-reads the active queue.
      // Because the broadcast_queue rows were deleted in step 2a (above), the
      // reload sees the already-clean state and seamlessly advances to the next
      // available item — no "Stream Unavailable" or blank-screen gap.
      adminEventBus.push("broadcast-queue-updated", {
        reason: "video-deleted",
        videoId: id,
        removedQueueItems: removedQueueItems.length,
      });

      // ── Step 5: Fire-and-forget storage blob cleanup ───────────────────────
      // The video row and all DB references are already gone. Storage cleanup
      // is best-effort: failures are logged as warnings, and any leftover blobs
      // are swept by the orphan-cleanup worker and the storage reconciliation
      // worker on their next pass. We do NOT block the 200 response here.
      void (async () => {
        const s = storage();

        // 5a. Raw source file (objectPath is the direct storage key).
        if (deleted.objectPath) {
          await s.deleteObject(deleted.objectPath).catch((err) =>
            log.warn(
              { err, id, objectPath: deleted.objectPath },
              "video-delete: failed to remove source object (non-fatal, will be GC'd)",
            ),
          );
        }

        // 5b. HLS tree: master.m3u8 + rendition playlists + .ts segments.
        //     Transcoder stores everything under `transcoded/{videoId}/`.
        //     Zero-row deletes are safe — no error if the prefix is empty.
        const hlsDeleted = await s.deleteByPrefix(`transcoded/${id}/`).catch((err) => {
          log.warn({ err, id }, "video-delete: failed to purge HLS tree (non-fatal, will be GC'd)");
          return 0;
        });
        if (hlsDeleted > 0) {
          log.info({ id, hlsDeleted }, "video-delete: purged HLS segments");
        }

        // 5c. Thumbnail — local thumbnails are served at `/api/v1/uploads/{key}`.
        //     Skip external URLs (YouTube CDN, etc.) and empty strings.
        const thumbUrl = deleted.thumbnailUrl ?? "";
        if (thumbUrl.startsWith("/api/v1/uploads/")) {
          const thumbKey = thumbUrl.slice("/api/v1/uploads/".length);
          await s.deleteObject(thumbKey).catch((err) =>
            log.warn(
              { err, id, thumbKey },
              "video-delete: failed to remove thumbnail (non-fatal, will be GC'd)",
            ),
          );
        }
      })().catch((err) =>
        log.warn({ err, id }, "video-delete: unexpected error in storage cleanup IIFE (non-fatal)"),
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
        objectKey: row.objectPath,
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
          const fsResult = await runFaststart(id, row.objectPath!, { skipStatusUpdate: false });
          if (fsResult.ok) {
            // faststart relocated the moov atom — enqueue for broadcast automatically
            // so the operator doesn't need a separate manual step.
            try {
              const enqRes = await enqueueIfMissing({ videoId: id, reason: "faststart-complete" });
              if (enqRes.enqueued) {
                adminEventBus.push("broadcast-queue-updated", { reason: "manual-faststart-complete", videoId: id });
                req.log.info({ videoId: id, queueItemId: enqRes.queueItemId }, "admin: faststart succeeded — video enrolled in broadcast queue");
              } else {
                req.log.info({ videoId: id }, "admin: faststart succeeded — video already in broadcast queue");
              }
            } catch (enqErr) {
              req.log.warn({ err: enqErr, videoId: id }, "admin: enqueueIfMissing after faststart failed (non-fatal)");
            }
            adminEventBus.push("videos-library-updated", { videoId: id, reason: "faststart-complete" });
            // Clear public catalog cache and notify the admin videos page
            // so the "Applying faststart…" spinner is cleared immediately.
            void invalidateVideosCatalogCache();
            adminEventBus.push("broadcast-source-upgraded", { videoId: id, quality: "mp4_faststart" });
            // Schedule comprehensive 9-check playback validation now that
            // the moov atom is confirmed at the start of the file.
            scheduleVideoValidation(id, row.objectPath!, { faststartApplied: true });
          } else {
            req.log.warn({ videoId: id, rootCause: fsResult.rootCause }, "admin: manual faststart failed");
          }
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

  // ── POST /videos/faststart-all ───────────────────────────────────────────────
  // Bulk-apply MP4 faststart (moov-atom relocation) to every locally-uploaded
  // video that has not yet been optimised (faststartApplied IS NULL or false)
  // and is not currently running (transcodingStatus != 'processing').
  // All jobs run sequentially in the background — the route returns 202 as soon
  // as the candidate list is built, so large libraries never block the request.
  r.post(
    "/videos/faststart-all",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["admin"],
        summary: "Apply MP4 faststart optimisation to all unoptimised locally-uploaded videos",
        response: {
          202: z.object({
            ok: z.literal(true),
            queued: z.number().int(),
            alreadyRunning: z.number().int(),
          }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      // Fetch all candidates: local uploads with an object path that are either
      // unoptimised (faststartApplied IS NULL → never attempted, or false → failed)
      // and not currently being processed.
      const candidates = await db
        .select({
          id: videos.id,
          objectPath: videos.objectPath,
          transcodingStatus: videos.transcodingStatus,
        })
        .from(videos)
        .where(
          and(
            ne(videos.videoSource, "youtube"),
            isNotNull(videos.objectPath),
            or(isNull(videos.faststartApplied), eq(videos.faststartApplied, false)),
          ),
        )
        .orderBy(asc(videos.importedAt));

      const active = candidates.filter((r) => r.transcodingStatus === "processing");
      const queued = candidates.filter((r) => r.transcodingStatus !== "processing");

      req.log.info(
        { total: candidates.length, queued: queued.length, alreadyRunning: active.length },
        "admin: bulk faststart-all triggered",
      );

      // Fire all jobs sequentially in the background so the memory profile stays
      // flat (ffmpeg is spawned one-at-a-time, same as single-video faststart).
      void (async () => {
        for (const row of queued) {
          if (!row.objectPath) continue;
          try {
            const fsResult = await runFaststart(row.id, row.objectPath, { skipStatusUpdate: false });
            if (fsResult.ok) {
              try {
                const enqRes = await enqueueIfMissing({ videoId: row.id, reason: "faststart-all" });
                if (enqRes.enqueued) {
                  adminEventBus.push("broadcast-queue-updated", { reason: "faststart-all", videoId: row.id });
                }
              } catch { /* non-fatal */ }
              void invalidateVideosCatalogCache();
              adminEventBus.push("videos-library-updated", { videoId: row.id, reason: "faststart-complete" });
              adminEventBus.push("broadcast-source-upgraded", { videoId: row.id, quality: "mp4_faststart" });
              scheduleVideoValidation(row.id, row.objectPath, { faststartApplied: true });
              req.log.info({ videoId: row.id }, "admin: bulk faststart-all — video succeeded");
            } else {
              req.log.warn(
                { videoId: row.id, rootCause: fsResult.rootCause },
                "admin: bulk faststart-all — video failed (non-fatal, recovery worker will retry)",
              );
            }
          } catch (err) {
            req.log.warn({ err, videoId: row.id }, "admin: bulk faststart-all — video crashed (non-fatal)");
          }
        }
        req.log.info({ processed: queued.length }, "admin: bulk faststart-all complete");
      })().catch((err) => req.log.error({ err }, "admin: bulk faststart-all outer crash"));

      return reply.code(202).send({ ok: true as const, queued: queued.length, alreadyRunning: active.length });
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
          await enqueueTranscode({ videoId: row.id, objectKey: row.objectPath });
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

  // ── GET /admin/videos/:id/validation ──────────────────────────────────────
  r.get(
    "/videos/:id/validation",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["admin"],
        summary: "Get the stored validation report for a local video (9-check broadcast-grade validation)",
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().min(1) }),
        response: {
          200: z.object({
            videoId: z.string(),
            validationStatus: z.enum(["pending", "running", "passed", "warn", "failed"]).nullable(),
            validationCompletedAt: z.string().nullable(),
            report: z.unknown().nullable(),
          }),
          404: z.object({ error: z.string() }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;

      const [row] = await db
        .select({
          id: videos.id,
          validationStatus: videos.validationStatus,
          validationCompletedAt: videos.validationCompletedAt,
        })
        .from(videos)
        .where(eq(videos.id, id))
        .limit(1);

      if (!row) return reply.code(404).send({ error: "Video not found" });

      const report = await getStoredValidationReport(id);
      const vs = row.validationStatus;

      return {
        videoId: id,
        validationStatus: (vs === "pending" || vs === "running" || vs === "passed" || vs === "warn" || vs === "failed") ? vs : null,
        validationCompletedAt: row.validationCompletedAt?.toISOString() ?? null,
        report,
      };
    },
  );

  // ── POST /admin/videos/:id/validation/run ─────────────────────────────────
  r.post(
    "/videos/:id/validation/run",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["admin"],
        summary: "Trigger a fresh validation run for a local video (9-check broadcast-grade validation). Non-blocking: returns immediately, runs in background.",
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().min(1) }),
        body: z.object({
          /** If true, wait for validation to finish and return the full report. Default: false (fire-and-forget). */
          sync: z.boolean().default(false),
        }).default({}),
        response: {
          200: z.object({
            videoId: z.string(),
            message: z.string(),
            report: z.unknown().nullable(),
          }),
          404: z.object({ error: z.string() }),
          422: z.object({ error: z.string() }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { sync } = req.body;

      const [row] = await db
        .select({
          id: videos.id,
          objectPath: videos.objectPath,
          videoSource: videos.videoSource,
          faststartApplied: videos.faststartApplied,
          localVideoUrl: videos.localVideoUrl,
          duration: videos.duration,
        })
        .from(videos)
        .where(eq(videos.id, id))
        .limit(1);

      if (!row) return reply.code(404).send({ error: "Video not found" });
      if (row.videoSource !== "local") {
        return reply.code(422).send({ error: "Validation only applies to locally-uploaded MP4 files, not YouTube videos" });
      }
      if (!row.objectPath) {
        return reply.code(422).send({ error: "Video has no source file — upload or re-upload required before validation" });
      }

      if (sync) {
        const report = await runVideoValidation(id, row.objectPath, {
          faststartApplied: row.faststartApplied ?? null,
          localVideoUrl: row.localVideoUrl ?? null,
          storedDurationSecs: row.duration ? parseFloat(row.duration) : null,
        });
        return { videoId: id, message: `Validation complete — status: ${report.status}`, report };
      }

      scheduleVideoValidation(id, row.objectPath, {
        faststartApplied: row.faststartApplied ?? null,
        localVideoUrl: row.localVideoUrl ?? null,
        storedDurationSecs: row.duration ? parseFloat(row.duration) : null,
      });

      return { videoId: id, message: "Validation scheduled — check GET /admin/videos/:id/validation for results", report: null };
    },
  );

  // ── POST /admin/videos/:id/generate-thumbnail ─────────────────────────────
  r.post(
    "/videos/:id/generate-thumbnail",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["admin"],
        summary: "Extract a thumbnail frame from a local video using ffmpeg and save it to storage",
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().min(1) }),
        body: z.object({
          /** If true, regenerate even if a thumbnailUrl already exists (ignores hasCustomThumbnail). */
          force: z.boolean().default(false),
        }),
        response: {
          200: z.object({
            videoId: z.string(),
            thumbnailUrl: z.string(),
            generated: z.boolean(),
            message: z.string(),
          }),
          404: z.object({ error: z.string() }),
          422: z.object({ error: z.string() }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { force } = req.body;

      const result = await generateThumbnailForVideo(id, force);

      if (result.error === "Video not found") {
        return reply.code(404).send({ error: "Video not found" });
      }
      if (!result.generated && result.error && !result.thumbnailUrl) {
        return reply.code(422).send({ error: result.error ?? "Thumbnail generation failed" });
      }

      // Invalidate catalog cache so updated thumbnailUrl is served immediately.
      if (result.generated) {
        invalidateVideosCatalogCache();
        adminEventBus.push("videos-library-updated", {});
      }

      return {
        videoId: result.videoId,
        thumbnailUrl: result.thumbnailUrl,
        generated: result.generated,
        message: result.generated
          ? "Thumbnail generated successfully"
          : (result.error ?? "Thumbnail already exists"),
      };
    },
  );
}
