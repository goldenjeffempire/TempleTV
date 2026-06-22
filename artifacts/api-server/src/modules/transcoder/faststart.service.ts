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
import type { ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { storage } from "../../infrastructure/storage.js";
import { logger as rootLogger } from "../../infrastructure/logger.js";
import { storagePaths } from "../../infrastructure/storage-paths.js";
import { isDiskConstrained } from "../../infrastructure/disk-watchdog.js";
import { env } from "../../config/env.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { invalidateVideosCatalogCache } from "../videos/videos.routes.js";
// MP4-first broadcast policy: enqueueIfMissing is called in the faststart
// success path so any video with a localVideoUrl enters the broadcast queue
// immediately after its moov atom is relocated — even if the upload finalize
// path never had a chance to enqueue it (server restart, migration, recovery).
import { enqueueIfMissing } from "../broadcast/auto-enqueue.service.js";
import { boostTranscodePriority } from "./transcoder.queue.js";
import { detectMdatWithoutMoov, probeContainerIsValid, remuxForFaststart, validateLocalSourceFile } from "./transcoder.service.js";

/**
 * Module-level registry of all currently-running FFmpeg child processes.
 * Used by cancelAllFaststartJobs() to free 80–150 MiB of RSS before the
 * memory watchdog issues a SIGTERM — potentially avoiding the restart entirely.
 */
const _activeProcs = new Set<ChildProcess>();

/**
 * Kill every in-flight FFmpeg faststart and ffprobe process immediately.
 *
 * Called by the memory watchdog as a pre-SIGTERM relief pass.  Each
 * faststart job holds 80–150 MiB of RSS; cancelling them may drop RSS
 * below the restart threshold and avoid the process restart entirely.
 *
 * Safe to call at any time — processes that have already exited are simply
 * absent from the set.  The running runFaststart() calls will receive a
 * rejection (ffmpeg exited non-zero / kill) which the caller already handles.
 */
export function cancelAllFaststartJobs(): void {
  const count = _activeProcs.size;
  for (const p of _activeProcs) {
    try { p.kill("SIGKILL"); } catch { /* noop — already exited */ }
  }
  _activeProcs.clear();
  if (count > 0) {
    rootLogger.warn({ count }, "[faststart] cancelAllFaststartJobs: killed active FFmpeg processes for memory relief");
  }
}

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

/**
 * Timeout for the poster-frame ffmpeg extraction subprocess.
 * Much shorter than FASTSTART_TIMEOUT_MS — a single -vframes 1 seek + decode
 * should never take more than 30 s even on the largest files.
 */
const THUMB_EXTRACT_TIMEOUT_MS = 30_000;

/**
 * Extract a single poster frame from a local MP4 file.
 *
 * Uses `-ss seek → -vframes 1` (same pattern as the HLS transcoder's
 * generateThumbnail) so output format is compatible with thumbnails set by
 * the full HLS transcode. The frame is letterboxed/pillarboxed to 640×360
 * so all aspect ratios produce a consistent thumbnail shape.
 *
 * Returns true on success, false on any ffmpeg error (non-throwing so a
 * corrupt input frame doesn't abort the parent faststart flow).
 */
/** Minimal logger interface used by the thumbnail helpers below. */
type ThumbnailLog = Pick<ReturnType<typeof rootLogger.child>, "debug" | "info">;

async function extractPosterFrame(
  inputPath: string,
  outputPath: string,
  targetSecs: number,
  log: ThumbnailLog,
): Promise<boolean> {
  return new Promise((resolve) => {
    const args = [
      "-y",
      "-ss", String(targetSecs),
      "-i", inputPath,
      "-vframes", "1",
      "-vf", "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2",
      "-f", "image2",
      outputPath,
    ];
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    proc.unref();
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      log.debug({ targetSecs }, "faststart: thumbnail extraction timed out — skipping");
      resolve(false);
    }, THUMB_EXTRACT_TIMEOUT_MS);
    timer.unref();
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      log.debug({ err }, "faststart: thumbnail extraction spawn failed — skipping");
      resolve(false);
    });
  });
}

