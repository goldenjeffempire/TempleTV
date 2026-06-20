#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# keystore-setup.sh — Android signing key recovery helper
#
# Usage:
#   bash scripts/keystore-setup.sh verify   <keystore.jks>   — check SHA1
#   bash scripts/keystore-setup.sh generate                  — create new key + export PEM for Google
#   bash scripts/keystore-setup.sh wire     <keystore.jks>   — write credentials.json ready for EAS
#
# Expected SHA1 (registered with Google Play):
#   52:2C:16:01:87:CF:98:86:F2:FB:AB:3B:0A:3A:FC:B1:E8:BF:91:69
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

EXPECTED_SHA1="52:2C:16:01:87:CF:98:86:F2:FB:AB:3B:0A:3A:FC:B1:E8:BF:91:69"
KEY_ALIAS="templetv"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(dirname "$SCRIPT_DIR")"
CREDENTIALS_JSON="$MOBILE_DIR/credentials.json"

# ── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✔${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
err()  { echo -e "${RED}✖${NC}  $*"; }

# ── require keytool ──────────────────────────────────────────────────────────
if ! command -v keytool &>/dev/null; then
  err "keytool not found. Install a JDK: brew install temurin  (macOS) or apt install default-jdk (Linux)"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
verify() {
  local ks="${1:-}"
  if [[ -z "$ks" ]]; then
    err "Usage: bash scripts/keystore-setup.sh verify <path/to/keystore.jks>"
    exit 1
  fi
  if [[ ! -f "$ks" ]]; then
    err "File not found: $ks"
    exit 1
  fi

  echo ""
  echo "Checking keystore: $ks"
  echo "Key alias:         $KEY_ALIAS"
  echo ""

  read -rsp "Enter keystore password: " KS_PASS; echo ""

  local sha1
  sha1=$(keytool -list -v -keystore "$ks" -alias "$KEY_ALIAS" -storepass "$KS_PASS" 2>/dev/null \
    | grep "SHA1:" | awk '{print $2}' | tr -d '[:space:]')

  if [[ -z "$sha1" ]]; then
    warn "Could not read SHA1. The alias may be different. Listing all aliases:"
    keytool -list -keystore "$ks" -storepass "$KS_PASS" 2>/dev/null | grep "Alias name:" || true
    exit 1
  fi

  echo "SHA1 in keystore:  $sha1"
  echo "SHA1 expected:     $EXPECTED_SHA1"
  echo ""

  if [[ "$sha1" == "$EXPECTED_SHA1" ]]; then
    ok "SHA1 MATCHES — this is the correct keystore for Google Play."
    echo ""
    echo "Next step: wire it up with:"
    echo "  bash scripts/keystore-setup.sh wire $ks"
  else
    err "SHA1 DOES NOT MATCH — this is not the correct keystore."
    echo ""
    echo "If you cannot find the original, use Path B:"
    echo "  bash scripts/keystore-setup.sh generate"
    echo "  Then submit the generated upload_certificate.pem to Google Play support."
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
generate() {
  local out_ks="$MOBILE_DIR/release.keystore"
  local out_pem="$MOBILE_DIR/upload_certificate.pem"

  if [[ -f "$out_ks" ]]; then
    warn "release.keystore already exists. Delete it first if you want to regenerate."
    exit 1
  fi

  echo ""
  echo "Generating a new production keystore …"
  echo "You will be prompted to set passwords. Record them in your password manager."
  echo ""

  keytool -genkeypair \
    -alias "$KEY_ALIAS" \
    -keyalg RSA \
    -keysize 4096 \
    -validity 10000 \
    -keystore "$out_ks" \
    -dname "CN=Temple TV, OU=JCTM, O=Jesus Christ Temple Ministry, L=Lagos, ST=Lagos, C=NG"

  ok "Keystore created: $out_ks"

  # Export public certificate as PEM for Google
  echo ""
  echo "Exporting public certificate …"
  read -rsp "Enter keystore password again: " KS_PASS; echo ""

  keytool -export \
    -alias "$KEY_ALIAS" \
    -keystore "$out_ks" \
    -storepass "$KS_PASS" \
    -rfc \
    -file "$out_pem"

  ok "Certificate exported: $out_pem"

  local sha1
  sha1=$(keytool -list -v -keystore "$out_ks" -alias "$KEY_ALIAS" -storepass "$KS_PASS" 2>/dev/null \
    | grep "SHA1:" | awk '{print $2}' | tr -d '[:space:]')

  echo ""
  echo "New keystore SHA1: $sha1"
  echo ""
  warn "ACTION REQUIRED — Google Play Upload Key Reset:"
  echo ""
  echo "  1. Go to: https://support.google.com/googleplay/android-developer/contact/otherbugs"
  echo "  2. Subject: Request upload key reset for com.templetv.jctm"
  echo "  3. Attach:  $out_pem"
  echo "  4. Include: package name (com.templetv.jctm) + account email"
  echo "  5. Google responds in 1–3 business days"
  echo ""
  echo "After Google approves, run:"
  echo "  bash scripts/keystore-setup.sh wire $out_ks"
}

# ─────────────────────────────────────────────────────────────────────────────
wire() {
  local ks="${1:-}"
  if [[ -z "$ks" ]]; then
    err "Usage: bash scripts/keystore-setup.sh wire <path/to/keystore.jks>"
    exit 1
  fi
  if [[ ! -f "$ks" ]]; then
    err "File not found: $ks"
    exit 1
  fi

  # Copy keystore to mobile dir if not already there
  local target="$MOBILE_DIR/release.keystore"
  if [[ "$(realpath "$ks")" != "$(realpath "$target" 2>/dev/null || echo "")" ]]; then
    cp "$ks" "$target"
    ok "Copied to: $target"
  fi

  read -rsp "Enter keystore password: " KS_PASS; echo ""
  read -rsp "Enter key password (press Enter if same as keystore): " KEY_PASS; echo ""
  if [[ -z "$KEY_PASS" ]]; then
    KEY_PASS="$KS_PASS"
  fi

  cat > "$CREDENTIALS_JSON" <<EOF
{
  "android": {
    "keystore": {
      "keystorePath": "./release.keystore",
      "keystorePassword": "$KS_PASS",
      "keyAlias": "$KEY_ALIAS",
      "keyPassword": "$KEY_PASS"
    }
  }
}
EOF

  ok "credentials.json written: $CREDENTIALS_JSON"
  echo ""
  ok "Ready to build. Run from artifacts/mobile/:"
  echo "  eas build --platform android --profile production-android"
}

# ─────────────────────────────────────────────────────────────────────────────
cmd="${1:-help}"
case "$cmd" in
  verify)   verify   "${2:-}" ;;
  generate) generate ;;
  wire)     wire     "${2:-}" ;;
  *)
    echo ""
    echo "Android signing key helper"
    echo ""
    echo "  bash scripts/keystore-setup.sh verify   <keystore.jks>  — check SHA1 fingerprint"
    echo "  bash scripts/keystore-setup.sh generate                  — create new key + PEM for Google reset"
    echo "  bash scripts/keystore-setup.sh wire     <keystore.jks>  — write credentials.json for EAS local build"
    echo ""
    ;;
esac
