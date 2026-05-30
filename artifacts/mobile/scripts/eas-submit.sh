#!/usr/bin/env bash
# =============================================================================
# eas-submit.sh — Submit an EAS build to the Play Store or TestFlight
# =============================================================================
#
# Usage:
#   cd artifacts/mobile
#   bash scripts/eas-submit.sh [android|ios] [--latest | --id <build-id>] [--track internal|alpha|beta|production]
#
# Required environment variables:
#   EXPO_ACCESS_TOKEN           — EAS personal access token (Replit Secret)
#   GOOGLE_SERVICE_ACCOUNT_JSON — Google Play service account JSON (Replit Secret, Android only)
#
# Optional:
#   APPLE_API_KEY_P8            — App Store Connect .p8 key content (iOS only)
#   APPLE_API_KEY_ID            — ASC API key ID (iOS only)
#   APPLE_API_KEY_ISSUER_ID     — ASC API key issuer UUID (iOS only)
#
# How to get the Google Play service account key:
#   1. Open Google Play Console → Setup → API access → Service accounts
#   2. Click "Manage Google Cloud Project" → create a service account
#      with "Service Account User" + "Service Account Token Creator" roles
#   3. Back in Play Console, grant the service account "Release manager" permission
#   4. In Cloud Console, create a JSON key for the service account
#   5. Paste the entire JSON content as a Replit Secret named GOOGLE_SERVICE_ACCOUNT_JSON
#   6. Re-run this script — it writes the secret to disk before submitting
#      and removes it on exit (trap).
#
# =============================================================================
set -euo pipefail

PLATFORM="${1:-android}"
BUILD_FLAG="${2:---latest}"
TRACK="${3:-internal}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SA_FILE="$MOBILE_DIR/google-service-account.json"
ASC_KEY_FILE="/tmp/asc-api-key-submit.p8"

cleanup() {
  rm -f "$SA_FILE" "$ASC_KEY_FILE"
}
trap cleanup EXIT

cd "$MOBILE_DIR"

# ── Validate inputs ─────────────────────────────────────────────────────────
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
    echo "  1. Follow the steps in scripts/eas-submit.sh header to create the key"
    echo "  2. Add GOOGLE_SERVICE_ACCOUNT_JSON as a Replit Secret"
    echo "  3. Re-run this script"
    exit 1
  fi
  echo "$GOOGLE_SERVICE_ACCOUNT_JSON" > "$SA_FILE"
  echo "[eas-submit] Service account key written to $SA_FILE"
fi

# ── iOS: write App Store Connect API key ────────────────────────────────────
if [[ "$PLATFORM" == "ios" ]]; then
  if [[ -z "${APPLE_API_KEY_P8:-}" || -z "${APPLE_API_KEY_ID:-}" || -z "${APPLE_API_KEY_ISSUER_ID:-}" ]]; then
    echo "ERROR: APPLE_API_KEY_P8, APPLE_API_KEY_ID, APPLE_API_KEY_ISSUER_ID must all be set." >&2
    exit 1
  fi
  echo "$APPLE_API_KEY_P8" > "$ASC_KEY_FILE"
  chmod 600 "$ASC_KEY_FILE"
  echo "[eas-submit] ASC key written to $ASC_KEY_FILE"

  # Patch eas.json with ASC key metadata (removed on exit via cleanup)
  node -e "
    const fs = require('fs');
    const eas = JSON.parse(fs.readFileSync('eas.json', 'utf8'));
    eas.submit.production.ios.ascApiKeyPath     = '$ASC_KEY_FILE';
    eas.submit.production.ios.ascApiKeyId       = '${APPLE_API_KEY_ID}';
    eas.submit.production.ios.ascApiIssuerId    = '${APPLE_API_KEY_ISSUER_ID}';
    fs.writeFileSync('eas.json', JSON.stringify(eas, null, 2) + '\n');
  "
fi

# ── Patch Android track if not internal ────────────────────────────────────
if [[ "$PLATFORM" == "android" && "$TRACK" != "internal" ]]; then
  node -e "
    const fs = require('fs');
    const eas = JSON.parse(fs.readFileSync('eas.json', 'utf8'));
    eas.submit.production.android.track = '${TRACK}';
    fs.writeFileSync('eas.json', JSON.stringify(eas, null, 2) + '\n');
  "
  echo "[eas-submit] Android track set to: $TRACK"
fi

# ── Submit ───────────────────────────────────────────────────────────────────
echo "[eas-submit] Submitting $PLATFORM build ($BUILD_FLAG) …"
GIT_INDEX_FILE=/tmp/eas-submit-index \
  EXPO_TOKEN="$EXPO_ACCESS_TOKEN" \
  eas submit \
    --platform "$PLATFORM" \
    --profile production \
    $BUILD_FLAG \
    --non-interactive

echo "[eas-submit] Done."
