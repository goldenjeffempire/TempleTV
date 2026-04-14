# Temple TV (JCTM) Broadcasting Platform

## Overview

A full-stack broadcasting platform for Temple TV (JCTM). Features a cross-platform mobile app (Expo/React Native), a web admin dashboard (React/Vite), and a Node.js/Express API backend. Includes Live TV, Video-on-Demand sermon library, 24/7 Radio mode, push notifications, offline video downloads, and a continuous adaptive streaming engine.

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
- **PlayerContext** — Queue management, shuffle mode, loop mode (none/one/all), play/pause/next/previous, persisted data saver/radio/shuffle/loop/volume settings

### Hooks
- `useNotificationPreferences` — Persists live/sermon notification preferences to AsyncStorage
- `useYouTubeChannel` — Fetches + caches YouTube channel videos; exposes `error` state

### Design System
- **Light-first auto theme**: Mobile and admin default to light theme; automatic midnight theme activates from 8:00 PM to 5:59 AM using the device/browser local time zone
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
14. **Offline Video Downloads** — `useDownloads` hook uses `expo-file-system` to download locally-uploaded videos to device storage; download progress indicator on library cards; "Offline" tab in Library shows all downloaded videos; delete button to free storage; downloaded videos play from local path when offline
15. **Cast to TV** — "Cast" button in player: opens YouTube native app (Chromecast-ready) or browser for YouTube videos; AirPlay supported natively on iOS via expo-av for local HLS videos through system media controls

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
- **Temple TV** — Expo dev server on port 18115 at `/mobile/` (mobile app)
- **API Server** — Express API server on port 8080 at `/api` (YouTube RSS proxy for web; falls back to RSS when YouTube quota is exceeded via `fetchVideosFromRss()`)
- **Temple TV Admin** — Vite dev server on port 23744 at `/admin/` (React admin panel for content management)

## Replit Migration Notes
- Dependencies are installed with pnpm from the existing lockfile; the monorepo structure is preserved.
- Replit-native app runners are used for the mobile app, API server, and admin dashboard; duplicate legacy imported runners were removed to avoid route and port conflicts.
- Development PostgreSQL is provisioned and the existing Drizzle schema has been applied with `pnpm --filter @workspace/db run push`.
- Mobile web rendering requires root layout containers to fill the viewport (`SafeAreaProvider` and `GestureHandlerRootView` use `flex: 1`).
- The Expo config keeps `react-native-track-player` as a runtime dependency but does not list it as an Expo config plugin, because the package does not provide a valid plugin entry point.
- Mobile preview dependency compatibility was aligned for Expo SDK 54: `expo-file-system` uses the SDK-compatible 19.x line and `shaka-player` satisfies the web shim used by `react-native-track-player`.
- Verified Replit preview routes: `/api/healthz`, `/admin/`, `/mobile/`, and Expo `/status` all return HTTP 200 with the registered API, admin, and mobile runners active.

## Features Added (Session 3)
- **Videos page**: Fixed missing `Video` icon import (empty state crash), added "Edit Details" dialog for updating title, category, preacher, featured status per video
- **Playlists DnD**: Installed `@dnd-kit/core` + `@dnd-kit/sortable`; playlist videos are now drag-and-drop reorderable
- **Add Video to Playlist**: Changed from YouTube URL input to searchable library picker — selects videos already imported in the DB
- **Push Tokens DB**: Added `push_tokens` table (id, token, platform, created_at, last_seen_at) for storing device tokens from the mobile app
- **Real Push Notifications**: `POST /api/admin/notifications/send` now sends via Expo Push API (`https://exp.host/--/api/v2/push/send`) to all registered devices; `sentCount` tracks successful deliveries
- **Push Token Registration API**: `POST /api/push-tokens` endpoint — mobile devices register on launch (upserts on conflict)
- **Mobile Push Token**: `notifications.native.ts` now calls `/api/push-tokens` after getting the Expo push token on app launch
- **View Tracking**: `POST /api/videos/:youtubeId/view` increments `view_count`; mobile player calls it when a video starts
- **Analytics**: `uniqueViewers` now uses registered device count; daily views uses notification history instead of random data
- **Dashboard**: "Notifications Today" stat card now shows registered device count as subtext

