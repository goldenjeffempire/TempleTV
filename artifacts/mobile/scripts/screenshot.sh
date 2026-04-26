#!/usr/bin/env bash
#
# screenshot.sh — capture the connected Android device's screen as a PNG.
#
# Uses `adb exec-out screencap -p` (not `adb shell`) because exec-out streams
# the binary PNG payload verbatim. `adb shell` mangles output by translating
# CRLF, which corrupts the PNG bytes on Linux/macOS hosts.
#
# Output: artifacts/mobile/screenshots/screenshot-YYYY-MM-DD_HH-MM-SS.png
#         (path printed on success so it's easy to drop into bug reports)

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$MOBILE_DIR"

if ! command -v adb >/dev/null 2>&1; then
  echo "ERROR: adb not on PATH."
  echo "Install Android platform-tools or add \$ANDROID_HOME/platform-tools to PATH."
  exit 1
fi

DEVICES="$(adb devices | awk 'NR>1 && $2=="device" {print $1}')"
if [ -z "$DEVICES" ]; then
  echo "ERROR: no Android device or emulator connected."
  echo "Plug in a device with USB debugging enabled, or start an emulator, then retry."
  exit 1
fi

DEVICE_COUNT="$(echo "$DEVICES" | wc -l | tr -d ' ')"
if [ "$DEVICE_COUNT" -gt 1 ]; then
  echo "WARNING: $DEVICE_COUNT devices connected — adb will pick the first one."
  echo "If that's wrong, set ANDROID_SERIAL=<serial> first. Available:"
  echo "$DEVICES" | sed 's/^/  /'
  echo ""
fi

OUT_DIR="$MOBILE_DIR/screenshots"
mkdir -p "$OUT_DIR"

TS="$(date +%Y-%m-%d_%H-%M-%S)"
OUT_FILE="$OUT_DIR/screenshot-$TS.png"

adb exec-out screencap -p > "$OUT_FILE"

# Sanity-check the output: a valid PNG starts with the 8-byte magic header.
# If it doesn't, the capture failed (locked screen, permission denied, etc).
MAGIC="$(head -c 8 "$OUT_FILE" | od -An -tx1 | tr -d ' \n')"
if [ "$MAGIC" != "89504e470d0a1a0a" ]; then
  echo "ERROR: capture failed — output is not a valid PNG."
  echo "Common causes: device locked, screen-recording permission denied, or"
  echo "USB-debugging authorization not granted. Unlock the device and retry."
  rm -f "$OUT_FILE"
  exit 1
fi

SIZE_KB="$(($(wc -c < "$OUT_FILE") / 1024))"
echo "Saved: $OUT_FILE (${SIZE_KB} KB)"
