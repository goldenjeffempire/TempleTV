import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { storage } from "../../infrastructure/storage.js";
import { requireAuth } from "../../middleware/auth.js";
import { uploadSessions, type UploadSession } from "./upload-sessions.js";
import { generateQuickThumbnail, probeUploadedDuration } from "../transcoder/transcoder.service.js";
import { env } from "../../config/env.js";
import { invalidateVideosCatalogCache } from "../videos/videos.routes.js";
import { broadcastEngine } from "../broadcast/queue.engine.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { uploadTelemetry } from "./upload-telemetry.service.js";
import { chunkedUploadRoutes } from "./chunked-upload.routes.js";
import { logger } from "../../infrastructure/logger.js";
import { ServiceUnavailableError, InternalError } from "../../shared/errors.js";
import { enqueueIfMissing } from "../broadcast/auto-enqueue.service.js";

const dbSessions = schema.uploadSessionsTable;

/**
 * Persist a multipart session to the `upload_sessions` table so it
 * survives an API-server restart (F02). Non-fatal — the in-memory registry
 * is still the primary store; this is a durability write-through.
 */
async function persistSessionToDb(session: UploadSession): Promise<void> {
  await db.insert(dbSessions).values({
    sessionId: session.sessionId,
    uploadId: session.uploadId,
    objectKey: session.objectKey,
    title: session.title,
    contentType: session.contentType,
    sizeBytes: session.sizeBytes,
    totalChunks: session.totalParts,
    chunkSize: session.partSize,
    storageBackend: "db",
    status: "uploading",
  }).onConflictDoNothing();
}

/**
 * Recover a session from DB when it's missing from the in-memory registry
 * (e.g., after a server restart). Returns null if not found in DB either.
 */
