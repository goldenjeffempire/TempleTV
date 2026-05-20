#!/usr/bin/env bash
# =============================================================================
# Temple TV — Sentry Release + Source Map Upload
# =============================================================================
#
# Creates a Sentry release and uploads source maps for:
#   - API server (Node.js)
#   - Admin web app (Vite)
#   - TV web app (Vite)
#
# Usage:
#   bash scripts/sentry-release.sh [version]
#
# Required environment variables:
#   SENTRY_AUTH_TOKEN — Sentry API auth token
#   SENTRY_ORG        — Sentry organization slug (default: templetv)
#
# Optional:
#   SENTRY_URL        — Sentry instance URL (default: https://sentry.io)
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

: "${SENTRY_AUTH_TOKEN:?SENTRY_AUTH_TOKEN is required}"
SENTRY_ORG="${SENTRY_ORG:-templetv}"
SENTRY_URL="${SENTRY_URL:-https://sentry.io}"

# ── Version ───────────────────────────────────────────────────────────────────
if [ -n "${1:-}" ]; then
  VERSION="$1"
else
  VERSION="$(node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('artifacts/mobile/app.json', 'utf8'));
    console.log(p.expo.version);
  ")"
fi
RELEASE_TAG="v${VERSION}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Temple TV — Sentry Release Upload"
echo "  Version: $RELEASE_TAG"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

export SENTRY_AUTH_TOKEN SENTRY_ORG SENTRY_URL

# ── Check sentry-cli ─────────────────────────────────────────────────────────
if ! command -v sentry-cli &>/dev/null; then
  echo "Installing sentry-cli..."
  npm install -g @sentry/cli
fi

sentry_upload() {
  local PROJECT="$1"
  local DIST_DIR="$2"
  local URL_PREFIX="$3"

  if [ ! -d "$DIST_DIR" ]; then
    echo "⚠️  $DIST_DIR not found — skipping $PROJECT"
    return
  fi

  echo ""
  echo "→ Uploading $PROJECT source maps..."

  # Create release
  sentry-cli releases new "$RELEASE_TAG" \
    --project "$PROJECT" || true

  # Associate commits
  sentry-cli releases set-commits "$RELEASE_TAG" \
    --project "$PROJECT" \
    --auto || true

  # Upload source maps
  sentry-cli releases files "$RELEASE_TAG" upload-sourcemaps "$DIST_DIR" \
    --project "$PROJECT" \
    --url-prefix "$URL_PREFIX" \
    --rewrite \
    --ignore-file .sentrycliignore 2>/dev/null || true

  # Finalize release
  sentry-cli releases finalize "$RELEASE_TAG" \
    --project "$PROJECT" || true

  echo "✅ $PROJECT source maps uploaded"
}

# ── API Server ────────────────────────────────────────────────────────────────
pnpm --filter @workspace/api-server run build 2>/dev/null || true
sentry_upload \
  "${SENTRY_PROJECT_API:-temple-tv-api}" \
  "artifacts/api-server/dist" \
  "~/"

# ── Admin web app ─────────────────────────────────────────────────────────────
pnpm --filter @workspace/admin run build 2>/dev/null || true
sentry_upload \
  "${SENTRY_PROJECT_ADMIN:-temple-tv-admin}" \
  "artifacts/admin/dist" \
  "~/admin/"

# ── TV web app ────────────────────────────────────────────────────────────────
pnpm --filter @workspace/tv run build 2>/dev/null || true
sentry_upload \
  "${SENTRY_PROJECT_TV:-temple-tv-tv}" \
  "artifacts/tv/dist" \
  "~/"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Sentry release $RELEASE_TAG complete"
echo "   View at: https://sentry.io/organizations/$SENTRY_ORG/releases/$RELEASE_TAG/"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
