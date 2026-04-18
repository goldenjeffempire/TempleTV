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
- Mobile Expo dev CORS is configured to allow the Replit preview origin, preventing blocked source-map/runtime requests in the `/mobile/` preview.

## Features Added (Current Session) — Real-Time Broadcast Control Foundation
- **Public broadcast event stream**: Added `/api/broadcast/events` so clients can subscribe to current broadcast changes without waiting for polling.
- **Unified broadcast state payload**: Refactored `/api/broadcast/current` into a shared server-side state builder used by both HTTP and event-stream responses.
- **Instant queue/control events**: Broadcast queue add/update/delete/reorder, schedule create/update/delete, and live start/stop/extend now publish real-time update events.
- **Mobile real-time sync**: Watch screen, player screen, and live supervisor subscribe to broadcast events when the runtime supports EventSource, with existing polling retained as fallback.
- **Broadcast-model playback hardening**: Player controls and seek/progress controls are hidden during broadcast mode so channel playback behaves like TV rather than on-demand video.
- **Admin control refresh**: Broadcast Control listens for queue, schedule, current-state, and live-control events to refresh the control room immediately.
- **Live/failover state propagation**: Live override start/stop/extend/expiry, schedule changes, broadcast queue video changes, and YouTube live status changes now also emit a full current-broadcast snapshot.
- **Admin realtime status**: Broadcast Control shows the real-time connection state and the last received update timestamp in the page header.

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

## Features Added (Session 14–16) — Production Video Pipeline

### Upload Engine
- **8 MB chunk size**: Down from 32 MB for better mobile compatibility and GCS limits
- **Adaptive parallel streams per file** (up to 6): Engine scales concurrency based on measured link speed
- **5 simultaneous file uploads**: Entire batch ingest runs in parallel — drop 5 sermons at once
- **Prefetch pipeline**: Chunks N+1…N+6 are read from disk and SHA-256 hashed BEFORE their upload slot opens
- **Render throttle (80ms)**: React re-renders capped at ~12 fps; internal state always current
- **SHA-256 checksum verification**: Every chunk hashed client-side + verified server-side via Web Crypto API
- **Debounced session persistence**: Session metadata written at most once per 4 seconds
- **Per-file pause/resume/cancel/retry**: Fully independent; resume skips already-uploaded chunks
- **Session recovery**: localStorage + server-side recovery survives browser refresh mid-upload
- **UPLOAD_SESSION_KEY = v4**: Invalidates old sessions after chunk size change

### Client-side H.264 Compression (`artifacts/admin/src/lib/videoCompressor.ts`)
- **WebCodecs pipeline**: mp4box.js demux → VideoDecoder → OffscreenCanvas scale → VideoEncoder (H.264 avc1.4d401f) + AudioDecoder → AudioEncoder (AAC) → mp4-muxer output
- **Profile**: H.264 Main Profile Level 3.1 (avc1.4d401f) — broad device compatibility
- **mp4-muxer** with `fastStart: "in-memory"` for browser-compatible MP4 output
- **30–60% size reduction** for typical MP4/MOV sermon videos before upload
- **Compression toggle** in the upload dialog (auto-detects WebCodecs support via `isCompressionSupported()`)
- **Compression phase UI**: Violet-themed progress card with fps, ETA, before/after size, compression ratio
- **`probeVideo()`**: Reads first mp4 sample to get resolution, framerate, codec, audio info
- **`shouldCompress()`**: Skips compression if already H.264 < 4 Mbps or file < 50 MB
- **Resume skips compression**: Resumed uploads use original file to avoid double-processing

### HLS Transcoder (`artifacts/api-server/src/lib/transcoder.ts`)
- **5 quality profiles**: 1080p / 720p / 480p / 360p / 240p with bitrates 4000k→400k
- **2-second HLS segments**: Down from 6s → <3s startup latency
- **Skip upscale**: Probes source height and omits variants taller than the source
- **Consistent GOP**: keyframe interval = 2s for all profiles (sync with segment duration)
- **Non-blocking GCS upload**: HLS output uploaded to Replit Object Storage after transcoding; served locally via Express `/api/hls/` in parallel

