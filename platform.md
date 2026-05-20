# Temple TV — JCTM Broadcasting Platform
## Complete Feature & Functionality Reference

---

## Overview

Temple TV is a full-stack Christian media broadcasting platform built for Jesus Christ Temple Ministry. It delivers a unified 24/7 live broadcast experience across four surfaces — web, mobile (iOS/Android), Smart TV, and an administrative control room — all backed by a single production-grade Fastify API. The platform is self-contained: all media, HLS segments, thumbnails, and upload state are stored in PostgreSQL with zero external object storage dependencies.

**Platform surfaces:**
- `artifacts/api-server` — Fastify 5 REST + WebSocket + SSE API (port 5000)
- `artifacts/admin` — React/Vite admin panel (port 3000)
- `artifacts/mobile` — Expo React Native app (iOS, Android, mobile web)
- `artifacts/tv` — Vite/React Smart TV browser app

---

## 1. Backend API

### 1.1 Core Infrastructure
- **Framework:** Fastify v5 with `fastify-type-provider-zod`. All routes are schema-validated via Zod 3, which also serves as the OpenAPI source of truth.
- **Database:** PostgreSQL via Drizzle ORM. Connection pool with configurable `DB_POOL_MAX`, idle timeout, and connection timeout.
- **Object Storage:** `DatabaseObjectStorage` — all binary assets (video files, HLS segments, thumbnails) stored as BYTEA in the `storage_blobs` PostgreSQL table. Zero external storage dependencies.
- **Caching:** Redis with in-process LRU Map fallback for single-replica deploys.
- **Authentication:** JWT access + refresh token pairs using `jose` (Web Crypto, native ESM). Configurable algorithm (HS256/RS256). HttpOnly cookie session for admin, static API token for automation. RBAC roles. bcrypt password hashing with configurable work factor.
- **API Docs:** Swagger UI auto-generated from Zod schemas at `/docs`.
- **Dual-prefix routing:** All routes registered under both `/api/v1` (OpenAPI) and `/api` (legacy) for backward compatibility.
- **Rate limiting:** Global rate limiting via `@fastify/rate-limit` with per-IP SSE connection cap (`MAX_SSE_PER_IP`).
- **Compression:** `@fastify/compress` — excludes `video/mp2t` and `application/vnd.apple.mpegurl` to avoid double-compressing HLS streams.
- **CORS:** Explicit origin allowlist (`CORS_ORIGINS` env var required in production).
- **CSP:** Content-Security-Policy header stripped from non-HTML responses.
- **Error monitoring:** Sentry integration for error tracking and performance monitoring.

### 1.2 Authentication & Security (`auth` module)
- Email/password registration and login with email verification flow.
- JWT access token (short-lived) + refresh token (long-lived, invalidated by jti + tokenHash on use).
- Refresh token strict IP re-validation (`REFRESH_TOKEN_STRICT_IP_CHECK`).
- Admin static API token with role cap (`ADMIN_API_TOKEN_ROLE`) and IP allowlist (`ADMIN_API_TOKEN_IP_ALLOWLIST`). Every use is logged with a warning and source IP.
- HttpOnly cookie-based admin session (`POST /admin/session`) with CSRF protection (`X-Admin-CSRF: 1` header).
- Password change endpoint with current-password verification.
- SSE sub-token store: short-lived tokens (90 s TTL) written to Redis (or in-process LRU) for authenticating SSE streams without exposing bearer tokens in URLs.

### 1.3 Video Library (`videos` / `media` modules)
- Full CRUD for managed videos: title, description, thumbnail, YouTube import, local upload.
- Video status lifecycle: `pending` → `encoding` → `hls_ready` (with legacy `processing` / `ready` aliases for backwards compatibility).
- YouTube video import by URL or ID.
- Local video serving: `GET /api/v1/uploads/*` streams BYTEA from `storage_blobs`.
- HLS proxy: `GET /api/hls/:videoId/*` streams HLS manifests and MPEG-TS segments with URL rewriting and short-lived HMAC-SHA256 access tokens. 7-day CDN cache on segments.
- HLS in-flight concurrency limiter to prevent database overload.
- Thumbnail proxy: serves generated and custom thumbnails.
- Playlist association: videos can belong to multiple playlists.

### 1.4 Resumable Chunked Upload System (`media-uploads` module)
- Five relay endpoints: `POST /videos/upload/init`, `POST /videos/upload/:sid/chunk`, `GET /videos/upload/:sid/status`, `POST /videos/upload/:sid/thumbnail`, `POST /videos/upload/:sid/finalize`.
- Sessions persisted to DB (`upload_sessions` + `upload_chunks`) — survive server restarts.
- Per-chunk SHA-256 integrity verification.
- Multipart upload emulation: `createMultipartUpload` → `uploadPart` → `completeMultipartUpload` pipeline.
- Upload chunk size capped at 4 MB (`PROXY_SAFE_MAX_CHUNK_BYTES`) to stay within reverse-proxy body limits.
- Idempotent session/finalize operations; session TTL + eviction.
- Storage backend: `db` mode (BYTEA in `storage_blobs`) with legacy `db_fallback` support.
- Per-attempt error messages propagated to retry-exhaustion errors for debugging.

