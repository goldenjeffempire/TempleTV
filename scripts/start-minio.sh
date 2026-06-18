#!/usr/bin/env bash
# scripts/start-minio.sh
#
# Start a local MinIO server and create the application bucket.
# Designed to run as a Replit workflow task before the API starts.
#
# Configuration (set via env vars in the workflow command):
#   MINIO_ROOT_USER     — MinIO admin user (default: minioadmin)
#   MINIO_ROOT_PASSWORD — MinIO admin password (default: minioadmin)
#   MINIO_DATA_DIR      — Storage directory (default: $HOME/.minio-data)
#   S3_BUCKET           — Bucket to create on first run (default: temple-tv)
#   MINIO_API_PORT      — MinIO S3 API port (default: 9000)
#   MINIO_CONSOLE_PORT  — MinIO web console port (default: 9001)

set -euo pipefail

MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"
MINIO_DATA_DIR="${MINIO_DATA_DIR:-$HOME/.minio-data}"
S3_BUCKET="${S3_BUCKET:-temple-tv}"
MINIO_API_PORT="${MINIO_API_PORT:-9000}"
MINIO_CONSOLE_PORT="${MINIO_CONSOLE_PORT:-9001}"

echo "[minio] Starting MinIO server..."
echo "[minio] Data directory: $MINIO_DATA_DIR"
echo "[minio] API port: $MINIO_API_PORT  Console port: $MINIO_CONSOLE_PORT"
echo "[minio] Bucket: $S3_BUCKET"

# Create data directory if it doesn't exist.
mkdir -p "$MINIO_DATA_DIR"

# Export credentials so minio binary and mc client pick them up.
export MINIO_ROOT_USER
export MINIO_ROOT_PASSWORD

# Start MinIO server in the foreground (the Replit workflow keeps it alive).
# --address binds the S3 API to port MINIO_API_PORT.
# --console-address binds the web UI to port MINIO_CONSOLE_PORT.
exec minio server "$MINIO_DATA_DIR" \
  --address "0.0.0.0:${MINIO_API_PORT}" \
  --console-address "0.0.0.0:${MINIO_CONSOLE_PORT}"
