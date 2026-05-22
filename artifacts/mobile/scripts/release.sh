#!/usr/bin/env bash
#
# release.sh — cut a production release of the Temple TV mobile app via EAS.
#
# Pipeline:
#   1. Refuse to run if the working tree has uncommitted changes.
#   2. Read current expo.version from app.json, bump the patch component.
#      NOTE: versionCode (Android) is NOT bumped here — eas.json sets
#      autoIncrement: true so EAS Build increments it automatically on
#      every production build, sourcing the authoritative sequence from
#      the Play Store rather than a local counter.
#   3. Mirror the new semver into package.json so both files agree.
#   4. Commit "Release vX.Y.Z" and create an annotated tag.
#   5. Append a stub entry to RELEASES.md.
#   6. Run `eas build --platform android --profile production`.
#      EAS builds on a remote worker, uploads the signed .aab to its
#      artifact store, and prints a download URL. The build is NOT
#      submitted automatically here — see manual follow-ups below.
#   7. Optionally run `eas submit` if --submit flag is passed.
#
# Usage:
#   ./scripts/release.sh              # build only
#   ./scripts/release.sh --submit     # build + submit to Play Store internal track
#
# Prerequisites:
#   - EAS CLI installed: npm install -g eas-cli
#   - Authenticated: eas login
#   - google-service-account.json present in artifacts/mobile/ (for --submit)
#   - app.json extra.eas.projectId set to your real EAS project UUID

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$MOBILE_DIR/../.." && pwd)"
cd "$MOBILE_DIR"

# ── Parse flags ──────────────────────────────────────────────────────────────
SUBMIT=false
for arg in "$@"; do
  case "$arg" in
    --submit) SUBMIT=true ;;
    *)
      echo "ERROR: unknown argument '$arg'"
      echo "Usage: $0 [--submit]"
      exit 1
      ;;
  esac
done

# ── Lockfile invariant checks (runs before any irreversible action) ───────────
#
# Verifies that the pnpm lockfile's resolved dependency tree matches the
# scoped overrides that protect the EAS Android build from cross-major API
# breakage (e.g. brace-expansion v1→v2 breaking minimatch@3's `expand` call
# in the Gradle generateCodegenSchemaFromJavaScript task).
#
# Runs here — after flag parsing, before the version bump / git commit / tag —
# so a bad lockfile is surfaced in ~2 seconds locally rather than 10-20 minutes
# into a remote EAS worker.  See scripts/src/verify-mobile-lockfile.ts for the
# full check table and remediation guidance.
echo ""
echo "=== Lockfile pre-flight (verify:mobile-lockfile) ==="
echo ""

if ! (cd "$REPO_ROOT" && pnpm run verify:mobile-lockfile); then
  echo ""
  echo "ERROR: lockfile invariant check failed — release aborted before any"
  echo "version bump, commit, or EAS submission."
  echo ""
  echo "The check above describes the problem and how to fix it."
  echo "After fixing, re-run: pnpm run release:patch [--submit]"
  exit 1
fi

echo ""

# ── 1. Clean working tree check ──────────────────────────────────────────────
DIRTY="$(cd "$REPO_ROOT" && git status --porcelain)"
if [ -n "$DIRTY" ]; then
  echo "ERROR: working tree is not clean. Commit or stash your changes first."
  echo ""
  echo "Uncommitted files:"
  echo "$DIRTY" | sed 's/^/  /'
  exit 1
fi

BRANCH="$(cd "$REPO_ROOT" && git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  echo "WARNING: you are on branch '$BRANCH', not 'main'. Continuing anyway."
  echo ""
fi

# ── 2-3. Compute and apply semver bump (versionCode handled by EAS) ──────────
read -r OLD_VERSION NEW_VERSION < <(node -e '
  const fs = require("fs");
  const appJson = JSON.parse(fs.readFileSync("app.json", "utf8"));
  const oldVersion = appJson.expo.version;
  const parts = oldVersion.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    console.error("ERROR: app.json expo.version is not semver: " + oldVersion);
    process.exit(1);
  }
  parts[2] += 1;
  const newVersion = parts.join(".");
  console.log(`${oldVersion} ${newVersion}`);