### 1.5 HLS Transcoding (`transcoder` module)
- In-house FFmpeg-based HLS transcoding pipeline.
- Multi-rendition adaptive bitrate output: master.m3u8 + rendition playlists + MPEG-TS segments stored in `storage_blobs` under `transcoded/{videoId}/`.
- Auto-generated thumbnail extracted during transcoding.
- Transcoding job queue with status tracking: `pending`, `encoding`, `hls_ready`, `failed`.
- Job retry, cancellation, and bulk clear operations.
- Real-time progress pushed via SSE (`transcoding-progress` event).
- `TranscoderDisabledBanner` in admin when transcoding is disabled via env.
- `TRANSCODER_SCRATCH_DIR` for configuring temp file location.

### 1.6 Post-Transcode Source Cleanup Pipeline (`transcoder/cleanup.service.ts`)
- After successful HLS transcoding, the raw source blob is automatically scheduled for deletion to reclaim database space.
- `scheduleSourceCleanup(videoId, objectKey)` marks the video row `sourceCleanupStatus='scheduled'` with a `sourceCleanupAfter` timestamp (controlled by `CLEANUP_RETENTION_HOURS`, default 1 h).
- `CleanupWorker` sweeps every `CLEANUP_SWEEP_MS` (default 5 min), validates HLS output integrity (checks master.m3u8, all rendition playlists, first+last segment of each rendition), then deletes the source blob and associated upload rows.
- Exponential backoff on failure; max `CLEANUP_MAX_ATTEMPTS=5` before marking `sourceCleanupStatus='failed'`.
- Status tracked in `managed_videos` columns: `source_cleanup_status`, `source_cleanup_after`, `source_deleted_at`, `source_cleanup_attempts`.
- Disable entirely with `CLEANUP_DISABLE=true`.

### 1.7 Broadcast Engine (`broadcast` module)
- Continuous 24/7 broadcast queue: wall-clock-synchronized playback of a rotating queue of videos.
- Queue management: add, remove, reorder items; drag-and-drop in admin.
- Current broadcast state: `GET /api/broadcast/current` — returns current item, next item, upcoming items (capped at 3), position seconds, total duration, progress percent, server time, item-end epoch.
- DB-direct cold-start fallback when in-memory engine state is unavailable.
- Empty-queue sentinel: synthesizes a 1-hour failover HLS stream when queue is empty (`BROADCAST_FAILOVER_HLS_URL`).
- SSE broadcast events: `broadcast-current-updated`, `broadcast-control-updated`, `status`, `yt-status`, `override-expired`, `broadcast-config-changed`.
- WebSocket broadcast sync (`/api/playback/ws`): delivers state frames, preload frames, and OMEGA signals. HTTP fallback polling at `/api/playback/state`.
- SSE sidecar (`/api/broadcast/events?platform=<tv|mobile|web>`): fans out `videos-library-updated` and `broadcast-schedule-updated` for catalogue revision bumps.

### 1.8 Live Override System (`live-overrides` module)
- Admin can activate a live override (HLS URL or YouTube live URL) that instantly preempts the broadcast queue on all viewer surfaces.
- `POST /api/admin/live/override/start` — starts override, fans out `broadcast-control-updated` SSE/WS to every connected client within milliseconds.
- `POST /api/admin/live/override/stop` — ends override; broadcast engine resumes normal queue/schedule precedence automatically.
- Scheduled overrides: `POST /api/admin/live/override/schedule` — create a future-dated override that activates automatically.
- Override history and per-surface live failure stats.
- YouTube live URL validation + liveness probe before activation.
- Recent YouTube streams retrieved for quick re-broadcast.

### 1.9 Schedule (`schedule` module)
- Weekly programming grid: create, edit, delete schedule entries by day-of-week and UTC time window.
- Entry types: `live`, `playlist`, `video`. Recurring and one-off entries.
- Schedule-aware broadcast engine: overrides queue playback at scheduled times automatically.
- Local-time display hints shown alongside UTC times in admin.

### 1.10 Playlists (`playlists` module)
- Full CRUD for playlists with title, description, and public/private visibility.
- Add/remove videos; drag-and-drop reorder.
- Playlist can be assigned to schedule entries.

### 1.11 Live Chat (`admin-chat` module)
- Global real-time chat channel (`TEMPLE_TV_LIVE_CHANNEL`) over WebSocket.
- Per-message identity: anonymous viewers assigned a session identity; registered users show display name.
- Live viewer count tracked and broadcast.
- Message buffer: last N messages replayed on connect for late joiners.
- Rate limiting and duplicate-message suppression (bypassed for moderator/admin sockets).
- Admin moderation: delete any message, mute a subject (user ID or hashed IP), ban a subject.

