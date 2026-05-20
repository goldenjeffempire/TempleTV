#!/usr/bin/env bash
# =============================================================================
# Temple TV — TV Web Assets → AWS S3 + CloudFront Deploy
# =============================================================================
#
# Deploys the TV web app (FireTV / web) to S3 and invalidates CloudFront.
# Samsung (.wgt) and LG (.ipk) files are uploaded as store-submission packages.
#
# Usage:
#   bash scripts/deploy-tv-cdn.sh [--dry-run] [--platform firetv|all]
#
# Required environment variables:
#   AWS_ACCESS_KEY_ID       — AWS credentials
#   AWS_SECRET_ACCESS_KEY   — AWS credentials
#   AWS_REGION              — e.g. eu-north-1
#   S3_BUCKET               — target bucket name (e.g. temple-tv-web)
#   CLOUDFRONT_DISTRIBUTION_ID  — optional, for cache invalidation
#
# Optional:
#   S3_TV_PREFIX            — path prefix in bucket (default: "tv/")
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DRY_RUN=false
PLATFORM="all"

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --platform=*) PLATFORM="${arg#--platform=}" ;;
  esac
done

# ── Validate required vars ────────────────────────────────────────────────────
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"
: "${AWS_REGION:?AWS_REGION is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"

TV_PREFIX="${S3_TV_PREFIX:-tv/}"
DIST="$REPO_ROOT/artifacts/tv/dist"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Temple TV — CDN Deploy  (bucket: $S3_BUCKET)"
$DRY_RUN && echo "  [DRY RUN — no changes will be made]"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

sync_platform() {
  local PLATFORM_DIR="$1"
  local S3_PREFIX="$2"
  local DIST_PATH="$DIST/$PLATFORM_DIR"

  if [ ! -d "$DIST_PATH" ]; then
    echo "⚠️  $DIST_PATH not found — skipping (run build first)"
    return
  fi

  echo ""
  echo "→ Syncing $PLATFORM_DIR → s3://${S3_BUCKET}/${S3_PREFIX}"

  DRY_RUN_FLAG=""
  $DRY_RUN && DRY_RUN_FLAG="--dryrun"

  # Static assets: long cache TTL, immutable
  aws s3 sync "$DIST_PATH" "s3://${S3_BUCKET}/${S3_PREFIX}" \
    $DRY_RUN_FLAG \
    --delete \
    --exclude "*.html" \
    --exclude "*.json" \
    --exclude "*.webmanifest" \
    --cache-control "public, max-age=31536000, immutable" \
    --region "$AWS_REGION"

  # HTML / manifest / JSON: no cache
  aws s3 sync "$DIST_PATH" "s3://${S3_BUCKET}/${S3_PREFIX}" \
    $DRY_RUN_FLAG \
    --delete \
    --include "*.html" \
    --include "*.json" \
    --include "*.webmanifest" \
    --cache-control "no-cache, no-store, must-revalidate" \
    --region "$AWS_REGION"

  echo "✅ $PLATFORM_DIR synced"
}

# ── Deploy FireTV web assets ──────────────────────────────────────────────────
if [ "$PLATFORM" = "all" ] || [ "$PLATFORM" = "firetv" ]; then
  sync_platform "firetv" "${TV_PREFIX}firetv/"
fi

# ── Deploy generic TV assets (fallback) ───────────────────────────────────────
if [ "$PLATFORM" = "all" ] && [ -d "$DIST/tizen" ]; then
  # Copy Tizen dist (without .wgt packaging) for web fallback
  sync_platform "tizen" "${TV_PREFIX}samsung/"
fi

# ── Upload store packages as release artifacts ────────────────────────────────
PACKAGES_DIR="$REPO_ROOT/artifacts/tv/packages"
if [ -d "$PACKAGES_DIR" ] && [ "$PLATFORM" = "all" ]; then
  PACKAGES_PREFIX="${TV_PREFIX}releases/"
  echo ""
  echo "→ Uploading store packages to s3://${S3_BUCKET}/${PACKAGES_PREFIX}"
  for PKG in "$PACKAGES_DIR"/*.{wgt,ipk} 2>/dev/null; do
    [ -f "$PKG" ] || continue
    BASENAME="$(basename "$PKG")"
    DRY_FLAG=""
    $DRY_RUN && DRY_FLAG="--dryrun"
    aws s3 cp "$PKG" "s3://${S3_BUCKET}/${PACKAGES_PREFIX}${BASENAME}" \
      $DRY_FLAG \
      --region "$AWS_REGION"
    echo "✅ Uploaded $BASENAME"
  done
fi

# ── CloudFront cache invalidation ─────────────────────────────────────────────
if [ -n "${CLOUDFRONT_DISTRIBUTION_ID:-}" ] && ! $DRY_RUN; then
  echo ""
  echo "→ Invalidating CloudFront distribution $CLOUDFRONT_DISTRIBUTION_ID"
  INVALIDATION_ID="$(aws cloudfront create-invalidation \
    --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
    --paths "/${TV_PREFIX}*" \
    --query 'Invalidation.Id' \
    --output text)"
  echo "✅ CloudFront invalidation created: $INVALIDATION_ID"
  echo "   Status check: aws cloudfront get-invalidation --distribution-id $CLOUDFRONT_DISTRIBUTION_ID --id $INVALIDATION_ID"
else
  [ -z "${CLOUDFRONT_DISTRIBUTION_ID:-}" ] && echo "ℹ️  CLOUDFRONT_DISTRIBUTION_ID not set — skipping cache invalidation"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  CDN deploy complete!"
$DRY_RUN && echo "  (DRY RUN — no actual changes were made)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