### Replit Object Storage (GCS)
- Bucket: `replit-objstore-216c19a7-8788-473b-ad79-9f8d74ade180`
- Libraries: `@google-cloud/storage` + `google-auth-library` installed in api-server
- `objectStorage.ts` + `objectAcl.ts` in `artifacts/api-server/src/lib/`
- HLS files uploaded non-blocking after transcode completes

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

## Features Added (Session 12) — Professional Operations Center
- **Admin Operations page**: Added `/operations` in the admin dashboard with platform-wide health checks, API uptime, request counters, database counts, registered device count, broadcast queue state, connected admin clients, cache mode, upload sessions, storage usage, and video pipeline status.
- **Operations status API**: Added protected `GET /api/admin/ops/status`, aggregating database connectivity, cache health, broadcast continuity, transcoding status, upload storage, and in-process HTTP metrics into a single operator-friendly payload.
- **Mobile platform status**: Settings now includes a Platform Status section showing whether the broadcast platform is healthy, how many programme queue items are active, and how much sermon content is available.
- **Server logging cleanup**: Replaced remaining startup/recovery `console.*` calls in server routes with the shared structured logger.

## Features Added (Latest Session) — Live Stream Health Monitor

- **Live Monitor admin page**: New `/live-monitor` admin page with real-time YouTube live stream health dashboard
- **4 stat cards**: Stream Status (LIVE/OFF AIR), Stream Uptime (live timer), Last Check (staleness + detection method), Poll Interval (normal vs burst mode)
- **Live stream card**: When live, shows thumbnail, title, video ID, and direct links to YouTube and YouTube Studio
- **Event History log**: Timestamped log of every live↔offline transition with detection method and stream title; persisted in-memory up to 50 events
- **Burst mode indicator**: Shows amber "⚡ Burst mode" badge when the poller is in 15s rapid-poll mode after a state change
- **Offline alert banner**: Prominent red alert banner + toast notification when stream goes offline (detected via SSE)
- **SSE real-time badge**: Green "Real-time" pill when connected to SSE event stream; turns red on disconnection
- **Server tracking additions**: `liveHistory`, `liveSessionStartedAt`, and `currentPollIntervalMs` exported from youtube route; `GET /api/admin/live/health` endpoint returns current status, uptime, poll config, and history

## Features Added (Session 13) — Automated Broadcast Queue Reliability
- **Automatic queue registration**: Admin local uploads and YouTube imports now automatically upsert videos into `broadcast_queue`, preserving metadata, source type, stream URL, sort order, and active status.
- **Queue cleanup on delete**: Deleting a managed video now also removes its broadcast queue entry, invalidates broadcast caches, and notifies connected admin dashboards.
- **HLS queue synchronization**: When FFmpeg HLS transcoding finishes, the worker updates the broadcast queue item with the HLS master URL and probed duration, clears the queue cache, and emits a live queue update event.
- **Real-time admin broadcast refresh**: Broadcast admin page listens for `broadcast-queue-updated` SSE events and reloads queue state immediately after upload/import/transcode/delete changes.
- **Bulk admin uploads**: Video Library upload dialog accepts multiple video files. Each file is uploaded through the existing resumable chunk pipeline with parallel chunk streams, and every finalized video is auto-added to the broadcast queue.
- **Fresh mobile broadcast sync**: Watch tab fetches fresh `/api/broadcast/current` state immediately before opening the player and compensates start position with server-time drift.
- **Playback failover**: Local and YouTube players now surface playback errors to the broadcast player screen, which re-checks the broadcast engine and routes viewers to the currently correct queue item.

## Features Added (Session 17) — Scheduled Push Notifications
- **Scheduled Notifications DB table**: Added scheduled_notifications table with fields: id, title, body, type, videoId, scheduledAt, status, sentCount, errorMessage, sentAt, createdAt. Schema pushed with Drizzle.
- **Background scheduler**: lib/notification-scheduler.ts starts on server boot; checks every 30 seconds for pending notifications whose scheduledAt <= NOW(), sends via Expo Push API, marks as sent or failed, and records a sent_notifications row on success.
- **API endpoints added**:
  - GET /api/admin/notifications/scheduled — list all scheduled notifications (sorted by scheduledAt asc)
  - POST /api/admin/notifications/schedule — create a new scheduled notification (validates future date)
  - DELETE /api/admin/notifications/scheduled/:id — cancel a pending scheduled notification (sets status = cancelled)