### 1.12 Prayer Requests (`prayers` module)
- `POST /api/broadcast/prayer` — any viewer can submit a prayer request (name optional, message required).
- Admin inbox with read/unread status, pagination, and delete.
- Real-time SSE notification on new submission.

### 1.13 Push Notifications (`notifications` / `push` modules)
- W3C Web Push (VAPID) for web clients; Expo Push for native mobile.
- Notification types: `live_service`, `new_sermon`, `announcement`, `custom`.
- Immediate send or scheduled for a future datetime.
- In-process scheduler with exponential backoff and idempotency; permanently-failed items accessible at `GET /admin/notifications/failed`.
- Full delivery history with status, sent count, and error messages.
- Auto-notification on new YouTube live detection.

### 1.14 YouTube Integration (`youtube-live` / `youtube-channel` modules)
- YouTube Data API v4: channel scraping for live detection, video imports, playlist items.
- YouTube quota tracking: daily unit usage, per-context breakdown, 7-day history, exhaustion detection.
- Quota exhaustion gate: pauses API calls when daily limit is reached; `youtube-quota-exhausted` SSE event.
- Ops alert on quota exhaustion.
- YouTube live status: `GET /api/youtube/live` — resolves current live videoId with override priority.
- Channel auto-detect: `ytLive`, `ytVideoId`, `ytTitle` fields propagated through broadcast SSE/REST payloads.

### 1.15 Digital Channel Station System (`channels` module)
- Multi-channel broadcasting infrastructure: multiple independently-running broadcast engines.
- Channel CRUD: name, slug, description, color, primary flag.
- Per-channel queue management and viewer count.
- `channel-engine.ts` per-channel broadcast engine; `channel-registry.ts` manages all engines at startup.

### 1.16 On-Air Graphics (`graphics` module)
- Three graphic types: **Ticker Crawl** (scrolling text bar), **Lower Third** (speaker name and title overlay), **Bug Text** (extra text on channel watermark).
- Full CRUD per channel; activate/deactivate with optional duration.
- Real-time SSE push at `/api/graphics/events`: TV app overlays update within milliseconds of admin action.

### 1.17 Emergency Broadcast System (`emergency` module)
- Create, activate, and deactivate emergency alerts per channel.
- Severity levels: `info`, `warning`, `critical`, `emergency`.
- `GET /api/emergency/active` — poll for currently active alerts.
- Real-time OMEGA signal `EMERGENCY_BROADCAST` fanned out via SSE and WebSocket to all viewer surfaces simultaneously.
- `NODE_HEALTH_CHANGED` signal with `dismissed: true` clears critical/emergency alerts from all clients.

### 1.18 Realtime Infrastructure (`realtime` module)
- Single in-process event bus; all SSE and WebSocket gateways subscribe to it.
- SSE endpoint: `/api/realtime/sse` — omega signals, ops alerts, live events.
- SSE heartbeats at 15 s intervals to prevent proxy timeouts.
- Per-IP SSE connection cap (`MAX_SSE_PER_IP`).
- Graceful shutdown drain loop up to `SHUTDOWN_DRAIN_MS` (default 5 000 ms).
- Cross-instance SSE bus for multi-replica fanout.

### 1.19 Analytics (`analytics` module)
- View counts, unique viewers, watch time, and video play counts.
- Time-range filtering (7d, 30d, 90d, all-time).
- Area chart time series in admin; CSV export with formula-injection protection.

### 1.20 Reactions Pipeline
- Viewers send emoji reactions during live broadcasts (`POST /api/broadcast/reaction`).
- Reaction events fanned out via SSE in real time to all connected surfaces.

### 1.21 Live Ingest (`live-ingest` module)
- RTMP ingest management: create and manage ingest endpoints with stream keys.
- Stream key rotation for security.
- Live ingest preview player in admin.
- Ingest status: running / stopped per endpoint.

### 1.22 Sermon Series (`series` module)
- Create and manage sermon series (title, slug, description, thumbnail, visibility toggle).
- Episodes: add videos as ordered episodes within a series.
- Public/private visibility per series.

### 1.23 Observability & Operations
- **Health endpoints:** `GET /status` (basic alive check), `GET /readyz` (deep storage + DB check; returns HTTP 503 if storage misconfigured in production).
- **Memory watchdog** (`memory-watchdog.ts`): 30-second RSS sampling; fires `ops-alert` SSE event when `MEMORY_WARN_RSS_MB` threshold is breached.
- **Slow request tracker:** captures and exposes the slowest recent requests for performance analysis.
- **Launch readiness checker:** pre-flight validation across auth, storage, CDN, notifications, and broadcast configuration.
- **Telemetry endpoint:** `/api/broadcast/playback-telemetry` — receives per-platform dropped-frame deltas and recovery events from clients.
- **Ops alert system:** unified alert history (last 100); alert channels (email, webhook); severity filtering; SSE real-time push on new alerts; test-fire endpoint.
- **SSE bus monitor:** publish/receive rate sparklines, instance ID, uptime, frame drop counters.
- **Process status panel:** CPU, memory, uptime visible in admin.

