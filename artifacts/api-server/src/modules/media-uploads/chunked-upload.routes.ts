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
import { eq, asc, and, inArray, lt, gt, isNull, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { env } from "../../config/env.js";
import { storage } from "../../infrastructure/storage.js";
import { requireAuth } from "../../middleware/auth.js";
import { enqueueTranscode } from "../transcoder/transcoder.queue.js";
import { transcoderDispatcher } from "../transcoder/transcoder.dispatcher.js";
import { generateQuickThumbnail, normalizeThumbnailBuffer, probeUploadedContainerValidity, probeUploadedDuration, probeVideoMetadata } from "../transcoder/transcoder.service.js";
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

// ─── Assembly retry policy ────────────────────────────────────────────────────
//
// Maximum number of automatic re-assembly attempts before the session is
// permanently marked ASSEMBLY_FAILED and the operator must intervene manually.
// Kept at 5 so a genuinely unrecoverable session (corrupt chunks, missing
// parts) does not retry forever, while giving enough headroom to survive
// transient DB / storage hiccups across multiple server restarts.
const MAX_AUTO_ASSEMBLY_ATTEMPTS = 5;
//
// Per-attempt backoff delays (indexed by the attempt count AFTER the attempt
// that just failed).  ASSEMBLY_BACKOFF_MS[n] = "wait n before attempting n+1".
//
//   Attempt 1 fires immediately (from onReady or reconciliation).
//   Attempt 1 failed  (assemblyAttempts now = 1) → wait 30 s.
//   Attempt 2 failed  (assemblyAttempts now = 2) → wait 5 min.
//   Attempt 3 failed  (assemblyAttempts now = 3) → wait 15 min.
//   Attempt 4 failed  (assemblyAttempts now = 4) → wait 30 min.
//   Attempt 5 failed  (assemblyAttempts now = 5 = MAX)  → ASSEMBLY_FAILED permanently.
const ASSEMBLY_BACKOFF_MS: readonly number[] = [0, 30_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];

// ─── Assembly reconciliation interval ────────────────────────────────────────
// How often the in-process reconciliation timer scans for sessions whose
// automatic re-assembly failed transiently and whose backoff window has elapsed.
const ASSEMBLY_RECONCILIATION_INTERVAL_MS = 5 * 60_000; // 5 minutes

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
  /**
   * Optional SHA-256 hash of the complete file (64-char lowercase hex).
   * When provided, the finalize background task computes the SHA-256 of
   * the assembled blob via PostgreSQL sha256() and rejects any mismatch
   * as CORRUPT_SOURCE — a cryptographic end-to-end integrity guarantee
   * beyond per-chunk SHA-256 + assembled-size checks.
   */
  fileSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "fileSha256 must be a 64-character lowercase hex SHA-256 hash")
    .optional(),
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
//   • Startup recovery (onReady) — when all chunks are still present but the
//     assembled blob is missing (server restarted mid-assembly).
//   • Assembly reconciliation timer — periodic scan that retries sessions
//     whose last attempt failed transiently and whose backoff has elapsed.
//   • Admin retry endpoint — when an operator clicks "Retry Assembly".
//
// Retry policy (crash-safe via DB state):
//   • assemblyAttempts is incremented BEFORE each attempt so the count is
//     durable across server restarts even if the attempt crashes the process.
//   • On transient failure (attempt < MAX_AUTO_ASSEMBLY_ATTEMPTS): session
//     is reset to "uploading" with completedVideoId PRESERVED so the
//     reconciliation timer can find and re-trigger it after the backoff.
//   • On terminal failure (attempt >= MAX_AUTO_ASSEMBLY_ATTEMPTS): session
//     is reset to "uploading" with completedVideoId CLEARED and the video
//     row is marked ASSEMBLY_FAILED for manual intervention.
//
// On success: session → "completed"; video row restored; post-processing queued.
//
async function spawnAssemblyRetry(
  sessionId: string,
  videoId: string,
  log: FastifyInstance["log"],
): Promise<void> {
  void (async () => {
    try {
      // ── Step 0: Increment attempt counter BEFORE assembly ─────────────────
      // Incrementing first makes the count crash-safe: if the server dies
      // mid-assembly the DB reflects the correct attempt count so the next
      // restart (or reconciliation scan) applies the right backoff.
      await db
        .update(sessions)
        .set({ assemblyAttempts: sql`assembly_attempts + 1`, updatedAt: new Date() })
        .where(eq(sessions.sessionId, sessionId))
        .catch((err: unknown) =>
          log.warn({ err, sessionId }, "[assembly-retry] assemblyAttempts increment failed (non-fatal)"),
        );

      // ── Step 1: Re-load the full session row ──────────────────────────────
      const [session] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.sessionId, sessionId))
        .limit(1);

      if (!session) {
        log.warn({ sessionId, videoId }, "[assembly-retry] session not found — aborting");
        return;
      }

      const currentAttempts = session.assemblyAttempts ?? 1;
      const objectKey = session.objectKey;

      // No object key → no storage path → unrecoverable regardless of retry count.
      if (!objectKey) {
        log.warn({ sessionId, videoId, currentAttempts }, "[assembly-retry] session has no objectKey — marking permanently failed");
        await _markAssemblyPermanentlyFailed(
          videoId, sessionId,
          "Upload session has no storage key. Delete this video and re-upload to recover.",
          log, currentAttempts,
        );
        return;
      }

      log.info(
        { sessionId, videoId, attempt: currentAttempts, maxAttempts: MAX_AUTO_ASSEMBLY_ATTEMPTS, storageBackend: session.storageBackend, objectKey },
        "[assembly-retry] starting background re-assembly",
      );

      // ── Step 2: Run the assembly ──────────────────────────────────────────
      if (session.storageBackend === "db_fallback") {
        // BYTEA chunks in upload_chunks.fallback_data.
        // Abort any stale assemblyUploadId left over from a previous crashed
        // attempt to prevent orphaned _parts/{staleId}/... rows accumulating.
        if (session.assemblyUploadId) {
          log.info(
            { sessionId, staleUploadId: session.assemblyUploadId },
            "[assembly-retry] aborting stale assemblyUploadId before fresh attempt",
          );
          await storage()
            .abortMultipartUpload({ key: objectKey, uploadId: session.assemblyUploadId })
            .catch((abortErr: unknown) =>
              log.warn({ abortErr, sessionId }, "[assembly-retry] stale assemblyUploadId abort failed (non-fatal)"),
            );
          // Clear the stale ID — a new one will be written by finalizeFromDbFallback.
          await db
            .update(sessions)
            .set({ assemblyUploadId: null, updatedAt: new Date() })
            .where(eq(sessions.sessionId, sessionId))
            .catch(() => {});
        }
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
            `${missingEtags.length} chunk(s) are missing storage ETags — parts may have been cleaned up`,
          );
        }
        // completeMultipartUpload is idempotent: the INSERT ... ON CONFLICT DO UPDATE
        // reseeds the destination row from the first part even if a partial blob
        // exists from a previous interrupted attempt, then appends remaining parts.
        await storage().completeMultipartUpload({
          key: objectKey,
          uploadId: session.uploadId,
          parts: allChunks.map((c) => ({
            partNumber: c.chunkIndex + 1,
            etag: c.s3Etag as string,
          })),
        });
      }

      // ── Step 3: Verify assembled blob integrity ───────────────────────────
      const head = await storage().headObject(objectKey);
      if (!head.exists || (session.sizeBytes > 0 && head.contentLength !== session.sizeBytes)) {
        throw new Error(
          `Assembled blob size mismatch: expected ${session.sizeBytes} bytes, got ${head.contentLength ?? 0}`,
        );
      }

      const localVideoUrl = storage().publicUrl(objectKey);

      // ── Step 4: Commit success state ──────────────────────────────────────
      await Promise.all([
        db
          .update(sessions)
          .set({
            status: "completed",
            storageBackend: "db",
            assemblyUploadId: null,
            lastAssemblyError: null,
            updatedAt: new Date(),
          })
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
      log.info({ sessionId, videoId, attempt: currentAttempts }, "[assembly-retry] assembly succeeded — running post-processing");

      // ── Step 5: Post-assembly processing (same as normal finalize path) ───
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

      // ── Step 5a: ffprobe — accurate duration + technical metadata ─────────
      // The video row was reset to transcodingStatus="none" in step 4 and may
      // carry the 1800-second upload-time placeholder duration. Run ffprobe now
      // to get the real duration and codec info BEFORE enqueueing for broadcast.
      // A wrong duration causes dead-air at end-of-slot or premature auto-skip.
      try {
        const mediaMeta = await probeVideoMetadata(vRow.objectPath);
        const metaPatch: Partial<typeof videos.$inferInsert> = {};
        if (mediaMeta.durationSecs != null) metaPatch.duration = String(Math.round(mediaMeta.durationSecs));
        if (mediaMeta.videoCodec != null) metaPatch.videoCodec = mediaMeta.videoCodec;
        if (mediaMeta.audioCodec != null) metaPatch.audioCodec = mediaMeta.audioCodec;
        if (mediaMeta.videoBitrate != null) metaPatch.videoBitrate = mediaMeta.videoBitrate;
        if (mediaMeta.videoWidth != null) metaPatch.videoWidth = mediaMeta.videoWidth;
        if (mediaMeta.videoHeight != null) metaPatch.videoHeight = mediaMeta.videoHeight;
        if (Object.keys(metaPatch).length > 0) {
          await db.update(videos).set(metaPatch).where(eq(videos.id, videoId)).catch(() => {});
          void invalidateVideosCatalogCache();
        }
      } catch (probeErr) {
        log.warn({ err: probeErr, videoId }, "[assembly-retry] ffprobe failed (non-fatal) — using existing duration");
      }

      try {
        const enqResult = await enqueueIfMissing({ videoId, reason: "assembly-retry" });
        if (enqResult.enqueued) {
          adminEventBus.push("broadcast-queue-updated", { reason: "assembly-retry-enqueue", videoId });
        }
      } catch (err) {
        log.warn({ err, videoId }, "[assembly-retry] enqueueIfMissing failed (non-fatal)");
      }

      if (!vRow.faststartApplied) {
        try {
          await runFaststart(videoId, vRow.objectPath, { skipStatusUpdate: false });
          log.info({ videoId }, "[assembly-retry] faststart applied");
        } catch (fsErr) {
          log.warn({ err: fsErr, videoId }, "[assembly-retry] faststart failed (non-fatal)");
        }
      }

      if (!vRow.hlsMasterUrl) {
        try {
          await enqueueTranscode({ videoId, videoPath: vRow.objectPath });
          if (!env.TRANSCODER_DISABLE) transcoderDispatcher.nudge();
          log.info({ videoId }, "[assembly-retry] HLS transcoding queued");
        } catch (txErr) {
          log.warn({ err: txErr, videoId }, "[assembly-retry] enqueueTranscode failed (non-fatal)");
        }
      }

      log.info({ sessionId, videoId, attempt: currentAttempts }, "[assembly-retry] complete ✓");

    } catch (err) {
      // ── Failure handling: backoff retry OR permanent failure ──────────────
      const errMsg = err instanceof Error ? err.message : String(err);

      // Re-read the attempt counter — it was incremented at step 0, even if
      // the DB increment itself threw (in which case we default to 1).
      const [sessionAfterFail] = await db
        .select({ assemblyAttempts: sessions.assemblyAttempts })
        .from(sessions)
        .where(eq(sessions.sessionId, sessionId))
        .limit(1)
        .catch(() => [] as Array<{ assemblyAttempts: number | null }>);
      const attempts = sessionAfterFail?.assemblyAttempts ?? 1;

      if (attempts >= MAX_AUTO_ASSEMBLY_ATTEMPTS) {
        // All auto-retry budget exhausted — mark permanently failed so the
        // operator sees a clear "Retry Assembly" / re-upload call to action.
        log.error(
          { err, sessionId, videoId, attempts, max: MAX_AUTO_ASSEMBLY_ATTEMPTS },
          "[assembly-retry] max auto-retry attempts exhausted — marking ASSEMBLY_FAILED permanently",
        );
        await _markAssemblyPermanentlyFailed(videoId, sessionId, errMsg, log, attempts);
      } else {
        // Transient failure — preserve completedVideoId so the reconciliation
        // timer can find and retry this session after the backoff window.
        const backoffMs = ASSEMBLY_BACKOFF_MS[attempts] ?? 30 * 60_000;
        log.warn(
          { err, sessionId, videoId, attempts, backoffMs },
          `[assembly-retry] attempt ${attempts} failed — will retry after ${Math.round(backoffMs / 1000)}s via reconciliation`,
        );
        await Promise.allSettled([
          // Keep transcodingStatus as "none" so the video does not appear
          // broken in the admin panel while retries are pending.
          db.update(videos)
            .set({ transcodingStatus: "none", transcodingErrorCode: null, transcodingErrorMessage: null })
            .where(eq(videos.id, videoId)),
          // Reset session to "uploading" WITH completedVideoId intact.
          // The reconciliation timer queries (status="uploading" AND
          // completedVideoId IS NOT NULL AND assemblyAttempts > 0) to find
          // exactly these sessions and trigger the next attempt.
          db.update(sessions)
            .set({ status: "uploading", lastAssemblyError: errMsg.slice(0, 2048), updatedAt: new Date() })
            .where(eq(sessions.sessionId, sessionId)),
        ]);
        adminEventBus.push("videos-library-updated", { videoId, reason: "assembly-retry-pending" });
      }
    }
  })();
}

