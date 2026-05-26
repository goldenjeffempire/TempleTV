# `@workspace/mobile` — Temple TV Mobile App

Expo SDK 54 + React Native 0.81 app shipping from a single codebase to iOS, Android, Android TV, Apple TV, and Fire TV. Live broadcast, sermon-on-demand, radio, push notifications, offline favorites, and cross-device sync.

> Production: `https://templetv.org.ng` (web bundle) · App Store · Play Store

---

## Platforms & build profiles

| Platform | Profile (`eas.json`) | Output |
|----------|---------------------|--------|
| iOS (App Store) | `production` | Auto-incremented IPA |
| Android (Play Store) | `production` | App Bundle (.aab) |
| Android TV | `androidtv` | APK / AAB |
| Apple TV | `appletv` | tvOS IPA |
| Fire TV | `firetv` | APK |
| Internal testing | `preview` | IPA + APK |
| Dev client | `development` | Dev client (iOS sim + Android) |

---

## App tour

| Tab | Route | Purpose |
|-----|-------|---------|
| Watch | `(tabs)/index.tsx` | Live hero (v2 player), recent sermons, categorized rows |
| Library | `(tabs)/library.tsx` | Full catalog — search, filter, sort, favorites, history |
| Radio | `(tabs)/radio.tsx` | Audio-only mode with spinning disc + sleep timer |
| Settings | `(tabs)/settings.tsx` | Preferences, notifications, account, support |

Other surfaces: full-screen `/player`, auth screens (`/auth/*`), device-link pairing (`/link`).

---

## Player architecture (v2)

The mobile player uses **`V2PlayerContainer`** — two persistent `expo-av <Video>` buffers driven by the `PlayerMachine` A/B-buffer FSM from `@workspace/player-core`.

```
V2Transport (pure WS — no EventSource on RN)
        │
        ▼
PlayerMachine (lib/player-core/src/machine.ts)
        │
        ▼
V2PlayerContainer (artifacts/mobile/components/V2PlayerContainer.tsx)
        │
        ├── BroadcastBuffer A  (expo-av <Video>)
        └── BroadcastBuffer B  (expo-av <Video>)
```

Key behaviours:
- **A/B swap** — inactive buffer preloads the next item; swap is atomic (no black frame)
- **Live vs VOD HLS detection** — `durationMillis === null/Infinity` from `onLoad` → live edge (`playAsync()`); finite → VOD (`playFromPositionAsync(min(positionMs, actualMs - 2000))`)
- **Quick-finish guard** — `didJustFinish` within 5 s of play start → retry from position 0 (up to 2 retries) before escalating to `buffer-ended`
- **Live-sync interval** — `playAsync()` every 30 s on active live HLS buffers to re-latch to the live edge
- **Clock calibration** — `V2Transport.onClockCalibration` wires server-client offset to `PlayerMachine.setClockOffsetMs()` so position calculations use server time instead of the (potentially skewed) device OS clock

---

## Source layout

```
artifacts/mobile/
├── app/                            ← expo-router file-system routes
│   ├── _layout.tsx                 ← providers: Auth, Player, Network, Query
│   ├── (tabs)/_layout.tsx          ← tab bar
│   ├── (tabs)/index.tsx            ← Watch tab
│   ├── (tabs)/library.tsx
│   ├── (tabs)/radio.tsx
│   ├── (tabs)/settings.tsx
│   ├── player.tsx                  ← full-screen player
│   └── auth/                       ← login, signup, password reset
│
├── components/
│   ├── V2PlayerContainer.tsx       ← v2 A/B-buffer player (expo-av)
│   ├── V2PlayerContainer.web.tsx   ← web shim
│   ├── YoutubePlayer.native.tsx    ← react-native-youtube-iframe wrapper
│   ├── YoutubePlayer.web.tsx       ← YouTube IFrame Player API
│   ├── MiniPlayer.tsx              ← persistent floating player bar
│   ├── NetworkBanner.tsx           ← offline indicator
│   └── ...
│
├── context/
│   ├── AuthContext.tsx             ← JWT + expo-secure-store
│   ├── PlayerContext.tsx           ← queue, shuffle, loop, mini-player state
│   └── NetworkContext.tsx          ← online/offline detection
│
├── hooks/
│   ├── useV2BroadcastNative.ts     ← v2 WS transport hook (pure WS, no EventSource)
│   ├── useNotificationPreferences.ts
│   └── ...
│
├── services/
│   ├── authApi.ts                  ← signup/login + refresh-token coordination
│   ├── broadcast.ts                ← /api/broadcast/current
│   └── notifications.native.ts     ← Expo push token registration
│
├── app.config.ts                   ← EAS build config
├── eas.json                        ← build profiles
├── metro.config.js
└── tsconfig.json
```

---

## Development

```bash
# Start Expo bundler
pnpm --filter @workspace/mobile run dev

# Type-check
pnpm --filter @workspace/mobile run typecheck

# Android device/emulator
pnpm --filter @workspace/mobile run android

# iOS simulator
pnpm --filter @workspace/mobile run ios
```

On Replit the dev server binds to `$REPLIT_EXPO_DEV_DOMAIN` and serves the web bundle at port 18115. Scan the QR code with Expo Go to open on a real device.

The app cannot be previewed in the browser iframe — use Expo Go, a simulator, or a device build.

### Environment variables (set automatically on Replit)

| Variable | Purpose |
|----------|---------|
| `EXPO_PUBLIC_API_URL` | Canonical API base URL |
| `EXPO_PUBLIC_DOMAIN` | Fallback API host |
| `EXPO_PUBLIC_REPL_ID` | Replit REPL ID (used for dev routing) |

---

## Authentication & storage

- Access + refresh JWTs stored in **`expo-secure-store`** (Keychain on iOS, Keystore on Android, IndexedDB on web)
- A one-time migration moves any legacy `AsyncStorage` tokens to SecureStore on first launch
- 401 on any protected request triggers a single deduplicated refresh; permanent failure wipes both tokens and signs the user out

---

## Push notifications

- Token registration: on launch, `expo-notifications` requests permission, fetches the Expo push token, POSTs to `/api/v1/notifications/push-token`
- Fan-out: admins trigger from the dashboard; API fans out via Expo Push API in batches of 100
- Deep links: live alerts → Watch tab; sermon alerts → Library

---

## EAS builds

```bash
# Build for iOS production
pnpm run mobile:eas:build -- --platform ios --profile production

# Build for Android production
pnpm run mobile:eas:build -- --platform android --profile production

# Submit latest build
eas submit --platform ios --latest
eas submit --platform android --latest
```

OTA updates (`expo-updates`) push JS-only changes automatically on `main` branch pushes via `ota-update.yml` GitHub Action — no store review required.

---

## Related

- [`@workspace/api-server`](../api-server/README.md)
- [`@workspace/player-core`](../../lib/player-core/README.md)
- [`@workspace/api-client-react`](../../lib/api-client-react/README.md)
- [`RELEASE_PIPELINE.md`](../../RELEASE_PIPELINE.md)
- Project [README](../../README.md)