### 1.24 Email (`mail` module)
- Transactional email via nodemailer (SMTP): email verification, password reset, admin notifications.

---

## 2. Admin Panel

React 18 + Vite SPA. Design system: Tailwind CSS with shadcn/ui components. All data via `@workspace/api-client-react` (React Query). Real-time updates via an `SSEContext` that reconnects automatically and shows an `ApiReconnectionBanner` when the SSE channel is lost.

### Navigation Sections
**Broadcasting:** Dashboard, Live Control, Live YouTube, Live Monitor, Broadcast Queue, Schedule, Live Ingest

**Content:** Video Library, Playlists, Transcoding, Playback Monitor

**Station:** Master Control Room, Channel Manager, On-Air Graphics, Emergency Alerts, Sermon Series

**Audience:** Analytics, Live Chat, Prayer Requests, Push Notifications

**System:** Operations, SSE Bus, Stream Health, Users, YouTube Quota, Launch Readiness, Alerts History, Purge

---

### 2.1 Dashboard
- Live status tile: currently-on-air item, viewer count, override active badge.
- Quick-start live override (HLS or YouTube URL) and stop override without leaving the page.
- Stat cards: total videos, playlists, schedule entries, notifications sent.
- Recent videos list.
- Today's schedule strip.
- Quick-navigation cards to all major sections.

### 2.2 Live Control
- Activate a live override with HLS URL or YouTube live URL; optional title and duration.
- Schedule a future-dated override with a date/time picker.
- Push notification toggle on override start (notifies mobile subscribers).
- YouTube URL validation and live liveness probe before activation.
- Live override status card with start time, title, and one-click deactivation.
- Override history log.
- Recent YouTube streams dropdown for quick re-broadcast.
- Scheduled overrides list with cancel option.
- Live failure stats per platform (mobile, TV, web) showing recent error counts.
- Real-time status updates via SSE — no manual refresh required.

### 2.3 Live YouTube
- Simplified single-purpose page for going live via a YouTube URL.
- Paste URL → validate → activate in one click.
- Shows active override with deactivation button.
- All viewer surfaces (TV, mobile, web) switch over within milliseconds via `broadcast-control-updated` SSE.

### 2.4 Live Monitor
- Real-time stream health dashboard with area charts for viewer count over time.
- Live event timeline: queue transitions, override activations, failovers, viewer spikes.
- Per-platform viewer count tile.
- HLS stream status: current item, position, queue depth.
- Reconnect button for SSE channel.
- Process status panel: server CPU, memory, uptime.
- Refresh and auto-update via `stream-health` SSE events.

### 2.5 Live Ingest
- Create RTMP ingest endpoints with name and description.
- View and rotate stream keys (masked by default, reveal on demand).
- Start/stop ingest sessions.
- Live preview player embedded in admin.
- Ingest status badges per endpoint.

### 2.6 Broadcast Queue
- Full drag-and-drop queue management using `@dnd-kit`.
- Add videos from library directly to queue.
- Upload new video directly from queue page via the upload modal.
- Remove items; reorder by dragging.
- Live "on air" indicator on the currently-playing item.
- Queue loop and shuffle toggle.
- Real-time queue sync via SSE.

### 2.7 Schedule
- 7-column weekly grid (Sunday–Saturday) with time-of-day rows.
- Create schedule entries: day-of-week, UTC start/end time, content type (live/playlist/video), recurring toggle.
- Local-time conversion hint displayed next to each UTC time.
- Conflict detection prevents overlapping entries.
- Delete with confirmation dialog.

### 2.8 Playlists
- Create/edit/delete playlists (title, description, public/private).
- Add videos by search, remove videos.
- Drag-and-drop reorder within a playlist.
- Duration rollup showing total playlist length.

### 2.9 Video Library
- Paginated video grid with thumbnail previews.
- Filter by status (all, encoded, encoding, pending, failed) and sort by date/title.
- Search by title.
- Multi-select with bulk actions: add to queue, add to playlist, delete.
- Per-video actions: edit metadata, add to playlist, delete (with confirmation dialog).
- Status badges: encoded (green), encoding (amber spinner), failed (red).
- Upload new video via upload modal (chunked, resumable, with progress bar).
- Import YouTube video by URL.
- Real-time transcoding status updates via SSE — badge updates without page refresh.

### 2.10 Transcoding
- List all transcoding jobs with title, thumbnail, status, progress bar, timestamps.
- Job actions: retry failed jobs, cancel in-progress jobs, delete jobs.
- Bulk clear by status.
- Real-time progress updates via SSE (`transcoding-progress` event).
- `TranscoderDisabledBanner` shown when transcoding is disabled via env.

