#!/usr/bin/env bash
# =============================================================================
# LG webOS Smart TV — Production Build Script
# =============================================================================
# Prerequisites (install once):
#   npm install -g @webosose/ares-cli
#   ares-setup-device   (configure your TV device — see ares-setup-device.json)
#
# Usage:
#   cd artifacts/tv && bash lg/build.sh
#
# Output:
#   artifacts/tv/lg/com.templetv.jctm_1.0.0_all.ipk  (upload to LG Seller Lounge)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TV_ROOT="$(dirname "$SCRIPT_DIR")"
DIST="$TV_ROOT/dist/lg"
APP_ID="com.templetv.jctm"
VERSION="1.0.0"
IPK="$SCRIPT_DIR/${APP_ID}_${VERSION}_all.ipk"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Temple TV — LG webOS Build"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. Vite build for webOS
echo "→ Building web assets..."
cd "$TV_ROOT"
BASE_PATH="/" pnpm vite build --config vite.config.ts --outDir "$DIST"

# 2. Copy webOS manifest and icons
echo "→ Copying webOS appinfo.json..."
cp "$SCRIPT_DIR/appinfo.json" "$DIST/appinfo.json"

for ICON in icon.png icon_large.png splash.png; do
  if [ -f "$SCRIPT_DIR/$ICON" ]; then
    cp "$SCRIPT_DIR/$ICON" "$DIST/$ICON"
  elif [ -f "$TV_ROOT/public/temple-tv-logo.png" ]; then
    cp "$TV_ROOT/public/temple-tv-logo.png" "$DIST/$ICON"
  fi
done

# 3. Package as .ipk using ares-cli
echo "→ Packaging .ipk..."
if command -v ares-package &>/dev/null; then
  ares-package "$DIST" -o "$SCRIPT_DIR"
  echo "✅ Package ready: $IPK"
else
  echo "⚠️  ares-cli not found. Install with: npm install -g @webosose/ares-cli"
  echo "   Built web assets are at: $DIST"
  echo "   Run: ares-package $DIST -o $SCRIPT_DIR"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Next steps:"
echo "  1. Install on test TV:   ares-install -d tv-dev $IPK"
echo "  2. Launch app:           ares-launch -d tv-dev $APP_ID"
echo "  3. Submit to store:      https://seller.lgappstv.com"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
