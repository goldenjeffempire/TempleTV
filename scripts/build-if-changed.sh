#!/usr/bin/env bash
# Rebuilds the API server only when source files have changed since the last build.
# Checks artifacts/api-server/src and all lib/* packages (bundled into the server).
# Called by the "Start API" workflow so restarts triggered by the memory watchdog
# do not re-run the expensive esbuild step (3 bundles + source maps ≈ 500 MB peak).
set -euo pipefail

DIST="artifacts/api-server/dist/index.mjs"

if [ ! -f "$DIST" ]; then
  echo "[build] No dist found — building API server..."
  pnpm --filter @workspace/api-server run build
  exit 0
fi

CHANGED=$(find artifacts/api-server/src lib -name '*.ts' -newer "$DIST" 2>/dev/null | head -1)

if [ -n "$CHANGED" ]; then
  echo "[build] Source changed (e.g. $CHANGED) — rebuilding API server..."
  pnpm --filter @workspace/api-server run build
else
  echo "[build] Dist is up to date — skipping rebuild."
fi
