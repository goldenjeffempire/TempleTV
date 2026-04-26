#!/usr/bin/env bash
# Temple TV JCTM — Mobile environment doctor
#
# Quick health check for the local toolchain that the Android build depends on.
# Run from artifacts/mobile/ via:  pnpm run mobile:doctor
#
# Exits 0 on success, 1 if any "FAIL" check fires (missing required tooling).
# Warnings ("WARN") never fail the run — they flag drift, not breakage.

set -u

PASS="\033[32m PASS \033[0m"
WARN="\033[33m WARN \033[0m"
FAIL="\033[31m FAIL \033[0m"
INFO="\033[36m INFO \033[0m"

EXIT_CODE=0
WARN_COUNT=0

mark_fail() { EXIT_CODE=1; }
mark_warn() { WARN_COUNT=$((WARN_COUNT + 1)); }

echo ""
echo "=== Temple TV — Mobile Environment Doctor ==="
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── 1. Node.js version ────────────────────────────────────────────────────────
if command -v node >/dev/null 2>&1; then
  NODE_PATH="$(command -v node)"
  NODE_VERSION="$(node --version | sed 's/^v//')"
  NODE_MAJOR="${NODE_VERSION%%.*}"
  echo -e "$INFO node            $NODE_PATH"
  echo -e "$INFO node version    v$NODE_VERSION"
  if [ "$NODE_MAJOR" -ge 24 ]; then
    echo -e "$PASS node major is >= 24 (project target)"
  else
    echo -e "$WARN node major is $NODE_MAJOR — project targets >= 24. Run: nvm use 24"
    mark_warn
  fi
else
  echo -e "$FAIL node not found on PATH"
  mark_fail
fi

# ── 2. /usr/local/bin/node symlink (the Android Studio fix) ───────────────────
if [ -e "/usr/local/bin/node" ]; then
  TARGET="$(readlink -f /usr/local/bin/node 2>/dev/null || echo /usr/local/bin/node)"
  echo -e "$PASS /usr/local/bin/node -> $TARGET"
else
  echo -e "$WARN /usr/local/bin/node missing — Android Studio launched from a desktop icon"
  echo "       may fail with \"command 'node' error=2\". Fix:"
  echo "       sudo ln -s \"\$(which node)\" /usr/local/bin/node"
  mark_warn
fi

# ── 3. pnpm available ─────────────────────────────────────────────────────────
if command -v pnpm >/dev/null 2>&1; then
  echo -e "$PASS pnpm           $(pnpm -v)"
else
  echo -e "$FAIL pnpm not found on PATH (npm install -g pnpm)"
  mark_fail
fi

# ── 4. babel.config.js matches repo expectations ──────────────────────────────
BABEL="$MOBILE_DIR/babel.config.js"
if [ ! -f "$BABEL" ]; then
  echo -e "$FAIL babel.config.js missing at $BABEL"
  mark_fail
elif grep -q "babel-preset-expo" "$BABEL" && grep -q "unstable_transformImportMeta" "$BABEL"; then
  echo -e "$PASS babel.config.js has babel-preset-expo + unstable_transformImportMeta"
else
  echo -e "$FAIL babel.config.js is missing the expected preset / transformImportMeta flag."
  echo "       Restore it from git:  git checkout artifacts/mobile/babel.config.js"
  mark_fail
fi

# ── 5. Android SDK location ───────────────────────────────────────────────────
SDK=""
if [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME" ]; then
  SDK="$ANDROID_HOME"
elif [ -n "${ANDROID_SDK_ROOT:-}" ] && [ -d "$ANDROID_SDK_ROOT" ]; then
  SDK="$ANDROID_SDK_ROOT"
elif [ -d "$HOME/Android/Sdk" ]; then
  SDK="$HOME/Android/Sdk"
elif [ -d "$HOME/Library/Android/sdk" ]; then
  SDK="$HOME/Library/Android/sdk"
fi

if [ -z "$SDK" ]; then
  echo -e "$WARN Android SDK not found — Android build will fail."
  echo "       Install Android Studio, then run: bash scripts/setup-local-properties.sh"
  mark_warn
else
  echo -e "$PASS Android SDK     $SDK"

  # Ownership check — root-owned SDK is a common cause of "corrupted" Build Tools
  SDK_OWNER="$(stat -c '%U' "$SDK" 2>/dev/null || stat -f '%Su' "$SDK" 2>/dev/null || echo unknown)"
  if [ "$SDK_OWNER" = "root" ]; then
    echo -e "$WARN $SDK is owned by root — installs from your user will fail to extract."
    echo "       Fix once: sudo chown -R \"\$USER:\$USER\" \"$SDK\""
    mark_warn
  fi

  # ── 6. Half-extracted Build Tools folders ──────────────────────────────────
  BT_DIR="$SDK/build-tools"
  if [ -d "$BT_DIR" ]; then
    SHOPT_RESET=""
    if shopt -q nullglob 2>/dev/null; then SHOPT_RESET="shopt -u nullglob"; fi
    shopt -s nullglob 2>/dev/null || true

    for v in "$BT_DIR"/*/; do
      [ -d "$v" ] || continue
      version="$(basename "$v")"
      file_count="$(find "$v" -maxdepth 1 -mindepth 1 | wc -l | tr -d ' ')"
      if [ ! -f "$v/source.properties" ] || [ "$file_count" -lt 10 ]; then
        echo -e "$FAIL build-tools/$version is incomplete (only $file_count entries, source.properties missing)."
        echo "       Hard-clean and reinstall:"
        echo "       rm -rf \"$v\""
        echo "       \"$SDK/cmdline-tools/latest/bin/sdkmanager\" \"build-tools;$version\""
        mark_fail
      else
        echo -e "$PASS build-tools/$version intact ($file_count entries)"
      fi
    done

    [ -n "$SHOPT_RESET" ] && eval "$SHOPT_RESET"
  else
    echo -e "$WARN $BT_DIR does not exist — install Build Tools via Android Studio's SDK Manager."
    mark_warn
  fi

  # ── 7. cmdline-tools (so future SDK ops can use the CLI) ───────────────────
  if [ -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
    echo -e "$PASS sdkmanager     $SDK/cmdline-tools/latest/bin/sdkmanager"
  else
    echo -e "$WARN sdkmanager CLI not installed. In Android Studio: SDK Manager →"
    echo "       SDK Tools → tick \"Android SDK Command-line Tools (latest)\" → Apply"
    mark_warn
  fi
fi

# ── 8. Free disk space in \$HOME ──────────────────────────────────────────────
FREE_KB="$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')"
if [ -n "$FREE_KB" ]; then
  FREE_GB=$((FREE_KB / 1024 / 1024))
  if [ "$FREE_GB" -lt 2 ]; then
    echo -e "$FAIL Only ${FREE_GB} GB free in \$HOME — SDK installs will silently truncate."
    mark_fail
  elif [ "$FREE_GB" -lt 5 ]; then
    echo -e "$WARN Only ${FREE_GB} GB free in \$HOME — recommend >5 GB for safe SDK installs."
    mark_warn
  else
    echo -e "$PASS \$HOME has ${FREE_GB} GB free"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
if [ "$EXIT_CODE" -eq 0 ] && [ "$WARN_COUNT" -eq 0 ]; then
  echo "All checks passed — you're ready to run: pnpm run build:android"
elif [ "$EXIT_CODE" -eq 0 ]; then
  echo "$WARN_COUNT warning(s) — non-blocking, but worth addressing."
else
  echo "One or more FAIL checks fired — fix them before running pnpm run build:android."
fi
echo ""

exit "$EXIT_CODE"
