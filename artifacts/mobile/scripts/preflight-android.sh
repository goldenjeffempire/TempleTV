#!/usr/bin/env bash
# Android EAS production .aab preflight validator.
# Verifies every prerequisite before you run `eas build --platform android --profile production`.
# Exit 0 = ready to build. Non-zero = fix the reported issue first.

set -u
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
WARN=0
ok()   { echo "  ✓ $*"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $*"; FAIL=$((FAIL+1)); }
warn() { echo "  ! $*"; WARN=$((WARN+1)); }
sec()  { echo; echo "── $* ──"; }

sec "1. Versioning"
APP_VER=$(node -p "require('./app.json').expo.version")
PKG_VER=$(node -p "require('./package.json').version")
VC=$(node -p "require('./app.json').expo.android.versionCode")
[ "$APP_VER" = "$PKG_VER" ] && ok "version sync: app.json($APP_VER) == package.json($PKG_VER)" \
  || bad "version drift: app.json($APP_VER) != package.json($PKG_VER)"
[[ "$VC" =~ ^[0-9]+$ ]] && [ "$VC" -ge 1 ] && ok "android.versionCode = $VC" \
  || bad "android.versionCode invalid: $VC"

sec "2. Identity"
PKG=$(node -p "require('./app.json').expo.android.package")
SLUG=$(node -p "require('./app.json').expo.slug")
OWNER=$(node -p "require('./app.json').expo.owner")
PROJ=$(node -p "require('./app.json').expo.extra.eas.projectId")
[ "$PKG" = "com.templetv.jctm" ] && ok "package: $PKG" || bad "package: $PKG (expected com.templetv.jctm)"
[ -n "$OWNER" ] && ok "owner: $OWNER" || bad "owner missing"
[ -n "$PROJ" ] && ok "eas.projectId: $PROJ" || bad "eas.projectId missing"
echo "  · slug: $SLUG"

sec "3. Firebase (Android FCM)"
GS=./google-services.json
if [ ! -f $GS ]; then
  bad "google-services.json missing"
else
  if grep -q 'REPLACE_WITH_' $GS; then
    bad "google-services.json contains REPLACE_WITH_* placeholders"
  else
    GS_PKG=$(node -p "require('$GS').client[0].client_info.android_client_info.package_name")
    GS_PROJ=$(node -p "require('$GS').project_info.project_id")
    [ "$GS_PKG" = "$PKG" ] && ok "google-services.json package matches: $GS_PKG" \
      || bad "google-services.json package mismatch: $GS_PKG vs app $PKG"
    ok "Firebase project_id: $GS_PROJ"
  fi
fi

sec "4. Production hardening (app.json android)"
NEW_ARCH=$(node -p "require('./app.json').expo.newArchEnabled")
HERMES=$(node -p "require('./app.json').expo.jsEngine")
ALLOW_BACKUP=$(node -p "require('./app.json').expo.android.allowBackup")
BLOCKED=$(node -p "require('./app.json').expo.android.blockedPermissions.length")
[ "$NEW_ARCH" = "true" ] && ok "New Architecture enabled" || warn "New Architecture disabled"
[ "$HERMES" = "hermes" ] && ok "Hermes engine" || bad "jsEngine=$HERMES (expected hermes)"
[ "$ALLOW_BACKUP" = "false" ] && ok "allowBackup=false (no auto-backup of secrets)" \
  || warn "allowBackup=$ALLOW_BACKUP"
[ "$BLOCKED" -ge 5 ] && ok "$BLOCKED unnecessary permissions blocked" \
  || warn "only $BLOCKED permissions blocked"

sec "5. Release build properties"
BP=$(node -p "JSON.stringify(require('./app.json').expo.plugins.find(p=>Array.isArray(p)&&p[0]==='expo-build-properties')[1].android)")
echo "$BP" | grep -q '"enableProguardInReleaseBuilds":true' && ok "ProGuard enabled" || bad "ProGuard disabled"
echo "$BP" | grep -q '"enableShrinkResourcesInReleaseBuilds":true' && ok "Resource shrinking enabled" || warn "Resource shrinking disabled"
echo "$BP" | grep -q '"enableMinifyInReleaseBuilds":true' && ok "Minification enabled" || warn "Minification disabled"
echo "$BP" | grep -q '"usesCleartextTraffic":false' && ok "Cleartext HTTP blocked" || bad "Cleartext HTTP allowed"
TARGET=$(node -p "require('./app.json').expo.plugins.find(p=>Array.isArray(p)&&p[0]==='expo-build-properties')[1].android.targetSdkVersion")
[ "$TARGET" -ge 35 ] && ok "targetSdkVersion=$TARGET (Play Store 2025 requires ≥35)" \
  || bad "targetSdkVersion=$TARGET (Play Store rejects <35 from Aug 2025)"

sec "6. ProGuard keep rules (crash-critical native modules)"
RULES=$(node -p "require('./app.json').expo.plugins.find(p=>Array.isArray(p)&&p[0]==='expo-build-properties')[1].android.extraProguardRules")
for cls in \
  "com.doublesymmetry.kotlinaudio" \
  "com.doublesymmetry.trackplayer" \
  "com.brentvatne" \
  "com.swmansion.reanimated" \
  "com.facebook.react" \
  "com.facebook.hermes" \
  "kotlin." \
  "kotlinx.coroutines" \
  "expo.modules" \
  "androidx.media3" \
  "okhttp3"
do
  echo "$RULES" | grep -q "$cls" && ok "keep: $cls.**" || bad "MISSING keep: $cls.**"
done

sec "7. EAS build profile (production)"
PROF=$(node -p "JSON.stringify(require('./eas.json').build.production)")
echo "$PROF" | grep -q '"buildType":"app-bundle"' && ok "production buildType=app-bundle (.aab)" \
  || bad "production buildType is not app-bundle"
echo "$PROF" | grep -q '"channel":"production"' && ok "channel=production (OTA scoping)" || warn "no production OTA channel"
echo "$PROF" | grep -q '"distribution":"store"' && ok "distribution=store" || bad "distribution is not store"
echo "$PROF" | grep -q '"credentialsSource":"remote"' && ok "credentialsSource=remote (EAS-managed keystore)" \
  || warn "keystore not EAS-managed"
echo "$PROF" | grep -q '"EXPO_PUBLIC_API_URL":"https://api.templetv.org.ng"' && ok "API URL: https://api.templetv.org.ng" \
  || bad "production API URL not set to https://api.templetv.org.ng"

sec "8. Toolchain"
command -v node >/dev/null && ok "node $(node -v)" || bad "node missing"
command -v pnpm >/dev/null && ok "pnpm $(pnpm -v)" || bad "pnpm missing"
NV=$(node -v | sed 's/v//' | cut -d. -f1)
[ "$NV" -ge 20 ] && ok "node ≥20 (EAS image compatible)" || warn "node <20 may break EAS image"

sec "9. TypeScript health (production blocker)"
if pnpm --filter @workspace/mobile run typecheck >/tmp/tsc.log 2>&1; then
  ok "typecheck clean"
else
  bad "typecheck FAILED (see /tmp/tsc.log)"
  tail -20 /tmp/tsc.log | sed 's/^/    /'
fi

sec "10. Submission credentials (eas submit only, not eas build)"
[ -f ./google-service-account.json ] \
  && ok "google-service-account.json present (eas submit ready)" \
  || warn "google-service-account.json missing — required for 'eas submit' but NOT for 'eas build'"

sec "Summary"
echo "  Passed:   $PASS"
echo "  Warnings: $WARN"
echo "  Failed:   $FAIL"
echo
if [ "$FAIL" -eq 0 ]; then
  echo "✅ READY for: eas build --platform android --profile production"
  echo
  echo "Next steps (run locally with EAS CLI authenticated):"
  echo "  1. cd artifacts/mobile"
  echo "  2. npx eas-cli@latest login          # one-time"
  echo "  3. npx eas-cli@latest credentials    # generate/upload keystore (one-time)"
  echo "  4. npx eas-cli@latest build --platform android --profile production"
  echo "  5. (after build completes, ~20 min)"
  echo "     npx eas-cli@latest submit --platform android --profile production --latest"
  echo "     # requires ./google-service-account.json"
  exit 0
else
  echo "❌ NOT READY — fix the $FAIL failure(s) above first."
  exit 1
fi