### 2.11 Playback Monitor
- WebSocket-driven live playback view.
- "Now / Next / Next-Next" triple-buffer display showing current item, upcoming item, and pre-warming item.
- Dual-buffer player preview embedded in the page.
- Connection status pill (connected / reconnecting / disconnected).
- No polling — every state change delivered via WS.

### 2.12 Stream Health
- Per-platform startup time percentiles (p50, p95) for mobile and TV players.
- Dropped frame rate chart over time.
- Stall event rate tracking.
- Recovery event count (60-second window per platform).
- Area charts for each metric.
- Auto-refresh via SSE `stream-health` events.

### 2.13 Analytics
- Time-range selector (7d, 30d, 90d, all-time).
- Stat cards: total views, unique viewers, total watch minutes, most-played video.
- Area chart: views over time.
- Top videos table with play count and watch time.
- CSV export (formula-injection safe).
- Auto-refresh toggle.

### 2.14 Live Chat
- Real-time WebSocket chat view with live connection status badge.
- All messages from all viewers visible in chronological order with timestamps.
- Admin can send announcements directly into the chat.
- Per-message moderation: delete message with one click.
- Per-subject moderation: mute (temporary) or ban (permanent) by user ID or hashed IP.
- Live viewer count shown in header.
- Admin socket bypasses rate limits and duplicate checks.

### 2.15 Prayer Requests
- Inbox of all submitted prayer requests with name (optional), message, and timestamp.
- Mark as read/unread.
- Delete requests with confirmation dialog.
- Real-time SSE notification badge on new submissions.
- Pagination.

### 2.16 Push Notifications
- Compose and send push notifications: title, body, type, optional deep-link to a video.
- Notification types: Live Service, New Sermon, Announcement, Custom.
- Schedule notifications for a future date and time.
- Scheduled queue: view, cancel pending notifications.
- Delivery history: status, sent count, error messages, timestamp.
- Delete history entries.

### 2.17 Users
- Paginated user directory with search by name/email.
- Filter by verified/unverified status.
- User cards: avatar, display name, email, verification badge, join date.
- CSV export of user list.

### 2.18 Master Control Room
- Unified overview of all channels: name, color, live/offline status, viewer count.
- View and send emergency alerts across all channels from a single surface.
- Channel quick-stats at a glance.
- System status summary: API health, broadcast engine state, SSE connectivity.
- Real-time refresh.

### 2.19 Channel Manager
- Create/edit/delete channels (name, slug, description, color, primary flag).
- Per-channel viewer count and running status badges.
- Toggle primary channel designation.
- Confirmation dialogs for destructive actions.

### 2.20 On-Air Graphics
- Create and activate three types of broadcast overlays:
  - **Ticker Crawl:** Scrolling text bar across the bottom of the screen.
  - **Lower Third:** Speaker name and title overlay slide-in.
  - **Bug Text:** Additional text displayed on the channel watermark.
- Per-channel graphic management; optional auto-expiry duration.
- Activate/deactivate instantly — TV app overlays update within milliseconds via SSE.

### 2.21 Emergency Alerts
- Create emergency alerts with title, message, severity (info / warning / critical / emergency), and optional expiry time.
- Activate / deactivate alerts.
- Active alerts shown prominently on TV (full-screen or banner mode) and mobile (slide-in banner).
- Critical and emergency alerts cannot be dismissed by the viewer — only cleared by the server.

### 2.22 Sermon Series
- Create/edit/delete sermon series: title, slug, description, thumbnail, visible/hidden toggle.
- Add videos as ordered episodes within a series.
- Reorder episodes.
- Visibility toggle per series.
- Episode list with remove option.

### 2.23 Operations
- Server health: uptime, Node.js version, memory (RSS, heap used/total), CPU.
- Active upload sessions: list in-progress uploads with progress bars and cancel button.
- Storage telemetry: object count and total bytes in `storage_blobs`.
- Slow request snapshot: slowest recent API calls with URL, method, duration.
- SSE bus tile: connection status, publish rate, frame drop counters.
- Memory diagnostics card: RSS trend, GC stats if available.
- Links to SSE Bus detail page and other diagnostic tools.
- Visibility-aware polling (pauses when tab is backgrounded).

### 2.24 SSE Bus
- Full SSE bus detail: instance ID, channel name, uptime, full counter breakdown.
- 5-minute rolling rate history sparklines: publishes/min sent, frames/min received.
- Frame drop counters: `framesDroppedSelf`, `framesDroppedMalformed`, `publishesFailed`, `publishesSkippedDisconnected`.
- 15-second polling cadence (faster than Operations page for active monitoring).

### 2.25 YouTube Quota
- Current daily unit usage vs daily limit with visual gauge.
- Exhaustion state alert and SSE-driven real-time update.
- Last-7-days usage bar chart.
- Per-context breakdown table: which API call site is using units today.
- Quota pause/resume control.

### 2.26 Launch Readiness
- Pre-flight checklist across categories: Auth, Storage, Broadcast, Notifications, CDN, Security.
- Each check returns `ready`, `warning`, or `blocked` with a detail message and recommended action.
- Overall readiness percentage progress bar.
- Auto-refreshes on page focus.

