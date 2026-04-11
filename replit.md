# Temple TV (JCTM) Broadcasting Platform

## Overview

A mobile broadcasting platform for Temple TV (JCTM) built with Expo/React Native. Features Live TV, Video-on-Demand sermon library, 24/7 Radio mode, push notifications, and a continuous streaming engine. Production-ready with EAS build config, full dark mode, and notification deep-linking.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Mobile**: Expo (React Native) with expo-router
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **In-app player**: react-native-youtube-iframe (native only)
- **Notifications**: expo-notifications (push tokens + local notifications)
- **Keyboard**: react-native-keyboard-controller v1.18.5 (pinned to expo-compatible version)

## App Structure

### Mobile App (`artifacts/mobile`)
- **Watch Tab** — Live stream banner, recent sermons, categorized sections (Faith, Healing, Deliverance, Worship, Teachings, Special Programs)
- **Library Tab** — Full sermon library with search, category filter, sort (Newest/Oldest/Popular), favorites, watch history; FlatList with keyboard dismiss + performance tuning
- **Radio Tab** — Audio-only mode with disc animation, shuffle/loop controls, category filter, up-next queue
- **Settings Tab** — Playback settings, shuffle/loop, Live Alerts + New Sermon Alerts (persisted to AsyncStorage), data saver, history management, Share app, Contact support

### Player Screen
- In-app YouTube video player (react-native-youtube-iframe on iOS/Android, external browser on web)
- Seek bar shown on **all** platforms (not just web)
- Auto-advance to next related sermon when current video ends
- "Up Next" banner with quick-play button
- Favorites, share, watch history tracking
- Related sermons list

### MiniPlayer
- Floating persistent mini-player across all tabs
- Tappable — navigates to full player screen
- Play/pause control without leaving current tab
- BlurView tint adapts to dark/light mode

### Services
- **YouTube** (`services/youtube.ts`) — Live status, embed URLs, RSS feed
- **Notifications** (`services/notifications.native.ts`) — Push token registration (APNs/FCM), Android notification channel setup, local notifications for live alerts and new sermons; web-safe stub in `notifications.ts`

### Context
- **PlayerContext** — Queue management, shuffle mode, loop mode (none/one/all), play/pause/next/previous, data saver

### Hooks
- `useNotificationPreferences` — Persists live/sermon notification preferences to AsyncStorage
- `useYouTubeChannel` — Fetches + caches YouTube channel videos; exposes `error` state

### Design System
- **Full dark mode**: `userInterfaceStyle: "automatic"` (iOS + Android); dark palette `#0D0014` background, `#F0E6FF` text, `#9B30FF` primary
- Glassmorphism-style UI with theme-aware glass backgrounds (GlassCard, MiniPlayer, NetworkBanner)
- Loop icons: `minus-circle` (none) / `repeat` (all) / `rotate-cw` (one) — consistent in player + radio
- SermonCard wrapped in `React.memo` for scroll performance

## Content Categories
Faith, Healing, Deliverance, Worship, Prophecy, Teachings, Special Programs

## Key Features Implemented
1. **In-app video player** — react-native-youtube-iframe with play/pause/fullscreen/quality
2. **Seek bar on all platforms** — not restricted to web
3. **Continuous Streaming Engine** — Zero dead-air auto-advance
4. **Push notifications** — Push token registration on app launch; Android notification channel; deep-link tap handling (live → Watch tab, sermon → Library tab)
5. **Persisted notification preferences** — Saved to AsyncStorage via `useNotificationPreferences`
6. **Full dark mode** — True dark palette, dynamic BlurView tints, theme-aware GlassCard
7. **Sermon Library** — Search, category filter, sort by newest/oldest/popular (date tiebreaker for RSS sermons without view counts)
8. **Radio Mode** — Background audio, category filter, shuffle/loop with proper animation lifecycle
9. **User personalization** — Favorites, watch history, notification prefs (all AsyncStorage)
10. **NetworkBanner** — Amber-themed offline indicator with themed colors
11. **EAS build config** (`eas.json`) — development/preview/production build profiles
12. **Category deep-link navigation** — "See all" buttons on Watch tab navigate to Library with category pre-selected via URL param (`/library?category=Faith`)
13. **TypeScript strict compliance** — zero errors; web notification stub exports all native functions as no-ops

