#!/usr/bin/env bash
# =============================================================================
# Temple TV — Automated Version Bump
# =============================================================================
#
# Bumps the semver version across all version-carrying files in the monorepo.
# Updates:
#   - artifacts/mobile/app.json    (expo.version)
#   - artifacts/mobile/package.json (version)
#   - artifacts/tv/tizen/config.xml (version attribute)
#   - artifacts/tv/lg/appinfo.json  (version)
#
# Usage:
#   bash scripts/version-bump.sh [patch|minor|major] [--commit] [--tag]
#
# Examples:
#   bash scripts/version-bump.sh             # patch bump, no commit
#   bash scripts/version-bump.sh minor       # minor bump, no commit
#   bash scripts/version-bump.sh patch --commit --tag   # patch + commit + tag
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BUMP_TYPE="${1:-patch}"
DO_COMMIT=false
DO_TAG=false

for arg in "$@"; do
  case "$arg" in
    patch|minor|major) BUMP_TYPE="$arg" ;;
    --commit) DO_COMMIT=true ;;
    --tag)    DO_TAG=true; DO_COMMIT=true ;;
  esac
done

# ── Compute new version ───────────────────────────────────────────────────────
read -r OLD_VERSION NEW_VERSION < <(node -e "
  const fs = require('fs');
  const appJson = JSON.parse(fs.readFileSync('artifacts/mobile/app.json', 'utf8'));
  const old = appJson.expo.version;
  const parts = old.split('.').map(Number);
  const type = '${BUMP_TYPE}';
  if (type === 'major') { parts[0]++; parts[1] = 0; parts[2] = 0; }
  else if (type === 'minor') { parts[1]++; parts[2] = 0; }
  else { parts[2]++; }
  console.log(old + ' ' + parts.join('.'));
")

echo "Bumping version: $OLD_VERSION → $NEW_VERSION ($BUMP_TYPE)"

# ── Update all files ──────────────────────────────────────────────────────────
node << EOF
const fs = require('fs');
const v = '${NEW_VERSION}';

// Mobile app.json — version string + Android versionCode auto-increment
const appJson = JSON.parse(fs.readFileSync('artifacts/mobile/app.json', 'utf8'));
appJson.expo.version = v;

// Auto-increment Android versionCode (integer, required by Play Store)
const currentCode = appJson.expo?.android?.versionCode ?? 0;
const nextCode = currentCode + 1;
if (!appJson.expo.android) appJson.expo.android = {};
appJson.expo.android.versionCode = nextCode;
console.log('  versionCode: ' + currentCode + ' → ' + nextCode);

// Mirror versionCode into iOS buildNumber (use date-based integer for TestFlight)
const now = new Date();
const iosBuild = now.getFullYear().toString() +
  String(now.getMonth() + 1).padStart(2, '0') +
  String(now.getDate()).padStart(2, '0') +
  String(now.getHours()).padStart(2, '0') +
  String(now.getMinutes()).padStart(2, '0');
if (!appJson.expo.ios) appJson.expo.ios = {};
appJson.expo.ios.buildNumber = iosBuild;
console.log('  ios.buildNumber → ' + iosBuild);

fs.writeFileSync('artifacts/mobile/app.json', JSON.stringify(appJson, null, 2) + '\n');
console.log('✓ artifacts/mobile/app.json');

// Mobile package.json
const mPkg = JSON.parse(fs.readFileSync('artifacts/mobile/package.json', 'utf8'));
mPkg.version = v;
fs.writeFileSync('artifacts/mobile/package.json', JSON.stringify(mPkg, null, 2) + '\n');
console.log('✓ artifacts/mobile/package.json');

// LG appinfo.json
const lgInfo = JSON.parse(fs.readFileSync('artifacts/tv/lg/appinfo.json', 'utf8'));
lgInfo.version = v;
fs.writeFileSync('artifacts/tv/lg/appinfo.json', JSON.stringify(lgInfo, null, 2) + '\n');
console.log('✓ artifacts/tv/lg/appinfo.json');
EOF

# Update Samsung config.xml
if [ -f "artifacts/tv/tizen/config.xml" ]; then
  sed -i.bak "s/version=\"[0-9]*\.[0-9]*\.[0-9]*\"/version=\"${NEW_VERSION}\"/" \
    artifacts/tv/tizen/config.xml
  rm -f artifacts/tv/tizen/config.xml.bak
  echo "✓ artifacts/tv/tizen/config.xml"
fi

echo ""
echo "Version bumped to $NEW_VERSION"

# ── Optional commit + tag ──────────────────────────────────────────────────────
CHANGED_FILES=(
  "artifacts/mobile/app.json"
  "artifacts/mobile/package.json"
  "artifacts/tv/lg/appinfo.json"
  "artifacts/tv/tizen/config.xml"
)

echo ""
echo "  Android versionCode and iOS buildNumber updated inside app.json"

if $DO_COMMIT; then
  git add "${CHANGED_FILES[@]}" 2>/dev/null || true
  git commit -m "chore(release): bump version $OLD_VERSION → $NEW_VERSION"
  echo "✓ Committed version bump"
fi

if $DO_TAG; then
  TAG="v${NEW_VERSION}"
  git tag -a "$TAG" -m "Release $TAG"
  echo "✓ Created tag $TAG"
  echo ""
  echo "  Push with: git push origin main --follow-tags"
fi

echo ""
echo "New version: $NEW_VERSION"
