#!/usr/bin/env bash
# Rebuilds the API server, Admin SPA, and TV SPA when their source files have
# changed since the last build.  Called by the "Start API" workflow so restarts
# triggered by the memory watchdog do not re-run expensive build steps.
#
# Change detection uses mtime comparison against each package's dist sentinel:
#   API server  → artifacts/api-server/dist/index.mjs
#   Admin SPA   → artifacts/admin/dist/public/index.html
#   TV SPA      → artifacts/tv/dist/public/index.html
#
# Source trees watched:
#   API  : artifacts/api-server/src + all lib/* packages
#   Admin: artifacts/admin/src       + all lib/* packages
#   TV   : artifacts/tv/src          + all lib/* packages
set -euo pipefail

# ── API server ────────────────────────────────────────────────────────────────
API_DIST="artifacts/api-server/dist/index.mjs"

if [ ! -f "$API_DIST" ]; then
  echo "[build] API dist not found — building API server..."
  pnpm --filter @workspace/api-server run build
else
  CHANGED=$(find artifacts/api-server/src lib -name '*.ts' -newer "$API_DIST" 2>/dev/null | head -1)
  if [ -n "$CHANGED" ]; then
    echo "[build] API source changed (e.g. $CHANGED) — rebuilding API server..."
    pnpm --filter @workspace/api-server run build
  else
    echo "[build] API dist is up to date — skipping rebuild."
  fi
fi

# ── Admin SPA ─────────────────────────────────────────────────────────────────
ADMIN_DIST="artifacts/admin/dist/public/index.html"

if [ ! -f "$ADMIN_DIST" ]; then
  echo "[build] Admin SPA dist not found — building..."
  NODE_ENV=production CI=true pnpm --filter @workspace/admin run build
else
  CHANGED=$(find artifacts/admin/src lib -name '*.ts' -o -name '*.tsx' -o -name '*.css' 2>/dev/null | \
    xargs -r ls -t 2>/dev/null | head -1)
  # Use a simpler newer-than check
  CHANGED=$(find artifacts/admin/src lib \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) \
    -newer "$ADMIN_DIST" 2>/dev/null | head -1)
  if [ -n "$CHANGED" ]; then
    echo "[build] Admin SPA source changed (e.g. $CHANGED) — rebuilding..."
    NODE_ENV=production CI=true pnpm --filter @workspace/admin run build
  else
    echo "[build] Admin SPA dist is up to date — skipping rebuild."
  fi
fi

# ── TV SPA ────────────────────────────────────────────────────────────────────
TV_DIST="artifacts/tv/dist/public/index.html"

if [ ! -f "$TV_DIST" ]; then
  echo "[build] TV SPA dist not found — building..."
  BASE_PATH=/tv/ NODE_ENV=production CI=true pnpm --filter @workspace/tv run build
else
  CHANGED=$(find artifacts/tv/src lib \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) \
    -newer "$TV_DIST" 2>/dev/null | head -1)
  if [ -n "$CHANGED" ]; then
    echo "[build] TV SPA source changed (e.g. $CHANGED) — rebuilding..."
    BASE_PATH=/tv/ NODE_ENV=production CI=true pnpm --filter @workspace/tv run build
  else
    echo "[build] TV SPA dist is up to date — skipping rebuild."
  fi
fi
