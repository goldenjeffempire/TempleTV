#!/usr/bin/env bash
# =============================================================================
# eas-submit.sh — Submit an EAS build to the Play Store or TestFlight
# =============================================================================
#
# Usage:
#   cd artifacts/mobile
#   bash scripts/eas-submit.sh [android|ios] [--latest | --id <build-id>] [--track <track>]
#
#   android|ios          Platform to submit (default: android)
#   --latest             Submit the latest successful build (default)
#   --id <build-id>      Submit a specific EAS build ID
#   --track <track>      Android track: internal|alpha|beta|production (default: internal)
#
# Required environment variables:
#   EXPO_ACCESS_TOKEN           — EAS personal access token (Replit Secret)
#   GOOGLE_SERVICE_ACCOUNT_JSON — Google Play service account JSON (Replit Secret, Android only)
#
# Optional (iOS only):
#   APPLE_API_KEY_P8            — App Store Connect .p8 key content
#   APPLE_API_KEY_ID            — ASC API key ID
#   APPLE_API_KEY_ISSUER_ID     — ASC API key issuer UUID
#
# How to get the Google Play service account key (one-time setup):
#   1. Google Play Console → Setup → API access → Link a Google Cloud project
#   2. Cloud Console → IAM & Admin → Service Accounts → Create Service Account
#      (name it e.g. "temple-tv-eas-submit")
#   3. Back in Play Console: grant the service account "Release manager" permission
#   4. Cloud Console → Service Account → Keys → Add Key → Create new key → JSON
#   5. Paste the entire JSON content as a Replit Secret named GOOGLE_SERVICE_ACCOUNT_JSON
#      (also add it as a GitHub secret for CI/CD)
#   See: .local/GOOGLE_PLAY_SUBMIT_NOTES.md for full instructions
#
# =============================================================================
set -euo pipefail

# ── Parse arguments ──────────────────────────────────────────────────────────
PLATFORM="android"
BUILD_FLAG="--latest"
TRACK="internal"

while [[ $# -gt 0 ]]; do
  case "$1" in
    android|ios) PLATFORM="$1"; shift ;;
    --latest)    BUILD_FLAG="--latest"; shift ;;
    --id)        BUILD_FLAG="--id $2"; shift 2 ;;
    --track)     TRACK="$2"; shift 2 ;;
    *)           echo "ERROR: Unknown argument: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SA_FILE="$MOBILE_DIR/google-service-account.json"
ASC_KEY_FILE="/tmp/asc-api-key-submit.p8"
# Snapshot eas.json before any patches so we can restore it on exit.
EAS_JSON_ORIG="$(cat "$MOBILE_DIR/eas.json")"

cleanup() {
  rm -f "$SA_FILE" "$ASC_KEY_FILE"
  # Restore eas.json to its original state so local track/key patches
  # made by this script don't persist after the submit completes.
  echo "$EAS_JSON_ORIG" > "$MOBILE_DIR/eas.json"
}
trap cleanup EXIT

cd "$MOBILE_DIR"

# ── Validate inputs ──────────────────────────────────────────────────────────
if [[ "$PLATFORM" != "android" && "$PLATFORM" != "ios" ]]; then
  echo "ERROR: platform must be 'android' or 'ios', got: $PLATFORM" >&2
  exit 1
fi

if [[ -z "${EXPO_ACCESS_TOKEN:-}" ]]; then
  echo "ERROR: EXPO_ACCESS_TOKEN is not set. Set it as a Replit Secret." >&2
  exit 1
fi

# ── Android: write service account key ──────────────────────────────────────
if [[ "$PLATFORM" == "android" ]]; then
  if [[ -z "${GOOGLE_SERVICE_ACCOUNT_JSON:-}" ]]; then
    echo "ERROR: GOOGLE_SERVICE_ACCOUNT_JSON is not set." >&2
    echo ""
    echo "To fix:"
    echo "  1. Follow the steps in .local/GOOGLE_PLAY_SUBMIT_NOTES.md to create"
    echo "     a Google Play service account and download its JSON key"
    echo "  2. Add GOOGLE_SERVICE_ACCOUNT_JSON as a Replit Secret (paste the"
    echo "     entire JSON content as the value)"
    echo "  3. Re-run this script"
    exit 1
  fi
  printf '%s' "$GOOGLE_SERVICE_ACCOUNT_JSON" > "$SA_FILE"
  echo "[eas-submit] Service account key written to $SA_FILE (removed on exit)"
fi

# ── iOS: write App Store Connect API key ─────────────────────────────────────
if [[ "$PLATFORM" == "ios" ]]; then
  if [[ -z "${APPLE_API_KEY_P8:-}" || -z "${APPLE_API_KEY_ID:-}" || -z "${APPLE_API_KEY_ISSUER_ID:-}" ]]; then
    echo "ERROR: APPLE_API_KEY_P8, APPLE_API_KEY_ID, and APPLE_API_KEY_ISSUER_ID must all be set." >&2
    exit 1
  fi
  printf '%s' "$APPLE_API_KEY_P8" > "$ASC_KEY_FILE"
  chmod 600 "$ASC_KEY_FILE"
  echo "[eas-submit] ASC key written to $ASC_KEY_FILE (removed on exit)"

  # Patch eas.json with ASC key metadata (eas.json is restored by trap on exit)
  node -e "
    const fs = require('fs');
    const eas = JSON.parse(fs.readFileSync('eas.json', 'utf8'));
    eas.submit.production.ios.ascApiKeyPath   = '$ASC_KEY_FILE';
    eas.submit.production.ios.ascApiKeyId     = '${APPLE_API_KEY_ID}';
    eas.submit.production.ios.ascApiIssuerId  = '${APPLE_API_KEY_ISSUER_ID}';
    fs.writeFileSync('eas.json', JSON.stringify(eas, null, 2) + '\n');
  "
fi

# ── Patch Android track if not 'internal' ────────────────────────────────────
if [[ "$PLATFORM" == "android" && "$TRACK" != "internal" ]]; then
  node -e "
    const fs = require('fs');
    const eas = JSON.parse(fs.readFileSync('eas.json', 'utf8'));
    eas.submit.production.android.track = '${TRACK}';
    fs.writeFileSync('eas.json', JSON.stringify(eas, null, 2) + '\n');
  "
  echo "[eas-submit] Android track set to: $TRACK (eas.json restored on exit)"
fi

# ── Submit ────────────────────────────────────────────────────────────────────
echo "[eas-submit] Submitting $PLATFORM build ($BUILD_FLAG) to ${TRACK} …"
# GIT_INDEX_FILE redirects the git index lock to /tmp so EAS CLI can archive
# project files without hitting "could not lock index" in restricted environments.
GIT_INDEX_FILE=/tmp/eas-submit-index \
  EXPO_TOKEN="$EXPO_ACCESS_TOKEN" \
  eas submit \
    --platform "$PLATFORM" \
    --profile production \
    $BUILD_FLAG \
    --non-interactive

echo "[eas-submit] Done. Check Play Console → Internal testing for the new build."
