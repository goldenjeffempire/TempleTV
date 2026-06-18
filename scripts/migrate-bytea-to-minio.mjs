/**
 * scripts/migrate-bytea-to-minio.mjs
 *
 * One-time migration: copies binary data from the PostgreSQL storage_blobs.data
 * BYTEA column to MinIO (S3-compatible) object storage.
 *
 * Safe to run multiple times:
 *   - Checks whether the `data` column still exists; exits cleanly if already dropped.
 *   - Skips rows with size_bytes = 0 or data IS NULL.
 *   - Skips keys that already exist in MinIO (HEAD check).
 *
 * Run BEFORE `pnpm --filter @workspace/db run push` so the migration
 * completes while the `data` column still exists. The schema migration
 * then drops the column.
 *
 * Usage:
 *   node scripts/migrate-bytea-to-minio.mjs
 *
 * Required env vars:
 *   DATABASE_URL or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL, S3_BUCKET
 */

import pg from "pg";
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

const { Client } = pg;

// ── Config ──────────────────────────────────────────────────────────────────

const pgConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.PGHOST ?? "localhost",
      port: Number(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER ?? "postgres",
      password: process.env.PGPASSWORD ?? "",
      database: process.env.PGDATABASE ?? "postgres",
    };

const s3Bucket = process.env.S3_BUCKET ?? "temple-tv";
const s3Endpoint = process.env.AWS_ENDPOINT_URL;
const s3Region = process.env.S3_REGION ?? process.env.AWS_REGION ?? "us-east-1";

const s3 = new S3Client({
  region: s3Region,
  ...(s3Endpoint ? { endpoint: s3Endpoint, forcePathStyle: true } : {}),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function keyExistsInS3(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: s3Bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function putToS3(key, data, contentType) {
  await s3.send(
    new PutObjectCommand({
      Bucket: s3Bucket,
      Key: key,
      Body: data,
      ContentType: contentType ?? "application/octet-stream",
      ContentLength: data.length,
    }),
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

const client = new Client(pgConfig);
await client.connect();
console.log("[migrate] Connected to PostgreSQL");

// Check if the `data` column still exists (idempotency guard).
const colCheck = await client.query(`
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'storage_blobs' AND column_name = 'data'
`);
if (colCheck.rows.length === 0) {
  console.log(
    "[migrate] storage_blobs.data column not found — migration already applied or never needed. Exiting.",
  );
  await client.end();
  process.exit(0);
}

// Count rows to migrate.
const countResult = await client.query(`
  SELECT COUNT(*) AS cnt FROM storage_blobs
  WHERE data IS NOT NULL AND size_bytes > 0
`);
const total = Number(countResult.rows[0]?.cnt ?? 0);
console.log(`[migrate] Found ${total} blob(s) to migrate`);

if (total === 0) {
  console.log("[migrate] Nothing to migrate. Exiting.");
  await client.end();
  process.exit(0);
}

let migrated = 0;
let skipped = 0;
let errors = 0;
const PAGE_SIZE = 20;
let offset = 0;

while (true) {
  const page = await client.query(
    `SELECT key, data, content_type FROM storage_blobs
     WHERE data IS NOT NULL AND size_bytes > 0
     ORDER BY key
     LIMIT $1 OFFSET $2`,
    [PAGE_SIZE, offset],
  );
  if (page.rows.length === 0) break;

  for (const row of page.rows) {
    const { key, data, content_type: contentType } = row;
    try {
      const exists = await keyExistsInS3(key);
      if (exists) {
        console.log(`[migrate] SKIP (already in MinIO): ${key}`);
        skipped++;
        continue;
      }
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      await putToS3(key, buf, contentType);
      migrated++;
      const pct = Math.round(((migrated + skipped) / total) * 100);
      console.log(
        `[migrate] OK [${migrated + skipped}/${total} ${pct}%] ${key} (${buf.length.toLocaleString()} bytes)`,
      );
    } catch (err) {
      errors++;
      console.error(`[migrate] ERROR: ${key} — ${err.message ?? err}`);
    }
  }

  offset += PAGE_SIZE;
}

await client.end();

console.log(
  `[migrate] Done — migrated: ${migrated}, skipped: ${skipped}, errors: ${errors}`,
);
if (errors > 0) {
  console.error(`[migrate] ${errors} error(s) — review logs above before proceeding`);
  process.exit(1);
}
