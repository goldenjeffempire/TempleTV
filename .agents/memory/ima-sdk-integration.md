---
name: IMA SDK integration — TV + Mobile
description: Google IMA HTML5 SDK (TV web) and react-native-google-mobile-ads (Mobile) integration patterns, key decisions, and config locations.
---

# Google IMA / GAM Ad Integration

## TV Web App (artifacts/tv)

**SDK loading**: `https://imasdk.googleapis.com/js/sdkloader/ima3.js` loaded via synchronous `<script>` tag in `index.html` (before the app module). IMA is injected into the global `google.ima` namespace.

**Type declarations**: `artifacts/tv/src/types/google-ima.d.ts` — minimal ambient namespace covering only the API surface used. Do NOT add `@types/google.ima` as a dep — it collides with `@types/google.maps` ambient namespace.

**Env configuration**: `VITE_IMA_AD_TAG_URL` — set to a GAM VMAP URL to enable ads. Leave unset → AdManager becomes a complete no-op. Type is declared in `artifacts/tv/src/vite-env.d.ts`.

**Architecture**: `artifacts/tv/src/lib/adManager.ts` (AdManager class) + `artifacts/tv/src/hooks/useAdManager.ts` (React hook) + `adContainerRef` div in `LiveBroadcastV2.tsx`.

**Key decisions**:
- Uses VMAP (not individual VAST tags) so GAM controls preroll/midroll schedule server-side.
- Mutes/unmutes live HLS buffers during ad breaks rather than pausing — preserves broadcast FSM state.
- VPAID is disabled (`VpaidMode.DISABLED`) — Smart TV environments don't support VPAID.
- 30-minute localStorage frequency cap prevents re-requests on accidental remounts.
- Ad container at zIndex 28 (above stall spinner=22, progress bar=25).
- Only runs in `variant="player"`, never in `variant="hero"` (ambient background).
- Ad request fires on first PLAYING FSM state (ensures stream is live before preroll).

**Why VMAP**: VMAP lets GAM define the exact break points (preroll + midroll intervals) without any client-side timer logic. This keeps the client code simple and gives ad ops full control.

## Mobile App (artifacts/mobile)

**Package**: `react-native-google-mobile-ads@14.11.0` (installed July 2026).

**Config**: `app.json` — `react-native-google-mobile-ads` plugin entry with test app IDs. Replace android/ios app IDs with real GAM app IDs before production release.
- Test Android app ID: `ca-app-pub-3940256099942544~3347511713`
- Test iOS app ID: `ca-app-pub-3940256099942544~1458002511`
- `delay_app_measurement_init: true` — waits for UMP consent before attributing events (GDPR compliance).

**Initialization**: `setupMobileAds()` in `artifacts/mobile/app/_layout.tsx` — called fire-and-forget alongside `setupAudioSession()` after fonts load. Must be called before any ad is loaded.

**Hook**: `artifacts/mobile/hooks/useInterstitialAd.ts` — `useBroadcastInterstitialAd()` hook.

**Integration**: Called in `V2PlayerContainer.tsx` after `isYouTubeOverride` and `activeBufferId` are determined.

**Key decisions**:
- Uses GAM interstitials (not AdMob banners) — full-screen overlay at natural broadcast breaks.
- Shows on: (1) first PLAYING FSM state, (2) `activeBufferId` swap (new queue item).
- Suppressed when: YouTube override active, non-PLAYING states, `minimal=true`, `suppressEvents=true`.
- 30-minute module-level frequency cap (resets on app restart).
- **Critical**: Use `TestIds.GAM_INTERSTITIAL` in dev, NOT `TestIds.INTERSTITIAL` — the latter is an empty string for GAM and will fail silently.
- `delay_app_measurement_init: true` in app.json config is required alongside this.

**Ad unit IDs**: Production ad unit IDs go in `EXPO_PUBLIC_GAM_INTERSTITIAL_AD_UNIT_ID` (Expo public env var). No default — ads simply don't load if unset.

## Setup checklist for going live

1. Create GAM account → Network → New app → get android/ios app IDs.
2. Replace test app IDs in `artifacts/mobile/app.json` with real production IDs.
3. Create Interstitial ad unit in GAM → copy ad unit ID → set `EXPO_PUBLIC_GAM_INTERSTITIAL_AD_UNIT_ID` secret.
4. Create VMAP ad tag in GAM with preroll + midrolls → copy URL → set `VITE_IMA_AD_TAG_URL` secret.
5. Add UMP consent form in GAM (Tools → User Messaging Platform) for GDPR compliance.
6. EAS build required for native changes (app.json plugin + react-native-google-mobile-ads).
