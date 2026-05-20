#!/usr/bin/env bash
# Temple TV JCTM — Android Studio launcher (Linux)
#
# Starts Android Studio with the user's full shell PATH preloaded, so React
# Native / Expo Gradle builds can always find `node`. Avoids the classic
# "command 'node' error=2 No such file or directory" failure that hits Linux
# users who launch Android Studio from a desktop / GNOME / KDE icon (those
# launchers don't source ~/.bashrc, ~/.zshrc, or nvm/asdf/fnm init scripts).
#
# Usage (from anywhere):
#   bash artifacts/mobile/scripts/launch-android-studio.sh

set -e

echo ""
echo "=== Temple TV — Android Studio Launcher (Linux) ==="
echo ""

# ── 1. Load the user's shell environment ──────────────────────────────────────
# Source common shell rc files so PATH, nvm, asdf, fnm, etc. are available.
# We tolerate failures from any individual file (set +e around each source).
load_rc() {
  local rc="$1"
  if [ -f "$rc" ]; then
    # shellcheck disable=SC1090
    set +e
    . "$rc" >/dev/null 2>&1 || true
    set -e
  fi
}

load_rc "$HOME/.profile"
load_rc "$HOME/.bash_profile"
load_rc "$HOME/.bashrc"
load_rc "$HOME/.zshrc"

# Explicitly load nvm if present (most common reason node isn't on PATH)
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  set +e
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  set -e
fi

# Explicitly load asdf if present
if [ -s "$HOME/.asdf/asdf.sh" ]; then
  set +e
  # shellcheck disable=SC1091
  . "$HOME/.asdf/asdf.sh" >/dev/null 2>&1 || true
  set -e
fi

# Explicitly load fnm if present
if command -v fnm >/dev/null 2>&1; then
  set +e
  eval "$(fnm env --use-on-cd 2>/dev/null)" || true
  set -e
fi

# ── 2. Verify node is now on PATH ─────────────────────────────────────────────
if command -v node >/dev/null 2>&1; then
  echo "node found: $(command -v node) ($(node --version))"
else
  echo "WARNING: 'node' is still not on PATH after loading shell rc files."
  echo "         The build will likely fail again with the 'command \"node\"' error."
  echo "         Fix: install node via nvm/asdf/fnm/brew, or symlink it:"
  echo "           sudo ln -s \"\$(which node)\" /usr/local/bin/node"
  echo ""
fi

# ── 3. Locate the Android Studio binary ───────────────────────────────────────
STUDIO_BIN=""
CANDIDATES=(
  "$HOME/android-studio/bin/studio.sh"
  "/opt/android-studio/bin/studio.sh"
  "/usr/local/android-studio/bin/studio.sh"
  "$HOME/.local/share/JetBrains/Toolbox/apps/android-studio/bin/studio.sh"
  "/snap/bin/android-studio"
)

# Also check anything on PATH (covers Toolbox shims, Flatpak wrappers, etc.)
for cmd in studio.sh android-studio; do
  if command -v "$cmd" >/dev/null 2>&1; then
    CANDIDATES+=("$(command -v "$cmd")")
  fi
done

for candidate in "${CANDIDATES[@]}"; do
  if [ -x "$candidate" ]; then
    STUDIO_BIN="$candidate"
    break
  fi
done

if [ -z "$STUDIO_BIN" ]; then
  echo "ERROR: Could not find Android Studio. Looked in:"
  for c in "${CANDIDATES[@]}"; do echo "  - $c"; done
  echo ""
  echo "Fix: set the path manually and re-run, e.g."
  echo "  STUDIO_BIN=/path/to/studio.sh bash $0"
  echo ""
  echo "Or install Android Studio: https://developer.android.com/studio"
  exit 1
fi

# Allow override via env var
STUDIO_BIN="${STUDIO_BIN_OVERRIDE:-$STUDIO_BIN}"
echo "Launching: $STUDIO_BIN"
echo ""

# ── 4. Determine project path to open (this script's grandparent dir) ─────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ANDROID_DIR="$MOBILE_DIR/android"

if [ -d "$ANDROID_DIR" ]; then
  echo "Opening project: $ANDROID_DIR"
  echo ""
  # Detach so the terminal returns; nohup so it survives shell exit.
  nohup "$STUDIO_BIN" "$ANDROID_DIR" >/dev/null 2>&1 &
else
  echo "Note: $ANDROID_DIR not found — launching Android Studio without a project."
  echo "      Run 'bash scripts/setup-local-properties.sh' from $MOBILE_DIR first to generate it."
  echo ""
  nohup "$STUDIO_BIN" >/dev/null 2>&1 &
fi

disown 2>/dev/null || true

echo "Android Studio is starting in the background (PID $!)."
echo "PATH passed to it includes: $(command -v node 2>/dev/null || echo '<no node found>')"
echo ""
echo "If Gradle sync still fails with 'command \"node\" error=2', stop the daemon"
echo "and try again:"
echo "  cd $ANDROID_DIR && ./gradlew --stop"
echo ""
