/**
 * Resumable chunked upload gateway (server-relay path).
 *
 * All video data flows through the server — no browser-direct or presigned
 * URL uploads. Every byte is stored in the PostgreSQL `storage_blobs` table
 * via DatabaseObjectStorage. No S3, Replit Object Storage, or any cloud
 * provider is involved.
 *
 * Wire:
 *   POST /admin/videos/upload/init
 *     → create DB session; initialise DatabaseObjectStorage multipart slot
 *   POST /admin/videos/upload/:sessionId/chunk
 *     → receive raw binary chunk (application/octet-stream), verify SHA-256,
 *       store as a multipart part in storage_blobs (db mode) OR as raw BYTEA
 *       in upload_chunks.fallback_data (db_fallback mode)
 *   GET  /admin/videos/upload/:sessionId/status
 *     → return { uploadedChunkIndices } so the client can resume mid-flight
 *   POST /admin/videos/upload/:sessionId/thumbnail
 *     → accept optional custom thumbnail; store in storage_blobs
 *   POST /admin/videos/upload/:sessionId/finalize
 *     → assemble multipart parts (db mode) or BYTEA chunks (db_fallback mode)
 *       into the final storage_blobs row, insert managed_videos row, and
 *       enqueue HLS transcoding
 *
 * DB-fallback rescue layer:
 *   If DatabaseObjectStorage.createMultipartUpload fails at init time the
 *   session falls back to 'db_fallback' mode. Every chunk is stored as BYTEA
 *   in upload_chunks.fallback_data. On finalize the server reassembles them
 *   via a fresh multipart session entirely inside PostgreSQL. No video data
 *   is ever lost.
 */

import { randomUUID, createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq, asc, and, inArray, lt, sql } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { storage } from "../../infrastructure/storage.js";
import { requireAuth } from "../../middleware/auth.js";
import { enqueueTranscode } from "../transcoder/transcoder.queue.js";
import { generateQuickThumbnail, normalizeThumbnailBuffer, probeUploadedDuration } from "../transcoder/transcoder.service.js";
import { runFaststart } from "../transcoder/faststart.service.js";
import { invalidateVideosCatalogCache } from "../videos/videos.routes.js";
import { env } from "../../config/env.js";
import { broadcastEngine } from "../broadcast/queue.engine.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { ServiceUnavailableError } from "../../shared/errors.js";

const sessions = schema.uploadSessionsTable;
const chunks = schema.uploadChunksTable;
const videos = schema.videosTable;

// Minimum part size used when reassembling db_fallback chunks into a multipart
// upload. Mirrors S3's 5 MiB floor so sessions can be migrated without changes.

// ─── Schema helpers ───────────────────────────────────────────────────────────

// 100 GiB hard upper limit — Postgres BYTEA can hold it, but signals misconfiguration above this.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024 * 1024;

const InitBodySchema = z.object({
  sessionId: z.string().uuid(),
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional().default(""),
  category: z.string().max(64).optional().default("sermon"),
  preacher: z.string().max(255).optional().default(""),
  featured: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (typeof v === "string" ? v === "true" : (v ?? false))),
  durationSecs: z
    .union([z.number(), z.string()])
    .optional()
    .transform((v) => (v === undefined ? undefined : Number(v) || 0)),
  totalChunks: z
    .union([z.number().int(), z.string()])
    .transform((v) => Number(v))
    .pipe(z.number().int().min(1, "totalChunks must be at least 1").max(50_000, "totalChunks must not exceed 50,000")),
  totalBytes: z
    .union([z.number(), z.string()])
    .transform((v) => Number(v))
    .pipe(z.number().min(1, "File size must be at least 1 byte").max(MAX_UPLOAD_BYTES, "File size must not exceed 100 GB")),
  ext: z.string().max(16).optional().default("mp4"),
  originalFilename: z.string().max(500).optional(),
  mimeType: z.string().max(255).optional(),
});

function buildObjectKey(ext: string, sessionId: string): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const safeExt =
    ext
      .replace(/^\./, "")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase() || "mp4";
  return `uploads/${yyyy}/${mm}/${dd}/${sessionId}.${safeExt}`;
}

function projectRow(row: typeof videos.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    videoSource: row.videoSource,
    localVideoUrl: row.localVideoUrl,
    duration: row.duration,
    category: row.category,
    preacher: row.preacher,
    featured: row.featured,
    transcodingStatus: row.transcodingStatus,
  };
}

function getMissingChunks(received: number[], total: number): number[] {
  const set = new Set(received);
  return Array.from({ length: total }, (_, i) => i).filter((i) => !set.has(i));
}

// ─── DB-fallback finalization ──────────────────────────────────────────────────

async function finalizeFromDbFallback(
  session: typeof sessions.$inferSelect,
  totalChunks: number,
  log: FastifyInstance["log"],
): Promise<{ localVideoUrl: string | null; objectKey: string; storageBackend: "db" | "db_fallback" }> {
  const now = new Date();
  // Detect the correct extension from the original filename first, then MIME type.
  // Without this, non-MP4 uploads (WebM, MOV, MKV…) get a ".bin" extension which
  // prevents the media player from identifying the codec on playback.
  const safeExt = (() => {
    const fnExt = session.originalFilename
      ? (session.originalFilename.split(".").pop() ?? "").toLowerCase()
      : "";
    if (/^(mp4|mov|mkv|avi|webm|m4v|flv|wmv|ts|mts|m2ts)$/.test(fnExt)) return fnExt;
    const mime = (session.mimeType ?? session.contentType ?? "").toLowerCase();
    if (mime.includes("webm")) return "webm";
    if (mime.includes("quicktime") || mime.includes("mov")) return "mov";
    if (mime.includes("x-matroska") || mime.includes("mkv")) return "mkv";
    if (mime.includes("x-msvideo") || mime.includes("avi")) return "avi";
    return "mp4"; // safe fallback for all MPEG-4 and unknown types
  })();
  const objectKey =
    session.objectKey ??
    `uploads/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${String(now.getUTCDate()).padStart(2, "0")}/${session.sessionId}.${safeExt}`;

  try {
    const { uploadId } = await storage().createMultipartUpload({
      key: objectKey,
      contentType: session.contentType,
    });

    // Assemble BYTEA chunks into multipart parts ONE AT A TIME.
    //
    // CRITICAL: Do NOT use a pre-loaded allChunks array with fallbackData here.
    // Loading all chunk BYTEA at once (e.g. 30 × 8 MiB = 240 MiB) into Node.js
    // memory in a single SELECT * causes OOM on Replit's constrained heap for
    // any file larger than ~50 MB. Instead, each chunk's fallbackData is fetched
    // individually, uploaded as a part, and then eligible for GC before the next
    // chunk is fetched. Peak Node.js memory overhead is ~one chunk size (8 MiB).
    const parts: Array<{ partNumber: number; etag: string }> = [];

    for (let i = 0; i < totalChunks; i++) {
      // Fetch only this chunk's BYTEA — prior chunks are GC-eligible after this point.
      const chunkRow = await db
        .select({ fallbackData: chunks.fallbackData })
        .from(chunks)
        .where(and(eq(chunks.sessionId, session.sessionId), eq(chunks.chunkIndex, i)))
        .limit(1)
        .then((r) => r[0]);

      const buf = chunkRow?.fallbackData
        ? (chunkRow.fallbackData as unknown as Buffer)
        : Buffer.alloc(0);

      if (buf.length === 0) {
        log.warn(
          { sessionId: session.sessionId, chunkIndex: i },
          "[finalize-fallback] chunk has empty fallbackData — skipping",
        );
        continue;
      }

      const { etag } = await storage().uploadPart({
        key: objectKey,
        uploadId,
        partNumber: i + 1,
        body: buf,
      });
      parts.push({ partNumber: i + 1, etag });
    }

    if (parts.length === 0) {
      throw new Error("No parts could be assembled from DB chunks");
    }

    await storage().completeMultipartUpload({ key: objectKey, uploadId, parts });
    const localVideoUrl = storage().publicUrl(objectKey);

    log.info(
      { sessionId: session.sessionId, objectKey, parts: parts.length },
      "[finalize-fallback] successfully assembled DB chunks into database storage",
    );
    return { localVideoUrl, objectKey, storageBackend: "db" };
  } catch (err) {
    log.error(
      { err, sessionId: session.sessionId },
      "[finalize-fallback] database storage assembly failed — chunks remain in upload_chunks",
    );
    throw new ServiceUnavailableError(
      "Storage assembly failed. Your video chunks are safely stored in the database. " +
        "Please retry finalizing this session.",
    );
  }
}

