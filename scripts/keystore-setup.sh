#!/usr/bin/env bash
# =============================================================================
# Temple TV — Android Keystore Setup & Management
# =============================================================================
#
# Generates a production Android release keystore and prints the environment
# variables needed for CI/CD signing.
#
# IMPORTANT: Back up the generated .jks file and all passwords in a secure
# vault (1Password, AWS Secrets Manager, GitHub Secrets, etc.).
# Losing the keystore means you CANNOT update your Play Store app — you would
# need to publish a new app with a different package name.
#
# Usage:
#   bash scripts/keystore-setup.sh              # interactive
#   bash scripts/keystore-setup.sh --export     # also export to .env.signing
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYSTORE_DIR="$REPO_ROOT/artifacts/mobile/android/keystores"
mkdir -p "$KEYSTORE_DIR"

EXPORT_ENV=false
[ "${1:-}" = "--export" ] && EXPORT_ENV=true

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║      Temple TV — Android Keystore Generator             ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "This will generate a production Android signing keystore."
echo "Keep the output VERY SAFE — losing it means you cannot update your app."
echo ""

# ── Validate Java keytool is available ────────────────────────────────────────
if ! command -v keytool &>/dev/null; then
  echo "ERROR: keytool not found. Install JDK:"
  echo "  macOS:  brew install openjdk"
  echo "  Linux:  apt install default-jdk"
  exit 1
fi

# ── Collect parameters ────────────────────────────────────────────────────────
KEYSTORE_FILE="$KEYSTORE_DIR/templetv-release.jks"
KEY_ALIAS="${KEYSTORE_KEY_ALIAS:-templetv}"
APP_PACKAGE="com.templetv.jctm"

if [ -f "$KEYSTORE_FILE" ]; then
  echo "⚠️  Keystore already exists at $KEYSTORE_FILE"
  read -r -p "Overwrite? [y/N] " ANSWER
  [[ "${ANSWER:-N}" =~ ^[yY]$ ]] || { echo "Aborted."; exit 0; }
fi

echo ""
echo "Enter keystore password (≥8 chars, store securely):"
read -r -s KEYSTORE_PASS
echo ""
echo "Confirm keystore password:"
read -r -s KEYSTORE_PASS2
echo ""
[ "$KEYSTORE_PASS" = "$KEYSTORE_PASS2" ] || { echo "Passwords do not match."; exit 1; }
[ "${#KEYSTORE_PASS}" -ge 8 ] || { echo "Password must be ≥8 characters."; exit 1; }

echo "Enter key password (press Enter to use same as keystore):"
read -r -s KEY_PASS
echo ""
[ -z "$KEY_PASS" ] && KEY_PASS="$KEYSTORE_PASS"

# ── Generate keystore ─────────────────────────────────────────────────────────
echo "Generating keystore..."
keytool -genkeypair \
  -v \
  -storetype JKS \
  -keystore "$KEYSTORE_FILE" \
  -alias "$KEY_ALIAS" \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000 \
  -storepass "$KEYSTORE_PASS" \
  -keypass "$KEY_PASS" \
  -dname "CN=Temple TV, OU=Engineering, O=Jesus Christ Temple Ministry, L=Lagos, S=Lagos, C=NG"

echo ""
echo "✅ Keystore generated: $KEYSTORE_FILE"

# ── Print SHA fingerprints ────────────────────────────────────────────────────
echo ""
echo "── Certificate fingerprints ──────────────────────────────────"
keytool -list -v \
  -keystore "$KEYSTORE_FILE" \
  -alias "$KEY_ALIAS" \
  -storepass "$KEYSTORE_PASS" \
  2>/dev/null | grep -E "SHA1|SHA256" || true

# ── Print environment variables ───────────────────────────────────────────────
KEYSTORE_BASE64="$(base64 < "$KEYSTORE_FILE" | tr -d '\n')"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Store these in GitHub Secrets / CI environment variables   ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "KEYSTORE_PATH=$(realpath "$KEYSTORE_FILE")"
echo "KEYSTORE_PASSWORD=$KEYSTORE_PASS"
echo "KEY_ALIAS=$KEY_ALIAS"
echo "KEY_PASSWORD=$KEY_PASS"
echo ""
echo "For EAS Build (base64 encoded — paste into EAS secrets):"
echo "ANDROID_KEYSTORE_BASE64=${KEYSTORE_BASE64:0:40}... (truncated — see .env.signing)"

if $EXPORT_ENV; then
  ENV_FILE="$REPO_ROOT/.env.signing"
  cat > "$ENV_FILE" << EOF
# Temple TV — Android Signing (KEEP SECRET — add to .gitignore)
# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
KEYSTORE_PATH=$(realpath "$KEYSTORE_FILE")
KEYSTORE_PASSWORD=$KEYSTORE_PASS
KEY_ALIAS=$KEY_ALIAS
KEY_PASSWORD=$KEY_PASS
ANDROID_KEYSTORE_BASE64=$KEYSTORE_BASE64
EOF
  echo ""
  echo "✅ Signing env written to .env.signing"
  echo "   Add to .gitignore immediately: echo '.env.signing' >> .gitignore"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  IMPORTANT:"
echo "  1. Back up $KEYSTORE_FILE to a secure vault NOW"
echo "  2. Store the passwords in a password manager"
echo "  3. Never commit the .jks file or passwords to git"
echo "  4. Add to GitHub Secrets for CI use"
echo "═══════════════════════════════════════════════════════════"
