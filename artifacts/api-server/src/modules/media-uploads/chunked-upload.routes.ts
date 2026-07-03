/**
 * Resumable chunked upload gateway (server-relay path).
 *
 * All video data flows through the server — no browser-direct or presigned
 * URL uploads. Every chunk is stored as a native MinIO multipart part.
 * MinIO is the sole storage backend; there is no database BYTEA fallback.
 *
 * Wire:
 *   POST /admin/videos/upload/init
 *     → create DB session; open MinIO multipart upload slot
 *   POST /admin/videos/upload/:sessionId/chunk
 *     → receive raw binary chunk (application/octet-stream), verify SHA-256,
 *       store as a native MinIO multipart part (uploadPart)
 *   GET  /admin/videos/upload/:sessionId/status
 *     → return { uploadedChunkIndices } so the client can resume mid-flight
 *   POST /admin/videos/upload/:sessionId/thumbnail
 *     → accept optional custom thumbnail; store in MinIO
 *   POST /admin/videos/upload/:sessionId/finalize
 *     → completeMultipartUpload assembles all parts in MinIO, inserts
 *       managed_videos row, and enqueues HLS transcoding
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
import { generateQuickThumbnail, normalizeThumbnailBuffer, probeUploadedContainerValidity, probeUploadedDuration, probeVideoMetadata } from "../transcoder/transcoder.service.js";
import { invalidateVideosCatalogCache } from "../videos/videos.routes.js";
import { broadcastEngine } from "../broadcast/queue.engine.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { uploadTelemetry } from "./upload-telemetry.service.js";
import { enqueueIfMissing } from "../broadcast/auto-enqueue.service.js";
import { ServiceUnavailableError, InternalError } from "../../shared/errors.js";
import { quarantineVideo } from "../broadcast/quarantine.service.js";

const sessions = schema.uploadSessionsTable;
const chunks = schema.uploadChunksTable;
const videos = schema.videosTable;

// ─── Chunk-write concurrency semaphore ────────────────────────────────────────
// Each in-flight chunk upload holds an 8 MiB body buffer in Node.js heap for
// the entire duration of the uploadPart DB write (typically 13-15 s under
// concurrent background-assembly I/O pressure). Without a cap, 10 concurrent
// files × 4 parallel chunks = 40 × 16 MiB ≈ 640 MiB of simultaneous Buffer
// allocations. Combined with V8 heap fragmentation and the pg hex-encoding
// overhead this pushes RSS well above the memory-watchdog restart threshold.
//
// Limiting concurrent DB writes to 20 keeps peak chunk-buffer memory under
// ~320 MiB while still saturating a 40-connection pg pool (DB_POOL_MAX=40).
// Override via MAX_CONCURRENT_CHUNK_DB_OPS env var — lower to 6–10 on
// memory-constrained hosts (< 1 GiB), raise to 30–40 on large-memory hosts.
const MAX_CONCURRENT_CHUNK_DB_OPS = env.MAX_CONCURRENT_CHUNK_DB_OPS ?? 20;
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
// Raised to 8 (from 5) to survive transient DB hiccups across multiple server
// restarts, storage contention, and memory-pressure events without burning
// through the retry budget too quickly on transient failures.
const MAX_AUTO_ASSEMBLY_ATTEMPTS = 8;
//
// Per-attempt backoff delays (indexed by the attempt count AFTER the attempt
// that just failed).  ASSEMBLY_BACKOFF_MS[n] = "wait n before attempting n+1".
//
//   Attempt 1 fires immediately (from onReady or reconciliation).
//   Attempt 1 failed  (assemblyAttempts now = 1) → wait 30 s.
//   Attempt 2 failed  (assemblyAttempts now = 2) → wait 5 min.
//   Attempt 3 failed  (assemblyAttempts now = 3) → wait 15 min.
//   Attempt 4 failed  (assemblyAttempts now = 4) → wait 30 min.
//   Attempt 5 failed  (assemblyAttempts now = 5) → wait 60 min.
//   Attempt 6 failed  (assemblyAttempts now = 6) → wait 90 min.
//   Attempt 7 failed  (assemblyAttempts now = 7) → wait 120 min.
//   Attempt 8 failed  (assemblyAttempts now = 8 = MAX) → ASSEMBLY_FAILED permanently.
const ASSEMBLY_BACKOFF_MS: readonly number[] = [
  0,
  30_000,
  5  * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  90 * 60_000,
  120 * 60_000,
];

// ─── Terminal assembly error codes ────────────────────────────────────────────
//
// These error codes indicate that the assembly data is structurally unrecoverable
// regardless of how many retries are attempted. Immediately marking the session
// ASSEMBLY_FAILED — without burning the full retry budget — lets the operator see
// the "re-upload required" call-to-action without waiting 0+30s+5m+15m+30m.
//
//   ASSEMBLY_CORRUPT_SOURCE  – SHA-256 mismatch; data was corrupted in transit
//   ASSEMBLY_NO_PARTS        – staging parts already cleaned up; re-upload required
//   ASSEMBLY_EMPTY_PARTS     – zero-byte chunk data; re-upload required
//
// ASSEMBLY_SIZE_MISMATCH and ASSEMBLY_WRONG_PART_COUNT are intentionally NOT in
// this set — they can result from transient DB I/O or phantom-part edge cases
// that may resolve on a subsequent attempt.
const TERMINAL_ASSEMBLY_ERROR_CODES = new Set([
  "ASSEMBLY_CORRUPT_SOURCE",
  "ASSEMBLY_NO_PARTS",
  "ASSEMBLY_EMPTY_PARTS",
]);

// ─── Assembly reconciliation interval ────────────────────────────────────────
// How often the in-process reconciliation timer scans for sessions whose
// automatic re-assembly failed transiently and whose backoff window has elapsed.
const ASSEMBLY_RECONCILIATION_INTERVAL_MS = 5 * 60_000; // 5 minutes

// ─── Schema helpers ───────────────────────────────────────────────────────────

// 100 GiB hard upper limit — signals misconfiguration above this.
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
      // ── Step 0: Load the full session row FIRST ───────────────────────────
      // Load BEFORE deciding whether to increment the attempt counter so a
      // blob-already-present fast-path (assembly succeeded but post-processing
      // failed) does NOT burn a retry attempt. This is the key fix for BUG-3:
      // previously the counter was incremented unconditionally at the top, so
      // every "blob present → post-step fails → retry" cycle consumed one of
      // the 8 allotted attempts, eventually exhausting the budget and
      // permanently failing a session whose blob was fully intact all along.
      const [session] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.sessionId, sessionId))
        .limit(1);

      if (!session) {
        log.warn({ sessionId, videoId }, "[assembly-retry] session not found — aborting");
        return;
      }

      const objectKey = session.objectKey;

      // No object key → no storage path → unrecoverable regardless of retry count.
      if (!objectKey) {
        log.warn({ sessionId, videoId }, "[assembly-retry] session has no objectKey — marking permanently failed");
        await _markAssemblyPermanentlyFailed(
          videoId, sessionId,
          "Upload session has no storage key. Delete this video and re-upload to recover.",
          log, session.assemblyAttempts ?? 0, session.uploadId,
        );
        return;
      }

      // ── Step 1: Blob-exists shortcut ──────────────────────────────────────
      //
      // CRITICAL IDEMPOTENCY GUARD: check whether the blob is already present
      // in storage_blobs BEFORE attempting completeMultipartUpload AND before
      // incrementing the attempt counter.
      //
      // WHY: if assembly succeeded but a later post-processing step threw
      // (telemetry write, DB hiccup in s3MirroredAt stamp, etc.), the catch
      // block in the finalize handler resets the session to "uploading" with
      // assemblyAttempts++. The reconciliation timer calls spawnAssemblyRetry
      // again. Without this guard, the retry would:
      //   a) Call completeMultipartUpload → ASSEMBLY_NO_PARTS (parts deleted)
      //      → burn another attempt toward ASSEMBLY_FAILED permanently.
      //   b) Deplete the retry budget even though only post-processing needs to
      //      complete and the blob is fully intact.
      //
      // With this guard: we recognise an already-assembled blob, skip both the
      // assembly AND the attempt counter increment, then jump straight to
      // post-processing. This is safe because post-processing is idempotent:
      // ffprobe + faststart + enqueueIfMissing are all no-ops if already done.
      let blobAlreadyPresent = false;
      try {
        const existingBlob = await storage().headObject(objectKey);
        if (existingBlob.exists && (existingBlob.contentLength ?? 0) > 0) {
          log.info(
            { sessionId, videoId, objectKey, blobSizeBytes: existingBlob.contentLength },
            "[assembly-retry] blob already present in storage_blobs — skipping re-assembly and attempt counter; running post-processing only",
          );
          blobAlreadyPresent = true;
        }
      } catch (headErr) {
        log.warn(
          { err: headErr, sessionId, videoId, objectKey },
          "[assembly-retry] headObject pre-check failed (non-fatal) — proceeding with full re-assembly",
        );
      }

      // ── Step 2: Increment attempt counter BEFORE assembly (crash-safe) ────
      // Only increment when we are actually going to attempt assembly — not for
      // the blob-already-present fast-path. Incrementing before the assembly DB
      // call makes the count crash-safe: if the process dies mid-assembly the
      // DB reflects the correct attempt count so the next reconciliation scan
      // applies the correct backoff window.
      if (!blobAlreadyPresent) {
        await db
          .update(sessions)
          .set({ assemblyAttempts: sql`assembly_attempts + 1`, updatedAt: new Date() })
          .where(eq(sessions.sessionId, sessionId))
          .catch((err: unknown) =>
            log.warn({ err, sessionId }, "[assembly-retry] assemblyAttempts increment failed (non-fatal)"),
          );
      }

      // Re-read current attempt count from DB (reflects the conditional increment above).
      const [sessionMeta] = await db
        .select({ assemblyAttempts: sessions.assemblyAttempts, uploadId: sessions.uploadId })
        .from(sessions)
        .where(eq(sessions.sessionId, sessionId))
        .limit(1)
        .catch(() => [] as Array<{ assemblyAttempts: number | null; uploadId: string | null }>);
      const currentAttempts = sessionMeta?.assemblyAttempts ?? 1;
      const uploadId = session.uploadId ?? sessionMeta?.uploadId;

      log.info(
        {
          sessionId,
          videoId,
          attempt: currentAttempts,
          maxAttempts: MAX_AUTO_ASSEMBLY_ATTEMPTS,
          objectKey,
          blobAlreadyPresent,
        },
        "[assembly-retry] starting background re-assembly",
      );

      if (!blobAlreadyPresent) {
        if (!uploadId) {
          throw new InternalError("session.uploadId is null — cannot re-assemble (re-upload required)");
        }

        // ── Step 3: Validate upload_chunks metadata ───────────────────────
        const allChunks = await db
          .select({ chunkIndex: chunks.chunkIndex, s3Etag: chunks.s3Etag })
          .from(chunks)
          .where(eq(chunks.sessionId, sessionId))
          .orderBy(asc(chunks.chunkIndex));

        if (allChunks.length !== session.totalChunks) {
          throw new InternalError(
            `Chunk count mismatch: expected ${session.totalChunks}, found ${allChunks.length} in upload_chunks — ` +
            "chunks may have been cleaned up after a successful assembly; re-upload to recover if this persists",
          );
        }
        const missingEtags = allChunks.filter((c) => !c.s3Etag);
        if (missingEtags.length > 0) {
          throw new InternalError(
            `${missingEtags.length} chunk(s) are missing ETags in upload_chunks — ` +
            "parts may have been cleaned up; re-upload to recover",
          );
        }

        // ── Step 4: Validate storage_upload_parts BYTEA presence ──────────
        // upload_chunks records metadata; storage_upload_parts holds the actual
        // BYTEA. A transient failure during uploadPart() can write upload_chunks
        // without the corresponding storage_upload_parts row, causing
        // completeMultipartUpload to fail with ASSEMBLY_SEQUENCE_GAP inside the
        // transaction AFTER burning a retry attempt. Validating here surfaces the
        // mismatch with a descriptive error message before entering the assembly
        // transaction — and avoids wasting a retry on a known-unrecoverable state.
        try {
          type PartsCountRow = { cnt: string };
          const partsResult = await db.execute<PartsCountRow>(
            sql`SELECT COUNT(*)::text AS cnt FROM storage_upload_parts WHERE upload_id = ${uploadId}`,
          );
          const rows = (partsResult as unknown as { rows?: PartsCountRow[] }).rows
            ?? (partsResult as unknown as PartsCountRow[]);
          const actualPartsCount = parseInt(rows[0]?.cnt ?? "0", 10);
          if (actualPartsCount !== session.totalChunks) {
            throw new InternalError(
              `storage_upload_parts count mismatch: expected ${session.totalChunks} BYTEA rows, ` +
              `found ${actualPartsCount} for uploadId=${uploadId}. ` +
              "Parts may have been partially cleaned up — re-upload to recover.",
            );
          }
        } catch (partsErr) {
          if (partsErr instanceof InternalError) throw partsErr; // re-throw count mismatch
          // DB query itself failed — log and proceed; completeMultipartUpload will
          // surface the actual gap as ASSEMBLY_SEQUENCE_GAP or ASSEMBLY_WRONG_PART_COUNT.
          log.warn(
            { err: partsErr, sessionId, uploadId },
            "[assembly-retry] storage_upload_parts count validation failed (non-fatal) — proceeding",
          );
        }

        // ── Step 5: Assemble ─────────────────────────────────────────────
        // completeMultipartUpload assembles all staging parts from
        // storage_upload_parts into the final blob in storage_blobs.
        // The transaction deletes staging parts on success so a re-call
        // after crash would fail with ASSEMBLY_NO_PARTS — prevented above
        // by the blobAlreadyPresent shortcut.
        await storage().completeMultipartUpload({
          key: objectKey,
          uploadId,
          parts: allChunks.map((c) => ({
            partNumber: c.chunkIndex + 1,
            etag: c.s3Etag as string,
          })),
          // Pass totalChunks so completeMultipartUpload's part-count cross-check
          // fires inside the transaction in addition to our pre-check above.
          totalChunks: session.totalChunks,
          // Re-verify the assembled blob's SHA-256 against the hash the client
          // computed before the upload began. Any mismatch rolls back the transaction.
          expectedSha256: session.expectedFileSha256 ?? undefined,
        });
      }

      // ── Step 6: Verify assembled blob integrity ───────────────────────────
      const head = await storage().headObject(objectKey);
      if (!head.exists || (session.sizeBytes > 0 && head.contentLength !== session.sizeBytes)) {
        throw new InternalError(
          `Assembled blob size mismatch: expected ${session.sizeBytes} bytes, got ${head.contentLength ?? 0}`,
        );
      }

      const localVideoUrl = storage().publicUrl(objectKey);

      // ── Step 7: Commit success state ──────────────────────────────────────
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

      // ── Step 8: Post-assembly processing (same as normal finalize path) ───
      const [vRow] = await db
        .select({
          objectPath: videos.objectPath,
          faststartApplied: videos.faststartApplied,
        })
        .from(videos)
        .where(eq(videos.id, videoId))
        .limit(1);

      if (!vRow?.objectPath) {
        log.warn({ videoId }, "[assembly-retry] post-processing skipped: no objectPath after update");
        return;
      }

      // ── Step 8a: ffprobe — accurate duration + technical metadata ─────────
      // The video row was reset to transcodingStatus="none" in step 7 and may
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

      // ── Enqueue immediately as raw MP4 — no faststart required ──────────
      // Raw MP4 is broadcast-eligible via HTTP Range streaming regardless of
      // moov atom position. Enqueue now so the video enters rotation immediately.
      try {
        const enqRes = await enqueueIfMissing({ videoId, reason: "assembly-retry" });
        if (enqRes.enqueued) {
          log.info({ videoId, queueItemId: enqRes.queueItemId }, "[assembly-retry] video enrolled in broadcast queue");
          adminEventBus.push("broadcast-queue-updated", { reason: "assembly-retry", videoId });
        }
      } catch (enqErr) {
        log.warn({ err: enqErr, videoId }, "[assembly-retry] enqueueIfMissing failed (non-fatal — upload-queue-reconciler will recover within 60 s)");
      }
      adminEventBus.push("videos-library-updated", { videoId, reason: "assembly-retry-complete" });
      void invalidateVideosCatalogCache();

      log.info({ sessionId, videoId, attempt: currentAttempts }, "[assembly-retry] complete ✓");

    } catch (err) {
      // ── Failure handling: terminal fast-fail OR backoff retry ─────────────
      const errMsg = err instanceof Error ? err.message : String(err);
      const errCode = (err as { code?: string })?.code;

      // Re-read the attempt counter from DB (reflects the conditional increment above).
      const [sessionAfterFail] = await db
        .select({ assemblyAttempts: sessions.assemblyAttempts, uploadId: sessions.uploadId })
        .from(sessions)
        .where(eq(sessions.sessionId, sessionId))
        .limit(1)
        .catch(() => [] as Array<{ assemblyAttempts: number | null; uploadId: string | null }>);
      const attempts = sessionAfterFail?.assemblyAttempts ?? 1;
      const uploadIdForCleanup = sessionAfterFail?.uploadId;

      // Terminal error codes indicate data is structurally unrecoverable —
      // immediately mark permanently failed without burning the remaining retry
      // budget. This surfaces the "re-upload required" call-to-action immediately
      // instead of waiting up to ~5.5 hours for all 8 backoff windows to elapse.
      const isTerminal = errCode != null && TERMINAL_ASSEMBLY_ERROR_CODES.has(errCode);

      if (attempts >= MAX_AUTO_ASSEMBLY_ATTEMPTS || isTerminal) {
        // All auto-retry budget exhausted OR data is unrecoverable — mark
        // permanently failed so the operator sees a clear call-to-action.
        log.error(
          { err, sessionId, videoId, attempts, max: MAX_AUTO_ASSEMBLY_ATTEMPTS, isTerminal, errCode },
          "[assembly-retry] max auto-retry attempts exhausted or terminal error — marking ASSEMBLY_FAILED permanently",
        );
        await _markAssemblyPermanentlyFailed(videoId, sessionId, errMsg, log, attempts, uploadIdForCleanup);
      } else {
        // Transient failure — preserve completedVideoId so the reconciliation
        // timer can find and retry this session after the backoff window.
        const backoffMs = ASSEMBLY_BACKOFF_MS[attempts] ?? 30 * 60_000;
        log.warn(
          { err, sessionId, videoId, attempts, backoffMs, errCode },
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
// fast-path, the terminal-error fast-path, and the max-attempts-exhausted
// path in spawnAssemblyRetry.
//
// uploadId is optional: when provided, the staging BYTEA parts in
// storage_upload_parts are deleted immediately (instead of waiting for the
// 24-hour stale-session cleanup sweep) to prevent storage bloat.
async function _markAssemblyPermanentlyFailed(
  videoId: string,
  sessionId: string,
  lastError: string,
  log: FastifyInstance["log"],
  attempts?: number,
  uploadId?: string | null,
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
    // Clean up staging BYTEA parts immediately so they do not bloat
    // storage_upload_parts until the 24-hour stale-session sweep fires.
    // For a 1 GB upload (128 × 8 MB chunks) this reclaims 1 GB right away.
    // Non-fatal: if this query fails the cleanup.worker sweep will collect them.
    ...(uploadId
      ? [db.execute(sql`DELETE FROM storage_upload_parts WHERE upload_id = ${uploadId}`)
          .catch((err: unknown) => log.warn({ err, uploadId }, "[assembly-retry] parts cleanup on permanent failure (non-fatal)"))]
      : []),
  ]);
  adminEventBus.push("videos-library-updated", { videoId, reason: "assembly-retry-exhausted" });
  log.error({ videoId, sessionId, attempts, uploadId }, "[assembly-retry] permanently marked ASSEMBLY_FAILED");
}

// (DB-fallback finalization removed — MinIO is the sole storage backend)

// ─── Route plugin ─────────────────────────────────────────────────────────────

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
        // noVideoSessionIds: "assembling" sessions that crashed before the
        // atomic pre-commit (video INSERT + session.completedVideoId UPDATE)
        // completed. No video row was created, no blob was committed, no cleanup
        // required. Handled separately to avoid misaligning the orphaned* parallel
        // arrays — previously these were pushed to orphanedSessionIds[], leaving
        // orphanedVideoIds[i] as undefined for these entries, which caused
        // spawnAssemblyRetry(sid, undefined) and deleteObject(undefined) bugs.
        const noVideoSessionIds: string[] = [];
        const orphanedSessionIds: string[] = [];
        const orphanedVideoIds: string[] = [];
        const orphanedObjectKeys: string[] = [];
        const orphanedTotalChunks: number[] = [];

        for (const row of stuckRows) {
          // Sessions that never reached pre-commit (no video row yet) go into a
          // separate list — NOT orphanedSessionIds[] — to keep the parallel arrays
          // aligned. These are reset to "uploading" at the end of this block.
          if (!row.completedVideoId || !row.objectKey) {
            noVideoSessionIds.push(row.sessionId);
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
        // For sessions whose blob assembly was interrupted mid-flight, the MinIO
        // part ETags are still stored in upload_chunks. We can automatically
        // re-run assembly without asking the
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
            .catch((err: unknown) => {
              app.log.warn({ err, count: recoveredVideoIds.length }, "[upload] recovery: s3MirroredAt stamp failed — scheduling 30 s retry");
              void (async () => {
                try {
                  await new Promise<void>((r) => { const t = setTimeout(r, 30_000); t.unref(); });
                  await db.update(videos).set({ s3MirroredAt: new Date() }).where(inArray(videos.id, recoveredVideoIds));
                  app.log.info({ count: recoveredVideoIds.length }, "[upload] recovery: s3MirroredAt stamp retry succeeded");
                } catch (retryErr: unknown) {
                  app.log.warn({ err: retryErr }, "[upload] recovery: s3MirroredAt stamp retry failed — startup repair will recover on next boot");
                }
              })();
            });
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
          // any post-assembly processing that the server crash interrupted.
          for (const videoId of recoveredVideoIds) {
            void (async () => {
              try {
                const [vRow] = await db
                  .select({ objectPath: videos.objectPath, faststartApplied: videos.faststartApplied })
                  .from(videos)
                  .where(eq(videos.id, videoId))
                  .limit(1);

                if (!vRow?.objectPath) return;

                // ffprobe — accurate duration + technical metadata.
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

                // Faststart — moov-atom relocation required before broadcast.
                // The crash may have occurred after completeMultipartUpload but
                // before faststart or enqueueIfMissing ran. Running these here
                // ensures a crash-recovered blob reaches broadcast-ready status
                // immediately instead of waiting for faststartRecoveryWorker
                // (up to 6 min). Both operations are idempotent — safe to re-run.
                const fsResult = await runFaststart(videoId, vRow.objectPath, { skipStatusUpdate: false });
                if (fsResult.ok) {
                  app.log.info({ videoId, durationMs: fsResult.durationMs }, "[upload] recovery: faststart complete on crash-recovered blob");
                  adminEventBus.push("broadcast-source-upgraded", { videoId, quality: "mp4_faststart" });
                  adminEventBus.push("videos-library-updated", { videoId, reason: "recovery-faststart-complete" });
                  void invalidateVideosCatalogCache();

                  scheduleVideoValidation(videoId, vRow.objectPath, { faststartApplied: true });

                  const enqRes = await enqueueIfMissing({ videoId, reason: "assembly-recovered-on-restart" }).catch(() => null);
                  if (enqRes?.enqueued) {
                    app.log.info({ videoId, queueItemId: enqRes.queueItemId }, "[upload] recovery: enrolled crash-recovered video in broadcast queue");
                    adminEventBus.push("broadcast-queue-updated", { reason: "assembly-recovered-on-restart", videoId });
                  }
                } else {
                  // Faststart failed — faststartRecoveryWorker will retry within ~5 min.
                  app.log.warn(
                    { videoId, rootCause: fsResult.rootCause },
                    "[upload] recovery: faststart failed on crash-recovered blob — faststartRecoveryWorker will retry",
                  );
                  adminEventBus.push("videos-library-updated", { videoId, reason: "recovery-faststart-failed" });
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

        // ── Reset sessions that crashed before pre-commit ──────────────────
        // These sessions have status="assembling" but no video row and no blob —
        // the process died between the CAS lock flip and the atomic pre-commit
        // transaction. No blob or video row cleanup is needed; just reset the
        // session status so the client's finalize retry can proceed cleanly.
        if (noVideoSessionIds.length > 0) {
          await db
            .update(sessions)
            .set({ status: "uploading", updatedAt: new Date() })
            .where(inArray(sessions.sessionId, noVideoSessionIds))
            .catch((err: unknown) =>
              app.log.warn({ err, count: noVideoSessionIds.length }, "[upload] recovery: pre-commit-crashed session reset failed (non-fatal)"),
            );
          app.log.info(
            { count: noVideoSessionIds.length, ids: noVideoSessionIds },
            "[upload] recovery: reset assembling sessions that crashed before pre-commit (no video row created, no blob written)",
          );
        }
      }
    } catch (err) {
      app.log.warn({ err }, "[upload] startup assembling-session recovery failed (non-fatal)");
    }

    // ── Stale session cleanup ─────────────────────────────────────────────
    // Sessions still in "uploading" status after 48 hours were abandoned
    // (browser closed, permanent network failure, user gave up). Their chunk
    // rows (MinIO ETag records) can accumulate. Run once at startup and then
    // every 6 hours so the upload_chunks table stays lean without manual DB
    // maintenance.
    const ABANDONED_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours
    const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

    const runSessionCleanup = async () => {
      try {
        const cutoff = new Date(Date.now() - ABANDONED_AGE_MS);
        const abandoned = await db
          .select({
            sessionId: sessions.sessionId,
            uploadId: sessions.uploadId,
            assemblyUploadId: sessions.assemblyUploadId,
            objectKey: sessions.objectKey,
          })
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


          // Abort any in-progress MinIO multipart uploads for these sessions.
          // MinIO stores part data internally until aborted or completed —
          // aborting releases that storage for interrupted uploads.
          for (const sess of abandoned) {
            if (sess.uploadId && sess.objectKey) {
              await storage().abortMultipartUpload({ key: sess.objectKey, uploadId: sess.uploadId })
                .catch((err: unknown) =>
                  app.log.warn({ err, sessionId: sess.sessionId, uploadId: sess.uploadId }, "[upload] abort multipart failed (non-fatal)"),
                );
            }
          }

          await db.delete(sessions).where(inArray(sessions.sessionId, ids));
          app.log.info(
            {
              count: abandoned.length,
              ids,
              uploadIdsCleared: abandoned.filter((s) => s.uploadId).length,
              assemblyUploadIdsCleared: abandoned.filter((s) => s.assemblyUploadId).length,
            },
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
      // typical read. 120/min supports batch workflows (10 concurrent files ×
      // several retries per minute) without leaving room for runaway loops.
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },      schema: {
        tags: ["uploads"],
        summary: "Initialize a resumable chunked upload session (server-relay path)",
        body: InitBodySchema,
        response: {
          200: z.object({
            ok: z.literal(true),
            sessionId: z.string(),
            storageBackend: z.string(),
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
          storageBackend: existing.storageBackend,
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

      // Open a multipart upload slot in object storage.
      // Retry with exponential backoff + jitter so transient storage restarts
      // don't fail the entire upload init — the client would have to re-init.
      let uploadId: string | undefined = undefined;
      {
        const INIT_MAX_ATTEMPTS = 4;
        const INIT_BASE_DELAY_MS = 500;
        const INIT_TIMEOUT_MS = 8_000;
        let initErr: unknown;
        let initiated = false;
        for (let attempt = 1; attempt <= INIT_MAX_ATTEMPTS; attempt++) {
          try {
            const mpPromise = storage().createMultipartUpload({ key: objectKey, contentType });
            const timeoutPromise = new Promise<never>((_, reject) => {
              setTimeout(
                () => reject(new Error(`createMultipartUpload timed out after ${INIT_TIMEOUT_MS / 1000} s`)),
                INIT_TIMEOUT_MS,
              ).unref();
            });
            const mp = await Promise.race([mpPromise, timeoutPromise]);
            uploadId = mp.uploadId;
            initiated = true;
            break;
          } catch (err) {
            initErr = err;
            if (attempt < INIT_MAX_ATTEMPTS) {
              const delay = INIT_BASE_DELAY_MS * (2 ** (attempt - 1)) +
                Math.floor(Math.random() * 300);
              req.log.warn(
                { err, sessionId: body.sessionId, attempt, retryInMs: delay },
                "[chunked-init] createMultipartUpload transient failure — retrying",
              );
              await new Promise<void>((r) => setTimeout(r, delay).unref());
            }
          }
        }
        if (!initiated) {
          req.log.error(
            { err: initErr, sessionId: body.sessionId, attempts: INIT_MAX_ATTEMPTS },
            "[chunked-init] object storage createMultipartUpload failed after all retries",
          );
          throw Object.assign(
            new Error(
              "Object storage is temporarily unavailable. Unable to initialize upload. " +
              "Please wait a moment and retry — the upload queue will resume automatically.",
            ),
            { statusCode: 503 },
          );
        }
      }

      try {
        await db.insert(sessions).values({
          sessionId: body.sessionId,
          uploadId,
          objectKey: objectKey,
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
          storageBackend: "db",
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
        // Sanitize raw DB errors so the client receives a structured 503 instead of
        // a 500 that leaks internal pg error codes, constraint names, or stack traces.
        // A session INSERT failure is always transient (pool exhaustion, connection
        // blip) — the client can safely retry with the same sessionId.
        throw Object.assign(
          new Error(
            "Failed to initialize upload session — database temporarily unavailable. " +
            "The upload queue will retry automatically.",
          ),
          { statusCode: 503, cause: insertErr },
        );
      }

      req.log.info(
        {
          sessionId: body.sessionId,
          storageBackend: "db",
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
        storageBackend: "db",
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
      bodyLimit: 20 * 1024 * 1024,
      // Chunk uploads: adaptive chunk size is 1–16 MiB, max concurrency=4.
      // 2400/min per IP covers 10 concurrent uploads × 4 parallel chunks
      // at the maximum speed, with headroom for retries. bodyLimit raised
      // to 20 MiB to accommodate 16 MiB fast-connection chunks + headers.
      config: { rateLimit: { max: 2400, timeWindow: "1 minute" } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Abort early if the client disconnected before we start any DB work.
      // This prevents a full BYTEA write for a connection that's already gone.
      if (req.signal?.aborted) {
        return reply.code(499).send({ error: "Client disconnected before chunk was received" });
      }

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

      // Fetch the upload session. Wrap in try/catch so a DB connection pool
      // exhaustion or transient connection error returns 503 instead of 500.
      let session: typeof sessions.$inferSelect | undefined;
      try {
        session = await db
          .select()
          .from(sessions)
          .where(eq(sessions.sessionId, sessionId))
          .limit(1)
          .then((r) => r[0]);
      } catch (dbErr) {
        req.log.warn(
          { err: dbErr, sessionId, chunkIndex },
          "[chunk] DB error fetching session — returning 503",
        );
        return reply.code(503).send({
          error: "Database temporarily unavailable — the chunk will be retried automatically.",
        });
      }

      if (!session) {
        return reply.code(404).send({ error: `Upload session not found: ${sessionId}` });
      }
      if (session.status === "completed") {
        return reply.code(409).send({ error: "Session already completed" });
      }
      // Block uploads to sessions that are actively being assembled.
      // Allowing chunks into an in-flight assembly is unsafe: the assembly
      // reads exactly totalChunks rows in order — a new chunk arriving
      // mid-assembly would either be silently ignored (if its index was
      // already past the current part counter) or corrupt the assembled
      // blob (if the assembly races the DB insert). Return 409 with a
      // message that tells the client to wait and re-check status.
      if (session.status === "assembling") {
        return reply.code(409).send({
          error:
            "Upload session is currently being assembled — cannot accept new chunks. " +
            "Poll /status to wait for assembly to complete or fail.",
        });
      }

      // Reject out-of-range chunk indices to prevent phantom chunk accumulation.
      if (chunkIndex >= session.totalChunks) {
        return reply.code(400).send({
          error: `Chunk index ${chunkIndex} is out of range — session expects ${session.totalChunks} total chunks (indices 0–${session.totalChunks - 1})`,
        });
      }

      // Idempotency: chunk already received. Wrap in try/catch for the same
      // reason as the session fetch above — pool exhaustion must return 503.
      let existingChunk: { id: string; storageBackend: string | null } | undefined;
      try {
        existingChunk = await db
          .select({ id: chunks.id, storageBackend: chunks.storageBackend })
          .from(chunks)
          .where(and(eq(chunks.sessionId, sessionId), eq(chunks.chunkIndex, chunkIndex)))
          .limit(1)
          .then((r) => r[0]);
      } catch (dbErr) {
        req.log.warn(
          { err: dbErr, sessionId, chunkIndex },
          "[chunk] DB error checking idempotency — returning 503",
        );
        return reply.code(503).send({
          error: "Database temporarily unavailable — the chunk will be retried automatically.",
        });
      }

      if (existingChunk) {
        return reply.code(409).send({ ok: true, chunkIndex, storageBackend: existingChunk.storageBackend });
      }

      let body = req.body as Buffer;
      if (!body || body.length === 0) {
        return reply.code(400).send({ error: "Empty chunk body" });
      }

      // Reject chunks that would overshoot the declared total file size.
      // Without this guard a buggy or malicious client could send overlapping
      // or extended-range chunks that inflate the assembled blob beyond the
      // size declared at /init, silently corrupting the final file.
      //
      // Use session.sizeBytes (the total declared size) as the ceiling.
      // byteOffset is the 0-based start position; body.length is the chunk
      // size in bytes. A valid chunk satisfies: byteOffset + chunkSize ≤ totalBytes.
      const sizeBytes = body.length;
      if (
        byteOffset !== null &&
        session.sizeBytes != null &&
        session.sizeBytes > 0 &&
        byteOffset + sizeBytes > session.sizeBytes
      ) {
        return reply.code(400).send({
          error:
            `Chunk at offset ${byteOffset} with size ${sizeBytes} B would exceed ` +
            `the declared file size of ${session.sizeBytes} B. Re-check your chunk ` +
            `boundaries and resend.`,
        });
      }
      const actualChecksum = createHash("sha256").update(body).digest("hex");
      if (actualChecksum !== checksum) {
        return reply.code(422).send({
          error:
            `Chunk ${chunkIndex} checksum mismatch — expected ${checksum}, ` +
            `got ${actualChecksum}. The chunk was corrupted in transit; re-send it.`,
        });
      }

      const chunkId = randomUUID();

      // Bail early if the client disconnected while we were validating — no
      // point burning a DB-write slot or touching storage for a dropped upload.
      if (req.signal?.aborted) {
        return reply.code(499).send({ error: "Client disconnected" });
      }

      // Acquire a DB-write slot before touching storage. The semaphore caps
      // concurrent 8 MiB body buffers in flight so peak RSS stays bounded even
      // under a 3-file simultaneous upload with 4 parallel chunks each.
      await acquireChunkDbSlot();
      try {
        if (!session.uploadId || !session.objectKey) {
          return reply.code(400).send({
            error: "Upload session is missing MinIO multipart state. Re-initialize the upload to recover.",
          });
        }

        // Upload directly to MinIO as a multipart part (1-based partNumber).
        // Server-side retry with exponential backoff + jitter covers transient
        // MinIO restarts so the client never sees a 503 for a brief hiccup.
        const partNumber = chunkIndex + 1;
        const UPLOAD_PART_MAX_ATTEMPTS = 4;
        const UPLOAD_PART_BASE_DELAY_MS = 400;

        let etag = "";
        let lastUploadErr: unknown;
        let uploaded = false;
        for (let attempt = 1; attempt <= UPLOAD_PART_MAX_ATTEMPTS; attempt++) {
          // Abort retry loop if the client dropped the connection.
          if (req.signal?.aborted) {
            req.log.debug({ sessionId, chunkIndex, attempt }, "[chunk] client disconnected — aborting retry loop");
            return reply.code(499).send({ error: "Client disconnected" });
          }
          try {
            const result = await storage().uploadPart({
              key: session.objectKey,
              uploadId: session.uploadId,
              partNumber,
              body,
            });
            etag = result.etag;
            uploaded = true;
            break;
          } catch (err) {
            lastUploadErr = err;
            if (attempt < UPLOAD_PART_MAX_ATTEMPTS) {
              const delay = UPLOAD_PART_BASE_DELAY_MS * (2 ** (attempt - 1)) +
                Math.floor(Math.random() * 200);
              req.log.warn(
                { err, sessionId, chunkIndex, partNumber, attempt, retryInMs: delay },
                "[chunk] uploadPart transient failure — retrying",
              );
              // Use a cancellable timer so we don't hold the slot open for a
              // disconnected client during the backoff delay.
              await new Promise<void>((resolve) => {
                const t = setTimeout(resolve, delay);
                t.unref();
                req.signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
              });
            }
          }
        }

        if (!uploaded) {
          req.log.error(
            { err: lastUploadErr, sessionId, chunkIndex, partNumber, attempts: UPLOAD_PART_MAX_ATTEMPTS },
            "[chunk] uploadPart failed after all retries — chunk NOT saved; client will retry",
          );
          return reply.code(503).send({
            error:
              "Object storage is temporarily unavailable after retries. The chunk was not saved. " +
              "It will be retried automatically with exponential backoff.",
          });
        }

        try {
          // body is no longer needed — release the 8 MiB buffer for GC
          // before the next await (the chunks INSERT) so it isn't kept alive
          // across the full ~13-15 s DB write.
          body = Buffer.alloc(0);
          (req as any).body = null;

          // Disconnect check after uploadPart(): the BYTEA row is already in
          // storage_upload_parts (idempotent and durable). Skip the metadata
          // INSERT if the socket is gone — it wastes a write slot and the
          // upload-integrity monitor will reconcile any part-without-metadata
          // rows on its next cycle (or the client will re-send the chunk on
          // resume, triggering the idempotency 409 path via the existing check).
          if (req.signal?.aborted) {
            req.log.debug(
              { sessionId, chunkIndex, partNumber },
              "[chunk] client disconnected after uploadPart — skipping metadata insert (part is safe in storage)",
            );
            return reply.code(499).send({ error: "Client disconnected" });
          }

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
            "[chunk] DB insert failed after successful uploadPart — chunk NOT saved; client will retry",
          );
          return reply.code(503).send({
            error:
              "Storage write succeeded but metadata could not be saved. " +
              "The chunk will be retried automatically.",
          });
        }
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
      // Called once per upload resume attempt: 200/min covers normal use
      // (10 concurrent files × several resume checks) with headroom for retries.
      config: { rateLimit: { max: 200, timeWindow: "1 minute" } },      schema: {
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
      // Finalize triggers DB assembly + transcoding job insertion. 120/min
      // matches the init limit — both create durable server-side work, and
      // bulk batch workflows can finalize 10+ files in rapid succession.
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },      schema: {
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
          499: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { sessionId } = req.params;

      // Abort early if the client disconnected before we begin. The background
      // assembly task that finalize spawns is self-contained and must NOT be
      // gated on the request signal — only the synchronous pre-commit work is
      // aborted here.
      if (req.signal?.aborted) {
        throw Object.assign(
          new Error("Client disconnected before finalize could start"),
          { statusCode: 499 },
        );
      }

      // Wrap session SELECT in try/catch so a DB pool exhaustion or transient
      // connection error returns 503 instead of an unhandled 500. The upload
      // queue will automatically retry finalization.
      let session: typeof sessions.$inferSelect | undefined;
      try {
        session = await db
          .select()
          .from(sessions)
          .where(eq(sessions.sessionId, sessionId))
          .limit(1)
          .then((r) => r[0]);
      } catch (dbErr) {
        req.log.warn({ err: dbErr, sessionId }, "[finalize] DB error fetching session — returning 503");
        throw Object.assign(
          new Error("Database temporarily unavailable — please retry finalization in a moment."),
          { statusCode: 503, cause: dbErr },
        );
      }

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
      // Wrap the CAS lock UPDATE in try/catch so a DB pool exhaustion returns
      // 503 instead of an unhandled 500. On failure the session stays 'uploading'
      // — the client can retry finalize immediately.
      let lockResult: Array<{ sessionId: string }>;
      try {
        lockResult = await db
          .update(sessions)
          .set({ status: "assembling", updatedAt: new Date() })
          .where(and(eq(sessions.sessionId, sessionId), eq(sessions.status, "uploading")))
          .returning({ sessionId: sessions.sessionId });
      } catch (dbErr) {
        req.log.warn({ err: dbErr, sessionId }, "[finalize] DB error acquiring assembly lock — returning 503");
        throw Object.assign(
          new Error("Database temporarily unavailable — please retry finalization in a moment."),
          { statusCode: 503, cause: dbErr },
        );
      }

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
        // Threshold: 30 minutes. We also respect ASSEMBLY_WATCHDOG_MS
        // (default 90 min) as a hard upper bound. 30 minutes means: if no
        // progress marker (completedVideoId) appears within 30 min, the
        // assembler is assumed dead and the lock is released.
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

      // Load all received chunks, ordered by index (ETag metadata only).
      // Wrap in try/catch — a DB error here must reset the lock and return 503
      // (not 500) so the client can retry finalization.
      let allChunks: Array<{
        id: string;
        sessionId: string;
        chunkIndex: number;
        checksum: string;
        sizeBytes: number;
        byteOffset: number | null;
        s3Etag: string | null;
        storageBackend: string | null;
        receivedAt: Date | null;
      }>;
      try {
        allChunks = await db
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
      } catch (dbErr) {
        await resetLock();
        req.log.warn({ err: dbErr, sessionId }, "[finalize] DB error loading chunks — lock released, returning 503");
        throw Object.assign(
          new Error("Database temporarily unavailable loading chunk list — please retry finalization."),
          { statusCode: 503, cause: dbErr },
        );
      }

      // Fast-path: if the client already disconnected while we were acquiring
      // the assembly lock, release it immediately rather than running 5 heavy
      // pre-flight DB queries against a dead connection.
      if (req.signal?.aborted) {
        await resetLock();
        return reply.code(499).send({ error: "Client disconnected before finalize pre-flight" });
      }

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

      // ── Storage layer integrity pre-flight ─────────────────────────────────
      // Verify that storage_upload_parts has exactly session.totalChunks BYTEA
      // rows for this uploadId.  The chunk count check above validated
      // upload_chunks (metadata), but uploadPart() writes to storage_upload_parts
      // (BYTEA data) in a separate DB call.  If that second write fails (e.g. a
      // transient DB hiccup between the two INSERTs), the metadata says N chunks
      // but the storage has < N parts.  completeMultipartUpload would then fail
      // inside the transaction with ASSEMBLY_SEQUENCE_GAP after the video row
      // has already been pre-committed — creating a dangling video in a failed
      // state.
      //
      // Checking here (before pre-commit) lets us reset the session lock and
      // give the client a clear, actionable error so it can re-upload only the
      // missing chunks without touching the video row.
      if (session.uploadId) {
        type PartsCountRow = { cnt: string };
        const partsCountResult = await db.execute<PartsCountRow>(sql`
          SELECT COUNT(*)::text AS cnt
          FROM storage_upload_parts
          WHERE upload_id = ${session.uploadId}
        `).catch(() => null);
        const partsCountRows: PartsCountRow[] = partsCountResult
          ? ((partsCountResult as unknown as { rows?: PartsCountRow[] }).rows ??
             (partsCountResult as unknown as PartsCountRow[]))
          : [];
        const actualPartsCount = parseInt(partsCountRows[0]?.cnt ?? "0", 10);

        if (actualPartsCount !== session.totalChunks) {
          // Query which part numbers are present so the error message names the
          // specific chunks that need to be re-uploaded.
          type PartNumRow = { part_number: number };
          const presentPartsResult = await db.execute<PartNumRow>(sql`
            SELECT part_number
            FROM storage_upload_parts
            WHERE upload_id = ${session.uploadId}
            ORDER BY part_number ASC
          `).catch(() => null);
          const presentRows: PartNumRow[] = presentPartsResult
            ? ((presentPartsResult as unknown as { rows?: PartNumRow[] }).rows ??
               (presentPartsResult as unknown as PartNumRow[]))
            : [];
          const presentSet = new Set(presentRows.map((r) => r.part_number));
          const missingPartNums = Array.from(
            { length: session.totalChunks },
            (_, i) => i + 1,
          ).filter((n) => !presentSet.has(n));

          await resetLock();
          req.log.error(
            {
              sessionId,
              uploadId: session.uploadId,
              expectedParts: session.totalChunks,
              actualParts: actualPartsCount,
              missingPartNumbers: missingPartNums.slice(0, 20),
            },
            "[finalize] storage integrity pre-flight FAILED — storage_upload_parts count mismatch",
          );
          throw Object.assign(
            new Error(
              `Storage integrity check failed: received ${allChunks.length} chunk records ` +
              `but storage_upload_parts only has ${actualPartsCount} BYTEA data rows ` +
              `(expected ${session.totalChunks}) for uploadId=${session.uploadId}. ` +
              (missingPartNums.length > 0
                ? `Missing chunk part numbers (1-based): ${missingPartNums.slice(0, 10).join(", ")}` +
                  (missingPartNums.length > 10 ? ` … and ${missingPartNums.length - 10} more` : "") +
                  `. Re-upload these chunks before retrying finalization.`
                : "Re-upload the missing chunks before retrying finalization."),
            ),
            { statusCode: 422 },
          );
        }

        req.log.debug(
          { sessionId, uploadId: session.uploadId, partsCount: actualPartsCount },
          "[finalize] storage_upload_parts count verified ✓",
        );
      }

      // Disconnect check after storage pre-flight: if the client dropped the
      // connection during the parts-count query, abort before pre-committing
      // the video row. The session stays in 'assembling' — the client's next
      // retry will re-acquire the lock and complete the pre-flight cleanly.
      if (req.signal?.aborted) {
        await resetLock();
        return reply.code(499).send({ error: "Client disconnected before video row commit" });
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
      if (!session.uploadId || !session.objectKey) {
        await resetLock();
        throw Object.assign(
          new Error(
            "Upload session is missing required MinIO multipart state (uploadId or objectKey). " +
            "Re-initialize the upload to recover.",
          ),
          { statusCode: 400 },
        );
      }

      {
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

        // ── Atomic pre-commit: video INSERT + session.completedVideoId UPDATE ──
        //
        // Previously these were two separate DB writes. A server crash between
        // them left the video row with no session link (completedVideoId=null),
        // causing onReady to classify the session as "crashed before pre-commit"
        // and reset it to "uploading" — permanently orphaning the video row even
        // though the client had already received a 200 with the videoId.
        //
        // With a single db.transaction() call:
        //   • Either BOTH the video INSERT and the completedVideoId UPDATE commit
        //     atomically, or NEITHER does (ROLLBACK on any error).
        //   • On crash between the client's 200 and the server's COMMIT, Postgres
        //     rolls back both writes, leaving the session in a clean "assembling"
        //     state that onReady can safely detect and recover.
        //   • On transient DB error the lock is released and the client can retry
        //     finalization with no stale state to clean up.
        let row: typeof videos.$inferSelect;
        try {
          row = await db.transaction(async (tx) => {
            const [inserted] = await tx
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
                transcodingStatus: "none", // blob not yet committed; faststart pending
              })
              .returning();

            if (!inserted) {
              throw new InternalError("videos INSERT returned no rows — database may be under load");
            }

            // Atomically link the new video row to the session so the idempotency
            // guard, finalize-status poller, and onReady recovery all see the link
            // immediately. sweepOrphanedSessions checks completedVideoId to decide
            // whether to treat a session as abandoned — this update ensures it is
            // set before the server responds and before any crash window opens.
            await tx
              .update(sessions)
              .set({ completedVideoId: inserted.id, updatedAt: new Date() })
              .where(eq(sessions.sessionId, sessionId));

            return inserted;
          });
        } catch (insertErr) {
          await resetLock();
          req.log.error({ err: insertErr, sessionId, videoId }, "[finalize] atomic pre-commit transaction failed — lock released");
          throw Object.assign(
            new Error(
              "Failed to create video record — database temporarily unavailable. " +
              "The upload is safe; please retry finalization.",
            ),
            { statusCode: 503, cause: insertErr },
          );
        }

        // The video will be enrolled in the broadcast queue (MP4-first) by the
        // background assembly task once the blob is confirmed in storage.
        // The transcoder dispatcher upgrades the queue row to HLS automatically
        // when transcoding completes — no re-enqueue needed.

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
                  .set({
                    status: "uploading",
                    // CRITICAL: preserve completedVideoId — clearing it here
                    // permanently orphans this video from the reconciliation timer
                    // and auto-retry logic.  The timer queries for sessions WHERE
                    // completedVideoId IS NOT NULL to find retryable uploads; a null
                    // here means the video is never retried automatically.
                    // completedVideoId: null   ← intentionally removed
                    assemblyAttempts: sql`assembly_attempts + 1`,
                    updatedAt: new Date(),
                  })
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
              // Pass totalChunks so completeMultipartUpload's part-count cross-check
              // fires inside the SQL transaction in addition to the pre-flight check
              // that ran before the background task started. Belt-and-suspenders.
              totalChunks: session.totalChunks,
              // Pass the client-declared whole-file SHA-256 so completeMultipartUpload
              // can verify the assembled blob inside the transaction before committing.
              // sha256(data) runs server-side in PostgreSQL — only the 32-byte hash
              // crosses the wire, so this is O(1) Node.js memory regardless of file size.
              // Any mismatch causes the transaction to roll back: no corrupt blob is
              // ever committed to storage_blobs.
              expectedSha256: session.expectedFileSha256 ?? undefined,
            });
            // Blob is now committed in storage_blobs.  Any exception thrown
            // after this point must NOT delete the object.
            assemblyCommitted = true;

            // NOTE: Post-assembly blob size and SHA-256 integrity are now validated
            // INSIDE the completeMultipartUpload transaction:
            //   1. Part sequence validation (no gaps in part_number 1..N)
            //   2. Per-part non-empty check (octet_length > 0 for every part)
            //   3. Assembly size check (octet_length(data) == sum of part sizes)
            //   4. End-to-end SHA-256 (computed server-side, zero Node.js memory)
            // Any failure rolls back the transaction — no partial blob is committed.
            // The external headObject size check that previously ran here has been
            // removed: it was checking a size mismatch that can no longer occur.

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
                .catch((err: unknown) => {
                  capturedLog.warn(
                    { err, videoId },
                    "[finalize:bg] s3MirroredAt stamp failed — scheduling 30 s retry",
                  );
                  // Schedule a self-healing retry so broadcast admission isn't
                  // gated until the next server restart.  Two attempts covers
                  // the vast majority of transient DB blips; any surviving
                  // gap is caught by repairMissingS3MirroredAt() on next boot.
                  void (async () => {
                    try {
                      await new Promise<void>((r) => { const t = setTimeout(r, 30_000); t.unref(); });
                      await db.update(videos).set({ s3MirroredAt: new Date() }).where(eq(videos.id, videoId));
                      capturedLog.info({ videoId }, "[finalize:bg] s3MirroredAt stamp retry succeeded");
                    } catch (retryErr: unknown) {
                      capturedLog.warn(
                        { err: retryErr, videoId },
                        "[finalize:bg] s3MirroredAt stamp retry failed — startup repair will recover on next boot",
                      );
                    }
                  })();
                }),
            ]);
            // Notify all connected admin tabs that this upload is fully assembled
            // and in storage.  Tabs that did NOT initiate the upload (i.e. editors
            // with the admin open in a background tab) will display a toast so they
            // know new content is available without polling.
            // NOTE: fires BEFORE thumbnail/faststart/HLS so editors get the
            // "upload done" signal as soon as possible; source upgrades arrive
            // via separate broadcast-source-upgraded / transcoding-update events.
            adminEventBus.push("upload-assembly-complete", {
              videoId,
              title: row.title ?? "",
              sessionId,
            });

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
              // Do NOT set transcodingStatus=ready yet — the faststart pipeline
              // below owns that transition.  Only metadata patches go here.
              if (Object.keys(patch).length > 0) {
                await db.update(videos).set(patch).where(eq(videos.id, videoId));
                void invalidateVideosCatalogCache();
                adminEventBus.push("videos-library-updated", { videoId, reason: "thumbnail-generated" });
              }
              // Capture for the post-enqueue broadcast_queue duration stamp below.
              const durSecs = probedSecs ?? mediaMeta.durationSecs;
              if (durSecs != null && durSecs > 10) ffprobeDurSecs = durSecs;
            } catch (err) {
              capturedLog.warn({ err, videoId }, "[finalize:bg] post-upload probes failed (non-fatal)");
              // Probes are non-fatal — faststart runs regardless.
            }

            // ── Enqueue immediately after blob confirmation ────────────────────
            // Raw MP4 is broadcast-eligible via HTTP Range streaming regardless of
            // moov atom position — the client can seek to any byte offset on demand.
            // Faststart (moov relocation) is a background quality optimisation that
            // runs below: the video enters the queue NOW so the broadcast never waits
            // for moov relocation to complete. The orchestrator picks up the optimised
            // blob automatically via the broadcast-source-upgraded event fired below.
            //
            // Retry policy: up to 3 attempts with 5 s delays per attempt.
            // If all fail, upload-queue-reconciler picks the video up within 60 s
            // as the final backstop.
            {
              const enqReason = "upload-finalize" as const;
              const MAX_ENQ_ATTEMPTS = 3;
              const ENQ_RETRY_DELAY_MS = 5_000;
              let enqueued = false;
              let queueItemId: string | undefined;
              let lastEnqSkipReason: string | undefined;

              for (let attempt = 1; attempt <= MAX_ENQ_ATTEMPTS; attempt++) {
                try {
                  const enqRes = await enqueueIfMissing({ videoId, reason: enqReason });
                  if (enqRes.enqueued) {
                    enqueued = true;
                    queueItemId = enqRes.queueItemId;
                    break;
                  }
                  lastEnqSkipReason = enqRes.skipReason;
                  if (enqRes.skipReason !== "error") break;
                  if (attempt < MAX_ENQ_ATTEMPTS) {
                    capturedLog.warn(
                      { videoId, attempt, skipReason: enqRes.skipReason },
                      "[finalize:bg] enqueueIfMissing returned error — retrying",
                    );
                    await new Promise<void>((resolve) => setTimeout(resolve, ENQ_RETRY_DELAY_MS).unref());
                  }
                } catch (enqErr) {
                  lastEnqSkipReason = "error";
                  if (attempt < MAX_ENQ_ATTEMPTS) {
                    capturedLog.warn(
                      { err: enqErr, videoId, attempt },
                      "[finalize:bg] enqueueIfMissing threw — retrying",
                    );
                    await new Promise<void>((resolve) => setTimeout(resolve, ENQ_RETRY_DELAY_MS).unref());
                  } else {
                    capturedLog.warn(
                      { err: enqErr, videoId },
                      "[finalize:bg] enqueueIfMissing failed after all retries (non-fatal — upload-queue-reconciler will recover within 60 s)",
                    );
                  }
                }
              }

              if (enqueued) {
                capturedLog.info(
                  { videoId, queueItemId, reason: enqReason },
                  "[finalize:bg] video enrolled in broadcast queue immediately after upload",
                );
                // Update queue row with accurate ffprobe duration.
                if (ffprobeDurSecs != null && ffprobeDurSecs > 10) {
                  await db
                    .update(schema.broadcastQueueTable)
                    .set({ durationSecs: Math.round(ffprobeDurSecs) })
                    .where(eq(schema.broadcastQueueTable.videoId, videoId))
                    .catch((err: unknown) =>
                      capturedLog.warn({ err, videoId }, "[finalize:bg] queue duration_secs update failed (non-fatal)"),
                    );
                }
                adminEventBus.push("broadcast-queue-updated", { reason: enqReason, videoId });

                // Post-enqueue verification: confirm the active row is visible in the
                // DB so we can alert immediately if the insert silently failed.
                const verified = await db
                  .select({ id: schema.broadcastQueueTable.id })
                  .from(schema.broadcastQueueTable)
                  .where(
                    and(
                      eq(schema.broadcastQueueTable.videoId, videoId),
                      eq(schema.broadcastQueueTable.isActive, true),
                    ),
                  )
                  .limit(1)
                  .catch(() => []);
                if (verified.length === 0) {
                  capturedLog.warn(
                    { videoId },
                    "[finalize:bg] post-enqueue verification FAILED — queue row not found; upload-queue-reconciler will re-enqueue within 60 s",
                  );
                } else {
                  capturedLog.info(
                    { videoId, queueRowId: verified[0]!.id },
                    "[finalize:bg] post-enqueue verification OK — queue row confirmed active",
                  );
                }
              } else {
                capturedLog.info(
                  { videoId, skipReason: lastEnqSkipReason },
                  "[finalize:bg] video already in broadcast queue or not yet eligible — skipping enqueue",
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

            if (assemblyCommitted) {
              // ── Post-assembly step threw — blob is INTACT ──────────────────
              // completeMultipartUpload already committed the blob atomically;
              // the exception came from a later step (probes, faststart,
              // enqueueIfMissing, or an adminEventBus call).
              // The blob is safe and the video row is valid.
              //
              // CRITICAL: do NOT mark the video transcodingStatus="failed" here.
              // Using CORRUPT_SOURCE would permanently exclude this video from
              // reactivateSystemDeactivated() (which explicitly skips
              // CORRUPT_SOURCE/SOURCE_MISSING/ASSEMBLY_FAILED rows), making the
              // video unreachable from the broadcast queue forever with no
              // auto-recovery path.
              //
              // Automatic recovery (no operator action required, ≤60 s):
              //   1. repairMissingS3MirroredAt() (runs in uploadQueueReconciler
              //      and before every scanLibraryAndEnqueue) stamps s3MirroredAt
              //      if the post-assembly DB update was the step that failed.
              //   2. uploadQueueReconciler.scan() (every 60 s) calls
              //      enqueueIfMissing() once s3MirroredAt IS NOT NULL.
              //   3. queueHealthGuard.scan() (every 10 min) as final backstop.
              capturedLog.error(
                {
                  err,
                  sessionId,
                  videoId,
                  objectKey: session.objectKey,
                  assemblyMs: Date.now() - assemblyStartMs,
                },
                "[finalize:bg] POST-ASSEMBLY STEP FAILED — blob is committed and intact; " +
                "video stays at transcodingStatus=none; uploadQueueReconciler will " +
                "re-stamp s3MirroredAt + enqueue within 60 s. No operator action needed.",
              );
              // Video row remains at transcodingStatus="none" + s3MirroredAt=null
              // (or already stamped). The reconciler stamps it and enqueues within 60 s.
              void invalidateVideosCatalogCache();
              adminEventBus.push("videos-library-updated", {
                videoId,
                reason: "assembly-post-step-failed",
              });
              uploadTelemetry.serverFail(
                sessionId,
                session.sizeBytes,
                "assembly_post_step_failed",
                err instanceof Error ? err.message : "Post-assembly step failed (blob intact)",
              );
            } else {
              // ── Assembly itself failed — blob NOT committed ─────────────────
              // completeMultipartUpload threw or rolled back; the blob is absent
              // or partial. Mark the video failed so the validator can deactivate
              // any stale queue row, and reset the session to "uploading" so the
              // operator can retry from the upload panel.
              capturedLog.error(
                { err, sessionId, videoId, assemblyMs: Date.now() - assemblyStartMs },
                "[finalize:bg] ASSEMBLY FAILED — blob not committed; resetting session for operator retry",
              );
              // Best-effort orphan cleanup: delete the partial blob at the dest key
              // so the next finalize retry starts from a clean slate.
              if (session.objectKey) {
                capturedLog.warn(
                  { sessionId, videoId, objectKey: session.objectKey },
                  "[finalize:bg] deleting uncommitted partial assembly blob",
                );
                void storage().deleteObject(session.objectKey).catch(() => {});
              }
              await Promise.allSettled([
                db
                  .update(videos)
                  .set({
                    transcodingStatus: "failed",
                    transcodingErrorCode: "ASSEMBLY_FAILED",
                    transcodingErrorMessage:
                      `Assembly failed after ${Date.now() - assemblyStartMs} ms — ` +
                      "the blob was not committed (transaction rolled back). " +
                      "Reset the session from the upload panel and retry the upload to recover.",
                  })
                  .where(eq(videos.id, videoId)),
                db
                  .update(sessions)
                  .set({
                    status: "uploading",
                    // CRITICAL: preserve completedVideoId so the reconciliation timer
                    // can find this session for spawnAssemblyRetry with backoff.
                    // Clearing it here permanently orphans the video from auto-recovery.
                    // completedVideoId: null   ← intentionally preserved
                    assemblyAttempts: sql`assembly_attempts + 1`,
                    updatedAt: new Date(),
                  })
                  .where(eq(sessions.sessionId, sessionId)),
              ]);
              // Invalidate catalog cache so TV/mobile clients stop seeing this
              // video as "queued" for the full cache TTL after it has been failed.
              void invalidateVideosCatalogCache();
              adminEventBus.push("videos-library-updated", { videoId, reason: "assembly-failed" });
              uploadTelemetry.serverFail(
                sessionId,
                session.sizeBytes,
                "assembly_failed",
                err instanceof Error ? err.message : "Assembly failed",
              );
            }
          }
        })();

        return {
          ...projectRow(row),
          storageBackend: "db" as const,
          transcodingWarning: null,
        };
      }


      // Unreachable: the block above always returns when uploadId and objectKey are set.
      throw Object.assign(
        new Error("[finalize] internal error: assembly path not resolved"),
        { statusCode: 500 },
      );
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
      // Client polls every 2 s during assembly. 200/min covers 10 concurrent
      // uploads + generous headroom for tab-restore reconnects and retries.
      config: { rateLimit: { max: 200, timeWindow: "1 minute" } },      schema: {
        tags: ["uploads"],
        summary: "Poll the finalization status of an upload session",
        params: z.object({ sessionId: z.string().min(1).max(128) }),
        response: {
          200: z.object({
            status: z.enum(["uploading", "assembling", "completed", "not_found"]),
            videoId: z.string().nullable(),
            /** Real assembly progress 0–99 derived from storage_blobs.size_bytes.
             *  Null when status is not "assembling" or when the storage query fails. */
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
        // assemblyPercent is always null with the transactional bytea_agg assembly:
        // the entire INSERT runs inside a single PostgreSQL transaction and the new
        // storage_blobs row is only visible to other connections after COMMIT.
        // There is no intermediate state to query — the client should show an
        // indeterminate progress indicator during assembly.
        return { status: "assembling" as const, videoId: session.completedVideoId ?? null, assemblyPercent: null };
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
