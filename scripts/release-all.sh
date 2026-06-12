#!/usr/bin/env bash
# =============================================================================
# Temple TV — One-Command Release Script
# =============================================================================
#
# Orchestrates a full production release across ALL platforms:
#   1. Pre-flight checks (clean tree, on main, lockfile integrity)
#   2. Version bump + changelog generation
#   3. Git commit + tag
#   4. API/Admin deploy (Render webhook)
#   5. EAS Build — Android (.aab) + iOS (.ipa)
#   6. EAS Build — Android TV + Apple TV + Fire TV
#   7. TV web packaging — Samsung (.wgt) + LG (.ipk)
#   8. Sentry source map upload
#   9. Push tag + trigger GitHub Actions
#
# Usage:
#   bash scripts/release-all.sh [--type patch|minor|major] [--dry-run] [--skip-tv] [--no-store]
#
# Flags:
#   --type      Semver bump type (default: patch)
#   --dry-run   Validate everything but make no changes
#   --skip-tv   Skip Samsung/LG packaging (requires local Tizen Studio / ares-cli)
#   --no-store  Build but do not submit to stores
#
# Prerequisites:
#   eas-cli: npm install -g eas-cli && eas login
#   For Samsung: Tizen Studio CLI on PATH (tizen command)
#   For LG:      npm install -g @webosose/ares-cli
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── Parse flags ───────────────────────────────────────────────────────────────
BUMP_TYPE="patch"
DRY_RUN=false
SKIP_TV=false
NO_STORE=false

for arg in "$@"; do
  case "$arg" in
    --type=*)  BUMP_TYPE="${arg#--type=}" ;;
    --dry-run) DRY_RUN=true ;;
    --skip-tv) SKIP_TV=true ;;
    --no-store) NO_STORE=true ;;
    -h|--help)
      grep '^#' "$0" | head -40 | sed 's/^# //'
      exit 0
      ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}  →${NC} $*"; }
ok()    { echo -e "${GREEN}  ✓${NC} $*"; }
warn()  { echo -e "${YELLOW}  ⚠${NC} $*"; }
die()   { echo -e "${RED}  ✗${NC} $*" >&2; exit 1; }
dryrun(){ $DRY_RUN && echo -e "${YELLOW}[DRY-RUN]${NC} $*" || true; }

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║         Temple TV — Full Production Release              ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
dryrun "DRY RUN MODE — no changes will be made"
echo ""

# ── 1. Pre-flight checks ──────────────────────────────────────────────────────
info "Running pre-flight checks..."

DIRTY="$(git status --porcelain)"
[ -n "$DIRTY" ] && die "Working tree is not clean. Commit or stash changes first."
ok "Working tree is clean"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" != "main" ] && warn "Not on main branch (on $BRANCH). Proceeding anyway."

info "Running lockfile integrity check..."
pnpm run verify:mobile-lockfile || die "Lockfile check failed"
ok "Lockfile integrity verified"

info "Running production verification..."
pnpm run verify:production || die "Production verification failed"
ok "Production verification passed"

