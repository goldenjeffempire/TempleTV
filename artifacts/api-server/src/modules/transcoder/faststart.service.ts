/**
 * Faststart service — MP4 moov-atom relocation for instant browser/TV/mobile playback.
 *
 * WHAT THIS DOES
 * ──────────────
 * An MP4 file written by a camera or recording app typically places the `moov`
 * atom (the index that tells players where every frame lives) at the END of the
 * file.  A browser or Smart TV receiving such a file over HTTP must download the
 * entire file before it can start playing — causing a blank screen or spinner.
 *
 * `ffmpeg -c copy -movflags +faststart` rewrites the file so moov is at the
 * BEGINNING, allowing playback to start within the first two HTTP responses.
 * No re-encoding occurs — audio/video data are copied byte-for-byte.
 *
 * PIPELINE GUARANTEES
 * ───────────────────
 * 1. Moov position is detected from the first 64 KB via `getObjectRange` before
 *    any file is downloaded — files that are already faststart'd are skipped.
 * 2. Integrity is validated (magic bytes, ffprobe container check) before the
 *    remux.  Corrupt/incomplete uploads are classified immediately.
 * 3. Five escalating remux strategies handle edge cases (mildly corrupt
 *    containers, fMP4, large moov beyond the default probe window).
 * 4. Output is validated (ffprobe + HTTP Range probe) before DB is updated.
 * 5. The blob is replaced atomically via multipart upload — the old file is
 *    served until completeMultipartUpload commits the new bytes in one
 *    PostgreSQL transaction.  No window where the URL returns empty.
 * 6. `faststartApplied = true` is only written after all validation passes.
 * 7. A concurrency semaphore (FASTSTART_MAX_CONCURRENT, default 2) prevents
 *    simultaneous ffmpeg jobs from OOM-killing the process on constrained hosts.
 *
 * RESULT SHAPE
 * ────────────
 * Every exit path returns `FaststartResult` with:
 *   ok          — true on success or skip (moov already at front).
 *   finalStatus — "completed" | "skipped" | "processing" | "failed"
 *   rootCause   — human-readable failure reason (present when ok=false)
 *   actions     — ordered list of steps taken (always present)
 *   durationMs  — wall-clock time for the job
 */

import { mkdir, open as fsOpen, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import { env } from "../../config/env.js";
import { storage } from "../../infrastructure/storage.js";
import { storagePaths } from "../../infrastructure/storage-paths.js";
import {
  remuxForFaststart,
  validateLocalSourceFile,
  probeContainerIsValid,
} from "./transcoder.service.js";
import { setPipelineStage } from "../media-pipeline/pipeline-stage.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface FaststartResult {
  ok: boolean;
  finalStatus: "completed" | "skipped" | "processing" | "failed";
  rootCause?: string;
  actions: string[];
  durationMs: number;
  /** Set when the moov atom was detected at the start and no remux was needed. */
  skipped?: boolean;
  /** Set when remux ran and produced output. */
  remuxed?: boolean;
  objectKey?: string;
}

export interface FaststartOptions {
  /**
   * When true the service does NOT update `transcodingStatus` in the DB.
   * Callers that manage status themselves (admin retry endpoint) set this.
   */
  skipStatusUpdate?: boolean;
  /**
   * Force remux even if `faststartApplied` is already true.  Used by the
   * admin "retry-faststart" endpoint to re-apply after a suspect upload.
   */
  force?: boolean;
}

// ── Moov position detection ────────────────────────────────────────────────

interface MoovInfo {
  /** True when the moov atom appears within the first 64 KiB. */
  isAtStart: boolean;
  /** Byte offset of the moov atom, or null when not found in the sample. */
  moovOffset: number | null;
  fileSize: number;
}

/**
 * Read the first 64 KiB of the stored blob and parse MP4 box headers to
 * determine whether the `moov` atom is already positioned at the front of
 * the file (i.e. faststart has already been applied).
 *
 * Returns `isAtStart: false` (needs faststart) when:
 *   • The blob doesn't exist or is empty.
 *   • The first meaningful box is not `moov`.
 *   • We cannot find `moov` in the first 64 KiB.
 *
 * A file with `ftyp` before `moov` is still considered "at start" — that
 * is the standard layout produced by `ffmpeg -movflags +faststart`.
 */