/**
 * Extract and persist an early poster-frame thumbnail after faststart
 * completes (while the faststarted MP4 is still on disk in scratchDir).
 *
 * Only runs when the video's thumbnailUrl is currently empty — preserves
 * any thumbnail already set by a previous HLS transcode or manual edit.
 * Fires-and-forgets: any error is logged at debug level and swallowed so
 * the caller (runFaststart) is never blocked or failed by thumbnail work.
 *
 * The thumbnail is stored at `uploads/thumbs/{videoId}.jpg` so it is served
 * by the same /api/v1/uploads/* route that serves raw uploads.
 */
function scheduleEarlyThumbnail(opts: {
  videoId: string;
  outputPath: string;
  durationSecs: number | null;
  log: ThumbnailLog;
}): void {
  void (async () => {
    try {
      const { videoId, outputPath, durationSecs, log } = opts;

      // Only extract when thumbnailUrl is empty AND no custom thumbnail was
      // explicitly uploaded by the operator. hasCustomThumbnail=true means the
      // operator deliberately chose a specific image — overwriting it with an
      // auto-generated poster frame would undo their intent.
      const [row] = await db
        .select({ thumbnailUrl: videos.thumbnailUrl, hasCustomThumbnail: videos.hasCustomThumbnail })
        .from(videos)
        .where(eq(videos.id, videoId))
        .limit(1);
      if (row?.thumbnailUrl) return;
      if (row?.hasCustomThumbnail) return;

      const targetSecs = Math.max(1, Math.round((durationSecs ?? 10) * 0.1));
      const thumbPath = outputPath.replace(/\.mp4$/i, ".thumb.jpg");
      const ok = await extractPosterFrame(outputPath, thumbPath, targetSecs, log);
      if (!ok) return;

      const thumbKey = `uploads/thumbs/${videoId}.jpg`;
      const thumbBytes = await readFile(thumbPath);
      await storage().putObject({ key: thumbKey, body: thumbBytes, contentType: "image/jpeg" });

      // Only write thumbnailUrl when it is still empty — guard against a
      // concurrent HLS transcode that finished while we were running ffmpeg.
      const thumbUrl = `/api/v1/uploads/thumbs/${videoId}.jpg`;
      // Guard: only write when thumbnailUrl is still empty/null — prevents
      // overwriting a thumbnail set by a concurrent HLS transcode or manual edit.
      // Must match BOTH "" (the coerced-from-null Zod value) and SQL NULL —
      // `eq(videos.thumbnailUrl, "")` generates `WHERE thumbnail_url = ''` which
      // does NOT match NULL, so newly-uploaded videos (thumbnailUrl IS NULL in DB)
      // would have the extracted thumbnail uploaded to storage but the DB row never
      // updated — silently discarding the thumbnail work.
      await db
        .update(videos)
        .set({ thumbnailUrl: thumbUrl })
        .where(and(eq(videos.id, videoId), or(eq(videos.thumbnailUrl, ""), isNull(videos.thumbnailUrl))));

      log.info({ targetSecs, thumbKey }, "faststart: early poster-frame thumbnail saved");
      adminEventBus.push("videos-library-updated", { videoId, reason: "thumbnail-extracted" });
    } catch (err) {
      opts.log.debug({ err }, "faststart: early thumbnail extraction failed (non-fatal)");
    }
  })();
}

