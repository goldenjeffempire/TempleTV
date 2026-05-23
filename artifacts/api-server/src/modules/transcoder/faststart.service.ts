/**
 * MP4 faststart post-processor.
 *
 * Runs `ffmpeg -c copy -movflags +faststart` on a newly-uploaded video to
 * relocate the moov atom from the end of the file to the beginning. This is a
 * stream-copy (no re-encoding) so it completes in seconds even for 300 MB
 * files. After processing, the video starts playing from the very first byte
 * — browsers can parse metadata immediately without an HTTP Range round-trip.
 *
 * Lifecycle written to managed_videos.transcoding_status:
 *   queued (upload complete) → processing → ready     (success)
 *                                          → <prior>   (failure — restored, not 'failed')
 *
 * Always call as `void runFaststart(...)` — intentionally non-blocking so
 * the finalize HTTP response returns immediately.
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { storage } from "../../infrastructure/storage.js";
import { logger as rootLogger } from "../../infrastructure/logger.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { invalidateVideosCatalogCache } from "../videos/videos.routes.js";
import { enqueueIfMissing } from "../broadcast/auto-enqueue.service.js";

const videos = schema.videosTable;

/** Hard upper bound — kills ffmpeg if it hangs on a corrupt moov. */
const FASTSTART_TIMEOUT_MS = 15 * 60_000;
const PROBE_TIMEOUT_MS = 30_000;
/**
 * Chunk size used when uploading the faststarted file back to storage via
 * the multipart path. 8 MiB matches the upload-engine chunk size and keeps
 * each individual pg parameter string well below the ERR_STRING_TOO_LONG
 * threshold (~1 GiB) even on Node.js versions that enforce a 512 MiB cap.
 */
const FASTSTART_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB

export interface FaststartResult {
  elapsedMs: number;
  outputSizeBytes: number;
  durationSecs: number | null;
}

export interface FaststartOptions {
  /**
   * When true, faststart will NOT update `transcodingStatus` on
   * managed_videos. Use this when the HLS transcoder is also running on the
   * same video so that faststart doesn't overwrite the authoritative
   * "encoding" / "hls_ready" state that the transcoder owns.
   * Duration and sizeBytes are always updated regardless of this flag.
   */
  skipStatusUpdate?: boolean;
}

/**
 * Apply MP4 faststart to an uploaded video stored in object storage.
 *
 * Steps:
 *   1. Snapshot priorTranscodingStatus; mark video as `processing`.
 *   2. Download the blob from storage to a local temp file.
 *   3. Run ffmpeg -c copy -movflags +faststart.
 *   4. Run ffprobe to measure exact duration.
 *   5. Re-upload via multipart: createMultipartUpload → uploadPart (8 MiB
 *      chunks) → completeMultipartUpload. The original key remains readable
 *      throughout — no 404 window, no data-loss risk if the upload fails.
 *   6. Update managed_videos: faststartApplied=true, transcodingStatus='ready',
 *      duration, sizeBytes.
 *   7. Fire videos-library-updated + broadcast-queue-updated so the admin UI
 *      refreshes and the orchestrator reloads without operator action.
 *
 * On failure:
 *   - The original blob at objectKey is NEVER deleted; it remains intact and
 *     playable (moov may still be at EOF, but the file is not lost).
 *   - transcodingStatus is restored to its pre-faststart value (not 'failed'),
 *     so the queue item stays admitted and the video continues to air.
 *   - Any in-progress multipart upload is aborted to clean up _parts/* rows.
 *
 * The scratch directory is always cleaned up in the finally block.
 */