- **Admin Notifications page redesigned**: Three-tab layout: Send Now (unchanged instant send + recent history), Schedule (scheduling form with datetime-local picker + live pending/sent list with cancel button), and History (full paginated log). Scheduled list auto-refreshes every 30 seconds. Status badges for pending/sent/failed/cancelled states.

## Features Added (Current Session) — User Authentication & Donations

### User Authentication (JWT)
- **`users` DB table**: id, email, password_hash (bcrypt, 12 rounds), display_name, avatar_url, email_verified, created_at, updated_at
- **`user_favorites` DB table**: server-side favourites per user (videoId, videoTitle, videoThumbnail, videoCategory)
- **`user_watch_history` DB table**: server-side watch history per user with progressSecs
- **`POST /api/auth/signup`**: Creates account, returns JWT + user object; 409 on duplicate email
- **`POST /api/auth/login`**: Validates credentials, returns JWT (90-day expiry)
- **`GET /api/auth/me`**: Returns current user from JWT (requireAuth middleware)
- **`PATCH /api/auth/profile`**: Updates displayName
- **`DELETE /api/auth/account`**: Deletes account + cascades to favorites/history
- **`GET/POST/DELETE /api/user/favorites`**: Server-side favourite management
- **`GET/POST/DELETE /api/user/history`**: Server-side watch history sync
- **`requireAuth` middleware**: JWT verification, attaches user to req.user
- **Auth rate limiting**: Signup + login capped at 10 req/min/IP (brute-force protection)
- **JWT_SECRET**: Auto-generated 48-byte hex key stored as environment variable

### Mobile Auth Screens
- **`AuthContext`**: React context with signIn/signOut/updateUser; restores token from AsyncStorage on launch; refreshes user profile in background
- **`services/authApi.ts`**: All API calls for auth (signup, login, me, profile update, favorites/history sync)
- **`app/login.tsx`**: Full login screen (email + password with show/hide, submit, link to signup)
- **`app/signup.tsx`**: Full signup screen (name + email + password + confirm password validation)
- **Settings — ACCOUNT section**: Shows sign in/create account buttons when logged out; shows user name + email + sign-out when logged in
- **Settings — GIVE section**: Donation entry point from settings

### Donations Screen
- **`app/donate.tsx`**: Full donation screen with 4 giving tiers, Paystack/Flutterwave/bank transfer links, account details, contact email

## Session 17 — TypeScript Cleanup (All Substantive Errors Resolved)
- **API server**: 100% clean TypeScript (only cosmetic TS7030 "not all code paths return" in Express handlers — runtime-safe, Express handles void fine)
- **admin/src/pages/playlists.tsx**: Renamed local `PlaylistVideo` to `LocalPlaylistVideo` to eliminate name collision with generated api-client-react type; replaced all implicit type assertions with explicit `as unknown as` casts throughout DnD reorder logic and existingVideoIds computation
- **admin/src/pages/notifications.tsx**: Removed non-existent `SendNotificationBodyType` import; defined `NotifType` union inline; cast Select `onValueChange` string values to `NotifType`
- **admin/src/pages/users.tsx**: Added `getListAdminUsersQueryKey` import; included required `queryKey` in React Query v5 `query` options alongside `keepPreviousData`
- **admin/src/pages/videos.tsx**: Added `as unknown as VideoRow[]` cast for `data?.videos` map callback to resolve `ManagedVideo` vs `VideoRow` incompatibility (runtime data has extra fields not in generated OpenAPI types)
- **admin/src/lib/videoCompressor.ts**: Fixed mp4box v2.3 API breaking changes — `MP4Sample` → `Sample`, `MP4ArrayBuffer` → `MP4BoxBuffer`, `onFlush` → double-cast, `m.default` → `m as unknown as typeof MP4BoxType`; fixed `sample.data` handling for `Uint8Array | DataView | undefined` union
- **artifacts/api-server routes/admin.ts**: Fixed `ListAdminVideosQueryParams` fallback object from `{}` to properly typed `{ page, limit, search, category }` default

