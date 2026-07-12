#!/usr/bin/env bash
#
# eas-build.sh — lockfile-verified wrapper around `eas build`.
#
# Run this instead of `eas build` directly for any EAS build profile (preview,
# development, production ad-hoc). It runs the monorepo lockfile invariant
# checks first so the class of EAS failure described below is caught locally
# in ~2 seconds rather than 10-20 minutes into a remote Gradle build.
#
# ── Background ─────────────────────────────────────────────────────────────
#
# pnpm global overrides can silently force a dep across a major-version
# boundary, breaking packages that were written against the old API.  The
# canonical incident (2026-05-03): brace-expansion >=2.0.3 forced minimatch@3
# onto v2, whose `expand` export was removed, causing EAS Android builds to
# fail with "TypeError: expand is not a function" deep inside the Gradle
# :react-native-*:generateCodegenSchemaFromJavaScript task.
#
# verify:mobile-lockfile guards against this class of regression for all
# known sensitive dependency pairs.  See scripts/src/verify-mobile-lockfile.ts
# for the full check table and remediation guidance.
#
# ── Usage ──────────────────────────────────────────────────────────────────
#
#   # From the mobile workspace:
#   pnpm run eas:build -- --platform android --profile preview
#   pnpm run eas:build -- --platform all    --profile production --non-interactive
#
#   # From the monorepo root:
#   pnpm run mobile:eas:build -- --platform android --profile preview
#
#   # Or run the script directly (all args forwarded to `eas build`):
#   bash artifacts/mobile/scripts/eas-build.sh --platform android --profile preview
#
# ── Prerequisites ──────────────────────────────────────────────────────────
#
#   - EAS CLI installed: npm install -g eas-cli
#   - Authenticated: eas login
#   - app.json extra.eas.projectId set to your EAS project UUID

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$MOBILE_DIR/../.." && pwd)"
cd "$MOBILE_DIR"

# ── 1. Lockfile invariant checks ─────────────────────────────────────────────
echo ""
echo "=== Lockfile pre-flight (verify:mobile-lockfile) ==="
echo ""

if ! (cd "$REPO_ROOT" && pnpm run verify:mobile-lockfile); then
  echo ""
  echo "ERROR: lockfile invariant check failed — EAS build aborted."
  echo ""
  echo "The check above describes the problem and how to fix it."
  echo "After fixing, re-run this script to verify before submitting to EAS."
  exit 1
fi

echo ""

# ── 2. Replit sandbox workarounds ────────────────────────────────────────────
#
# Workaround A — git index lock:
# EAS CLI needs to write to the git index while archiving project files for
# upload. The Replit sandbox blocks writes to .git/index.lock (the default
# path), causing the upload step to fail with a "could not lock index" error.
# Redirecting GIT_INDEX_FILE to /tmp lets git use a writable path.
cp "$REPO_ROOT/.git/index" /tmp/eas-build-index 2>/dev/null || true
export GIT_INDEX_FILE=/tmp/eas-build-index

# Workaround B — dotslash rmdir restriction:
# EAS CLI 14.x bundles a dotslash binary that extracts into a temp dir and
# then tries to rmdir it. Replit's sandbox blocks that rmdir with EACCES.
# We inject a Node.js preload shim that silences EACCES on dotslash/shallow-
# clone paths so EAS can proceed normally.
SHIM_PATH="$SCRIPT_DIR/eas-rmdir-shim.cjs"
export NODE_OPTIONS="${NODE_OPTIONS:-} --require $SHIM_PATH"

# ── 3. eas build (all arguments forwarded) ───────────────────────────────────
echo "=== Starting EAS build ==="
echo ""

# pnpm forwards args with a leading '--' separator; strip it so eas-cli doesn't
# receive 'eas build -- --platform ...' which it rejects as unexpected arguments.
if [[ "${1:-}" == "--" ]]; then
  shift
fi

exec eas build "$@"
