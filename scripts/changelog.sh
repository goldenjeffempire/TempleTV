#!/usr/bin/env bash
# =============================================================================
# Temple TV — Changelog Generator
# =============================================================================
#
# Generates a CHANGELOG.md entry from git log since the last tag.
# Uses conventional commits format for categorization when possible.
#
# Usage:
#   bash scripts/changelog.sh [version]
#
# If version is omitted, reads from artifacts/mobile/app.json.
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CHANGELOG_FILE="$REPO_ROOT/CHANGELOG.md"

# ── Determine version ─────────────────────────────────────────────────────────
if [ -n "${1:-}" ]; then
  VERSION="$1"
else
  VERSION="$(node -e "
    const fs = require('fs');
    const appJson = JSON.parse(fs.readFileSync('artifacts/mobile/app.json', 'utf8'));
    console.log(appJson.expo.version);
  ")"
fi

DATE="$(date +%Y-%m-%d)"
TAG="v${VERSION}"

echo "Generating CHANGELOG entry for $TAG..."

# ── Find previous tag ─────────────────────────────────────────────────────────
PREV_TAG="$(git describe --tags --abbrev=0 HEAD 2>/dev/null || echo '')"
if [ -n "$PREV_TAG" ]; then
  LOG_RANGE="${PREV_TAG}..HEAD"
  echo "Changes since: $PREV_TAG"
else
  LOG_RANGE="HEAD"
  echo "First release — including all commits"
fi

# ── Categorize commits using conventional commit prefixes ─────────────────────
BREAKING=""
FEATURES=""
FIXES=""
PERF=""
CHORES=""
OTHER=""

while IFS= read -r line; do
  subject="${line#* }"   # strip short SHA prefix
  hash="${line%% *}"

  case "$subject" in
    BREAKING*|"!:"*)
      BREAKING="${BREAKING}\n- ${subject} (${hash})" ;;
    feat*|feature*)
      FEATURES="${FEATURES}\n- ${subject} (${hash})" ;;
    fix*|bug*)
      FIXES="${FIXES}\n- ${subject} (${hash})" ;;
    perf*)
      PERF="${PERF}\n- ${subject} (${hash})" ;;
    chore*|build*|ci*|style*|refactor*)
      CHORES="${CHORES}\n- ${subject} (${hash})" ;;
    *)
      OTHER="${OTHER}\n- ${subject} (${hash})" ;;
  esac
done < <(git log "$LOG_RANGE" --pretty=format:"%h %s" --no-merges 2>/dev/null || echo "")

# ── Build changelog entry ─────────────────────────────────────────────────────
{
  echo "## [$TAG] — $DATE"
  echo ""

  if [ -n "$BREAKING" ]; then
    echo "### ⚠ Breaking Changes"
    echo -e "$BREAKING"
    echo ""
  fi

  if [ -n "$FEATURES" ]; then
    echo "### ✨ Features"
    echo -e "$FEATURES"
    echo ""
  fi

  if [ -n "$FIXES" ]; then
    echo "### 🐛 Bug Fixes"
    echo -e "$FIXES"
    echo ""
  fi

  if [ -n "$PERF" ]; then
    echo "### ⚡ Performance"
    echo -e "$PERF"
    echo ""
  fi

  if [ -n "$OTHER" ]; then
    echo "### 📝 Other Changes"
    echo -e "$OTHER"
    echo ""
  fi

  if [ -n "$CHORES" ]; then
    echo "### 🔧 Internal"
    echo -e "$CHORES"
    echo ""
  fi

  if [ -z "$FEATURES$FIXES$PERF$OTHER$BREAKING" ]; then
    echo "_No significant changes recorded._"
    echo ""
  fi
} > /tmp/changelog_entry.md

# ── Prepend to CHANGELOG.md ───────────────────────────────────────────────────
if [ -f "$CHANGELOG_FILE" ]; then
  # Insert after the title (first line)
  HEADER="$(head -n 3 "$CHANGELOG_FILE")"
  BODY="$(tail -n +4 "$CHANGELOG_FILE")"
  {
    echo "$HEADER"
    echo ""
    cat /tmp/changelog_entry.md
    echo "$BODY"
  } > "${CHANGELOG_FILE}.tmp"
  mv "${CHANGELOG_FILE}.tmp" "$CHANGELOG_FILE"
else
  # Create fresh CHANGELOG.md
  {
    echo "# Temple TV — Changelog"
    echo ""
    echo "All notable changes to the Temple TV platform are documented here."
    echo ""
    cat /tmp/changelog_entry.md
  } > "$CHANGELOG_FILE"
fi

rm -f /tmp/changelog_entry.md

echo "✓ CHANGELOG.md updated with $TAG entry"
cat "$CHANGELOG_FILE" | head -30