## Features Added (Current Session) — Production Hardening

### API Server
- **Startup env var validation**: Server now throws immediately if `DATABASE_URL` or `JWT_SECRET` are missing, with a clear descriptive error message — prevents silent failures at boot.
- **Global 404 & error handlers**: Added catch-all 404 JSON response and global Express error handler middleware in `app.ts`.
- **`PATCH /api/auth/password`**: Authenticated endpoint to change password — validates current password with bcrypt before updating.

### Mobile App — Cloud Sync
- **`apiGetFavorites()` + `apiGetHistory()`**: New functions in `authApi.ts` that fetch server-side data for the authenticated user.
- **`apiChangePassword()`**: New function in `authApi.ts` that calls the password change endpoint.
- **`useFavorites` cloud sync**: On login (token change), pulls cloud favorites and merges with local AsyncStorage, de-duplicating by videoId — cloud-only items are added locally.
- **`useWatchHistory` cloud sync**: Same approach — merges cloud history into local, sorted by watchedAt, capped at `maxHistoryItems`.

### Mobile App — Screens & UX
- **`app/change-password.tsx`**: New screen with current password + new password + confirm password fields, eye-toggle visibility, form validation (min 8 chars, must match), loading state, success alert, and back navigation.
- **`app/(tabs)/settings.tsx`**: Added "Change Password" row in the Account section when logged in, linking to the change-password screen.
- **`app/login.tsx`**: Added "Forgot your password? Contact support" link that opens a pre-filled support email.
- **Placeholder fixes**: Donate screen bank account number changed from fake "0123456789" to "Contact Us"; settings share URL changed from fake `https://templetv.jctm` to `https://jctm.org.ng`.

### Admin Dashboard
- **Notification character counters**: Both "Send Now" and "Schedule" forms now show live counters (Title: 0/65, Body: 0/240) with `maxLength` enforcement and red highlighting when the limit is exceeded.

## Features Added (Current Session) — Smart TV App

### Smart TV App (`artifacts/tv`) — New Artifact
- **New artifact** at `/tv/` — a dedicated Smart TV web interface (Samsung Tizen / LG webOS / any Smart TV browser)
- **10-foot UI design**: Dark OLED background (`#101010`), large fonts (24px minimum body text, 42px hero titles), prominent focus rings
- **D-pad / Remote navigation**: Full arrow-key spatial navigation — Up/Down switches between content rows, Left/Right moves between videos in a row, Enter plays the selected video, Escape/Backspace returns from the player
- **Live Hero banner**: Shows LIVE NOW or OFF AIR status with real YouTube live detection, includes pulsing LIVE indicator, auto-displays thumbnail when live
- **Categorized sermon rows**: Faith, Healing, Deliverance, Worship, Teachings, Special Programs — fed from the same `/api/youtube/videos` endpoint
- **Video Player**: Full-screen YouTube embed with auto-play, auto-hiding controls overlay, and back navigation
- **Live clock** in the header (updates every second)
- **Skeleton loading state** while videos are fetching
- **Reuses the existing API server** — no new backend code needed

## Features Added (Current Session) — Performance & Reliability Upgrades

### API Server — Broadcast Payload Optimization
- **Parallelized DB queries** in `buildBroadcastCurrentPayload`: `getActiveLiveOverride`, `getScheduleEntries`, and `getQueueItems` are now fetched concurrently via `Promise.all` (was sequential).
- **2-second full-payload cache**: Added `BROADCAST_PAYLOAD_CACHE_KEY` with 2s TTL so rapid SSE reconnects and client polls don't hammer the DB. Cache is invalidated whenever admin changes broadcast state.
- **TypeScript simplification**: Replaced complex generic in cache.get call with a clean `cache.get<any>` for the short-lived broadcast payload cache.

