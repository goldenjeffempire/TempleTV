/**
 * One-shot backfill: mirror every file currently on the api-server's local
 * `uploads/` disk to S3 under the `videos/` prefix, so that
 * `/api/uploads/<file>` can 302-redirect to S3 instead of streaming bytes
 * through the Node process (see `lib/staticWithS3Fallback.ts` redirectFromS3).
 *
 * Usage (from the Render shell, or anywhere with the API env vars set):
 *
 *   pnpm --filter @workspace/api-server run build
 *   pnpm --filter @workspace/api-server run backfill-uploads
 *
 * Behaviour
 * ─────────
 *   - Walks `<api-server>/uploads/` (the disk mountpath in production).
 *   - Skips the `hls/` subtree (HLS lives under the S3 `hls/` prefix and is
 *     served by a separate fallback mount; this script only touches the raw
 *     source uploads).
 *   - Skips the `tmp/` subtree (in-progress chunked-upload sessions).
 *   - Skips files whose `videos/<filename>` key already exists in S3 (HEAD
 *     check) — idempotent, safe to re-run.
 *   - Logs a per-file outcome and a summary at the end.
 *   - Exits with status 1 if any file failed to upload.
 */

import path from "path";
import { fileURLToPath } from "url";
import { promises as fs, createReadStream } from "fs";
import {
  isS3Configured,
  headObject,
  putObject,
  AWS_S3_BUCKET,
  AWS_REGION,
} from "../lib/s3Storage";
import { logger } from "../lib/logger";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In production (Render), the disk is mounted at
// `<repo>/artifacts/api-server/uploads/`. The compiled script lives in
// `<repo>/artifacts/api-server/dist/scripts/`, so going up two levels and
// then into `uploads/` matches both production and a local dev tree.
const UPLOADS_DIR = path.join(__dirname, "..", "..", "uploads");

const SKIP_DIRS = new Set(["hls", "tmp", "sessions"]);

const EXT_TO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".ogv": "video/ogg",
  ".ts": "video/mp2t",
  ".3gp": "video/3gpp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

interface Result {
  total: number;
  uploaded: number;
  skipped: number;
  failed: number;
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return out;
    throw err;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // Only the top-level uploads/ contents map directly to videos/<name>.
      // Nested directories aren't part of the /api/uploads URL surface so we
      // skip them rather than silently flattening their paths.
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(path.join(dir, entry.name));
  }
  return out;
}

async function mirrorOne(filePath: string, result: Result): Promise<void> {
  const filename = path.basename(filePath);
  const key = `videos/${filename}`;
  const ext = path.extname(filename).toLowerCase();
  const contentType = EXT_TO_MIME[ext] ?? "application/octet-stream";

  try {
    const existing = await headObject(key);
    if (existing) {
      logger.info({ key, sizeS3: existing.contentLength }, "backfill: already in S3 — skipped");
      result.skipped += 1;
      return;
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), key },
      "backfill: HEAD failed — skipping (treat as failure)",
    );
    result.failed += 1;
    return;
  }

  const stat = await fs.stat(filePath);
  const startedAt = Date.now();
  try {
    await putObject(key, createReadStream(filePath), { contentType });
    logger.info(
      {
        key,
        sizeBytes: stat.size,
        contentType,
        durationMs: Date.now() - startedAt,
      },
      "backfill: uploaded",
    );
    result.uploaded += 1;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), key, sizeBytes: stat.size },
      "backfill: upload failed",
    );
    result.failed += 1;
  }
}

async function main(): Promise<number> {
  if (!isS3Configured()) {
    logger.fatal(
      "backfill: AWS S3 is not configured — set AWS_REGION, AWS_S3_BUCKET, " +
        "AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY before running.",
    );
    return 1;
  }
  logger.info(
    { bucket: AWS_S3_BUCKET, region: AWS_REGION, uploadsDir: UPLOADS_DIR },
    "backfill: starting",
  );

  const files = await listFiles(UPLOADS_DIR);
  const result: Result = { total: files.length, uploaded: 0, skipped: 0, failed: 0 };

  if (files.length === 0) {
    logger.info({ uploadsDir: UPLOADS_DIR }, "backfill: no files found — nothing to do");
    return 0;
  }

  for (const filePath of files) {
    await mirrorOne(filePath, result);
  }

  logger.info(result, "backfill: complete");
  return result.failed > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    logger.fatal({ err: err instanceof Error ? err.message : String(err) }, "backfill: crashed");
    process.exit(1);
  });
