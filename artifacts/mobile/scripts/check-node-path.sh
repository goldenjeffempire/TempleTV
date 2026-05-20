#!/usr/bin/env bash
# Temple TV JCTM — Node.js Path Helper for Android Studio
#
# Run this from the artifacts/mobile directory if your Android Studio build
# fails with: "Cause: error=2, No such file or directory" / "command 'node'".
#
# It prints your node binary's absolute path in a copy-paste-ready format
# for android/gradle.properties, and offers to append it for you.

set -e

echo ""
echo "=== Temple TV — Node.js Path Helper ==="
echo ""

# ── 1. Locate node ────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: 'node' is not on your PATH in this shell."
  echo ""
  echo "Install Node.js 20+ first:"
  echo "  - macOS:  brew install node    (or use nvm: https://github.com/nvm-sh/nvm)"
  echo "  - Linux:  use nvm/asdf/fnm, or your distro's package manager"
  echo ""
  exit 1
fi

NODE_PATH="$(command -v node)"
NODE_VERSION="$(node --version)"

echo "Found node: $NODE_PATH"
echo "Version:    $NODE_VERSION"
echo ""

# ── 2. Print copy-paste-ready gradle.properties line ──────────────────────────
echo "Add this line to artifacts/mobile/android/gradle.properties:"
echo ""
echo "  nodeExecutableAndArgs=$NODE_PATH"
echo ""

# ── 3. Offer to append automatically ──────────────────────────────────────────
GRADLE_PROPS="android/gradle.properties"

if [ ! -f "$GRADLE_PROPS" ]; then
  echo "Note: $GRADLE_PROPS not found."
  echo "      Run 'pnpm expo prebuild --platform android --no-install' first to generate it."
  echo ""
  exit 0
fi

if grep -q "^nodeExecutableAndArgs=" "$GRADLE_PROPS"; then
  CURRENT="$(grep "^nodeExecutableAndArgs=" "$GRADLE_PROPS" | head -1)"
  echo "$GRADLE_PROPS already contains:"
  echo "  $CURRENT"
  echo ""
  read -rp "Replace it with the path above? [y/N]: " REPLY
  if [[ "$REPLY" =~ ^[Yy]$ ]]; then
    # Portable in-place edit (works on both GNU sed and BSD/macOS sed)
    TMP_FILE="$(mktemp)"
    grep -v "^nodeExecutableAndArgs=" "$GRADLE_PROPS" > "$TMP_FILE"
    echo "nodeExecutableAndArgs=$NODE_PATH" >> "$TMP_FILE"
    mv "$TMP_FILE" "$GRADLE_PROPS"
    echo "Updated $GRADLE_PROPS."
  else
    echo "No changes made."
  fi
else
  read -rp "Append it to $GRADLE_PROPS now? [y/N]: " REPLY
  if [[ "$REPLY" =~ ^[Yy]$ ]]; then
    {
      echo ""
      echo "# Temple TV — explicit node path so Android Studio (launched from desktop"
      echo "# icon) can find node when bundling React Native JS during the build."
      echo "nodeExecutableAndArgs=$NODE_PATH"
    } >> "$GRADLE_PROPS"
    echo "Appended to $GRADLE_PROPS."
  else
    echo "No changes made — copy the line above into $GRADLE_PROPS yourself."
  fi
fi

echo ""
echo "Next: in Android Studio, do File → Invalidate Caches → Invalidate and Restart,"
echo "      then rebuild your .aab."
echo ""
