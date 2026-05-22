# Temple TV — Release Pipeline

Complete reference for releasing Temple TV across all platforms and surfaces.

---

## Quick Reference

| Surface | Tool | Trigger | Output |
|---|---|---|---|
| API + Admin | Render | `release.yml` workflow dispatch | Live at `api.templetv.org.ng` |
| Mobile (Android) | EAS Build | `v*.*.*` tag push | `.aab` → Play Store |
| Mobile (iOS) | EAS Build | `v*.*.*` tag push | `.ipa` → App Store / TestFlight |
| Android TV | EAS Build | `v*.*.*` tag push | `.aab` (separate track) |
| Apple TV | EAS Build | `v*.*.*` tag push | `.ipa` → tvOS App Store |
| Fire TV | EAS Build | `v*.*.*` tag push | `.apk` → Amazon Appstore |
| Samsung TV | Tizen Studio | Manual / `tv-release.yml` | `.wgt` → Samsung Seller Office |
| LG webOS | ares-cli | Manual / `tv-release.yml` | `.ipk` → LG Seller Lounge |
| TV Web (CDN) | AWS S3+CF | `tv-release.yml` | `tv.templetv.org.ng` |
| OTA Updates | EAS Update | JS-only push to `main` | Instant (no store review) |

---

## 1. Pre-Release Checklist

Before any release, verify:

```bash
# 1. Clean working tree
git status

# 2. On main branch
git checkout main && git pull

# 3. Monorepo health
pnpm install --ignore-scripts
pnpm run verify:production
pnpm run verify:mobile-lockfile
pnpm run typecheck:libs

# 4. All secrets set (check CI environment)
# See section 7 for required secrets
```

---

## 2. Standard Release (All Platforms)

The one-command release script handles everything:

```bash
# Patch release (1.2.3 → 1.2.4) — most common
pnpm release:production
# equivalent: bash scripts/release-all.sh --type patch

# Minor release (1.2.3 → 1.3.0)
pnpm release:production:minor

# Major release (1.2.3 → 2.0.0)
pnpm release:production:major

# Staging release (no store submission)
pnpm release:staging

# Dry run — validate without making changes
pnpm release:production:dry-run

# Skip TV packaging (if no Tizen Studio installed)
bash scripts/release-all.sh --type patch --skip-tv
```

### Via GitHub Actions (GUI / gh CLI)

Trigger the master orchestration workflow that runs ALL platforms in parallel:

```bash
# Trigger via GitHub CLI (requires gh auth login)
gh workflow run production-release.yml \
  --ref main \
  --field version_bump=patch

# With options
gh workflow run production-release.yml \
  --ref main \
  --field version_bump=minor \
  --field skip_mobile=false \
  --field skip_tv_packages=false \
  --field dry_run=false

# Dry run to validate all jobs without deploying
gh workflow run production-release.yml \
  --ref main \
  --field dry_run=true
```

Or open `Actions → production-release → Run workflow` in the GitHub UI.

### Post-deploy: Seed Admin Credentials

After first deploy or to reset the admin account in production:

```bash
# Using environment variables
SEED_ADMIN_PASSWORD=YourPassword bash scripts/seed-production.sh

# Or using the npm script
pnpm seed:production
```

### Validate Environment Variables

Before deploying, verify all required env vars are set:

```bash
# Validate all surfaces
pnpm env:validate

# Validate API server only
pnpm env:validate:api

# Validate a specific surface
bash scripts/env-validate.sh --surface=tv
```

This script:
1. Runs all pre-flight checks
2. Bumps version in all manifests
3. Generates a `CHANGELOG.md` entry
4. Creates a `git commit` + annotated `tag`
5. Pushes to `origin` — triggers GitHub Actions for all builds
6. Optionally packages Samsung `.wgt` and LG `.ipk` locally

---

## 3. Mobile Releases (EAS Build)

### Automated (GitHub Actions)

Pushing a semver tag triggers `mobile-release.yml`:

```bash
# Cut all mobile platforms in one push
git tag -a v1.2.3 -m "Release v1.2.3"
git push origin main --follow-tags
```

This builds:
- Android `.aab` (Play Store)
- iOS `.ipa` (App Store)
- Android TV `.aab`
- Apple TV `.ipa`
- Fire TV `.apk`

### Manual EAS Builds

```bash
cd artifacts/mobile

# Verified wrapper (always prefer this over raw eas build)
pnpm run eas:build -- --platform android --profile production
pnpm run eas:build -- --platform ios --profile production
pnpm run eas:build -- --platform all --profile staging

# Specific profiles
eas build --platform android --profile androidtv --non-interactive
eas build --platform android --profile firetv --non-interactive
eas build --platform ios --profile appletv --non-interactive
```

