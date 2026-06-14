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
import { env } from "../../config/env.js";
import { storage } from "../../infrastructure/storage.js";
import { requireAuth } from "../../middleware/auth.js";
import { enqueueTranscode } from "../transcoder/transcoder.queue.js";
import { transcoderDispatcher } from "../transcoder/transcoder.dispatcher.js";
import { generateQuickThumbnail, normalizeThumbnailBuffer, probeUploadedContainerValidity, probeUploadedDuration } from "../transcoder/transcoder.service.js";
import { runFaststart } from "../transcoder/faststart.service.js";
import { invalidateVideosCatalogCache } from "../videos/videos.routes.js";
import { broadcastEngine } from "../broadcast/queue.engine.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { uploadTelemetry } from "./upload-telemetry.service.js";
import { enqueueIfMissing } from "../broadcast/auto-enqueue.service.js";
import { ServiceUnavailableError } from "../../shared/errors.js";
import { quarantineVideo } from "../broadcast/quarantine.service.js";

const sessions = schema.uploadSessionsTable;
const chunks = schema.uploadChunksTable;
const videos = schema.videosTable;

// ─── Chunk-write concurrency semaphore ────────────────────────────────────────
// Each in-flight chunk upload holds an 8 MiB body buffer in Node.js heap for
// the entire duration of the uploadPart DB write (typically 13-15 s under
// concurrent background-assembly I/O pressure). Without a cap, 3 concurrent
// files × 4 parallel chunks = 12 × 8 MiB ≈ 96 MiB of simultaneous Buffer
// allocations. Combined with V8 heap fragmentation and the pg hex-encoding
// overhead this pushes RSS well above the memory-watchdog restart threshold.
//
// Limiting concurrent DB writes to 6 keeps peak chunk-buffer memory under
// ~50 MiB while still saturating a 10-connection pg pool. Override via
// MAX_CONCURRENT_CHUNK_DB_OPS env var if you raise DB_POOL_MAX.
const MAX_CONCURRENT_CHUNK_DB_OPS = Number(process.env["MAX_CONCURRENT_CHUNK_DB_OPS"] ?? 6);
let _activeChunkDbOps = 0;
const _chunkDbQueue: Array<() => void> = [];

function acquireChunkDbSlot(): Promise<void> {
  if (_activeChunkDbOps < MAX_CONCURRENT_CHUNK_DB_OPS) {
    _activeChunkDbOps++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => _chunkDbQueue.push(resolve));
}

function releaseChunkDbSlot(): void {
  const next = _chunkDbQueue.shift();
  if (next) {
    // Pass the active slot directly to the next waiter — do NOT decrement
    // _activeChunkDbOps so the counter stays consistent.
    next();
  } else {
    _activeChunkDbOps--;
  }
}

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
  broadcastOnly: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (typeof v === "string" ? v === "true" : (v ?? true)))
    .default(true),
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

// ─── Background assembly retry ────────────────────────────────────────────────
//
// Spawns a fire-and-forget re-assembly task for an interrupted upload session.
// Called from:
//   • Startup recovery — when all chunks are still present but the assembled
//     blob is missing (server restarted mid-assembly).
//   • Admin retry endpoint — when an operator clicks "Retry Assembly" on a
//     video that was left in ASSEMBLY_FAILED state.
//
// On success:  session → "completed"; video row restored (objectPath, s3MirroredAt,
//              transcodingStatus cleared); faststart + HLS transcoding queued.
// On failure:  video → ASSEMBLY_FAILED again; session → "uploading"; completedVideoId
//              nulled so the belt-and-suspenders guard in /finalize does not re-fire.
//
async function spawnAssemblyRetry(
  sessionId: string,
  videoId: string,
  log: FastifyInstance["log"],
): Promise<void> {
  void (async () => {
    try {
      // Re-load the full session row — needed for finalizeFromDbFallback.
      const [session] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.sessionId, sessionId))
        .limit(1);

      if (!session) {
        log.warn({ sessionId, videoId }, "[assembly-retry] session not found — aborting retry");
        return;
      }

      const objectKey = session.objectKey;
      if (!objectKey) {
        log.warn({ sessionId, videoId }, "[assembly-retry] session has no objectKey — aborting retry");
        await db
          .update(videos)
          .set({
            transcodingStatus: "failed",
            transcodingErrorCode: "ASSEMBLY_FAILED",
            transcodingErrorMessage:
              "Retry failed: upload session has no storage key. Delete this video and re-upload to recover.",
          })
          .where(eq(videos.id, videoId))
          .catch(() => {});
        await db
          .update(sessions)
          .set({ status: "uploading", completedVideoId: null, updatedAt: new Date() })
          .where(eq(sessions.sessionId, sessionId))
          .catch(() => {});
        adminEventBus.push("videos-library-updated", { videoId, reason: "assembly-retry-no-key" });
        return;
      }

      log.info(
        { sessionId, videoId, storageBackend: session.storageBackend, objectKey },
        "[assembly-retry] starting background re-assembly",
      );

      if (session.storageBackend === "db_fallback") {
        // BYTEA chunks in upload_chunks.fallback_data — fully idempotent.
        await finalizeFromDbFallback(session, session.totalChunks, log);
      } else {
        // DB-multipart path: assemble from existing part ETags.
        if (!session.uploadId) {
          throw new Error("session.uploadId is null — cannot re-assemble db-backend session");
        }
        const allChunks = await db
          .select({ chunkIndex: chunks.chunkIndex, s3Etag: chunks.s3Etag })
          .from(chunks)
          .where(eq(chunks.sessionId, sessionId))
          .orderBy(asc(chunks.chunkIndex));

        if (allChunks.length !== session.totalChunks) {
          throw new Error(
            `Chunk count mismatch: expected ${session.totalChunks}, found ${allChunks.length}`,
          );
        }
        const missingEtags = allChunks.filter((c) => !c.s3Etag);
        if (missingEtags.length > 0) {
          throw new Error(
            `${missingEtags.length} chunk(s) are missing storage ETags — parts may have been partially consumed`,
          );
        }
        await storage().completeMultipartUpload({
          key: objectKey,
          uploadId: session.uploadId,
          parts: allChunks.map((c) => ({
            partNumber: c.chunkIndex + 1,
            etag: c.s3Etag as string,
          })),
        });
      }

      // Verify assembled blob size.
      const head = await storage().headObject(objectKey);
      if (!head.exists || (session.sizeBytes > 0 && head.contentLength !== session.sizeBytes)) {
        throw new Error(
          `Assembled blob size mismatch: expected ${session.sizeBytes} bytes, got ${head.contentLength ?? 0}`,
        );
      }

      const localVideoUrl = storage().publicUrl(objectKey);

      // Mark session completed + restore video row in parallel.
      await Promise.all([
        db
          .update(sessions)
          .set({ status: "completed", storageBackend: "db", updatedAt: new Date() })
          .where(eq(sessions.sessionId, sessionId))
          .catch((err: unknown) =>
            log.warn({ err, sessionId }, "[assembly-retry] session completed update failed (non-fatal)"),
          ),
        db
          .update(videos)
          .set({
            s3MirroredAt: new Date(),
            objectPath: objectKey,
            localVideoUrl,
            transcodingStatus: "none",
            transcodingErrorCode: null,
            transcodingErrorMessage: null,
          })
          .where(eq(videos.id, videoId))
          .catch((err: unknown) =>
            log.warn({ err, videoId }, "[assembly-retry] video row restore failed (non-fatal)"),
          ),
      ]);

      adminEventBus.push("videos-library-updated", { videoId, reason: "assembly-retry-succeeded" });
      void invalidateVideosCatalogCache();
      log.info({ sessionId, videoId }, "[assembly-retry] assembly succeeded — running post-processing");

      // Re-read video row for post-processing (faststart writes objectPath so it
      // must be current; re-reading is cheaper than trusting our own update).
      const [vRow] = await db
        .select({
          objectPath: videos.objectPath,
          faststartApplied: videos.faststartApplied,
          hlsMasterUrl: videos.hlsMasterUrl,
        })
        .from(videos)
        .where(eq(videos.id, videoId))
        .limit(1);

      if (!vRow?.objectPath) {
        log.warn({ videoId }, "[assembly-retry] post-processing skipped: no objectPath after update");
        return;
      }

      // Broadcast queue slot.
      try {
        const enqResult = await enqueueIfMissing({ videoId, reason: "assembly-retry" });
        if (enqResult.enqueued) {
          adminEventBus.push("broadcast-queue-updated", { reason: "assembly-retry-enqueue", videoId });
        }
      } catch (err) {
        log.warn({ err, videoId }, "[assembly-retry] enqueueIfMissing failed (non-fatal)");
      }

      // Faststart (move moov atom to front of MP4).
      if (!vRow.faststartApplied) {
        try {
          await runFaststart(videoId, vRow.objectPath, { skipStatusUpdate: false });
          log.info({ videoId }, "[assembly-retry] faststart applied");
        } catch (fsErr) {
          log.warn({ err: fsErr, videoId }, "[assembly-retry] faststart failed (non-fatal)");
        }
      }

      // HLS transcoding.
      if (!vRow.hlsMasterUrl) {
        try {
          await enqueueTranscode({ videoId, videoPath: vRow.objectPath });
          if (!env.TRANSCODER_DISABLE) transcoderDispatcher.nudge();
          log.info({ videoId }, "[assembly-retry] HLS transcoding queued");
        } catch (txErr) {
          log.warn({ err: txErr, videoId }, "[assembly-retry] enqueueTranscode failed (non-fatal)");
        }
      }

      log.info({ sessionId, videoId }, "[assembly-retry] complete ✓");

    } catch (err) {
      log.error({ err, sessionId, videoId }, "[assembly-retry] failed — marking video ASSEMBLY_FAILED");
      await Promise.allSettled([
        db
          .update(videos)
          .set({
            transcodingStatus: "failed",
            transcodingErrorCode: "ASSEMBLY_FAILED",
            transcodingErrorMessage:
              "Automatic re-assembly failed after server restart. " +
              "Click 'Retry Assembly' to try again, or delete this video and re-upload.",
          })
          .where(eq(videos.id, videoId)),
        db
          .update(sessions)
          .set({ status: "uploading", completedVideoId: null, updatedAt: new Date() })
          .where(eq(sessions.sessionId, sessionId)),
      ]);
      adminEventBus.push("videos-library-updated", { videoId, reason: "assembly-retry-failed" });
    }
  })();
}

// ─── DB-fallback finalization ──────────────────────────────────────────────────