export interface FaststartResult {
  elapsedMs: number;
  outputSizeBytes: number;
  durationSecs: number | null;
  /** True when faststart was intentionally skipped (check skipReason). */
  skipped?: boolean;
  /** Machine-readable reason when skipped=true. */
  skipReason?: "hls_exists" | "disk_constrained" | "memory_constrained";
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
  // Normalize: some older rows stored localVideoUrl (absolute URL) as objectPath instead of
  // the bare storage key.  Detect and fix in-flight so headObject doesn't get a URL it can
  // never resolve, which would throw CORRUPT_UPLOAD and permanently deactivate the video.
  // Also repair the DB column so the next call uses the correct value.
  const UPLOADS_MARKER = "/api/v1/uploads/";
  if (objectKey.startsWith("http://") || objectKey.startsWith("https://")) {
    const markerIdx = objectKey.indexOf(UPLOADS_MARKER);
    if (markerIdx === -1) {
      throw Object.assign(
        new Error(
          `faststart: objectKey is an absolute URL without a recognisable uploads path ("${objectKey}"). ` +
          "Re-upload the file to recover.",
        ),
        { code: "CORRUPT_UPLOAD" },
      );
    }
    const normalizedKey = `uploads/${objectKey.slice(markerIdx + UPLOADS_MARKER.length)}`;
    rootLogger.warn(
      { videoId, originalObjectKey: objectKey, normalizedObjectKey: normalizedKey },
      "faststart: objectKey was an absolute URL — normalising to bare storage key and repairing DB row",
    );
    // Repair the DB row so all subsequent callers (orchestrator, transcoder, etc.)
    // get the correct key without needing this normalisation pass again.
    await db
      .update(videos)
      .set({ objectPath: normalizedKey })
      .where(eq(videos.id, videoId))
      .catch((err: unknown) =>
        rootLogger.warn({ err, videoId }, "faststart: objectPath DB repair failed (non-fatal) — continuing with normalised key"),
      );
    // Recurse with the corrected key so log context is correct throughout.
    return runFaststart(videoId, normalizedKey, options);
  }

  const log = rootLogger.child({ module: "faststart", videoId, objectKey, skipStatusUpdate: options.skipStatusUpdate ?? false });
  const scratchDir = path.join(storagePaths.scratch, `faststart-${randomUUID()}`);
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

  // ── HLS-gate skip guard ──────────────────────────────────────────────────────
  // If HLS transcoding has already produced a master playlist, faststart is
  // unnecessary — the broadcast pipeline exclusively uses the HLS stream, not
  // the raw/faststarted MP4.  Skip early to avoid redundant ffmpeg work,
  // storage reads/writes, and scratch-dir allocation for already-processed files.
  {
    const [vRow] = await db
      .select({ hlsMasterUrl: videos.hlsMasterUrl, transcodingStatus: videos.transcodingStatus })
      .from(videos)
      .where(eq(videos.id, videoId))
      .limit(1)
      .catch(() => [undefined]);
    if (vRow?.hlsMasterUrl) {
      log.info(
        { hlsMasterUrl: vRow.hlsMasterUrl, transcodingStatus: vRow.transcodingStatus },
        "faststart: HLS stream already exists — skipping faststart (optimization not needed for HLS-only broadcast pipeline)",
      );
      return { elapsedMs: 0, outputSizeBytes: 0, durationSecs: null, skipped: true, skipReason: "hls_exists" };
    }
  }

  // Pre-flight: abort if the scratch partition is critically full. Faststart
  // downloads the full source + writes the output (2× source size) — starting
  // on an almost-full disk would guarantee an ENOSPC mid-write and leave a
  // partial file in the scratch dir. The disk watchdog clears the flag once
  // its emergency sweep recovers enough space.
  if (isDiskConstrained()) {
    log.warn(
      { scratchPath: storagePaths.scratch },
      "faststart: scratch partition constrained — skipping until disk pressure clears",
    );
    return { elapsedMs: 0, outputSizeBytes: 0, durationSecs: null, skipped: true, skipReason: "disk_constrained" };
  }

