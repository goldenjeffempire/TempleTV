#!/usr/bin/env bash
# scripts/init-minio-bucket.sh
#
# Wait for MinIO to become ready, then create the application bucket and
# migrate any BYTEA blobs that were stored in PostgreSQL storage_blobs.data.
#
# Called from the "Start API" workflow BEFORE pnpm --filter @workspace/db run push
# so the migration runs while the data column still exists, then the schema
# migration drops it.

set -euo pipefail

MINIO_ENDPOINT="${AWS_ENDPOINT_URL:-http://localhost:9000}"
MINIO_ROOT_USER="${AWS_ACCESS_KEY_ID:-minioadmin}"
MINIO_ROOT_PASSWORD="${AWS_SECRET_ACCESS_KEY:-minioadmin}"
S3_BUCKET="${S3_BUCKET:-temple-tv}"

MAX_WAIT_SECS=60
WAIT_INTERVAL=2

# ── 1. Wait for MinIO to be ready ─────────────────────────────────────────────
echo "[init-minio] Waiting for MinIO at $MINIO_ENDPOINT..."
elapsed=0
while true; do
  if curl -sf --max-time 3 "${MINIO_ENDPOINT}/minio/health/live" > /dev/null 2>&1; then
    echo "[init-minio] MinIO is up (${elapsed}s elapsed)"
    break
  fi
  if [ $elapsed -ge $MAX_WAIT_SECS ]; then
    echo "[init-minio] ERROR: MinIO did not start within ${MAX_WAIT_SECS}s — aborting"
    exit 1
  fi
  echo "[init-minio] MinIO not ready yet, retrying in ${WAIT_INTERVAL}s... (${elapsed}/${MAX_WAIT_SECS}s)"
  sleep $WAIT_INTERVAL
  elapsed=$((elapsed + WAIT_INTERVAL))
done

# ── 2. Create bucket (idempotent) using mc (MinIO Client) ─────────────────────
# mc config is written to a temp dir so it doesn't conflict with any existing
# ~/.mc configuration or credentials.
MC_CONFIG_DIR=$(mktemp -d)
cleanup() { rm -rf "$MC_CONFIG_DIR"; }
trap cleanup EXIT

mc --config-dir "$MC_CONFIG_DIR" alias set local \
  "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" \
  --api s3v4 2>&1 | head -2 || true

if mc --config-dir "$MC_CONFIG_DIR" mb "local/${S3_BUCKET}" --ignore-existing 2>&1; then
  echo "[init-minio] Bucket '${S3_BUCKET}' ready"
else
  echo "[init-minio] WARN: mb command failed (bucket may already exist — continuing)"
fi

# ── 3. Run BYTEA→MinIO migration (safe to run multiple times) ─────────────────
# The migration script checks whether the `data` column still exists in
# storage_blobs and exits cleanly if it has already been dropped.
if [ -f "$(dirname "$0")/migrate-bytea-to-minio.mjs" ]; then
  echo "[init-minio] Running BYTEA→MinIO migration script..."
  node "$(dirname "$0")/migrate-bytea-to-minio.mjs" 2>&1 || \
  echo "[init-minio] Migration script failed — skipping (column may already be dropped)"
fi

echo "[init-minio] MinIO initialization complete"