async function finalizeFromDbFallback(
  session: typeof sessions.$inferSelect,
  totalChunks: number,
  log: FastifyInstance["log"],
): Promise<{ localVideoUrl: string | null; objectKey: string; storageBackend: "db" | "db_fallback" }> {
  // Emit assembly progress SSE events every 5 s so the admin panel can show
  // a real progress bar instead of a silent spinner for up to ~90 min on large
  // uploads. Non-fatal: SSE emission failures are ignored to keep the assembly loop running.
  const PROGRESS_EMIT_INTERVAL_MS = 5_000;
  let lastProgressEmitMs = Date.now();
  let bytesAssembled = 0;
  const totalBytes = session.sizeBytes ?? 0;

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

  // Declared outside the try so the catch block can abort the multipart upload
  // if any step fails (chunk fetch, uploadPart, completeMultipartUpload).
  // Without this, a failed assembly leaves orphaned _parts/{uploadId}/... rows
  // in storage_blobs forever — the stale session cleanup uses sessions.uploadId
  // (the original db-path upload), NOT the temporary uploadId created here for
  // reassembly, so it would never clean up these orphaned rows.
  let assemblyUploadId: string | undefined;

  try {
    const { uploadId } = await storage().createMultipartUpload({
      key: objectKey,
      contentType: session.contentType,
    });
    assemblyUploadId = uploadId;

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
      // Also fetch the stored checksum so we can re-verify integrity before assembling.
      const chunkRow = await db
        .select({ fallbackData: chunks.fallbackData, checksum: chunks.checksum })
        .from(chunks)
        .where(and(eq(chunks.sessionId, session.sessionId), eq(chunks.chunkIndex, i)))
        .limit(1)
        .then((r) => r[0]);

      const buf = chunkRow?.fallbackData
        ? (chunkRow.fallbackData as unknown as Buffer)
        : Buffer.alloc(0);

      if (buf.length === 0) {
        // A missing chunk means the assembled file would be corrupt/truncated.
        // Fail hard so the client sees a clear error and can re-upload rather
        // than silently producing a broken video.
        const msg = `[finalize-fallback] chunk ${i} has empty fallbackData — cannot assemble video (sessionId: ${session.sessionId}). Re-upload required.`;
        log.error({ sessionId: session.sessionId, chunkIndex: i }, msg);
        throw new Error(msg);
      }

      // Re-verify SHA-256 integrity against the stored checksum to catch any
      // silent BYTEA corruption that may have occurred between chunk receipt and
      // finalize time. If the hash mismatches the stored chunk is corrupt and
      // assembling it would produce an unplayable file — fail hard here so the
      // operator gets a clear error and can retry the upload.
      if (chunkRow?.checksum) {
        const actualHash = createHash("sha256").update(buf).digest("hex");
        if (actualHash !== chunkRow.checksum) {
          const msg =
            `[finalize-fallback] chunk ${i} SHA-256 mismatch — expected ${chunkRow.checksum}, ` +
            `got ${actualHash} (sessionId: ${session.sessionId}). DB row appears corrupted; re-upload required.`;
          log.error({ sessionId: session.sessionId, chunkIndex: i, expected: chunkRow.checksum, actual: actualHash }, msg);
          throw new Error(msg);
        }
      }

      const { etag } = await storage().uploadPart({
        key: objectKey,
        uploadId,
        partNumber: i + 1,
        body: buf,
      });
      parts.push({ partNumber: i + 1, etag });

      // Emit SSE progress every 5 s so the admin panel can render a progress bar.
      // We throttle by wall-clock time rather than chunk count because chunks vary
      // in size and upload latency. Payload uses byte-based fields so the consumer
      // can render a standard bytes-transferred / total-bytes progress bar.
      // Non-fatal: failures are swallowed so the loop always continues.
      bytesAssembled += buf.length;
      const nowMs = Date.now();
      if (nowMs - lastProgressEmitMs >= PROGRESS_EMIT_INTERVAL_MS) {
        lastProgressEmitMs = nowMs;
        const pct = totalBytes > 0 ? Math.round((bytesAssembled / totalBytes) * 100) : Math.round(((i + 1) / totalChunks) * 100);
        try {
          adminEventBus.push("upload-assembly-progress", {
            sessionId: session.sessionId,
            bytesAssembled,
            totalBytes,
            pct,
          });
        } catch {
          // non-fatal — never let SSE emission abort the assembly
        }
      }
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
    // Abort the in-progress multipart upload to clean up orphaned
    // _parts/{assemblyUploadId}/... rows in storage_blobs. Without this call
    // those rows accumulate permanently — the stale session cleanup uses
    // sessions.uploadId (the original ingest upload), not this temporary
    // reassembly upload which is never stored in the sessions table.
    if (assemblyUploadId) {
      await storage().abortMultipartUpload({ key: objectKey, uploadId: assemblyUploadId }).catch(
        (abortErr: unknown) => {
          log.warn(
            { abortErr, sessionId: session.sessionId, uploadId: assemblyUploadId, objectKey },
            "[finalize-fallback] failed to abort orphaned assembly multipart upload (non-fatal) — " +
              "run the abandoned session cleanup to remove orphaned _parts rows",
          );
        },
      );
    }
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
      // The async-finalize path pre-commits a video row and starts writing the
      // assembled blob to storage_blobs (status="assembling") BEFORE responding
      // to the client. If the server restarts mid-assembly we must triage each
      // stuck session instead of blindly deleting every pre-committed video row:
      //
      //   • Assembly COMPLETED before crash (blob size = declared size):
      //     Keep the video row — it is a real, usable video that was fully
      //     uploaded. Just mark the session "completed" so the idempotency
      //     check and the finalize-status poller both see the right state.
      //     Fire a videos-library-updated SSE so the admin panel refreshes.
      //
      //   • Assembly INTERRUPTED (blob missing or truncated):
      //     Delete the pre-committed video row (it has no usable blob),
      //     delete the partial storage_blobs row, and reset the session to
      //     "uploading" so the client can re-attempt finalize from scratch.
      //
      // This prevents the previously-observed bug where a video uploaded
      // successfully in one API process disappears from the admin panel after
      // the next server restart (e.g. a routine dev hot-reload).
      const stuckRows = await db
        .select({
          sessionId: sessions.sessionId,
          completedVideoId: sessions.completedVideoId,
          objectKey: sessions.objectKey,
          sizeBytes: sessions.sizeBytes,
          totalChunks: sessions.totalChunks,
          storageBackend: sessions.storageBackend,
        })
        .from(sessions)
        .where(inArray(sessions.status, ["assembling"]));

      if (stuckRows.length > 0) {
        const recoveredSessionIds: string[] = [];
        const recoveredVideoIds: string[] = [];
        const orphanedSessionIds: string[] = [];
        const orphanedVideoIds: string[] = [];
        const orphanedObjectKeys: string[] = [];
        const orphanedTotalChunks: number[] = [];

        for (const row of stuckRows) {
          // Sessions that never reached pre-commit (no video row yet) are
          // straightforward: just reset to "uploading".
          if (!row.completedVideoId || !row.objectKey) {
            orphanedSessionIds.push(row.sessionId);
            continue;
          }

          // Probe the blob size in storage_blobs to determine whether
          // completeMultipartUpload ran to completion before the crash.
          //
          // SAFETY: use an explicit try/catch instead of .catch(() => ({ exists: false })).
          // Collapsing ANY storage error into "blob not found" causes valid, fully-assembled
          // video rows to be hard-deleted when the DB experiences a transient error during
          // this headObject query (e.g. a connection hiccup at startup). On storage failure
          // we skip the session — leaving it in "assembling" — so the next restart can
          // re-triage it once storage is reachable again. Only confirmed-absent blobs
          // (head.exists === false with a successful query) are treated as genuinely
          // interrupted assemblies that need cleanup.
          let head: { exists: boolean; contentLength?: number } | null = null;
          try {
            head = await storage().headObject(row.objectKey);
          } catch (headErr) {
            app.log.warn(
              { err: headErr, sessionId: row.sessionId, objectKey: row.objectKey },
              "[upload] recovery: headObject failed — skipping session; will re-triage on next restart",
            );
            continue; // preserve the video row; do NOT classify as orphaned
          }

          const blobSize = head.contentLength ?? 0;
          const assemblyComplete =
            head.exists && blobSize === row.sizeBytes && row.sizeBytes > 0;
          const decision = assemblyComplete ? "recovered" : "orphaned";

          app.log.info(
            {
              sessionId: row.sessionId,
              videoId: row.completedVideoId,
              blobSize,
              declaredSize: row.sizeBytes,
              blobExists: head.exists,
              decision,
            },
            "[upload] onReady assembly triage",
          );

          if (assemblyComplete) {
            // Blob is fully intact — the crash happened AFTER assembly completed
            // but BEFORE the session status was written to "completed". Recover
            // the video row by finalising the session state without deleting anything.
            recoveredSessionIds.push(row.sessionId);
            recoveredVideoIds.push(row.completedVideoId);
          } else {
            // Blob is missing or truncated — assembly was interrupted.
            // Will be re-classified below: "retriable" if all chunks are still
            // present in upload_chunks, or "orphaned" (truly unrecoverable) if not.
            orphanedSessionIds.push(row.sessionId);
            orphanedVideoIds.push(row.completedVideoId);
            orphanedObjectKeys.push(row.objectKey);
            orphanedTotalChunks.push(row.totalChunks);
          }
        }

        // ── Re-classify orphaned → retriable where all chunks are still present ──
        //
        // For sessions whose blob assembly was interrupted mid-flight, the chunks
        // (BYTEA for db_fallback, or part-ETags for db) are still stored in
        // upload_chunks. We can automatically re-run assembly without asking the
        // admin to delete and re-upload. Batch the count query to avoid N round trips.
        const retriableSessionIds: string[] = [];
        const retriableVideoIds: string[] = [];
        const trulyOrphanedSessionIds: string[] = [];
        const trulyOrphanedVideoIds: string[] = [];
        const trulyOrphanedObjectKeys: string[] = [];

        if (orphanedSessionIds.length > 0) {
          // Batch chunk count: one query for all orphaned sessions.
          const chunkCountRows = await db
            .select({
              sessionId: chunks.sessionId,
              cnt: sql<number>`COUNT(*)::int`.as("cnt"),
            })
            .from(chunks)
            .where(inArray(chunks.sessionId, orphanedSessionIds))
            .groupBy(chunks.sessionId)
            .catch(() => [] as Array<{ sessionId: string; cnt: number }>);

          const chunkCounts = new Map<string, number>();
          for (const r of chunkCountRows) chunkCounts.set(r.sessionId, r.cnt);

          for (let i = 0; i < orphanedSessionIds.length; i++) {
            const sid = orphanedSessionIds[i];
            const vid = orphanedVideoIds[i];
            const key = orphanedObjectKeys[i];
            const total = orphanedTotalChunks[i] ?? 0;
            const present = chunkCounts.get(sid) ?? 0;

            if (total > 0 && present >= total) {
              // All chunks are present — we can re-run assembly automatically.
              app.log.info(
                { sessionId: sid, videoId: vid, chunksPresent: present, totalChunks: total },
                "[upload] recovery: all chunks present — scheduling auto-retry instead of ASSEMBLY_FAILED",
              );
              retriableSessionIds.push(sid);
              retriableVideoIds.push(vid);
            } else {
              // Chunks are incomplete — nothing to assemble; needs re-upload.
              app.log.warn(
                { sessionId: sid, videoId: vid, chunksPresent: present, totalChunks: total },
                "[upload] recovery: chunks incomplete — marking ASSEMBLY_FAILED (re-upload required)",
              );
              trulyOrphanedSessionIds.push(sid);
              trulyOrphanedVideoIds.push(vid);
              trulyOrphanedObjectKeys.push(key);
            }
          }
        }

        // ── Auto-retry retriable sessions ─────────────────────────────────
        // Reset video rows back to a pending state, keep sessions in "assembling"
        // (they were already there), and spawn a background re-assembly task.
        // spawnAssemblyRetry handles success/failure and updates both rows.
        if (retriableSessionIds.length > 0) {
          await db
            .update(videos)
            .set({
              transcodingStatus: "none",
              transcodingErrorCode: null,
              transcodingErrorMessage: null,
              // objectPath + localVideoUrl preserved — session.objectKey is still valid;
              // the blob just needs to be (re-)assembled into it.
            })
            .where(inArray(videos.id, retriableVideoIds))
            .catch((err: unknown) =>
              app.log.warn({ err }, "[upload] recovery: retriable video row reset failed (non-fatal)"),
            );
          for (const videoId of retriableVideoIds) {
            adminEventBus.push("videos-library-updated", { videoId, reason: "assembly-retry-scheduled" });
          }
          app.log.info(
            { count: retriableSessionIds.length, videoIds: retriableVideoIds },
            "[upload] recovery: scheduling background re-assembly for interrupted sessions with intact chunks",
          );
          // Fire all background retries (fire-and-forget — each handles its own error).
          for (let i = 0; i < retriableSessionIds.length; i++) {
            void spawnAssemblyRetry(retriableSessionIds[i], retriableVideoIds[i], app.log);
          }
        }

        // ── Recover fully-assembled sessions ──────────────────────────────
        if (recoveredSessionIds.length > 0) {
          await db
            .update(sessions)
            .set({ status: "completed", updatedAt: new Date() })
            .where(inArray(sessions.sessionId, recoveredSessionIds))
            .catch((err: unknown) =>
              app.log.warn({ err }, "[upload] recovery: session status update failed (non-fatal)"),
            );
          // Ensure s3MirroredAt is stamped on the video rows so the post-assembly
          // path (faststart / enqueueIfMissing) knows the blob exists.
          await db
            .update(videos)
            .set({ s3MirroredAt: new Date() })
            .where(inArray(videos.id, recoveredVideoIds))
            .catch((err: unknown) =>
              app.log.warn({ err }, "[upload] recovery: s3MirroredAt stamp failed (non-fatal)"),
            );
          // Notify the admin panel so recovered videos appear immediately without
          // requiring a manual page refresh.
          for (const videoId of recoveredVideoIds) {
            adminEventBus.push("videos-library-updated", { videoId, reason: "assembly-recovered-on-restart" });
          }
          app.log.info(
            { count: recoveredSessionIds.length, videoIds: recoveredVideoIds },
            "[upload] recovered fully-assembled sessions after server restart — video rows preserved",
          );

          // Re-enqueue each recovered video into the broadcast queue and resume
          // any post-assembly processing (faststart, HLS) that the server crash
          // interrupted before it could complete.
          //
          // All three steps are idempotent:
          //   • enqueueIfMissing  — no-ops if the queue slot already exists
          //   • runFaststart      — guarded by faststartApplied=true already set
          //   • enqueueTranscode  — guarded by hlsMasterUrl IS NOT NULL already set
          for (const videoId of recoveredVideoIds) {
            void (async () => {
              try {
                // Step 1: Broadcast queue slot.
                const enqResult = await enqueueIfMissing({ videoId, reason: "upload-recovery-on-restart" });
                if (enqResult.enqueued) {
                  app.log.info(
                    { videoId, queueItemId: enqResult.queueItemId },
                    "[upload] recovery: auto-queued recovered video for broadcast",
                  );
                  adminEventBus.push("broadcast-queue-updated", { reason: "upload-recovery-enqueue", videoId });
                }

                // Step 2: Query current video state to decide what further
                // processing is still outstanding.
                const [vRow] = await db
                  .select({
                    objectPath: videos.objectPath,
                    faststartApplied: videos.faststartApplied,
                    hlsMasterUrl: videos.hlsMasterUrl,
                    transcodingStatus: videos.transcodingStatus,
                  })
                  .from(videos)
                  .where(eq(videos.id, videoId))
                  .limit(1);

                if (!vRow?.objectPath) return;

                // Step 3: Faststart — moves the moov atom to the front of the
                // MP4 so the file is streamable via HTTP range requests.
                // Also required for midnight-prayers videos to enter rotation
                // (midnight-prayers service gates on faststartApplied=true for
                // raw MP4 playback).
                if (!vRow.faststartApplied) {
                  try {
                    await runFaststart(videoId, vRow.objectPath, { skipStatusUpdate: false });
                    app.log.info({ videoId }, "[upload] recovery: faststart applied to recovered video");
                  } catch (fsErr) {
                    app.log.warn(
                      { err: fsErr, videoId },
                      "[upload] recovery: faststart failed for recovered video (non-fatal) — video is still broadcast-ready but not midnight-prayers eligible",
                    );
                  }
                }

                // Step 4: HLS transcoding — re-read faststartApplied after the
                // step above so we use the freshest state.
                if (!vRow.hlsMasterUrl) {
                  try {
                    await enqueueTranscode({ videoId, videoPath: vRow.objectPath });
                    if (!env.TRANSCODER_DISABLE) transcoderDispatcher.nudge();
                    app.log.info({ videoId }, "[upload] recovery: HLS transcoding queued for recovered video");
                  } catch (txErr) {
                    app.log.warn(
                      { err: txErr, videoId },
                      "[upload] recovery: enqueueTranscode failed for recovered video (non-fatal)",
                    );
                  }
                }
              } catch (err) {
                app.log.warn(
                  { err, videoId },
                  "[upload] recovery: post-assembly processing failed for recovered video (non-fatal)",
                );
              }
            })();
          }
        }

        // ── Clean up truly orphaned sessions (chunks incomplete — re-upload required) ──
        if (trulyOrphanedVideoIds.length > 0) {
          // Remove broadcast_queue slots added optimistically at pre-commit time.
          await db
            .delete(schema.broadcastQueueTable)
            .where(inArray(schema.broadcastQueueTable.videoId, trulyOrphanedVideoIds))
            .catch(() => {});
          // Mark video rows as failed instead of deleting them. Deleting caused
          // the "disappearing video" bug — the admin saw the upload succeed, the
          // row appeared in the panel, then vanished silently on the next server
          // restart. Keeping the row with transcodingStatus="failed" +
          // transcodingErrorCode="ASSEMBLY_FAILED" preserves the title and
          // metadata so the admin sees a "Re-upload required" badge and knows
          // exactly what happened. Chunks are incomplete so re-upload is the
          // only recovery path.
          await db
            .update(videos)
            .set({
              transcodingStatus: "failed",
              transcodingErrorCode: "ASSEMBLY_FAILED",
              transcodingErrorMessage:
                "Upload assembly was interrupted and upload data is incomplete. " +
                "Delete this video and re-upload to recover.",
              objectPath: null,     // blob is gone → sourceAvailable: false
              localVideoUrl: null,  // no longer streamable
            })
            .where(inArray(videos.id, trulyOrphanedVideoIds))
            .catch((err: unknown) =>
              app.log.warn({ err }, "[upload] recovery: failed to mark orphaned video rows as failed (non-fatal)"),
            );
          // Notify the admin panel so the failed status appears immediately.
          for (const videoId of trulyOrphanedVideoIds) {
            adminEventBus.push("videos-library-updated", { videoId, reason: "assembly-interrupted-on-restart" });
          }
        }
        // Delete partially-written destination blobs so the next finalize attempt
        // gets a clean objectKey instead of appending to a corrupt partial blob.
        for (const key of trulyOrphanedObjectKeys) {
          await db
            .execute(sql`DELETE FROM storage_blobs WHERE key = ${key}`)
            .catch((err: unknown) =>
              app.log.warn({ err, key }, "[upload] partial dest blob cleanup failed (non-fatal)"),
            );
        }
        if (trulyOrphanedSessionIds.length > 0) {
          // Reset to "uploading" so the client's retry logic can re-attempt finalize.
          await db
            .update(sessions)
            .set({ status: "uploading", completedVideoId: null, updatedAt: new Date() })
            .where(inArray(sessions.sessionId, trulyOrphanedSessionIds));
          app.log.warn(
            {
              count: trulyOrphanedSessionIds.length,
              trulyOrphanedVideoIds,
              destBlobsDeleted: trulyOrphanedObjectKeys.length,
              ids: trulyOrphanedSessionIds,
            },
            "[upload] reset interrupted assembling sessions (chunks incomplete) — video rows preserved with ASSEMBLY_FAILED status, partial blobs cleaned up",
          );
        }
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
    const cleanupTimer = setInterval(() => { void runSessionCleanup(); }, CLEANUP_INTERVAL_MS).unref();
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
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["uploads"],
        summary: "Initialize a resumable chunked upload session (server-relay path)",
        body: InitBodySchema,
        response: {
          200: z.object({
            ok: z.literal(true),
            sessionId: z.string(),
            storageBackend: z.enum(["db", "db_fallback"]),
            totalChunks: z.number().int().positive(),
            chunkSize: z.number().int().positive(),
          }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const body = req.body;

      // ── File type gate ──────────────────────────────────────────────────────
      // Reject non-video files immediately — before allocating a multipart
      // upload slot or inserting a session row.  The admin upload UI already
      // restricts the file picker to video/* types, but a direct API call could
      // bypass that and create a session that burns storage quota and then fails
      // at finalize time (after the full upload has already been transferred).
      // Belt-and-suspenders: validate on both extension AND MIME type.
      {
        const ALLOWED_VIDEO_EXTS = new Set([
          "mp4", "mov", "mkv", "avi", "webm", "m4v", "flv", "wmv",
          "ts", "mts", "m2ts",
        ]);
        const extFromExt = (body.ext ?? "").replace(/^\./, "").toLowerCase();
        const extFromFilename = body.originalFilename
          ? (body.originalFilename.split(".").pop() ?? "").toLowerCase()
          : "";
        const effectiveExt = extFromExt || extFromFilename;
        if (effectiveExt && !ALLOWED_VIDEO_EXTS.has(effectiveExt)) {
          throw Object.assign(
            new Error(
              `Unsupported file extension ".${effectiveExt}". ` +
              `Only video files are accepted: mp4, mov, mkv, avi, webm, ` +
              `m4v, flv, wmv, ts, mts, m2ts.`,
            ),
            { statusCode: 422 },
          );
        }
        // Reject clearly non-video MIME types. Allow video/*, application/octet-
        // stream (generic binary — common for video files from some OS/browser
        // combinations), application/mp4, and application/x-matroska.
        const mimeTypeLower = (body.mimeType ?? "").toLowerCase();
        const isDefinitelyNotVideo =
          mimeTypeLower.startsWith("image/") ||
          mimeTypeLower.startsWith("text/") ||
          mimeTypeLower === "application/pdf" ||
          mimeTypeLower.startsWith("application/msword") ||
          mimeTypeLower.startsWith("application/vnd.openxmlformats") ||
          mimeTypeLower.startsWith("application/vnd.ms-");
        if (isDefinitelyNotVideo) {
          throw Object.assign(
            new Error(
              `File type "${body.mimeType}" is not a video. ` +
              `Only video files are accepted (video/mp4, video/quicktime, ` +
              `video/webm, etc.).`,
            ),
            { statusCode: 422 },
          );
        }
      }

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
          totalChunks: existing.totalChunks,
          chunkSize: existing.chunkSize,
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
        const timeoutPromise = new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error("createMultipartUpload timed out after 5 s")), 5_000).unref();
          // .unref() so this timer does not prevent Node from exiting on SIGTERM
          // when the race resolves via mpPromise (the common case).
          t.unref();
        });
        const mp = await Promise.race([mpPromise, timeoutPromise]);
        uploadId = mp.uploadId;
        storageBackend = "db";
      } catch (err) {
        req.log.warn(
          { err, sessionId: body.sessionId },
          "[chunked-init] storage multipart init failed — session will use DB fallback storage",
        );
      }

      try {
        await db.insert(sessions).values({
          sessionId: body.sessionId,
          uploadId,
          objectKey: storageBackend !== "db_fallback" ? objectKey : null,
          title: body.title,
          description: body.description ?? "",
          category: body.category ?? "sermon",
          preacher: body.preacher ?? "",
          featured: body.featured ?? false,
          broadcastOnly: body.broadcastOnly ?? true,
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
      } catch (insertErr) {
        // If the DB session insert fails but we already reserved a multipart
        // upload slot in storage_blobs, abort it so orphaned _parts rows don't
        // accumulate. The client can safely retry with the same sessionId — the
        // idempotency check at the top of this handler will create a fresh session.
        if (uploadId) {
          await storage().abortMultipartUpload({ key: objectKey, uploadId }).catch((abortErr: unknown) =>
            req.log.warn(
              { abortErr, sessionId: body.sessionId, uploadId },
              "[chunked-init] failed to abort orphaned multipart upload after session insert error (non-fatal)",
            ),
          );
        }
        throw insertErr;
      }

      req.log.info(
        {
          sessionId: body.sessionId,
          storageBackend,
          totalChunks: body.totalChunks,
          totalBytes: body.totalBytes,
        },
        "[chunked-init] session created",
      );

      uploadTelemetry.init(
        body.sessionId,
        Number(body.totalBytes),
        req.headers["user-agent"] ?? null,
      );

      return {
        ok: true as const,
        sessionId: body.sessionId,
        storageBackend,
        totalChunks: Number(body.totalChunks),
        chunkSize,
      };
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

      let body = req.body as Buffer;
      if (!body || body.length === 0) {
        return reply.code(400).send({ error: "Empty chunk body" });
      }

      // Verify SHA-256 integrity before acquiring the DB slot so we don't
      // hold a semaphore permit while doing CPU work.
      const sizeBytes = body.length;
      const actualChecksum = createHash("sha256").update(body).digest("hex");
      if (actualChecksum !== checksum) {
        return reply.code(422).send({
          error:
            `Chunk ${chunkIndex} checksum mismatch — expected ${checksum}, ` +
            `got ${actualChecksum}. The chunk was corrupted in transit; re-send it.`,
        });
      }

      const chunkId = randomUUID();

      // Acquire a DB-write slot before touching storage. The semaphore caps
      // concurrent 8 MiB body buffers in flight so peak RSS stays bounded even
      // under a 3-file simultaneous upload with 4 parallel chunks each.
      await acquireChunkDbSlot();
      try {
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

            // body is no longer needed — release the 8 MiB buffer for GC
            // before the next await (the chunks INSERT) so it isn't kept alive
            // across the full ~13-15 s DB write.
            body = Buffer.alloc(0);
            (req as any).body = null;

            await db.insert(chunks).values({
              id: chunkId,
              sessionId,
              chunkIndex,
              checksum,
              sizeBytes,
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

        // DB fallback mode: store raw bytes as BYTEA.
        // body is passed as fallbackData — cannot null it before the INSERT.
        await db.insert(chunks).values({
          id: chunkId,
          sessionId,
          chunkIndex,
          checksum,
          sizeBytes,
          fallbackData: body,
          storageBackend: "db_fallback",
        });

        // Release the 8 MiB buffer now that it's persisted to the DB.
        body = Buffer.alloc(0);
        (req as any).body = null;

        return reply.send({ ok: true, chunkIndex, storageBackend: "db_fallback" });
      } finally {
        releaseChunkDbSlot();
      }
    },
  );

  // ── GET /videos/upload/:sessionId/status ───────────────────────────────────
  r.get(
    "/videos/upload/:sessionId/status",
    {
      preHandler: requireAuth("editor"),
      // Called once per upload resume attempt: 60/min covers normal use
      // (3 concurrent files × 10 resume checks) with headroom for retries.
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },      schema: {
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
          429: z.object({ error: z.string() }),
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
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
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
          429: z.object({ error: z.string() }),
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
          db
            .update(videos)
            .set({
              transcodingStatus: "failed",
              transcodingErrorCode: "ASSEMBLY_FAILED",
              transcodingErrorMessage:
                "Upload assembly was interrupted by a server restart. " +
                "Delete this video and re-upload to recover.",
              objectPath: null,
              localVideoUrl: null,
            })
            .where(eq(videos.id, session.completedVideoId)),
          db
            .update(sessions)
            .set({ completedVideoId: null })
            .where(eq(sessions.sessionId, sessionId)),
        ]);
      }

      // NOTE: We intentionally do NOT reset status="assembling" sessions here,
      // even when completedVideoId is null (i.e. assembly is mid-flight).
      // Resetting pre-CAS would kill a concurrent live assembler — Request 2 would
      // reset Request 1's lock, win the subsequent atomic CAS, and spawn a second
      // parallel assembly. Crash-recovery (status="assembling" left over from a
      // dead process) is handled below, after the CAS fails, using an age-gated
      // threshold (STALE_LOCK_THRESHOLD_MS).

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
            updatedAt: sessions.updatedAt,
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

        // Stale lock race: status="assembling" but no completedVideoId.
        //
        // There are two distinct cases:
        //   A. Genuinely stale: a prior finalize crashed before writing the
        //      video row. updatedAt is old (> STALE_LOCK_THRESHOLD_MS ago).
        //      → Safe to reset to "uploading" so the client can retry.
        //
        //   B. Active concurrent request: a concurrent /finalize call acquired
        //      the lock recently (status="assembling") and assembly is in
        //      progress. updatedAt is recent (< threshold).
        //      → Must NOT reset — doing so would kill the active assembler.
        //        Return 409 so the client polls finalize-status instead.
        //
        // Threshold: 30 minutes. A 2 GiB file assembled via the db_fallback
        // bytea-concat path can legitimately take 40+ minutes on Replit's
        // shared Neon DB; we also respect ASSEMBLY_WATCHDOG_MS (default 90 min)
        // as a hard upper bound. 30 minutes means: if no progress marker
        // (completedVideoId) appears within 30 min, the assembler is assumed
        // dead and the lock is released.
        if (refreshed?.status === "assembling" && !refreshed.completedVideoId) {
          const lockAgeMs = refreshed.updatedAt
            ? Date.now() - new Date(refreshed.updatedAt).getTime()
            : Infinity;
          // 30 minutes — safely below the 90-min ASSEMBLY_WATCHDOG_MS but long
          // enough that genuine large-file assemblies are never interrupted.
          const STALE_LOCK_THRESHOLD_MS = 30 * 60 * 1000;

          if (lockAgeMs > STALE_LOCK_THRESHOLD_MS) {
            // Case A: genuinely stale — reset and tell client to retry.
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
          // Case B: active concurrent assembly — tell client to poll.
          throw Object.assign(
            new Error(
              "Assembly is in progress for this session. " +
              "Poll GET /upload/:sessionId/finalize-status to check completion.",
            ),
            { statusCode: 409 },
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
              broadcastOnly: session.broadcastOnly ?? true,
              transcodingStatus: "none", // blob not yet committed; faststart + HLS pending
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

        // The video is queued for broadcast in the background task below,
        // immediately after completeMultipartUpload confirms the blob is fully
        // assembled in storage. No need to wait for faststart or HLS —
        // both upgrade the source in-place after the video is already on-air.

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
          // Assembly watchdog — if completeMultipartUpload hangs indefinitely
          // (TOAST bloat, DB lock, disk pressure), mark the video failed and
          // reset the session so the operator can retry from the upload panel
          // without waiting for a server restart. Default timeout is 4 hours
          // (ASSEMBLY_WATCHDOG_MS) to accommodate large 4K/long-form files on
          // slow storage I/O. Uses ASSEMBLY_FAILED (not CORRUPT_SOURCE) because
          // the blob state is unknown at watchdog-fire time — the file is
          // recoverable by retrying finalization from the upload panel.
          const assemblyWatchdog = setTimeout(() => {
            void (async () => {
              const watchdogElapsedMin = Math.round(env.ASSEMBLY_WATCHDOG_MS / 60_000);
              capturedLog.error(
                { sessionId, videoId, elapsed: `${watchdogElapsedMin}min` },
                "[finalize:bg] assembly watchdog fired — marking video failed, resetting session",
              );
              await Promise.allSettled([
                db
                  .update(videos)
                  .set({
                    transcodingStatus: "failed",
                    // ASSEMBLY_FAILED: blob state is unknown (assembly may still
                    // be running or may have been committed). Unlike CORRUPT_SOURCE
                    // this is recoverable — retrying finalization from the upload
                    // panel will either complete the assembly or restart it cleanly.
                    transcodingErrorCode: "ASSEMBLY_FAILED",
                    transcodingErrorMessage:
                      `Assembly watchdog timeout (${watchdogElapsedMin} min) — the blob was never fully assembled. ` +
                      "Reset the session from the upload panel and retry the upload.",
                  })
                  .where(eq(videos.id, videoId)),
                db
                  .update(sessions)
                  .set({ status: "uploading", completedVideoId: null, updatedAt: new Date() })
                  .where(eq(sessions.sessionId, sessionId)),
              ]);
              adminEventBus.push("videos-library-updated", { videoId, reason: "assembly-watchdog-timeout" });
              uploadTelemetry.serverFail(
                sessionId,
                session.sizeBytes,
                "assembly_watchdog_timeout",
                `Assembly watchdog timeout (${watchdogElapsedMin} min) — blob was never fully assembled.`,
              );
            })();
          }, env.ASSEMBLY_WATCHDOG_MS);
          // .unref() so this timer does not prevent Node from exiting on SIGTERM
          // while the watchdog is pending (the background assembly async task
          // will still run to completion on its own if the server stays up).
          assemblyWatchdog.unref();

          // Track whether completeMultipartUpload has committed the blob to
          // storage.  The catch block below deletes the blob to clean up
          // partial/failed assemblies — but if assembly already committed
          // (assemblyCommitted=true) the blob is intact and must NOT be
          // deleted, or the video row will point to a missing object.
          let assemblyCommitted = false;

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
            // Blob is now committed in storage_blobs.  Any exception thrown
            // after this point must NOT delete the object.
            assemblyCommitted = true;

            // ── Post-assembly blob integrity check ───────────────────────────
            // Verify that the assembled blob in storage_blobs actually has the
            // expected number of bytes before we let faststart or the transcoder
            // touch it.  A size mismatch means the assembly loop dropped a part
            // (e.g. a concurrent abortMultipartUpload orphaned a part row, or a
            // mid-loop Postgres connection failure silently aborted a part-append
            // UPDATE). Proceeding to transcode a truncated blob wastes the full
            // ffmpeg retry budget and produces a corrupt output.
            {
              const assembledHead = await storage().headObject(objectKey).catch(() => null);
              const expectedBytes = session.sizeBytes;
              const actualBytes = assembledHead?.contentLength ?? 0;
              if (!assembledHead?.exists || actualBytes !== expectedBytes) {
                capturedLog.error(
                  { sessionId, videoId, expectedBytes, actualBytes, blobExists: assembledHead?.exists ?? false },
                  "[finalize:bg] assembled blob size mismatch — marking video failed, resetting session for retry",
                );
                await Promise.allSettled([
                  db
                    .update(videos)
                    .set({
                      transcodingStatus: "failed",
                      transcodingErrorCode: "CORRUPT_SOURCE",
                      transcodingErrorMessage:
                        `Assembly integrity check failed: declared ${expectedBytes} bytes but assembled blob ` +
                        `is ${actualBytes} bytes. The upload may be incomplete — please retry finalization.`,
                    })
                    .where(eq(videos.id, videoId)),
                  db
                    .update(sessions)
                    .set({ status: "uploading", completedVideoId: null, updatedAt: new Date() })
                    .where(eq(sessions.sessionId, sessionId)),
                ]);
                adminEventBus.push("videos-library-updated", { videoId, reason: "assembly-size-mismatch" });
                uploadTelemetry.serverFail(
                  sessionId,
                  actualBytes,
                  "assembly_size_mismatch",
                  `Assembly integrity check failed: declared ${expectedBytes} bytes but assembled blob is ${actualBytes} bytes.`,
                );
                clearTimeout(assemblyWatchdog);
                return;
              }
            }

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
            // Wrap telemetry write: a DB failure here must not propagate to
            // the outer catch and trigger blob deletion — the blob is already
            // committed and the video row is valid.
            try {
              uploadTelemetry.success(sessionId, videoId, session.sizeBytes, Date.now() - assemblyStartMs);
            } catch (telErr) {
              capturedLog.warn(
                { err: telErr, sessionId },
                "[finalize:bg] telemetry success write failed (non-fatal — blob is intact)",
              );
            }

            // Reclaim chunk metadata rows (db-mode rows hold no BYTEA data).
            void db
              .delete(chunks)
              .where(eq(chunks.sessionId, sessionId))
              .catch((err: unknown) =>
                capturedLog.warn({ err, sessionId }, "[finalize:bg] chunk cleanup failed (non-fatal)"),
              );

            // Post-upload probes: thumbnail extraction + duration probe.
            // Must run BEFORE faststart because faststart replaces the blob.
            // Run sequentially (not in parallel) so only one source download
            // occupies /tmp at a time — parallel downloads would double the
            // peak disk usage (2× source size) on Replit's constrained /tmp.
            const clientDuration = Number(row.duration ?? "0");
            try {
              const thumbUrl = await generateQuickThumbnail(objectKey, videoId);

              // Fall back to the custom thumbnail that the client uploaded via
              // POST /upload/:sessionId/thumbnail when ffprobe-based auto-generation
              // is unavailable (ffprobe not installed) or returns null. The custom
              // thumbnail is stored at thumbnails/${sessionId}.jpg and served via
              // the /uploads/* wildcard route (which now resolves non-upload prefixes
              // correctly after the key-construction fix in video-serve.routes.ts).
              let effectiveThumbUrl = thumbUrl;
              if (!effectiveThumbUrl) {
                const customThumbKey = `thumbnails/${sessionId}.jpg`;
                try {
                  const customHead = await storage().headObject(customThumbKey);
                  if (customHead.exists) {
                    effectiveThumbUrl = `/api/v1/uploads/thumbnails/${sessionId}.jpg`;
                    capturedLog.info(
                      { videoId, sessionId, customThumbKey },
                      "[finalize:bg] auto-thumbnail unavailable — using custom uploaded thumbnail",
                    );
                  }
                } catch {
                  // Non-fatal: no custom thumbnail to fall back to.
                }
              }

              // Probe even when clientDuration > 0 if it equals the well-known
              // 1800-second upload-time placeholder.  The admin upload client
              // sends duration=1800 as a default when the real length is
              // unknown; treating that as a real duration permanently skips
              // ffprobe and leaves the broadcast_queue row at 1800 s, which
              // causes dead-air gaps when the video ends before its slot expires.
              const probedSecs =
                (clientDuration > 0 && clientDuration !== 1800) ? null
                  : await probeUploadedDuration(objectKey);
              const patch: Partial<typeof videos.$inferInsert> = {};
              if (effectiveThumbUrl) patch.thumbnailUrl = effectiveThumbUrl;
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
            // faststart.service.ts replaces the source blob via a multipart
            // re-upload. If the transcoder downloads the source while that
            // assembly is still in progress it fetches a partial file and
            // ffprobe reports "moov atom not found", killing the transcode job.
            //
            // faststart now also runs a container pre-flight probe and attempts
            // a stream-copy remux repair for files with moov-at-EOF or mild
            // container damage. If the container is totally unrepairable,
            // faststart throws with code="CORRUPT_UPLOAD" — we mark the video
            // "failed" immediately rather than cycling through 3 transcoder
            // retries against an unreadable file.
            //
            // EARLY GATE: probeUploadedContainerValidity runs before faststart
            // so that files with missing moov atoms are caught here rather than
            // falling through the DOWNLOAD_TRUNCATED bypass in faststart.service.ts
            // (which previously let corrupt uploads reach the HLS transcoder and
            // fail there after 3 expensive retry cycles).
            let skipTranscodeEnqueue = false;
            try {
              const containerProbe = await probeUploadedContainerValidity(objectKey);
              if (!containerProbe.valid) {
                if (containerProbe.unrecoverable === true) {
                  // Moov atom is completely absent or file failed pre-flight —
                  // no remux strategy can recover this. Mark failed immediately
                  // so the operator knows to re-upload the original source file.
                  capturedLog.error(
                    { videoId, objectKey, kind: containerProbe.kind },
                    "[finalize:bg] EARLY CORRUPT GATE (unrecoverable) — container probe confirmed " +
                    "no moov atom or invalid file type; marking failed before faststart.",
                  );
                  skipTranscodeEnqueue = true;
                  await db
                    .update(videos)
                    .set({
                      transcodingStatus: "failed",
                      transcodingErrorCode: "CORRUPT_SOURCE",
                      transcodingErrorMessage: containerProbe.error ??
                        "Upload rejected: the video file is unrecoverable " +
                        "(moov atom absent or invalid file type). " +
                        "Please re-upload from the original source file.",
                    })
                    .where(eq(videos.id, videoId))
                    .catch(() => {});
                  adminEventBus.push("videos-library-updated", { videoId, reason: "corrupt-upload-early-gate" });
                  void quarantineVideo(videoId, {
                    errorCode: "CORRUPT_SOURCE",
                    reason:
                      containerProbe.error ??
                      "Upload rejected at early gate: moov atom absent or invalid file type.",
                    triggeredBy: "finalize-early-gate",
                    metadata: { objectKey, kind: containerProbe.kind },
                  });
                } else {
                  // Container is mildly damaged but moov is not confirmed absent —
                  // faststart's remux strategies (including error-tolerant copy and
                  // fMP4 output) may recover it. Log a warning and let faststart run.
                  capturedLog.warn(
                    { videoId, objectKey, kind: containerProbe.kind },
                    "[finalize:bg] container probe soft-fail — allowing faststart remux to attempt repair.",
                  );
                }
              }
            } catch (earlyGateErr) {
              capturedLog.warn(
                { err: earlyGateErr, videoId },
                "[finalize:bg] early container gate probe failed (non-fatal) — proceeding to faststart",
              );
            }

            // ── Immediate broadcast queue entry ─────────────────────────────
            // Queue the video right after the raw file is confirmed valid and
            // accessible in storage — no need to wait for faststart or HLS.
            // Faststart re-uploads an optimised file to the same storage key;
            // HLS transcoding produces a separate manifest URL. Both upgrade
            // the broadcast source in-place without a re-queue.
            // Skipped for confirmed corrupt/unrepairable uploads.
            if (!skipTranscodeEnqueue) {
              try {
                const enqueueResult = await enqueueIfMissing({ videoId, reason: "upload-finalize" });
                if (enqueueResult.enqueued) {
                  capturedLog.info(
                    { videoId, queueItemId: enqueueResult.queueItemId },
                    "[finalize:bg] video auto-queued for broadcast immediately after assembly",
                  );
                } else {
                  capturedLog.info(
                    { videoId, queueItemId: enqueueResult.queueItemId },
                    "[finalize:bg] video already in broadcast queue — skipping duplicate insert",
                  );
                }
                // Always emit broadcast-queue-updated so the admin UI refreshes —
                // whether the video was freshly enqueued or was already present.
                // This guarantees the queue panel shows current state even when the
                // SSE connection was down during the background assembly window.
                adminEventBus.push("broadcast-queue-updated", { reason: "upload-finalize", videoId });
              } catch (enqErr) {
                capturedLog.warn({ err: enqErr, videoId }, "[finalize:bg] immediate enqueueIfMissing failed (non-fatal)");
                // Emit broadcast-queue-updated even on failure so clients
                // reload the queue and see the accurate server-side state.
                adminEventBus.push("broadcast-queue-updated", { reason: "upload-finalize-enqueue-failed", videoId });
              }
            }

            if (!skipTranscodeEnqueue) {
              try {
                await runFaststart(videoId, objectKey, { skipStatusUpdate: false });
                capturedLog.info({ sessionId, videoId }, "[finalize:bg] faststart done");
              } catch (err) {
                const isCorrupt = (err as { code?: string })?.code === "CORRUPT_UPLOAD";
                if (isCorrupt) {
                  capturedLog.error(
                    { err, videoId, objectKey },
                    "[finalize:bg] CORRUPT UPLOAD — container structurally damaged and unrepairable. " +
                    "Marking video failed. Operator must re-upload the file.",
                  );
                  skipTranscodeEnqueue = true;
                  await db
                    .update(videos)
                    .set({
                      transcodingStatus: "failed",
                      transcodingErrorCode: "CORRUPT_SOURCE",
                      transcodingErrorMessage:
                        "Upload failed: the video container is structurally damaged and cannot be repaired " +
                        "(faststart failed — moov atom missing or all remux strategies exhausted). " +
                        "Please re-upload from the original source file.",
                    })
                    .where(eq(videos.id, videoId))
                    .catch(() => {});
                  // Immediately deactivate the broadcast queue entry created by
                  // enqueueIfMissing above.  Without this the row stays is_active=true
                  // (but excluded by loadActive's transcodingStatus filter) until the
                  // queue-integrity-validator runs (up to 3 min), leaving a zombie
                  // entry visible in the admin queue panel and keeping it in the
                  // orchestrator's in-memory set until the next reload.
                  await db
                    .update(schema.broadcastQueueTable)
                    .set({ isActive: false })
                    .where(eq(schema.broadcastQueueTable.videoId, videoId))
                    .catch(() => {});
                  adminEventBus.push("videos-library-updated", { videoId, reason: "corrupt-upload-failed" });
                  // Reload the orchestrator immediately so the dead item is evicted
                  // from the active set rather than waiting for an unrelated event.
                  adminEventBus.push("broadcast-queue-updated", { reason: "corrupt-upload-faststart-cleanup", videoId });
                  void quarantineVideo(videoId, {
                    errorCode: "CORRUPT_SOURCE",
                    reason:
                      "Faststart failed: video container is structurally damaged and unrepairable " +
                      "(moov atom missing or all remux strategies exhausted). Re-upload required.",
                    triggeredBy: "faststart-failure",
                    metadata: { objectKey, sessionId },
                  });
                } else {
                  capturedLog.warn({ err, videoId }, "[finalize:bg] faststart failed (non-fatal)");
                }
              }
            }

            // Enqueue HLS transcoding AFTER faststart is complete.
            // Skipped when the container is confirmed unrepairable (CORRUPT_UPLOAD or early gate)
            // to avoid wasting transcoder retry cycles on a permanently broken file.
            if (!skipTranscodeEnqueue) {
              try {
                await enqueueTranscode({ videoId, videoPath: objectKey });
                capturedLog.info({ sessionId, videoId }, "[finalize:bg] HLS transcode job queued");
                // Immediately wake the dispatcher so encoding starts within
                // milliseconds rather than waiting for the next poll tick
                // (up to TRANSCODER_POLL_MS = 10 s). This eliminates the
                // visible "HLS queued" window in the broadcast queue UI.
                // Guard: nudge() is a no-op when the dispatcher was never
                // started (TRANSCODER_DISABLE=1), but we also check here as
                // belt-and-suspenders so grep can confirm the call site is safe.
                if (!env.TRANSCODER_DISABLE) transcoderDispatcher.nudge();
              } catch (err) {
                capturedLog.warn(
                  { err, videoId },
                  "[finalize:bg] enqueueTranscode failed (non-fatal) — faststart-applied video is still broadcast-ready",
                );
              }
            }

            capturedLog.info(
              { sessionId, videoId, totalMs: Date.now() - assemblyStartMs },
              "[finalize:bg] all post-processing complete",
            );
            clearTimeout(assemblyWatchdog);
          } catch (err) {
            clearTimeout(assemblyWatchdog);
            // Assembly failed — mark the video as failed and reset the session
            // to "uploading" so the operator can retry from the upload queue.
            capturedLog.error(
              { err, sessionId, videoId, assemblyMs: Date.now() - assemblyStartMs },
              "[finalize:bg] ASSEMBLY FAILED — resetting session, marking video failed",
            );
            // Best-effort orphan cleanup: if completeMultipartUpload threw
            // (assemblyCommitted=false) a partially-assembled blob may remain
            // at the final key.  Delete it so the storage GC doesn't carry it
            // for 4 h and the next finalize retry starts from a clean slate.
            //
            // CRITICAL: skip deletion when assemblyCommitted=true.  That flag
            // means completeMultipartUpload already committed the blob — the
            // exception was thrown by a later step (e.g. telemetry write) and
            // the video row still references this object.  Deleting it here
            // would make the video permanently unrecoverable.
            if (!assemblyCommitted && session.objectKey) {
              capturedLog.warn(
                { sessionId, videoId, objectKey: session.objectKey },
                "[finalize:bg] deleting uncommitted partial assembly blob",
              );
              void storage().deleteObject(session.objectKey).catch(() => {});
            } else if (assemblyCommitted && session.objectKey) {
              capturedLog.error(
                { sessionId, videoId, objectKey: session.objectKey },
                "[finalize:bg] assembly committed but a later step threw — blob is PRESERVED; video row intact",
              );
            }
            // Error code selection:
            //   assemblyCommitted=false → ASSEMBLY_FAILED: the blob is absent or
            //     partial; session is reset to 'uploading' so operator can retry
            //     finalization from the upload panel (recoverable).
            //   assemblyCommitted=true  → CORRUPT_SOURCE: the blob committed
            //     successfully but a post-assembly step threw (e.g. a DB write).
            //     The blob is intact but the video row may be in an inconsistent
            //     state; use CORRUPT_SOURCE to signal the validator to auto-deactivate
            //     this queue item until an operator investigates.
            await Promise.allSettled([
              db
                .update(videos)
                .set({
                  transcodingStatus: "failed",
                  transcodingErrorCode: assemblyCommitted ? "CORRUPT_SOURCE" : "ASSEMBLY_FAILED",
                  transcodingErrorMessage: assemblyCommitted
                    ? `A post-assembly step failed after ${Date.now() - assemblyStartMs} ms — ` +
                      "the blob is intact but the video may need operator review. " +
                      "Check logs for the specific error."
                    : `Assembly failed after ${Date.now() - assemblyStartMs} ms — ` +
                      "the blob was not committed. Reset the session from the " +
                      "upload panel and retry the upload to recover.",
                })
                .where(eq(videos.id, videoId)),
              db
                .update(sessions)
                .set({ status: "uploading", completedVideoId: null, updatedAt: new Date() })
                .where(eq(sessions.sessionId, sessionId)),
            ]);
            // Invalidate the server-side public catalog cache so TV/mobile
            // clients don't continue to see this video as "queued" for the
            // full cache TTL after it has been marked "failed".
            void invalidateVideosCatalogCache();
            adminEventBus.push("videos-library-updated", { videoId, reason: "assembly-failed" });
            uploadTelemetry.serverFail(
              sessionId,
              session.sizeBytes,
              "assembly_failed",
              err instanceof Error ? err.message : "Assembly failed",
            );
          }
        })();

        return {
          ...projectRow(row),
          storageBackend: "db" as const,
          transcodingWarning: null,
        };
      }

      // ── Path B: "db_fallback" backend — async pre-commit (same pattern as Path A) ──
      //
      // db_fallback is active when init's createMultipartUpload failed. Chunks are
      // stored as BYTEA in upload_chunks.fallback_data. We follow the same
      // pre-commit → background-assembly pattern as Path A so finalize returns
      // immediately regardless of storage backend.
      //
      // objectKey is null on the session row for db_fallback. Compute it now
      // using the same deterministic formula as finalizeFromDbFallback, then
      // persist it so the background task uses the same key even if midnight
      // rolls over between pre-commit and assembly.
      const now = new Date();
      const safeExtB = (() => {
        const fnExt = session.originalFilename
          ? (session.originalFilename.split(".").pop() ?? "").toLowerCase()
          : "";
        if (/^(mp4|mov|mkv|avi|webm|m4v|flv|wmv|ts|mts|m2ts)$/.test(fnExt)) return fnExt;
        const mime = (session.mimeType ?? session.contentType ?? "").toLowerCase();
        if (mime.includes("webm")) return "webm";
        if (mime.includes("quicktime") || mime.includes("mov")) return "mov";
        if (mime.includes("x-matroska") || mime.includes("mkv")) return "mkv";
        if (mime.includes("x-msvideo") || mime.includes("avi")) return "avi";
        return "mp4";
      })();
      const fallbackObjectKey =
        session.objectKey ??
        `uploads/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${String(now.getUTCDate()).padStart(2, "0")}/${session.sessionId}.${safeExtB}`;
      const fallbackVideoUrl = storage().publicUrl(fallbackObjectKey);
      const durationSecsB =
        session.durationSecs && session.durationSecs > 0
          ? Math.round(session.durationSecs)
          : 1800;

      const videoIdB = randomUUID();
      let insertedB: (typeof videos.$inferSelect)[];
      try {
        insertedB = await db
          .insert(videos)
          .values({
            id: videoIdB,
            youtubeId: null,
            title: session.title,
            description: session.description ?? "",
            thumbnailUrl: "",
            duration: String(durationSecsB),
            category: session.category ?? "sermon",
            preacher: session.preacher ?? "",
            publishedAt: null,
            videoSource: "local",
            localVideoUrl: fallbackVideoUrl,
            featured: session.featured,
            originalFilename: session.originalFilename ?? null,
            mimeType: session.mimeType ?? null,
            sizeBytes: session.sizeBytes,
            objectPath: fallbackObjectKey,
            uploadedBy: session.uploadedBy ?? null,
            s3MirroredAt: null,
            broadcastOnly: session.broadcastOnly ?? true,
            transcodingStatus: "none", // blob not yet committed; faststart + HLS pending
          })
          .returning();
      } catch (insertErr) {
        await resetLock();
        req.log.error(
          { err: insertErr, sessionId, videoId: videoIdB },
          "[finalize:db_fallback] video INSERT failed — lock released",
        );
        throw Object.assign(
          new Error("Failed to create video record. The upload is safe — please retry finalization."),
          { statusCode: 500, cause: insertErr },
        );
      }

      const rowB = insertedB[0];
      if (!rowB) {
        await resetLock();
        throw new Error("videos insert returned no rows");
      }

      // Persist the pre-agreed objectKey + pre-committed videoId so the
      // idempotency check and finalize-status poll work correctly during
      // background assembly, and so the background task uses the same key
      // even if midnight rolls over before assembly starts.
      try {
        await db
          .update(sessions)
          .set({ completedVideoId: videoIdB, objectKey: fallbackObjectKey, updatedAt: new Date() })
          .where(eq(sessions.sessionId, sessionId));
      } catch (updateErr) {
        req.log.warn(
          { err: updateErr, sessionId, videoId: videoIdB },
          "[finalize:db_fallback] completedVideoId update failed (non-fatal)",
        );
      }

      void invalidateVideosCatalogCache();
      try { broadcastEngine.pushSnapshot(); } catch { /* non-fatal */ }
      adminEventBus.push("videos-library-updated", { videoId: videoIdB, reason: "upload-precommitted" });

      req.log.info(
        { sessionId, videoId: videoIdB, chunks: allChunks.length },
        "[finalize:db_fallback] pre-committed ok — background assembly starting",
      );

      // ── Background db_fallback assembly + post-processing ─────────────────
      const capturedLogB = req.log;
      const sessionForAssembly = { ...session, objectKey: fallbackObjectKey };
      const assemblyStartMsB = Date.now();

      void (async () => {
        // Assembly watchdog (db_fallback path) — same rationale as Path A:
        // uses env.ASSEMBLY_WATCHDOG_MS (default 4 h) and emits ASSEMBLY_FAILED
        // (not CORRUPT_SOURCE) because the blob state is unknown at fire time.
        const watchdogB = setTimeout(() => {
          void (async () => {
            const watchdogElapsedMinB = Math.round(env.ASSEMBLY_WATCHDOG_MS / 60_000);
            capturedLogB.error(
              { sessionId, videoId: videoIdB, elapsed: `${watchdogElapsedMinB}min` },
              "[finalize:db_fallback:bg] assembly watchdog fired — marking failed, resetting session",
            );
            await Promise.allSettled([
              db
                .update(videos)
                .set({
                  transcodingStatus: "failed",
                  transcodingErrorCode: "ASSEMBLY_FAILED",
                  transcodingErrorMessage:
                    `Assembly watchdog timeout (${watchdogElapsedMinB} min) — the blob was never fully assembled. ` +
                    "Reset the session from the upload panel and retry the upload.",
                })
                .where(eq(videos.id, videoIdB)),
              db
                .update(sessions)
                .set({ status: "uploading", completedVideoId: null, updatedAt: new Date() })
                .where(eq(sessions.sessionId, sessionId)),
            ]);
            adminEventBus.push("videos-library-updated", { videoId: videoIdB, reason: "assembly-watchdog-timeout" });
            uploadTelemetry.serverFail(
              sessionId,
              session.sizeBytes,
              "assembly_watchdog_timeout",
              `Assembly watchdog timeout (${watchdogElapsedMinB} min) — blob was never fully assembled.`,
            );
          })();
        }, env.ASSEMBLY_WATCHDOG_MS);
        // .unref() so this timer does not prevent Node from exiting on SIGTERM
        // while the watchdog is pending.
        watchdogB.unref();

        try {
          const result = await finalizeFromDbFallback(sessionForAssembly, allChunks.length, capturedLogB);
          clearTimeout(watchdogB);

          // ── Post-assembly blob integrity check (Path B / db_fallback) ────
          // Mirror Path A: verify the assembled blob in storage_blobs has the
          // declared file size before allowing faststart or transcoding to run.
          // A mismatch here means the db_fallback multipart assembly dropped one
          // or more chunks — proceeding would produce a truncated video file.
          {
            const assembledHeadB = await storage().headObject(result.objectKey).catch(() => null);
            const expectedBytesB = session.sizeBytes;
            const actualBytesB = assembledHeadB?.contentLength ?? 0;
            if (!assembledHeadB?.exists || actualBytesB !== expectedBytesB) {
              capturedLogB.error(
                { sessionId, videoId: videoIdB, expectedBytes: expectedBytesB, actualBytes: actualBytesB, blobExists: assembledHeadB?.exists ?? false },
                "[finalize:db_fallback:bg] assembled blob size mismatch — marking video failed, resetting session for retry",
              );
              await Promise.allSettled([
                db
                  .update(videos)
                  .set({
                    transcodingStatus: "failed",
                    transcodingErrorCode: "CORRUPT_SOURCE",
                    transcodingErrorMessage:
                      `Assembly integrity check failed: declared ${expectedBytesB} bytes but assembled blob ` +
                      `is ${actualBytesB} bytes. The upload may be incomplete — please retry finalization.`,
                  })
                  .where(eq(videos.id, videoIdB)),
                db
                  .update(sessions)
                  .set({ status: "uploading", completedVideoId: null, updatedAt: new Date() })
                  .where(eq(sessions.sessionId, sessionId)),
              ]);
              adminEventBus.push("videos-library-updated", { videoId: videoIdB, reason: "assembly-size-mismatch" });
              uploadTelemetry.serverFail(
                sessionId,
                actualBytesB,
                "assembly_size_mismatch",
                `Assembly integrity check failed: declared ${expectedBytesB} bytes but assembled blob is ${actualBytesB} bytes.`,
              );
              return;
            }
          }

          const assemblyMsB = Date.now() - assemblyStartMsB;
          capturedLogB.info(
            { sessionId, videoId: videoIdB, assemblyMsB },
            "[finalize:db_fallback:bg] assembly done",
          );

          await Promise.all([
            db
              .update(sessions)
              .set({ status: "completed", storageBackend: result.storageBackend, updatedAt: new Date() })
              .where(eq(sessions.sessionId, sessionId))
              .catch((err: unknown) =>
                capturedLogB.warn({ err, sessionId }, "[finalize:db_fallback:bg] session completed update failed (non-fatal)"),
              ),
            db
              .update(videos)
              .set({ s3MirroredAt: new Date(), localVideoUrl: result.localVideoUrl, objectPath: result.objectKey })
              .where(eq(videos.id, videoIdB))
              .catch(() => {}),
          ]);

          // Reclaim BYTEA chunk rows now that the blob is fully assembled.
          void db
            .delete(chunks)
            .where(eq(chunks.sessionId, sessionId))
            .catch((err: unknown) =>
              capturedLogB.warn({ err, sessionId }, "[finalize:db_fallback:bg] chunk cleanup failed (non-fatal)"),
            );

          // Post-upload probes: thumbnail + duration.
          // Must run BEFORE faststart because faststart replaces the blob.
          // Run SEQUENTIALLY (not in parallel) so only one source download
          // occupies /tmp at a time — parallel downloads double peak disk
          // usage on constrained environments. This mirrors Path A's explicit
          // sequential design documented at the same step above.
          const clientDurationB = Number(rowB.duration ?? "0");
          try {
            const thumbUrlB = await generateQuickThumbnail(result.objectKey, videoIdB);
            // Mirror Path A: probe even when clientDurationB > 0 if it equals
            // the 1800-second placeholder so db_fallback uploads also get
            // a real ffprobe duration instead of a permanent placeholder.
            const probedSecsB = (clientDurationB > 0 && clientDurationB !== 1800)
              ? null
              : await probeUploadedDuration(result.objectKey);
            const patchB: Partial<typeof videos.$inferInsert> = {};
            if (thumbUrlB) patchB.thumbnailUrl = thumbUrlB;
            if (probedSecsB != null) patchB.duration = String(Math.round(probedSecsB));
            if (Object.keys(patchB).length > 0) {
              await db.update(videos).set(patchB).where(eq(videos.id, videoIdB));
              void invalidateVideosCatalogCache();
              adminEventBus.push("videos-library-updated", { videoId: videoIdB, reason: "thumbnail-generated" });
            }
            if (probedSecsB != null && probedSecsB > 10) {
              await db
                .update(schema.broadcastQueueTable)
                .set({ durationSecs: Math.round(probedSecsB) })
                .where(eq(schema.broadcastQueueTable.videoId, videoIdB))
                .catch(() => {});
            }
          } catch (err) {
            capturedLogB.warn({ err, videoId: videoIdB }, "[finalize:db_fallback:bg] post-upload probes failed (non-fatal)");
          }

          // ── Early container gate (Path B) ────────────────────────────────
          // Mirror Path A: run probeUploadedContainerValidity before faststart
          // so that structurally corrupt db_fallback uploads are caught here
          // rather than burning 3 transcoder retry cycles against a broken file.
          let skipTranscodeEnqueueB = false;
          try {
            const containerProbeB = await probeUploadedContainerValidity(result.objectKey);
            if (!containerProbeB.valid) {
              if (containerProbeB.unrecoverable === true) {
                // Moov atom is completely absent or file failed pre-flight —
                // no remux strategy can recover this. Mark failed immediately.
                capturedLogB.error(
                  { videoId: videoIdB, objectKey: result.objectKey, kind: containerProbeB.kind },
                  "[finalize:db_fallback:bg] EARLY CORRUPT GATE (unrecoverable) — container probe confirmed " +
                  "no moov atom or invalid file type; marking failed before faststart.",
                );
                skipTranscodeEnqueueB = true;
                await db
                  .update(videos)
                  .set({
                    transcodingStatus: "failed",
                    transcodingErrorCode: "CORRUPT_SOURCE",
                    transcodingErrorMessage: containerProbeB.error ??
                      "Upload rejected: the video file is unrecoverable " +
                      "(moov atom absent or invalid file type). " +
                      "Please re-upload from the original source file.",
                  })
                  .where(eq(videos.id, videoIdB))
                  .catch(() => {});
                adminEventBus.push("videos-library-updated", { videoId: videoIdB, reason: "corrupt-upload-early-gate" });
              } else {
                // Mildly damaged container — faststart remux may recover it.
                capturedLogB.warn(
                  { videoId: videoIdB, objectKey: result.objectKey, kind: containerProbeB.kind },
                  "[finalize:db_fallback:bg] container probe soft-fail — allowing faststart remux to attempt repair.",
                );
              }
            }
          } catch (earlyGateBErr) {
            capturedLogB.warn(
              { err: earlyGateBErr, videoId: videoIdB },
              "[finalize:db_fallback:bg] early container gate probe failed (non-fatal) — proceeding to faststart",
            );
          }

          // ── Immediate broadcast queue entry (Path B) ─────────────────────
          // Queue the video right after the blob is assembled and validated —
          // no need to wait for faststart or HLS.  Matches Path A behaviour:
          // faststart upgrades the source in-place; HLS adds a separate URL.
          // Skipped for confirmed corrupt/unrepairable uploads.
          //
          // IMPORTANT: this call must happen BEFORE runFaststart.  faststart
          // sets transcodingStatus='processing' while it swaps the blob, which
          // temporarily blocks the item in loadActive().  If faststart then
          // fails non-fatally (no ffmpeg, network hiccup), enqueueIfMissing
          // inside faststart.service never runs and the video would never be
          // queued.  Calling it here ensures the item is queued regardless.
          if (!skipTranscodeEnqueueB) {
            try {
              const enqueueResultB = await enqueueIfMissing({ videoId: videoIdB, reason: "upload-finalize" });
              if (enqueueResultB.enqueued) {
                capturedLogB.info(
                  { videoId: videoIdB, queueItemId: enqueueResultB.queueItemId },
                  "[finalize:db_fallback:bg] video auto-queued for broadcast immediately after assembly",
                );
              } else {
                capturedLogB.info(
                  { videoId: videoIdB, queueItemId: enqueueResultB.queueItemId },
                  "[finalize:db_fallback:bg] video already in broadcast queue — skipping duplicate insert",
                );
              }
              // Always emit regardless of enqueued boolean — the admin UI needs
              // to refresh whether the video was freshly queued or already present.
              adminEventBus.push("broadcast-queue-updated", { reason: "upload-finalize", videoId: videoIdB });
            } catch (enqErrB) {
              capturedLogB.warn(
                { err: enqErrB, videoId: videoIdB },
                "[finalize:db_fallback:bg] immediate enqueueIfMissing failed (non-fatal)",
              );
              // Emit even on failure so clients reload the queue.
              adminEventBus.push("broadcast-queue-updated", { reason: "upload-finalize-enqueue-failed", videoId: videoIdB });
            }
          }

          // Faststart MUST complete before enqueueTranscode (see Path A rationale).
          // CORRUPT_UPLOAD errors are handled the same way as Path A: mark failed,
          // deactivate the broadcast-queue entry, and skip transcode enqueue to
          // avoid pointless retry cycles. Without the queue deactivation the item
          // stays is_active=true and the orchestrator keeps trying to play it.
          try {
            await runFaststart(videoIdB, result.objectKey, { skipStatusUpdate: false });
            capturedLogB.info({ sessionId, videoId: videoIdB }, "[finalize:db_fallback:bg] faststart done");
          } catch (err) {
            const isCorruptB = (err as { code?: string })?.code === "CORRUPT_UPLOAD";
            if (isCorruptB) {
              capturedLogB.error(
                { err, videoId: videoIdB, objectKey: result.objectKey },
                "[finalize:db_fallback:bg] CORRUPT UPLOAD — container structurally damaged and unrepairable. " +
                "Marking video failed. Operator must re-upload the file.",
              );
              skipTranscodeEnqueueB = true;
              await db
                .update(videos)
                .set({
                  transcodingStatus: "failed",
                  transcodingErrorCode: "CORRUPT_SOURCE",
                  transcodingErrorMessage:
                    "Upload failed: the video container is structurally damaged and cannot be repaired " +
                    "(faststart failed — moov atom missing or all remux strategies exhausted). " +
                    "Please re-upload from the original source file.",
                })
                .where(eq(videos.id, videoIdB))
                .catch(() => {});
              // Immediately deactivate the broadcast queue entry created by
              // enqueueIfMissing above so the orchestrator stops trying to play
              // this corrupt item on the next reload cycle. Without this step
              // the row stays is_active=true and the orchestrator keeps loading
              // it — burning skip budget every cycle — until the queue-integrity-
              // validator runs (up to 3 min). This mirrors Path A's identical fix.
              await db
                .update(schema.broadcastQueueTable)
                .set({ isActive: false })
                .where(eq(schema.broadcastQueueTable.videoId, videoIdB))
                .catch(() => {});
              adminEventBus.push("videos-library-updated", { videoId: videoIdB, reason: "corrupt-upload-failed" });
              adminEventBus.push("broadcast-queue-updated", { reason: "corrupt-upload-faststart-cleanup", videoId: videoIdB });
            } else {
              capturedLogB.warn({ err, videoId: videoIdB }, "[finalize:db_fallback:bg] faststart failed (non-fatal)");
            }
          }

          if (!skipTranscodeEnqueueB) {
            try {
              await enqueueTranscode({ videoId: videoIdB, videoPath: result.objectKey });
              if (!env.TRANSCODER_DISABLE) transcoderDispatcher.nudge();
              capturedLogB.info({ sessionId, videoId: videoIdB }, "[finalize:db_fallback:bg] HLS transcode job queued");
            } catch (err) {
              capturedLogB.warn(
                { err, videoId: videoIdB },
                "[finalize:db_fallback:bg] enqueueTranscode failed (non-fatal)",
              );
            }
          }

          capturedLogB.info(
            { sessionId, videoId: videoIdB, totalMs: Date.now() - assemblyStartMsB },
            "[finalize:db_fallback:bg] all post-processing complete",
          );
        } catch (err) {
          clearTimeout(watchdogB);
          const assemblyFailedMs = Date.now() - assemblyStartMsB;
          capturedLogB.error(
            { err, sessionId, videoId: videoIdB, assemblyMs: assemblyFailedMs },
            "[finalize:db_fallback:bg] ASSEMBLY FAILED — resetting session, marking video failed",
          );
          // db_fallback path: the blob is assembled inline (not via
          // completeMultipartUpload) so a catch here means the blob was
          // never fully written — always use ASSEMBLY_FAILED (recoverable).
          await Promise.allSettled([
            db
              .update(videos)
              .set({
                transcodingStatus: "failed",
                transcodingErrorCode: "ASSEMBLY_FAILED",
                transcodingErrorMessage:
                  `Assembly failed after ${assemblyFailedMs} ms — ` +
                  "the blob was not committed. Reset the session from the " +
                  "upload panel and retry the upload to recover.",
              })
              .where(eq(videos.id, videoIdB)),
            db
              .update(sessions)
              .set({ status: "uploading", completedVideoId: null, updatedAt: new Date() })
              .where(eq(sessions.sessionId, sessionId)),
          ]);
          // Record server-side telemetry for this db_fallback assembly failure so
          // the S3 telemetry dashboard captures it alongside Path A failures.
          // Mirrors the identical call in Path A's outer catch block.
          uploadTelemetry.serverFail(
            sessionId,
            session.sizeBytes,
            "assembly_failed",
            err instanceof Error ? err.message : "db_fallback assembly failed",
          );
          // Invalidate the server-side public catalog cache so TV/mobile
          // clients don't continue to see this video as "queued" for the
          // full cache TTL after it has been marked "failed".
          void invalidateVideosCatalogCache();
          adminEventBus.push("videos-library-updated", { videoId: videoIdB, reason: "assembly-failed" });
        }
      })();

      return {
        ...projectRow(rowB),
        storageBackend: "db" as const,
        transcodingWarning: null,
      };
    },
  );

  // ── GET /videos/upload/:sessionId/finalize-status ────────────────────────
  // Lightweight polling endpoint — no auth required beyond the session ID being
  // a secret UUID. Returns the assembly state so the client can detect
  // completion even after a finalize fetch timed out or disconnected.
  //
  // When status="assembling", assemblyPercent is derived by comparing the
  // current size_bytes of the dest blob in storage_blobs against the total
  // file size stored in the session. The iterative PostgreSQL bytea-concat
  // loop grows the dest row's size_bytes column by one part on every UPDATE,
  // so this gives an accurate real-time assembly percentage (0–99).
  r.get(
    "/videos/upload/:sessionId/finalize-status",
    {
      preHandler: requireAuth("editor"),
      // Client polls every 2 s during assembly. 60/min covers 3 concurrent
      // uploads + generous headroom for tab-restore reconnects and retries.
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },      schema: {
        tags: ["uploads"],
        summary: "Poll the finalization status of an upload session",
        params: z.object({ sessionId: z.string().min(1).max(128) }),
        response: {
          200: z.object({
            status: z.enum(["uploading", "assembling", "completed", "not_found"]),
            videoId: z.string().nullable(),
            /** Real assembly progress 0–99 derived from storage_blobs.size_bytes.
             *  Null when status is not "assembling", when objectKey is unavailable
             *  (db_fallback mode), or when the storage query fails. */
            assemblyPercent: z.number().nullable(),
          }),
          429: z.object({ error: z.string() }),
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
          objectKey: sessions.objectKey,
          sizeBytes: sessions.sizeBytes,
        })
        .from(sessions)
        .where(eq(sessions.sessionId, sessionId))
        .limit(1)
        .then((r) => r[0]);

      if (!session) {
        return { status: "not_found" as const, videoId: null, assemblyPercent: null };
      }

      const st = session.status as string;
      if (st === "completed") {
        return { status: "completed" as const, videoId: session.completedVideoId ?? null, assemblyPercent: null };
      }
      if (st === "assembling") {
        // Return completedVideoId even during assembly — the async-finalize path
        // pre-commits the video row and stores its id before background assembly
        // starts, so the client can obtain the video id without waiting for the
        // full assembly to finish.
        //
        // Derive real assembly percentage from the dest blob's current size.
        // Non-fatal: if the query fails or objectKey is null (db_fallback mode
        // that hasn't run completeMultipartUpload yet), assemblyPercent stays null
        // and the client falls back to its fake-tick progress animation.
        let assemblyPercent: number | null = null;
        if (session.objectKey && session.sizeBytes > 0) {
          try {
            type BlobRow = { size_bytes: string | number };
            const blobResult = await db.execute<BlobRow>(
              sql`SELECT size_bytes FROM storage_blobs WHERE key = ${session.objectKey} LIMIT 1`,
            );
            const rows = (blobResult as unknown as { rows?: BlobRow[] }).rows ?? (blobResult as unknown as BlobRow[]);
            const currentBytes = Number(rows[0]?.size_bytes ?? 0);
            if (currentBytes > 0) {
              assemblyPercent = Math.max(1, Math.min(99, Math.round((currentBytes / session.sizeBytes) * 100)));
            }
          } catch {
            // Non-fatal: storage query failed, client keeps fake-tick animation.
          }
        }
        return { status: "assembling" as const, videoId: session.completedVideoId ?? null, assemblyPercent };
      }
      return { status: "uploading" as const, videoId: null, assemblyPercent: null };
    },
  );

  // ── POST /videos/upload/retry-assembly/:videoId ───────────────────────────
  // Admin-initiated retry for videos stuck in ASSEMBLY_FAILED state.
  // Finds the upload session via completedVideoId, counts whether all chunks
  // are still present, and re-spawns a background assembly task if they are.
  //
  // Returns:
  //   200 { canRetry: true,  message: string } — retry spawned
  //   200 { canRetry: false, message: string } — cannot retry (re-upload required)
  //   404                                       — video not found
  r.post(
    "/videos/upload/retry-assembly/:videoId",
    {
      schema: {
        tags: ["uploads"],
        params: z.object({ videoId: z.string().uuid() }),
        response: {
          200: z.object({ canRetry: z.boolean(), message: z.string() }),
          404: z.object({ error: z.string() }),
          429: z.object({ error: z.string() }),
        },
      },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { videoId } = req.params;

      // Find the video row and verify it is in ASSEMBLY_FAILED state.
      const [vRow] = await db
        .select({
          id: videos.id,
          transcodingStatus: videos.transcodingStatus,
          transcodingErrorCode: videos.transcodingErrorCode,
        })
        .from(videos)
        .where(eq(videos.id, videoId))
        .limit(1);

      if (!vRow) {
        return reply.code(404).send({ error: "Video not found" });
      }

      if (vRow.transcodingStatus !== "failed" || vRow.transcodingErrorCode !== "ASSEMBLY_FAILED") {
        return {
          canRetry: false,
          message: `Video is not in ASSEMBLY_FAILED state (current status: ${vRow.transcodingStatus}${vRow.transcodingErrorCode ? `/${vRow.transcodingErrorCode}` : ""})`,
        };
      }

      // Find the upload session via completedVideoId.
      const [session] = await db
        .select({
          sessionId: sessions.sessionId,
          totalChunks: sessions.totalChunks,
          storageBackend: sessions.storageBackend,
          status: sessions.status,
          objectKey: sessions.objectKey,
        })
        .from(sessions)
        .where(eq(sessions.completedVideoId, videoId))
        .limit(1);

      if (!session) {
        return {
          canRetry: false,
          message:
            "No upload session found for this video. " +
            "The session may have expired. Delete this video and re-upload to recover.",
        };
      }

      // Count chunks present in upload_chunks.
      type CountRow = { cnt: number };
      const countResult = await db.execute<CountRow>(
        sql`SELECT COUNT(*)::int AS cnt FROM upload_chunks WHERE session_id = ${session.sessionId}`,
      );
      const rows = (countResult as unknown as { rows?: CountRow[] }).rows ??
        (countResult as unknown as CountRow[]);
      const chunksPresent = Number(rows[0]?.cnt ?? 0);

      if (session.totalChunks <= 0 || chunksPresent < session.totalChunks) {
        return {
          canRetry: false,
          message:
            `Upload data is incomplete: ${chunksPresent} of ${session.totalChunks} chunk(s) are still stored. ` +
            "Delete this video and re-upload to recover.",
        };
      }

      // All chunks present — reset video to pending and spawn background retry.
      await db
        .update(videos)
        .set({
          transcodingStatus: "none",
          transcodingErrorCode: null,
          transcodingErrorMessage: null,
        })
        .where(eq(videos.id, videoId));

      // Keep session in (or move back to) "assembling" so the finalize-status
      // poller sees the right state during the retry.
      await db
        .update(sessions)
        .set({ status: "assembling", completedVideoId: videoId, updatedAt: new Date() })
        .where(eq(sessions.sessionId, session.sessionId));

      adminEventBus.push("videos-library-updated", { videoId, reason: "assembly-retry-requested" });

      req.log.info(
        { videoId, sessionId: session.sessionId, chunksPresent, totalChunks: session.totalChunks },
        "[assembly-retry] admin-initiated retry — spawning background re-assembly",
      );

      void spawnAssemblyRetry(session.sessionId, videoId, req.log);

      return {
        canRetry: true,
        message: "Assembly retry started. The video status will update automatically once complete.",
      };
    },
  );
}
