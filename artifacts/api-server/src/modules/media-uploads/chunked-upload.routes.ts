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
import { eq, asc, and, inArray, lt } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { storage } from "../../infrastructure/storage.js";
import { requireAuth } from "../../middleware/auth.js";
import { enqueueTranscode } from "../transcoder/transcoder.queue.js";
import { generateQuickThumbnail, normalizeThumbnailBuffer, probeUploadedDuration } from "../transcoder/transcoder.service.js";
import { runFaststart } from "../transcoder/faststart.service.js";
import { invalidateVideosCatalogCache } from "../videos/videos.routes.js";
import { env } from "../../config/env.js";
import { broadcastEngine } from "../broadcast/queue.engine.js";
import { broadcastService } from "../broadcast/broadcast.service.js";
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
  allChunks: Array<typeof chunks.$inferSelect>,
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

    // Assemble BYTEA chunks into multipart parts. The DatabaseObjectStorage
    // adapter has no minimum part-size restriction (unlike S3's 5 MiB floor),
    // so we upload each chunk as its own part immediately rather than
    // accumulating chunks. Processing one at a time keeps peak additional
    // memory at ~one chunk size (8 MiB) rather than a growing accumulator
    // buffer. The original data is already in `allChunks`; we just process
    // it sequentially to allow Node.js GC to free each Buffer sooner.
    const parts: Array<{ partNumber: number; etag: string }> = [];

    for (let i = 0; i < allChunks.length; i++) {
      const chunk = allChunks[i]!;
      const buf = chunk.fallbackData
        ? (chunk.fallbackData as unknown as Buffer)
        : Buffer.alloc(0);

      if (buf.length === 0) continue;

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
      const stuckRows = await db
        .select({ sessionId: sessions.sessionId })
        .from(sessions)
        .where(inArray(sessions.status, ["assembling"]));
      if (stuckRows.length > 0) {
        await db
          .update(sessions)
          .set({ status: "uploading", updatedAt: new Date() })
          .where(inArray(sessions.status, ["assembling"]));
        app.log.warn(
          { count: stuckRows.length, ids: stuckRows.map((r) => r.sessionId) },
          "[upload] reset stuck assembling sessions to uploading on startup",
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
          .select({ sessionId: sessions.sessionId })
          .from(sessions)
          .where(and(eq(sessions.status, "uploading"), lt(sessions.updatedAt, cutoff)));

        if (abandoned.length > 0) {
          const ids = abandoned.map((r) => r.sessionId);
          // Delete chunks first (FK dependency), then the session rows.
          await db.delete(chunks).where(inArray(chunks.sessionId, ids));
          await db.delete(sessions).where(inArray(sessions.sessionId, ids));
          app.log.info(
            { count: abandoned.length, ids },
            "[upload] cleaned up abandoned upload sessions and their chunks",
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
        return reply.send({ ok: true, chunkIndex, storageBackend: existingChunk.storageBackend });
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
        params: z.object({ sessionId: z.string() }),
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
      schema: {
        tags: ["uploads"],
        summary: "Complete the upload, insert the video row, and queue HLS transcoding",
        params: z.object({ sessionId: z.string() }),
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

      const session = await db
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

      // Idempotency: already finalized
      if (session.status === "completed" && session.completedVideoId) {
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

        // If the concurrent finalize finished while we were racing, return its result.
        if (refreshed?.status === "completed" && refreshed.completedVideoId) {
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

        // Still assembling (or an unexpected state) — tell the client to poll.
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

      // Load all received chunks, ordered by index
      const allChunks = await db
        .select()
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

      let localVideoUrl: string | null = null;
      let finalObjectKey: string | null = session.objectKey;
      let finalStorageBackend = session.storageBackend;

      // ── Assembly with server-side deadline ───────────────────────────────────
      // The batch-hex assembly algorithm is ~5× faster than the old per-part
      // approach, but we still impose an 8-minute hard deadline so that a
      // severe DB performance regression never hangs the HTTP response forever.
      // On timeout the session is reset to "uploading" so the client can retry.
      const ASSEMBLY_TIMEOUT_MS = 8 * 60 * 1000; // 8 minutes

      let assemblyTimedOut = false;
      const assemblyTimer = setTimeout(async () => {
        assemblyTimedOut = true;
        req.log.error(
          { sessionId, totalChunks: allChunks.length },
          "[finalize] assembly timeout — resetting session to uploading for retry",
        );
        await db
          .update(sessions)
          .set({ status: "uploading", updatedAt: new Date() })
          .where(eq(sessions.sessionId, sessionId))
          .catch(() => {});
      }, ASSEMBLY_TIMEOUT_MS);

      try {
        // "db" sessions used the multipart API via DatabaseObjectStorage (primary path).
        // "db_fallback" sessions stored raw BYTEA in upload_chunks and need assembly.
        if (session.storageBackend !== "db_fallback" && session.uploadId && session.objectKey) {
          // Build parts list — validate that every chunk has an etag before calling
          // completeMultipartUpload (a missing etag means a chunk was stored without
          // one, which would corrupt the assembly).
          const missingEtags = allChunks.filter((c) => !c.s3Etag);
          if (missingEtags.length > 0) {
            throw Object.assign(
              new Error(
                `${missingEtags.length} chunk(s) are missing storage etags — ` +
                  `re-upload the session to recover: indices ${missingEtags.slice(0, 10).map((c) => c.chunkIndex).join(", ")}`,
              ),
              { statusCode: 422 },
            );
          }
          const parts = allChunks.map((c) => ({
            partNumber: c.chunkIndex + 1,
            etag: c.s3Etag as string,
          }));

          const completed = await storage().completeMultipartUpload({
            key: session.objectKey,
            uploadId: session.uploadId,
            parts,
          });

          localVideoUrl = completed.location || storage().publicUrl(session.objectKey);
          finalObjectKey = session.objectKey;
          finalStorageBackend = "db";
        } else {
          // db_fallback: reassemble from BYTEA in upload_chunks into database storage
          const result = await finalizeFromDbFallback(session, allChunks, req.log);
          localVideoUrl = result.localVideoUrl;
          finalObjectKey = result.objectKey;
          finalStorageBackend = result.storageBackend;
        }
      } catch (assemblyErr) {
        clearTimeout(assemblyTimer);
        // Reset session to uploading so the client can retry finalization.
        await db
          .update(sessions)
          .set({ status: "uploading", updatedAt: new Date() })
          .where(eq(sessions.sessionId, sessionId))
          .catch(() => {});
        throw assemblyErr;
      }

      clearTimeout(assemblyTimer);

      // If the deadline fired while assembly was running, return 408 now — the
      // session has been reset to "uploading" so the client can retry finalize.
      if (assemblyTimedOut) {
        throw Object.assign(
          new Error(
            "File assembly exceeded the 8-minute deadline. " +
            "All chunks are safely stored — click Retry to resume finalization.",
          ),
          { statusCode: 408 },
        );
      }

      // Insert managed_videos row
      const videoId = randomUUID();
      const inserted = await db
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
        })
        .returning();

      const row = inserted[0];
      if (!row) throw new Error("videos insert returned no rows");

      // Mark session complete
      await db
        .update(sessions)
        .set({
          status: "completed",
          completedVideoId: videoId,
          storageBackend: finalStorageBackend,
          updatedAt: new Date(),
        })
        .where(eq(sessions.sessionId, sessionId));

      // Reclaim storage by deleting raw chunk rows now that the file has been
      // assembled. For "db" sessions the chunks table only holds small metadata
      // rows (no BYTEA); for "db_fallback" sessions this frees potentially
      // gigabytes of raw video data. Non-fatal — run in the background so
      // finalize returns quickly even if the delete is slow.
      void db
        .delete(chunks)
        .where(eq(chunks.sessionId, sessionId))
        .catch((err: unknown) => {
          req.log.warn({ err, sessionId }, "[finalize] chunk row cleanup failed (non-fatal)");
        });

      // Auto-add the uploaded video to the broadcast queue so it is ready to
      // air once processing completes. The item is inserted with isActive=true.
      //
      // Orchestrator admission: loadActive() allows statuses 'queued', 'encoding',
      // 'ready', and 'hls_ready' — only 'processing' is temporarily blocked to
      // prevent 404s while faststart is deleting and re-uploading the file during
      // moov atom relocation.
      //
      // We intentionally do NOT push broadcast-queue-updated here. The orchestrator
      // only reloads on that event, so the new item isn't visible to it until:
      //   • faststart completes → pushes broadcast-queue-updated. At this point the
      //     item is safe to stream (moov atom at byte 0). Status is 'ready' when
      //     TRANSCODER_DISABLE=true, or remains 'queued' when the HLS transcoder
      //     is also active (faststart skips status ownership in that case).
      //   • HLS transcoding completes → sets status='hls_ready' + hlsMasterUrl →
      //     pushes broadcast-queue-updated (transcoder.dispatcher.ts). Orchestrator
      //     switches from the raw MP4 fallback to the adaptive HLS stream.
      // This prevents the orchestrator from serving the raw un-faststarted blob
      // whose moov atom sits at EOF — which caused SKIP_PENDING "Source unavailable"
      // loops immediately after upload before faststart moved the atom to byte 0.
      // Non-fatal — if the queue insert fails the video is still saved.
      try {
        const durationSecs = session.durationSecs && session.durationSecs > 0
          ? Math.round(session.durationSecs)
          : 1800; // default 30 min placeholder until transcoder probes the real duration
        await broadcastService.addToQueue({
          videoId: row.id,
          title: session.title,
          thumbnailUrl: "",
          durationSecs,
          localVideoUrl,
          videoSource: "local",
        });
        // NOTE: broadcast-queue-updated is NOT pushed here.
        // The faststart service (faststart.service.ts) and the HLS transcoder
        // dispatcher (transcoder.dispatcher.ts) each push it after the asset
        // is confirmed streamable. This enforces the strict
        // upload → processing → ready → queue active pipeline.
      } catch (err) {
        req.log.warn(
          { err, videoId: row.id },
          "[finalize] auto-add to broadcast queue failed (non-fatal) — video saved, add manually",
        );
      }

      // Bust catalog cache and push SSE broadcast snapshot
      void invalidateVideosCatalogCache();
      try {
        broadcastEngine.pushSnapshot();
      } catch {
        /* non-fatal */
      }

      // Notify all connected clients (SSE + WebSocket) that the video
      // library has a new entry. TV/web clients bump libraryRevision via
      // the SSE sidecar; mobile clients receive a WS library-updated frame.
      adminEventBus.push("videos-library-updated", { videoId: row.id, reason: "upload-finalized" });

      // Enqueue HLS transcoding
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
        // Do NOT set transcodingStatus='failed' here: the video uploaded
        // successfully — only the job-queue insert failed (e.g. a transient
        // DB error). Marking it 'failed' would make the video appear broken
        // in the library immediately after a successful upload.
        // The video stays at its default status ('none') and can be manually
        // re-queued via Videos → Convert to HLS, or the Operations tab.
        req.log.warn(
          { err, videoId: row.id, errorMessage: err instanceof Error ? err.message : String(err) },
          "[finalize] enqueueTranscode failed — video saved, transcode can be re-queued manually",
        );
      }

      // Fire quick thumbnail extraction + duration probe + MP4 faststart
      // sequentially in a single background IIFE so they don't race on the
      // storage object key. All steps are non-fatal: failure is logged but
      // does not affect the already-returned finalize response.
      //
      // Order is important:
      //   1. Thumbnail + duration probe — reads the original stored blob
      //      (must run before faststart deletes and replaces the key).
      //   2. MP4 faststart — relocates the moov atom to the beginning via
      //      `ffmpeg -c copy -movflags +faststart`. After this step the
      //      video plays from byte 0 without HTTP Range support, and the
      //      player can parse metadata instantly even for 300 MB files.
      if (finalObjectKey) {
        const _clientDuration = Number(row.duration ?? "0");
        void (async () => {
          // Step 1: thumbnail + initial duration probe
          try {
            const [thumbUrl, probedSecs] = await Promise.all([
              generateQuickThumbnail(finalObjectKey!, row.id),
              _clientDuration > 0 ? Promise.resolve(null) : probeUploadedDuration(finalObjectKey!),
            ]);
            const patch: Partial<typeof videos.$inferInsert> = {};
            if (thumbUrl) patch.thumbnailUrl = thumbUrl;
            if (probedSecs != null) patch.duration = String(Math.round(probedSecs));
            if (Object.keys(patch).length > 0) {
              await db
                .update(videos)
                .set(patch)
                .where(eq(videos.id, row.id));
              void invalidateVideosCatalogCache();
              // Push SSE so the admin UI immediately shows the thumbnail
              // and corrected duration without waiting for faststart to
              // complete (which can take 30–90 s on large files).
              adminEventBus.push("videos-library-updated", {
                videoId: row.id,
                reason: "thumbnail-generated",
              });
            }
            // Sync the probed duration to any broadcast_queue rows that already
            // reference this video (auto-enqueued at finalize time with the
            // 1800-second placeholder). This corrects the slot timing before the
            // HLS transcoder fires, so the orchestrator uses the real length for
            // any playback that happens in the raw-MP4 window.
            if (probedSecs != null && probedSecs > 10) {
              const roundedSecs = Math.round(probedSecs);
              await db
                .update(schema.broadcastQueueTable)
                .set({ durationSecs: roundedSecs })
                .where(eq(schema.broadcastQueueTable.videoId, row.id))
                .catch((err) => {
                  req.log.warn(
                    { err, videoId: row.id, durationSecs: roundedSecs },
                    "[finalize] broadcast_queue duration sync failed (non-fatal)",
                  );
                });
            }
          } catch (err) {
            req.log.warn({ err, videoId: row.id }, "[finalize] post-upload probes failed (non-fatal)");
          }

          // Step 2: MP4 faststart — moov atom relocation for instant playback.
          // Always runs so the video is streamable from byte 0 immediately
          // after upload — this eliminates the HTTP Range moov-dance that
          // caused browsers to time out on large files before the HLS
          // transcode completed (the window where the broadcast queue plays
          // the raw MP4 fallback).
          //
          // When the HLS transcoder is also active (TRANSCODER_DISABLE=false)
          // we pass skipStatusUpdate=true so faststart never touches
          // transcodingStatus — the transcoder owns that field and we must not
          // overwrite its "encoding" / "hls_ready" lifecycle.
          //
          // Ordering: this step runs AFTER thumbnail + duration probe (Step 1)
          // which reads the original blob. Faststart then deletes and
          // re-uploads under the same key. The transcoder already queued its
          // job and will download the source independently; it receives either
          // the original or the faststart version — both transcode identically.
          try {
            await runFaststart(row.id, finalObjectKey!, {
              skipStatusUpdate: !env.TRANSCODER_DISABLE,
            });
          } catch (err) {
            req.log.warn({ err, videoId: row.id }, "[finalize] faststart failed (non-fatal)");
            // When the HLS transcoder is disabled, runFaststart is the ONLY
            // pipeline step that fires broadcast-queue-updated (it does so on
            // success in faststart.service.ts). If faststart throws, the
            // orchestrator never learns about the new queue item and the video
            // will never air — even though the raw MP4 blob is perfectly intact
            // and the broadcast_queue row was written at finalize time.
            // Push the event here so the orchestrator reloads and the video
            // becomes active (the original blob is still playable, just with
            // moov potentially at EOF on some strict players).
            if (env.TRANSCODER_DISABLE) {
              adminEventBus.push("broadcast-queue-updated", {
                reason: "faststart-failed-fallback",
                videoId: row.id,
              });
            }
          }
        })();
      }

      req.log.info(
        {
          sessionId,
          videoId: row.id,
          storageBackend: finalStorageBackend,
          totalChunks: allChunks.length,
        },
        "[finalize] ok",
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
        params: z.object({ sessionId: z.string() }),
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
        return { status: "assembling" as const, videoId: null };
      }
      return { status: "uploading" as const, videoId: null };
    },
  );
}