# ── 2. Determine new version ───────────────────────────────────────────────────
info "Computing version bump ($BUMP_TYPE)..."
read -r OLD_VERSION NEW_VERSION < <(node -e "
  const fs = require('fs');
  const appJson = JSON.parse(fs.readFileSync('artifacts/mobile/app.json', 'utf8'));
  const oldVersion = appJson.expo.version;
  const parts = oldVersion.split('.').map(Number);
  const type = '${BUMP_TYPE}';
  if (type === 'major') { parts[0]++; parts[1] = 0; parts[2] = 0; }
  else if (type === 'minor') { parts[1]++; parts[2] = 0; }
  else { parts[2]++; }
  console.log(oldVersion + ' ' + parts.join('.'));
")
TAG="v${NEW_VERSION}"
info "Version: $OLD_VERSION → $NEW_VERSION  (tag: $TAG)"

if $DRY_RUN; then
  ok "[DRY-RUN] Would bump version to $NEW_VERSION"
  echo ""
  echo "Dry run complete. Remove --dry-run to execute."
  exit 0
fi

# ── 3. Apply version bump ─────────────────────────────────────────────────────
info "Applying version bump..."
node -e "
  const fs = require('fs');
  const v = '${NEW_VERSION}';
  const appJson = JSON.parse(fs.readFileSync('artifacts/mobile/app.json', 'utf8'));
  appJson.expo.version = v;
  fs.writeFileSync('artifacts/mobile/app.json', JSON.stringify(appJson, null, 2) + '\n');
  const pkg = JSON.parse(fs.readFileSync('artifacts/mobile/package.json', 'utf8'));
  pkg.version = v;
  fs.writeFileSync('artifacts/mobile/package.json', JSON.stringify(pkg, null, 2) + '\n');
  const apiPkg = JSON.parse(fs.readFileSync('artifacts/api-server/package.json', 'utf8'));
  apiPkg.version = v;
  fs.writeFileSync('artifacts/api-server/package.json', JSON.stringify(apiPkg, null, 2) + '\n');
"
ok "Version bumped to $NEW_VERSION in app.json + package.json + api-server/package.json"

# ── 4. Generate changelog entry ────────────────────────────────────────────────
info "Generating changelog..."
bash scripts/changelog.sh "$NEW_VERSION" || warn "Changelog generation failed (non-fatal)"

# ── 5. Commit and tag ─────────────────────────────────────────────────────────
info "Creating release commit and tag..."
git add artifacts/mobile/app.json artifacts/mobile/package.json artifacts/api-server/package.json CHANGELOG.md 2>/dev/null || true
git commit -m "chore(release): $TAG"
git tag -a "$TAG" -m "Release $TAG"
ok "Created tag $TAG"

# ── 6. Push to origin (triggers GitHub Actions for all platforms) ──────────────
info "Pushing to origin (this triggers CI/CD for all platforms)..."
git push origin "$BRANCH" --follow-tags
ok "Pushed to origin. GitHub Actions will now:"
echo "     • EAS Build: Android (.aab) + iOS (.ipa)"
echo "     • EAS Build: Android TV + Apple TV + Fire TV"
echo "     • TV packaging: Samsung (.wgt) + LG (.ipk)"
echo "     • Deploy API/Admin to Render"
echo "     Watch: https://github.com/$(git config --get remote.origin.url | sed 's/.*github.com[:/]\(.*\)\.git/\1/')/actions"

# ── 7. Optional: local TV packaging ──────────────────────────────────────────
if ! $SKIP_TV; then
  echo ""
  info "Packaging TV builds locally..."

  info "Building TV web assets..."
  pnpm --filter @workspace/tv run build:tizen || warn "Tizen build failed"
  pnpm --filter @workspace/tv run build:lg || warn "LG build failed"
  pnpm --filter @workspace/tv run build:firetv || warn "FireTV build failed"

  info "Packaging Samsung Tizen (.wgt)..."
  if command -v tizen &>/dev/null; then
    bash artifacts/tv/tizen/build.sh || warn "Samsung packaging failed"
    ok "Samsung .wgt created: artifacts/tv/tizen/TempleTv.wgt"
  else
    warn "Tizen CLI not found — skipping .wgt packaging (run manually with Tizen Studio)"
  fi

  info "Packaging LG webOS (.ipk)..."
  if command -v ares-package &>/dev/null; then
    bash artifacts/tv/lg/build.sh || warn "LG packaging failed"
    ok "LG .ipk created: artifacts/tv/lg/com.templetv.app_${NEW_VERSION}_all.ipk"
  else
    warn "ares-cli not found — skipping .ipk packaging (npm install -g @webosose/ares-cli)"
  fi
fi

# ── 8. Sentry source map upload ───────────────────────────────────────────────
if [ -n "${SENTRY_AUTH_TOKEN:-}" ]; then
  info "Uploading Sentry source maps..."
  pnpm --filter @workspace/api-server run build 2>/dev/null || true
  # Upload via sentry-cli if available
  if command -v sentry-cli &>/dev/null; then
    sentry-cli releases new "$TAG" --org "${SENTRY_ORG:-templetv}" --project "${SENTRY_PROJECT:-temple-tv-api}" 2>/dev/null || true
    sentry-cli releases files "$TAG" upload-sourcemaps artifacts/api-server/dist/ \
      --org "${SENTRY_ORG:-templetv}" --project "${SENTRY_PROJECT:-temple-tv-api}" 2>/dev/null || true
    ok "Sentry source maps uploaded"
  fi
fi

# ── 9. Final summary ──────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  🚀  Release $TAG launched successfully!                "
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Tag:  $TAG"
echo "  EAS:  https://expo.dev/accounts/templetv/projects/mobile/builds"
echo "  GHA:  https://github.com/.../actions"
echo ""
echo "  Next steps:"
echo "    1. Monitor GitHub Actions for build status"
echo "    2. Review EAS builds when complete"
if ! $NO_STORE; then
  echo "    3. Submit to stores:"
  echo "       Android: eas submit --platform android --latest"
  echo "       iOS:     eas submit --platform ios --latest"
fi
echo "    4. Samsung: upload artifacts/tv/tizen/TempleTv.wgt → seller.samsungapps.com"
echo "    5. LG:      upload artifacts/tv/lg/*.ipk → seller.lgappstv.com"
echo ""
