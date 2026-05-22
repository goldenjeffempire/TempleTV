#!/usr/bin/env bash
#
# logcat.sh — stream filtered Android logs for the Temple TV mobile app.
#
# Two modes, picked automatically:
#   1. App is running on the connected device → filter by PID (cleanest:
#      shows only this app's output, including native crashes and JS console
#      logs, with no other-app noise).
#   2. App is not running → filter by tag (ReactNative / ReactNativeJS /
#      AndroidRuntime crashes / System.err) so you can launch the app and
#      see logs the moment it starts.
#
# In both modes the logcat ring buffer is cleared first so you only see
# fresh output. Ctrl-C to stop.

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
  echo ""
  echo "Run 'adb devices' to inspect what adb sees."
  exit 1
fi

PACKAGE="$(node -p "require('./app.json').expo.android.package" 2>/dev/null || true)"
if [ -z "$PACKAGE" ] || [ "$PACKAGE" = "undefined" ]; then
  PACKAGE="com.templetv.app"
fi

# pidof returns empty if app isn't running. Strip CR (adb shell line endings).
PID="$(adb shell pidof -s "$PACKAGE" 2>/dev/null | tr -d '\r' || true)"

adb logcat -c >/dev/null 2>&1 || true

if [ -n "$PID" ]; then
  echo "Streaming logs for $PACKAGE (PID $PID). Ctrl-C to stop."
  echo ""
  exec adb logcat -v color --pid="$PID"
else
  echo "$PACKAGE not running yet — streaming React Native + crash tags."
  echo "Launch the app on your device; logs will appear here. Ctrl-C to stop."
  echo ""
  exec adb logcat -v color \
    "*:S" \
    ReactNative:V \
    ReactNativeJS:V \
    AndroidRuntime:E \
    System.err:W
fi