// ─── Route plugin ─────────────────────────────────────────────────────────────

export async function chunkedUploadRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── Startup recovery: reset stuck "assembling" sessions ───────────────────
  // If the server is restarted while an assembly is in progress, the session
  // row is left in status="assembling" permanently. The client's finalize-status
  // poll would block forever. On every cold boot, reset those rows back to
  // status="uploading" so the client's retry logic can re-attempt finalize.
  app.addHook("onReady", async () => {
    try {
      // Select completedVideoId too — the async-finalize path pre-commits a video
      // row and stores its id in completedVideoId BEFORE starting background assembly.
      // If the server restarted mid-assembly those rows are orphaned (blob partial).
      const stuckRows = await db
        .select({ sessionId: sessions.sessionId, completedVideoId: sessions.completedVideoId })
        .from(sessions)
        .where(inArray(sessions.status, ["assembling"]));
      if (stuckRows.length > 0) {
        const orphanedVideoIds = stuckRows
          .filter((r) => r.completedVideoId)
          .map((r) => r.completedVideoId as string);

        if (orphanedVideoIds.length > 0) {
          // Remove broadcast_queue slots (were added optimistically at pre-commit time)
          await db
            .delete(schema.broadcastQueueTable)
            .where(inArray(schema.broadcastQueueTable.videoId, orphanedVideoIds))
            .catch(() => {});
          // Remove the orphaned video rows so retry creates a clean new row
          await db
            .delete(videos)
            .where(inArray(videos.id, orphanedVideoIds))
            .catch(() => {});
        }

        // Reset session state: clear completedVideoId so the idempotency check
        // doesn't incorrectly fast-path on the next /finalize call.
        await db
          .update(sessions)
          .set({ status: "uploading", completedVideoId: null, updatedAt: new Date() })
          .where(inArray(sessions.status, ["assembling"]));

        app.log.warn(
          { count: stuckRows.length, orphanedVideoIds, ids: stuckRows.map((r) => r.sessionId) },
          "[upload] reset stuck assembling sessions — orphaned pre-commit rows cleaned up",
        );
      }
    } catch (err) {
      app.log.warn({ err }, "[upload] startup assembling-session recovery failed (non-fatal)");
    }

    // ── Stale session cleanup ─────────────────────────────────────────────
    // Sessions still in "uploading" status after 48 hours were abandoned
    // (browser closed, permanent network failure, user gave up). Their chunk
    // rows — especially db_fallback BYTEA blobs — can hold significant data.
    // Run once at startup and then every 6 hours so the upload_chunks table
    // stays lean without manual DB maintenance.
    const ABANDONED_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours
    const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

    const runSessionCleanup = async () => {
      try {
        const cutoff = new Date(Date.now() - ABANDONED_AGE_MS);
        const abandoned = await db
          .select({ sessionId: sessions.sessionId, uploadId: sessions.uploadId })
          .from(sessions)
          .where(and(eq(sessions.status, "uploading"), lt(sessions.updatedAt, cutoff)));

        if (abandoned.length > 0) {
          const ids = abandoned.map((r) => r.sessionId);
          // Delete chunks first (FK dependency), then the session rows.
          await db.delete(chunks).where(inArray(chunks.sessionId, ids));

          // Also clean up orphaned _parts/{uploadId}/... rows in storage_blobs.
          // These are created during the db-mode upload path and are normally
          // cleaned up by completeMultipartUpload, but abandoned sessions leave
          // them orphaned, causing unbounded storage growth.
          const uploadIds = abandoned
            .map((r) => r.uploadId)
            .filter((id): id is string => id != null);
          for (const uploadId of uploadIds) {
            const partPrefix = `_parts/${uploadId}/`;
            await db
              .execute(sql`DELETE FROM storage_blobs WHERE starts_with(key, ${partPrefix})`)
              .catch((err: unknown) =>
                app.log.warn({ err, uploadId }, "[upload] _parts cleanup failed (non-fatal)"),
              );
          }

          await db.delete(sessions).where(inArray(sessions.sessionId, ids));
          app.log.info(
            { count: abandoned.length, ids, uploadIdsCleared: uploadIds.length },
            "[upload] cleaned up abandoned upload sessions, chunks, and orphaned storage parts",
          );
        }
      } catch (err) {
        app.log.warn({ err }, "[upload] abandoned session cleanup failed (non-fatal)");
      }
    };

    // Run immediately on boot (catches sessions from a previous server process
    // that died without processing them), then on the repeating interval.
    void runSessionCleanup();
    const cleanupTimer = setInterval(() => { void runSessionCleanup(); }, CLEANUP_INTERVAL_MS);
    // Ensure the timer does not prevent the Node.js event loop from exiting
    // when the server shuts down gracefully.
    cleanupTimer.unref();
  });

  // ── POST /videos/upload/init ───────────────────────────────────────────────
  r.post(
    "/videos/upload/init",
    {
      preHandler: requireAuth("editor"),
      // Tighter limit than the global 120/min — init creates a DB session row
      // and reserves an upload slot, so a burst is more expensive than a
      // typical read. 30/min is enough for any realistic bulk-upload workflow
      // (3 concurrent uploads × 10 retries per minute) without leaving room
      // for a runaway loop to churn DB rows. (P2 fix)
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["uploads"],
        summary: "Initialize a resumable chunked upload session (server-relay path)",
        body: InitBodySchema,
        response: {
          200: z.object({
            ok: z.literal(true),
            sessionId: z.string(),
            storageBackend: z.enum(["db", "db_fallback"]),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const body = req.body;

      // Idempotency: return existing session if it's still in-flight
      const existing = await db
        .select()
        .from(sessions)
        .where(eq(sessions.sessionId, body.sessionId))
        .limit(1)
        .then((r) => r[0]);

      if (existing) {
        if (existing.status === "completed") {
          throw Object.assign(
            new Error(`Session ${body.sessionId} is already completed`),
            { statusCode: 409 },
          );
        }
        return {
          ok: true as const,
          sessionId: existing.sessionId,
          storageBackend: existing.storageBackend as "db" | "db_fallback",
        };
      }

      const ext = (body.ext ?? "mp4").replace(/^\./, "");
      const objectKey = buildObjectKey(ext, body.sessionId);
      const contentType = body.mimeType || "video/mp4";
      const chunkSize =
        body.totalBytes > 0 && body.totalChunks > 0
          ? Math.ceil(body.totalBytes / body.totalChunks)
          : 8 * 1024 * 1024;

      let uploadId: string | null = null;
      let storageBackend: "db" | "db_fallback" = "db_fallback";

      // DatabaseObjectStorage is always available — create the multipart
      // upload slot immediately. The "db_fallback" path handles the rare case
      // where createMultipartUpload fails (e.g. a transient DB error); chunks
      // are then stored as raw BYTEA in upload_chunks and assembled at finalize.
      // Wrap in a 5-second timeout so a slow DB never makes /init block long
      // enough for the proxy to return 502 before the client even starts chunking.
      try {
        const mpPromise = storage().createMultipartUpload({ key: objectKey, contentType });
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("createMultipartUpload timed out after 5 s")), 5_000),
        );
        const mp = await Promise.race([mpPromise, timeoutPromise]);
        uploadId = mp.uploadId;
        storageBackend = "db";
      } catch (err) {
        req.log.warn(
          { err, sessionId: body.sessionId },
          "[chunked-init] storage multipart init failed — session will use DB fallback storage",
        );
      }

      await db.insert(sessions).values({
        sessionId: body.sessionId,
        uploadId,
        objectKey: storageBackend !== "db_fallback" ? objectKey : null,
        title: body.title,
        description: body.description ?? "",
        category: body.category ?? "sermon",
        preacher: body.preacher ?? "",
        featured: body.featured ?? false,
        contentType,
        sizeBytes: Number(body.totalBytes),
        totalChunks: Number(body.totalChunks),
        chunkSize,
        originalFilename: body.originalFilename ?? null,
        mimeType: body.mimeType ?? null,
        durationSecs:
          body.durationSecs !== undefined ? Math.round(Number(body.durationSecs)) : null,
        uploadedBy: req.principal?.id ?? null,
        storageBackend,
        status: "uploading",
      });

      req.log.info(
        {
          sessionId: body.sessionId,
          storageBackend,
          totalChunks: body.totalChunks,
          totalBytes: body.totalBytes,
        },
        "[chunked-init] session created",
      );

      return { ok: true as const, sessionId: body.sessionId, storageBackend };
    },
  );

  // ── POST /videos/upload/:sessionId/chunk ───────────────────────────────────
  // Receives raw binary body (application/octet-stream).
  // Chunk metadata is in headers:
  //   X-Chunk-Index:    <number>  (0-based)
  //   X-Chunk-Checksum: <sha256-hex>
  app.post(
    "/videos/upload/:sessionId/chunk",
    {
      preHandler: requireAuth("editor") as any,
      // Per-route bodyLimit: 12 MiB — covers the 8 MiB maximum adaptive
      // chunk size plus HTTP framing headroom. The previous 110 MiB limit
      // was unnecessarily large (the adaptive max is capped at 8 MiB client-side).
      bodyLimit: 12 * 1024 * 1024,
      // Chunk uploads: adaptive chunk size is 1–8 MiB, max concurrency=4.
      // 600/min per IP covers 3 concurrent uploads × 4 parallel chunks
      // at the maximum speed, with headroom for retries.
      config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Disable proxy buffering so Nginx/Replit proxy streams bytes through
      // immediately rather than buffering the entire chunk before passing it on.
      reply.raw.setHeader("X-Accel-Buffering", "no");

      const { sessionId } = req.params as { sessionId: string };
      const chunkIndex = parseInt((req.headers["x-chunk-index"] as string) ?? "", 10);
      const checksum = (req.headers["x-chunk-checksum"] as string | undefined) ?? "";

      if (isNaN(chunkIndex) || chunkIndex < 0) {
        return reply.code(400).send({ error: "Missing or invalid X-Chunk-Index header" });
      }
      if (!checksum) {
        return reply.code(400).send({ error: "Missing X-Chunk-Checksum header" });
      }

      const session = await db
        .select()
        .from(sessions)
        .where(eq(sessions.sessionId, sessionId))
        .limit(1)
        .then((r) => r[0]);

      if (!session) {
        return reply.code(404).send({ error: `Upload session not found: ${sessionId}` });
      }
      if (session.status === "completed") {
        return reply.code(409).send({ error: "Session already completed" });
      }

      // Reject out-of-range chunk indices to prevent phantom chunk accumulation.
      if (chunkIndex >= session.totalChunks) {
        return reply.code(400).send({
          error: `Chunk index ${chunkIndex} is out of range — session expects ${session.totalChunks} total chunks (indices 0–${session.totalChunks - 1})`,
        });
      }

      // Idempotency: chunk already received
      const existingChunk = await db
        .select({ id: chunks.id, storageBackend: chunks.storageBackend })
        .from(chunks)
        .where(and(eq(chunks.sessionId, sessionId), eq(chunks.chunkIndex, chunkIndex)))
        .limit(1)
        .then((r) => r[0]);

      if (existingChunk) {
        return reply.code(409).send({ ok: true, chunkIndex, storageBackend: existingChunk.storageBackend });
      }

      const body = req.body as Buffer;
      if (!body || body.length === 0) {
        return reply.code(400).send({ error: "Empty chunk body" });
      }

      // Verify SHA-256 integrity
      const actualChecksum = createHash("sha256").update(body).digest("hex");
      if (actualChecksum !== checksum) {
        return reply.code(422).send({
          error:
            `Chunk ${chunkIndex} checksum mismatch — expected ${checksum}, ` +
            `got ${actualChecksum}. The chunk was corrupted in transit; re-send it.`,
        });
      }

      const chunkId = randomUUID();

      if (session.storageBackend !== "db_fallback" && session.uploadId && session.objectKey) {
        // Upload directly to object storage as a multipart part (1-based partNumber)
        const partNumber = chunkIndex + 1;
        try {
          const { etag } = await storage().uploadPart({
            key: session.objectKey,
            uploadId: session.uploadId,
            partNumber,
            body,
          });

          await db.insert(chunks).values({
            id: chunkId,
            sessionId,
            chunkIndex,
            checksum,
            sizeBytes: body.length,
            s3Etag: etag,
            storageBackend: "db",
          });

          return reply.send({ ok: true, chunkIndex, storageBackend: "db" });
        } catch (err) {
          req.log.warn(
            { err, sessionId, chunkIndex, partNumber },
            "[chunk] uploadPart failed — chunk NOT saved; client will retry",
          );
          // Do NOT fall through to DB fallback: the session was opened in object storage
          // mode and all previous chunks went there. Switching mid-session to db_fallback
          // would produce an irrecoverable mixed state at finalize time. Instead return
          // 503 so the client's retry logic backs off and re-attempts.
          return reply.code(503).send({
            error:
              "Object storage is temporarily unavailable. The chunk was not saved. " +
              "It will be retried automatically with exponential backoff.",
          });
        }
      }

      // DB fallback mode: store raw bytes as BYTEA
      await db.insert(chunks).values({
        id: chunkId,
        sessionId,
        chunkIndex,
        checksum,
        sizeBytes: body.length,
        fallbackData: body,
        storageBackend: "db_fallback",
      });

      return reply.send({ ok: true, chunkIndex, storageBackend: "db_fallback" });
    },
  );

  // ── GET /videos/upload/:sessionId/status ───────────────────────────────────
  r.get(
    "/videos/upload/:sessionId/status",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["uploads"],
        summary: "Return received chunk indices so the client can skip them on resume",
        params: z.object({ sessionId: z.string().min(1).max(128) }),
        response: {
          200: z.object({
            sessionId: z.string(),
            status: z.string(),
            storageBackend: z.string(),
            totalChunks: z.number(),
            uploadedChunkIndices: z.array(z.number()),
          }),
          404: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { sessionId } = req.params;

      const session = await db
        .select()
        .from(sessions)
        .where(eq(sessions.sessionId, sessionId))
        .limit(1)
        .then((r) => r[0]);

      if (!session) {
        return reply.code(404).send({ error: `Upload session not found: ${sessionId}` });
      }

      const uploadedChunks = await db
        .select({ chunkIndex: chunks.chunkIndex })
        .from(chunks)
        .where(eq(chunks.sessionId, sessionId))
        .orderBy(asc(chunks.chunkIndex));

      return {
        sessionId,
        status: session.status,
        storageBackend: session.storageBackend,
        totalChunks: session.totalChunks,
        uploadedChunkIndices: uploadedChunks.map((c) => c.chunkIndex),
      };
    },
  );

  // ── POST /videos/upload/:sessionId/thumbnail ───────────────────────────────
  // Accepts multipart/form-data OR raw image bytes.
  // Body is already available as a Buffer (registered in app.ts).
  // Stores the thumbnail to S3 keyed under `thumbnails/<sessionId>.*`.
  app.post(
    "/videos/upload/:sessionId/thumbnail",
    {
      preHandler: requireAuth("editor") as any,
      bodyLimit: 20 * 1024 * 1024,
      // One thumbnail per upload session; 10/min covers retries and
      // multi-file batches.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { sessionId } = req.params as { sessionId: string };

      const session = await db
        .select({ sessionId: sessions.sessionId })
        .from(sessions)
        .where(eq(sessions.sessionId, sessionId))
        .limit(1)
        .then((r) => r[0]);

      if (!session) {
        return reply.code(404).send({ error: `Upload session not found: ${sessionId}` });
      }

      // Store thumbnail bytes directly to storage_blobs (DatabaseObjectStorage).
      // For multipart/form-data we receive the raw boundary payload as a Buffer
      // and skip storage (thumbnail is auto-generated by the transcoder instead).
      const body = req.body as Buffer | undefined;
      const ct = (req.headers["content-type"] ?? "").toLowerCase();
      if (
        storage().enabled &&
        body instanceof Buffer &&
        body.length > 0 &&
        (ct.includes("image/jpeg") || ct.includes("image/png") || ct.includes("image/webp"))
      ) {
        // Always normalize to 640×360 JPEG with black letterbox/pillarbox padding
        // so stored thumbnails are always the correct 16:9 shape regardless of
        // the source image's original aspect ratio.
        const normalizedBody = await normalizeThumbnailBuffer(body).catch(() => null);
        const finalBody = normalizedBody ?? body;
        const thumbKey = `thumbnails/${sessionId}.jpg`;
        try {
          await storage().putObject({ key: thumbKey, body: finalBody, contentType: "image/jpeg" });
        } catch (err) {
          req.log.warn({ err, sessionId }, "[thumbnail] database put failed — thumbnail skipped");
        }
      }

      return reply.send({ ok: true });
    },
  );

  // ── POST /videos/upload/:sessionId/finalize ───────────────────────────────
  r.post(
    "/videos/upload/:sessionId/finalize",
    {
      preHandler: requireAuth("editor"),
      // Finalize triggers DB assembly + transcoding job insertion. Same
      // limit as /init (30/min) since both create durable server-side work.
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["uploads"],
        summary: "Complete the upload, insert the video row, and queue HLS transcoding",
        params: z.object({ sessionId: z.string().min(1).max(128) }),
        response: {
          200: z.object({
            id: z.string(),
            title: z.string(),
            description: z.string().nullable(),
            videoSource: z.string(),
            localVideoUrl: z.string().nullable(),
            duration: z.string().nullable(),
            category: z.string().nullable(),
            preacher: z.string().nullable(),
            featured: z.boolean(),
            transcodingStatus: z.string().nullable(),
            storageBackend: z.string(),
            transcodingWarning: z.string().nullable().optional(),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { sessionId } = req.params;

      let session = await db
        .select()
        .from(sessions)
        .where(eq(sessions.sessionId, sessionId))
        .limit(1)
        .then((r) => r[0]);

      if (!session) {
        throw Object.assign(
          new Error(`Upload session not found: ${sessionId}`),
          { statusCode: 404 },
        );
      }

      // Belt-and-suspenders: If the session has a completedVideoId but status is
      // neither "assembling" nor "completed", the server restarted during background
      // assembly and the onReady cleanup either failed or hasn't run yet. Delete the
      // orphaned rows here so this finalize attempt produces a clean result.
      if (
        session.completedVideoId &&
        session.status !== "assembling" &&
        session.status !== "completed"
      ) {
        req.log.warn(
          { sessionId, completedVideoId: session.completedVideoId, status: session.status },
          "[finalize] belt-and-suspenders: cleaning up orphaned pre-commit rows (server-restart recovery)",
        );
        await Promise.allSettled([
          db
            .delete(schema.broadcastQueueTable)
            .where(eq(schema.broadcastQueueTable.videoId, session.completedVideoId)),
          db.delete(videos).where(eq(videos.id, session.completedVideoId)),
          db
            .update(sessions)
            .set({ completedVideoId: null })
            .where(eq(sessions.sessionId, sessionId)),
        ]);
      }

      // Stale-lock recovery: If status is "assembling" but completedVideoId is null,
      // a prior finalize attempt locked the session but crashed before pre-committing
      // the video row (e.g. DB error thrown from db.insert(videos)).
      // Without this reset the session is permanently stuck — subsequent finalize
      // calls see lockResult.length === 0, re-read status="assembling" + null id,
      // and throw 409 forever. Reset to "uploading" so this attempt can proceed.
      if (session.status === "assembling" && !session.completedVideoId) {
        req.log.warn(
          { sessionId },
          "[finalize] stale-lock recovery: status=assembling but no completedVideoId — resetting to uploading",
        );
        await db
          .update(sessions)
          .set({ status: "uploading", updatedAt: new Date() })
          .where(eq(sessions.sessionId, sessionId))
          .catch(() => {});
        // Re-read to get fresh state for the lock acquisition below.
        session = (await db
          .select()
          .from(sessions)
          .where(eq(sessions.sessionId, sessionId))
          .limit(1)
          .then((r) => r[0])) ?? session;
      }

      // Idempotency: already completed OR pre-committed (background assembly running).
      // The new async-finalize path sets status="assembling" + completedVideoId before
      // responding, so both states should return the already-created video row.
      if ((session.status === "completed" || session.status === "assembling") && session.completedVideoId) {
        const existingRow = await db
          .select()
          .from(videos)
          .where(eq(videos.id, session.completedVideoId))
          .limit(1)
          .then((r) => r[0]);
        if (existingRow) {
          return {
            ...projectRow(existingRow),
            storageBackend: session.storageBackend,
            transcodingWarning: null,
          };
        }
      }

      // Atomic assembly lock — flip status from 'uploading' → 'assembling' in a
      // single UPDATE…RETURNING so that two concurrent /finalize calls cannot both
      // proceed to assembly. Without this atomic step there is a TOCTOU window where
      // both requests read status='uploading', both pass the guard, and both run
      // completeMultipartUpload + INSERT INTO managed_videos — producing duplicate
      // video rows and wasting storage.
      //
      // If zero rows come back the session was already claimed (status='assembling')
      // or completed by the concurrent request; we re-read the live state and either
      // return the idempotent result or tell the client to poll finalize-status.
      const lockResult = await db
        .update(sessions)
        .set({ status: "assembling", updatedAt: new Date() })
        .where(and(eq(sessions.sessionId, sessionId), eq(sessions.status, "uploading")))
        .returning({ sessionId: sessions.sessionId });

      if (lockResult.length === 0) {
        // Failed to acquire lock — re-read the actual current state.
        const refreshed = await db
          .select({
            status: sessions.status,
            completedVideoId: sessions.completedVideoId,
            storageBackend: sessions.storageBackend,
          })
          .from(sessions)
          .where(eq(sessions.sessionId, sessionId))
          .limit(1)
          .then((r) => r[0]);

        // If already completed OR pre-committed (background assembly in flight),
        // return the video row immediately — no need for the client to poll.
        if (
          (refreshed?.status === "completed" || refreshed?.status === "assembling") &&
          refreshed.completedVideoId
        ) {
          const existingRow = await db
            .select()
            .from(videos)
            .where(eq(videos.id, refreshed.completedVideoId))
            .limit(1)
            .then((r) => r[0]);
          if (existingRow) {
            return {
              ...projectRow(existingRow),
              storageBackend: refreshed.storageBackend,
              transcodingWarning: null,
            };
          }
        }

        // Stale lock race: status="assembling" but no completedVideoId means a prior
        // finalize crashed before pre-committing the video row. The stale-lock recovery
        // block above (run on the initial session read) would have reset this to
        // "uploading" already. If we still end up here with null completedVideoId,
        // surface a 503 (not 409) so the client knows it can retry immediately.
        if (refreshed?.status === "assembling" && !refreshed.completedVideoId) {
          await db
            .update(sessions)
            .set({ status: "uploading", updatedAt: new Date() })
            .where(eq(sessions.sessionId, sessionId))
            .catch(() => {});
          throw Object.assign(
            new Error(
              "A prior finalize attempt left a stale lock. The lock has been cleared — " +
              "please retry finalization now.",
            ),
            { statusCode: 503 },
          );
        }

        // Truly still assembling via the old sync path — tell the client to poll.
        throw Object.assign(
          new Error(
            "Assembly already in progress for this session. " +
            "Poll GET /upload/:sessionId/finalize-status to check completion.",
          ),
          { statusCode: 409 },
        );
      }

      // We hold the assembly lock. Load chunks now; if validation fails we must
      // reset the session back to 'uploading' so the client can retry after
      // re-sending the missing chunks (or just retry finalize if chunks are intact).
      const resetLock = async () => {
        await db
          .update(sessions)
          .set({ status: "uploading", updatedAt: new Date() })
          .where(eq(sessions.sessionId, sessionId))
          .catch(() => {});
      };

      // Load all received chunks, ordered by index.
      // Deliberately exclude the fallbackData (BYTEA) column — for db-mode sessions
      // it is always null (no overhead), but for db_fallback sessions loading all
      // chunk BYTEA at once (e.g. 30 × 8 MiB = 240 MiB for a 240 MB file) into
      // Node.js memory causes OOM on Replit's constrained heap. fallbackData is
      // loaded lazily one chunk at a time inside finalizeFromDbFallback.
      const allChunks = await db
        .select({
          id: chunks.id,
          sessionId: chunks.sessionId,
          chunkIndex: chunks.chunkIndex,
          checksum: chunks.checksum,
          sizeBytes: chunks.sizeBytes,
          s3Etag: chunks.s3Etag,
          storageBackend: chunks.storageBackend,
          receivedAt: chunks.receivedAt,
        })
        .from(chunks)
        .where(eq(chunks.sessionId, sessionId))
        .orderBy(asc(chunks.chunkIndex));

      if (allChunks.length === 0) {
        await resetLock();
        throw Object.assign(
          new Error("No chunks received for this session"),
          { statusCode: 422 },
        );
      }

      if (allChunks.length !== session.totalChunks) {
        const missing = getMissingChunks(
          allChunks.map((c) => c.chunkIndex),
          session.totalChunks,
        );
        await resetLock();
        throw Object.assign(
          new Error(
            `Incomplete upload: received ${allChunks.length} of ${session.totalChunks} chunks. ` +
              `Missing chunk indices: ${missing.slice(0, 20).join(", ")}` +
              (missing.length > 20 ? ` … and ${missing.length - 20} more` : ""),
          ),
          { statusCode: 422 },
        );
      }

      // ── Path A: "db" backend — pre-commit video row and respond immediately ──
      //
      // For db sessions the object key is fixed at init time, so the storage URL
      // is fully deterministic before assembly runs. We insert the video row,
      // return the HTTP 200 immediately (eliminating the 99% hang for all file
      // sizes), and run completeMultipartUpload in a background async task.
      //
      // The assembly is the O(n²) iterative bytea-concat loop which can take
      // several minutes for large files (1 GB+ = 128+ chunks ≈ 65 GB total DB
      // I/O). Running it synchronously in the request thread blocks the HTTP
      // response for that entire duration, causing the 99%-forever stall.
      //
      // Failure recovery: if background assembly throws, the video row is marked
      // transcodingStatus='failed' and the session is reset to 'uploading' so
      // the operator can retry from the upload queue panel.
      if (session.storageBackend !== "db_fallback" && session.uploadId && session.objectKey) {
        // Validate etags now (synchronous check; must happen before we commit
        // the video row since a corrupt assembly would leave an unplayable blob).
        const missingEtags = allChunks.filter((c) => !c.s3Etag);
        if (missingEtags.length > 0) {
          await resetLock();
          throw Object.assign(
            new Error(
              `${missingEtags.length} chunk(s) are missing storage etags — ` +
                `re-upload the session to recover: indices ${missingEtags.slice(0, 10).map((c) => c.chunkIndex).join(", ")}`,
            ),
            { statusCode: 422 },
          );
        }

        const videoId = randomUUID();
        const objectKey = session.objectKey;
        const uploadId = session.uploadId;
        const localVideoUrl = storage().publicUrl(objectKey);
        const durationSecs =
          session.durationSecs && session.durationSecs > 0
            ? Math.round(session.durationSecs)
            : 1800;

        req.log.info(
          { sessionId, objectKey, chunks: allChunks.length, sizeBytes: session.sizeBytes },
          "[finalize] pre-commit started",
        );

        // Pre-insert the video row with the deterministic storage URL.
        // Wrapped in try/catch: if this INSERT throws (e.g. DB connection hiccup or
        // unique-key conflict), we must release the assembly lock so subsequent
        // finalize retries can proceed instead of hitting a permanent 409.
        let inserted: (typeof videos.$inferSelect)[];
        try {
          inserted = await db
            .insert(videos)
            .values({
              id: videoId,
              youtubeId: null,
              title: session.title,
              description: session.description ?? "",
              thumbnailUrl: "",
              duration: String(durationSecs),
              category: session.category ?? "sermon",
              preacher: session.preacher ?? "",
              publishedAt: null,
              videoSource: "local",
              localVideoUrl,
              featured: session.featured,
              originalFilename: session.originalFilename ?? null,
              mimeType: session.mimeType ?? null,
              sizeBytes: session.sizeBytes,
              objectPath: objectKey,
              uploadedBy: session.uploadedBy ?? null,
              s3MirroredAt: null, // set after background assembly confirms blob exists
              broadcastOnly: true, // hidden from public library until admin publishes
              transcodingStatus: "queued", // background assembly + faststart in progress
            })
            .returning();
        } catch (insertErr) {
          await resetLock();
          req.log.error({ err: insertErr, sessionId, videoId }, "[finalize] video INSERT failed — lock released");
          throw Object.assign(
            new Error(
              "Failed to create video record. The upload is safe — please retry finalization.",
            ),
            { statusCode: 500, cause: insertErr },
          );
        }

        const row = inserted[0];
        if (!row) {
          await resetLock();
          throw new Error("videos insert returned no rows");
        }

        // Store the pre-committed videoId on the session so that:
        //   • Idempotent /finalize retries return the video row immediately.
        //   • GET /finalize-status returns the videoId while assembling.
        // Session status stays "assembling" until background assembly completes.
        // Wrapped in try/catch: if this update fails the video row already exists,
        // so the background assembly can still mark it completed. We log the failure
        // and continue — the response still returns the video row so the client
        // doesn't see a 500.
        try {
          await db
            .update(sessions)
            .set({ completedVideoId: videoId, updatedAt: new Date() })
            .where(eq(sessions.sessionId, sessionId));
        } catch (updateErr) {
          req.log.warn(
            { err: updateErr, sessionId, videoId },
            "[finalize] completedVideoId update failed (non-fatal) — background task will set it on assembly completion",
          );
        }

        // NOTE: The video is NOT added to the broadcast queue here.
        // faststart.service.ts auto-adds it AFTER relocating the moov atom
        // (faststartApplied=true), ensuring the player always receives a
        // seekable MP4 rather than a raw upload with moov at EOF.

        // Notify connected clients that the library has a new entry.
        void invalidateVideosCatalogCache();
        try { broadcastEngine.pushSnapshot(); } catch { /* non-fatal */ }
        adminEventBus.push("videos-library-updated", { videoId: row.id, reason: "upload-precommitted" });

        req.log.info(
          { sessionId, videoId: row.id, chunks: allChunks.length },
          "[finalize] pre-committed ok — background assembly starting",
        );

        // ── Background assembly + all post-processing ───────────────────────
        // Capture references before the handler returns (req may be GC'd).
        const capturedLog = req.log;
        const partsForAssembly = allChunks.map((c) => ({
          partNumber: c.chunkIndex + 1,
          etag: c.s3Etag as string,
        }));
        const assemblyStartMs = Date.now();

        void (async () => {
          try {
            capturedLog.info(
              { sessionId, videoId, parts: partsForAssembly.length },
              "[finalize:bg] completeMultipartUpload started",
            );

            await storage().completeMultipartUpload({
              key: objectKey,
              uploadId,
              parts: partsForAssembly,
            });

            const assemblyMs = Date.now() - assemblyStartMs;
            capturedLog.info(
              { sessionId, videoId, assemblyMs, parts: partsForAssembly.length },
              "[finalize:bg] completeMultipartUpload done",
            );

            // Mark session completed and confirm the blob is fully assembled.
            await Promise.all([
              db
                .update(sessions)
                .set({ status: "completed", storageBackend: "db", updatedAt: new Date() })
                .where(eq(sessions.sessionId, sessionId))
                .catch((err: unknown) =>
                  capturedLog.warn({ err, sessionId }, "[finalize:bg] session completed update failed (non-fatal)"),
                ),
              db
                .update(videos)
                .set({ s3MirroredAt: new Date() })
                .where(eq(videos.id, videoId))
                .catch(() => {}),
            ]);

            // Reclaim chunk metadata rows (db-mode rows hold no BYTEA data).
            void db
              .delete(chunks)
              .where(eq(chunks.sessionId, sessionId))
              .catch((err: unknown) =>
                capturedLog.warn({ err, sessionId }, "[finalize:bg] chunk cleanup failed (non-fatal)"),
              );

            // Post-upload probes: thumbnail extraction + duration probe.
            // Must run BEFORE faststart because faststart replaces the blob.
            const clientDuration = Number(row.duration ?? "0");
            try {
              const [thumbUrl, probedSecs] = await Promise.all([
                generateQuickThumbnail(objectKey, videoId),
                clientDuration > 0 ? Promise.resolve(null) : probeUploadedDuration(objectKey),
              ]);
              const patch: Partial<typeof videos.$inferInsert> = {};
              if (thumbUrl) patch.thumbnailUrl = thumbUrl;
              if (probedSecs != null) patch.duration = String(Math.round(probedSecs));
              if (Object.keys(patch).length > 0) {
                await db.update(videos).set(patch).where(eq(videos.id, videoId));
                void invalidateVideosCatalogCache();
                adminEventBus.push("videos-library-updated", { videoId, reason: "thumbnail-generated" });
              }
              if (probedSecs != null && probedSecs > 10) {
                const roundedSecs = Math.round(probedSecs);
                await db
                  .update(schema.broadcastQueueTable)
                  .set({ durationSecs: roundedSecs })
                  .where(eq(schema.broadcastQueueTable.videoId, videoId))
                  .catch(() => {});
              }
            } catch (err) {
              capturedLog.warn({ err, videoId }, "[finalize:bg] post-upload probes failed (non-fatal)");
            }

            // CRITICAL ORDERING: faststart MUST complete before enqueueTranscode.
            //
            // faststart.service.ts replaces the source blob via
            // completeMultipartUpload (multipart re-upload built from 8 MiB
            // READ chunks of the original). If the transcoder dispatcher
            // downloads the source while that assembly is still in progress,
            // it fetches a partial/truncated file that passes the size check
            // (headObject returns the in-flight size) but causes ffprobe to
            // report "moov atom not found" — killing the transcode job.
            //
            // Running enqueueTranscode AFTER faststart here guarantees the
            // transcoder always downloads the complete, fully-assembled file.
            // If faststart fails the original blob is still intact; the
            // transcoder's own remuxForFaststart recovery handles moov-at-EOF.
            try {
              await runFaststart(videoId, objectKey, { skipStatusUpdate: false });
              capturedLog.info({ sessionId, videoId }, "[finalize:bg] faststart done");
            } catch (err) {
              capturedLog.warn({ err, videoId }, "[finalize:bg] faststart failed (non-fatal)");
            }

            // Enqueue HLS transcoding AFTER faststart is complete.
            try {
              await enqueueTranscode({ videoId, videoPath: objectKey });
              capturedLog.info({ sessionId, videoId }, "[finalize:bg] HLS transcode job queued");
            } catch (err) {
              capturedLog.warn(
                { err, videoId },
                "[finalize:bg] enqueueTranscode failed (non-fatal) — faststart-applied video is still broadcast-ready",
              );
            }

            capturedLog.info(
              { sessionId, videoId, totalMs: Date.now() - assemblyStartMs },
              "[finalize:bg] all post-processing complete",
            );
          } catch (err) {
            // Assembly failed — mark the video as failed and reset the session
            // to "uploading" so the operator can retry from the upload queue.
            capturedLog.error(
              { err, sessionId, videoId, assemblyMs: Date.now() - assemblyStartMs },
              "[finalize:bg] ASSEMBLY FAILED — resetting session, marking video failed",
            );
            // Best-effort orphan cleanup: if the seed INSERT succeeded but a
            // later append failed, a partially-assembled blob remains at the
            // final key. Delete it so the storage GC doesn't carry it for
            // 4 h and the next finalize retry starts from a clean slate.
            if (session.objectKey) {
              void storage().deleteObject(session.objectKey).catch(() => {});
            }
            await Promise.allSettled([
              db.update(videos).set({ transcodingStatus: "failed" }).where(eq(videos.id, videoId)),
              db
                .update(sessions)
                .set({ status: "uploading", completedVideoId: null, updatedAt: new Date() })
                .where(eq(sessions.sessionId, sessionId)),
            ]);
            adminEventBus.push("videos-library-updated", { videoId, reason: "assembly-failed" });
          }
        })();

        return {
          ...projectRow(row),
          storageBackend: "db" as const,
          transcodingWarning: null,
        };
      }

      // ── Path B: "db_fallback" backend — synchronous assembly (rare path) ───
      //
      // db_fallback is only active when the init's createMultipartUpload failed.
      // We keep this path synchronous to preserve the existing error semantics
      // (assembly errors propagate as HTTP errors the client can retry).
      let localVideoUrl: string | null = null;
      let finalObjectKey: string | null = session.objectKey;
      let finalStorageBackend = session.storageBackend;

      const ASSEMBLY_TIMEOUT_MS = 8 * 60 * 1000;
      let assemblyTimedOut = false;
      const assemblyTimer = setTimeout(async () => {
        assemblyTimedOut = true;
        req.log.error(
          { sessionId, totalChunks: allChunks.length },
          "[finalize] db_fallback assembly timeout — resetting session to uploading for retry",
        );
        await db
          .update(sessions)
          .set({ status: "uploading", updatedAt: new Date() })
          .where(eq(sessions.sessionId, sessionId))
          .catch(() => {});
      }, ASSEMBLY_TIMEOUT_MS);

      try {
        const result = await finalizeFromDbFallback(session, allChunks.length, req.log);
        localVideoUrl = result.localVideoUrl;
        finalObjectKey = result.objectKey;
        finalStorageBackend = result.storageBackend;
      } catch (assemblyErr) {
        clearTimeout(assemblyTimer);
        await resetLock();
        throw assemblyErr;
      }

      clearTimeout(assemblyTimer);

      if (assemblyTimedOut) {
        throw Object.assign(
          new Error(
            "File assembly exceeded the 8-minute deadline. " +
            "All chunks are safely stored — click Retry to resume finalization.",
          ),
          { statusCode: 408 },
        );
      }

      // Insert managed_videos row (db_fallback path)
      // Wrapped in try/catch so a DB error releases the assembly lock and lets
      // the client retry instead of being permanently stuck on 409.
      const videoId = randomUUID();
      let inserted2: (typeof videos.$inferSelect)[];
      try {
        inserted2 = await db
          .insert(videos)
          .values({
            id: videoId,
            youtubeId: null,
            title: session.title,
            description: session.description ?? "",
            thumbnailUrl: "",
            duration: session.durationSecs ? String(Math.round(session.durationSecs)) : "0",
            category: session.category ?? "sermon",
            preacher: session.preacher ?? "",
            publishedAt: null,
            videoSource: "local",
            localVideoUrl,
            featured: session.featured,
            originalFilename: session.originalFilename ?? null,
            mimeType: session.mimeType ?? null,
            sizeBytes: session.sizeBytes,
            objectPath: finalObjectKey ?? null,
            uploadedBy: session.uploadedBy ?? null,
            s3MirroredAt: finalStorageBackend === "db" ? new Date() : null,
            broadcastOnly: true, // hidden from public library until admin publishes
          })
          .returning();
      } catch (insertErr) {
        await resetLock();
        req.log.error({ err: insertErr, sessionId, videoId }, "[finalize:db_fallback] video INSERT failed — lock released");
        throw Object.assign(
          new Error("Failed to create video record. The upload is safe — please retry finalization."),
          { statusCode: 500, cause: insertErr },
        );
      }

      const row = inserted2[0];
      if (!row) {
        await resetLock();
        throw new Error("videos insert returned no rows");
      }

      await db
        .update(sessions)
        .set({
          status: "completed",
          completedVideoId: videoId,
          storageBackend: finalStorageBackend,
          updatedAt: new Date(),
        })
        .where(eq(sessions.sessionId, sessionId));

      void db
        .delete(chunks)
        .where(eq(chunks.sessionId, sessionId))
        .catch((err: unknown) => {
          req.log.warn({ err, sessionId }, "[finalize] chunk row cleanup failed (non-fatal)");
        });

      // NOTE: The video is NOT added to the broadcast queue here.
      // faststart.service.ts auto-adds it AFTER relocating the moov atom
      // (faststartApplied=true), ensuring the player always receives a
      // seekable MP4 rather than a raw upload with moov at EOF.

      void invalidateVideosCatalogCache();
      try { broadcastEngine.pushSnapshot(); } catch { /* non-fatal */ }
      adminEventBus.push("videos-library-updated", { videoId: row.id, reason: "upload-finalized" });
      adminEventBus.push("broadcast-queue-updated", { reason: "upload-finalized", videoId: row.id });

      let transcodingWarning: string | null = null;
      try {
        await enqueueTranscode({
          videoId: row.id,
          videoPath: finalObjectKey ?? session.objectKey ?? "",
        });
      } catch (err) {
        transcodingWarning =
          err instanceof Error
            ? err.message
            : "Transcoding job could not be queued — re-enqueue from the Operations tab.";
        req.log.warn({ err, videoId: row.id }, "[finalize] enqueueTranscode failed (non-fatal)");
      }

      if (finalObjectKey) {
        const _clientDuration = Number(row.duration ?? "0");
        void (async () => {
          try {
            const [thumbUrl, probedSecs] = await Promise.all([
              generateQuickThumbnail(finalObjectKey!, row.id),
              _clientDuration > 0 ? Promise.resolve(null) : probeUploadedDuration(finalObjectKey!),
            ]);
            const patch: Partial<typeof videos.$inferInsert> = {};
            if (thumbUrl) patch.thumbnailUrl = thumbUrl;
            if (probedSecs != null) patch.duration = String(Math.round(probedSecs));
            if (Object.keys(patch).length > 0) {
              await db.update(videos).set(patch).where(eq(videos.id, row.id));
              void invalidateVideosCatalogCache();
              adminEventBus.push("videos-library-updated", { videoId: row.id, reason: "thumbnail-generated" });
            }
            if (probedSecs != null && probedSecs > 10) {
              const roundedSecs = Math.round(probedSecs);
              await db
                .update(schema.broadcastQueueTable)
                .set({ durationSecs: roundedSecs })
                .where(eq(schema.broadcastQueueTable.videoId, row.id))
                .catch(() => {});
            }
          } catch (err) {
            req.log.warn({ err, videoId: row.id }, "[finalize] post-upload probes failed (non-fatal)");
          }
          try {
            await runFaststart(row.id, finalObjectKey!, { skipStatusUpdate: !env.TRANSCODER_DISABLE });
          } catch (err) {
            req.log.warn({ err, videoId: row.id }, "[finalize] faststart failed (non-fatal)");
            if (env.TRANSCODER_DISABLE) {
              adminEventBus.push("broadcast-queue-updated", { reason: "faststart-failed-fallback", videoId: row.id });
            }
          }
        })();
      }

      req.log.info(
        { sessionId, videoId: row.id, storageBackend: finalStorageBackend, totalChunks: allChunks.length },
        "[finalize] ok (db_fallback)",
      );

      return {
        ...projectRow(row),
        storageBackend: finalStorageBackend,
        transcodingWarning,
      };
    },
  );

  // ── GET /videos/upload/:sessionId/finalize-status ────────────────────────
  // Lightweight polling endpoint — no auth required beyond the session ID being
  // a secret UUID. Returns the assembly state so the client can detect
  // completion even after a finalize fetch timed out or disconnected.
  r.get(
    "/videos/upload/:sessionId/finalize-status",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["uploads"],
        summary: "Poll the finalization status of an upload session",
        params: z.object({ sessionId: z.string().min(1).max(128) }),
        response: {
          200: z.object({
            status: z.enum(["uploading", "assembling", "completed", "not_found"]),
            videoId: z.string().nullable(),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { sessionId } = req.params;
      const session = await db
        .select({
          status: sessions.status,
          completedVideoId: sessions.completedVideoId,
        })
        .from(sessions)
        .where(eq(sessions.sessionId, sessionId))
        .limit(1)
        .then((r) => r[0]);

      if (!session) {
        return { status: "not_found" as const, videoId: null };
      }

      const st = session.status as string;
      if (st === "completed") {
        return { status: "completed" as const, videoId: session.completedVideoId ?? null };
      }
      if (st === "assembling") {
        // Return completedVideoId even during assembly — the async-finalize path
        // pre-commits the video row and stores its id before background assembly
        // starts, so the client can obtain the video id without waiting for the
        // full assembly to finish.
        return { status: "assembling" as const, videoId: session.completedVideoId ?? null };
      }
      return { status: "uploading" as const, videoId: null };
    },
  );
}