')

if [ -z "${NEW_VERSION:-}" ]; then
  echo "ERROR: failed to compute new version from app.json."
  exit 1
fi

echo "Bumping version: $OLD_VERSION → $NEW_VERSION"
echo "(versionCode is managed automatically by EAS Build autoIncrement)"
echo ""

node -e '
  const fs = require("fs");
  const newVersion = "'"$NEW_VERSION"'";

  const appJson = JSON.parse(fs.readFileSync("app.json", "utf8"));
  appJson.expo.version = newVersion;
  fs.writeFileSync("app.json", JSON.stringify(appJson, null, 2) + "\n");

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  pkg.version = newVersion;
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
'

# ── 4. Commit and tag ─────────────────────────────────────────────────────────
TAG="v$NEW_VERSION"
RELEASE_DATE="$(date +%Y-%m-%d)"
RELEASES_FILE="$MOBILE_DIR/RELEASES.md"

if [ ! -f "$RELEASES_FILE" ]; then
  cat > "$RELEASES_FILE" <<EOF
# Temple TV Mobile — Release History

Newest releases first. Edit each entry's bullet list to describe what shipped.

EOF
fi

TMP="$(mktemp)"
{
  head -n 4 "$RELEASES_FILE"
  cat <<EOF
## $TAG — $RELEASE_DATE

- _Add release notes here._

EOF
  tail -n +5 "$RELEASES_FILE"
} > "$TMP"
mv "$TMP" "$RELEASES_FILE"

(
  cd "$REPO_ROOT"
  git add artifacts/mobile/app.json artifacts/mobile/package.json artifacts/mobile/RELEASES.md
  git commit -m "Release $TAG"
  git tag -a "$TAG" -m "Release $TAG"
)

echo "Release commit and tag created: $TAG"
echo ""

# ── 5. EAS Build ─────────────────────────────────────────────────────────────
echo "Starting EAS Build (production / Android app-bundle)..."
echo "This runs on EAS remote workers — typically 10-20 minutes."
echo ""

if ! eas build \
  --platform android \
  --profile production \
  --non-interactive \
  --message "Release $TAG"; then
  echo ""
  echo "ERROR: EAS Build failed."
  echo "The release commit and tag have already been created locally."
  echo "Fix the build error, then re-run without bumping version again,"
  echo "or revert the commit and tag and re-run this script."
  exit 1
fi

# ── 6. Optional EAS Submit ────────────────────────────────────────────────────
if [ "$SUBMIT" = true ]; then
  echo ""
  echo "Submitting to Google Play (internal track)..."
  if ! eas submit \
    --platform android \
    --profile production \
    --latest \
    --non-interactive; then
    echo ""
    echo "WARNING: EAS Submit failed. The build artifact is still available"
    echo "in the EAS dashboard — submit manually via Play Console or re-run:"
    echo "  eas submit --platform android --profile production --latest"
    exit 1
  fi
  echo "Submitted to Google Play internal testing track."
fi

# ── 7. Final summary ──────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  Release $TAG cut successfully."
echo "═══════════════════════════════════════════════════════════════════════"
echo ""
echo "  Tag:   $TAG (local only — not pushed)"
echo "  Notes: $RELEASES_FILE (stub added — edit before pushing)"
echo ""
echo "  EAS Build artifact: download from https://expo.dev/accounts/temple_tv/projects/mobile/builds"
echo ""
echo "  Manual follow-ups:"
echo "    1. Edit RELEASES.md to describe what's in this release."
echo "    2. git push --follow-tags origin $BRANCH"
if [ "$SUBMIT" = false ]; then
  echo "    3. Submit to Play Store:"
  echo "       ./scripts/release.sh --submit   (uses the latest EAS build)"
  echo "       OR manually upload the .aab from the EAS dashboard to Play Console."
fi
echo ""
