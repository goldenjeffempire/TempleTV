#!/usr/bin/env bash
# Rebuilds the API server, Admin SPA, TV SPA, and Mobile web app when their
# source files have changed since the last build.  Called by the "Start API"
# workflow so restarts triggered by the memory watchdog do not re-run
# expensive build steps.
#
# Change detection uses mtime comparison against each package's dist sentinel:
#   API server  → artifacts/api-server/dist/index.mjs
#   Admin SPA   → artifacts/admin/dist/public/index.html
#   TV SPA      → artifacts/tv/dist/public/index.html
#   Mobile web  → artifacts/mobile/web-dist/index.html
#
# Source trees watched:
#   API    : artifacts/api-server/src + all lib/* packages
#   Admin  : artifacts/admin/src       + all lib/* packages
#   TV     : artifacts/tv/src          + all lib/* packages
#   Mobile : artifacts/mobile/{app,components,hooks,context,constants,modules}
#
# Note: -print -quit is used instead of "| head -1" to avoid SIGPIPE (exit 141)
# under set -o pipefail when find exits early after the first match.
set -euo pipefail

# ── API server ────────────────────────────────────────────────────────────────
API_DIST="artifacts/api-server/dist/index.mjs"

if [ ! -f "$API_DIST" ]; then
  echo "[build] API dist not found — building API server..."
  pnpm --filter @workspace/api-server run build
else
  CHANGED=$(find artifacts/api-server/src lib -name '*.ts' -newer "$API_DIST" -print -quit 2>/dev/null)
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
  CHANGED=$(find artifacts/admin/src lib \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) \
    -newer "$ADMIN_DIST" -print -quit 2>/dev/null)
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
    -newer "$TV_DIST" -print -quit 2>/dev/null)
  if [ -n "$CHANGED" ]; then
    echo "[build] TV SPA source changed (e.g. $CHANGED) — rebuilding..."
    BASE_PATH=/tv/ NODE_ENV=production CI=true pnpm --filter @workspace/tv run build
  else
    echo "[build] TV SPA dist is up to date — skipping rebuild."
  fi
fi

# ── Mobile web ────────────────────────────────────────────────────────────────
# Watches: app/, components/, hooks/, context/, constants/, modules/ (all exist).
# Uses EXPO_BASE_URL=/mobile so assets resolve correctly under the /mobile prefix.
MOBILE_DIST="artifacts/mobile/web-dist/index.html"

# Build a list of mobile source dirs that actually exist to avoid find errors.
MOBILE_SRCDIRS=""
for d in artifacts/mobile/app artifacts/mobile/components artifacts/mobile/hooks \
          artifacts/mobile/context artifacts/mobile/constants artifacts/mobile/modules; do
  [ -d "$d" ] && MOBILE_SRCDIRS="$MOBILE_SRCDIRS $d"
done

if [ ! -f "$MOBILE_DIST" ]; then
  echo "[build] Mobile web dist not found — building..."
  EXPO_BASE_URL=/mobile CI=true pnpm --filter @workspace/mobile run build:web
elif [ -n "$MOBILE_SRCDIRS" ]; then
  # shellcheck disable=SC2086
  CHANGED=$(find $MOBILE_SRCDIRS \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \) \
    -newer "$MOBILE_DIST" -print -quit 2>/dev/null)
  if [ -n "$CHANGED" ]; then
    echo "[build] Mobile web source changed (e.g. $CHANGED) — rebuilding..."
    EXPO_BASE_URL=/mobile CI=true pnpm --filter @workspace/mobile run build:web
  else
    echo "[build] Mobile web dist is up to date — skipping rebuild."
  fi
else
  echo "[build] Mobile web: no source dirs found — skipping check."
fi