### 2.27 Alerts History
- Last 100 ops alerts across all sources (YouTube quota, live ingest, memory watchdog, etc.).
- Severity filter: all / info / warning / critical.
- Real-time SSE update: new alerts appear instantly via `ops-alert-sent` event.
- Alert channel status (email, webhook): enabled/disabled per channel.
- Test-fire alert to verify channels are configured correctly.

### 2.28 Purge (Danger Zone)
- Selective data purge with six independent targets:
  - Local Video Library
  - YouTube Video Library
  - Broadcast Queue
  - Playlists
  - Transcoding Jobs
  - Schedule Entries
- Requires typing `PURGE CONFIRMED` phrase before any destructive operation.
- Severity badges (critical / high / medium) per target.

---

## 3. Mobile App (Expo)

React Native with Expo SDK. Runs on iOS, Android, and mobile web (same codebase). Shared `@workspace/broadcast-sync` hook connects to the API's WebSocket engine for real-time broadcast state.

### 3.1 Watch Tab (Home)
- Cinematic hero banner showing the currently-on-air program with thumbnail, title, and live badge.
- Cold-start instant paint: AsyncStorage-hydrated cache shows the last-known program before network responds.
- Live status detection: merges admin override (highest priority) → channel auto-detect → YouTube channel scrape.
- Live notification banner that slides in when a live service starts; dismissible.
- Sermon feed: horizontal and vertical cards pulled from YouTube RSS and the API video library.
- Skeleton loading cards during initial fetch.
- Network banner that slides down on connectivity loss with contextual copy.
- Emergency alert banner: slides in from the top, severity-color-coded (info/warning/critical/emergency). Critical and emergency alerts cannot be dismissed.
- Pull-to-refresh.
- Auto-start live broadcast on app open (native only; suppressed on web due to autoplay policies).
- Haptic feedback on navigation actions.
- SEO meta tags on web.
- Section headers with category filtering.
- Watch-progress indicators on sermon cards.

### 3.2 Radio Tab
- Audio-mode media player interface.
- Queue display: current track, upcoming tracks in rotation.
- Playback controls: play/pause, next, previous, seek bar.
- Loop modes: none, loop-all, loop-one.
- Channel watermark (bug) overlay.
- Category filter pills.
- WebSocket broadcast sync integration showing live-queue state.

### 3.3 Library Tab
- Multi-mode browsing: All Videos, Favorites, History, Playlists, Downloads.
- Unified search across all modes with debounced input.
- Sort: Newest, Oldest, Popular.
- Category filter pills.
- Favorites: add/remove on any sermon card.
- Watch history: chronological list of recently watched.
- Watch progress: resume-from position per video.
- Playlists: browse all playlists from the API; view playlist detail with episode list.
- Downloads: locally downloaded episodes for offline playback.
- Skeleton loading states.

### 3.4 Guide Tab
- Broadcast programming guide showing the full schedule of upcoming content.
- Each guide entry shows title, thumbnail, start/end time, and duration.
- Time-relative labels ("On Now", "Up Next", "In X h").
- Reminders: tap the bell on any entry to set a local device notification for that program.
- Reminders persisted to AsyncStorage; bell icon fills when set.
- Scroll-to-now button to jump to the current position in the guide.
- Pull-to-refresh.

### 3.5 Channels Tab
- List of all broadcast channels from the API.
- Channel cards: color strip, icon badge, name, description/slug, live badge (when running), viewer count.
- Tap to navigate to the Watch tab filtered to that channel.
- Auto-refresh every 15 seconds.
- Pull-to-refresh.

### 3.6 Player Screen
- Full-screen video player with:
  - **Local/HLS content:** `LocalVideoPlayer` component with A/B double-buffering, stall watchdog, and reconnect recovery.
  - **YouTube content:** `YoutubePlayer` component (YouTube iframe on web, deep link on native).
- Locks to light color theme for readability.
- Channel watermark overlay in corner.
- Live badge shown during live broadcasts.
- BroadcastInfoStrip: on-air program title and metadata.
- Live reactions: tap to send emoji reactions visible to all viewers in real time.
- Prayer request modal: submit a prayer from the player.
- BroadcastLiveBar: tabbed bottom sheet with reactions and prayer tabs.
- Related sermon cards below the player.
- Favorite, share, and watch-progress tracking.
- Network banner when disconnected during playback ("Reconnecting…" copy).
- Live failure reporting: automatically reports playback errors to the API telemetry endpoint.
- Resume-from-position on re-open for non-live content.
- Playback telemetry: posts dropped-frame deltas to `POST /api/broadcast/playback-telemetry` on a 5-second cadence.

### 3.7 Authentication Screens
- Login, signup, and change-password screens.
- Email + password registration with field validation.
- Persistent session across app launches.

