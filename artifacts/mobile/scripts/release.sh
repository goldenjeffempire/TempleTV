#!/usr/bin/env bash
#
# release.sh — automate a patch release of the Temple TV mobile app.
#
# Pipeline:
#   1. Refuse to run if the working tree has uncommitted changes (so the
#      release commit can never accidentally include unrelated edits).
#   2. Read current expo.version from app.json, bump the patch component.
#   3. Bump expo.android.versionCode by +1 (Play Store requires this).
#   4. Mirror the new version into package.json so both files agree.
#   5. Run the full build pipeline (which includes the doctor gate). If
#      the build fails, revert all version edits and exit non-zero — the
#      working tree returns to exactly its pre-release state.
#   6. On build success: commit "Release vX.Y.Z", create annotated tag
#      vX.Y.Z, append a stub entry to RELEASES.md.
#   7. Print exactly which manual follow-ups remain (push the tag, upload
#      the .aab to Play Console). Pushing is intentionally NOT automated
#      because the tag should be reviewed first.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$MOBILE_DIR/../.." && pwd)"
cd "$MOBILE_DIR"

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

# ── 2-4. Compute and apply version bumps ─────────────────────────────────────
read -r OLD_VERSION NEW_VERSION OLD_CODE NEW_CODE < <(node -e '
  const fs = require("fs");
  const appJson = JSON.parse(fs.readFileSync("app.json", "utf8"));
  const oldVersion = appJson.expo.version;
  const oldCode = appJson.expo.android.versionCode;
  const parts = oldVersion.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    console.error("ERROR: app.json expo.version is not semver: " + oldVersion);
    process.exit(1);
  }
  parts[2] += 1;
  const newVersion = parts.join(".");
  const newCode = oldCode + 1;
  console.log(`${oldVersion} ${newVersion} ${oldCode} ${newCode}`);
')

if [ -z "${NEW_VERSION:-}" ]; then
  echo "ERROR: failed to compute new version from app.json."
  exit 1
fi

echo "Bumping version: $OLD_VERSION → $NEW_VERSION (versionCode $OLD_CODE → $NEW_CODE)"
echo ""

node -e '
  const fs = require("fs");
  const newVersion = "'"$NEW_VERSION"'";
  const newCode = '"$NEW_CODE"';

  const appJson = JSON.parse(fs.readFileSync("app.json", "utf8"));
  appJson.expo.version = newVersion;
  appJson.expo.android.versionCode = newCode;
  fs.writeFileSync("app.json", JSON.stringify(appJson, null, 2) + "\n");

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  pkg.version = newVersion;
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
'

# ── 5. Build (revert version edits if it fails) ──────────────────────────────
echo "Building release .aab — this is the long step (typically 1-3 min)."
echo ""

if ! pnpm run build:android; then
  echo ""
  echo "ERROR: build failed. Reverting version bumps."
  (cd "$REPO_ROOT" && git checkout -- artifacts/mobile/app.json artifacts/mobile/package.json)
  echo "Working tree restored to pre-release state. No commit, no tag."
  exit 1
fi

# ── 6. Commit, tag, append release notes ─────────────────────────────────────
TAG="v$NEW_VERSION"
RELEASE_DATE="$(date +%Y-%m-%d)"
RELEASES_FILE="$MOBILE_DIR/RELEASES.md"

if [ ! -f "$RELEASES_FILE" ]; then
  cat > "$RELEASES_FILE" <<EOF
# Temple TV Mobile — Release History

Newest releases first. Edit each entry's bullet list to describe what shipped.

EOF
fi

# Prepend the new entry (after the header lines).
TMP="$(mktemp)"
{
  head -n 4 "$RELEASES_FILE"
  cat <<EOF
## $TAG — $RELEASE_DATE

- versionCode: $NEW_CODE
- _Add release notes here before pushing._

EOF
  tail -n +5 "$RELEASES_FILE"
} > "$TMP"
mv "$TMP" "$RELEASES_FILE"

(
  cd "$REPO_ROOT"
  git add artifacts/mobile/app.json artifacts/mobile/package.json artifacts/mobile/RELEASES.md
  git commit -m "Release $TAG"
  git tag -a "$TAG" -m "Release $TAG (versionCode $NEW_CODE)"
)

# ── 7. Final summary ─────────────────────────────────────────────────────────
AAB_PATH="$MOBILE_DIR/android/app/build/outputs/bundle/release/app-release.aab"

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  Release $TAG cut successfully."
echo "═══════════════════════════════════════════════════════════════════════"
echo ""
echo "  AAB:   $AAB_PATH"
echo "  Tag:   $TAG (local only — not pushed)"
echo "  Notes: $RELEASES_FILE (stub added — edit before pushing)"
echo ""
echo "  Manual follow-ups:"
echo "    1. Edit RELEASES.md to describe what's in this release."
echo "    2. git commit --amend  (to fold notes into the release commit)"
echo "    3. git push --follow-tags origin $BRANCH"
echo "    4. Upload the .aab to Play Console → Internal testing track."
echo ""
