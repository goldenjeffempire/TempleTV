#!/usr/bin/env bash
#
# record.sh — capture an MP4 screen recording of the connected Android device.
#
# Usage:
#   bash scripts/record.sh           # 30 seconds (default)
#   bash scripts/record.sh 60        # 60 seconds (max 180, Android limit)
#
# Recording happens on-device, then the file is pulled to the host and the
# on-device copy is deleted. Ctrl-C during recording is handled gracefully:
# the running screenrecord process is killed cleanly, and whatever was
# captured up to that point is still pulled.
#
# Output: artifacts/mobile/screenshots/recording-YYYY-MM-DD_HH-MM-SS.mp4

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$MOBILE_DIR"

DURATION="${1:-30}"
if ! [[ "$DURATION" =~ ^[0-9]+$ ]] || [ "$DURATION" -lt 1 ] || [ "$DURATION" -gt 180 ]; then
  echo "ERROR: duration must be an integer between 1 and 180 seconds (got '$DURATION')."
  echo "Android's screenrecord caps single recordings at 180s."
  exit 1
fi

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

OUT_DIR="$MOBILE_DIR/screenshots"
mkdir -p "$OUT_DIR"

TS="$(date +%Y-%m-%d_%H-%M-%S)"
DEVICE_PATH="/sdcard/templetv-record-$TS.mp4"
HOST_PATH="$OUT_DIR/recording-$TS.mp4"

cleanup() {
  # Kill any lingering screenrecord process on the device so the file is
  # finalized and flushed before we try to pull it.
  adb shell 'pkill -SIGINT screenrecord 2>/dev/null; true' >/dev/null 2>&1 || true
  sleep 1
}
trap cleanup INT TERM

echo "Recording for ${DURATION}s. Reproduce the bug now. Ctrl-C to stop early."
echo ""

adb shell screenrecord --time-limit "$DURATION" "$DEVICE_PATH" || true

# Give the encoder a moment to finalize the MP4 container.
sleep 1

if ! adb shell "[ -f $DEVICE_PATH ]" 2>/dev/null; then
  echo ""
  echo "ERROR: no recording file produced on device."
  echo "Common cause: screen-recording permission denied, or screenrecord not"
  echo "supported (some emulators / very old devices)."
  exit 1
fi

adb pull "$DEVICE_PATH" "$HOST_PATH" >/dev/null 2>&1
adb shell rm "$DEVICE_PATH" >/dev/null 2>&1 || true

if [ ! -s "$HOST_PATH" ]; then
  echo ""
  echo "ERROR: pulled file is empty — capture failed."
  rm -f "$HOST_PATH"
  exit 1
fi

SIZE_KB="$(($(wc -c < "$HOST_PATH") / 1024))"
echo ""
echo "Saved: $HOST_PATH (${SIZE_KB} KB)"