export async function runFaststart(
  videoId: string,
  objectKey: string,
  options: FaststartOptions = {},
): Promise<FaststartResult> {
  const log = rootLogger.child({ service: "faststart", videoId, objectKey, skipStatusUpdate: options.skipStatusUpdate ?? false });
  const scratchDir = path.join(os.tmpdir(), `faststart-${randomUUID()}`);
  const inputPath = path.join(scratchDir, "input.mp4");
  const outputPath = path.join(scratchDir, "output.mp4");
  const startMs = Date.now();

  // Snapshot the current transcodingStatus so we can restore it on failure.
  // We do this unconditionally (even when skipStatusUpdate=true) to have the
  // value available if the catch block needs it.
  let priorTranscodingStatus = "none";
  if (!options.skipStatusUpdate) {
    try {
      const [row] = await db
        .select({ transcodingStatus: videos.transcodingStatus })
        .from(videos)
        .where(eq(videos.id, videoId))
        .limit(1);
      priorTranscodingStatus = row?.transcodingStatus ?? "none";
    } catch {
      // Non-fatal; priorTranscodingStatus stays "none" which is always admitted.
    }
  }

  try {
    await mkdir(scratchDir, { recursive: true });

    if (!options.skipStatusUpdate) {
      await db
        .update(videos)
        .set({ transcodingStatus: "processing" })
        .where(eq(videos.id, videoId));
    }

    log.info("faststart: downloading source from storage");
    const { body } = await storage().getObject(objectKey);
    await pipeline(body, createWriteStream(inputPath));

    log.info("faststart: running ffmpeg -movflags +faststart");
    await spawnFfmpegFaststart(inputPath, outputPath, log);

    const { size: outputSizeBytes } = await stat(outputPath);

    log.info("faststart: probing duration");
    const durationSecs = await probeDuration(outputPath, log);

    // ── Atomic multipart re-upload ────────────────────────────────────────────
    // Replace the storage blob using the multipart path so that:
    //   • The original key remains fully readable until completeMultipartUpload
    //     fires — there is no 404 window (the old delete-then-putObject pattern
    //     created a window proportional to the re-upload time).
    //   • No video bytes enter Node.js heap as a single Buffer — each part is
    //     ≤ 8 MiB, eliminating the ERR_STRING_TOO_LONG risk for large files.
    //   • completeMultipartUpload assembles parts with SQL `bytea || bytea`
    //     and UPSERTS the final key atomically in one round-trip.
    //   • If any part upload or the final assembly fails the original key is
    //     still intact; we abort to clean up the orphaned _parts/* rows.
    log.info({ outputSizeBytes, durationSecs }, "faststart: re-uploading to storage via multipart");
    let uploadId: string | undefined;
    try {
      ({ uploadId } = await storage().createMultipartUpload({
        key: objectKey,
        contentType: "video/mp4",
      }));
      const parts: Array<{ partNumber: number; etag: string }> = [];
      const fh = await open(outputPath, "r");
      try {
        let offset = 0;
        let partNum = 1;
        while (offset < outputSizeBytes) {
          const chunkSize = Math.min(FASTSTART_CHUNK_SIZE, outputSizeBytes - offset);
          const buf = Buffer.allocUnsafe(chunkSize);
          await fh.read(buf, 0, chunkSize, offset);
          const { etag } = await storage().uploadPart({
            key: objectKey,
            uploadId,
            partNumber: partNum,
            body: buf,
          });
          parts.push({ partNumber: partNum, etag });
          partNum++;
          offset += chunkSize;
        }
      } finally {
        await fh.close();
      }
      await storage().completeMultipartUpload({ key: objectKey, uploadId, parts });
    } catch (uploadErr) {
      // Abort the multipart upload so orphaned _parts/* rows don't accumulate.
      if (uploadId) {
        await storage()
          .abortMultipartUpload({ key: objectKey, uploadId })
          .catch((abortErr) =>
            log.warn({ abortErr }, "faststart: abortMultipartUpload failed — _parts rows may leak"),
          );
      }
      throw uploadErr;
    }
    // ── End multipart re-upload ───────────────────────────────────────────────

    const patch: Partial<typeof videos.$inferInsert> = {
      sizeBytes: outputSizeBytes,
      // Always mark faststart as applied on success, regardless of
      // skipStatusUpdate. The broadcast-v2 queue uses this flag to
      // distinguish "HLS transcoder failed after faststart succeeded"
      // (localVideoUrl IS seekable → safe to broadcast) from "faststart
      // itself failed" (raw upload, moov at EOF → must not broadcast).
      faststartApplied: true,
    };
    if (durationSecs != null) {
      patch.duration = String(Math.round(durationSecs));
    }
    // Only take ownership of transcodingStatus when the HLS transcoder is not
    // active. When skipStatusUpdate=true the transcoder owns this field and
    // setting it to "ready" here would overwrite "encoding" or "hls_ready".
    if (!options.skipStatusUpdate) {
      patch.transcodingStatus = "ready";
    }
    await db
      .update(videos)
      .set(patch)
      .where(
        options.skipStatusUpdate
          ? eq(videos.id, videoId)
          // Extra safety: don't overwrite a completed HLS transcode even when
          // skipStatusUpdate=false (e.g. if the transcoder finished while
          // faststart was running on a very large file).
          : and(eq(videos.id, videoId), ne(videos.transcodingStatus, "hls_ready")),
      );

    void invalidateVideosCatalogCache();
    adminEventBus.push("videos-library-updated", { videoId, reason: "faststart-complete" });
    // Trigger an orchestrator reload so the broadcast queue picks up the
    // faststarted file. The reload clears the bad-URL cache so items that
    // entered SKIP_PENDING while the file was being re-uploaded are
    // unblocked and promoted to LIVE without operator intervention.
    adminEventBus.push("broadcast-queue-updated", { reason: "faststart-complete", videoId });

    // Auto-add to broadcast queue if not already there.
    // Videos are only enqueued AFTER faststart so the player always receives
    // a moov-at-byte-0 (seekable) MP4 — never a raw upload with moov at EOF
    // that causes player timeouts and infinite SKIP_PENDING dead-air loops.
    // enqueueIfMissing handles de-dup, playability check, and bus signal
    // internally — no need for a manual EXISTS query here.
    const enqueueResult = await enqueueIfMissing({ videoId, reason: "upload-finalize" });
    if (enqueueResult.enqueued) {
      log.info({ videoId, queueItemId: enqueueResult.queueItemId }, "faststart: auto-added video to broadcast queue");
    } else {
      log.debug({ videoId, skipReason: enqueueResult.skipReason }, "faststart: enqueueIfMissing skipped");
    }

    const elapsedMs = Date.now() - startMs;
    log.info({ elapsedMs, outputSizeBytes, durationSecs }, "faststart: complete");
    return { elapsedMs, outputSizeBytes, durationSecs };

  } catch (err) {
    log.error({ err }, "faststart: failed");
    // Only touch transcodingStatus when the HLS transcoder is not running.
    // When skipStatusUpdate=true the transcoder owns this field.
    if (!options.skipStatusUpdate) {
      try {
        // Restore the pre-faststart status. The original upload blob is intact
        // (the multipart re-upload was either aborted or never reached
        // completeMultipartUpload, so the original key was never overwritten).
        // Setting "failed" here would permanently block the item from loadActive()
        // and cause an avoidable Off Air state — the source file is still playable.
        await db
          .update(videos)
          .set({ transcodingStatus: priorTranscodingStatus as "none" | "queued" | "encoding" | "ready" | "hls_ready" | "failed" | "processing" })
          .where(and(eq(videos.id, videoId), ne(videos.transcodingStatus, "hls_ready")));
      } catch (dbErr) {
        log.error({ dbErr }, "faststart: could not restore transcodingStatus");
      }
    }
    throw err;
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => { /* noop */ });
  }
}

