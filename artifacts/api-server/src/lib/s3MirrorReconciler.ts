import path from "path";
import { promises as fs, createReadStream } from "fs";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, videosTable } from "@workspace/db";
import {
  isS3Configured,
  headObject,
  putObject,
  AWS_S3_BUCKET,
} from "./s3Storage";
import { logger } from "./logger";

/**
 * Startup reconciler: ensures every `videoSource = 'local'` row has its source
 * MP4 mirrored to S3 under `videos/<filename>`.
 *
 * Why this exists
 * ───────────────
 * The upload finalize paths attempt a best-effort S3 PUT and fall back to
 * leaving the file on the api-server's ephemeral disk if the PUT fails. That
 * fallback is silent — the row is committed with `s3MirroredAt = NULL` and
 * the playback URL points at `/api/uploads/<filename>`, which streams bytes
 * through the Node process from local disk. Under fan-out load (multiple
 * viewers of the same video), that path saturates the per-client concurrency
 * cap (uploadRangeGuard), 429s legitimate viewers, and risks OOM-killing the
 * container — see the production incident at 2026-04-26T08:00Z.
 *
 * This reconciler runs once per process boot:
 *   1. Selects rows with `s3MirroredAt IS NULL` and `videoSource = 'local'`.
 *   2. For each row, derives the S3 key (from `objectPath` or by parsing the
 *      `localVideoUrl`) and does a HEAD against the bucket.
 *      - If the object is already in S3, just stamps `s3MirroredAt` (and
 *        backfills `objectPath` if it was missing).
 *      - If not in S3, attempts to upload from the matching local-disk file.
 *      - If the file is missing on both disk and S3, logs a warning and
 *        leaves the row alone — manual intervention is required for that
 *        case (the bytes are gone).
 *   3. After a successful upload, also flips `localVideoUrl` to the cleaner
 *      `/api/videos/:id/source` redirect endpoint when it was still pointing
 *      at the legacy `/api/uploads/<filename>` route, so subsequent playbacks
 *      go straight through the redirect path.
 *
 * The reconciler is idempotent and safe to run on every boot. It processes a
 * small number of rows in parallel to avoid spending all bandwidth on a
 * single boot when the backlog is large.
 */

// Note: esbuild bundles every src/** module into dist/index.mjs (a single
// file at the dist/ root), so at runtime __dirname is `<api-server>/dist`,
// not `<api-server>/dist/lib`. Only one `..` is needed to reach the
// api-server root, then into the persistent `uploads/` directory. This
// matches how app.ts resolves the same directory for express.static.
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
const CONCURRENCY = 2;

const EXT_TO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".ogv": "video/ogg",
  ".3gp": "video/3gpp",
};

interface ReconcileResult {
  scanned: number;
  alreadyInS3: number;
  uploaded: number;
  missing: number;
  failed: number;
}

/**
 * Pull the disk filename out of a legacy `/api/uploads/<filename>` URL. Returns
 * `null` for any URL shape we don't recognise (e.g. the newer
 * `/api/videos/<id>/source` form, an absolute external URL, or empty string).
 */
function filenameFromUploadsUrl(localVideoUrl: string | null): string | null {
  if (!localVideoUrl) return null;
  const marker = "/api/uploads/";
  const idx = localVideoUrl.indexOf(marker);
  if (idx < 0) return null;
  const tail = localVideoUrl.slice(idx + marker.length).split("?")[0]?.split("#")[0];
  if (!tail || tail.includes("/") || tail.includes("..")) return null;
  return tail;
}

/**
 * Resolve `(s3Key, diskFilename)` for a row. Both are derived from whichever
 * pointer the row already carries — `objectPath` wins when set (it's the
 * canonical key), otherwise we fall back to parsing `localVideoUrl`.
 */
function resolvePointers(
  row: Pick<
    typeof videosTable.$inferSelect,
    "objectPath" | "localVideoUrl"
  >,
): { s3Key: string; diskFilename: string } | null {
  if (row.objectPath && row.objectPath.startsWith("videos/")) {
    const filename = path.basename(row.objectPath);
    if (!filename || filename.includes("..")) return null;
    return { s3Key: row.objectPath, diskFilename: filename };
  }
  const filename = filenameFromUploadsUrl(row.localVideoUrl);
  if (!filename) return null;
  return { s3Key: `videos/${filename}`, diskFilename: filename };
}