### EAS Submit (Store Submission)

```bash
cd artifacts/mobile

# Android → Play Store (internal track)
eas submit --platform android --profile production --latest

# iOS → TestFlight
eas submit --platform ios --profile production --latest
```

### OTA Updates (no store review)

For JavaScript-only changes, EAS Update delivers instantly:

```bash
cd artifacts/mobile

# Push OTA to production channel
eas update --channel production --message "Fix: video playback regression"

# Push OTA to staging only
eas update --channel staging --message "Test: new sermon grid layout"
```

OTA is automatically triggered by `ota-update.yml` when JS files change on `main`.
Native code changes (android/, ios/, package.json) skip OTA and require a full build.

### EAS Build Profiles

| Profile | Platform | Distribution | Use case |
|---|---|---|---|
| `development` | Android + iOS | Internal (APK / Simulator) | Local dev / debugging |
| `preview` | Android + iOS | Internal | Feature branch testing |
| `staging` | Android + iOS | Internal | Pre-production validation |
| `production` | Android + iOS | Store | Google Play / App Store |
| `production-android` | Android only | Store | Android-only release |
| `production-ios` | iOS only | Store | iOS-only release |
| `androidtv` | Android | Store | Google Play (TV) |
| `appletv` | iOS (tvOS) | Store | Apple TV App Store |
| `firetv` | Android | Amazon | Amazon Appstore |

---

## 4. TV Platform Releases

### Samsung Tizen (.wgt)

Requires Tizen Studio installed locally (not available in GitHub-hosted CI):

```bash
# Full build + package
cd artifacts/tv && bash tizen/build.sh

# Output: artifacts/tv/tizen/TempleTv.wgt
```