/**
 * Spawn ffmpeg with -c copy -movflags +faststart.
 * Rejects if ffmpeg exits non-zero or the hard timeout fires.
 */
function spawnFfmpegFaststart(
  inputPath: string,
  outputPath: string,
  log: typeof rootLogger,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", inputPath,
      "-c", "copy",
      "-movflags", "+faststart",
      outputPath,
    ]);

    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGKILL"); } catch { /* noop */ }
      reject(new Error(`faststart: ffmpeg timed out after ${FASTSTART_TIMEOUT_MS / 1000}s`));
    }, FASTSTART_TIMEOUT_MS);

    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`faststart: ffmpeg spawn error: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        const tail = stderr.slice(-500);
        log.warn({ exitCode: code, stderr: tail }, "faststart: ffmpeg non-zero exit");
        reject(new Error(`faststart: ffmpeg exited ${String(code)}: ${tail}`));
      }
    });
  });
}

/**
 * Run ffprobe to measure exact duration of a local file.
 * Returns null on any failure (non-fatal — video still plays).
 */
function probeDuration(filePath: string, log: typeof rootLogger): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    let out = "";
    let settled = false;
    const settle = (val: number | null) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* noop */ }
      log.warn("faststart: ffprobe duration timed out");
      settle(null);
    }, PROBE_TIMEOUT_MS);
    proc.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    proc.on("error", () => { clearTimeout(timer); settle(null); });
    proc.on("close", () => {
      clearTimeout(timer);
      const v = parseFloat(out.trim());
      settle(Number.isFinite(v) && v > 0 ? v : null);
    });
  });
}