async function recoverSessionFromDb(sessionId: string): Promise<UploadSession | null> {
  try {
    const rows = await db
      .select()
      .from(dbSessions)
      .where(eq(dbSessions.sessionId, sessionId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const recovered: UploadSession = {
      sessionId: row.sessionId,
      uploadId: row.uploadId ?? "",
      objectKey: row.objectKey ?? "",
      title: row.title,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      partSize: row.chunkSize,
      totalParts: row.totalChunks,
      startedAt: row.createdAt.getTime(),
      completedVideoId: row.completedVideoId ?? null,
      // completedAt is not persisted to DB; default to null for recovered sessions.
      // The TTL sweep uses startedAt as a fallback, which is acceptable for the
      // rare post-restart idempotency window.
      completedAt: null,
    };
    // Re-hydrate into the in-memory registry for future lookups
    uploadSessions.restore(recovered);
    logger.info({ sessionId }, "[upload-sessions] recovered from DB after restart");
    return recovered;
  } catch (err) {
    logger.warn({ err, sessionId }, "[upload-sessions] db recovery failed (non-fatal)");
    return null;
  }
}

/**
 * Mark a session as completed in the DB (non-fatal).
 */
async function markDbSessionCompleted(sessionId: string, videoId: string): Promise<void> {
  try {
    await db
      .update(dbSessions)
      .set({ status: "completed", completedVideoId: videoId, updatedAt: new Date() })
      .where(eq(dbSessions.sessionId, sessionId));
  } catch (err) {
    logger.warn({ err, sessionId, videoId }, "[upload-sessions] db complete update failed (non-fatal)");
  }
}

/**
 * Mark a session as failed in the DB (non-fatal).
 */
async function markDbSessionFailed(sessionId: string, reason: string): Promise<void> {
  try {
    await db
      .update(dbSessions)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(dbSessions.sessionId, sessionId));
  } catch (err) {
    logger.warn({ err, sessionId, reason }, "[upload-sessions] db fail update failed (non-fatal)");
  }
}

/**
 * Best-effort cleanup when a finalized upload is rejected (e.g. corrupt
 * container). The object has already been materialized in storage by the
 * time these gates run, so a bare `throw` would leave an orphan blob plus a
 * lingering in-memory + DB session. This removes the stored object, drops the
 * in-memory session, and marks the DB session failed. Every step is non-fatal
 * — the storage lifecycle reaper is the backstop if any of them error.
 */
async function cleanupRejectedUpload(
  sessionId: string,
  objectKey: string,
  reason: string,
): Promise<void> {
  try {
    await storage().deleteObject(objectKey);
  } catch (err) {
    logger.warn(
      { err, objectKey, reason },
      "[upload-reject] orphan object delete failed (non-fatal; lifecycle reaper will sweep)",
    );
  }
  try {
    uploadSessions.remove(sessionId);
  } catch {
    /* in-memory remove is best-effort */
  }
  await markDbSessionFailed(sessionId, reason);
}

/**
 * Database-backed multipart upload gateway.
 *
 * All video data is stored in PostgreSQL via DatabaseObjectStorage — no S3,
 * Replit Object Storage, or any external provider is used. These routes keep
 * their legacy "s3-" URL prefixes for backwards compatibility with existing
 * admin clients; the implementation underneath is entirely database-backed.
 *
 * Wire:
 *   1. POST /admin/videos/upload/s3-multipart-init
 *      → creates a DatabaseObjectStorage multipart slot, registers the session,
 *        returns { sessionId, uploadId, objectKey, partSize, totalParts, contentType }.
 *   2. POST /admin/videos/upload/s3-multipart-sign
 *      → returns 410 Gone (presigned URLs are not supported with DB storage;
 *        use the server-relay chunked path instead).
 *   3. POST /admin/videos/upload/s3-multipart-complete
 *      → calls DatabaseObjectStorage.completeMultipartUpload + HEAD-verify +
 *        inserts the videos row. Idempotent via session registry.
 *   4. POST /admin/videos/upload/s3-multipart-abort
 *      → aborts the in-flight multipart session in storage_blobs.
 *
 * All endpoints require `editor` role. The admin Operations tab's
 * `GET /admin/uploads/active` and `DELETE /admin/videos/upload/:id` read
 * and mutate the same `uploadSessions` registry.
 */

// Part-size constants kept for interface compatibility.
const S3_MIN_PART_BYTES = 5 * 1024 * 1024;       // 5 MiB
const S3_MAX_PARTS = 10_000;
const SIGN_BATCH_LIMIT = 1000;
const videos = schema.videosTable;

const InitBodySchema = z.object({
  title: z.string().min(1).max(500),
  sizeBytes: z.number().int().positive().max(50 * 1024 * 1024 * 1024),
  ext: z.string().max(16),
  mimeType: z.string().max(255).optional(),
  partSize: z.number().int().positive(),
});

const InitResponseSchema = z.object({
  sessionId: z.string(),
  uploadId: z.string(),
  objectKey: z.string(),
  partSize: z.number().int().positive(),
  totalParts: z.number().int().positive(),
  contentType: z.string(),
});

const SignBodySchema = z.object({
  uploadId: z.string(),
  objectKey: z.string(),
  partNumbers: z.array(z.number().int().positive()).min(1).max(SIGN_BATCH_LIMIT),
});

const CompleteBodySchema = z.object({
  sessionId: z.string(),
  uploadId: z.string(),
  objectKey: z.string(),
  parts: z
    .array(z.object({ partNumber: z.number().int().positive(), etag: z.string() }))
    .min(1),
  title: z.string().min(1).max(500),
  category: z.string().max(64).optional().nullable(),
  preacher: z.string().max(255).optional().nullable(),
  featured: z.boolean().optional(),
  durationSecs: z.number().nonnegative().optional(),
  sizeBytes: z.number().int().positive(),
  mimeType: z.string().max(255).optional(),
  originalFilename: z.string().max(500).optional(),
  clientDurationMs: z.number().nonnegative().optional(),
});

const VideoRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  videoSource: z.string(),
  localVideoUrl: z.string().nullable(),
  duration: z.string().nullable(),
  category: z.string().nullable(),
  preacher: z.string().nullable(),
  featured: z.boolean(),
  transcodingWarning: z.string().nullable().optional(),
});

const AbortBodySchema = z.object({
  uploadId: z.string(),
  objectKey: z.string(),
});


const S3FinalizeBodySchema = z.object({
  sessionId: z.string(),
  objectKey: z.string(),
  title: z.string().min(1).max(500),
  category: z.string().max(64).optional().nullable(),
  preacher: z.string().max(255).optional().nullable(),
  featured: z.boolean().optional(),
  durationSecs: z.number().nonnegative().optional(),
  sizeBytes: z.number().int().positive(),
  mimeType: z.string().max(255).optional(),
  originalFilename: z.string().max(500).optional(),
  clientDurationMs: z.number().nonnegative().optional(),
});

