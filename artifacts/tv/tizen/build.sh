#!/usr/bin/env bash
# =============================================================================
# Samsung Tizen Smart TV — Production Build Script
# =============================================================================
# Prerequisites (install once):
#   - Tizen Studio CLI:   https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html
#   - Samsung TV CLI:     tizen-studio/tools/ide/bin/tizen
#   - Author certificate: tizen certificate -a TempleTv -p <password> -c KR -ct ...
#
# Usage:
#   cd artifacts/tv && bash tizen/build.sh
#
# Output:
#   artifacts/tv/tizen/TempleTv.wgt  (upload this to Samsung Seller Office)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TV_ROOT="$(dirname "$SCRIPT_DIR")"
DIST="$TV_ROOT/dist/tizen"
OUT="$SCRIPT_DIR/TempleTv.wgt"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Temple TV — Samsung Tizen Build"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. Vite build for Tizen (no base path — Tizen loads from local FS)
echo "→ Building web assets..."
cd "$TV_ROOT"
BASE_PATH="/" pnpm vite build --config vite.config.ts --outDir "$DIST"

# 2. Copy Tizen manifest and assets into dist
echo "→ Copying Tizen config..."
cp "$SCRIPT_DIR/config.xml" "$DIST/config.xml"

# Copy icons — use public icons as fallback if tizen-specific ones don't exist
for ICON in icon.png icon_focus.png logo.png; do
  if [ -f "$SCRIPT_DIR/$ICON" ]; then
    cp "$SCRIPT_DIR/$ICON" "$DIST/$ICON"
  elif [ -f "$TV_ROOT/public/temple-tv-logo.png" ]; then
    cp "$TV_ROOT/public/temple-tv-logo.png" "$DIST/$ICON"
  fi
done

# 3. Package as .wgt using Tizen CLI
echo "→ Packaging .wgt..."
if command -v tizen &>/dev/null; then
  tizen package -t wgt -s TempleTvCert -- "$DIST"
  # Move output to script dir
  WGT_FILE=$(find "$DIST" -name "*.wgt" | head -1)
  if [ -n "$WGT_FILE" ]; then
    mv "$WGT_FILE" "$OUT"
    echo "✅ Package ready: $OUT"
  fi
else
  echo "⚠️  Tizen CLI not found. Install Tizen Studio and add it to PATH."
  echo "   Built web assets are at: $DIST"
  echo "   Manually open Tizen Studio → Project → Import → Web App → point to $DIST"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Next steps:"
echo "  1. Install on test TV:   tizen install -n TempleTv.wgt -t <device_id>"
echo "  2. Upload to Seller:     https://seller.samsungapps.com"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