async function reconcileOne(
  row: typeof videosTable.$inferSelect,
  apiBaseUrl: string,
  result: ReconcileResult,
): Promise<void> {
  const ptrs = resolvePointers(row);
  if (!ptrs) {
    logger.warn(
      { videoId: row.id, localVideoUrl: row.localVideoUrl, objectPath: row.objectPath },
      "s3MirrorReconciler: cannot derive S3 key for row — skipping",
    );
    result.failed += 1;
    return;
  }
  const { s3Key, diskFilename } = ptrs;

  // 1. Is the object already in the bucket?
  let head;
  try {
    head = await headObject(s3Key);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), videoId: row.id, s3Key },
      "s3MirrorReconciler: HEAD failed — leaving row for next boot",
    );
    result.failed += 1;
    return;
  }

  if (head) {
    await db
      .update(videosTable)
      .set({
        s3MirroredAt: new Date(),
        objectPath: row.objectPath ?? s3Key,
      })
      .where(eq(videosTable.id, row.id));
    logger.info(
      { videoId: row.id, s3Key, sizeS3: head.contentLength },
      "s3MirrorReconciler: row already mirrored — stamped s3MirroredAt",
    );
    result.alreadyInS3 += 1;
    return;
  }

  // 2. Need to upload from local disk.
  const diskPath = path.join(UPLOADS_DIR, diskFilename);
  let stat;
  try {
    stat = await fs.stat(diskPath);
  } catch {
    logger.warn(
      { videoId: row.id, s3Key, diskPath },
      "s3MirrorReconciler: file missing on both disk and S3 — manual recovery required",
    );
    result.missing += 1;
    return;
  }

  const ext = path.extname(diskFilename).toLowerCase();
  const contentType =
    row.mimeType?.trim() || EXT_TO_MIME[ext] || "application/octet-stream";

  const startedAt = Date.now();
  try {
    await putObject(s3Key, createReadStream(diskPath), { contentType });
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        videoId: row.id,
        s3Key,
        sizeBytes: stat.size,
      },
      "s3MirrorReconciler: upload failed — will retry next boot",
    );
    result.failed += 1;
    return;
  }

  // 3. Stamp the row. Also upgrade the playback URL when it still points at
  //    the legacy `/api/uploads/<filename>` route, so the next request goes
  //    through the cleaner `/api/videos/:id/source` redirect path.
  const upgradeUrl =
    apiBaseUrl &&
    row.localVideoUrl &&
    row.localVideoUrl.includes("/api/uploads/");
  await db
    .update(videosTable)
    .set({
      s3MirroredAt: new Date(),
      objectPath: s3Key,
      ...(upgradeUrl
        ? { localVideoUrl: `${apiBaseUrl}/api/videos/${row.id}/source` }
        : {}),
    })
    .where(eq(videosTable.id, row.id));

  logger.info(
    {
      videoId: row.id,
      s3Key,
      sizeBytes: stat.size,
      durationMs: Date.now() - startedAt,
      urlUpgraded: upgradeUrl,
    },
    "s3MirrorReconciler: uploaded local file to S3 and stamped row",
  );
  result.uploaded += 1;
}

/**
 * Run the scan once. Safe to call on boot from a fire-and-forget caller — all
 * errors are caught and logged. Returns the per-outcome counts so callers can
 * surface metrics.
 */
export async function runS3MirrorReconciliation(): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    scanned: 0,
    alreadyInS3: 0,
    uploaded: 0,
    missing: 0,
    failed: 0,
  };

  if (!isS3Configured()) {
    logger.info(
      "s3MirrorReconciler: S3 not configured — skipping reconciliation",
    );
    return result;
  }

  // Hard cap on the per-pass batch size. Without this LIMIT, a large backlog
  // (e.g. after extended S3 downtime, or on the first reconciliation in a
  // newly-restored environment) loads every unmirrored row into memory at
  // once and can OOM the API server on boot. The reconciler runs on a
  // schedule, so capping at 500/pass simply means a 50k backlog drains over
  // ~100 passes instead of OOM'ing on the first one. Tunable via env var so
  // ops can speed up large recoveries on hosts with more memory.
  const RECONCILE_BATCH_SIZE = Math.max(
    50,
    Number(process.env.S3_MIRROR_BATCH_SIZE ?? "500"),
  );
  const rows = await db
    .select()
    .from(videosTable)
    .where(
      and(
        eq(videosTable.videoSource, "local"),
        isNull(videosTable.s3MirroredAt),
      ),
    )
    .orderBy(sql`imported_at asc`)
    .limit(RECONCILE_BATCH_SIZE);

  result.scanned = rows.length;
  if (rows.length === 0) {
    logger.info("s3MirrorReconciler: no unmirrored local uploads found");
    return result;
  }

  const devDomain = process.env.REPLIT_DEV_DOMAIN;
  const apiBaseUrl =
    process.env.API_BASE_URL ?? (devDomain ? `https://${devDomain}` : "");

  logger.info(
    { unmirroredCount: rows.length, bucket: AWS_S3_BUCKET, concurrency: CONCURRENCY },
    "s3MirrorReconciler: starting reconciliation pass",
  );

  // Bounded concurrency — never run more than CONCURRENCY uploads at once so
  // a large backlog can't saturate the upload bandwidth on boot.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < rows.length) {
      const idx = cursor++;
      const row = rows[idx];
      try {
        await reconcileOne(row, apiBaseUrl, result);
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), videoId: row.id },
          "s3MirrorReconciler: unexpected error reconciling row",
        );
        result.failed += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  logger.info(result, "s3MirrorReconciler: pass complete");
  return result;
}