// ─── Permanent assembly failure helper ────────────────────────────────────────
//
// Marks a video ASSEMBLY_FAILED and resets its session so the operator sees
// a clear call-to-action in the admin panel. Shared between the no-objectKey
// fast-path and the max-attempts-exhausted path in spawnAssemblyRetry.
async function _markAssemblyPermanentlyFailed(
  videoId: string,
  sessionId: string,
  lastError: string,
  log: FastifyInstance["log"],
  attempts?: number,
): Promise<void> {
  const attemptNote = attempts != null ? ` after ${attempts} auto-retry attempt(s)` : "";
  await Promise.allSettled([
    db.update(videos)
      .set({
        transcodingStatus: "failed",
        transcodingErrorCode: "ASSEMBLY_FAILED",
        transcodingErrorMessage:
          `Automatic re-assembly failed${attemptNote}. ` +
          `Last error: ${lastError.slice(0, 500)}. ` +
          "Click 'Retry Assembly' to try again manually, or delete this video and re-upload.",
      })
      .where(eq(videos.id, videoId)),
    // Clear completedVideoId so stale-session cleanup can eventually reclaim
    // the session row, and so the reconciliation timer does not keep retrying.
    db.update(sessions)
      .set({
        status: "uploading",
        completedVideoId: null,
        lastAssemblyError: lastError.slice(0, 2048),
        updatedAt: new Date(),
      })
      .where(eq(sessions.sessionId, sessionId)),
  ]);
  adminEventBus.push("videos-library-updated", { videoId, reason: "assembly-retry-exhausted" });
  log.error({ videoId, sessionId, attempts }, "[assembly-retry] permanently marked ASSEMBLY_FAILED");
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

    // Persist the assemblyUploadId immediately after creation so that
    // if the server crashes between here and completeMultipartUpload,
    // the next restart can abort the orphaned _parts/{uploadId}/... rows
    // before starting a fresh attempt instead of letting them accumulate.
    await db
      .update(sessions)
      .set({ assemblyUploadId: uploadId, updatedAt: new Date() })
      .where(eq(sessions.sessionId, session.sessionId))
      .catch((err: unknown) =>
        log.warn({ err, sessionId: session.sessionId }, "[finalize-fallback] failed to persist assemblyUploadId (non-fatal)"),
      );

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

    // Assembly succeeded — clear the persisted assemblyUploadId so that
    // future crash-recovery does not try to abort a completed upload.
    await db
      .update(sessions)
      .set({ assemblyUploadId: null, updatedAt: new Date() })
      .where(eq(sessions.sessionId, session.sessionId))
      .catch(() => {}); // non-fatal: assemblyUploadId will simply be a no-op on next abort attempt

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
          assemblyAttempts: sessions.assemblyAttempts,
          assemblyUploadId: sessions.assemblyUploadId,
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
          // Fire all background retries with a small stagger to avoid a
          // thundering-herd of concurrent DB assembly operations on boot.
          // Each retry is offset by 3 s so a 5-session boot recovery
          // spreads its DB load over 12 s instead of hitting all at once.
          for (let i = 0; i < retriableSessionIds.length; i++) {
            const delayMs = i * 3_000;
            if (delayMs === 0) {
              void spawnAssemblyRetry(retriableSessionIds[i]!, retriableVideoIds[i]!, app.log);
            } else {
              const timer = setTimeout(() => {
                void spawnAssemblyRetry(retriableSessionIds[i]!, retriableVideoIds[i]!, app.log);
              }, delayMs);
              timer.unref();
            }
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
                // Step 1: Query current video state first — needed for ffprobe
                // objectPath and to decide which post-processing is outstanding.
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

                // Step 2: ffprobe — accurate duration + technical metadata.
                // On server restart, recovered videos may carry the 1800-second
                // upload-time placeholder duration if the original finalize task
                // was interrupted before the probes completed. Run now to
                // guarantee accurate duration in the broadcast queue slot.
                try {
                  const mediaMeta = await probeVideoMetadata(vRow.objectPath);
                  const metaPatch: Partial<typeof videos.$inferInsert> = {};
                  if (mediaMeta.durationSecs != null) metaPatch.duration = String(Math.round(mediaMeta.durationSecs));
                  if (mediaMeta.videoCodec != null) metaPatch.videoCodec = mediaMeta.videoCodec;
                  if (mediaMeta.audioCodec != null) metaPatch.audioCodec = mediaMeta.audioCodec;
                  if (mediaMeta.videoBitrate != null) metaPatch.videoBitrate = mediaMeta.videoBitrate;
                  if (mediaMeta.videoWidth != null) metaPatch.videoWidth = mediaMeta.videoWidth;
                  if (mediaMeta.videoHeight != null) metaPatch.videoHeight = mediaMeta.videoHeight;
                  if (Object.keys(metaPatch).length > 0) {
                    await db.update(videos).set(metaPatch).where(eq(videos.id, videoId)).catch(() => {});
                    void invalidateVideosCatalogCache();
                  }
                } catch (probeErr) {
                  app.log.warn(
                    { err: probeErr, videoId },
                    "[upload] recovery: ffprobe failed (non-fatal) — using existing duration",
                  );
                }


                // Step 4: Broadcast queue slot.
                const enqResult = await enqueueIfMissing({ videoId, reason: "upload-recovery-on-restart" });
                if (enqResult.enqueued) {
                  app.log.info(
                    { videoId, queueItemId: enqResult.queueItemId },
                    "[upload] recovery: auto-queued recovered video for broadcast",
                  );
                  adminEventBus.push("broadcast-queue-updated", { reason: "upload-recovery-enqueue", videoId });
                }

                // Step 5: Faststart — moves the moov atom to the front of the
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

                // Step 6: HLS transcoding.
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
          .where(
            and(
              eq(sessions.status, "uploading"),
              lt(sessions.updatedAt, cutoff),
              // CRITICAL: never clean up sessions that have a pending assembly
              // retry (completedVideoId IS NOT NULL means the video row exists
              // and the reconciliation timer may still retry this session).
              // Only clean up truly abandoned uploads that were never pre-committed.
              isNull(sessions.completedVideoId),
            ),
          );

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
    setInterval(() => { void runSessionCleanup(); }, CLEANUP_INTERVAL_MS).unref();

    // ── Assembly reconciliation timer ─────────────────────────────────────
    // Periodically scans for upload sessions that:
    //   • Were in "assembling" status during a previous server lifecycle,
    //   • Had spawnAssemblyRetry fail transiently (session reset to "uploading"
    //     with completedVideoId PRESERVED and assemblyAttempts incremented),
    //   • And whose exponential back-off window has now elapsed.
    //
    // This timer is the backbone of fault-tolerant auto-recovery: it decouples
    // retry scheduling from the process lifecycle so a transient DB hiccup
    // during one startup does not permanently strand the upload.
    //
    // Design properties:
    //   • Crash-safe: all state (assemblyAttempts, updatedAt, status) lives in
    //     the DB, not in-process memory. A server restart picks up exactly where
    //     the last attempt left off.
    //   • Idempotent CAS: status flip (uploading → assembling) is guarded by a
    //     WHERE status='uploading' predicate, so two concurrent reconciliation
    //     ticks cannot double-spawn for the same session.
    //   • Backoff: uses ASSEMBLY_BACKOFF_MS[attempts] based on attempt count so
    //     repeated transient failures space out rather than hammer the DB.
    //   • Self-limiting: once assemblyAttempts reaches MAX_AUTO_ASSEMBLY_ATTEMPTS,
    //     spawnAssemblyRetry marks the session ASSEMBLY_FAILED and clears
    //     completedVideoId, removing it from the reconciliation query forever.
    const runAssemblyReconciliation = async () => {
      try {
        const pendingRetries = await db
          .select({
            sessionId: sessions.sessionId,
            completedVideoId: sessions.completedVideoId,
            assemblyAttempts: sessions.assemblyAttempts,
            updatedAt: sessions.updatedAt,
          })
          .from(sessions)
          .where(
            and(
              eq(sessions.status, "uploading"),
              isNotNull(sessions.completedVideoId),
              gt(sessions.assemblyAttempts, 0),
              lt(sessions.assemblyAttempts, MAX_AUTO_ASSEMBLY_ATTEMPTS),
            ),
          )
          .limit(20); // safety cap per tick

        if (pendingRetries.length === 0) return;

        const now = Date.now();
        for (const candidate of pendingRetries) {
          if (!candidate.completedVideoId) continue;
          const attempts = candidate.assemblyAttempts ?? 0;
          const backoffMs = ASSEMBLY_BACKOFF_MS[attempts] ?? 30 * 60_000;
          const lastMs = candidate.updatedAt ? new Date(candidate.updatedAt).getTime() : 0;
          if (now - lastMs < backoffMs) continue; // still inside backoff window

          // CAS: atomically flip status to "assembling" only if still "uploading".
          // If another reconciliation tick or a manual retry already grabbed it,
          // `acquired` will be empty and we safely skip to the next candidate.
          const acquired = await db
            .update(sessions)
            .set({ status: "assembling", updatedAt: new Date() })
            .where(
              and(
                eq(sessions.sessionId, candidate.sessionId),
                eq(sessions.status, "uploading"),
              ),
            )
            .returning({ sessionId: sessions.sessionId })
            .catch(() => [] as Array<{ sessionId: string }>);

          if (acquired.length === 0) continue;

          app.log.info(
            {
              sessionId: candidate.sessionId,
              videoId: candidate.completedVideoId,
              attempts,
              backoffMs,
            },
            "[assembly-reconciliation] backoff elapsed — scheduling retry",
          );
          void spawnAssemblyRetry(candidate.sessionId, candidate.completedVideoId, app.log);
        }
      } catch (err) {
        app.log.warn({ err }, "[assembly-reconciliation] scan failed (non-fatal)");
      }
    };

    // First tick fires after one full interval (not immediately) — the onReady
    // hook already handles sessions that are currently in "assembling" status.
    // "uploading" sessions with assemblyAttempts > 0 (from a prior restart)
    // are picked up on the first tick ~5 minutes after boot, which is fine
    // because they are already waiting out a backoff window anyway.
    setInterval(() => { void runAssemblyReconciliation(); }, ASSEMBLY_RECONCILIATION_INTERVAL_MS).unref();
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
          expectedFileSha256: body.fileSha256 ?? null,
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
      // Optional byte-offset header (X-Byte-Offset: <number>).
      // Populated by the admin upload client for all new sessions.
      // Null for legacy clients that predate byte-range tracking.
      const rawByteOffset = req.headers["x-byte-offset"] as string | undefined;
      const byteOffset =
        rawByteOffset !== undefined && rawByteOffset !== ""
          ? (isNaN(parseInt(rawByteOffset, 10)) ? null : parseInt(rawByteOffset, 10))
          : null;

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
              byteOffset,
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
          byteOffset,
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
          byteOffset: chunks.byteOffset,
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

      // ── Byte-range contiguous coverage validation ─────────────────────────────
      // Only runs when ALL chunks carry a byteOffset (new sessions).
      // Legacy sessions (byteOffset=null) skip this check — they're protected
      // by the chunk-count check above + the assembly size assertion below.
      //
      // Validates three properties:
      //   1. All byte offsets are unique (DB unique index guards duplicates
      //      by chunkIndex, but byteOffset uniqueness is an extra safety net).
      //   2. Offsets form a contiguous sequence: sorted[0].byteOffset === 0
      //      and each subsequent offset equals the previous offset + sizeBytes.
      //   3. Full coverage: last chunk's offset + sizeBytes === session.sizeBytes.
      {
        const chunksWithOffsets = allChunks.filter(
          (c): c is typeof c & { byteOffset: number } => c.byteOffset !== null && c.byteOffset !== undefined,
        );
        if (chunksWithOffsets.length === allChunks.length && chunksWithOffsets.length > 0) {
          const sorted = [...chunksWithOffsets].sort((a, b) => a.byteOffset - b.byteOffset);
          let expectedOffset = 0;
          let gapError: string | null = null;
          for (const chunk of sorted) {
            if (chunk.byteOffset !== expectedOffset) {
              gapError =
                `Byte-range coverage gap: expected chunk at byte offset ${expectedOffset}, ` +
                `found chunk ${chunk.chunkIndex} at offset ${chunk.byteOffset}. ` +
                `This indicates a missing or misaligned chunk — re-upload to recover.`;
              break;
            }
            expectedOffset += chunk.sizeBytes;
          }
          if (gapError) {
            await resetLock();
            throw Object.assign(new Error(gapError), { statusCode: 422 });
          }
          if (expectedOffset !== session.sizeBytes) {
            await resetLock();
            throw Object.assign(
              new Error(
                `Byte-range coverage incomplete: chunks cover ${expectedOffset} bytes ` +
                `but session declared ${session.sizeBytes} bytes total. ` +
                `The upload appears truncated — re-upload to recover.`,
              ),
              { statusCode: 422 },
            );
          }
          req.log.debug(
            { sessionId, totalBytes: session.sizeBytes, chunks: allChunks.length },
            "[finalize] byte-range contiguous coverage verified ✓",
          );
        }
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

            // ── File-level SHA-256 cryptographic verification ─────────────────
            // Runs only when the client declared a file hash at init time.
            // PostgreSQL's sha256(bytea) computes the hash server-side without
            // moving the blob into Node.js memory — O(1) Node.js heap regardless
            // of file size. A mismatch means bytes were corrupted in transit or
            // during assembly and the per-chunk SHA-256s cannot be fully trusted
            // (e.g. a hash-collision attack or a storage-level silent corruption).
            if (session.expectedFileSha256) {
              try {
                type HashRow = { file_sha256: string };
                const hashResult = await db.execute<HashRow>(
                  sql`SELECT encode(sha256(data), 'hex') AS file_sha256 FROM storage_blobs WHERE key = ${objectKey}`,
                );
                const hashRows = (hashResult as unknown as { rows?: HashRow[] }).rows ??
                  (hashResult as unknown as HashRow[]);
                const computedSha256 = hashRows[0]?.file_sha256;
                if (computedSha256 && computedSha256 !== session.expectedFileSha256) {
                  capturedLog.error(
                    {
                      sessionId,
                      videoId,
                      expectedSha256: session.expectedFileSha256,
                      computedSha256,
                    },
                    "[finalize:bg] file SHA-256 mismatch — assembled blob does not match client-declared hash; marking failed",
                  );
                  await Promise.allSettled([
                    db
                      .update(videos)
                      .set({
                        transcodingStatus: "failed",
                        transcodingErrorCode: "CORRUPT_SOURCE",
                        transcodingErrorMessage:
                          `File integrity check failed: SHA-256 mismatch. ` +
                          `Expected ${session.expectedFileSha256.slice(0, 16)}… ` +
                          `but assembled blob hashes to ${computedSha256.slice(0, 16)}…. ` +
                          `This indicates data corruption in transit or assembly. ` +
                          `Please delete this video and re-upload the original file.`,
                      })
                      .where(eq(videos.id, videoId)),
                    db
                      .update(sessions)
                      .set({ status: "uploading", completedVideoId: null, updatedAt: new Date() })
                      .where(eq(sessions.sessionId, sessionId)),
                  ]);
                  adminEventBus.push("videos-library-updated", { videoId, reason: "assembly-sha256-mismatch" });
                  uploadTelemetry.serverFail(
                    sessionId,
                    session.sizeBytes,
                    "assembly_sha256_mismatch",
                    `SHA-256 mismatch: expected ${session.expectedFileSha256.slice(0, 16)}… got ${computedSha256.slice(0, 16)}…`,
                  );
                  clearTimeout(assemblyWatchdog);
                  return;
                }
                capturedLog.info(
                  { sessionId, videoId, sha256: session.expectedFileSha256.slice(0, 16) },
                  "[finalize:bg] file SHA-256 verified ✓",
                );
              } catch (sha256Err) {
                // Non-fatal: size check already passed and per-chunk SHA-256s
                // were verified at upload time. Log and continue — the file is
                // likely correct even if the PG sha256() query failed.
                capturedLog.warn(
                  { err: sha256Err, sessionId, videoId },
                  "[finalize:bg] file SHA-256 verification query failed (non-fatal) — skipping; size check passed",
                );
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
                .catch((err: unknown) =>
                  capturedLog.warn(
                    { err, videoId },
                    "[finalize:bg] s3MirroredAt stamp failed (non-fatal) — startup repair will recover on next boot",
                  ),
                ),
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
            // Hoisted so the accurate ffprobe duration is available to update
            // broadcast_queue.duration_secs AFTER enqueueIfMissing() creates
            // the queue row (updating before enqueue would match 0 rows).
            let ffprobeDurSecs: number | null = null;
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
              // Single ffprobe pass for all technical metadata (codec, bitrate, resolution).
              // Runs concurrently with the duration probe when the client already supplied
              // a valid duration, otherwise runs after duration probe completes.
              const mediaMeta = await probeVideoMetadata(objectKey);
              const patch: Partial<typeof videos.$inferInsert> = {};
              if (effectiveThumbUrl) patch.thumbnailUrl = effectiveThumbUrl;
              const effectiveDurSecs = probedSecs ?? mediaMeta.durationSecs;
              if (effectiveDurSecs != null) patch.duration = String(Math.round(effectiveDurSecs));
              if (mediaMeta.videoCodec != null) patch.videoCodec = mediaMeta.videoCodec;
              if (mediaMeta.audioCodec != null) patch.audioCodec = mediaMeta.audioCodec;
              if (mediaMeta.videoBitrate != null) patch.videoBitrate = mediaMeta.videoBitrate;
              if (mediaMeta.videoWidth != null) patch.videoWidth = mediaMeta.videoWidth;
              if (mediaMeta.videoHeight != null) patch.videoHeight = mediaMeta.videoHeight;
              if (Object.keys(patch).length > 0) {
                await db.update(videos).set(patch).where(eq(videos.id, videoId));
                void invalidateVideosCatalogCache();
                adminEventBus.push("videos-library-updated", { videoId, reason: "thumbnail-generated" });
              }
              // Capture for the post-enqueue broadcast_queue update below.
              const durSecs = probedSecs ?? mediaMeta.durationSecs;
              if (durSecs != null && durSecs > 10) ffprobeDurSecs = durSecs;
            } catch (err) {
              capturedLog.warn({ err, videoId }, "[finalize:bg] post-upload probes failed (non-fatal)");
            }

            // CRITICAL ORDERING: faststart MUST complete before enqueueTranscode.
            //
            // faststart.service.ts replaces the source blob via a multipart
            // re-upload. If the transcoder downloads the source while that
            // assembly is still in progress it fetches a partial file and
            // ffprobe reports "moov atom not found", killing the transcode job.

            // ── Immediate broadcast queue entry ─────────────────────────────
            // Queue the video as soon as the raw file is in storage — no
            // validity gate.  Every upload reaches the broadcast queue and can
            // air as raw MP4.  Faststart upgrades the source in-place if ffmpeg
            // succeeds; HLS adds a separate manifest URL when transcoding finishes.
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
              if (ffprobeDurSecs !== null) {
                await db
                  .update(schema.broadcastQueueTable)
                  .set({ durationSecs: Math.round(ffprobeDurSecs) })
                  .where(eq(schema.broadcastQueueTable.videoId, videoId))
                  .catch(() => {});
              }
              adminEventBus.push("broadcast-queue-updated", { reason: "upload-finalize", videoId });
            } catch (enqErr) {
              capturedLog.warn({ err: enqErr, videoId }, "[finalize:bg] immediate enqueueIfMissing failed (non-fatal)");
              adminEventBus.push("broadcast-queue-updated", { reason: "upload-finalize-enqueue-failed", videoId });
            }

            try {
              await runFaststart(videoId, objectKey, { skipStatusUpdate: false });
              capturedLog.info({ sessionId, videoId }, "[finalize:bg] faststart done");
            } catch (err) {
              capturedLog.warn({ err, videoId }, "[finalize:bg] faststart failed (non-fatal) — broadcasting as raw MP4");
            }

            // Enqueue HLS transcoding AFTER faststart is complete.
            {
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
              .catch((err: unknown) =>
                capturedLogB.warn(
                  { err, videoId: videoIdB },
                  "[finalize:db_fallback:bg] s3MirroredAt stamp failed (non-fatal) — startup repair will recover on next boot",
                ),
              ),
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
          // Hoisted so the accurate ffprobe duration is available to update
          // broadcast_queue.duration_secs AFTER enqueueIfMissing() creates
          // the queue row (updating before enqueue would match 0 rows).
          let ffprobeDurSecsB: number | null = null;
          try {
            const thumbUrlB = await generateQuickThumbnail(result.objectKey, videoIdB);
            // Mirror Path A: probe even when clientDurationB > 0 if it equals
            // the 1800-second placeholder so db_fallback uploads also get
            // a real ffprobe duration instead of a permanent placeholder.
            const probedSecsB = (clientDurationB > 0 && clientDurationB !== 1800)
              ? null
              : await probeUploadedDuration(result.objectKey);
            // Single ffprobe pass for all technical metadata (codec, bitrate, resolution).
            const mediaMetaB = await probeVideoMetadata(result.objectKey);
            const patchB: Partial<typeof videos.$inferInsert> = {};
            if (thumbUrlB) patchB.thumbnailUrl = thumbUrlB;
            const effectiveDurSecsB = probedSecsB ?? mediaMetaB.durationSecs;
            if (effectiveDurSecsB != null) patchB.duration = String(Math.round(effectiveDurSecsB));
            if (mediaMetaB.videoCodec != null) patchB.videoCodec = mediaMetaB.videoCodec;
            if (mediaMetaB.audioCodec != null) patchB.audioCodec = mediaMetaB.audioCodec;
            if (mediaMetaB.videoBitrate != null) patchB.videoBitrate = mediaMetaB.videoBitrate;
            if (mediaMetaB.videoWidth != null) patchB.videoWidth = mediaMetaB.videoWidth;
            if (mediaMetaB.videoHeight != null) patchB.videoHeight = mediaMetaB.videoHeight;
            if (Object.keys(patchB).length > 0) {
              await db.update(videos).set(patchB).where(eq(videos.id, videoIdB));
              void invalidateVideosCatalogCache();
              adminEventBus.push("videos-library-updated", { videoId: videoIdB, reason: "thumbnail-generated" });
            }
            // Capture for the post-enqueue broadcast_queue update below.
            const durSecsB = probedSecsB ?? mediaMetaB.durationSecs;
            if (durSecsB != null && durSecsB > 10) ffprobeDurSecsB = durSecsB;
          } catch (err) {
            capturedLogB.warn({ err, videoId: videoIdB }, "[finalize:db_fallback:bg] post-upload probes failed (non-fatal)");
          }

          // ── Immediate broadcast queue entry (Path B) ─────────────────────
          // Queue the video as soon as the raw blob is in storage — no validity
          // gate.  Every upload reaches the broadcast queue and can air as raw
          // MP4.  Faststart upgrades the source in-place; HLS adds a manifest.
          //
          // IMPORTANT: enqueue BEFORE runFaststart — faststart sets
          // transcodingStatus='processing' while swapping the blob, which
          // temporarily blocks the item in loadActive().  Calling enqueueIfMissing
          // here ensures the item is queued even if faststart fails.
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
            if (ffprobeDurSecsB !== null) {
              await db
                .update(schema.broadcastQueueTable)
                .set({ durationSecs: Math.round(ffprobeDurSecsB) })
                .where(eq(schema.broadcastQueueTable.videoId, videoIdB))
                .catch(() => {});
            }
            adminEventBus.push("broadcast-queue-updated", { reason: "upload-finalize", videoId: videoIdB });
          } catch (enqErrB) {
            capturedLogB.warn(
              { err: enqErrB, videoId: videoIdB },
              "[finalize:db_fallback:bg] immediate enqueueIfMissing failed (non-fatal)",
            );
            adminEventBus.push("broadcast-queue-updated", { reason: "upload-finalize-enqueue-failed", videoId: videoIdB });
          }

          try {
            await runFaststart(videoIdB, result.objectKey, { skipStatusUpdate: false });
            capturedLogB.info({ sessionId, videoId: videoIdB }, "[finalize:db_fallback:bg] faststart done");
          } catch (err) {
            capturedLogB.warn({ err, videoId: videoIdB }, "[finalize:db_fallback:bg] faststart failed (non-fatal) — broadcasting as raw MP4");
          }

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
      // Reset assemblyAttempts to 0 so the operator-initiated retry gets a
      // fresh budget of MAX_AUTO_ASSEMBLY_ATTEMPTS automatic re-tries —
      // the prior budget was exhausted or the operator is explicitly starting
      // fresh regardless of how many automatic attempts were already made.
      await db
        .update(sessions)
        .set({
          status: "assembling",
          completedVideoId: videoId,
          assemblyAttempts: 0,
          lastAssemblyError: null,
          updatedAt: new Date(),
        })
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
