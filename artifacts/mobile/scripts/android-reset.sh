#!/usr/bin/env bash
#
# android-reset.sh — return a known-bad Android workspace to green in one shot.
#
# Sequence (each step short-circuits on failure of the previous):
#   1. doctor --fix         stop Gradle daemon + clear stale .cxx / build /
#                           codegen caches (survives prebuild --clean since
#                           codegen lives in node_modules, not android/)
#   2. gradlew clean        explicit Gradle-level clean of any remaining
#                           build outputs while android/ still exists
#   3. expo prebuild --clean
#                           delete android/ entirely and regenerate it from
#                           the canonical app.json + plugin pipeline
#   4. doctor               final read-only verification of the new state
#
# Safe to run when android/ does not yet exist — step 2 is skipped in that
# case, and step 3 generates the folder fresh.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$MOBILE_DIR"

echo ""
echo "=== Temple TV — Android Reset ==="
echo ""

# Step 1: doctor in fix mode (stops daemon, clears stale caches)
echo "[1/4] Clearing stale build caches..."
bash scripts/doctor.sh --fix

# Step 2: Gradle-level clean (only if android/gradlew exists and is executable)
if [ -x "$MOBILE_DIR/android/gradlew" ]; then
  echo ""
  echo "[2/4] Running gradlew clean..."
  (cd android && ./gradlew clean) || {
    echo "  gradlew clean failed — continuing to prebuild --clean which will replace android/ entirely."
  }
else
  echo ""
  echo "[2/4] Skipped — android/gradlew not present yet (prebuild will create it)."
fi

# Step 3: Fresh native regeneration
echo ""
echo "[3/4] Regenerating native android/ folder via expo prebuild --clean..."
npx expo prebuild --platform android --clean --no-install

# Step 4: Final verification
echo ""
echo "[4/4] Verifying reset state..."
bash scripts/doctor.sh

echo ""
echo "Reset complete — you can now run: pnpm run build:android"
