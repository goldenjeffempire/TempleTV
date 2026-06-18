#!/usr/bin/env bash
# scripts/init-minio-bucket.sh
#
# Wait for a local MinIO instance to become ready, then create the application
# bucket.  This script is ONLY relevant in local-dev / CI environments where
# MinIO runs at localhost.
#
# When AWS_ENDPOINT_URL is not set (i.e. production AWS S3), the script exits
# immediately with success — no MinIO is expected and no init is required.
#
# The script is intentionally non-fatal: if MinIO is slow to start or
# unavailable, it exits 0 with a warning so the API startup chain continues.
# The API falls back to whatever S3 backend is configured in environment
# variables (real AWS S3 in production, MinIO in dev).

MINIO_ENDPOINT="${AWS_ENDPOINT_URL:-}"
MINIO_ROOT_USER="${AWS_ACCESS_KEY_ID:-minioadmin}"
MINIO_ROOT_PASSWORD="${AWS_SECRET_ACCESS_KEY:-minioadmin}"
BUCKET="${S3_BUCKET:-temple-tv}"

# ── Skip entirely if no local MinIO endpoint is configured ────────────────────
if [ -z "$MINIO_ENDPOINT" ]; then
  echo "[init-minio] AWS_ENDPOINT_URL not set — using cloud S3 backend, skipping MinIO init"
  exit 0
fi

# ── Sanity: only run MinIO init against localhost endpoints ───────────────────
case "$MINIO_ENDPOINT" in
  http://localhost:*|http://127.0.0.1:*)
    ;;
  *)
    echo "[init-minio] WARN: AWS_ENDPOINT_URL='$MINIO_ENDPOINT' is not a localhost address"
    echo "[init-minio] Skipping MinIO bucket init — treating this as a cloud S3 deployment"
    exit 0
    ;;
esac

MAX_WAIT_SECS=45
WAIT_INTERVAL=2

# ── 1. Wait for MinIO to be ready (non-fatal timeout) ─────────────────────────
echo "[init-minio] Waiting for MinIO at $MINIO_ENDPOINT (bucket: $BUCKET)..."
elapsed=0
minio_ready=0
while [ $elapsed -lt $MAX_WAIT_SECS ]; do
  if curl -sf --max-time 3 "${MINIO_ENDPOINT}/minio/health/live" > /dev/null 2>&1; then
    echo "[init-minio] MinIO is up (${elapsed}s elapsed)"
    minio_ready=1
    break
  fi
  echo "[init-minio] MinIO not ready yet, retrying in ${WAIT_INTERVAL}s... (${elapsed}/${MAX_WAIT_SECS}s)"
  sleep $WAIT_INTERVAL
  elapsed=$((elapsed + WAIT_INTERVAL))
done

if [ $minio_ready -eq 0 ]; then
  echo "[init-minio] WARN: MinIO did not start within ${MAX_WAIT_SECS}s"
  echo "[init-minio] Continuing without MinIO bucket init — API will use AWS S3 backend"
  exit 0
fi

# ── 2. Create bucket (idempotent) using mc (MinIO Client) ─────────────────────
MC_CONFIG_DIR=$(mktemp -d)
cleanup() { rm -rf "$MC_CONFIG_DIR"; }
trap cleanup EXIT

mc --config-dir "$MC_CONFIG_DIR" alias set local \
  "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" \
  --api s3v4 2>&1 | head -2 || true

if mc --config-dir "$MC_CONFIG_DIR" mb "local/${BUCKET}" --ignore-existing 2>&1; then
  echo "[init-minio] Bucket '${BUCKET}' ready"
else
  echo "[init-minio] WARN: mb command failed (bucket may already exist — continuing)"
fi

# ── 3. Run BYTEA→MinIO migration if present (idempotent, non-fatal) ───────────
if [ -f "$(dirname "$0")/migrate-bytea-to-minio.mjs" ]; then
  echo "[init-minio] Running BYTEA→MinIO migration script..."
  node "$(dirname "$0")/migrate-bytea-to-minio.mjs" 2>&1 || \
  echo "[init-minio] Migration script failed — skipping (column may already be dropped)"
fi

echo "[init-minio] MinIO initialization complete"