### 3.8 Settings Screen
- Account management, notification preferences.
- App info.

### 3.9 Donate Screen
- Church giving information: multiple bank accounts (UBA, FCMB, GTBank, Zenith Bank) in NGN and USD.
- One-tap copy to clipboard for account numbers.
- SWIFT code for international transfers.

### 3.10 Real-Time Infrastructure (Mobile)
- `useBroadcastSync` hook: WebSocket connection to `/api/playback/ws` with absolute URL construction from `EXPO_PUBLIC_API_URL`. SSE sidecar to `/api/broadcast/events?platform=mobile` for library/schedule revision bumps (web only; silently skipped on native).
- `subscribeBroadcastEvents`: SSE client with platform-adaptive EventSource (browser native on web, custom XHR-backed `NativeSSEClient` on iOS/Android). Exponential backoff (2 s → 60 s).
- `useEmergencyAlerts`: polls `/api/emergency/active` on mount; subscribes to `omega-signal` SSE for real-time `EMERGENCY_BROADCAST` signals. Reconnect retry at 6 s.
- `useNetworkStatus`: monitors device connectivity and drives the NetworkBanner.
- Cold-start broadcast cache: last known on-air program stored in AsyncStorage (60 s TTL) for zero-flash first paint.

---

## 4. Smart TV App

Vite/React SPA optimized for Smart TV browsers (Samsung Tizen, LG webOS, Android TV). Remote control navigation using d-pad/arrow keys. No pointer-dependent interactions; all UI navigable with keyboard events. Samsung AVPlay API integration for native HLS playback on Samsung TVs.

### 4.1 Home Screen
- Cinematic live hero: full-bleed video or thumbnail with title, LIVE badge, viewer count.
- A/B double-buffer hero video: seamless queue transitions with no black frame or loading spinner.
- `useUnifiedLive`: admin override takes priority over channel auto-detect over queue — hero and player always resolve the same stream.
- Cold-start instant paint: last broadcast cached in sessionStorage (60 s TTL) for immediate first render.
- SSE-driven hero updates: `broadcast-current-updated` payload updates the hero within milliseconds — no HTTP fetch on the hot path.
- `BroadcastOnAirStrip`: compact on-air info bar below the hero.
- Sermon rows: one row per category (Faith, Healing, Deliverance, Worship, Teachings, Special Programs).
- Live row: a dedicated `__live__` row when a YouTube live stream is active.
- Logo header with live clock.
- Guide and Search navigation buttons.
- Chat overlay: compact chip in the corner of the home screen.
- Remote navigation: up/down/left/right/select/back fully wired.

### 4.2 Player
- Dual-path player: HLS for uploaded content, YouTube iframe for YouTube IDs.
- **HLS path (`HlsVideoPlayer`):**
  - A/B double-buffer: two `<video>` elements pre-loaded; transitions feel instantaneous.
  - Samsung AVPlay integration for hardware-accelerated HLS on Samsung TVs.
  - Stall watchdog: detects frozen playback and initiates recovery.
  - Automatic reconnect with exponential backoff.
  - Failover URL fallback before giving up on an item.
  - Playback telemetry: posts dropped-frame deltas to the API.
- **YouTube path (`YouTubePlayer`):** YouTube iframe with IFrame Player API integration.
- **Live broadcast wrapper (`LiveBroadcastHlsPlayer` / `LiveYouTubePlayer`):** subscribes to `useLiveSync`; self-advances to the next queue item in place without remounting. Feeds `nextHlsUrl` to the A/B double-buffer for zero-gap transitions.
- Control overlay: auto-hides after 5 s; re-appears on any remote key press.
- Controls suppressed during live broadcasts (no seek, pause, or stop — behaves like a real TV channel).
- Back navigation returns to home.
- `BroadcastChannelBug`: channel watermark overlay.
- `BroadcastLiveCompanion`: passive chip showing live status and viewer count.
- Live failure detection: navigates back to home and falls back to broadcast queue if YouTube iframe fails.

### 4.3 TV Guide
- Full remote-navigable program guide.
- Entries show title, thumbnail, air time, duration.
- Currently-on-air item highlighted with a live indicator.
- Reminders: press select on a future entry to toggle a reminder bell.
- D-pad navigation: up/down scrolls through entries; select plays the current item.
- Back returns to home.
- Synchronized with `useLiveSync` to show the live item correctly.

### 4.4 Search
- On-screen keyboard grid (4 rows × 10 keys) fully navigable by d-pad.
- Live search results update as characters are typed.
- Results show video thumbnail, title, duration.
- Select a result to go to Video Details or play immediately.

### 4.5 Video Details
- Full-screen details view: title, description, thumbnail, duration.
- Play button (d-pad select).
- Related videos list navigable by d-pad.
- Back returns to previous screen.

