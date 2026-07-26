---
name: AdMob production wiring — mobile app
description: How production AdMob App IDs and ad unit IDs are injected, what components exist, and the placement policy enforced in code.
---

## Config plugin pattern

`plugins/with-admob-app-id.js` runs after `react-native-google-mobile-ads` in the Expo
plugin chain and overrides `com.google.android.gms.ads.APPLICATION_ID` in AndroidManifest
and `GADApplicationIdentifier` in Info.plist using `ADMOB_ANDROID_APP_ID` /
`ADMOB_IOS_APP_ID` env vars read at EAS prebuild time. Also forces
`DELAY_APP_MEASUREMENT_INIT=true` on both platforms for the UMP consent-first flow.

**Why**: rn-google-mobile-ads plugin options are evaluated at local `expo prebuild`, not at
EAS build time, so production App IDs (which are EAS secrets) would never be injected.
Running a second plugin that reads `process.env.*` at build time works around this.

## Ad unit env vars (all EXPO_PUBLIC_ → baked at build time)

- `EXPO_PUBLIC_ADMOB_ANDROID_APP_ID` / `EXPO_PUBLIC_ADMOB_IOS_APP_ID` — App IDs (runtime fallback via adConfig.getAndroidAppId())
- `EXPO_PUBLIC_ADMOB_APP_OPEN_UNIT_ID` — App Open
- `EXPO_PUBLIC_ADMOB_BANNER_UNIT_ID` — Banner
- `EXPO_PUBLIC_ADMOB_INTERSTITIAL_UNIT_ID` — Interstitial
- `EXPO_PUBLIC_ADMOB_REWARDED_UNIT_ID` — Rewarded
- `EXPO_PUBLIC_ADMOB_REWARDED_INTERSTITIAL_UNIT_ID` — Rewarded interstitial
- `EXPO_PUBLIC_ADMOB_NATIVE_UNIT_ID` — Native (Android: banner proxy)
- `EXPO_PUBLIC_GAM_INTERSTITIAL_AD_UNIT_ID` — GAM interstitial

All `REPLACE_WITH_*` placeholders are in `eas.json` for every production profile.
See `docs/admob-production-setup.md` for the full `eas secret:create` commands.

## Components / hooks

- `components/ads/AppOpenAdController.tsx` — foreground-resume app open ad (pre-existing)
- `components/ads/AdBanner.tsx` — adaptive banner (pre-existing)
- `components/ads/useInterstitialAd.ts` — interstitial hook; frequency cap 5min/4 per session
- `components/ads/useRewardedAd.ts` — rewarded hook; 15min/3 per session
- `components/ads/useRewardedInterstitialAd.ts` — rewarded interstitial; 20min/2 per session
- `components/ads/NativeAdView.tsx` — native ad (banner proxy on Android)
- `components/ads/InterstitialAdController.tsx` — root-level provider; reads usePlayer().isPlaying;
  exposes useInterstitialAdContext() { showInterstitial, showRewardedInterstitial, isInterstitialReady }

**Why inner/outer split in InterstitialAdController**: Hooks can't be in try/catch. The
Inner component reads usePlayer() normally and always mounts inside PlayerProvider.

## Frequency capper

Class is `FrequencyCapper` (not FrequencyCapManager) from `lib/ads/adFrequency.ts`.
Constructor: `new FrequencyCapper({ key: { cooldownMs, maxPerSession? } })`.

## Layout wiring

`InterstitialAdController` wraps the full subtree inside `<PlayerProvider>` in
`app/_layout.tsx`. `AppOpenAdController` stays as a floating sibling inside the JSX tree.

## Publisher account

pub-6817509745706083 · Africa/Lagos · USD · Programmatic Limited Ads ON · Full IP sharing OFF