### API Server — YouTube Cache Upgrade
- **Dual-layer Redis/memory cache** for YouTube videos and RSS: migrated from plain `let videosCache` in-memory variables to the `cache` module (`youtube:videos` and `youtube:rss` keys with 10-minute TTL). When Redis is configured, cached data now survives process restarts.
- **Stale fallback**: Added `_videosCacheFallback` — if all YouTube sources fail on a cache miss, the last known video list is served with an `X-Cache: STALE` header instead of returning a 502.
- **Imported `cache` module** into `youtube.ts`.

### Mobile App — Web RSS Fix
- **RSS URL ordering on web**: On `Platform.OS === "web"`, the RSS fetch now prefers the API server proxy (`${apiBase}/api/youtube/rss`) before falling back to the direct YouTube RSS URL. This avoids CORS failures when fetching YouTube RSS from browser context.

### Bug Fixes
- **`pointerEvents` deprecation** in `BroadcastInfoStrip.tsx`: Moved prop from component prop to `style={{ pointerEvents: "none" }}` per React Native 0.73+ deprecation warning.

## Features Added (Session (previous)) — Enterprise Launch Readiness
- **Launch readiness API**: Added protected `GET /api/admin/launch/readiness`, aggregating security, content, broadcast, HLS, cache, notification, monetization, and app launch configuration into go/no-go checks.
- **Admin Launch Readiness page**: Added `/launch-readiness` with readiness score, blocker/warning counts, operational metrics, and actionable checklist grouped by Security & Access, Content & Broadcast, Streaming Pipeline, and Growth & Distribution.
- **Navigation update**: Added Launch Readiness to the admin sidebar so operators can review production blockers before public release.

## Features Added (Current Session) — TV Guide, Mobile Reminders & Platform Polish

### Smart TV — TV Guide / Schedule System
- **`TVGuide` page** (`artifacts/tv/src/pages/TVGuide.tsx`): Full-screen programme guide with a grid listing of all upcoming broadcast items — program name, thumbnail, start time, end time, and duration
- **Live programme highlighting**: The currently-playing item is prominently highlighted with a purple gradient card, a "NOW" badge, and a real-time progress bar showing how far through the programme the stream is
- **Reminder system** (`artifacts/tv/src/hooks/useGuide.ts`): Viewers can toggle reminders for any upcoming programme using the R key or the bell button; reminders are persisted to `localStorage` and survive page refreshes. A reminder count badge appears in the guide header.
- **Watchable from guide**: Current programme with a YouTube video ID shows a "Watch" action button — pressing Enter/clicking it plays the video in the full-screen player
- **D-pad navigation**: Full arrow-key navigation (↑/↓ to move between programmes, Enter to watch/act, R to toggle reminder, Escape to return home)
- **Auto-refresh**: Guide data refreshes from `/api/broadcast/guide` every 60 seconds without disrupting navigation
- **Live override banner**: When a manual live override is active, the guide displays a prominent LIVE NOW banner instead of the normal grid
- **Empty & error states**: Dedicated states for loading (skeleton rows), API errors (with retry button), and empty schedule
- **App-level routing** (`artifacts/tv/src/App.tsx`): Extracted player state to the root so Home ↔ Guide ↔ Player navigation is clean and stateless
- **Guide button in Home header**: Clearly visible "Guide" button in the TV header; keyboard shortcut G also opens the guide from any point on the Home screen

### Mobile App — Programme Reminders
- **Reminder toggle in Guide screen** (`artifacts/mobile/app/(tabs)/guide.tsx`): Upcoming programmes in the TV guide now have a "Remind me" / "Reminded" button; state stored via `AsyncStorage` under `@temple_tv/guide_reminders`
- **Reminder counter**: Guide header shows the total number of active reminders set for upcoming programmes
- **Haptic feedback**: Toggling a reminder triggers a light haptic tap on supported iOS/Android devices

### Mobile App — Donate Screen Fixes
- **Account number link**: The "Contact Us" placeholder for bank account details is now a tappable link that opens the giving team email
- **Contact button on web**: The "Questions? Contact our giving team" button is now visible on all platforms (web, iOS, Android) — was previously hidden on web
