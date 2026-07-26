# AdMob Production Setup — Temple TV Mobile

Publisher: **pub-6817509745706083** (JCTM / Temple TV)
Account type: Africa/Lagos · USD · Programmatic Limited Ads enabled · Full IP sharing: off

---

## Overview

The code is fully wired for production AdMob monetisation. Two things are still
needed before a production build will serve real ads:

1. **Create App IDs and Ad Unit IDs** in the AdMob console.
2. **Fill in the `REPLACE_WITH_*` placeholders** in `eas.json` (or, better, set
   them as EAS secrets and reference them) for every production build profile.

---

## Step 1 — Create AdMob App IDs

1. Sign in at https://admob.google.com/ with the `pub-6817509745706083` account.
2. **Apps → Add app** — add "Temple TV" for Android, then again for iOS.
3. Each creates an **App ID** in the format `ca-app-pub-6817509745706083~XXXXXXXXXX`.

> The test App IDs already in `app.json` (`ca-app-pub-3940256099942544~…`) are
> Google's shared sample apps — safe for development, but will NOT serve real
> ads in production.

---

## Step 2 — Create Ad Units

Inside each App in the AdMob console, create the following ad units:

| Format                  | Recommended type       | env var suffix         |
|-------------------------|------------------------|------------------------|
| App Open                | App Open               | `APP_OPEN_UNIT_ID`     |
| Banner                  | Banner (Adaptive)      | `BANNER_UNIT_ID`       |
| Interstitial            | Interstitial           | `INTERSTITIAL_UNIT_ID` |
| Rewarded                | Rewarded               | `REWARDED_UNIT_ID`     |
| Rewarded Interstitial   | Rewarded Interstitial  | `REWARDED_INTERSTITIAL_UNIT_ID` |
| Native (Android banner proxy) | Banner (300×250) | `NATIVE_UNIT_ID`     |
| GAM Interstitial        | (via GAM, optional)    | `GAM_INTERSTITIAL_AD_UNIT_ID` |

Each unit ID has the format `ca-app-pub-6817509745706083/YYYYYYYYYY`.

---

## Step 3 — Fill in `eas.json` placeholders

Replace every `REPLACE_WITH_*` value in `eas.json` under each production
profile's `"env"` section with the real IDs from step 1 and 2.

Profiles to update: `production-aab`, `production`, `production-ios`,
`production-android`.

**Recommended approach — EAS Secrets (more secure than eas.json env):**

```bash
eas secret:create --scope project --name ADMOB_ANDROID_APP_ID  --value "ca-app-pub-6817509745706083~XXXXXXXXXX"
eas secret:create --scope project --name ADMOB_IOS_APP_ID      --value "ca-app-pub-6817509745706083~YYYYYYYYYY"
eas secret:create --scope project --name EXPO_PUBLIC_ADMOB_ANDROID_APP_ID  --value "ca-app-pub-6817509745706083~XXXXXXXXXX"
eas secret:create --scope project --name EXPO_PUBLIC_ADMOB_IOS_APP_ID      --value "ca-app-pub-6817509745706083~YYYYYYYYYY"
eas secret:create --scope project --name EXPO_PUBLIC_ADMOB_APP_OPEN_UNIT_ID   --value "ca-app-pub-6817509745706083/ZZZZZZZZZZ"
eas secret:create --scope project --name EXPO_PUBLIC_ADMOB_BANNER_UNIT_ID     --value "ca-app-pub-6817509745706083/ZZZZZZZZZZ"
eas secret:create --scope project --name EXPO_PUBLIC_ADMOB_INTERSTITIAL_UNIT_ID --value "ca-app-pub-6817509745706083/ZZZZZZZZZZ"
eas secret:create --scope project --name EXPO_PUBLIC_ADMOB_REWARDED_UNIT_ID   --value "ca-app-pub-6817509745706083/ZZZZZZZZZZ"
eas secret:create --scope project --name EXPO_PUBLIC_ADMOB_REWARDED_INTERSTITIAL_UNIT_ID --value "ca-app-pub-6817509745706083/ZZZZZZZZZZ"
eas secret:create --scope project --name EXPO_PUBLIC_ADMOB_NATIVE_UNIT_ID     --value "ca-app-pub-6817509745706083/ZZZZZZZZZZ"
eas secret:create --scope project --name EXPO_PUBLIC_GAM_INTERSTITIAL_AD_UNIT_ID --value "ca-app-pub-6817509745706083/ZZZZZZZZZZ"
```

EAS secrets are automatically injected into the build environment; you can then
remove the `REPLACE_WITH_*` lines from `eas.json` entirely.

---

## How the config plugin works

`plugins/with-admob-app-id.js` runs during EAS prebuild **after**
`react-native-google-mobile-ads`'s own plugin, and replaces:

- **Android** — `com.google.android.gms.ads.APPLICATION_ID` metadata in
  `AndroidManifest.xml` with `ADMOB_ANDROID_APP_ID`.
- **iOS** — `GADApplicationIdentifier` in `Info.plist` with `ADMOB_IOS_APP_ID`.
- Both platforms — `DELAY_APP_MEASUREMENT_INIT` / `GADDelayAppMeasurementInit`
  forced to `true` (required for UMP consent-first flow).

When the env vars are absent (local dev builds), the plugin logs a warning and
leaves the existing test App IDs in place so development builds still work.

---

## Ad display policy (already enforced in code)

| Ad format           | Where shown                                   | Never shown                      |
|---------------------|-----------------------------------------------|----------------------------------|
| App Open            | App foreground resume                         | During live broadcast player     |
| Banner              | Library, channels, series, settings screens   | Player screen                    |
| Interstitial        | After VOD ends, before leaving player         | Live broadcast, background       |
| Rewarded            | Optional (e.g. unlock premium content)        | Live broadcast, background       |
| Rewarded Interstitial | Natural content breaks, post-sermon end     | Live broadcast, background       |
| Native (Banner proxy) | Feed between content cards               | Player screen                    |

Frequency caps (in-memory, per-session):

| Format               | Cooldown    | Max/session |
|----------------------|-------------|-------------|
| App Open             | 30 min      | —           |
| Interstitial         | 5 min       | 4           |
| Rewarded             | 15 min      | 3           |
| Rewarded Interstitial | 20 min     | 2           |

---

## Testing checklist before first production build

- [ ] App IDs created in AdMob console for both Android and iOS.
- [ ] All ad unit IDs created and filled in `eas.json` / EAS secrets.
- [ ] Test build run on a real device with test ad unit IDs — all formats load.
- [ ] Verify `EXPO_PUBLIC_ADMOB_ENABLED=true` is set in production env (or ads
      are enabled unconditionally by default — check `adConfig.ts` `ADS_ENABLED`).
- [ ] UMP consent form appears on first launch on a device with EU locale.
- [ ] No ads shown during live broadcast.
- [ ] App Open ad fires on app foreground after 30-min gap.
- [ ] ILRD `onPaid` logs appear in Sentry breadcrumbs for each paid impression.
- [ ] Programmatic Limited Ads setting matches AdMob console (no sensitive
      categories; COPPA flag off; max content rating = G for family audience).