## App Store Configuration (`app.json`)
- **iOS bundle ID**: `com.templetv.jctm`
- **Android package**: `com.templetv.jctm`
- **URL scheme**: `templetv`
- **userInterfaceStyle**: `automatic` (both iOS and Android)
- **iOS background modes**: audio, fetch, remote-notification
- **Android permissions**: POST_NOTIFICATIONS, INTERNET, FOREGROUND_SERVICE, WAKE_LOCK
- **Notification**: purple (#6A0DAD) with androidMode: collapse
- **supportsTablet**: true

## EAS Build (`eas.json`)
- `development` — dev client, iOS simulator, Android APK
- `preview` — internal distribution APK/IPA
- `production` — autoIncrement, Android App Bundle, iOS archive

## Running Services (Workflows)
- **Start application** — Expo dev server on port 18115 (mobile app)
- **API Server** — Express API server on port 8080 (YouTube RSS proxy for web; falls back to RSS when YouTube quota is exceeded via `fetchVideosFromRss()`)
- **Admin Dashboard** — Vite dev server on port 5173 at `/admin/` (React admin panel for content management)

## Bug Fixes Applied (Session 2)
- **Channel ID fix**: `JCTM_CHANNEL_ID` in `data/sermons.ts` corrected to `UCPFFvkE-KGpR37qJgvYriJg` everywhere (was wrong before)
- **API server `/videos` route**: Added `fetchVideosFromRss()` fallback so it returns 200 + RSS data when YouTube quota exceeded (was returning 502)
- **`useYouTubeChannel` rewrite**: On web, tries API server first, then falls directly to YouTube RSS. On native, goes directly to RSS without going through server.
- **`services/youtube.ts`**: `checkLiveStatus` now uses API server on web for better live detection reliability
- **`app/_layout.tsx`**: Added `expo-av` audio session setup (`staysActiveInBackground: true`, `playsInSilentModeIOS: true`) for iOS background audio
- **`app.json`**: Added `expo-av` plugin, complete `infoPlist` with `AVAudioSessionCategory`, `ITSAppUsesNonExemptEncryption: false`, and removed arbitrary loads
- **`eas.json`**: Added `appVersionSource: local`, iOS/Android submit config with categories (Entertainment, Education)
- **`player.tsx`**: Moved `pointerEvents` from deprecated prop to `style` to eliminate RN 0.81 warning
- **`YoutubePlayer.native.tsx`**: Moved `pointerEvents` to `style` on `Animated.View`

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `eas build --profile production` — trigger production EAS build

## Architecture Notes

### RSS Data Flow
- **Native (iOS/Android)**: Fetches YouTube RSS directly from `https://www.youtube.com/feeds/videos.xml?channel_id=...`
- **Web**: Proxies through API server at `/api/youtube/rss` to avoid CORS; tries `/api/youtube/videos` (YouTube Data API v3) first
- **Fallback**: Local `data/sermons.ts` fallback if RSS or network fails
- **Cache**: AsyncStorage caches RSS results for 10 minutes
- **Error indicator**: Amber dot in Watch tab header when using fallback data

### Category Auto-Detection
RSS videos are auto-categorized using keyword matching in `hooks/useYouTubeChannel.ts`. 70+ keywords across 7 categories: grace, salvation, baptism, prayer, fasting, anointing, holy spirit, gospel, kingdom, revival, conference, and many more.

### Popular Sort
When view counts are unavailable (RSS-only sermons), popular sort falls back to date descending as a proxy for popularity.

### Notification Deep Linking
Root layout (`app/_layout.tsx`) registers a `addNotificationResponseReceivedListener` on native. Tap on a `live_service` notification → Watch tab; `new_sermon` → Library tab.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