## Broadcast Streaming Fixes (Session 8)
- **Broadcast auto-advance**: `player.tsx` now accepts `broadcastMode=true` URL param; on video end, calls `checkBroadcastCurrent()` and replaces route with the next broadcast item at correct position instead of advancing the library queue
- **YouTube position sync**: `startPositionSecs` prop now passed to `YoutubePlayer` from `paramStartPositionMs` (converted from ms→secs) so broadcast viewers join at the correct live position
- **Broadcast re-sync interval**: `player.tsx` sets a 60-second interval in broadcast mode; if the current video differs from what the server says should be playing, it navigates to the correct video at the correct offset
- **Duration auto-detection (upload)**: Admin video upload now detects video duration client-side via the HTML5 `loadedmetadata` event and sends `durationSecs` as a form field
- **Duration stored on upload**: API upload handler reads `durationSecs` field and stores it in the `duration` column instead of always defaulting to empty string
- **Duration auto-detection (broadcast queue)**: `POST /api/admin/broadcast` now looks up video duration from the DB when `durationSecs` is missing/zero, so broadcast items get accurate durations instead of always defaulting to 1800s
- **`parseDurationSecs` enhancement**: Now handles plain-seconds strings (stored by upload handler) in addition to `H:MM:SS` and `Xm` formats
- **`handleBroadcastPress` fix**: Watch tab now passes `broadcastMode: "true"` and `startPositionMs` for both local and YouTube broadcast items

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
- **Offline metadata**: The app keeps stale sermon metadata as an offline fallback and exposes refresh/clear controls in Settings
- **Error indicator**: Amber dot in Watch tab header when using fallback data

### Category Auto-Detection
RSS videos are auto-categorized using keyword matching in `hooks/useYouTubeChannel.ts`. 70+ keywords across 7 categories: grace, salvation, baptism, prayer, fasting, anointing, holy spirit, gospel, kingdom, revival, conference, and many more.

### Popular Sort
When view counts are unavailable (RSS-only sermons), popular sort falls back to date descending as a proxy for popularity.

### Notification Deep Linking
Root layout (`app/_layout.tsx`) registers a `addNotificationResponseReceivedListener` on native. Tap on a `live_service` notification → Watch tab; `new_sermon` → Library tab.

## Features Added (Session 4)
- **Persistent playback settings**: Radio mode, data saver, shuffle, loop and volume are stored locally and restored on launch.
- **Offline sermon metadata hardening**: YouTube/RSS sermon metadata now falls back to stale AsyncStorage cache when the network is unavailable; Settings shows cache count/age with refresh and clear controls.
- **Data saver behavior**: YouTube playback requests lower quality in data saver/radio mode, local playback reduces progress update frequency, and UI badges show the active low-data/audio mode.
- **Player failover**: YouTube player retries transient playback errors before showing the external YouTube handoff fallback.
- **Cast/AirPlay handoff**: Player screen includes a cast button that opens the YouTube app/browser so users can use YouTube’s Chromecast/AirPlay device picker without adding native-only SDKs.
- **Broadcast engine metadata**: `/api/broadcast/current` now returns `nextItem`, progress percent, sync timestamp, and explicit failover reasons for empty/invalid queues.
- **Schedule-driven broadcast override**: Active schedule slots now drive the public broadcast endpoint. Live slots interrupt the app into the live player; playlist/video slots temporarily replace the 24/7 queue using the same epoch-synced engine.

## Features Added (Session 5)
- **Light platform theme**: Mobile app and admin dashboard now default to a light theme instead of following the device/system dark mode.
- **Auto midnight theme**: Mobile and admin automatically switch to the midnight palette from 8:00 PM through 5:59 AM based on the current device/browser local time zone.
- **Theme visibility**: Admin header shows whether the platform is currently using Light Theme or Auto Midnight and displays the active local time zone.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Features Added (Session 7)
- **True audio-only radio mode**: When Radio Mode is toggled on, the YouTube player shrinks to 1px height (hidden) while audio continues streaming — no video frames rendered, saving GPU, CPU, and data
- **Audio card overlay**: In audio mode, the player screen shows a spinning disc with album art, pulsing wave visualizer, "Audio Mode" badge, and a "Switch to Video" button
- **Video ↔ Audio toggle button**: A headphones/video icon button appears in the player screen's top bar (native only) for seamless switching between full video and audio-only mode without stopping playback
- **Works for both live and VOD**: The hidden player handles live broadcasts and uploaded sermons equally — Radio Mode works regardless of what's currently broadcasting
- **"Watch Video" from Radio tab**: A "Watch Video" button appears in the Radio tab when a sermon is playing, navigating to the full player and disabling Radio Mode for immediate video viewing
- **Low data optimized**: Audio mode forces `suggestedQuality: "small"` on the YouTube player, minimizing bandwidth consumption
- **Library.tsx playlistItemRow fix**: Added missing `playlistItemRow` style that was causing a TypeScript error

