/**
 * migrate-blobs-to-s3.ts
 *
 * Migrates all blobs from the PostgreSQL `storage_blobs` BYTEA table
 * to the AWS S3 bucket configured in S3_BUCKET (env var).
 *
 * Usage:
 *   pnpm tsx scripts/src/migrate-blobs-to-s3.ts [options]
 *
 * Options:
 *   --dry-run          Print what would be migrated without actually doing it
 *   --delete-after     Delete PostgreSQL rows after successful S3 upload
 *   --batch-size=N     Number of blobs to process per batch (default: 20)
 *   --skip-existing    Skip blobs that already exist in S3 (default: true)
 *   --key-filter=STR   Only migrate blobs whose key contains this substring
 *
 * Environment variables required:
 *   DATABASE_URL or PGHOST+PGPORT+PGUSER+PGPASSWORD+PGDATABASE
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 *   S3_BUCKET, S3_REGION (or AWS_REGION)
 *
 * Safety:
 *   - Idempotent: blobs already in S3 are skipped by default
 *   - Non-destructive by default: PostgreSQL rows are preserved unless --delete-after
 *   - Progress is logged to stdout as JSON
 *   - Failures are logged but do not abort the batch; the script continues
 */

import { Pool } from "pg";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

const DRY_RUN = process.argv.includes("--dry-run");
const DELETE_AFTER = process.argv.includes("--delete-after");
const SKIP_EXISTING = !process.argv.includes("--no-skip-existing");
const BATCH_SIZE = parseInt(
  process.argv.find(a => a.startsWith("--batch-size="))?.split("=")[1] ?? "20",
  10,
);
const KEY_FILTER = process.argv.find(a => a.startsWith("--key-filter="))?.split("=")[1];

function log(level: "info" | "warn" | "error", data: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, ...data }));
}

async function main() {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    log("error", { msg: "S3_BUCKET env var is required" });
    process.exit(1);
  }
  const region = process.env.S3_REGION ?? process.env.AWS_REGION;
  if (!region) {
    log("error", { msg: "S3_REGION or AWS_REGION env var is required" });
    process.exit(1);
  }

  log("info", {
    msg: "Starting migration",
    bucket,
    region,
    dryRun: DRY_RUN,
    deleteAfter: DELETE_AFTER,
    skipExisting: SKIP_EXISTING,
    batchSize: BATCH_SIZE,
    keyFilter: KEY_FILTER ?? "(none)",
  });

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    host: process.env.PGHOST,
    port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : undefined,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    max: 3,
    statement_timeout: 0,
  });

  const s3 = new S3Client({ region });

  let totalBlobs = 0;
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  let deleted = 0;

  try {
    // Count total blobs for progress reporting
    const countRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM storage_blobs${KEY_FILTER ? ` WHERE key LIKE $1` : ""}`,
      KEY_FILTER ? [`%${KEY_FILTER}%`] : [],
    );
    totalBlobs = parseInt(countRes.rows[0]?.count ?? "0", 10);
    log("info", { msg: "Blobs found in PostgreSQL", total: totalBlobs });

    if (totalBlobs === 0) {
      log("info", { msg: "No blobs to migrate — storage_blobs table is empty" });
      return;
    }

    let offset = 0;
    let done = false;

    while (!done) {
      // Fetch a batch ordered by size ASC so smaller blobs migrate first
      const baseQuery = KEY_FILTER
        ? `SELECT key, content_type, data, size_bytes FROM storage_blobs WHERE key LIKE $1 ORDER BY size_bytes ASC LIMIT $2 OFFSET $3`
        : `SELECT key, content_type, data, size_bytes FROM storage_blobs ORDER BY size_bytes ASC LIMIT $1 OFFSET $2`;
      const params = KEY_FILTER
        ? [`%${KEY_FILTER}%`, BATCH_SIZE, offset]
        : [BATCH_SIZE, offset];

      const batchRes = await pool.query<{
        key: string;
        content_type: string;
        data: Buffer;
        size_bytes: string;
      }>(baseQuery, params);

      if (batchRes.rows.length === 0) {
        done = true;
        break;
      }

      log("info", {
        msg: "Processing batch",
        batchStart: offset,
        batchSize: batchRes.rows.length,
        progress: `${offset}/${totalBlobs}`,
      });

      for (const row of batchRes.rows) {
        const { key, content_type, data, size_bytes } = row;
        const sizeBytes = parseInt(size_bytes ?? "0", 10);

        try {
          // Check if blob already exists in S3
          if (SKIP_EXISTING && !DRY_RUN) {
            try {
              await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
              log("info", { msg: "Skipping — already in S3", key, sizeBytes });
              skipped++;
              continue;
            } catch {
              // Not found → proceed with upload
            }
          }

          if (DRY_RUN) {
            log("info", { msg: "[DRY RUN] Would upload", key, sizeBytes, contentType: content_type });
            migrated++;
            continue;
          }

          // Upload to S3
          const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
          await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: content_type ?? "application/octet-stream",
            ContentLength: body.length,
          }));
          migrated++;
          log("info", { msg: "Uploaded to S3", key, sizeBytes });

          // Optionally delete from PostgreSQL after successful upload
          if (DELETE_AFTER) {
            await pool.query(`DELETE FROM storage_blobs WHERE key = $1`, [key]);
            deleted++;
            log("info", { msg: "Deleted from PostgreSQL", key });
          }
        } catch (err: unknown) {
          failed++;
          const e = err as { message?: string };
          log("error", { msg: "Failed to migrate blob", key, sizeBytes, error: e.message });
        }
      }

      offset += batchRes.rows.length;
      if (batchRes.rows.length < BATCH_SIZE) {
        done = true;
      }
    }
  } finally {
    await pool.end();
  }

  log("info", {
    msg: "Migration complete",
    totalBlobs,
    migrated,
    skipped,
    failed,
    deleted,
    dryRun: DRY_RUN,
  });

  if (failed > 0) {
    log("warn", { msg: `${failed} blobs failed to migrate — check errors above` });
    process.exit(1);
  }

  if (totalBlobs > 0 && !DRY_RUN && !DELETE_AFTER) {
    log("info", {
      msg: "Tip: Re-run with --delete-after to remove migrated blobs from PostgreSQL once you have verified S3 content",
    });
  }
}

main().catch((err: unknown) => {
  const e = err as { message?: string; stack?: string };
  log("error", { msg: "Fatal error", error: e.message, stack: e.stack });
  process.exit(1);
});