### 4.6 TV Overlays (rendered globally in App.tsx)
- **`OnAirTicker`:** animated crawl text scrolling across the bottom of the screen. Content managed by admin On-Air Graphics.
- **`LowerThird`:** slide-in speaker name and title overlay. Activated and cleared by admin.
- **`EmergencyAlert`:** full-screen or banner emergency alert. Critical/emergency alerts cannot be dismissed. Driven by `useEmergencyAlerts`.
- **`ConnectivityBanner`:** two-tier banner — red when device is network-offline; amber when broadcast WebSocket is disconnected ("Reconnecting to broadcast…"). Detected via `navigator.onLine` events and `temple-tv-broadcast-connected` custom event dispatched by `useBroadcastSync`.

### 4.7 Chat Overlay
- Live chat visible as a glass-background bottom-right panel during broadcast.
- Compact chip mode on home page; full panel on player page.
- Capped at 60 messages in memory to prevent layout churn.
- Minimal per-row rendering (single text node; no avatars) for performance on under-powered TV browsers.
- Send box with text input (for TVs with keyboards); collapses to "Tap to chat" button otherwise.
- Live viewer count.

### 4.8 Real-Time Infrastructure (TV)
- `useLiveSync` hook: wraps `@workspace/broadcast-sync`. Derives WebSocket URL from `window.location`; passes `sseUrl: "/api/broadcast/events?platform=tv"` for SSE sidecar.
- All OMEGA signals handled in the shared hook: `SYNC_REQUIRED`, `EMERGENCY_BROADCAST`, `PROGRAM_CHANGED`, `FAILOVER_ACTIVATED`.
- `useEmergencyAlerts`: polls `/api/emergency/active` on mount; subscribes to `omega-signal` SSE for real-time signals. Reconnect retry at 6 s.
- `useOnAirGraphics`: SSE subscription to `/api/graphics/events` for ticker/lower-third/bug updates.

---

## 5. Shared Packages

### `@workspace/broadcast-sync`
- Shared React hook used by both TV and Mobile.
- WebSocket connection to `/api/playback/ws`; HTTP fallback polling at `/api/playback/state`.
- OMEGA signal bus: `SYNC_REQUIRED`, `EMERGENCY_BROADCAST`, `PROGRAM_CHANGED`, `FAILOVER_ACTIVATED`.
- 30-second resync loop regardless of WS health to prevent drift.
- Optional SSE sidecar (`sseUrl`) for `videos-library-updated` and `broadcast-schedule-updated` revision bumps. Silently skipped when `EventSource` is unavailable (React Native).
- Exponential backoff reconnect (2 s → 60 s); dispatches `temple-tv-broadcast-connected` custom event on WS open/close for connectivity banners.
- Returns typed `BroadcastSyncState` with: current/next/nextNext items, position, live override, YouTube live state, emergency broadcast flag, revision counters.

### `@workspace/broadcast-types`
- Shared TypeScript types: `BroadcastItem`, `BroadcastNextItem`, `BroadcastSyncState`, `GuideItem`, `GuideResponse`, `ReactionType`, `BroadcastRealtimeEvent`, `PlaybackSourceKind`.

### `@workspace/api-client-react`
- React Query hooks auto-generated from the OpenAPI spec. Used by the admin panel for all data fetching and mutations.

---

## 6. Infrastructure & DevOps

- **Monorepo:** pnpm workspaces, Node.js 24, TypeScript 5.9, esbuild bundler.
- **Database:** Replit built-in PostgreSQL. Schema managed by Drizzle ORM; migrations run via psql.
- **Binary storage:** All media assets in PostgreSQL `storage_blobs` table (BYTEA, TOAST-compressed). No external object storage.
- **Workflows:** Four long-running processes managed by Replit workflows — API server, admin dev server, mobile Expo server, TV dev server.
- **Security hardening:**
  - JWT signed with `jose` (Web Crypto, ESM-native); configurable HS256/RS256.
  - Admin token logged + IP-checked on every use.
  - Refresh tokens invalidated by jti + tokenHash.
  - CSP stripped from non-HTML responses.
  - CORS explicit allowlist.
  - `/readyz` returns HTTP 503 when storage is misconfigured.
  - Admin SPA served with `cache: no-store` to prevent stale JS after deploys.
  - Admin token stored in `sessionStorage` (not `localStorage`).
  - `noindex` meta tag on admin and TV SPAs.
- **Key environment variables:** `DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ALGORITHM`, `ADMIN_API_TOKEN`, `CORS_ORIGINS`, `BROADCAST_FAILOVER_HLS_URL`, `CLEANUP_RETENTION_HOURS`, `CLEANUP_SWEEP_MS`, `CLEANUP_DISABLE`, `MEMORY_WARN_RSS_MB`, `MAX_SSE_PER_IP`, `TRANSCODER_SCRATCH_DIR`, `SHUTDOWN_DRAIN_MS`, `BCRYPT_ROUNDS`, `REFRESH_TOKEN_STRICT_IP_CHECK`, `ADMIN_API_TOKEN_IP_ALLOWLIST`, `ADMIN_API_TOKEN_ROLE`.
