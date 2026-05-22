#!/usr/bin/env bash
# eas-build-pre-install.sh
#
# EAS Build pre-install hook — runs before npm/pnpm install on every EAS build.
# Injects Firebase credential files from EAS secrets so they're available
# during the native Android/iOS build phases.
#
# Required EAS secrets (set via: eas secret:create --scope project):
#   GOOGLE_SERVICES_JSON_BASE64         — base64-encoded android google-services.json
#   GOOGLE_SERVICE_INFO_PLIST_BASE64    — base64-encoded ios GoogleService-Info.plist
#
# To create the secrets:
#   eas secret:create --scope project --name GOOGLE_SERVICES_JSON_BASE64 \
#       --value "$(base64 -w 0 artifacts/mobile/google-services.json)"
#   eas secret:create --scope project --name GOOGLE_SERVICE_INFO_PLIST_BASE64 \
#       --value "$(base64 -w 0 artifacts/mobile/GoogleService-Info.plist)"
#
# On macOS the base64 flag is: base64 -i file -o - (no -w flag needed)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[pre-install] Temple TV — injecting Firebase credential files"

# ── Android: google-services.json ─────────────────────────────────────────────
if [ -n "${GOOGLE_SERVICES_JSON_BASE64:-}" ]; then
  echo "[pre-install] Injecting google-services.json from EAS secret"
  echo "$GOOGLE_SERVICES_JSON_BASE64" | base64 --decode > "$SCRIPT_DIR/google-services.json"
  echo "[pre-install] google-services.json written ($(wc -c < "$SCRIPT_DIR/google-services.json") bytes)"
else
  echo "[pre-install] GOOGLE_SERVICES_JSON_BASE64 not set — using placeholder google-services.json"
  echo "[pre-install] WARNING: Push notifications will NOT work without real Firebase credentials"
fi

# ── iOS: GoogleService-Info.plist ─────────────────────────────────────────────
if [ -n "${GOOGLE_SERVICE_INFO_PLIST_BASE64:-}" ]; then
  echo "[pre-install] Injecting GoogleService-Info.plist from EAS secret"
  echo "$GOOGLE_SERVICE_INFO_PLIST_BASE64" | base64 --decode > "$SCRIPT_DIR/GoogleService-Info.plist"
  echo "[pre-install] GoogleService-Info.plist written ($(wc -c < "$SCRIPT_DIR/GoogleService-Info.plist") bytes)"
else
  echo "[pre-install] GOOGLE_SERVICE_INFO_PLIST_BASE64 not set — using placeholder GoogleService-Info.plist"
fi

echo "[pre-install] Done."