## Features Added (Session 9) — Production-Grade Video Pipeline
- **FFmpeg HLS transcoding queue**: Uploaded local videos are automatically queued for transcoding into three quality variants (1080p/720p/480p) using FFmpeg with libx264 + AAC, 6-second HLS segments
- **Adaptive bitrate streaming (ABR)**: A master HLS playlist (`master.m3u8`) is generated per video; the mobile player automatically selects quality based on network conditions via `expo-av`'s native HLS stack
- **`transcoding_jobs` DB table**: Persistent queue backed by PostgreSQL with status (queued/processing/done/failed/cancelled), priority, progress %, error messages, and timestamps
- **Transcoding worker**: In-process async worker picks the highest-priority queued job, processes each quality variant sequentially, and reports per-profile progress (0–100%) back to the DB
- **Startup recovery**: On server boot, any stuck `processing` jobs are reset to `queued` so crashed jobs auto-resume — no manual intervention needed
- **HLS static serving**: API serves HLS playlists and .ts segments via `/api/hls/:videoId/master.m3u8` with correct MIME types and CORS headers for cross-origin player use
- **Admin Transcoding Queue page**: New `/transcoding` admin page shows live stats (Processing/Queued/Completed/Failed), real-time job list grouped by status, progress bars for active jobs, one-click Retry for failed jobs, cancel for queued jobs
- **Transcoding status on Video Library**: Local uploads show contextual inline badges — `Encoding…`, `In queue`, `HLS Ready`, or `Encode failed` — with an "ABR" badge in the mobile player when streaming via HLS
- **Re-encode option**: Video card dropdown menu includes "Re-encode (HLS)" for any local video that failed or has no HLS yet, allowing priority re-queuing
- **Mobile HLS integration**: `LocalVideoPlayer` accepts `hlsMasterUrl` prop and prefers it over the raw upload URL; broadcasts and navigation routes pass the HLS URL through all navigation params

## Features Added (Session 10) — Caching, Docker & Production Infrastructure
- **Redis-ready dual-layer cache** (`api-server/src/lib/cache.ts`): Dual-layer caching — uses Redis when `REDIS_URL` env var is set, falls back transparently to in-memory (TTL + GC). `getOrSet` pattern avoids redundant fetches. Added `status()` method for health inspection.
- **Broadcast route caching**: `/broadcast/current` and `/broadcast/guide` now cache DB queries for live overrides (5s TTL), schedule entries (30s TTL), and the broadcast queue (10s TTL). All write routes (POST/PATCH/DELETE broadcast queue, reorder) call `invalidateBroadcastCache()` immediately, so admin changes surface within one cycle.
- **Cache health endpoint**: `GET /api/cache/status` returns Redis configured/connected state and memory cache status.
- **Offline video downloads**: `useDownloads` hook (`hooks/useDownloads.ts`) uses `expo-file-system` for download/pause/resume/delete with progress tracking; Library tab's "Offline" tab shows all downloaded videos; only local-uploaded (non-YouTube) videos are downloadable.
- **Docker containerization**: Added `artifacts/api-server/Dockerfile` (multi-stage: deps → builder → production runner), `artifacts/admin/Dockerfile` (multi-stage: deps → builder → nginx static server), `artifacts/admin/nginx.conf` (path-based routing for `/admin/`), and `docker-compose.yml` orchestrating the API, Admin, PostgreSQL 16, and Redis 7 services with health checks, volume persistence, and correct dependency ordering.

## Features Added (Session 6)
- **Admin schedule targeting**: Schedule entries for playlist/video content now include selectors for imported playlists and videos so scheduled programming points to real content.
- **App-wide live interrupt**: Mobile now polls for YouTube live status and scheduled live slots globally, not only on the Watch tab, and opens the live player when a service begins.
- **App Store permission cleanup**: Removed unused iOS microphone/camera/photo/tracking usage descriptions from `app.json`; retained background audio, fetch, remote notification, and encryption declaration.

## Features Added (Session 11) — Operational Security & Observability
- **API security middleware**: Added request IDs, secure response headers, per-IP/per-path rate limiting, and stricter JSON/body size limits.
- **Admin API protection**: `/api/admin/*` routes now require `ADMIN_API_TOKEN` in production, with timing-safe token comparison and support for bearer headers, `X-Admin-Token`, and SSE query token transport.
- **Admin access key UI**: Admin dashboard header now shows whether an admin key is configured and lets operators set/remove the key locally; protected admin fetches and live SSE connections automatically include it.
- **Production metrics**: Added `GET /api/metrics` with Prometheus-compatible uptime, active request, request count, error count, and latency sum metrics.