**Store submission:**
1. Visit [Samsung Seller Office](https://seller.samsungapps.com)
2. Select your app → Update → Upload `.wgt`
3. Fill in version notes and submit for review (7–10 days typical)

**Test on device:**
```bash
tizen install -n TempleTv.wgt -t <device_id>
tizen run -p JCTMTV001.TempleTv -t <device_id>
```

**Getting a Tizen device ID:**
```bash
tizen sdb devices
```

### LG webOS (.ipk)

```bash
# Full build + package
cd artifacts/tv && bash lg/build.sh

# Output: artifacts/tv/lg/com.templetv.app_1.0.0_all.ipk
```

**Store submission:**
1. Visit [LG Seller Lounge](https://seller.lgappstv.com)
2. Upload `.ipk` file
3. Review takes 5–14 days

**Test on device:**
```bash
# Set up device once
ares-setup-device

# Install and launch
ares-install -d tv-dev com.templetv.app_1.0.0_all.ipk
ares-launch -d tv-dev com.templetv.app
```

### Amazon Fire TV

Fire TV uses the Amazon Web App Packager (PWA approach — no native build):

1. Ensure `artifacts/tv/firetv/manifest.json` is up to date
2. Visit [Amazon Developer Console](https://developer.amazon.com/apps-and-games)
3. Submit via **Web App Packager** pointing to `https://tv.templetv.org.ng`
4. The manifest at `artifacts/tv/firetv/manifest.json` is the submission reference

Alternatively, the Fire TV `.apk` (EAS Build, `firetv` profile) can be submitted as a native Android app.

### TV Web CDN Deploy (AWS S3 + CloudFront)

Automatic on version tags via `tv-release.yml`. Manual deploy:

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=eu-north-1
export S3_BUCKET=temple-tv-web
export CLOUDFRONT_DISTRIBUTION_ID=...

bash scripts/deploy-tv-cdn.sh
```

---

## 5. API + Admin Deploy

### Automated (GitHub Actions)

```
GitHub Actions → release.yml → workflow_dispatch
  Environment: production
  SHA: <commit hash>
```

Navigate to: **Actions → release → Run workflow**

### Manual (Render webhook)

```bash
curl -X POST "$RENDER_DEPLOY_HOOK_URL"
```

### Health check

```bash
curl https://api.templetv.org.ng/api/healthz
```

### Rollback

```bash
# Trigger rollback webhook (reverts to previous Render deploy)
curl -X POST "$RENDER_ROLLBACK_HOOK_URL"
```

---

## 6. Version Management

### Auto-versioning

```bash
# Bump patch version across all manifests
bash scripts/version-bump.sh patch

# Bump minor version + commit + tag
bash scripts/version-bump.sh minor --tag

# Files updated:
#   artifacts/mobile/app.json     (expo.version)
#   artifacts/mobile/package.json (version)
#   artifacts/tv/lg/appinfo.json  (version)
#   artifacts/tv/tizen/config.xml (version attribute)
```

### Version Sources

| File | Field | Platform |
|---|---|---|
| `artifacts/mobile/app.json` | `expo.version` | iOS + Android semver |
| `artifacts/mobile/app.json` | `expo.android.versionCode` | Android store integer (auto by EAS) |
| `artifacts/mobile/app.json` | `expo.ios.buildNumber` | iOS build string (auto by EAS) |
| `artifacts/tv/tizen/config.xml` | `version` | Samsung TV |
| `artifacts/tv/lg/appinfo.json` | `version` | LG TV |

EAS automatically increments `versionCode`/`buildNumber` on every build — do not manually manage these.

### Changelog

```bash
# Auto-generate from git log
bash scripts/changelog.sh

# Or for a specific version
bash scripts/changelog.sh 1.2.3
```

The changelog uses [conventional commits](https://www.conventionalcommits.org/) prefixes for categorization:
- `feat:` → Features section
- `fix:` → Bug Fixes section
- `perf:` → Performance section
- `BREAKING CHANGE:` → Breaking Changes section

---

## 7. Required Secrets

### GitHub Repository Secrets

| Secret | Description | Where to get |
|---|---|---|
| `EXPO_TOKEN` | EAS CLI authentication | `expo.dev/accounts/templetv/settings/access-tokens` |

### GitHub Environment Secrets (production + staging)

| Secret | Required | Description |
|---|---|---|
| `RENDER_DEPLOY_HOOK_URL` | Yes | Render → Service → Deploy Hook |
| `RENDER_ROLLBACK_HOOK_URL` | No | Render → Service → Rollback Hook |
| `API_HEALTHCHECK_URL` | Yes | `https://api.templetv.org.ng/api/healthz` |
| `JWT_ACCESS_SECRET` | Yes | ≥32 char HMAC secret |
| `JWT_REFRESH_SECRET` | Yes | ≥32 char HMAC secret |
| `ADMIN_API_TOKEN` | Yes | ≥16 char admin token |
| `SENTRY_AUTH_TOKEN` | No | `sentry.io → Settings → Auth Tokens` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | No | Play Console → API access → Service accounts |
| `APPLE_API_KEY_P8` | No | App Store Connect → Keys |
| `APPLE_API_KEY_ID` | No | 10-char key ID from App Store Connect |
| `APPLE_API_KEY_ISSUER_ID` | No | UUID from App Store Connect |
| `MATCH_GIT_URL` | No | Private git repo for iOS certs (Fastlane Match) |
| `MATCH_PASSWORD` | No | Match encryption password |
| `AWS_ACCESS_KEY_ID` | No | AWS IAM user for S3 deploys |
| `AWS_SECRET_ACCESS_KEY` | No | AWS IAM secret |
| `CLOUDFRONT_DISTRIBUTION_ID` | No | CloudFront distribution for TV CDN |
| `FIREBASE_ANDROID_APP_ID` | No | Firebase console → Android app |
| `SENTRY_ORG` | No | Sentry organization slug (e.g. `templetv`) |
| `SENTRY_DSN` | No | Sentry DSN from `sentry.io → Project → Settings` |
| `GOOGLE_SERVICES_JSON` | No | `base64 -i google-services.json` — Firebase Android |
| `GOOGLE_SERVICE_INFO_PLIST` | No | `base64 -i GoogleService-Info.plist` — Firebase iOS |
| `FIREBASE_PROJECT_ID` | No | Firebase project ID |
| `SEED_ADMIN_EMAIL` | No | Admin email to seed post-deploy (e.g. `admin@templetv.org.ng`) |
| `SEED_ADMIN_PASSWORD` | No | Admin password to seed post-deploy |
| `S3_TV_BUCKET` | No | S3 bucket name for TV assets (e.g. `temple-tv-web`) |
| `AWS_REGION` | No | AWS region (default: `eu-north-1`) |

### Setup helper

```bash
# Interactive secret setup via GitHub CLI
bash scripts/github-secrets-setup.sh --repo templetv/temple-tv --env production
bash scripts/github-secrets-setup.sh --repo templetv/temple-tv --env staging
```

---

## 8. Android Signing (Keystore)

EAS Build manages signing credentials remotely for CI builds. For local/Fastlane builds:

```bash
# Generate production keystore (one-time)
bash scripts/keystore-setup.sh --export

# Output:
#   artifacts/mobile/android/keystores/templetv-release.jks
#   .env.signing  (contains all credentials — add to .gitignore)
```

**CRITICAL:** Back up the keystore immediately to:
- A password manager (1Password, Bitwarden)
- AWS Secrets Manager or similar
- A secure offline location

Losing the keystore = cannot update the Play Store app. Period.

---

## 9. iOS Code Signing (Fastlane Match)

Fastlane Match stores iOS certificates and provisioning profiles in a private git repo, encrypted with a password. All team members and CI use the same credentials.

### Initial setup (one time)

```bash
# Create a private GitHub repo for certificates
# e.g. github.com/templetv/certificates (must be private)

# Initialize Match
bundle exec fastlane match init
```

### Sync certificates

```bash
# App Store certificates
bundle exec fastlane match appstore

# Development certificates
bundle exec fastlane match development

# In CI (read-only)
MATCH_READONLY=true bundle exec fastlane match appstore
```

### Nuke and regenerate (if certificates are revoked)

```bash
bundle exec fastlane match nuke appstore
bundle exec fastlane match appstore
```

---

## 10. Docker

### Development

```bash
# Full dev stack (API + Admin + Postgres + Redis + Mailhog)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up

# With mail capture
docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile mail up
```

### Production

```bash
# Set required env vars first
export POSTGRES_PASSWORD=... JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=... ADMIN_API_TOKEN=...

# Deploy
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Rolling update
IMAGE_TAG=v1.2.3 docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps api admin

# View logs
docker compose logs -f api
```

### Publish images (GitHub Container Registry)

Automatic on version tags via `docker-publish.yml`. Manual:

```bash
# Build and push API image
docker build -t ghcr.io/templetv/temple-tv-api:latest -f artifacts/api-server/Dockerfile .
docker push ghcr.io/templetv/temple-tv-api:latest
```

---

## 11. TurboRepo Caching

`turbo.json` configures task dependencies and caching. With remote caching enabled, builds are dramatically faster on CI:

```bash
# Enable Vercel remote cache (free tier)
npx turbo login
npx turbo link

# Run all builds with caching
pnpm exec turbo run build

# Type-check only changed packages
pnpm exec turbo run typecheck --filter='[HEAD~1]'
```

---

## 12. Sentry Source Maps

Source maps are uploaded automatically in the release pipeline. Manual upload:

```bash
export SENTRY_AUTH_TOKEN=...
export SENTRY_ORG=templetv

bash scripts/sentry-release.sh 1.2.3
```

---

## 13. Rollback Procedures

### API / Admin Rollback

**Option A — Render UI:**  
Dashboard → Service → Deploys → click any previous deploy → **Rollback**

**Option B — Webhook:**
```bash
curl -X POST "$RENDER_ROLLBACK_HOOK_URL"
```

**Option C — Git revert + redeploy:**
```bash
git revert HEAD
git push origin main
# Then trigger release.yml with the new SHA
```

### Mobile OTA Rollback

```bash
cd artifacts/mobile

# List recent updates
eas update:list --channel production

# Rollback to previous update
eas update:republish --channel production --group <previous-update-group-id>
```

### Mobile Store Rollback

Play Store and App Store do not support rollbacks — they only go forward. Options:
1. Immediately release the previous version as a new build (increment build number)
2. Use EAS OTA to push a JS-only fix without store review (fastest)

### TV Rollback

Re-deploy the previous CDN assets:
```bash
# Roll back S3 to a specific version's assets
aws s3 sync "s3://temple-tv-web/releases/v1.2.2/" "s3://temple-tv-web/tv/" --delete
aws cloudfront create-invalidation --distribution-id $CLOUDFRONT_DISTRIBUTION_ID --paths "/tv/*"
```

---

## 14. GitHub Actions Workflows Summary

| Workflow | File | Trigger | Purpose |
|---|---|---|---|
| Production Release | `production-release.yml` | Manual dispatch | Version bump + API deploy + all mobile builds |
| Mobile Release | `mobile-release.yml` | `v*.*.*` tag + manual | EAS builds for all 5 mobile platforms + auto-submit |
| OTA Update | `ota-update.yml` | `main` push (JS files) | EAS OTA for instant JS-only updates |
| Store Deploy | `store-deploy.yml` | Manual | Re-submit or promote any EAS build to stores |

### Required GitHub Secrets

Run `bash scripts/github-secrets-setup.sh --repo your-org/temple-tv` to register all secrets interactively.

| Secret | Scope | Used by | How to get it |
|---|---|---|---|
| `EXPO_TOKEN` | Repo | All mobile workflows | expo.dev/accounts → Settings → Access tokens |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Repo | Android submission | Google Play Console → Setup → API access → Service accounts |
| `APPLE_API_KEY_P8` | Repo | iOS submission | appstoreconnect.apple.com → Users → Keys → App Store Connect API |
| `APPLE_API_KEY_ID` | Repo | iOS submission | Same page as above — 10-char key ID |
| `APPLE_API_KEY_ISSUER_ID` | Repo | iOS submission | Same page as above — issuer UUID |
| `RENDER_DEPLOY_HOOK_URL` | Production env | `production-release.yml` | Render dashboard → service → Settings → Deploy Hook |
| `API_HEALTHCHECK_URL` | Production env | `production-release.yml` | e.g. `https://api.templetv.org.ng/api/healthz` |

### Quick CI setup (one-time)

```bash
# 1. Register all secrets
bash scripts/github-secrets-setup.sh --repo templetv/temple-tv

# 2. Verify the workflows are recognised
gh workflow list

# 3. Dry-run the full release to validate without deploying
gh workflow run production-release.yml \
  --ref main \
  --field version_bump=patch \
  --field dry_run=true
```

---

## 15. Platform Store Links

| Platform | Store | URL |
|---|---|---|
| Android | Google Play Console | https://play.google.com/console/developers |
| iOS | App Store Connect | https://appstoreconnect.apple.com |
| Android TV | Google Play (TV) | https://play.google.com/console/developers |
| Apple TV | App Store Connect (tvOS) | https://appstoreconnect.apple.com |
| Fire TV | Amazon Developer | https://developer.amazon.com/apps-and-games |
| Samsung | Samsung Seller Office | https://seller.samsungapps.com |
| LG | LG Seller Lounge | https://seller.lgappstv.com |
| EAS | Expo Dashboard | https://expo.dev/accounts/templetv/projects/mobile |

---

## 16. Troubleshooting

### EAS Build fails with "lockfile invariant check failed"

```bash
# Run the lockfile verifier locally
pnpm run verify:mobile-lockfile

# Fix: reset overrides and reinstall
pnpm install --ignore-scripts
pnpm run verify:mobile-lockfile
```

### EAS Build fails with "brace-expansion" or "expand is not a function"

The lockfile has a dep that was force-upgraded across a major. Check `pnpm-lock.yaml`:
```bash
grep "brace-expansion" pnpm-lock.yaml | grep "version:"
# Should be 1.x.x — if 2.x.x, the override is missing or broken
```

### iOS build fails with "No matching provisioning profiles"

```bash
# Re-sync Match certificates
MATCH_READONLY=false bundle exec fastlane match appstore
```

### Samsung .wgt packaging fails

Tizen CLI requires GUI Tizen Studio. In CI this step is skipped.
```bash
# Install Tizen Studio on your Mac/Linux machine
# Add to PATH: ~/tizen-studio/tools/ide/bin
tizen version  # should print version
cd artifacts/tv && bash tizen/build.sh
```

### CloudFront invalidation not propagating

Invalidations take 5–30 minutes globally. Force a hard refresh in the browser:
`Ctrl+Shift+R` (Chrome) or clear site data.

### Render deploy hook returns 404

The hook URL has rotated (Render rotates hooks when you regenerate them). Update `RENDER_DEPLOY_HOOK_URL` in GitHub Secrets.

### Admin login fails after production deploy

The admin account may not have been seeded yet. Run:

```bash
SEED_ADMIN_PASSWORD=YourPassword bash scripts/seed-production.sh
# or
pnpm seed:production
```

This uses the `/api/auth/seed?force=true` endpoint which safely wipes any existing
elevated accounts and recreates the admin with the provided credentials. It is
idempotent and safe to run multiple times.

### Environment variables missing

Run the environment validator to identify missing variables before deploying:

```bash
pnpm env:validate
# or for a specific surface:
bash scripts/env-validate.sh --surface=api
```

### Firebase config not found in CI

The `google-services.json` and `GoogleService-Info.plist` files are gitignored.
For CI, encode them as GitHub Secrets:

```bash
# Encode:
base64 -i google-services.json | pbcopy
# Paste into GOOGLE_SERVICES_JSON GitHub secret

base64 -i GoogleService-Info.plist | pbcopy
# Paste into GOOGLE_SERVICE_INFO_PLIST GitHub secret
```

See `artifacts/mobile/google-services.json.template` and
`artifacts/mobile/GoogleService-Info.plist.template` for the required structure.