async function detectMoovPosition(objectKey: string): Promise<MoovInfo> {
  const s = storage();
  const head = await s.headObject(objectKey);
  if (!head.exists || !head.contentLength) {
    return { isAtStart: false, moovOffset: null, fileSize: 0 };
  }
  const fileSize = head.contentLength;

  const readEnd = Math.min(65535, fileSize - 1);
  const range = await s.getObjectRange(objectKey, 0, readEnd);
  if (!range) return { isAtStart: false, moovOffset: null, fileSize };

  const chunks: Buffer[] = [];
  for await (const chunk of range.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buf = Buffer.concat(chunks);

  // Walk the top-level MP4 box list looking for `moov`.
  let offset = 0;
  let moovOffset: number | null = null;

  while (offset + 8 <= buf.length) {
    const sizeField = buf.readUInt32BE(offset);
    const type = buf.slice(offset + 4, offset + 8).toString("latin1");

    let boxSize: number;
    if (sizeField === 0) {
      boxSize = fileSize - offset;
    } else if (sizeField === 1) {
      if (offset + 16 > buf.length) break;
      const hi = buf.readUInt32BE(offset + 8);
      const lo = buf.readUInt32BE(offset + 12);
      boxSize = hi * 2 ** 32 + lo;
    } else {
      boxSize = sizeField;
    }

    if (type === "moov") {
      moovOffset = offset;
      break;
    }

    if (boxSize < 8) break;
    offset += boxSize;
  }

  const isAtStart = moovOffset !== null && moovOffset < 65536;
  return { isAtStart, moovOffset, fileSize };
}

// ── Storage helpers ────────────────────────────────────────────────────────

const PART_SIZE = 8 * 1024 * 1024; // 8 MiB per multipart part

/**
 * Download a blob from PostgreSQL BYTEA storage to a local temp file using
 * streaming (O(1) Node.js RSS regardless of file size).
 *
 * Logs download progress every 10% so operators can track large-file jobs.
 */
async function downloadToTemp(
  objectKey: string,
  destPath: string,
  logCtx?: { info: (obj: object, msg: string) => void },
): Promise<void> {
  const s = storage();
  const { body, contentLength } = await s.getObject(objectKey);
  const ws = createWriteStream(destPath);

  let written = 0;
  let lastLoggedPct = -1;
  const reportEveryPct = 10;

  const trackingStream = new (await import("node:stream")).Transform({
    transform(chunk: Buffer, _enc: string, cb: () => void) {
      written += chunk.length;
      if (contentLength && contentLength > 0) {
        const pct = Math.floor((written / contentLength) * 100);
        const bucket = Math.floor(pct / reportEveryPct) * reportEveryPct;
        if (bucket > lastLoggedPct) {
          lastLoggedPct = bucket;
          logCtx?.info({ writtenBytes: written, totalBytes: contentLength, pct: bucket }, `[faststart] download ${bucket}%`);
        }
      }
      this.push(chunk);
      cb();
    },
  });

  await pipeline(body, trackingStream, ws);
  const stats = await stat(destPath);
  if (stats.size === 0) {
    throw Object.assign(new Error(`Downloaded file is empty: ${objectKey}`), { code: "EMPTY_DOWNLOAD" });
  }
}

/**
 * Re-upload a local file to object storage using multipart upload.
 * Reads the file in PART_SIZE chunks so peak Node.js RSS stays O(1).
 *
 * Uses createMultipartUpload → uploadPart × N → completeMultipartUpload.
 * The existing blob at `destKey` is atomically replaced by the final
 * completeMultipartUpload PostgreSQL transaction — no serving window exists
 * where the URL returns empty data.
 *
 * Logs upload progress every 10% so operators can track large-file jobs.
 */
async function uploadFromTemp(
  sourcePath: string,
  destKey: string,
  logCtx?: { info: (obj: object, msg: string) => void },
): Promise<void> {
  const s = storage();
  const fileStat = await stat(sourcePath);
  const fileSize = fileStat.size;
  if (fileSize === 0) {
    throw Object.assign(new Error(`Refusing to upload zero-byte file at ${sourcePath}`), { code: "EMPTY_OUTPUT" });
  }

  const { uploadId } = await s.createMultipartUpload({ key: destKey, contentType: "video/mp4" });

  const parts: Array<{ partNumber: number; etag: string }> = [];
  let partNumber = 1;
  let bytesUploaded = 0;
  let lastLoggedPct = -1;
  const reportEveryPct = 10;

  const fh = await fsOpen(sourcePath, "r");
  try {
    while (bytesUploaded < fileSize) {
      const toRead = Math.min(PART_SIZE, fileSize - bytesUploaded);
      const buf = Buffer.allocUnsafe(toRead);
      const { bytesRead: n } = await fh.read(buf, 0, toRead, bytesUploaded);
      if (n === 0) break;
      const chunk = n < toRead ? buf.subarray(0, n) : buf;
      const { etag } = await s.uploadPart({ key: destKey, uploadId, partNumber, body: chunk });
      parts.push({ partNumber, etag });
      bytesUploaded += n;
      partNumber++;

      const pct = Math.floor((bytesUploaded / fileSize) * 100);
      const bucket = Math.floor(pct / reportEveryPct) * reportEveryPct;
      if (bucket > lastLoggedPct) {
        lastLoggedPct = bucket;
        logCtx?.info(
          { uploadedBytes: bytesUploaded, totalBytes: fileSize, pct: bucket, partNumber },
          `[faststart] re-upload ${bucket}%`,
        );
      }
    }
  } finally {
    await fh.close().catch(() => undefined);
  }

  await s.completeMultipartUpload({ key: destKey, uploadId, parts });
}

// ── HTTP Range validation ──────────────────────────────────────────────────

/**
 * Probe the loopback URL for the given object key with a 1 KiB Range request.
 * Returns true when the server responds 206 Partial Content, confirming that
 * HTTP Range is supported for this resource.
 *
 * Non-throwing — any network failure returns false (validation is advisory;
 * the blob was already uploaded successfully before this probe runs).
 */
async function validateRangeSupport(objectKey: string): Promise<boolean> {
  try {
    const port = env.PORT ?? 8080;
    const keyPath = objectKey.startsWith("uploads/")
      ? objectKey
      : objectKey.replace(/^\/(?:api\/(?:v\d+\/)?)?/, "");
    const urlPath = `/api/v1/uploads/${keyPath.replace(/^uploads\//, "")}`;
    const loopbackUrl = `http://127.0.0.1:${port}${urlPath}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(loopbackUrl, {
      method: "GET",
      headers: { "Range": "bytes=0-1023" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    // Drain the body so the connection is properly closed.
    await res.body?.cancel().catch(() => undefined);
    return res.status === 206;
  } catch {
    return false;
  }
}

// ── Concurrency semaphore ──────────────────────────────────────────────────

class Semaphore {
  private queue: Array<() => void> = [];
  private running = 0;
  constructor(private readonly max: number) {}

  acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) {
      this.running++;
      next();
    }
  }
}

const semaphore = new Semaphore(env.FASTSTART_MAX_CONCURRENT ?? 2);

// ── Active job tracking (for cancelAllFaststartJobs) ──────────────────────

const activeControllers = new Map<string, AbortController>();

// ── DB helpers ────────────────────────────────────────────────────────────

const videos = schema.videosTable;

async function markProcessing(videoId: string): Promise<void> {
  await db
    .update(videos)
    .set({ transcodingStatus: "processing" })
    .where(eq(videos.id, videoId));
}

async function markReady(videoId: string): Promise<void> {
  await db
    .update(videos)
    .set({
      transcodingStatus: "ready",
      faststartApplied: true,
      transcodingErrorCode: null,
      transcodingErrorMessage: null,
    })
    .where(eq(videos.id, videoId));
}

async function markFailed(videoId: string, errorCode: string, errorMessage: string): Promise<void> {
  await db
    .update(videos)
    .set({
      transcodingStatus: "failed",
      transcodingErrorCode: errorCode,
      transcodingErrorMessage: errorMessage,
    })
    .where(eq(videos.id, videoId));
}

async function incrementAttempts(videoId: string): Promise<number> {
  const [row] = await db
    .update(videos)
    .set({ faststartAttempts: sql`${videos.faststartAttempts} + 1` })
    .where(eq(videos.id, videoId))
    .returning({ faststartAttempts: videos.faststartAttempts });
  return row?.faststartAttempts ?? 1;
}

// ── Core job ──────────────────────────────────────────────────────────────

/**
 * Run the faststart pipeline for a single video.
 *
 * @param videoId   Managed-video row id (for DB updates and logging).
 * @param objectKey Bare storage key (e.g. `uploads/2024/05/30/abc123.mp4`).
 *                  Relative `/api/v1/uploads/…` paths are normalised.
 * @param opts      Optional behaviour overrides.
 */
export async function runFaststart(
  videoId: string,
  objectKey: string,
  opts: FaststartOptions = {},
): Promise<FaststartResult> {
  const startMs = Date.now();
  const actions: string[] = [];
  const log = logger.child({ videoId, objectKey });

  // Normalise the object key: strip any /api/v1/uploads/ prefix.
  const normalizedKey = objectKey.startsWith("/")
    ? objectKey.replace(/^\/(?:api\/(?:v\d+\/)?)?/, "")
    : objectKey;

  const elapsed = () => Date.now() - startMs;

  // ── 0. Check if already applied ─────────────────────────────────────────
  if (!opts.force) {
    const [row] = await db
      .select({ faststartApplied: videos.faststartApplied })
      .from(videos)
      .where(eq(videos.id, videoId))
      .limit(1);
    if (row?.faststartApplied === true) {
      log.info("[faststart] already applied — skipping");
      actions.push("detected faststartApplied=true in DB — no action needed");
      return { ok: true, finalStatus: "skipped", skipped: true, actions, durationMs: elapsed() };
    }
  }

  // ── 1. Mark as processing (if caller wants status tracking) ─────────────
  if (!opts.skipStatusUpdate) {
    try {
      await markProcessing(videoId);
      actions.push("set transcodingStatus=processing");
    } catch (err) {
      log.warn({ err }, "[faststart] failed to mark processing (continuing)");
    }
  }

  await setPipelineStage(videoId, "faststart", "faststart job started").catch((err: unknown) =>
    log.warn({ err }, "[faststart] pipeline-stage transition failed (non-fatal)"),
  );

  // ── 2. Detect moov position from first 64 KiB ───────────────────────────
  actions.push("detecting moov atom position from first 64 KiB");
  let moovInfo: MoovInfo;
  try {
    moovInfo = await detectMoovPosition(normalizedKey);
    actions.push(
      moovInfo.moovOffset !== null
        ? `moov found at offset ${moovInfo.moovOffset} (fileSize=${moovInfo.fileSize}, isAtStart=${moovInfo.isAtStart})`
        : `moov not detected in first 64 KiB (fileSize=${moovInfo.fileSize})`,
    );
    log.info({ moovInfo }, "[faststart] moov position detected");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "[faststart] moov detection failed (proceeding to full remux)");
    actions.push(`moov detection failed: ${msg} — will attempt full remux`);
    moovInfo = { isAtStart: false, moovOffset: null, fileSize: 0 };
  }

  // ── 3. If moov is already at start: validate + mark applied + done ───────
  if (moovInfo.isAtStart) {
    actions.push("moov atom already at start — skipping ffmpeg remux");
    log.info("[faststart] moov already at start — marking faststartApplied=true without remux");
    try {
      await markReady(videoId);
      actions.push("set transcodingStatus=ready, faststartApplied=true");
    } catch (err) {
      log.warn({ err }, "[faststart] DB update failed after moov-at-start detection");
    }
    // Still run the Range probe to confirm HTTP delivery works.
    const rangeOk = await validateRangeSupport(normalizedKey);
    actions.push(`HTTP Range probe: ${rangeOk ? "206 ✓" : "failed (non-fatal)"}`);
    await setPipelineStage(videoId, "metadata", "faststart skipped (moov already at start) — proceeding to validation").catch(
      (err: unknown) => log.warn({ err }, "[faststart] pipeline-stage transition failed (non-fatal)"),
    );
    return { ok: true, finalStatus: "completed", skipped: true, actions, durationMs: elapsed() };
  }

  // ── 4. Acquire concurrency semaphore ────────────────────────────────────
  await semaphore.acquire();
  const controller = new AbortController();
  activeControllers.set(videoId, controller);

  const scratchDir = path.join(storagePaths.scratch, `faststart-${videoId}-${randomUUID()}`);

  try {
    await mkdir(scratchDir, { recursive: true });
    const ext = path.extname(normalizedKey) || ".mp4";
    const sourcePath = path.join(scratchDir, `source${ext}`);
    const outputPath = path.join(scratchDir, `output${ext}`);

    // ── 5. Validate storage blob exists and is non-zero ───────────────────
    actions.push("validating storage blob");
    const head = await storage().headObject(normalizedKey);
    if (!head.exists) {
      throw Object.assign(new Error(`Blob not found in storage: ${normalizedKey}`), {
        code: "SOURCE_MISSING",
      });
    }
    if ((head.contentLength ?? 0) === 0) {
      throw Object.assign(new Error(`Blob is zero bytes: ${normalizedKey}`), {
        code: "EMPTY_BLOB",
      });
    }
    actions.push(`blob confirmed: ${head.contentLength} bytes`);
    log.info({ sizeBytes: head.contentLength }, "[faststart] blob validated");

    // ── 5a. Large-file guard ──────────────────────────────────────────────
    // When FASTSTART_MAX_FILE_SIZE_GB > 0 skip files above the threshold.
    // They are still broadcast-eligible as raw MP4; the recovery worker will
    // retry once more scratch space is available (e.g. after other jobs clear).
    const maxFileSizeGb = env.FASTSTART_MAX_FILE_SIZE_GB ?? 0;
    if (maxFileSizeGb > 0 && (head.contentLength ?? 0) > maxFileSizeGb * 1024 * 1024 * 1024) {
      const sizeGib = ((head.contentLength ?? 0) / (1024 * 1024 * 1024)).toFixed(2);
      log.warn(
        { sizeGib, maxFileSizeGb },
        "[faststart] file exceeds FASTSTART_MAX_FILE_SIZE_GB — skipping (raw MP4 still playable)",
      );
      actions.push(`skipped: file is ${sizeGib} GiB, exceeds FASTSTART_MAX_FILE_SIZE_GB=${maxFileSizeGb} GiB`);
      return { ok: true, finalStatus: "skipped", skipped: true, actions, durationMs: elapsed() };
    }

    // ── 6. Download source to temp file ───────────────────────────────────
    actions.push("downloading source blob to temp file");
    await downloadToTemp(normalizedKey, sourcePath, log);
    const localStat = await stat(sourcePath);
    actions.push(`downloaded ${localStat.size} bytes to ${path.basename(sourcePath)}`);
    log.info({ sizeBytes: localStat.size, scratchDir }, "[faststart] source downloaded");

    // ── 7. Pre-remux validation (magic bytes + ffprobe container check) ───
    actions.push("validating source file integrity (magic bytes + ffprobe)");
    try {
      await validateLocalSourceFile(sourcePath);
      actions.push("magic-bytes check passed");
    } catch (valErr) {
      const msg = valErr instanceof Error ? valErr.message : String(valErr);
      throw Object.assign(new Error(`Source file failed pre-flight validation: ${msg}`), {
        code: "CORRUPT_SOURCE",
        unrecoverable: true,
      });
    }

    const containerValid = await probeContainerIsValid(sourcePath);
    if (!containerValid) {
      actions.push("ffprobe: container structure is invalid/damaged — remux may recover");
      log.warn("[faststart] source container invalid — attempting remux recovery");
    } else {
      actions.push("ffprobe: container structure valid");
    }

    // Increment attempt counter BEFORE the remux (so it counts even if we crash).
    const attemptN = await incrementAttempts(videoId);
    actions.push(`attempt ${attemptN}`);

    // ── 8. Run ffmpeg -c copy -movflags +faststart ────────────────────────
    actions.push("running ffmpeg remux (strategy cascade: s1→s5)");
    log.info("[faststart] starting ffmpeg remux");
    const remuxed = await remuxForFaststart(sourcePath, outputPath, videoId);
    if (!remuxed) {
      throw Object.assign(
        new Error(
          "All ffmpeg remux strategies exhausted. The container may be structurally corrupt " +
          "(moov absent or mdat truncated). Please re-upload the original source file.",
        ),
        { code: "REMUX_FAILED" },
      );
    }
    actions.push("ffmpeg remux completed (moov relocated to start)");
    log.info("[faststart] ffmpeg remux succeeded");

    // ── 9. Validate remux output ──────────────────────────────────────────
    actions.push("validating remux output with ffprobe");
    const outputValid = await probeContainerIsValid(outputPath);
    if (!outputValid) {
      throw Object.assign(
        new Error("Remux output failed container validation — output file may be corrupt."),
        { code: "OUTPUT_INVALID" },
      );
    }
    actions.push("remux output passed ffprobe container validation");

    // Confirm moov is now at the front of the output file.
    const outputStat = await stat(outputPath);
    actions.push(`remux output: ${outputStat.size} bytes`);

    // ── 10. Re-upload output to same storage key (atomic replace) ─────────
    actions.push("uploading remuxed file to object storage (atomic multipart replace)");
    log.info({ sizeBytes: outputStat.size }, "[faststart] uploading remuxed output");
    await uploadFromTemp(outputPath, normalizedKey, log);
    actions.push(`uploaded ${outputStat.size} bytes to ${normalizedKey}`);
    log.info("[faststart] upload complete");

    // ── 11. HTTP Range validation ─────────────────────────────────────────
    actions.push("probing HTTP Range support on loopback (GET bytes=0-1023)");
    const rangeOk = await validateRangeSupport(normalizedKey);
    actions.push(`HTTP Range probe: ${rangeOk ? "206 ✓" : "not 206 (non-fatal — blob uploaded successfully)"}`);
    if (!rangeOk) {
      log.warn("[faststart] HTTP Range probe did not return 206 (non-fatal — may be transient proxy lag)");
    }

    // ── 12. Update DB: mark complete ─────────────────────────────────────
    if (!opts.skipStatusUpdate) {
      await markReady(videoId);
      actions.push("set transcodingStatus=ready, faststartApplied=true in DB");
    } else {
      await db
        .update(videos)
        .set({ faststartApplied: true, transcodingErrorCode: null, transcodingErrorMessage: null })
        .where(eq(videos.id, videoId));
      actions.push("set faststartApplied=true in DB (skipStatusUpdate=true — status unchanged)");
    }
    await setPipelineStage(videoId, "metadata", "faststart remux completed — proceeding to validation").catch(
      (err: unknown) => log.warn({ err }, "[faststart] pipeline-stage transition failed (non-fatal)"),
    );
    log.info({ durationMs: elapsed() }, "[faststart] complete");

    return {
      ok: true,
      finalStatus: "completed",
      remuxed: true,
      actions,
      durationMs: elapsed(),
      objectKey: normalizedKey,
    };

  } catch (err) {
    const isStructured = (err as { code?: string }).code;
    const code = isStructured ?? "FASTSTART_FAILED";
    const msg = err instanceof Error ? err.message : String(err);

    log.error({ err, code, durationMs: elapsed() }, "[faststart] FAILED");
    actions.push(`ERROR [${code}]: ${msg}`);

    if (!opts.skipStatusUpdate) {
      try {
        await markFailed(videoId, code, msg.slice(0, 500));
        actions.push(`set transcodingStatus=failed, errorCode=${code} in DB`);
      } catch (dbErr) {
        log.warn({ dbErr }, "[faststart] failed to persist failed status (non-fatal)");
      }
    }
    await setPipelineStage(videoId, "failed", `faststart failed: [${code}] ${msg.slice(0, 200)}`).catch(
      (pipelineErr: unknown) => log.warn({ pipelineErr }, "[faststart] pipeline-stage transition failed (non-fatal)"),
    );

    return {
      ok: false,
      finalStatus: "failed",
      rootCause: `[${code}] ${msg}`,
      actions,
      durationMs: elapsed(),
    };

  } finally {
    activeControllers.delete(videoId);
    semaphore.release();
    await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Abort all in-flight faststart jobs gracefully.
 * Called on server shutdown to prevent ffmpeg processes from outliving the
 * Node.js process.
 */
export function cancelAllFaststartJobs(): void {
  for (const [videoId, controller] of activeControllers) {
    try {
      controller.abort();
    } catch {
      // ignore
    }
    logger.warn({ videoId }, "[faststart] cancelled in-flight job (shutdown)");
  }
  activeControllers.clear();
}
