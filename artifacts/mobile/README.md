# `@workspace/mobile` — Temple TV Mobile App

The Temple TV mobile and mobile-web client, built on **Expo SDK 54** with
**React Native** and **expo-router**. Ships from a single codebase to:

- **iOS** (App Store) — `com.templetv.jctm`
- **Android** (Play Store) — `com.templetv.jctm`
- **Mobile Web** — `https://templetv.org.ng` (Expo's metro web bundle)

> Production web: `https://templetv.org.ng`

---

## 1. App tour

| Tab | Purpose |
|---|---|
| **Watch** | Live banner, recent sermons, categorized rows (Faith, Healing, Deliverance, Worship, Teachings, Special Programs) |
| **Library** | Full catalog — search, category filter, sort, favorites, history; offline downloads tab |
| **Radio** | Audio-only mode (1px hidden video), spinning disc, sleep timer, shuffle / loop |
| **Settings** | Preferences, notification toggles, data saver, history controls, account, support |

Other surfaces:

- **Player** — In-app YouTube via `react-native-youtube-iframe` (native) and
  the official IFrame Player API (web). Seek bar on every platform, auto-advance,
  cast button, audio-mode toggle.
- **MiniPlayer** — Persistent floating bar across all tabs.
- **NetworkBanner** — Themed offline indicator.
- **LiveBroadcastSupervisor** — Background hook that reacts to broadcast SSE.
- **LocalVideoPlayer** — In-house HLS / MP4 player used by the live hero and
  by `/player` for non-YouTube broadcasts (see §6.1).

---

## 2. Stack

| | |
|---|---|
| Runtime | Expo SDK 54, React Native 0.81 |
| Routing | `expo-router` (typed routes) |
| State | TanStack React Query + React Context (Player, Auth) |
| Storage | `@react-native-async-storage/async-storage` (preferences) + `expo-secure-store` (tokens) |
| Media | `react-native-youtube-iframe`, `expo-av`, `expo-video` |
| Notifications | `expo-notifications` (APNs + FCM) |
| Offline downloads | `expo-file-system` |
| Animations | `react-native-reanimated`, `lottie-react-native` |
| Web bundler | metro |

---

## 3. Source layout

```
artifacts/mobile/
├── app/                       ← expo-router file-system routes
│   ├── _layout.tsx            ← root: providers + ErrorBoundary → /api/client-errors
│   ├── (tabs)/_layout.tsx     ← tab bar
│   ├── (tabs)/index.tsx       ← Watch
│   ├── (tabs)/library.tsx     ← Library + Offline tab
│   ├── (tabs)/radio.tsx       ← Audio-only mode
│   ├── (tabs)/settings.tsx
│   ├── player.tsx             ← Full-screen player
│   └── auth/                  ← signup, login, password reset
│
├── components/
│   ├── YoutubePlayer.native.tsx   ← react-native-youtube-iframe wrapper
│   ├── YoutubePlayer.web.tsx      ← official IFrame Player API
│   ├── YoutubePlayer.tsx          ← fallback
│   ├── LocalVideoPlayer.tsx       ← in-house HLS / MP4 player (hls.js on web, native HLS on iOS)
│   ├── BroadcastInfoStrip.tsx     ← title + countdown above the live hero
│   ├── ErrorBoundary.tsx          ← wired to reportClientError
│   ├── ErrorFallback.tsx
│   ├── LiveBroadcastSupervisor.tsx
│   ├── MiniPlayer.tsx
│   ├── NowPlayingBar.tsx
│   ├── NetworkBanner.tsx
│   ├── SermonCard.tsx
│   └── ...
│
├── context/
│   ├── AuthContext.tsx        ← uses expo-secure-store for tokens
│   └── PlayerContext.tsx      ← queue, shuffle, loop, mini-player state
│
├── hooks/
│   ├── useYouTubeChannel.ts
│   ├── useNotificationPreferences.ts
│   ├── useDownloads.ts        ← offline downloads via expo-file-system
│   └── ...
│
├── lib/
│   ├── apiBase.ts             ← canonical EXPO_PUBLIC_API_URL resolver
│   ├── secureStorage.ts       ← thin expo-secure-store wrapper
│   ├── errorReporter.ts       ← POSTs to /api/client-errors
│   └── theme.ts
│
├── services/
│   ├── authApi.ts             ← signup/login + refresh-token coordination
│   ├── youtube.ts             ← channel videos, RSS fallback
│   ├── broadcast.ts           ← /api/broadcast/current
│   ├── notifications.native.ts ← Expo push token registration
│   └── notifications.ts       ← web stub
│
├── data/
│   └── sermons.ts             ← bundled offline metadata fallback
│
├── constants/
│   └── config.ts              ← STORAGE_KEYS, theme constants
│
├── app.config.ts              ← EAS build config (preferred over app.json)
├── app.json                   ← Expo Go fallback
├── eas.json                   ← build profiles
├── babel.config.js
├── metro.config.js
└── tsconfig.json
```

---

## 4. Local development

```bash
pnpm --filter @workspace/mobile run dev
```

This starts the Expo dev server. On Replit it auto-binds to
`$REPLIT_EXPO_DEV_DOMAIN` and serves the web build at the assigned port.

### Required env

```env
EXPO_PUBLIC_API_URL=http://localhost:8080      # canonical (set in eas.json profiles)
EXPO_PUBLIC_DOMAIN=localhost:8080              # optional fallback
```

### Open on a real device

1. Install **Expo Go** from the App Store / Play Store.
2. Run `pnpm --filter @workspace/mobile run dev`.
3. Scan the QR code printed in the terminal.

---

## 5. Authentication & secure storage

- Access + refresh JWTs are stored in **`expo-secure-store`** (Keychain on
  iOS, Keystore on Android, IndexedDB on web).
- A **one-time migration** in `AuthContext` moves any legacy token from
  `AsyncStorage` to SecureStore on first launch.
- A 401 on any protected endpoint triggers a single deduped refresh; if the
  refresh permanently fails, both tokens are wiped and the user is signed out.

---

## 6. In-app YouTube playback

| Platform | Component | Mechanism |
|---|---|---|
| iOS / Android | `YoutubePlayer.native.tsx` | `react-native-youtube-iframe` (WebView) |
| Web | `YoutubePlayer.web.tsx` | Official YouTube IFrame Player API |
| Smart TV (separate artifact) | `artifacts/tv/src/pages/Player.tsx` | `youtube-nocookie.com` embed |

There is **no** redirect to youtube.com on any client.

### 6.1 Live broadcast playback (HLS / MP4)

The live hero on the Watch tab and the full-screen `/player` route both render
**`LocalVideoPlayer.tsx`** when the broadcast item is locally streamed (HLS
playlist or direct MP4) rather than YouTube.

| Concern | Implementation |
|---|---|
| Web | `hls.js` v1.6.x for `.m3u8` ; native `<video>` for `.mp4 / .webm / .mov / .m4v / .ogg` ; URL-extension regex (not Content-Type) decides the path |
| Native | iOS uses native HLS via `expo-av`; the same component falls back to direct progressive playback for MP4 |
| Aspect | **Two-layer render** — a blurred, `cover`-fitted backdrop fills the box; the foreground video is `contain`-fitted so the broadcast frame is never cropped (parity with the TV `LiveBroadcastVideo`) |
| Sync | The hero passes `broadcastMode="live"` and `startPositionMs` (`positionSecs * 1000 + networkDriftSecs`) computed against `serverTimeMs` from `/api/broadcast/current`, so the player joins at the exact second currently airing on every other client |
| Drift correction | A 12-second tick in `app/(tabs)/index.tsx` compares the playhead to the expected live offset and `setPositionAsync`s back into lock-step when drift exceeds 4 s, clamped to `[0, durationSecs - 0.5]` |
| Stability | Sync data and callbacks are held in `useRef`s so React re-renders don't tear down the video element |

The `seekToStart()` helper inside `LocalVideoPlayer.tsx` honours
`startPositionMs` on **every** code path (HLS, native HLS, direct progressive),
so MP4 broadcasts join at the correct offset just like HLS ones.

---

## 7. Push notifications

- **Token registration** — On launch, `notifications.native.ts` requests a
  permission, fetches the Expo push token, and POSTs it to
  `/api/push-tokens` (upsert).
- **Send** — Admins use `POST /api/admin/notifications/send`; the API server
  fans out via the Expo Push API in chunks of 100.
- **Deep links** — Live alerts → Watch tab; sermon alerts → Library tab.
- **Local toggles** — Stored in AsyncStorage via `useNotificationPreferences`.

---

## 8. Crash & error reporting

The root `ErrorBoundary` in `app/_layout.tsx` calls `reportClientError(...)`
which POSTs a Zod-validated payload to `/api/client-errors`. The server logs it
structured via pino and (optionally) forwards to a configured sink such as
Logtail, Datadog, or Sentry.

For full source-map symbolication in production, install
`@sentry/react-native` — it complements the first-party endpoint.

---

## 9. Building for production

EAS profiles in `eas.json`:

| Profile | Output |
|---|---|
| `development` | Dev client; iOS simulator + Android APK |
| `preview` | Internal distribution APK + IPA |
| `production` | Auto-incremented Android App Bundle + iOS archive |

```bash
cd artifacts/mobile
eas login
eas build --platform ios --profile production
eas submit --platform ios --latest
eas build --platform android --profile production
eas submit --platform android --latest
```

App Store / Play Store metadata is **not** in this repository — see
[`RELEASE_AUDIT.md`](../../RELEASE_AUDIT.md) §5.3 / §5.4 for the full
submission checklist.

---

## 10. Related

- [`@workspace/api-server`](../api-server/README.md)
- Project [README](../../README.md)
- Audit report [`RELEASE_AUDIT.md`](../../RELEASE_AUDIT.md)
