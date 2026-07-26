---
name: AdMob placeholder-protection + frequency-cap audit
description: 4 bugs found and fixed in the AdMob production pipeline during Jul 2026 deep audit.
---

## Bugs Fixed (Jul 2026)

### Bug 1 — CRITICAL: `REPLACE_WITH_*` placeholders passed as real unit/app IDs
**Where:** `lib/ads/adConfig.ts`, `app.config.ts`
**Root cause:** `envStr()` returns any truthy string. `"REPLACE_WITH_APP_OPEN_UNIT_ID"` is truthy → forwarded to AdMob SDK as a real unit ID in release builds. Same for App ID in `getAndroidAppId()` / `getIosAppId()`.
**Effect:** No ads served (invalid ID), potential AdMob invalid-traffic policy flag, `app.config.ts` never threw its "production build" guard (placeholder is truthy).
**Fix:**
- Added `isPlaceholder(value: string): boolean` — detects `REPLACE_WITH_*` prefix.
- Added `envStrSafe(name)` — calls `envStr()` then filters placeholders to `""`.
- `getProdAdUnitId()` now uses `envStrSafe()`.
- `getAndroidAppId()` / `getIosAppId()` now use `envStrSafe()`.
- `pickAdUnitId()` also checks `isPlaceholder(prodUnitId)` as defense-in-depth.
- `app.config.ts` `readAppId()` now strips placeholder before the truthy check, so `APP_ENV=production` + unfilled eas.json → build error (as intended).

### Bug 2 — POLICY VIOLATION: App Open ad frequency cap was 4 min, not 30 min
**Where:** `components/ads/AppOpenAdController.tsx`
**Root cause:** `cooldownMs: 4 * 60 * 1000` (4 minutes). Docs and policy table both say 30 minutes.
**Effect:** App Open ads could show up to 7.5× more often than policy allows.
**Fix:** `cooldownMs: 30 * 60 * 1_000`, `maxPerSession: 6` (3 h minimum total daily spread).

### Bug 3 — MINOR: `nextBackoffDelay(0)` could return 0 ms
**Where:** `lib/ads/adFrequency.ts`
**Root cause:** Full-jitter returns `floor(rng() * cap)`. When `rng()` ≈ 0 and `attempt=0` (cap=2000ms), delay = 0ms → immediate retry.
**Effect:** Tight retry loop on persistent ad load failures.
**Fix:** Added `minFloor = floor(baseDelayMs / 4)` (500 ms for default 2 s base). Return `max(minFloor, floor(rng() * cap))`.

### Bug 4 — DOCUMENTATION: Wrong env var name
**Where:** `docs/admob-production-setup.md` line 122
**Root cause:** Checklist item said `EXPO_PUBLIC_ADMOB_ENABLED=true` but code uses `EXPO_PUBLIC_ADS_ENABLED`.
**Fix:** Corrected to `EXPO_PUBLIC_ADS_ENABLED`.

## Architecture confirmed production-grade (no bugs):
- `mobileAds.ts` — consent-first UMP → request config → SDK init; fully guarded; never throws.
- All 6 ad format hooks (`AppOpen`, `Banner`, `Interstitial`, `RewardedInterstitial`, `Rewarded`, `NativeAdView`) — lazy native module load, isMountedRef teardown, ILRD revenue callbacks, exponential backoff, graceful null on web/Expo-Go.
- `InterstitialAdController` inner/outer split — correct for PlayerContext dependency.
- `adTelemetry.ts` — dual Sentry+backend sink, fire-and-forget, never throws.
- `PlayerContext.tsx` — broadcast-mode/VOD mutual exclusion, shuffle/queue logic, settings persistence, AppState teardown all sound.
- `player.tsx` (sampled) — audio session serialization, PiP ghost-state guard, V2 broadcast bridge all solid.

## Operator action still required:
1. Create AdMob App IDs (Android + iOS) in AdMob console for pub-6817509745706083.
2. Create Ad Unit IDs for all 7 formats (App Open, Banner, Interstitial, GAM Interstitial, Rewarded, Rewarded Interstitial, Native).
3. Replace `REPLACE_WITH_*` placeholders in `eas.json` or set as EAS secrets.
   With the new placeholder-protection, an unfilled `APP_ENV=production` build now throws a hard error during `expo prebuild` so it can't ship accidentally.