  // Pre-flight: abort if RSS is too close to the restart threshold.
  //
  // Faststart spawns an ffmpeg child process and (on failure paths) reads
  // the full source blob from PostgreSQL — together this typically adds
  // 80–150 MB of RSS ABOVE whatever the server is currently at.  On
  // memory-constrained hosts (≤ 1 GiB) that spike can easily cross
  // MEMORY_RESTART_RSS_MB and trigger the watchdog SIGTERM mid-job.
  //
  // Crucially the gate must account for headroom, not just the warn
  // threshold.  If MEMORY_WARN_RSS_MB = 400 and the server is at 395 MB
  // (just below the gate), spawning ffmpeg pushes RSS to ~475 MB — above
  // MEMORY_RESTART_RSS_MB = 470 → instant restart.  The gate must be at
  // least FASTSTART_SPAWN_OVERHEAD_MB below the restart threshold.
  //
  // Gate formula:  min(MEMORY_WARN_RSS_MB, MEMORY_RESTART_RSS_MB − 100)
  //   • 512 MiB host (WARN=380, RESTART=430): gate = min(380, 330) = 330 MB
  //   • 1 GiB host   (WARN=700, RESTART=900): gate = min(700, 800) = 700 MB
  //   • 2 GiB host   (WARN=1024,RESTART=1536):gate = min(1024,1436)= 1024 MB
  // On constrained hosts the restart − 100 formula is the binding limit,
  // on large hosts the warn threshold is the binding limit — both are safe.
  {
    const currentRssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    const rssCeilingMb = Math.min(env.MEMORY_WARN_RSS_MB, env.MEMORY_RESTART_RSS_MB - 100);
    if (currentRssMb >= rssCeilingMb) {
      log.warn(
        { currentRssMb, rssCeilingMb, memoryWarnRssMb: env.MEMORY_WARN_RSS_MB, memoryRestartRssMb: env.MEMORY_RESTART_RSS_MB },
        "faststart: RSS within 100 MB of restart threshold — skipping to prevent watchdog SIGTERM during ffmpeg spawn",
      );
      return { elapsedMs: 0, outputSizeBytes: 0, durationSecs: null, skipped: true, skipReason: "memory_constrained" };
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

    // ── Pre-download metadata validation ──────────────────────────────────────
    // Validate size_bytes BEFORE fetching any bytes.  A zero or null size_bytes
    // indicates a corrupt or incompletely-assembled storage record — fetching it
    // would produce a 0-byte file that causes probeContainerIsValid to fail and
    // triggers the erroneous CORRUPT_UPLOAD permanent-failure path.
    // headObject failure is swallowed (non-fatal) because faststart has a fallback
    // (HLS transcoder) and shouldn't block the upload pipeline on a transient DB
    // blip.  A genuinely missing / zero-size record throws immediately.
    log.info("faststart: validating source metadata before download");
    const fsHead = await storage().headObject(objectKey).catch(() => null);
    if (fsHead?.exists === false) {
      // Trigger the storage blob recovery waterfall non-blockingly.  The waterfall
      // checks whether HLS blobs already exist (healthy), can re-transcode (tier1/2),
      // or must quarantine (tier3 SOURCE_MISSING).  This closes the autonomous
      // recovery loop for blobs discovered missing during the faststart path.
      void (async () => {
        try {
          const { storageBlobRecoveryService } = await import("../broadcast-v2/engine/storage-blob-recovery.service.js");
          await storageBlobRecoveryService.runWaterfall({
            videoId,
            queueId: "",
            title: videoId,
            objectPath: objectKey,
            hlsUrl: null,
            triggeredBy: "faststart",
          });
        } catch (recErr) {
          log.warn({ err: recErr }, "faststart: post-missing-blob recovery trigger failed (non-fatal)");
        }
      })();
      throw Object.assign(
        new Error(
          `faststart: source object not found in storage (key="${objectKey}"). ` +
          `The upload blob may have been deleted. Re-upload to recover.`,
        ),
        // SOURCE_MISSING (not CORRUPT_UPLOAD): the file was deleted, not corrupt.
        // This distinction matters in the transcoder dispatcher: CORRUPT_UPLOAD is
        // treated as a permanent structural failure; SOURCE_MISSING triggers the
        // storage recovery waterfall on the dispatcher side as well.
        { code: "SOURCE_MISSING" },
      );
    }
    if (fsHead?.contentLength != null && fsHead.contentLength <= 0) {
      throw Object.assign(
        new Error(
          `faststart: invalid source metadata — size_bytes=${fsHead.contentLength} for key="${objectKey}". ` +
          `The storage record is corrupt or the multipart upload was never fully assembled.`,
        ),
        { code: "CORRUPT_UPLOAD" },
      );
    }

    // ── Atomic download with byte counting ────────────────────────────────────
    // Write to a .part file first; rename atomically to inputPath on success so
    // the final path never contains a partial file.
    log.info("faststart: downloading source from storage");
    const fsPartPath = `${inputPath}.part`;
    await rm(fsPartPath, { force: true }).catch(() => undefined);

    let fsBytesWritten = 0;
    const { body, contentLength } = await storage().getObject(objectKey);
    const fsByteCounter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        fsBytesWritten += chunk.length;
        cb(null, chunk);
      },
    });

    await pipeline(body, fsByteCounter, createWriteStream(fsPartPath));

    // Atomic promotion: .part → final path (rename(2), atomic on Linux).
    await rename(fsPartPath, inputPath);

    // ── Post-download size verification ───────────────────────────────────────
    // Verify the download completed in full. The chunked streaming path for
    // large blobs (> 64 MiB) exits the generator early on a short SUBSTRING
    // result — the `pipeline` call succeeds but the written file is shorter
    // than expected. A truncated input causes probeContainerIsValid to return
    // false on a valid file, which leads remuxForFaststart to also fail and
    // ultimately throws CORRUPT_UPLOAD — permanently failing a healthy video.
    // Throwing DOWNLOAD_TRUNCATED here instead lets the finalize handler treat
    // it as a non-fatal faststart failure so the video continues to the HLS
    // transcoder, which performs its own verified download.
    const { size: actualSize } = await stat(inputPath);

    if (actualSize === 0) {
      throw Object.assign(
        new Error(
          `faststart: source download produced an empty file (0 bytes) for key="${objectKey}". ` +
          `The video will be processed by the HLS transcoder instead.`,
        ),
        { code: "DOWNLOAD_TRUNCATED" },
      );
    }

    if (fsBytesWritten !== actualSize) {
      throw Object.assign(
        new Error(
          `faststart: download write mismatch — ${fsBytesWritten} bytes counted in stream but ` +
          `${actualSize} bytes on disk (key="${objectKey}"). Possible disk I/O error.`,
        ),
        { code: "DOWNLOAD_TRUNCATED" },
      );
    }

    if (contentLength != null && contentLength > 0 && actualSize !== contentLength) {
      throw Object.assign(
        new Error(
          `faststart: source download truncated — expected ${contentLength} bytes but received ${actualSize}. ` +
          `The video will be processed by the HLS transcoder instead.`,
        ),
        { code: "DOWNLOAD_TRUNCATED" },
      );
    }

    // ── Magic-bytes and file-type pre-flight ──────────────────────────────────
    // Log a warning if the downloaded file looks like a non-video (HTML page,
    // image, etc.) but do NOT block it — ffmpeg will handle or fail gracefully,
    // and the video stays queued to broadcast as-is regardless.
    try {
      await validateLocalSourceFile(inputPath);
    } catch (valErr) {
      log.warn(
        { videoId, objectKey, err: valErr },
        "faststart: source file failed pre-flight type check — proceeding anyway",
      );
    }

    // Run ffmpeg -movflags +faststart to relocate the moov atom to the file
    // head for instant-play streaming.  If ffmpeg cannot process the file
    // (moov absent, unsupported container, damaged data) we log a warning and
    // return early — the video remains queued and broadcasts as the raw
    // uploaded MP4.  No validity pre-checks: every upload reaches the queue.
    log.info("faststart: running ffmpeg -movflags +faststart");
    try {
      await spawnFfmpegFaststart(inputPath, outputPath, log);
    } catch (ffmpegErr) {
      // ── FASTSTART OPTIMIZATION SKIPPED — not an upload or playback failure ──
      // ffmpeg could not relocate the moov atom (e.g. unsupported container,
      // damaged intermediate data, timeout).  The original blob in storage is
      // completely intact and the video is already in the broadcast queue as a
      // raw MP4 (enqueueIfMissing was called before faststart ran).  The HLS
      // transcoder will be triggered by the caller after this function returns,
      // so the video will eventually serve HLS regardless.
      // This is NOT an upload failure and NOT a playback failure — it is an
      // optional optimization step that failed gracefully.
      log.warn(
        { videoId, objectKey, err: ffmpegErr },
        "[FASTSTART OPTIMIZATION SKIPPED] ffmpeg moov-relocation failed — " +
        "video remains in broadcast queue as raw MP4; HLS transcoding will follow; " +
        "this is NOT an upload or playback failure",
      );
      // Persist a 'FASTSTART_SKIPPED' marker so the admin UI can distinguish
      // "never attempted" (null) from "attempted but failed" (FASTSTART_SKIPPED).
      // Only write when the video is not already in a terminal HLS state.
      await db
        .update(videos)
        .set({ transcodingErrorCode: "FASTSTART_SKIPPED" })
        .where(
          and(
            eq(videos.id, videoId),
            ne(videos.transcodingStatus, "hls_ready"),
            ne(videos.transcodingStatus, "encoding"),
          ),
        )
        .catch((dbErr) =>
          log.warn({ dbErr, videoId }, "faststart: FASTSTART_SKIPPED marker write failed (non-fatal)"),
        );
      // HLS-gate: do NOT enqueue here. The transcoder dispatcher calls
      // enqueueIfMissing() after HLS transcoding completes and hlsMasterUrl is
      // written — that is the only broadcast queue entry point for local uploads.
      // Signal the orchestrator and admin UI so the raw-MP4 source is used
      // immediately without waiting for the next poll cycle.
      adminEventBus.push("videos-library-updated", { videoId, reason: "faststart-skipped" });
      adminEventBus.push("broadcast-queue-updated", { videoId, reason: "faststart-skipped" });
      return;
    }

    const { size: outputSizeBytes } = await stat(outputPath);

    log.info("faststart: probing duration");
    const durationSecs = await probeDuration(outputPath, log);

    // ── Early poster-frame thumbnail ──────────────────────────────────────────
    // Fire-and-forget: extract a thumbnail while outputPath is on disk so the
    // video library shows an image immediately — before HLS transcoding (which
    // can take 20-60 min on large files). Non-blocking; any error is swallowed.
    scheduleEarlyThumbnail({ videoId, outputPath, durationSecs, log });

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
    // Set faststart_locked=true on the storage blob BEFORE starting the multipart
    // re-upload. During the swap window the blob data is being replaced in-place
    // via iterative bytea-concat parts. Any reader that calls headObject() at
    // this moment receives contentLength=0 and treats the blob as transiently
    // unavailable — preventing the orchestrator from serving a partially-assembled
    // (corrupt) file to viewers.
    await db.execute(sql`
      UPDATE storage_blobs SET faststart_locked = true WHERE key = ${objectKey}
    `).catch((lockErr) =>
      log.warn({ lockErr, objectKey }, "faststart: failed to set faststart_locked (non-fatal — continuing)"),
    );
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
    } finally {
      // Always clear faststart_locked regardless of success or failure so the
      // blob becomes visible to readers again. On success the blob is fully
      // assembled; on failure the original blob is still intact (the multipart
      // re-upload is copy-on-write — original key is never deleted).
      await db.execute(sql`
        UPDATE storage_blobs SET faststart_locked = false WHERE key = ${objectKey}
      `).catch((unlockErr) =>
        log.warn({ unlockErr, objectKey }, "faststart: failed to clear faststart_locked — blob may remain locked"),
      );
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
          // Extra safety: don't overwrite a completed HLS transcode or an
          // actively-running HLS encode when skipStatusUpdate=false (e.g. if
          // the transcoder started while faststart was running on a large file).
          // Without the "encoding" guard, a slow faststart completing after HLS
          // has started would write "ready" over "encoding", confusing the
          // dispatcher watchdog and causing stale status in the admin UI.
          : and(eq(videos.id, videoId), ne(videos.transcodingStatus, "hls_ready"), ne(videos.transcodingStatus, "encoding")),
      );

    // Sync the real duration to any broadcast_queue rows that reference this
    // video. Queue rows are created at upload-finalize time with a 1800-second
    // placeholder (before ffprobe runs); this corrects them so orchestrator
    // cycle timing matches the actual video length. Non-fatal — a failure here
    // does not block the faststart result; loadActive() reads the real duration
    // from the joined video row at runtime as a belt-and-suspenders fallback.
    if (durationSecs != null && durationSecs > 0) {
      const roundedDuration = Math.round(durationSecs);
      await db
        .update(schema.broadcastQueueTable)
        .set({ durationSecs: roundedDuration })
        .where(eq(schema.broadcastQueueTable.videoId, videoId))
        .catch((err) => {
          log.warn(
            { err, videoId, durationSecs: roundedDuration },
            "faststart: broadcast_queue duration sync failed (non-fatal)",
          );
        });
    }

    void invalidateVideosCatalogCache().catch(() => {});
    adminEventBus.push("videos-library-updated", { videoId, reason: "faststart-complete" });

    // MP4-first broadcast policy: enqueue now if not already in the queue.
    // This handles videos that missed the upload-finalize enqueue path
    // (server restart during assembly, migration, operator repair, or recovery).
    // enqueueIfMissing is idempotent — if the queue row already exists this
    // is a cheap no-op (single SELECT returns "already-queued").
    void enqueueIfMissing({ videoId, reason: "faststart-complete" }).catch(
      (err: unknown) => log.warn({ err, videoId }, "faststart: enqueueIfMissing failed (non-fatal)"),
    );

    // Trigger an orchestrator reload so the faststart-optimised source URL is
    // picked up without waiting for the next scheduled poll cycle.
    // The reload clears the bad-URL cache so items that entered SKIP_PENDING
    // while the file was being re-uploaded are unblocked immediately.
    adminEventBus.push("broadcast-queue-updated", { reason: "faststart-complete", videoId });
    // Targeted source-upgrade event: lets the orchestrator refresh only this
    // item's resolved URL without a full queue reload or cycle anchor reset.
    // Clients receive a source.upgraded event frame and can switch to the
    // moov-at-byte-0 MP4 at the next segment boundary for seamless upgrade.
    adminEventBus.push("broadcast-source-upgraded", { videoId, quality: "mp4_faststart" });

    // Boost transcoding priority for videos now in the broadcast queue.
    // The video is either just-enqueued or was already queued before faststart
    // ran. Either way, HLS transcoding (if pending) should jump ahead of
    // unrelated library jobs so it becomes broadcast-ready ASAP.
    // boostTranscodePriority is a no-op when no pending job exists (non-fatal).
    void boostTranscodePriority(videoId, 100).catch((err) =>
      log.debug({ err }, "faststart: boostTranscodePriority failed (non-fatal)"),
    );

    const elapsedMs = Date.now() - startMs;
    log.info({ elapsedMs, outputSizeBytes, durationSecs }, "faststart: complete");
    return { elapsedMs, outputSizeBytes, durationSecs };

  } catch (err) {
    // ── FASTSTART OPTIMIZATION SKIPPED — not an upload or playback failure ──
    // Errors that reach here are pipeline failures AFTER ffmpeg succeeded:
    //   DOWNLOAD_TRUNCATED — storage download was incomplete (transient I/O issue)
    //   SOURCE_MISSING     — source blob was deleted from storage (recovery needed)
    //   CORRUPT_UPLOAD     — storage record is zero bytes (malformed session)
    //   upload failure     — multipart re-upload failed after faststart completed
    //
    // In every case the ORIGINAL source blob at objectKey is intact or already
    // gone — the multipart re-upload is copy-on-write, so the original is never
    // deleted before completeMultipartUpload succeeds.
    // The video is already (or will be) in the broadcast queue and the HLS
    // transcoder will run from the original asset — this is NOT an upload or
    // playback failure; it is a failed optimization step.
    const errCode = (err as { code?: string } | null)?.code;
    const isTerminal = errCode === "CORRUPT_UPLOAD" || errCode === "SOURCE_MISSING";

    log.warn(
      { err, videoId, objectKey, errCode },
      isTerminal
        ? "[FASTSTART OPTIMIZATION SKIPPED] source blob unavailable or zero-size — " +
          "video will broadcast as raw MP4 or via HLS once transcoding completes; " +
          "this is NOT an upload or playback failure (original blob state: " +
          (errCode === "SOURCE_MISSING" ? "deleted from storage" : "zero bytes in storage") + ")"
        : "[FASTSTART OPTIMIZATION SKIPPED] post-ffmpeg pipeline step failed — " +
          "original source blob is intact; video remains in broadcast queue as raw MP4; " +
          "HLS transcoding will be attempted from the original asset; " +
          "this is NOT an upload or playback failure",
    );

    // Only touch transcodingStatus when the HLS transcoder is not running.
    // When skipStatusUpdate=true the transcoder owns this field.
    if (!options.skipStatusUpdate) {
      try {
        // Restore the pre-faststart status. The original upload blob is intact
        // (the multipart re-upload was either aborted or never reached
        // completeMultipartUpload, so the original key was never overwritten).
        // Setting "failed" for transient errors (disk full, ffmpeg timeout, etc.)
        // would permanently block the item from loadActive() and cause an avoidable
        // Off Air state — the source file is still playable in those cases.
        //
        // CRITICAL: Never restore to "processing" — that value means "faststart is
        // actively running" and restoring it leaves the video permanently stuck if
        // this crash-restart scenario set priorTranscodingStatus to "processing"
        // (i.e. the previous server process was killed while faststart was running).
        // "queued" is always safe: the source blob is intact and the video will be
        // re-processed by faststart-on-finalize or by the transcoder dispatcher.
        const safeRestoreStatus = (
          priorTranscodingStatus === "processing" ? "queued" : priorTranscodingStatus
        ) as "none" | "queued" | "encoding" | "ready" | "hls_ready" | "failed";
        await db
          .update(videos)
          .set({
            transcodingStatus: safeRestoreStatus,
            // Persist the skip marker unless the error is a real terminal source
            // failure (CORRUPT_UPLOAD / SOURCE_MISSING) — those get their own codes.
            ...(!isTerminal ? { transcodingErrorCode: "FASTSTART_SKIPPED" } : {}),
          })
          // Same dual guard as the success path: don't clobber "encoding"
          // (HLS transcoder may have started while faststart was running).
          .where(and(eq(videos.id, videoId), ne(videos.transcodingStatus, "hls_ready"), ne(videos.transcodingStatus, "encoding")));
      } catch (dbErr) {
        log.warn({ dbErr }, "faststart: could not restore transcodingStatus (non-fatal)");
      }
    }

    // HLS-gate: do NOT enqueue here. The transcoder dispatcher calls
    // enqueueIfMissing() after HLS transcoding completes and hlsMasterUrl is
    // written — that is the only broadcast queue entry point for local uploads.

    // Notify the admin UI that the video's status changed after the failure so
    // the library / broadcast-queue panels refresh without waiting for the next
    // poll interval. The transcodingStatus was already restored above; these
    // events trigger a React Query refetch to surface the restored state.
    adminEventBus.push("videos-library-updated", { videoId, reason: "faststart-skipped" });
    adminEventBus.push("broadcast-queue-updated", { videoId, reason: "faststart-skipped" });
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
    proc.unref();
    _activeProcs.add(proc);

    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      _activeProcs.delete(proc);
      try { proc.kill("SIGKILL"); } catch { /* noop */ }
      reject(new Error(`faststart: ffmpeg timed out after ${FASTSTART_TIMEOUT_MS / 1000}s`));
    }, FASTSTART_TIMEOUT_MS);
    timer.unref();

    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      _activeProcs.delete(proc);
      clearTimeout(timer);
      reject(new Error(`faststart: ffmpeg spawn error: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      _activeProcs.delete(proc);
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
    proc.unref();
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
    timer.unref();
    proc.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    proc.on("error", () => { clearTimeout(timer); settle(null); });
    proc.on("close", () => {
      clearTimeout(timer);
      const v = parseFloat(out.trim());
      settle(Number.isFinite(v) && v > 0 ? v : null);
    });
  });
}