function safeExt(ext: string): string {
  const cleaned = ext.replace(/^\./, "").toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(cleaned) ? cleaned : "bin";
}

function buildObjectKey(ext: string): string {
  // Datestamped prefix keeps the bucket browsable and lets lifecycle
  // rules expire orphan parts by date.
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `uploads/${yyyy}/${mm}/${dd}/${randomUUID()}.${safeExt(ext)}`;
}

function ensureStorageEnabled(): void {
  if (!storage().enabled) {
    throw new ServiceUnavailableError("Object storage is not available.");
  }
}

export async function mediaUploadsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/videos/upload/s3-multipart-init",
    {
      preHandler: requireAuth("editor"),
      // Creates an S3 multipart session (external API call + DB row).
      // 10/min allows uploading 10 new files per minute which exceeds
      // the UI's MAX_CONCURRENT_FILES=3 cap with generous headroom.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },      schema: {
        tags: ["uploads"],
        summary: "Begin an S3 multipart upload session",
        body: InitBodySchema,
        response: { 200: InitResponseSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      ensureStorageEnabled();
      const body = req.body;
      // Clamp the part size to S3's minimum (5 MiB) so we don't get a
      // surprise EntityTooSmall on Complete. The client already clamps
      // but a stale build could slip through.
      const partSize = Math.max(S3_MIN_PART_BYTES, body.partSize);
      const totalParts = Math.min(
        S3_MAX_PARTS,
        Math.max(1, Math.ceil(body.sizeBytes / partSize)),
      );
      const contentType = body.mimeType || "application/octet-stream";
      const objectKey = buildObjectKey(body.ext);

      let uploadId: string;
      try {
        ({ uploadId } = await storage().createMultipartUpload({ key: objectKey, contentType }));
      } catch (err) {
        req.log.error({ err, objectKey }, "[s3-multipart-init] createMultipartUpload failed");
        throw new ServiceUnavailableError(
          err instanceof Error ? err.message : "Object storage unavailable",
        );
      }

      const session = uploadSessions.start({
        uploadId,
        objectKey,
        title: body.title,
        contentType,
        sizeBytes: body.sizeBytes,
        partSize,
        totalParts,
      });

      // F02: persist to DB so session survives a server restart.
      // Await and return 500 on failure so the client can retry rather than
      // silently proceeding with a session that would be lost on restart.
      try {
        await persistSessionToDb(session);
      } catch (err) {
        req.log.error(
          { err, sessionId: session.sessionId },
          "[s3-multipart-init] failed to persist session to DB — aborting init so client can retry",
        );
        uploadSessions.remove(session.sessionId);
        void storage().abortMultipartUpload({ key: objectKey, uploadId }).catch(() => {});
        throw Object.assign(
          new Error("Failed to register upload session — please retry."),
          { statusCode: 500 },
        );
      }

      req.log.info(
        { sessionId: session.sessionId, uploadId, objectKey, totalParts, sizeBytes: body.sizeBytes },
        "[s3-multipart-init]",
      );

      return {
        sessionId: session.sessionId,
        uploadId,
        objectKey,
        partSize,
        totalParts,
        contentType,
      };
    },
  );

  r.post(
    "/videos/upload/s3-multipart-sign",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },      schema: {
        tags: ["uploads"],
        summary: "Presign a batch of multipart-upload PUT URLs (not supported — use chunked relay path)",
        body: SignBodySchema,
        response: { 410: z.object({ error: z.string() }), 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (_req, reply) => {
      return reply.code(410).send({
        error:
          "Presigned upload URLs are not supported — all video data must flow through the server. " +
          "Use the server-relay chunked upload path (/api/admin/videos/upload/init).",
      });
    },
  );

  r.post(
    "/videos/upload/s3-multipart-complete",
    {
      preHandler: requireAuth("editor"),
      // Assembles multipart parts in DB — CPU + I/O intensive. 10/min
      // matches the init endpoint cap.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },      schema: {
        tags: ["uploads"],
        summary: "Complete the multipart upload and register the video row",
        body: CompleteBodySchema,
        response: { 200: VideoRowSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      ensureStorageEnabled();
      const body = req.body;
      // F02: fall back to DB recovery when session is absent from memory
      // (e.g., the API server restarted mid-upload).
      let session = uploadSessions.get(body.sessionId);
      if (!session) session = await recoverSessionFromDb(body.sessionId) ?? undefined;

      // Idempotency guard. If a previous Complete already inserted the
      // videos row, return the same row instead of double-completing
      // (the client retries this endpoint up to 3× on 5xx/timeouts —
      // see VideoUploadModal "Robust multipart-complete with timeout +
      // retry").
      if (session?.completedVideoId) {
        const rows = await db
          .select()
          .from(videos)
          .where(eq(videos.id, session.completedVideoId))
          .limit(1);
        if (rows[0]) {
          return projectVideoRow(rows[0]);
        }
      }

      const completed = await storage().completeMultipartUpload({
        key: body.objectKey,
        uploadId: body.uploadId,
        parts: body.parts,
      });

      // Verify the final object exists and the size matches what the
      // client claimed; mismatches usually indicate a part was dropped
      // silently by a flaky proxy mid-upload.
      const head = await storage().headObject(body.objectKey);
      if (!head.exists) {
        throw Object.assign(new Error("Storage reports the assembled object does not exist"), {
          statusCode: 502,
        });
      }
      if (head.contentLength != null && head.contentLength !== body.sizeBytes) {
        req.log.error(
          {
            objectKey: body.objectKey,
            expectedBytes: body.sizeBytes,
            actualBytes: head.contentLength,
          },
          "[s3-multipart-complete] size mismatch — upload is truncated or corrupt, rejecting",
        );
        // The multipart object was assembled in storage but has the wrong size.
        // Clean it up before rejecting so there is no orphaned blob.
        uploadTelemetry.serverFail(
          body.sessionId,
          head.contentLength,
          "size_mismatch",
          `Upload integrity check failed: expected ${body.sizeBytes} bytes but storage reports ${head.contentLength}.`,
        );
        await cleanupRejectedUpload(body.sessionId, body.objectKey, "size-mismatch").catch((e: unknown) =>
          req.log.warn({ err: e, objectKey: body.objectKey }, "[s3-multipart-complete] size-mismatch cleanup failed (non-fatal)"),
        );
        throw Object.assign(
          new Error(
            `Upload integrity check failed: expected ${body.sizeBytes} bytes but storage reports ${head.contentLength}. ` +
              "The file may have been truncated in transit. Please retry the upload.",
          ),
          { statusCode: 422 },
        );
      }

      const localVideoUrl = completed.location || storage().publicUrl(body.objectKey);
      const videoId = randomUUID();
      // Guard: if the DB insert fails after storage assembly succeeded, the object
      // would be orphaned forever. Catch the error, clean up the storage object,
      // then re-throw a 500 so the client knows to retry.
      const inserted = await db
        .insert(videos)
        .values({
          id: videoId,
          youtubeId: null,
          title: body.title,
          description: "",
          thumbnailUrl: "",
          duration: body.durationSecs ? String(Math.round(body.durationSecs)) : "0",
          category: body.category ?? "sermon",
          preacher: body.preacher ?? "",
          publishedAt: null,
          videoSource: "local",
          localVideoUrl: localVideoUrl ?? null,
          featured: body.featured ?? false,
        })
        .returning()
        .catch(async (dbErr: unknown) => {
          req.log.error(
            { err: dbErr, objectKey: body.objectKey },
            "[s3-multipart-complete] videos insert failed after storage write — cleaning up orphaned object",
          );
          uploadTelemetry.serverFail(
            body.sessionId,
            body.sizeBytes,
            "db_insert_failed",
            dbErr instanceof Error ? dbErr.message : "DB videos insert failed after storage write",
          );
          await cleanupRejectedUpload(body.sessionId, body.objectKey, "db-insert-failed");
          throw Object.assign(
            new Error("Failed to create video record — the upload is safe to retry."),
            { statusCode: 500 },
          );
        });
      const row = inserted[0];
      if (!row) throw new InternalError("videos insert returned no rows — database may be under load, retry finalization");

      uploadSessions.markCompleted(body.sessionId, row.id);
      // F02: update the persisted DB row so recovery after restart returns
      // the completed state and idempotency works across restarts.
      markDbSessionCompleted(body.sessionId, row.id).catch((e: unknown) => {
        req.log.warn({ err: e }, "[finalize] markDbSessionCompleted background update failed — idempotency window shortened");
      });
      // Drop the session shortly after so it doesn't pile up in the
      // admin Operations tab. The idempotency window is small (the
      // client retries within 90 s × 3 attempts = ~5 minutes max).
      setTimeout(() => uploadSessions.remove(body.sessionId), 10 * 60 * 1000).unref();

      // Proactively bust the public catalogue cache so the new video
      // appears on the next GET /api/videos without waiting for the TTL.
      invalidateVideosCatalogCache().catch((e: unknown) => {
        req.log.warn({ err: e }, "[finalize] invalidateVideosCatalogCache failed — next poll will pick up the new video");
      });

      // Push a fresh broadcast snapshot so any SSE-connected client (admin
      // dashboard, TV, mobile) receives an immediate notification that the
      // video library changed. Clients listening to /realtime/sse will get
      // the snapshot event and can trigger a React Query refetch to pick up
      // the new video row without waiting for their next poll interval.
      try {
        broadcastEngine.pushSnapshot();
      } catch {
        // Non-fatal — SSE push is best-effort; the cache bust above ensures
        // the next HTTP poll will always see the new video.
      }
      // Notify SSE-subscribed admin tabs (transcoding panel, library, broadcast
      // queue) that a new video has landed. Without this push they only update
      // on their next poll interval, not in real time.
      adminEventBus.push("videos-library-updated", { videoId: row.id, reason: "upload-finalize" });
      adminEventBus.push("broadcast-queue-updated", { reason: "upload-finalize", videoId: row.id });

      // Immediately enqueue the video into the broadcast queue.
      // s3MirroredAt is already stamped in the insert above, so
      // isPlayableForBroadcast's blob-existence gate will pass.
      // Fire-and-forget: the upload-queue-reconciler worker is the backstop
      // if this transient call fails.
      void (async () => {
        try {
          const enqRes = await enqueueIfMissing({ videoId: row.id, reason: "upload-finalize" });
          if (enqRes.enqueued) {
            req.log.info(
              { videoId: row.id, queueItemId: enqRes.queueItemId },
              "[s3-multipart-complete] video enrolled in broadcast queue",
            );
            adminEventBus.push("broadcast-queue-updated", { reason: "s3-multipart-complete-enqueued", videoId: row.id });
          } else {
            req.log.info(
              { videoId: row.id, skipReason: enqRes.skipReason },
              "[s3-multipart-complete] enqueueIfMissing: skipped",
            );
          }
        } catch (enqErr) {
          req.log.warn({ err: enqErr, videoId: row.id }, "[s3-multipart-complete] enqueueIfMissing failed (non-fatal — upload-queue-reconciler will recover within 60 s)");
        }
      })();

      uploadTelemetry.success(body.sessionId, row.id, body.sizeBytes, 0);

      // Fire quick thumbnail extraction and duration probing in parallel —
      // both are non-blocking background tasks. Thumbnail extracts a frame
      // at t=1s so the admin UI shows a preview immediately. Duration runs
      // ffprobe on the source file and updates the duration field only when
      // the client-provided value was absent or zero (authoritative server-
      // side measurement without waiting for the full HLS transcode).
      const _clientDuration = Number(row.duration ?? "0");
      void (async () => {
        try {
          const [thumbUrl, probedSecs] = await Promise.all([
            generateQuickThumbnail(body.objectKey, row.id),
            _clientDuration > 0 ? Promise.resolve(null) : probeUploadedDuration(body.objectKey),
          ]);
          const patch: Partial<typeof schema.videosTable.$inferInsert> = {};
          if (thumbUrl) patch.thumbnailUrl = thumbUrl;
          if (probedSecs != null) patch.duration = String(Math.round(probedSecs));
          if (Object.keys(patch).length > 0) {
            await db
              .update(schema.videosTable)
              .set(patch)
              .where(eq(schema.videosTable.id, row.id));
            void invalidateVideosCatalogCache();
          }
        } catch (err) {
          req.log.warn({ err, videoId: row.id }, "[s3-multipart-complete] post-upload probes failed (non-fatal)");
        }
      })();

      const transcodingWarning: string | null = null;

      req.log.info(
        {
          sessionId: body.sessionId,
          videoId: row.id,
          objectKey: body.objectKey,
          sizeBytes: body.sizeBytes,
          clientDurationMs: body.clientDurationMs,
          transcodingWarning,
        },
        "[s3-multipart-complete] ok",
      );

      return { ...projectVideoRow(row), transcodingWarning };
    },
  );

  r.post(
    "/videos/upload/s3-multipart-abort",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },      schema: {
        tags: ["uploads"],
        summary: "Abort an in-flight multipart upload",
        body: AbortBodySchema,
        response: { 200: z.object({ ok: z.literal(true) }), 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      ensureStorageEnabled();
      const body = req.body;
      try {
        await storage().abortMultipartUpload({
          key: body.objectKey,
          uploadId: body.uploadId,
        });
      } catch (err) {
        // Lifecycle reaps orphans even if the abort fails; log and ack
        // so the client doesn't hang on cleanup.
        req.log.warn({ err, objectKey: body.objectKey }, "[s3-multipart-abort] failed");
      }
      return { ok: true as const };
    },
  );

  // Single-PUT presigned URL — not supported with database-backed storage.
  // Returns 410 Gone so clients know to use the server-relay chunked path.
  r.post(
    "/videos/upload/s3-init",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },      schema: {
        tags: ["uploads"],
        summary: "Not supported — use the chunked server-relay path instead",
        body: z.object({
          ext: z.string().max(16).default("bin"),
          mimeType: z.string().max(255).optional(),
        }),
        response: { 410: z.object({ error: z.string() }), 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (_req, reply) => {
      return reply.code(410).send({
        error:
          "Single-PUT presigned uploads are not supported — all video data must flow through the server. " +
          "Use the server-relay chunked upload path (/api/admin/videos/upload/init).",
      });
    },
  );

  // Finalize a single-PUT upload that previously landed in database storage.
  r.post(
    "/videos/upload/s3-finalize",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },      schema: {
        tags: ["uploads"],
        summary: "Finalize a single-PUT upload and register the video row",
        body: S3FinalizeBodySchema,
        response: { 200: VideoRowSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      ensureStorageEnabled();
      const body = req.body;

      // Idempotency: if this session was already finalized, return existing row.
      // F02: fall back to DB recovery on restart.
      let session = uploadSessions.get(body.sessionId);
      if (!session) session = await recoverSessionFromDb(body.sessionId) ?? undefined;
      if (session?.completedVideoId) {
        const rows = await db
          .select()
          .from(videos)
          .where(eq(videos.id, session.completedVideoId))
          .limit(1);
        if (rows[0]) return projectVideoRow(rows[0]);
      }

      // Verify the object actually landed in database storage and matches the
      // declared size. A size mismatch means the PUT was truncated in transit.
      const head = await storage().headObject(body.objectKey);
      if (!head.exists) {
        throw Object.assign(
          new Error(
            `Object not found in storage at ${body.objectKey}. ` +
              "The upload may have failed silently — try uploading again.",
          ),
          { statusCode: 502 },
        );
      }
      if (head.contentLength != null && head.contentLength !== body.sizeBytes) {
        req.log.error(
          { objectKey: body.objectKey, expectedBytes: body.sizeBytes, actualBytes: head.contentLength },
          "[s3-finalize] size mismatch — upload is truncated or corrupt, rejecting",
        );
        uploadTelemetry.serverFail(
          body.sessionId,
          head.contentLength,
          "size_mismatch",
          `Upload integrity check failed: expected ${body.sizeBytes} bytes but storage reports ${head.contentLength}.`,
        );
        await cleanupRejectedUpload(body.sessionId, body.objectKey, "size-mismatch").catch((e: unknown) =>
          req.log.warn({ err: e, objectKey: body.objectKey }, "[s3-finalize] size-mismatch cleanup failed (non-fatal)"),
        );
        throw Object.assign(
          new Error(
            `Upload integrity check failed: expected ${body.sizeBytes} bytes but storage reports ${head.contentLength}. ` +
              "The file may have been truncated in transit. Please retry the upload.",
          ),
          { statusCode: 422 },
        );
      }

      const localVideoUrl = storage().publicUrl(body.objectKey);
      const videoId = randomUUID();
      // Guard: if the DB insert fails after the object is already in storage,
      // the blob would be orphaned forever. Catch the error, clean up, telemetry,
      // then re-throw a 500 so the client knows to retry.
      const inserted = await db
        .insert(videos)
        .values({
          id: videoId,
          youtubeId: null,
          title: body.title,
          description: "",
          thumbnailUrl: "",
          duration: body.durationSecs ? String(Math.round(body.durationSecs)) : "0",
          category: body.category ?? "sermon",
          preacher: body.preacher ?? "",
          publishedAt: null,
          videoSource: "local",
          localVideoUrl: localVideoUrl ?? null,
          featured: body.featured ?? false,
          originalFilename: body.originalFilename ?? null,
          mimeType: body.mimeType ?? null,
          sizeBytes: body.sizeBytes,
          objectPath: body.objectKey,
          s3MirroredAt: new Date(),
        })
        .returning()
        .catch(async (dbErr: unknown) => {
          req.log.error(
            { err: dbErr, objectKey: body.objectKey },
            "[s3-finalize] videos insert failed after storage write — cleaning up orphaned object",
          );
          uploadTelemetry.serverFail(
            body.sessionId,
            body.sizeBytes,
            "db_insert_failed",
            dbErr instanceof Error ? dbErr.message : "DB videos insert failed after storage write",
          );
          await cleanupRejectedUpload(body.sessionId, body.objectKey, "db-insert-failed");
          throw Object.assign(
            new Error("Failed to create video record — the upload is safe to retry."),
            { statusCode: 500 },
          );
        });
      const row = inserted[0];
      if (!row) throw new InternalError("videos insert returned no rows — database may be under load, retry finalization");

      uploadSessions.markCompleted(body.sessionId, row.id);
      // F02: update the persisted DB row so idempotency works across restarts.
      void markDbSessionCompleted(body.sessionId, row.id);
      setTimeout(() => uploadSessions.remove(body.sessionId), 10 * 60 * 1000).unref();

      void invalidateVideosCatalogCache();
      try {
        broadcastEngine.pushSnapshot();
      } catch {
        /* non-fatal */
      }
      // Notify SSE-subscribed admin tabs (transcoding panel, library, broadcast
      // queue) that a new video has landed. Without this push they only update
      // on their next poll interval, not in real time.
      adminEventBus.push("videos-library-updated", { videoId: row.id, reason: "upload-finalize" });
      adminEventBus.push("broadcast-queue-updated", { reason: "upload-finalize", videoId: row.id });

      // Immediately enqueue the video into the broadcast queue.
      // s3MirroredAt is already stamped in the insert above, so
      // isPlayableForBroadcast's blob-existence gate will pass.
      // Fire-and-forget: the upload-queue-reconciler worker is the backstop
      // if this transient call fails.
      void (async () => {
        try {
          const enqRes = await enqueueIfMissing({ videoId: row.id, reason: "upload-finalize" });
          if (enqRes.enqueued) {
            req.log.info(
              { videoId: row.id, queueItemId: enqRes.queueItemId },
              "[s3-finalize] video enrolled in broadcast queue",
            );
            adminEventBus.push("broadcast-queue-updated", { reason: "s3-finalize-enqueued", videoId: row.id });
          } else {
            req.log.info(
              { videoId: row.id, skipReason: enqRes.skipReason },
              "[s3-finalize] enqueueIfMissing: skipped",
            );
          }
        } catch (enqErr) {
          req.log.warn({ err: enqErr, videoId: row.id }, "[s3-finalize] enqueueIfMissing failed (non-fatal — upload-queue-reconciler will recover within 60 s)");
        }
      })();

      const transcodingWarning: string | null = null;

      req.log.info(
        {
          sessionId: body.sessionId,
          videoId: row.id,
          objectKey: body.objectKey,
          sizeBytes: body.sizeBytes,
          clientDurationMs: body.clientDurationMs,
          transcodingWarning,
        },
        "[s3-finalize] ok",
      );

      return { ...projectVideoRow(row), transcodingWarning };
    },
  );


  // ── Resumable chunked upload gateway (server-relay + DB-fallback path) ────
  // Handles POST /videos/upload/init, POST /videos/upload/:sid/chunk,
  // GET  /videos/upload/:sid/status, POST /videos/upload/:sid/thumbnail,
  // POST /videos/upload/:sid/finalize.
  await app.register(chunkedUploadRoutes);
}

function projectVideoRow(row: typeof videos.$inferSelect): z.infer<typeof VideoRowSchema> {
  return {
    id: row.id,
    title: row.title,
    videoSource: row.videoSource,
    localVideoUrl: row.localVideoUrl,
    duration: row.duration,
    category: row.category,
    preacher: row.preacher,
    featured: row.featured,
  };
}
