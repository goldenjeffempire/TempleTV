# Temple TV (JCTM) Broadcasting Platform

## Overview

Temple TV (JCTM) is an enterprise-grade broadcasting platform offering a comprehensive media experience. It includes a cross-platform mobile app, a Smart TV web app, an admin dashboard, and a Node.js/Express API backend. Key capabilities include Live TV, Video-on-Demand (VOD) sermon library, 24/7 Radio mode, push notifications, offline video downloads, adaptive streaming, subscription management, user authentication, and a unified real-time broadcast synchronization system across all platforms. The platform aims to deliver a seamless and engaging content consumption experience.

**Guest Access Policy (April 2026):** All content viewing — live broadcast, VOD sermons, TV Guide, and broadcast queue — is freely accessible without sign-up or login on every platform. Authentication is retained exclusively for optional enhanced features: watch history sync, favourites, live-service alerts, admin operations, and device-link pairing. Specific changes: (1) TV `App.tsx` `gatedPlay` hard gate removed — playback fires immediately for all users; `AuthGateModal` and pending-play state removed from TV. (2) Mobile `utils/navigation.ts` `navigateToSermon` and `navigateToPlayer` no longer wrap navigation in `gatePlayback` — both navigate directly. (3) Mobile `app/player.tsx` automatic `openAuthGate` on mount removed — guests arrive at the player without an interruption. The voluntary in-player "Save your watch history" nudge (user-initiated, dismissible) is retained as a non-blocking optional prompt. Backend broadcast endpoints were already fully public; no API changes were needed.

## User Preferences

- The user wants the agent to focus on delivering high-quality, production-ready code.
- The user expects the agent to adhere to the existing monorepo structure and technology stack.
- The user prefers that the agent prioritize features that enhance user experience and operational efficiency.
- The user wants the agent to ensure new features are integrated seamlessly with the real-time broadcast synchronization system.
- The user expects the agent to perform comprehensive testing and address any TypeScript errors or deprecated patterns.
- The user requires the agent to consider security, performance, and scalability in all implemented features.
- The user wants the agent to ensure all changes respect the existing design system, including light-first auto theming and glassmorphism UI elements.

## System Architecture

The platform is built as a monorepo using `pnpm workspaces`, Node.js 24, and TypeScript 5.9.

**Core Architectural Decisions:**
- **Unified Live Broadcast Sync:** A single live input (YouTube Live, HLS URL, or RTMP) feeds all platforms simultaneously via Server-Sent Events (SSE) for real-time state changes (`GET /api/broadcast/events`). An Admin Live Control panel facilitates instant broadcasting.
  - **Automatic Transition Ticker:** `startBroadcastTransitionTicker()` (started in `index.ts`) runs a 2-second server loop. It compares `Date.now()` against `currentItemEndsAtMs` from the last known payload and — when the boundary passes — invalidates the cache, rebuilds the full payload, and pushes `broadcast-current-updated` to all SSE clients with `reason: "item-transition"`. No admin action required for automatic queue advances.
  - **Live Position Recalculation:** `buildBroadcastCurrentPayload()` now stores `itemStartEpochSecs` in the cache. Every read from cache recomputes `positionSecs = floor(Date.now()/1000) - itemStartEpochSecs`, keeping seek positions accurate even if a client joins several seconds after the cache was populated.
  - **Client Precision Timing:** `currentItemEndsAtMs` (epoch ms) and `itemStartEpochSecs` (epoch seconds) are included in every broadcast payload. Mobile `player.tsx` uses `currentItemEndsAtMs` to schedule a precision `setTimeout` that self-tunes to the next item without waiting for the 15-second background poll. TV `useLiveSync` hook now exposes the full payload (positionSecs, currentItemEndsAtMs, itemStartEpochSecs, index, totalSecs, queueLength, progressPercent, nextItem) for position-aware corrections.
  - **Reduced Mobile Poll Interval:** Broadcast sync polling in `player.tsx` reduced from 60 s to 15 s as a belt-and-suspenders fallback behind the SSE + precision timer path.
- **Micro-frontend Approach:** Separation of concerns with distinct artifacts for mobile (`artifacts/mobile`), Smart TV (`artifacts/tv`), and admin (`artifacts/admin`).
- **Data Persistence:** PostgreSQL with Drizzle ORM for database management.
- **API Framework:** Express 5 for the backend API.
- **Validation:** Zod for schema validation.
- **Monorepo Management:** `pnpm` for package management and workspace organization.
- **Cross-Platform Mobile:** Expo (React Native) with `expo-router` for mobile development.
- **Admin Dashboard:** React/Vite for the administrative interface.
- **Adaptive Streaming:** HLS transcoding (FFmpeg v6.1.2 on system PATH) with adaptive bitrate (ABR) streaming for uploaded videos. After transcoding, HLS segments are uploaded to **AWS S3** (bucket configured via `AWS_S3_BUCKET`, region via `AWS_REGION`) for CDN-backed durability and cross-instance access. Local FS serves as the primary delivery path; S3 provides the durable backup. All S3 calls go through the typed wrapper in `artifacts/api-server/src/lib/s3Storage.ts` (singleton `S3Client` from `@aws-sdk/client-s3`, multipart streaming via `@aws-sdk/lib-storage`, presigned URLs via `@aws-sdk/s3-request-presigner`). The transcoding pipeline (`artifacts/api-server/src/lib/transcoder.ts` + `lib/ffmpeg.ts`) is hardened for enterprise reliability:
    - **Boot-time preflight** (`assertFfmpegAvailable`) resolves and caches the `ffmpeg`/`ffprobe` binary paths once at server startup, honors `FFMPEG_PATH`/`FFPROBE_PATH` env overrides, and fails loud with an actionable error if either binary is missing.
    - **Strict input validation** (`validateAndProbeInput`) probes container + all streams before the encoder is initialized, throwing a `TerminalTranscodeError` for corrupt files / no video stream / invalid dimensions / zero duration / sub-1KB uploads. Terminal errors skip retries — they're permanent failures of the asset, not the system.
    - **Idle + wall-clock watchdogs** (`runFfmpeg`) kill any ffmpeg process that goes silent for 90s or exceeds a per-encode wall-clock cap (clamped between 5 min and 4 h, scaled by source duration). Kills are SIGTERM with a 5s grace before SIGKILL. Eliminates hung-encoder zombies.
    - **Atomic job claiming** uses Postgres `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING *` so multiple workers (or future multi-instance deployments) can never claim the same row.
    - **Per-variant fallback**: a single quality variant failure is logged, its partial output cleaned up, and the remaining ladder continues; the job only fails if ZERO variants are produced.
    - **Auto-retry with exponential backoff**: transient failures schedule `nextRetryAt = now + 30s/1m/2m...` (capped at 15m) for up to `maxAttempts` (default 3). The `startRetryTick` interval (30s) wakes the worker so backoff retries fire even with no new uploads. Crash-recovery (`resumePendingJobsOnStartup`) decrements `attempts` so an interrupted attempt doesn't burn the retry budget.
    - **Partial-success transparency**: jobs that succeed with a degraded ladder record `Partial: produced N/5 variants (skipped …)` in `errorMessage` so admins see degradation in the queue UI.
- **Caching:** Three-tier distributed caching: Redis (primary, when `REDIS_URL` set) → PostgreSQL `cache_entries` table (secondary, always active, multi-instance safe via `lib/db`) → in-memory MemoryCache (L1 hot-key layer). `rateStore` similarly: Redis → PostgreSQL `rate_limit_buckets` → memory. Both backends use atomic upserts to prevent race conditions across instances.
- **Performance Optimization:**
  - **Hot endpoint response cache:** `/api/videos/featured`, `/api/videos/trending`, and `/api/playlists` are served from the distributed cache (60s and 30s TTL respectively) and emit `Cache-Control: public, max-age=30, stale-while-revalidate=60` so CDNs and browsers can also cache. Admin mutations to videos and playlists invalidate the affected cache keys via `invalidatePublicVideoCaches` / `invalidatePublicPlaylistCaches` so changes appear within one render cycle.
  - **Database indexes for hot queries:** `transcoding_jobs` indexes on `status`, `video_id`, `next_retry_at`, and a composite `(status, priority, created_at)` for the worker's `FOR UPDATE SKIP LOCKED` claim. `managed_videos` indexes added on `featured` (for `/videos/featured`) and `view_count` (for `/videos/trending`) on top of the existing `imported_at`, `category`, `video_source`, `transcoding_status`, `title`, `preacher` set.
  - **Vite production builds:** Both admin and TV apps use vendor-chunk splitting (`react-vendor`, `ui-vendor`, `tanstack`, `player-vendor` for TV's HLS libraries, `charts-vendor` for admin's recharts, plus a generic `vendor` bucket) so the initial JS download per route stays small. Production builds also drop `console.*` and `debugger` statements via esbuild for smaller, faster bundles.
  - **Express compression** (gzip/brotli, threshold 1024B) is enabled globally with an explicit SSE bypass so live broadcast events still stream in real time.
  - **HLS segment caching:** `.m3u8` manifests cached for 30s, `.ts` segments cached for 1h via `Cache-Control: public, max-age=3600`.
- **Authentication:** JWT-based user authentication with refresh tokens, account management, and server-side storage for favorites and watch history.
- **Notifications:** Expo Push API for scheduled and instant push notifications.
- **UI/UX:**
    - **Theme:** Light-first auto theme with an automatic midnight theme activated from 8:00 PM to 5:59 AM based on the device/browser local time zone.
    - **Design System:** Glassmorphism-style UI with theme-aware glass backgrounds.
    - **Smart TV UI:** 10-foot UI design with large fonts, prominent focus rings, and D-pad/remote navigation.
- **Key Features:**
    - **Video Playback:** Dual-player architecture per platform:
        - **YouTube content:** `react-native-youtube-iframe` (mobile), YouTube IFrame API (TV/web) with D-pad remote control, seek OSD, play/pause overlay.
        - **Local/uploaded HLS content:** `HlsVideoPlayer` component (`artifacts/tv/src/components/HlsVideoPlayer.tsx`) on Smart TV — uses `hls.js` for adaptive bitrate (ABR) on Chromium/Firefox/Samsung/LG browsers, native HLS for Safari/WKWebView. Features: 5-level ABR quality ladder auto-selection, real-time quality badge, fullscreen HTML5 API, seek ±15s OSD, D-pad/remote key handler, cinematic loading veil, buffering spinner, 3-attempt error recovery. TV `Player.tsx` routes between the two players based on whether `hlsUrl` is present. Mobile uses `expo-av` with ExoPlayer on Android (native HLS ABR); mobile web now uses `hls.js` via HTML5 `<video>` (replaced the old open-in-tab button in `LocalVideoPlayer.tsx`). Broadcast sync position (`positionSecs`) is threaded from the TVGuide through `App.gatedPlay` into `Player.startPositionSecs` so viewers join the 24/7 broadcast in-sync.
    - **Content Organization:** Categorization of sermons (Faith, Healing, Deliverance, Worship, Teachings, Special Programs) with search, filtering, and sorting capabilities.
    - **Radio Mode:** Audio-only mode with background playback, sleep timer, and video-to-audio toggle. Powered by a persistent root-level audio engine (`PersistentAudioPlayer`) mounted in `_layout.tsx` — a hidden, offscreen YouTube iframe that owns playback whenever a sermon is selected, surviving tab navigation. The visible `/player` route takes ownership when active to prevent double-playback. Player refs use a compare-and-swap ownership pattern so racing mount/unmount transitions never null out the active controls.
    - **Offline Capabilities:** Offline video downloads using `expo-file-system` and offline metadata caching.
    - **Admin Control:** Dedicated admin panels for Live Control, subscription management, user management, video transcoding queue, scheduled notifications, and platform operations/health monitoring. The admin frontend (`artifacts/admin`) uses a modular architecture with: centralized SSE via `SSEContext.tsx` (single EventSource, pub/sub pattern, exponential backoff reconnect), typed service layer at `src/services/adminApi.ts` (all admin REST calls not in the generated API client), shared components (`PageHeader`, `ErrorAlert`, `MetricCard`), grouped sidebar navigation, and an enterprise layout with real-time sync indicator and live override badge. Live Control, Operations, and Transcoding pages all use the services layer directly to avoid generated-client type restrictions.
    - **TV Guide:** Real-time TV Guide for Smart TV app with live program highlighting and reminder system.
    - **Broadcast-Aware TV Hero:** `LiveHero.tsx` now has three distinct states driven by real API data: (1) YouTube LIVE — red badge + ambient YouTube embed + "Watch Live" CTA; (2) 24/7 Broadcast ON AIR — purple "ON AIR · TEMPLE TV" badge + broadcast thumbnail backdrop + animated real-time progress bar + "Tune In" CTA + "Up Next" indicator; (3) Off-air — muted badge + gradient fallback. `Home.tsx` subscribes to `useLiveSync` for SSE-driven updates — when the hook's `syncedAt` changes (real item transition or queue edit), `Home.tsx` immediately refetches `/api/broadcast/current` so the hero updates within seconds; a 60s interval poll remains as a belt-and-suspenders fallback for when SSE is unavailable. `api.ts` `BroadcastCurrent` type upgraded to include `positionSecs`, `totalSecs`, `progressPercent`, `item`, and `nextItem`. Both the hero `onSelect` and the row `onSelect` now thread `broadcastCurrent.positionSecs` as `startPositionSecs` through the `onPlay → App.gatedPlay → Player` chain so viewers join broadcast playback exactly in-sync.
    - **Tappable NowPlayingBar:** Mobile `NowPlayingBar` component upgraded with `onPress` prop — renders a `Pressable` with scale/opacity micro-interaction and a themed chevron icon on the right. When live, tapping navigates to the live player; when a sermon is playing, tapping navigates to that sermon. Border accent turns red for live state. Title shows "Temple TV" (not raw filename) when live.
    - **Auth-Gated Playback (non-blocking):** Auth is advisory, not a hard gate — guests can watch all content after tapping "Continue watching without signing in." The gate still appears for new content to encourage sign-up, but never interrupts an active viewing session.
        - **Mobile gate flow:** `gatePlayback()` shows the `AuthGateModal`; "Continue watching" in the modal executes `router.push` to the pending content target and then closes. The player route's `useEffect` shows the gate as a suggestion for deep-link arrivals but never calls `router.back()` — guests stay in the player. A once-shown, dismissible purple nudge banner appears below the broadcast video inviting free sign-up. The dismiss button copy changes to "Continue watching without signing in" when a video is pending.
        - **Backend:** Three device-link endpoints (`/api/auth/device-link/{create,claim,exchange}`) backed by the `device_link_codes` table — 8-char codes (ABCD-1234, unambiguous alphabet), 10-min TTL, single-use. Implemented in `artifacts/api-server/src/routes/device-link.ts`.
        - **Mobile:** Module-level binder (`artifacts/mobile/utils/auth-gate.ts`) lets non-React utilities like `navigateToSermon` consult live auth state without becoming hooks. `AuthContext` exposes `openAuthGate / pendingPlayback / consumePendingPlayback`. The gate modal (`components/AuthGateModal.tsx`) is mounted at the root in `_layout.tsx`. Login + signup screens consume the pending target on success and resume playback. `/link` page lets the user pair their TV by entering the on-screen code.
        - **TV:** Minimal localStorage auth (`artifacts/tv/src/lib/auth.ts`) with subscriber pattern. `App.tsx` funnels every `onPlay` through `gatedPlay()`. The TV `AuthGateModal` POSTs `/create`, displays the code at couch-readable scale (>5rem), and polls `/exchange` via a ref-managed recursive `setTimeout` (one in-flight poll, no leakage). Auto-regenerates on expiry with a `creatingRef` guard preventing overlapping creates.
    - **Broadcast Player UI (clean mode):** When `isLive || isBroadcastMode` in the mobile player, the entire scrollable metadata section (category badge, raw filename title, preacher name, "Watch on YouTube" button, "Up Next on Temple TV", seek bar, playback controls) is replaced with a minimal broadcast footer: a red "ON AIR"/"LIVE" badge + "Temple TV · JCTM Broadcasting" channel name, an "Audio only"/"Video" toggle button, and a Share button. For VOD content, the full existing metadata + controls remain unchanged. TV Home (`Home.tsx`) was also fixed to thread `localVideoUrl` as `hlsUrl` through both the broadcast row handler and `LiveHero.onSelect` so the `HlsVideoPlayer` is correctly chosen over the YouTube iframe for local MP4 broadcast content.
    - **Transcoding system hardening:**
      - Route order bug fixed: `DELETE /admin/transcoding/clear` was unreachable (shadowed by the `/:jobId` wildcard) — `/clear` now declared before `/:jobId` so the literal path wins. The "clear failed/done/cancelled" function now actually works.
      - Cancel endpoint extended: `DELETE /admin/transcoding/:jobId` previously only cancelled `queued` jobs. Now also accepts `failed` jobs so admins can dismiss non-retryable failures.
      - Source-file resilience: When the transcoder picks up a job whose `video_path` no longer exists locally (e.g. after a server migration), it now queries the video's `localVideoUrl` and downloads the file via HTTP to a temp path before encoding. The temp file is deleted after the job completes or fails. This prevents ENOENT failures when running in a new environment.
      - Import: `Readable` from `node:stream` added to `transcoder.ts` for the `Readable.fromWeb` web-stream adapter used during HTTP download.
    - **Hero Cinematic Redesign (cross-platform):**
      - **Mobile (`index.tsx`):** Edge-to-edge hero with `LinearGradient`, dynamic height (`62vh` mobile / `52vh` tablet), cinematic 4-layer gradient stack (top scrim + bottom content pull + left editorial vignette + side bleed), floating header overlaid on hero, ON AIR badge with pulse animation, "Library" secondary CTA, and JCTM channel bug watermark.
      - **TV (`LiveHero.tsx`):** Hero height expanded from `min(82vh, 820px)` → `min(94vh, 1080px)` with `minHeight: max(72dvh, 480px)`. The 120% video scaling hack is removed — `inset: 0; width: 100%; height: 100%; objectFit: cover` lets the video fill the container natively. Gradient stack now has four distinct layers: top scrim, bottom content panel, left editorial vignette, and right edge fade. Channel bug watermark added (top-right, "TEMPLE TV / JCTM BROADCASTING"). Metadata panel bottom padding enlarged for cinematic breathing room.
      - **Player broadcast video:** `LocalVideoPlayer` gains `coverMode` prop (uses `ResizeMode.COVER` for broadcast, `CONTAIN` for VOD) and `playerHeightOverride` prop so the player screen can pass its computed taller container height (11:16 aspect ratio for broadcast vs 9:16 for VOD). Both props are passed from `player.tsx` when `isBroadcastOrLive` is true. The `videoPlayerHeight` calculation moved to after `isLive`/`isBroadcastMode` are derived to avoid TypeScript forward-reference errors.
    - **Security & Observability:** API security middleware, admin API protection with `ADMIN_API_TOKEN`, production metrics (Prometheus-compatible), and structured logging.
    - **Enterprise SEO:** Per-route `<title>`, description, canonical, OG, and Twitter cards on every mobile web page via the `usePageSeo` hook (`artifacts/mobile/hooks/usePageSeo.ts`). Root `+html.tsx` ships a Schema.org `@graph` (Organization + WebSite with sitelinks SearchAction + BroadcastService + MobileApplication). Player route emits dynamic `VideoObject` / `BroadcastEvent` JSON-LD per sermon for Google Video carousel eligibility. Sitemap architecture is a sitemap-index at `templetv.org.ng/sitemap.xml` that fans out to a static `sitemap-pages.xml` (mobile `public/`) and a **dynamic** `sitemap-sermons.xml` served by the API server (`artifacts/api-server/src/routes/sitemap.ts`) with full Google Video Sitemap extensions. TV web has its own complete head + manifest + robots; admin is hard-blocked from indexing (`noindex,nofollow,noarchive,nosnippet` + full-disallow `robots.txt`).
    - **Containerization:** Docker support with `docker-compose` for orchestration of API, Admin, PostgreSQL, and Redis services.

## Local Video Upload Pipeline

The admin panel supports chunked resumable uploads of local sermon videos (MP4/MOV/WebM) up to 5 GB. The pipeline:

1. **Admin → Init** (`POST /api/admin/videos/upload/init`): client-generated UUID session, metadata (title, category, preacher, durationSecs), chunked plan written to disk for crash recovery.
2. **Admin → Chunks** (`POST /api/admin/videos/upload/:id/chunk`): 8 MB multipart chunks with SHA-256 verification, adaptive concurrency (1–6 parallel streams), prefetch pool.
3. **Admin → Finalize** (`POST /api/admin/videos/upload/:id/finalize`): streams chunks into assembled file, magic-byte validates (MP4/MOV `ftyp`), computes SHA-256, inserts DB row (`videoSource="local"`, `localVideoUrl` set immediately), **automatically calls `upsertBroadcastQueueVideo`** to add the video to the broadcast queue, queues HLS transcoding job.
4. **Transcoding** (`artifacts/api-server/src/lib/transcoder.ts`): FFmpeg HLS ladder (1080p/720p/480p/360p/240p, upscale-skipped), updates `hlsMasterUrl` + `duration` on success. Videos fall back to raw MP4 `localVideoUrl` if transcoding fails.
5. **Library visibility**: all three platforms use `GET /api/videos?limit=500` (public, no auth) ordered by `importedAt DESC`. The admin library auto-refreshes via `refetch()` post-upload. The mobile library (`useLocalVideos`) uses stale-while-revalidate caching. The TV library polls every 5 minutes.

**Direct Upload to Broadcast Queue:**
The Broadcast Queue page has an **"Upload Video"** button that opens a full-featured `VideoUploadModal` (drag-and-drop, multi-file, chunked, resumable, SHA-256, adaptive concurrency, H.264 client compression). After upload finalize, the server's existing `upsertBroadcastQueueVideo` automatically places the video in the queue with no extra API calls needed. The queue UI auto-refreshes via `loadAll()` on completion.

**Shared upload component:**
- `artifacts/admin/src/lib/uploadEngine.ts` — shared constants, types, and pure upload utilities (chunk XHR, SHA-256, duration detection)
- `artifacts/admin/src/components/VideoUploadModal.tsx` — reusable upload dialog; used in both Video Library and Broadcast Queue with `broadcastMode` and `storageKey` props for context differentiation; `storageKey="ttv-broadcast-upload-v1"` for broadcast, `"ttv-upload-session-v4"` for video library

**Video Library Pagination:**
The Video Library now supports full pagination (`page` query param, 50 items/page). Page controls appear below the list when there are multiple pages. Changing the search query resets to page 1.

**Key files:**
- `artifacts/admin/src/pages/videos.tsx` — upload UI + chunked pipeline + pagination
- `artifacts/admin/src/pages/broadcast.tsx` — broadcast queue with direct upload button
- `artifacts/admin/src/lib/uploadEngine.ts` — shared upload engine utilities
- `artifacts/admin/src/components/VideoUploadModal.tsx` — shared upload modal component
- `artifacts/api-server/src/routes/admin.ts` — init / chunk / finalize / public videos endpoints
- `artifacts/api-server/src/lib/transcoder.ts` — HLS transcoding worker
- `artifacts/mobile/hooks/useLocalVideos.ts` — mobile local-video fetching + duration formatting
- `artifacts/tv/src/hooks/useData.ts` — TV polling + category mapping for local uploads
- `artifacts/tv/src/lib/api.ts` — TV video fetching, passes `apiCategory` from DB

## Direct Browser → S3 Upload (April 2026)

Admin video uploads now bypass the API server's byte-stream by default. The
browser PUTs the file straight to AWS S3 via a presigned URL minted by the
API server, freeing server CPU/bandwidth from the upload critical path.

- **Endpoints (`artifacts/api-server/src/routes/admin.ts`):**
  - `POST /api/admin/videos/upload/s3-init` — validates title + size (≤ 5 GB
    cap), sanitises ext/MIME, mints a 1-hour presigned PUT URL pointing at
    `videos/<sessionUuid>.<ext>`, returns `{sessionId, objectKey, uploadUrl,
    contentType}`.
  - `POST /api/admin/videos/upload/s3-finalize` — HEADs the S3 object to
    confirm it landed (and to use S3's authoritative `ContentLength`),
    stamps ACL metadata via CopyObject, inserts the videos row with
    `objectPath = <S3 key>` and `localVideoUrl = ${baseUrl}/api/videos/<id>/source`,
    and queues a transcoding job with `videoPath=""` so the transcoder's
    HTTP fallback fetches the source via the redirect.
  - `GET /api/videos/:id/source` — public 302 redirect to a freshly-minted
    6-hour presigned GET URL. Used as the stable `localVideoUrl` for clients
    and transcoder.
- **Client (`artifacts/admin/src/lib/uploadEngine.ts`):** new
  `uploadFileToS3(presignedUrl, body, contentType, signal, onProgress,
  stallTimeoutMs)` XHR helper with the same progress + stall-watchdog
  semantics as `uploadChunk`, and ETag capture on success.
- **Modal (`artifacts/admin/src/components/VideoUploadModal.tsx`):** new
  "Upload directly to S3" toggle (default ON, persisted in localStorage).
  `runFileUpload` branches into `runS3DirectUpload` when the toggle is on,
  the file is ≤ 4.5 GB, no resume session is in progress, and no custom
  thumbnail was attached. The chunked upload path remains the fallback for
  files > 4.5 GB, custom thumbnails (which still need a session-scoped
  upload), and resume scenarios. The transcoder auto-generates thumbnails
  for the S3 direct flow.
- **Limits:** S3 single-PUT cap is 5 GB; client cap is 4.5 GB to leave HTTP
  overhead headroom. Object key regex is locked to `^videos/[A-Za-z0-9._-]+$`.

### Telemetry (April 2026)

A dedicated `s3_upload_telemetry` table (`lib/db/src/schema/s3-upload-telemetry.ts`)
records every direct-S3 upload attempt so operators can verify the feature is
healthy before flipping it on for everyone.

- **Events tracked:** `init`, `success`, `server_fail`, `client_error`,
  `client_stall`, `client_abort`. Each row stores sessionId, sizeBytes,
  durationMs, derived throughputBps, errorKind, errorMessage, userAgent.
- **Server instrumentation (`artifacts/api-server/src/routes/admin.ts`):**
  - `s3-init` writes one `init` row per presigned URL minted.
  - `s3-finalize` writes a `success` row (using the client-reported
    `clientDurationMs` to compute throughput) or a `server_fail` row on
    every error path (validation, missing HEAD, empty object, exception).
  - New `POST /api/admin/videos/upload/s3-telemetry` accepts client-side
    `client_error` / `client_stall` / `client_abort` reports.
  - New `GET /api/admin/uploads/s3-telemetry/summary?hours=N` returns
    aggregations: counts by event, attempts/success/failures, success-rate
    %, p50/p95 throughput (via PostgreSQL `percentile_cont`), avg + total
    bytes, and the top 5 errors by count.
- **Client (`artifacts/admin/src/components/VideoUploadModal.tsx`):**
  the S3 path measures wall-clock PUT duration, posts it to `s3-finalize`
  as `clientDurationMs`, and fires best-effort telemetry on stall / abort
  / network error.
- **Surfacing (`artifacts/admin/src/pages/operations.tsx`):** new
  `S3DirectUploadTelemetryCard` card on the Operations page with 1h / 24h /
  7d window toggles, a metric strip (attempts, success-rate, p50/p95
  throughput, total bytes), a top-5 errors list, and per-event raw counts.
  Polls every 15s.
- **Telemetry helper invariants:** `recordS3Telemetry()` swallows all
  failures and only logs at `warn` — a telemetry insert failure must
  never break a real upload. Error messages are capped at 500 chars and
  user agents at 240 chars to keep table size bounded under failure storms.

## Admin Panel Defensive Hardening (April 2026)

After repeated user reports of admin pages crashing with `Unexpected token '<'` JSON-parse errors and `X.map is not a function` runtime errors, all 11 admin pages were hardened across three rounds:

- **Class A — non-JSON response bodies** (HTML proxy fallbacks, 502s): `artifacts/admin/src/services/adminApi.ts` switched all parsing to `text()` + guarded `JSON.parse` and throws a controlled `AdminApiError` with a human-readable message. `broadcast.tsx` and `live-monitor.tsx` direct-fetch paths got the same safe-parse treatment. Generated API client (`lib/api-client-react/src/custom-fetch.ts`) already throws structured `ResponseParseError`.
- **Class B — non-array list payloads**: every `.map / .filter / .reduce / .length` call site on data from API was wrapped with `Array.isArray(...) ? ... : []` either at ingress (preferred for `setState` / `useMemo`) or inline at the render site. Pages touched: `analytics`, `broadcast`, `launch-readiness`, `live-monitor`, `notifications`, `operations`, `playlists`, `schedule`, `transcoding`, `users`, `videos`.

Rule of thumb going forward: **never trust API list shape** — coerce with `Array.isArray` at the boundary. **never call `res.json()` directly** in admin pages — use `adminApi` helpers or wrap in `try/catch` around `text()` + `JSON.parse`.

### Round 4 — workflow `BASE_PATH` fix (April 2026)

The `Start application` workflow was launching admin/tv/mobile dev servers with only `PORT=...` set, omitting the `BASE_PATH=/<slug>/` env var that `vite.config.ts` reads to compute Vite's `base`. As a result, served `index.html` referenced `/src/main.tsx` and `/@vite/client` instead of `/admin/src/main.tsx` etc. — every asset 404'd through the Replit path-routed proxy and the React app never mounted, surfacing as the avalanche of `<!DOCTYPE` / `K.map` / `e?.map` / `undefined.map` errors the user reported. Fixed by updating the workflow command to set `BASE_PATH=/admin/`, `BASE_PATH=/mobile/`, and `BASE_PATH=/tv/` alongside each `PORT=...`. The values match each artifact's `[services.env]` block in its `.replit-artifact/artifact.toml` so dev now matches what production already builds with.

### Round 4b — broadcast loadAll status-aware errors + stale `ADMIN_API_TOKEN` (April 2026)

Two more issues surfaced after the BASE_PATH fix:

1. `broadcast.tsx` `loadAll` silently dropped non-OK responses (so a 401 produced no visible error, just empty data) and reported a generic "Unexpected non-JSON response" message when any `.ok` body returned null. Rewrote it to be status-aware: 401/403 → "Admin authentication failed (401/403). Open the admin key prompt and paste a valid ADMIN_API_TOKEN."; other non-OK → "queue: HTTP 500" etc. (per-endpoint); empty/malformed body → labelled "queue: empty or malformed response". The aggregated message tells you which endpoint failed and how.
2. **The real cause of every page returning 401 was a stale `ADMIN_API_TOKEN` env in the api-server process.** The Replit secret had been rotated, but the api-server had been running since before the rotation, so `process.env.ADMIN_API_TOKEN` held the old value and rejected every request signed with the current one. Diagnosed by reading `/proc/<pid>/environ` and comparing to the shell value. Fix: restart the workflow whenever `ADMIN_API_TOKEN` (or any secret the api-server reads) is rotated. After restart, all 12 admin endpoints returned 200 with the same token.

Operational note: any time admin pages start returning 401 across the board, first check that `process.env.ADMIN_API_TOKEN` inside the running api-server matches the shell's `$ADMIN_API_TOKEN`. A stale-env mismatch surfaces as "Operations status unavailable", "Failed to load broadcast data", and similar messages everywhere at once.

### Round 4c — diagnostic logging + URL audit (April 2026)

After Rounds 1–4 fixed the upstream causes, did a full professional audit of every URL the admin frontend calls vs every route the api-server actually serves. Two stale URL bugs were still hiding in the codebase and would have produced "Failed to …" toasts in real-world use:

1. `artifacts/admin/src/pages/broadcast.tsx` line ~905: was calling `GET /api/admin/broadcast/current` (404 — no such route). The public endpoint is `GET /api/broadcast/current` (no `/admin/` prefix). Already corrected in earlier work; verified.
2. `artifacts/admin/src/components/command-palette.tsx` line ~120 (`stopOverride`): was calling `DELETE /api/admin/live/override` (404 — no such route). The api-server exposes overrides as POST start/stop/extend actions; corrected to `POST /api/admin/live/override/stop`.

Also added structured `console.error` diagnostics to `safeJson()` in `broadcast.tsx`. Whenever it returns null (empty or non-JSON body), it now logs the URL, status, content-type, and — for non-JSON content-types only (to avoid leaking JSON payload fragments) — a 200-char body preview plus the parse error. So next time "empty or malformed response" appears in the UI, the browser console pinpoints exactly which endpoint and what bytes caused it.

Verification after the round:
- TypeScript clean across `artifacts/admin`, `artifacts/api-server`, `lib/api-client-react`.
- All 15 admin URLs the frontend calls return 200 against the api-server.
- Both URL fixes verified with curl (`POST /api/admin/live/override/stop` → 200; `GET /api/broadcast/current` → 200).

How the auto-generated React Query client (`@workspace/api-client-react`) gets the admin token: the admin app monkey-patches `window.fetch` in `lib/admin-access.ts` `configureAdminAccess()`, injecting `Authorization: Bearer <token>` for any URL whose path starts with `/api/admin`. This is invoked from `main.tsx` before React mounts. As a result, the generated client (which uses the standard `fetch` global) receives the token automatically without anyone calling `setAuthTokenGetter()` from the client package. If you ever switch the generated client to a non-fetch transport (e.g. axios), this wiring will need to be redone explicitly.

### Round 4d — page-level enhancements (April 2026)

Added concrete operator-facing improvements to the smaller pages, staying within the no-schema/no-deps/no-rewrites constraints.

1. **Users (`artifacts/admin/src/pages/users.tsx`)**
   - Real avatar rendering when the user has `avatarUrl` (uses existing `Avatar`/`AvatarImage`/`AvatarFallback` primitives); coloured-initial fallback otherwise.
   - **Verified / Unverified / All** filter dropdown (client-side over current page; the API doesn't accept a verified flag, so we surface the limitation inline as "Filtering this page · use Export CSV to apply across all pages").
   - **Export CSV** button that pages through the `/api/admin/users` endpoint in 100-user chunks (server's hard cap), respects the search + verified filters, and downloads `temple-tv-users-<timestamp>.csv` via a Blob URL — no new dependency.
   - Local `AdminUser` type defined in-file because the package barrel `lib/api-client-react/src/index.ts` re-exports `* from "./generated/api"` and that file's `import { AdminUser } from "./api.schemas"` is type-only (stripped at compile), so `AdminUser` isn't reachable from the barrel. Mirrored the small set of fields actually rendered.

2. **Analytics (`artifacts/admin/src/pages/analytics.tsx`)**
   - Manual **Refresh** button driving `refetch()` (spinner while `isFetching`).
   - **Auto-refresh** toggle (60-second `refetchInterval`, off by default; React Query auto-pauses background tabs).
   - **"Updated <Xm ago>"** indicator powered by `dataUpdatedAt`, re-rendering every 30s so the relative time stays current even when the data isn't refetching.
   - **Export top videos** button that emits `temple-tv-top-videos-<period>-<timestamp>.csv`.

3. **Schedule (`artifacts/admin/src/pages/schedule.tsx`)**
   - Inline **local-time hint** rendered next to every per-entry UTC time block: `09:00 – 10:30 UTC · 13:00–14:30 IST`. Computed via `Date.setUTCHours()` + `toLocaleTimeString()` and `Intl.DateTimeFormat` for the TZ abbreviation. Suppressed when the viewer's `getTimezoneOffset()` is already 0.
   - Footer note updated to mention the local-equivalent hint when applicable.
   - Deliberately did NOT shift entries between day columns when local TZ would put them on a different day — that would change the meaning of "today" and confuse operators reading the 7-day grid. Comment in the code documents this decision.

Security hardening (in response to Round 4d architect review):
- **CSV formula-injection guard** added to both `csvEscape()` helpers (`users.tsx`, `analytics.tsx`). Cells whose first non-whitespace character is `=`, `+`, `-`, `@`, TAB, or CR are prefixed with a single quote so they are rendered as text rather than executed as a formula by Excel/Google Sheets/Numbers (OWASP "CSV Injection", CWE-1236). Without this, a user with a `displayName` like `=cmd|'/c calc'!A1` could weaponize an exported user list.
- **Truncation warning** added to the users CSV export. If the 200-page (20k row) safety cap is hit, the toast switches to a destructive variant explicitly stating "Export capped at N rows" so operators know to refine the search instead of trusting an incomplete file.

Verification:
- TypeScript clean across `artifacts/admin`, `artifacts/api-server`, `lib/api-client-react`.
- `/api/admin/users`, `/api/admin/analytics`, `/api/admin/schedule` all 200 after restart.
- Architect re-review of Round 4d security fix: **Pass**. CSV-injection guard correctly orders formula neutralization before CSV quoting; truncation toast switches to the destructive variant with explicit row count. No new findings.

### Round 4e — broadcast.tsx error diagnostics (April 2026)

A user reported the broadcast page surfacing three useless errors at once: "queue: empty or malformed response; current broadcast: empty or malformed response; live status: empty or malformed response". All three endpoints returned valid 200 JSON when curled directly — the bug was the diagnostic itself: it collapsed every parse failure into the same opaque string and gave the operator no signal about WHAT to do.

Fix in `artifacts/admin/src/pages/broadcast.tsx`:

1. **Replaced `safeJson`'s `Promise<T | null>` return with a tagged `JsonResult<T>`** carrying the failure reason (`empty` / `html_fallback` / `non_json`), HTTP status, content-type, and a body preview. The HTML fallback case is detected explicitly with a regex that matches `<!doctype html>`, `<html`, `<head`, or `<body` at the start of the body.
2. **Added `describeJsonError(label, err)`** that turns each variant into an actionable banner string. The HTML-fallback path explicitly tells the operator the symptom suggests `/api/*` is hitting the SPA instead of the API server. The non-JSON path includes the actual content-type and the first ~80 chars of the body so they can identify the source immediately.
3. **Migrated all three call sites in `loadAll`** plus the videos search modal's `fetchVideos` to the new tagged result.
4. **Added a no-token early-out in `loadAll`**: if `localStorage["temple-tv-admin-token"]` is empty, the page now shows a single clear "Admin access key not set — paste your ADMIN_API_TOKEN" message instead of letting three requests 401 and then explaining auth failed.
5. The existing **Retry button** is wired to `loadAll` so the user can re-run after fixing things without a full page reload.
6. The 401/403 message was tightened to explicitly mention the token may have been rotated and no longer matches the server's `ADMIN_API_TOKEN`.

Verification:
- TypeScript clean across the workspace.
- All three broadcast endpoints continue to return 200 JSON via curl, the outer proxy (port 80), and the vite proxy (port 23744).
- The error-state UI still renders the Retry button. The new no-token branch matches the existing admin-key modal flow.

### Round 4f — silent-catch elimination across remaining admin pages (April 2026)

A repo-wide audit of `} catch {` (no error binding) across the 13 admin pages turned up three real defects where the caught error was discarded entirely, leaving the operator with either a generic toast or nothing at all:

1. **`live-monitor.tsx`** (line 263) — caught the `/admin/live/health` failure but dropped the cause; the toast just said "Failed to load live health data" with no description, and the empty-state card said "Check that the API server is running" even when the real cause was a 401, an HTML fallback, or a JSON shape mismatch. Fixed by binding the error, recording the message in a new `fetchError` state, surfacing it in the toast description AND the inline empty-state card, and adding a Retry button that re-runs `fetchHealth`.

2. **`notifications.tsx`** (line 113) — silently swallowed `/admin/notifications/scheduled` failures, leaving the operator looking at "No upcoming notifications scheduled." while the API was actually down or rejecting the token. Fixed by binding the error, storing it in a new `schedError` state, and rendering a destructive-bordered error block (with the underlying message and a Retry button) ahead of the empty-state branch in the Upcoming card.

3. **`launch-readiness.tsx`** (line 106) — toasted "Launch readiness unavailable" with no description; same root cause / same fix pattern (bind error, include `err.message` in the toast description) as the round-4d hardening on dashboard/users/analytics.

Every remaining `} catch {` in the page tree was reviewed and confirmed safe: `live-monitor.tsx:131,139,296` are localStorage parse / JSON.parse fallbacks where ignoring is correct; `schedule.tsx:59` is a timezone-resolution fallback; `videos.tsx:601` is a JSON.parse on an already-failing fetch where the original error is preserved by the surrounding `throw new Error(msg)`.

Verification:
- `tsc --noEmit` clean for both `@workspace/admin` and `@workspace/api-server`.
- After workflow restart, all three previously-silent endpoints (`/admin/live/health`, `/admin/notifications/scheduled`, `/admin/launch/readiness`) return 200 via the API server.
- New `RefreshCw` import added to `notifications.tsx` to power the Retry button; no new dependencies, no schema changes, no rewrites.

### Round 4g — shared safe-json lib + central adminRequest hardening (April 2026)

The `safeJson` / `describeJsonError` / `JsonResult<T>` trio that Round 4e introduced inside `broadcast.tsx` was lifted into a new shared module at **`artifacts/admin/src/lib/safe-json.ts`** so the central admin API client can reuse the exact same diagnostics. This closes the explicit operator request: *"API stability improvements to eliminate failures such as non-JSON responses and unreachable server issues."*

Three concrete changes:

1. **New `lib/safe-json.ts`** — exports `safeJson<T>(res, consoleLabel?)` returning `JsonResult<T>` (`{ok:true,data}` / `{ok:false, reason: 'empty' | 'html_fallback' | 'non_json', status, contentType, bodyPreview}`), plus `describeJsonError(label, err)` for human-readable banner strings. Body-preview safety preserved: when the server claimed `application/json` but failed to parse, the preview is suppressed in both the visible string and the console diagnostic (it may contain user data).

2. **`services/adminApi.ts` rewrite of `adminRequest`** — every page that calls `adminGet/adminPost/adminPut/adminPatch/adminDelete` now benefits automatically:
   - **Network-failure path now distinguishes `AbortError` from connection failures.** The previous code surfaced raw "Failed to fetch" from the browser; it now throws `new AdminApiError(0, "API server unreachable at <url> (<detail>). Check that the API workflow is running.")` so operators see the actual cause rather than a generic browser error.
   - **Error-body parsing uses `safeJson`** instead of a silent `try/catch {}`. An HTML 500 page from a proxy is no longer reported as the literal status text — the message is augmented with "server returned HTML (proxy may be routing /api to the SPA)." or "(non-JSON <content-type>)" so the operator sees the source of the failure.
   - **Successful-but-malformed JSON** now throws `AdminApiError(status, describeJsonError(...))` instead of silently returning a half-parsed payload. Empty 200s still return `undefined` to preserve existing call-site contracts (e.g., DELETE handlers).
   - **204 No Content** is short-circuited explicitly so it never hits the parser.

3. **`pages/broadcast.tsx`** — removed the inline 70-line `safeJson`/`describeJsonError`/`JsonResult` block and now imports from `@/lib/safe-json`. Behavior is byte-identical at the call sites.

Constraints honored: no new runtime dependencies, no schema changes, no rewrites of any page, no removal of `AdminApiError` (its `status` and `message` fields remain stable for `instanceof` checks elsewhere). The shared module is pure — no React, no DOM, no globals — so it's trivially importable from any future admin code path.

Verification:
- `tsc --noEmit` clean for `@workspace/admin`.
- After workflow restart: `/api/admin/broadcast`, `/api/admin/live`, `/api/admin/analytics`, `/api/admin/users`, `/api/admin/ops/status`, `/api/admin/transcoding/queue`, `/api/admin/launch/readiness`, `/api/admin/notifications/scheduled`, and `/api/admin/live/health` all return 200 against the API server.
- The error path was exercised mentally for each branch: `network throw → AdminApiError(0, "unreachable")`, `!res.ok + JSON body → status text replaced by error.error`, `!res.ok + HTML body → status text + " — server returned HTML"`, `200 + HTML body → AdminApiError(200, describeJsonError(...))`, `200 + empty body → undefined` (legacy contract preserved), `204 → undefined`.

### Round 4h — manual theme override on top of auto theming (April 2026)

The admin layout already had a small badge in the top bar showing the resolved theme ("Light" or "Midnight") with a tooltip explaining that the theme switched automatically at 8pm and 6am local time. The badge was non-clickable — operators in fixed-lighting environments (a control room with always-dim screens, or a service running past midnight where the team prefers to keep light mode) had no way to override.

This round added a 3-mode override (Auto / Light / Dark) on top of the existing auto behavior, without breaking the original "light-first auto theming" design intent.

Changes:

1. **`lib/theme.ts` extended** — `applyAutoTheme()` now reads a stored `ThemeMode` (`"auto" | "light" | "dark"`) from `localStorage["temple-tv-admin-theme-mode"]`. When `"auto"` it falls back to the original time-of-day detection (`isMidnightHour()`), preserving the legacy behavior byte-for-byte. New exports: `getThemeMode()`, `setThemeMode()` (writes localStorage + dispatches a custom event for in-tab listeners + calls `applyAutoTheme()`), `nextThemeMode()` (auto → light → dark → auto cycle), and the `ThemeMode` type. All localStorage access is wrapped in `try/catch` for Safari private mode and sandboxed-iframe cases.

2. **`layout.tsx` upgraded the badge to a button** — the previously non-clickable pill is now a semantic `<button type="button">` with a focus ring, an `aria-label`, a tooltip that updates per-mode, and a label that displays the active mode (`Auto · Midnight`, `Auto · Light`, `Light`, `Dark`). The component listens for the in-tab custom event AND the cross-tab `storage` event so a toggle in one operator window propagates to all others; the storage handler is narrowed to the specific theme key so unrelated localStorage writes (admin token, viewer history) don't trigger a re-render. The `CustomEvent.detail` is validated against the union literal before being trusted.

3. **`App.tsx` untouched** — its 60-second `applyAutoTheme()` interval now correctly honors the stored override (when set to `light`/`dark`, the tick is a no-op for the resolved theme; when `auto`, it still flips at 8pm/6am as before).

Architect review: **PASS** on all six verification points (localStorage resilience, SSR hygiene, auto-tick vs override coexistence, cross-tab `storage` correctness, listener lifecycle cleanup, accessibility). Three optional polish items applied: dropped a redundant `applyAutoTheme()` call, narrowed the storage handler to the specific key, and added payload validation for the custom event.

Verification:
- `tsc --noEmit` clean for `@workspace/admin`.
- Workflow restarted and serving on the configured BASE_PATH.
- Constraints respected: no new dependencies, no schema changes, no rewrites of any other component.

### Round 4i — broadcast page UX consistency + missed silent catch (April 2026)

The `broadcast.tsx` page is the most critical screen in the admin (it controls what airs live). It already used shadcn `AlertDialog` for the Clear Queue and End Live confirmations, but the per-item Remove action still used the browser-native `window.confirm()` — a UX inconsistency on the highest-stakes page. Round 4f's silent-catch elimination pass also missed one occurrence: the bulk clear loop did `await adminFetch(...).catch(() => {})` per item, which meant if any individual delete failed (404 if another operator already removed it, network failure mid-clear, token rotation), the local UI was emptied anyway and the operator saw "Queue cleared" while items remained in the database.

Changes:

1. **Per-item delete uses shadcn AlertDialog** — added a `removeConfirmId: string | null` state. `handleRemove(id)` now just opens the dialog (sets the state); the actual DELETE is in a new `handleConfirmRemove` that fires from the dialog's destructive button. The dialog interpolates the queue item's title into the description (with a graceful fallback if the item disappeared via SSE between open and confirm) and resets the state on Cancel / Esc / click-outside via the `onOpenChange` handler.

2. **Bulk clear surfaces partial failures** — `handleClearQueue` now tracks `succeededIds` and `failures` arrays. On full success: `setQueue([])` and a normal toast with the count. On partial failure: only the succeeded items are removed from local state, a destructive-variant toast reports `"X of N removed. Y failed (e.g. <first reason>)"`, and `loadAll()` runs to reconcile against the server-of-truth in case local state drifted from the actual queue.

Architect review: **PASS**.

Verification:
- `tsc --noEmit` clean for `@workspace/admin`.
- Workflow restarted; broadcast page serves and the four AlertDialogs (Add, Go Live, End Live, Clear Queue, Remove) are now consistent shadcn dialogs end-to-end.

### Round 4j — silent-catch sweep extended to components/ (April 2026)

Round 4f's silent-catch elimination pass only swept `artifacts/admin/src/pages/`. A grep this round across the full `artifacts/admin/src/` tree found two missed instances in `components/VideoUploadModal.tsx`:

- `cancelTask` line 781: `await uploadAdminFetch(.../upload/${task.sessionId}, { method: "DELETE" }).catch(() => {});`
- `cancelAll`  line 796: same pattern in the close-all loop.

Both are in the upload cancel path. The local upload aborts via `task.abortController?.abort()` regardless, but the server-side DELETE that cleans up the upload session row + already-uploaded chunks was silently dropped on failure. In production this meant orphaned upload sessions could accumulate server-side (visible in `/api/admin/uploads/active`) with no operator awareness — and could meaningfully fill storage on a busy media operation.

Changes:

- **Extracted `cleanupSession(sessionId)` helper** — wraps the server-side DELETE in an `AbortController` with an 8-second hard timeout. Even a fully hung connection resolves within 8s with a `"timed out (8s)"` failure record. Distinguishes `AbortError` (timeout), `!res.ok` (HTTP error), and thrown network errors.
- **`cancelTask` is now non-blocking** — local teardown (abort upload, remove from `tasksRef`, clear session, force re-render) happens synchronously and immediately. The server-side cleanup DELETE runs as `void cleanupSession(...).then(...)` background work; on failure it `console.warn`s with the session id and surfaces a destructive `"Upload cancelled (cleanup pending)"` toast so operators can check Active Uploads.
- **`cancelAll` is now non-blocking** — snapshots all session ids, aborts every upload, closes the modal, all synchronously. Then `void Promise.all(sessionIds.map(cleanupSession)).then(...)` runs every cleanup in parallel in the background and aggregates failures into a single destructive `"N upload session(s) need manual cleanup"` toast.
- The operator's cancel feels instant regardless of network conditions, and orphaned upload sessions are still surfaced (just asynchronously).

A second `grep` across all of `artifacts/admin/src` for the silent-catch pattern (`.catch(() => {})`, `.catch(() => null)`, etc.) now returns **zero hits**. The admin tree is clean.

Architect review: **PASS**.

Verification:
- `tsc --noEmit` clean.
- Workflow restarted; server logs show clean startup (FFmpeg verified, schedulers running, first request 304 in 4ms, no runtime errors).
- Constraints respected: no new dependencies, no schema changes.

### Round 4k — One-shot retry on transient API failures

**Bug reported by operator:** Transcoding page surfaced `Encoding queue unavailable: API /admin/transcoding/queue: server returned HTML instead of JSON`.

**Root cause:** The Round 4g `safe-json` diagnostic was working perfectly — it correctly identified that the response body was HTML rather than JSON. The proximate cause was a workflow-restart race: the api-server's `dev` script runs `pnpm run build && pnpm run start`, leaving a ~1-2 second window when port 8080 refuses connections. During that window, vite's dev proxy (or the workspace path-based router) returns HTML — either an error page or the admin SPA's index.html — for `/api/*` requests. Direct verification (`curl localhost:8080` and `curl localhost:80`) both return 200 JSON; routing is fine.

**Fix in `artifacts/admin/src/services/adminApi.ts`:**

1. Extracted the per-attempt logic into `doAdminRequest`. The public `adminRequest` is now a thin retry wrapper.
2. Added `transient: boolean` to `AdminApiError`. Set true for:
   - Network unreachable (status 0 from `fetch` reject — distinct from `AbortError`).
   - HTTP 502/503/504 gateway/proxy failures.
   - `safeJson` `html_fallback` reason on either success or error responses.
   - **NOT** set for genuine 4xx, application 5xx with structured JSON body, or empty 204/200.
3. The wrapper retries **once**, after an 800 ms delay, only when:
   - Method is `GET` or `HEAD` (idempotent — POST/PUT/PATCH/DELETE never retry, to avoid double-mutation if the original request reached the server but the response was lost).
   - `signal` is not already aborted.
   - Error is `instanceof AdminApiError && err.transient === true`.
4. The 800 ms delay honors the caller's `AbortSignal`. If the user cancels mid-wait, the Promise rejects with a fresh `AbortError` (not the underlying transient `AdminApiError`) so consumers like React Query that branch on `err.name === "AbortError"` correctly treat it as a clean cancellation, not a retried failure.
5. Listener cleanup: timer-fires path explicitly removes the abort listener before resolving; abort-fires path uses `{ once: true }` and clears the timer before rejecting.

**Architect review:** First pass **PASS** with one medium correctness flag (the abort-during-backoff was rejecting with the wrong error); fixed and second pass returned a clean **PASS** confirming all four verification points (abort semantics, no regression on happy/4xx/5xx paths, listener cleanup correct in all exit paths, post-wait abort check correctly removed as redundant).

**Why this is the right fix:** Workflow-restart races are a real, recurring class of failure in this dev environment. Surfacing them to the operator as actionable errors (Round 4g's diagnostic) was a strict improvement over generic "fetch failed" messages, but operators shouldn't have to click "Retry now" for a 1-2 second restart blip. The retry is silent, scoped tightly to the transient cases, and never applied to mutating requests.

### Round 4l — Universal transient retry coverage + auth-probe hardening (April 2026)

**Bug reported by operator:** After Round 4k shipped, the operator hit the same `html_fallback` failure on the broadcast page on three parallel calls (queue, current broadcast, live status). Round 4k's retry only covered the central `adminRequest` client; six raw-fetch sites bypassed it entirely.

**Coverage fixes in `artifacts/admin/src`:**

1. New exported helper `fetchWithTransientRetry(factory, signal?)` in `services/adminApi.ts`. Shares one backoff schedule with `adminRequest` — see point 2 below. Retries on factory throw (excluding `AbortError`), HTTP 502/503/504, and 200/2xx with HTML body (sniffed via `Response.clone().text().slice(0, 128)` — 128-char window is wide enough to skip BOM, leading whitespace, and HTML comment prefixes before `<!doctype html>`). Skips body-clone when Content-Type is explicitly `application/json` to avoid extra clone+text cost on the SSE 30s refresh cycles.
2. Backoff schedule iterated three times in this round as we measured the actual restart window: 800 ms single attempt (Round 4k initial) → `[500, 1500]` (Round 4l initial, ~2.0s budget) → `[500, 1500, 3000]` (Round 4l hotfix, ~5.0s budget across 4 attempts). The final value comfortably covers the api-server's `pnpm run build && pnpm run start` cycle even under load (3-4s observed), while a successful response on attempt 2 still lands in <2.5s — indistinguishable from a slow page load. The hotfix was triggered by an operator hitting the live-monitor page right at the start of a restart cycle and exhausting the shorter schedule.

**Transient-error UX (hotfix #2 in same round):** Even with 5s of internal retry, an operator can still land on a polling page right at the start of a workflow restart and see the html_fallback diagnostic before the next 5s polling tick recovers. A destructive red "Transcoding queue unavailable" banner overstates the severity for a sub-5s outage that's about to auto-clear.

- `components/shared/error-alert.tsx`: added optional `transient?: boolean` prop. Default false preserves all existing call sites. When true, renders an amber/muted "Reconnecting to API server…" indicator with a spinning loader and softer copy ("…will refresh automatically as soon as it responds"). Both variants still support `onRetry` for the manual escape hatch.
- `pages/transcoding.tsx`: error state changed from `string | null` to `{ message: string; transient: boolean } | null`. The transient flag is derived from `err instanceof AdminApiError && err.transient === true` — i.e., only the same restart-race signatures (network unreachable, 502/503/504, html_fallback) trigger the soft variant. Real auth (401), missing-resource (404), and structured 5xx errors keep the destructive banner.
- Same pattern is intentionally NOT swept into other polling pages this round (live-monitor, broadcast, etc) — done in incremental rounds rather than as a sweeping rewrite.
- Architect noted a useful follow-up: escalate transient → destructive after N consecutive failures or sustained duration (>30-60s) so a real persistent routing fault can't stay visually soft forever. Deferred to a later round.
- No workflow restart was performed for this hotfix because Vite HMR picks up the .tsx changes hot — avoiding causing yet another transient-error window in the operator's session.

**Hotfix #3 — same pattern, Operations page:** Operator reported the same destructive red banner ("Operations status unavailable: API /admin/ops/status: server returned HTML instead of JSON") on the Operations page during a restart cycle. Page polls every 10s; api-server was down ~1-2s, banner stayed up until the next poll tick.

- `pages/operations.tsx`: applied the identical pattern from hotfix #2 to the main `Operations()` component's error state. Added `AdminApiError` to the existing `@/services/adminApi` import, changed error state from `string | null` to `{ message: string; transient: boolean } | null`, derived transient from `err instanceof AdminApiError && err.transient === true`, and branched the ErrorAlert render so transient cases get the soft amber variant and real failures keep the destructive treatment.
- Intentionally NOT touched this round: `ActiveUploadsCard` (already inline muted text, not a destructive banner), `dashboard.tsx` polling errors (already inline muted text inside their panels, not destructive banners), `broadcast.tsx`/`videos.tsx` (use local adminFetch helpers that throw plain Errors, not AdminApiError — adapting them needs a separate detection path and is deferred to a later round).
- Architect's third pass confirmed: keep the explicit ternary branch (clearer than prop-spread for incident paths), defer extracting a `useTransientError()` hook until N≥3 (premature at 2), and the heuristic stays narrow + safe for ops use.
- Again no workflow restart — Vite HMR is sufficient. tsc --noEmit passes clean.

**Hotfix #4 — same pattern + toast suppression, Launch Readiness page:** Operator hit "Launch readiness is unavailable." (the bare empty-state card with no retry hook) on the Launch Readiness page during a workflow restart. This page had two compounding UX problems on top of the underlying html_fallback race: (a) the catch fired a destructive toast on every 15s poll cycle — pure red-toast spam during a restart, and (b) the empty-state card said "Launch readiness is unavailable." with no way to retry because the FIRST load failed and `readiness` stayed null.

- `pages/launch-readiness.tsx`: applied the same error-shape change as transcoding/operations, added `AdminApiError` and `ErrorAlert` imports.
- New rule: **destructive toast suppressed on transient errors unless the refresh was manual** (`if (!transient || manual) toast(...)`). Background polls go silent on transient errors — the inline amber indicator carries that state. Manual refreshes still toast destructively because the operator clicked the button and deserves explicit feedback.
- New render branch: when `!readiness && error`, render `ErrorAlert` (transient or destructive based on the flag) with an `onRetry` button calling `fetchReadiness(true)`. The original "Launch readiness is unavailable." fallback card remains as defensive dead code (effectively unreachable but architect agreed: harmless, low risk, no need to remove in a hotfix).
- Architect's fourth pass confirmed all three deferrals: the dropped-manual-click edge during in-flight is acceptable (not a regression, queue/disable is a separate enhancement); fallback card stays as defensive guard; useTransientError hook extraction waits for the broadcast.tsx work since that page uses a different error class (plain Error from local adminFetch, not AdminApiError) — extracting now would lock in too narrow a signature.
- No workflow restart — Vite HMR catches .tsx hot. tsc --noEmit clean across artifacts/admin.
3. Wrapped the four raw-fetch sites in retry: `pages/broadcast.tsx`, `pages/videos.tsx`, `components/command-palette.tsx` (each had an identical local `adminFetch` helper — retry now applied only to GET/HEAD), and `pages/live-monitor.tsx fetchHealth`.

**Auth-probe hardening (security fix flagged by code review):**

The first review caught an auth-bypass class: the two startup probes (`auth-gate.tsx probeAdminAccess` and `admin-key-dialog.tsx verifyAdminToken`) treated any `res.ok` as success without parsing the body. Combined with `fetchWithTransientRetry`'s JSON-content-type bypass, an HTML response mislabelled as `application/json` could theoretically have let an unauthenticated user past the gate.

- `auth-gate.tsx probeAdminAccess`: replaced raw fetch with `adminGet<unknown>("/admin/stats")`. The central client already does real `safeJson` parsing, so an HTML body throws `AdminApiError` and the probe correctly maps to `server-down` rather than returning `{ kind: "ok" }`. Catch branch maps `AdminApiError.status` to existing `GateState` shapes (401 → `needs-token`, 503 → `server-misconfigured`, 0 → `server-down`).
- `admin-key-dialog.tsx verifyAdminToken`: cannot use `adminGet` because it must verify a token the operator just typed (not yet stored in localStorage). Kept `fetchWithTransientRetry` for retry behavior, but added an explicit `text() → JSON.parse → typeof === "object"` check inside the `res.ok` branch. Parse failure or non-object shape returns `{ ok: false }` with a clear message rather than passing the verification.

**Architect review:** First pass FAIL (missed the two auth probes); second pass FAIL (caught the auth-bypass class on the JSON content-type bypass); third pass **PASS** confirming the auth probes now require parseable JSON success responses and eliminating the false-positive auth path on proxy/SPA fallback responses.

**Coverage claim:** Survey of `await fetch(` across `artifacts/admin/src` now shows only `services/adminApi.ts` itself (already retry-protected) and `components/VideoUploadModal.tsx` (chunk PUTs, intentionally never retried since they are mutating).

### Round 4n — Split-domain production routing fix (uploads silently succeeded against SPA host)

**Symptom:** Operator reported "Success toast but the video isn't appearing in the library." Investigation showed: the production deployment uses two separate custom domains — `admin.templetv.org.ng` for the static SPA and `api.templetv.org.ng` for the API server. The admin SPA was hardcoded to call same-origin `/api/...` paths, which on production resolved to `admin.templetv.org.ng/api/...`. The static-host catch-all rewrite (`/* → /index.html`) returned the SPA's HTML for every API request. The XHR-based chunk uploader only checked `xhr.status >= 200 && < 300` and never validated the response body, so chunks "succeeded" with HTML 200 responses, the upload modal fired its success toast, and nothing was ever written to the API or DB.

**Fix (split into routing + defense-in-depth):**

1. **New `artifacts/admin/src/lib/api-base.ts`** — single source of truth for the API base URL. Honors `VITE_API_BASE_URL` build-time env var; falls back to relative `/api` for same-origin dev. Exports `apiBase()`, `apiUrl(path)`, `rewriteApiPath(legacy)`. The legacy-rewrite helper lets every existing call site that hardcodes `/api/...` continue to work unmodified — they only need their fetch wrapper updated.

2. **All admin fetch wrappers route through the helper:**
   - `services/adminApi.ts` — `BASE` constant uses `apiBase()`
   - `components/VideoUploadModal.tsx` — `uploadAdminFetch` wraps URL with `rewriteApiPath()`
   - `lib/uploadEngine.ts` — chunk URL uses `${apiBase()}/admin/videos/upload/.../chunk`
   - `pages/videos.tsx`, `pages/broadcast.tsx`, `components/command-palette.tsx` — all three local `adminFetch` helpers wrap URL with `rewriteApiPath()`
   - `pages/live-monitor.tsx` — local `apiUrl(path)` delegates to `apiBase()`
   - `lib/admin-access.ts` — `getAdminEventSourceUrl` routes through `rewriteApiPath()`, supports absolute URLs (EventSource has stricter URL handling than fetch)
   - Stragglers: `components/error-boundary.tsx` (`/api/client-errors`) and `components/admin-key-dialog.tsx` (`/api/admin/stats`) — both updated to use `${apiBase()}/...`

3. **Defense-in-depth in the XHR chunk uploader (`uploadEngine.ts`):** on `xhr.onload` with 2xx, the response is validated as JSON before resolving. Logic: pass if Content-Type contains `application/json` OR body parses as JSON; reject with a clear error message if body starts with `<` (HTML). Stops the silent-success class entirely — even if `VITE_API_BASE_URL` is misconfigured in the future, the upload will fail loudly with `"Chunk N returned HTML instead of JSON — the upload reached the static SPA host, not the API server"` instead of falsely claiming success.

**Operator action required to activate the fix in production:** set `VITE_API_BASE_URL=https://api.templetv.org.ng` as a build-time env var on the admin web artifact's deployment, then re-publish. Without this, the relative `/api` fallback continues, which is what was broken. The build inlines the value at compile time (Vite `import.meta.env.VITE_*`), so the env var must be present during the deployment build, not just at runtime.

**Verification in dev:** With `VITE_API_BASE_URL` unset, `apiBase()` resolves to `/api` and all behavior is byte-identical to the previous code path. Confirmed by hitting `localhost:80/api/admin/videos` (HTTP 200) and `localhost:80/admin/` (HTTP 200) post-restart.

**Architect review:** PASS with one follow-up — `live-monitor.tsx` had its own local `apiUrl` helper that was missed in the first sweep; updated to delegate to `apiBase()`. No false-positives on the JSON-vs-HTML detection in `uploadEngine.ts` (it falls through to `JSON.parse` before declaring HTML based on `<` prefix). EventSource URL absolute/relative handling correctly preserved.

### Round 4o — Crash-loop guard for poison-pill transcoding jobs (production OOM took the API down)

**Symptom:** After fixing the split-domain routing (Round 4n), production API server entered a crash loop. Render returned HTTP 502 for every request. Logs showed: server starts, recovers stuck transcoding job `f8bdd00e-da61-404f-80e8-398f1435c0ca` (1080p variant of videoId `f758080a`), starts ffmpeg, ~95s later container dies (Render OOM kill — ffmpeg 1080p exceeded container memory budget), Render restarts container, same cycle repeats indefinitely.

**Root cause:** `resumePendingJobsOnStartup` in `lib/transcoder.ts` was *decrementing* `attempts` on crash recovery to preserve the retry budget across legitimate deploy interruptions. But `attempts` only ever increments via the SQL `claimNextJob` (line 312: `attempts = attempts + 1`), and a job that crashes the container before completing means the worker never finishes — so attempts oscillates 0 → 1 (claim) → 0 (resume decrement) → 1 (claim) → forever. The retry cap (`maxAttempts`, default 3) is never reached. A single oversized/malformed source file thus permanently kills the API server.

**Fix (surgical, no schema change):** added a circuit breaker in `resumePendingJobsOnStartup`:
- Each crash-recovery appends a sentinel string `[crash-recovery]` to the job's existing `errorMessage` text column (capped at 1KB via left-truncation so the column can't bloat).
- On each subsequent startup, count the markers in `errorMessage` via regex.
- If marker count >= `CRASH_LOOP_LIMIT` (= 1, i.e. tolerate one recovery, fail on the second), mark the job `failed` and the video's `transcodingStatus` `failed` instead of re-queueing. Logs an explicit error explaining the guard fired.

**How the bad row gets unstuck after deploy:** existing `f8bdd00e` row has 0 markers in `errorMessage`. First startup after deploy: count=0, append marker, queue, worker claims, OOMs. Second startup: count=1, hits the guard, marked `failed`. Total recovery time: ~2 container cycles (~3-5 minutes). API stays up from cycle 2 onward.

**Architect review:** PASS on all six review questions — marker regex is safe against user input (errorMessage is set by the worker, not video metadata; worst-case false-positive just marks one job failed which is fail-safe); 1KB slice well within the `text` column's effective limits; multiple instances doing recovery converge to same final state; downstream apps (TV/mobile) gracefully fall back to `youtubeId` when `hlsMasterUrl` is null and never hang on a "transcoding..." state.

**Operator action:** redeploy the API server with this fix. After ~2 crash cycles the guard kicks in, the bad job is marked failed, and the API stays up. Long-term: bump the API service's container memory tier on Render so 1080p ffmpeg encodes don't OOM (current tier appears insufficient for 1080p+ source material), or downgrade the encoder ladder to skip 1080p/2160p variants on the smaller tier.

### Round 4p — Cross-platform broadcast video parity + domain migration + documentation refresh (April 2026)

This pass had three operator directives, all completed in code and reviewed by the architect:

1. **Mobile MP4 broadcast playback was broken.** `LocalVideoPlayer.tsx` always tried to load every URL through `hls.js` regardless of file type, so a `.mp4` broadcast item failed silently with an `hls.js` parser error. Fixed by URL-extension regex (`/\.(mp4|webm|mov|m4v|ogg|ogv)(\?|#|$)/i`) — when matched, the component routes to the native `<video>` element on web and to `expo-av` direct progressive playback on native. The `seekToStart()` helper that honours `startPositionMs` was extended to fire on every code path (HLS, native HLS, direct MP4) so MP4 broadcasts join at the correct live offset just like HLS ones.

2. **Mobile hero was cropping the broadcast frame.** The hero used `objectFit: cover`, which cropped the top and bottom of any broadcast wider than the hero box's aspect ratio. Switched the foreground to `contain` (so the full frame is always visible) and added a web-only blurred `cover` backdrop layer behind it — exact parity with the TV `LiveBroadcastVideo.tsx` cinematic look. Native iOS / Android keeps `contain` over the dark theme background (no blur) since `expo-av` doesn't expose a per-instance backdrop layer.

3. **Cross-platform broadcast parity audit.** Verified mobile↔TV are now byte-equivalent on the four sync axes:
   - **MP4 detection:** identical URL-extension regex on both platforms (`HlsVideoPlayer.tsx` / `LocalVideoPlayer.tsx`).
   - **Hero contain + blur:** identical two-layer composition (`LiveBroadcastVideo.tsx` / mobile `app/(tabs)/index.tsx` hero block).
   - **12-second / 4-second drift correction:** identical thresholds, same clamp `[0, durationSecs - 0.5]`, same stable-ref pattern so the video element never tears down on identity churn.
   - **Broadcast position handoff:** both platforms compute `startPositionMs = positionSecs * 1000 + networkDriftSecs` from `serverTimeMs` returned by `/api/broadcast/current` and pass it to the player as `startPositionMs` along with `broadcastMode="live"`. The TV path runs through `computeLiveBroadcastPosition()` in `pages/Home.tsx`; the mobile path is inlined in the hero. The api-server is the single source of truth for the live offset.

   Admin out of scope for this audit (CMS only, no broadcast playback).

4. **Domain migration `templetv.app/link → templetv.org.ng/link`.** Repo-wide grep turned up exactly one stale reference in `artifacts/tv/src/components/AuthGateModal.tsx` (the TV pairing screen — the most user-visible occurrence). Updated. The `templetv.app` DNS record should serve a 301 to `templetv.org.ng` for any QR codes / printed material still pointing at the old host.

5. **Documentation refresh.** Updated the root `README.md`, `artifacts/mobile/README.md`, `artifacts/tv/README.md`, and `artifacts/api-server/README.md` to reflect the cross-platform sync architecture above — new sections describe the join-offset computation, the 12s/4s drift correction loop, the two-layer container shape, and the MP4-routing rule. The api-server README's route table now explicitly enumerates the sync fields (`serverTimeMs`, `positionSecs`, `currentItemEndsAtMs`, `itemStartEpochSecs`) that every broadcast client depends on. `RELEASE_AUDIT.md` §12 closes the loop with the operator-facing summary.

Verification:
- TypeScript clean across `artifacts/mobile`, `artifacts/tv`, `artifacts/api-server`.
- `grep -rn 'templetv.app/link'` → 0 hits in `artifacts/`, `lib/`, and root docs.
- All workflows except the aggregate `Start application` running clean (the aggregate's port-8080 wait window is a pre-existing dev-only race, not a regression from this pass).

### Round 4s — Production admin blank-screen part 2: vendor chunk React.Children race (April 2026)

**Symptom:** After Round 4r shipped (API origin auto-inference) and was redeployed, the admin SPA at `https://admin.templetv.org.ng/` was still blank. Browser DevTools showed an uncaught error inside React internals: `Cannot set/read property 'Children' of undefined` thrown from inside `vendor-BgvKa1iE.js`, with the React internals (minified `ZD`, `Ih`) appearing as the trigger in the stack — i.e., the failure happened during top-level evaluation of a vendor chunk before React was bound.

**Root cause:** `artifacts/admin/vite.config.ts` had a custom `manualChunks` function that sent `react`/`react-dom` to a `react-vendor` chunk while sending React-consuming packages — `recharts`, `react-remove-scroll`, Radix Slot pattern, `@floating-ui` — to sibling `vendor` / `ui-vendor` / `charts-vendor` chunks. Verified by greping the deployed bundles: `Children` references existed in vendor (3), ui-vendor (2), and charts-vendor (4), all reading `React.Children.toArray/only/count` cross-chunk. Forced manual chunk boundaries created problematic cross-chunk initialization for transformed CJS/interop modules that expect the React namespace to be initialized; sibling chunks could begin top-level evaluation before `react-vendor`'s exports were fully bound, surfacing as `undefined.Children` and a completely blank page.

**Fix:** Removed the `manualChunks` function entirely from `artifacts/admin/vite.config.ts` (`rollupOptions.output = {}`). Rollup's automatic chunking algorithm builds the chunk graph from the real import graph, so React-touching code is co-located with React or in chunks that explicitly depend on React's chunk — no cross-chunk race possible.

**Build outcome verified locally:**
- Single main entry chunk `index-le3Gy-bu.js` — 633.99 kB raw / **185.62 kB gzipped** (contains React + the eagerly-needed app shell).
- Route pages still split per-route via `React.lazy()` in `App.tsx` (dashboard, videos, broadcast, etc.) — 14 dynamic imports preserved.
- Heavy libs lazy: `AreaChart` (recharts) 400 kB / 111 kB gz, `mp4box` 182 kB / 45 kB gz, `sortable` 45 kB / 15 kB gz — all loaded on demand.
- Every chunk that references `React.Children` either IS the entry chunk (which has React) or imports from the entry chunk via the natural dep graph, so React always evaluates first.
- No build warnings about circular chunks; no CSS regression (`assets/index-*.css` still wired into `index.html`).

**Architect note:** the previous "manualChunks for cache stability" win was negligible (gzipped vendor was ~120 kB; auto-chunked entry is ~186 kB), and the catastrophic blank-page risk was never worth that ~65 kB cache-cohort delta. If we ever want to reintroduce vendor splitting for cache reasons, it must be dependency-aware (verify React-touching modules stay grouped with React) and validated by an end-to-end smoke load before deploy.

**Action required to apply this fix:** redeploy the admin app — same as Round 4r, the build is what bakes the fix into the bundle that runs in the browser at `admin.templetv.org.ng`.

### Round 4r — Production admin blank-screen fix: split-domain API origin auto-inference (April 2026)

**Symptom:** `https://admin.templetv.org.ng/` rendered as a blank/empty card to users. Direct probing showed the SPA was actually stuck in `state.kind === "checking"` ("Verifying admin access..."), retrying the auth probe forever.

**Root cause:** The production admin Vite build did not have `VITE_API_BASE_URL` (or `VITE_API_URL`) set, so `apiBase()` fell back to a same-origin relative `/api` path. On the split-domain deploy `admin.templetv.org.ng` serves a static SPA whose catch-all rewrite (`from = "/*", to = "/index.html"`) returns `index.html` for ALL paths, including `/api/admin/stats`. The AuthGate's `adminGet("/admin/stats")` therefore received HTML on a 200 status, `safeJson()` correctly classified it as `html_fallback` which `doAdminRequest` marks transient, and `adminRequest`'s retry wrapper kept retrying — the bounded retry eventually exhausted but the AuthGate showed only the spinner state during the loop. Curl confirmed: `https://admin.templetv.org.ng/api/admin/stats` → 200 text/html, `https://api.templetv.org.ng/api/admin/stats` → 401 (the correct backend).

**Fix:** `artifacts/admin/src/lib/api-base.ts` now has `inferProductionApiOrigin()`. When neither `VITE_API_BASE_URL` nor `VITE_API_URL` is set AND the browser hostname starts with `admin.`, `ABSOLUTE_BASE` is derived as `${protocol}//api.<rest-of-host>`. This matches the production deploy convention (`admin.templetv.org.ng` SPA + `api.templetv.org.ng` backend) and means a forgotten env var no longer breaks the entire admin console.

**Guarantees preserved:**
- Explicit `VITE_API_BASE_URL` / `VITE_API_URL` overrides still take precedence (build-time control retained).
- Dev untouched: localhost / replit-dev / path-routed workspace previews don't match `^admin\.` so they continue using the relative same-origin `/api` proxied to localhost:8080 by Vite.
- SSR/Node contexts return `null` (`typeof window === "undefined"` guard) so module-load doesn't crash in non-browser environments.
- Both `apiBase()`/`apiUrl()` and `rewriteApiPath()` consume the same `ABSOLUTE_BASE`, so REST calls AND the SSE EventSource (via `getAdminEventSourceUrl`) get the corrected origin transparently.

**Caveat:** Inference uses default protocol/port from `window.location` and the `admin.→api.` hostname convention only. Custom-port or non-standard split deployments must still set `VITE_API_BASE_URL` explicitly. The retry path is now finite (bounded by `RETRY_BACKOFF_MS.length`) so a wrong-host inference surfaces as a normal error state instead of a perpetual spinner.

**Action required to apply this fix:** the admin app must be redeployed — the build is what bakes in client-side code that runs in the browser at `admin.templetv.org.ng`.

### Round 6 — Remove all time/duration/progress UI from broadcast surfaces (April 2026)

Goal: complete the TV-channel directive by stripping every "playback position" indicator from viewer-facing broadcast surfaces. Round 5 disabled the controls; Round 6 removes the readouts. A real television channel never tells viewers how far through the current program they are.

What was already correct (verified in audit, not changed):
- `artifacts/mobile/components/MiniPlayer.tsx`: progress bar already gated `showProgress = !isLive && duration > 0`. ✅
- `artifacts/mobile/app/player.tsx`: seek bar already gated `showSeekBar = !isLive && !isBroadcastMode && duration > 0`. ✅
- `artifacts/mobile/components/NowPlayingBar.tsx`: no time UI, just "NOW LIVE" / "NOW PLAYING" + chevron. ✅
- `artifacts/mobile/components/PersistentAudioPlayer.tsx`: bare wrapper around YoutubePlayer, no UI chrome. ✅
- `artifacts/tv/src/components/ContinueWatchingCard.tsx`: VOD-only ("X minutes left" on previously-watched sermons that the user CAN resume / seek into). Not a broadcast surface. ✅

Surgical changes applied this round:
- `artifacts/tv/src/components/LiveHero.tsx`: deleted the entire `BroadcastProgressBar` sub-component (a 2-second-tick `<div>` progress bar + "Xm left" / "Ending soon" caption) and removed its only call-site in the cinematic hero. Hero now shows ON AIR badge + title + Tune In CTA, period.
- `artifacts/tv/src/pages/TVGuide.tsx`: deleted the per-second live progress bar, the `{fmtDuration(livePositionSecs)} / {fmtDuration(item.durationSecs)}` readout, and the orange `· ending soon` flag from the current-program guide row. EPG metadata (start time, end time, total program duration on the right of the row) is preserved because that is scheduling information, not playback position.
- `artifacts/mobile/app/(tabs)/guide.tsx`: deleted the `progressTrack` / `progressFill` bar and the "X left" `remainingPill` from the NOW ON AIR card. The same EPG-metadata preservation rule applies (start–end window and program length stay).
- `artifacts/mobile/app/(tabs)/index.tsx`: replaced the cinematic-hero `BroadcastProgress` component (a per-second-tick progress track + Up Next chip) with a slim `BroadcastUpNext` chip that shows "Up Next: <title>" only. The Up Next preview is preserved because real TV channels do show a sneak peek of the next program — they just don't show a playback bar for the current one.
- `artifacts/mobile/components/BroadcastInfoStrip.tsx`: removed the `progressTrack` / `progressFill` from the in-player overlay strip and the now-unused `fmtRemaining` helper. The "NOW ON AIR" badge and the "Up Next" pill (now showing the next title) remain.

Architectural rationale (called out for future maintainers):
- Two distinct categories of "time UI" exist on these surfaces: **EPG/scheduling** (start time, end time, program length — what a TV listings magazine prints) and **playback position** (elapsed/remaining/progress bar — what a video player shows). The directive removes the second category from broadcast surfaces. The first stays because it answers "when does my show air?" — a legitimate channel question, not a playback control.
- The "Up Next" chip is preserved everywhere because real TV channels routinely do bug-style "Coming up next: …" overlays. Removing it would be a regression vs. real television, not a step toward it.
- VOD/Continue-Watching cards keep their "X min left" and progress bars because those are on-demand sermons the viewer chose to resume — they are *not* broadcast surfaces.

**Pass 2 — broadcast-mode control suppression on `/player`:** The first architect review of Round 6 caught a real gap: mobile broadcast queue items launched with `broadcastMode="true"` but `live="false"` were still rendering native scrubber/timeline UI on `LocalVideoPlayer` (both `useNativeControls` on native and HTML5 `controls` on web) and exposing the YouTube IFrame control bar / fullscreen / keyboard seek on `YoutubePlayer`. Fixed by:

- Threading a new `isBroadcastLive?: boolean` prop through `LocalVideoPlayer`, `YoutubePlayer.tsx` (shared interface), `YoutubePlayer.web.tsx`, and `YoutubePlayer.native.tsx`. Each platform variant maintains its own `YoutubePlayerProps` interface and was updated independently.
- `LocalVideoPlayer`: `useNativeControls={!isBroadcastLive}` on native; `controls: !isRadioMode && !isBroadcastLive` on web.
- `YoutubePlayer.web.tsx`: `playerVars.controls`, `playerVars.disablekb`, `playerVars.fs` now conditionally `0/1` on `isBroadcastLive`. Init effect deps and bootstrap effect deps both updated to include `isBroadcastLive`, so flipping mode for an unchanged `videoId` re-creates the player instance with new chrome (the architect's pass-2 finding).
- `YoutubePlayer.native.tsx`: `initialPlayerParams.controls`, `initialPlayerParams.preventFullScreen`, and `webViewProps.allowsFullscreenVideo` are all gated on `isBroadcastLive`. The `<YoutubeIframe>` `key` now includes `isBroadcastLive` (`${activeVideoId}-${isBroadcastLive ? "b" : "v"}`) so the WebView remounts on mode flip.
- `artifacts/mobile/app/player.tsx`: passes `isBroadcastLive={isBroadcastOrLive}` to both player call sites; the `LiveBadge` now renders for both `isLive` and `isBroadcastMode` (both are channel feeds, not on-demand picks).

**MiniPlayer broadcast-mode gating:** The previous gate `!isLive && duration > 0` did not catch broadcast queue items because `PlayerContext.playSermon()` sets `isLive=false`. Added a new `isBroadcastMode: boolean` field + `setIsBroadcastMode(b)` setter to `PlayerContext`, mirrored from the player route on mount/unmount. `MiniPlayer.tsx` now gates `showProgress = !isLive && !isBroadcastMode && duration > 0`, hides `skip-forward`, shows ON AIR badge for broadcast, and uses "Temple TV / ON AIR" for the title/subtitle pair.

**Pass 3 — off-route persistence + system-level controls:** Pass 2 cleared `isBroadcastMode` on `/player` unmount, so backgrounding the player while broadcast continued via `PersistentAudioPlayer` re-enabled VOD chrome on MiniPlayer. Pass 2 also left `MiniPlayer` re-entering as VOD (`navigateToSermon`), and left RNTP lock-screen/notification capabilities (`SeekTo`, `SkipToNext`, `SkipToPrevious`) and remote handlers active for broadcast. Pass 3 fixes:

- `PlayerContext` clears `isBroadcastMode` from inside `playSermon` (VOD pick) and `playLive` (YT live), the only legitimate exits. `/player`'s mirror effect no longer clears on unmount.
- `MiniPlayer.handlePress` adds an `isBroadcastMode` branch that calls `navigateToPlayer({ broadcastMode: "true" })`, preserving channel intent on re-entry — `/player` then re-tunes to the current SSE broadcast item.
- `services/nowPlaying.ts` exposes `setBroadcastCapabilities(b)` that swaps RNTP capabilities to Play/Pause/Stop only for broadcast and restores the full set otherwise.
- `services/PlayerService.ts` adds module-level `broadcastMode` + `setBroadcastModeForRemoteHandlers(b)`. `RemoteSeek`/`RemoteNext`/`RemotePrevious` early-return when `broadcastMode` is true — defense in depth against stale BT/CarPlay UIs that cache a previous capability set.
- `PlayerContext` `useEffect` on `isBroadcastMode` calls both setters; both are platform-safe (no-op on web) and setup-safe.

**Pass 4 — Radio surface + context transitions + RNTP cold-start race:** Architect Pass 4 found three remaining leaks. Closed all three:

- `app/(tabs)/radio.tsx`: skip-back and skip-forward `Pressable`s are now wrapped in `{!isBroadcastMode && (...)}` — a TV viewer can't skip programs from the radio screen. The "Watch Video" CTA's `handleWatchVideo` checks `isBroadcastMode` first and routes via `navigateToPlayer({ broadcastMode: "true" })` instead of `navigateToSermon` so re-entry can't downgrade to VOD.
- `PlayerContext.tsx`: `playNext` and `playPrevious` early-return when `isBroadcastModeRef.current` is true (broadcast advance is exclusively driven by `/player`'s `tuneToBroadcastItem` against the SSE schedule, so external calls — stale UI, RNTP RemoteNext/Previous — would jump out of the channel feed). `stopPlayback` clears `isBroadcastMode` so the next surface starts clean. Added `isBroadcastModeRef` mirror so the empty-dep callbacks can read the current value without invalidation.
- `services/nowPlaying.ts`: split the actual `updateOptions` call into a private `applyBroadcastCapabilities`. `setBroadcastCapabilities` now records `lastBroadcastMode` even before RNTP setup completes; `setupPlayer` replays the queued mode after `isSetup = true`. Closes the cold-start race where `PlayerContext` mounted and called `setBroadcastCapabilities` before `_layout.tsx`'s async `setupTrackPlayer()` had finished — the lock-screen UI would otherwise stay on the default seek/skip set until the next mode flip.

**Pass 5 — shared YoutubePlayer.tsx web fallback:** Architect Pass 5 found one final leak: the shared `artifacts/mobile/components/YoutubePlayer.tsx` (web fallback used on any path that doesn't resolve to `.web.tsx`) still hardcoded `fs: "1"`, `allowFullScreen: true`, and didn't consume `isBroadcastLive` at all. Closed by:

- `buildEmbedUrl` Pick now includes `isBroadcastLive`; embed params switch `controls` (1↔0), `disablekb` (0↔1), `fs` (1↔0) on the broadcast flag.
- Component destructures `isBroadcastLive` and forwards into `buildEmbedUrl`. The `useMemo` for `src` now includes `isBroadcastLive` in its dep array so flipping mode for an unchanged `videoId` rebuilds the URL with new chrome.
- The `<iframe>` `allow` attribute strips `"fullscreen"` from the permission policy when `isBroadcastLive` is true, and `allowFullScreen={!isBroadcastLive}` removes the attribute itself — the user has no escape hatch into the native YouTube fullscreen player (which carries its own scrubber/seek controls).

**Architect Pass 6: PASS.** All broadcast surfaces (TV LiveHero, TV TVGuide, mobile guide.tsx, mobile (tabs)/index.tsx, mobile (tabs)/radio.tsx, mobile BroadcastInfoStrip, mobile player.tsx, mobile LocalVideoPlayer, mobile YoutubePlayer .tsx/.web/.native, mobile MiniPlayer, mobile PlayerContext, mobile services/nowPlaying, mobile services/PlayerService) now enforce: no progress UI, no scrub/seek/scrubber, no skip-forward/back, no fullscreen escape hatch, no off-route downgrade to VOD, no lock-screen / Bluetooth / CarPlay seek/skip leak, no cold-start RNTP capability race, no broadcast bypass via context transitions (playNext/playPrevious/stopPlayback all guarded or self-clearing).

TypeScript clean on both packages (`@workspace/tv` and `@workspace/mobile`, both `tsc --noEmit` produced no output) after every pass. All individual workflows running and HMR'd successfully.

### Round 5 — Strict TV-channel broadcast behavior on LIVE surfaces (April 2026)

Goal: enforce television-station semantics — viewers cannot pause, scrub, or stop a LIVE broadcast; the channel is always running and the user is either tuned in or not. VOD playback (on-demand sermons) keeps full controls because pausing a recorded sermon is essential UX.

What was already correct (verified, not changed):
- Server is the single source of truth: `artifacts/api-server/src/routes/broadcast.ts` publishes `BroadcastCurrentPayload` (item, positionSecs, itemStartEpochSecs, serverTimeMs, liveOverride) over `/api/broadcast/events` (SSE) and `/api/broadcast/current` (poll fallback). Cross-device sync, refresh persistence, and per-12s drift correction were already live on mobile (`PlayerContext`) and TV (`LiveBroadcastVideo.tsx`).
- Auto-play is on everywhere; the only fallback is the unavoidable browser-policy "tap to start" overlay (Chrome/Safari mandate).
- Cinematic Hero on both platforms already had zero playback controls.
- Mobile `player.tsx` LIVE footer already omitted play/pause (static ON AIR pill).

Surgical changes applied this round:
- `artifacts/tv/src/components/HlsVideoPlayer.tsx`: added `isLive?: boolean` prop. When live, the bottom control bar (scrubber, time, hint strip) is gated off and replaced with a pulsing "ON AIR" pill bottom-left; a live-mode keymap guard runs BEFORE the main switch and swallows playpause/play/pause/stop/select/fastforward/rewind (BACK/EXIT/F still work).
- `artifacts/tv/src/pages/Player.tsx`: forwarded `isLive` to HlsVideoPlayer and YouTubePlayer. YouTube live mode now suppresses playpause/play/pause/stop/fastforward/rewind (the `playpause` case was the architect-flagged miss in the first pass — fixed). Hint strip becomes ON AIR + Exit.
- `artifacts/tv/src/pages/Home.tsx` + `artifacts/tv/src/App.tsx`: extended `onPlay` callback signature with optional `isLive`; the four LIVE call-sites in Home pass `true`, schedule/VOD entries omit it. The App-level Home wiring callback (line 144) was the architect-flagged miss in the first pass — the 5th argument is now forwarded into `gatedPlay`.
- `artifacts/tv/src/pages/TVGuide.tsx` + `artifacts/tv/src/App.tsx`: extended TVGuide `onPlay` signature with optional `isLive` and pass `true` for all four `item.isCurrent` launch paths (keyboard select + click, both HLS local and YouTube). App TVGuide wiring forwards the 5th arg. Architect-flagged in second-pass review — current ON AIR program launched from the TV Guide now correctly suppresses pause/seek/stop. Upcoming/non-current entries do not call onPlay (they only toggle reminders), so no change there.
- `artifacts/mobile/app/(tabs)/radio.tsx`: replaced central play/pause Pressable with non-interactive ON AIR / TUNE IN indicator pill, removed the standalone Stop Pressable, removed the now-unused `handlePlayToggle`/`handleStop` helpers and `togglePlay` destructure. ALSO removed the broadcast time/duration position pill, elapsed/remaining text, and the progress bar from the broadcast glass card (architect-flagged miss in the first pass — TV-channel viewers join mid-show and don't see a progress bar). Audio entry remains via the "Tune In to Temple TV Channel" CTA (live) or by tapping a sermon row (on-demand). The sleep timer still calls `stopPlayback` directly so audio still ends when the timer fires. Skip-back / skip-forward kept (queue navigation, not pause).

Deferred (not done this round, called out for future work):
- TV "Radio Mode" parity: adding an audio-only listening surface to the TV is genuinely a new feature (route, audio-only renderer, persisted preference) and was scoped out of this controls-suppression round to keep the diff reviewable.
- Mobile VOD player.tsx still has play/pause for on-demand sermons. The directive's "TV-channel behavior" was interpreted as applying to LIVE surfaces only; on-demand sermon playback genuinely needs pause.

Architectural note (not a deferral): `isRadioMode` is intentionally a per-viewer client-side preference, not a server-broadcast field. The server timeline is synchronized; an individual viewer's choice between audio-only and audio+video is private (a person wearing headphones in church wants radio mode; the same broadcast on a TV in the lobby wants video). Cross-device sync applies to the broadcast timeline, not to per-viewer rendering preferences.

TypeScript clean (`pnpm --filter @workspace/tv exec tsc --noEmit` and `pnpm --filter @workspace/mobile exec tsc --noEmit` both produced no output). Architect re-review confirmed all three first-pass misses fixed.

### Round 4q — TV pairing modal responsive refactor + SSE backoff parity (April 2026)

Two operator-driven fixes to enforce cross-platform reliability parity:

1. **TV pairing modal (`artifacts/tv/src/components/AuthGateModal.tsx`) responsive overhaul.** The modal was breaking at narrow viewports (~520px) — the 8-character pairing code rendered as "7UBB - - MU5" (letter-spacing leaking onto the dash separator), the Cancel button got clipped at the right edge, and the "Free account" side panel overlapped the code area. Fixed by: (a) splitting the code into two `<span>` chunks at the midpoint (handles 6/7/8-char codes) with letter-spacing applied per-chunk so the separator span is unaffected; (b) `clamp(2.75rem, 9vw, 6.5rem)` font scaling so the code stays readable from 320px to 1920px; (c) responsive padding `px-5 py-6 sm:px-10 md:px-14`, modal `max-h-[calc(100vh-1.5rem)] overflow-y-auto` so it never escapes the viewport; (d) side panel hidden until `lg:` (1024px) so it can't crowd the code; (e) bottom action row uses `flex-wrap` with order utilities so Cancel sits top-right on small screens, bottom-right on large; (f) backdrop click-to-close, inline "Try again" button in the error block, `aria-live` on the code, `aria-label` on Cancel. Polling, countdown, regenerate, ESC handling, and `aliveRef` cleanup are unchanged. Architect verdict: PASS.

2. **TV SSE reconnection backoff aligned with mobile** (`artifacts/tv/src/hooks/useLiveSync.ts`). The TV `useLiveSync` hook used a weaker reconnection pattern than mobile: linear 1.5x multiplier, 30s ceiling, no jitter, no `open`-event reset. Under sustained API outages this would converge faster than mobile and could cause thundering-herd reconnections. Aligned with `artifacts/mobile/services/broadcast.ts`'s pattern: exponential 2x with 0–30% jitter, 2s floor, 60s ceiling, reset on both the EventSource `open` event AND on any successful `broadcast-current-updated` message. Both clients now share identical reliability semantics so a single api-server restart triggers the same reconnect curve regardless of device.

Verified parity that did NOT need changes (audit findings that were stale):
- Mobile precision transition timer (`currentItemEndsAtMs`) — already implemented in `artifacts/mobile/app/player.tsx` lines 571-583.
- Mobile transparent 401 token refresh — already implemented in `artifacts/mobile/services/authApi.ts` lines 108-110, matching TV's `authFetch` behavior.

Intentional cross-platform differences (NOT parity gaps):
- Mobile fallback poll interval is 60s (battery-aware); TV is 10s (always-on, mains-powered context). Different SLAs by design.
- Mobile has a `/radio` tab with background audio + sleep timer + auto-mirror; TV has no radio mode (10-foot UI is video-centric — TV viewers do not run the device as a background audio source).
- Mobile uses Expo Push Notifications; TV web has no notification surface (browsers cannot fire push without service-worker registration which Tizen/WebOS do not consistently support).

## External Dependencies

- **Database:** PostgreSQL
- **ORM:** Drizzle ORM
- **Cloud Storage:** AWS S3 (`@aws-sdk/client-s3` v3, `@aws-sdk/s3-request-presigner`, `@aws-sdk/lib-storage`)
- **Push Notifications:** Expo Push API
- **Live Streaming/Video Platform:** YouTube Live
- **Payment Gateways (Donations):** Paystack, Flutterwave
- **In-App Video Player:** `react-native-youtube-iframe`
- **HLS Adaptive Streaming:** `hls.js` (TV web + mobile web fallback)
- **Audio/Video Playback:** `expo-av` (mobile native — ExoPlayer HLS on Android)
- **File System (Mobile):** `expo-file-system`
- **Caching:** Redis
- **Containerization:** Docker, Nginx
- **API Specification:** OpenAPI
- **Frontend Frameworks:** React, Vite
- **Mobile Framework:** Expo (React Native)
- **Backend Framework:** Express
- **Video Processing:** FFmpeg (for HLS transcoding)
### Round 7 — Seamless broadcast queue transitions across all surfaces (April 2026)

The broadcast queue rolling from one item to the next was triggering a full
player teardown on every platform: blank screens, spinners, black frames,
and (on mobile) a `router.replace` that re-mounted the entire `/player`
route. The directive was to make queue advances behave like a real TV
channel — preload + instant cut, persistent video pipeline, identical
behavior on mobile/web, TV, Hero, and Player.

Fixes (additive — no behavior change for VOD playback):

1. **TV `HlsVideoPlayer` (`artifacts/tv/src/components/HlsVideoPlayer.tsx`)** rewritten as A/B double-buffered: two `<video>` elements + two `hls.js` instances, `videoRefA/B`, `hlsARef/BRef`, `loadedUrlA/B`, `activeSlot` + `activeSlotRef`. New `nextHlsUrl` prop primes the inactive slot via `loadIntoSlot(slot, url, "preload")`. On `hlsUrl` change the player either swaps to the slot that already has the URL (`swapToInactive()` — 1-frame cut) or cold-loads the active slot. AVPlay (Tizen) fallback preserved as single-engine. Cinematic veil suppressed after first frame via `hasEverShown` flag so the second item never re-shows the loading curtain.
2. **TV `LiveBroadcastVideo` (`artifacts/tv/src/components/LiveBroadcastVideo.tsx`)** uses 4-element A/B with a foreground+background pair per slot for the cinematic crop. `LiveHero.tsx` now passes `broadcastCurrent.nextItem` so the hero strip on the home page transitions identically.
3. **TV `Player.tsx`** added a `LiveBroadcastHlsPlayer` wrapper that subscribes to `useLiveSync` when `isLive=true`, holds local `hlsUrl/title/startPositionSecs` state, and forwards `sync.nextItem.localVideoUrl` as `nextHlsUrl` so the full-screen player behaves the same as the hero.
4. **Mobile `app/player.tsx`** the killer bug: `tuneToBroadcastItem` was calling `router.replace` on every queue advance, tearing down the entire screen. Replaced with in-place state mutation (`tunedLocalVideoUrl/tunedHlsMasterUrl/tunedTitle/tunedThumbnail/tunedVideoId/tunedStartPositionMs/tunedNextLocalVideoUrl/tunedNextHlsMasterUrl`). The 15s sync poll, SSE handler, and precision transition timer all update tuned state instead of navigating. The SSE handler was also updated so that when the active item is unchanged but the queue's `nextItem` is fresh, we still mirror it into the preload slot.
5. **Mobile `LocalVideoPlayer` (`artifacts/mobile/components/LocalVideoPlayer.tsx`)** web path rewritten as A/B double-buffered to match TV: two `<video>` + two `hls.js` instances, per-slot loaded-URL refs, `loadIntoWebSlot(slot, url, "active"|"preload")`, `swapWebSlots()`, and a render that absolutely-positions both elements at full size with the inactive slot at `opacity:0`. New `nextVideoUrl/nextHlsMasterUrl` props receive the upcoming queue item from `player.tsx`. Only the active slot drives external `onPlay/onPause/onEnded` callbacks so the inactive slot's preload-completion events don't cascade into the broadcast handler. Watchdog, autoplay-blocked overlay, radio-mode hidden video, MP4-vs-HLS routing, and the `crossOrigin` policy are all preserved. Native expo-av path remains single-engine — the dominant native UX bug was `router.replace`, which is now gone, so the React subtree stays mounted and source changes flow through one Video component without a remount.

Surfaces that share the new pipeline:
- TV Hero (LiveHero → LiveBroadcastVideo, 4-element A/B with cinematic background)
- TV Player full-screen (LiveBroadcastHlsPlayer wrapper → HlsVideoPlayer A/B)
- Mobile web Player (LocalVideoPlayer A/B web)
- Mobile native Player (single-engine expo-av; in-place source swap via tuned* state, no router.replace)

TypeScript clean for both `@workspace/tv` and `@workspace/mobile`. All four workflow servers come up cleanly (api:8080, admin:23744, mobile:18115, tv:23876) with no errors.


### Round 8 — Black-frame elimination during broadcast transitions (April 2026)

Round 7 introduced the A/B double-buffered pipeline so the *common* queue
advance (preload-hit) became a 1-frame cut. This round closes the
remaining edge cases that could still surface a black frame or spinner
between videos:

1. **Cold-load via inactive slot (TV + mobile-web).** Previously, when
   `hlsUrl` advanced to a URL that *wasn't* primed on the inactive slot
   (channel change, schedule jump, override toggle, queue mutation), the
   active slot's hls.js was destroyed in-place and `src` reassigned —
   blacking out the visible `<video>` for the duration of the manifest
   fetch. Now the cold-path URL is staged on the **inactive** slot in
   preload mode; a `pendingPromotionUrlRef` + watcher effect listens
   for `loadeddata`/`canplay`/`playing` and promotes via
   `swapToInactive` / `swapWebSlots` the moment the slot is ready.
   The visible slot keeps showing its last frame the entire time. A
   15s safety fallback hard-loads onto the active slot if the inactive
   slot can't get ready (matches `LOAD_WATCHDOG_MS`).

2. **Autonomous swap on `ended` (TV).** Added an `ended` listener on
   the active slot that promotes the inactive slot immediately if it
   has a different URL primed and is at `readyState ≥ 2`. Eliminates
   the "video ends → wait for SSE → swap" black gap when the server's
   transition tick hadn't yet fired. The SSE-driven `hlsUrl` change
   that arrives moments later lands harmlessly because the URL now
   matches the active slot. Mobile already had this via `onEnded`
   piping into `handleVideoEnd` — see point 4.

3. **Faster server transition ticker.** `_tickTransitions` interval
   reduced from **2,000ms → 500ms** in `artifacts/api-server/src/routes/broadcast.ts`.
   Clients now auto-swap on `ended` so the SSE isn't strictly required
   for video continuity, but it remains the source of truth for the
   now-playing card and up-next list — the faster tick keeps that
   metadata in lock-step with the actual on-screen video.

4. **Mobile `handleVideoEnd` no-wait path.** Removed the hard-coded
   800ms `setTimeout` before re-tuning the broadcast on video end.
   The web A/B player auto-swaps the moment the active video ends, so
   the wait was creating a visible black gap on platforms where the
   pipeline is already swapped. Native iOS/Android (single-engine
   `expo-av`) also benefits — re-tuning immediately makes the source
   change land sooner.

Files touched:
- `artifacts/tv/src/components/HlsVideoPlayer.tsx`
- `artifacts/mobile/components/LocalVideoPlayer.tsx`
- `artifacts/mobile/app/player.tsx`
- `artifacts/api-server/src/routes/broadcast.ts`

TypeScript clean for both `@workspace/tv` and `@workspace/mobile`. All
four workflow servers come up cleanly (api:8080, admin:23744,
mobile:18115, tv:23876) with no errors. `/api/broadcast/current`
returns 200.


---

## Round 9 — Broadcast-Clean: All Up Next / Title Metadata Removed (Apr 25, 2026)

Per the directive to make the broadcast viewing experience read like a
real television channel, **every** "Up Next" label, video title, and
queue/preview metadata element has been removed from the live broadcast
surfaces across all platforms. The underlying `nextItem` data flow is
**preserved** — it still feeds the inactive A/B preload slot — it is
simply no longer surfaced to the viewer.

### Surfaces stripped of titles & queue metadata

1. **Mobile cinematic hero** (`artifacts/mobile/app/(tabs)/index.tsx`):
   `BroadcastUpNext` component definition + render site removed. The
   hero now shows only the live preview video, branded subtitle, and
   the "Watch Temple TV" CTA — no "Up Next: <title>" chip.

2. **Mobile broadcast info strip** (`artifacts/mobile/components/BroadcastInfoStrip.tsx`):
   Reduced to the bare TV-channel affordances: `NOW ON AIR` dot +
   `TEMPLE TV` channel badge. The previous "Up Next: <title>" line
   under the badges is gone. Component left in the tree so the
   gradient + safe-area math driving player chrome stays stable.

3. **Mobile player chrome** (`artifacts/mobile/app/player.tsx`):
   In `isBroadcastMode`, `displayTitle` is forced to `"Temple TV Live"`,
   `displayPreacher` to `"JCTM Broadcast"`, and `displayDuration` /
   `displayCategory` to empty strings. The native player chrome,
   share sheet, and on-screen title section all read as the channel
   identity instead of leaking the currently airing sermon name.
   The VOD `nextSermon` "Up Next" auto-play banner is also gated
   with `!isBroadcastMode` defensively.

4. **TV HLS player** (`artifacts/tv/src/components/HlsVideoPlayer.tsx`):
   In `isLive` mode, the top control bar's `<h2>{title}</h2>` is
   replaced with a `flex: 1` spacer. Back button, quality badge, and
   fullscreen control remain pinned in place.

5. **TV YouTube player** (`artifacts/tv/src/pages/Player.tsx`):
   Same treatment — the title `<h2>` in the top overlay is gated with
   `!isLive`. VOD playback still shows the title; live broadcast does
   not.

6. **TV Live Hero** (`artifacts/tv/src/components/LiveHero.tsx`):
   The dynamic `{liveStatus?.title ?? "Temple TV Live Stream"}` is
   replaced with a hardcoded `Temple TV Live Stream` heading. The
   landing page now reads as a channel-identity tease, not as a
   sermon-specific landing.

### NOT touched (intentionally)

- `artifacts/tv/src/pages/VideoDetails.tsx` — VOD library page, not a
  broadcast surface. Its "Up Next" related-videos panel is part of the
  on-demand catalog UX, not live-channel UX.
- `artifacts/mobile/app/(tabs)/guide.tsx` — schedule/EPG page; users
  explicitly come here to see what's airing and what's next.
- `artifacts/mobile/app/(tabs)/radio.tsx` — radio station queue UI;
  audio-station context, not broadcast-channel context.
- `artifacts/mobile/app/player.tsx` line 1085 region — the VOD
  related-sermon auto-play banner is now gated with `!isBroadcastMode`
  but otherwise preserved for VOD playback.

### Verification

TypeScript clean on `@workspace/mobile` and `@workspace/tv`
(`tsc --noEmit` produces no output). All four workflow services start
cleanly (api:8080, admin:23744, mobile:18115, tv:23876).
`nextItem` continues to flow through the broadcast SSE / current-tune
pipeline so the A/B inactive-slot preload (Round 7) still primes the
next program before the active video ends — the viewer still gets a
black-frame-free transition (Round 8), they just no longer see a text
hint that the transition is coming.

---

## Round 9b — Real-Broadcaster Channel Bug (Apr 25, 2026)

Re-introduced station identity *the right way* after Round 9 stripped all
title metadata from broadcast surfaces. A discreet "TEMPLE TV" watermark
now sits in the bottom-right corner of every live playback surface and
fades in **3 seconds after each program change** — the convention used
by real TV networks (NBC peacock, CBS eye, ESPN logo, CNN bug) where
the station mark eases in once the new program has settled on screen,
not the moment the cut happens.

### What was added

1. **`artifacts/tv/src/components/BroadcastChannelBug.tsx`** (new) —
   TV/web watermark component. Pure-CSS opacity transition, glassy
   `rgba(0,0,0,0.42)` chip with `backdrop-filter: blur(8px)`, white
   "TEMPLE TV" wordmark + tiny `#FF0040` live-dot. Resets fade on
   `programKey` change, fades in over 700ms after a 3000ms grace
   period. `pointer-events: none` and `z-index: 5` so it never
   intercepts remote-control focus and always sits below the chrome
   overlay (`z-index: 10`).

2. **`artifacts/mobile/components/ChannelBug.tsx`** (extended) —
   Added a new `mode="watermark"` variant that mirrors the TV
   behaviour (3s delay, 700ms fade, no pulse) for React Native. The
   legacy `mode="chrome"` (default) keeps the existing pulsing badge
   untouched so `(tabs)/radio.tsx` continues to render exactly as
   before. New `programKey` prop is the program identifier the
   watermark watches.

### Where it's mounted

- **`artifacts/tv/src/components/HlsVideoPlayer.tsx`** — `{isLive && <BroadcastChannelBug programKey={hlsUrl} />}`
  rendered alongside the A/B `<video>` slots. The HLS URL change is
  exactly the same signal that drives the A/B preload swap (Round 7),
  so each new program automatically gets its own grace period before
  the bug re-fades in.

- **`artifacts/tv/src/pages/Player.tsx`** YouTubePlayer — `{isLive && <BroadcastChannelBug programKey={videoId} />}`
  for live YouTube broadcasts. Sits above the iframe/loading veil
  inside the same fixed-position container.

- **`artifacts/mobile/app/player.tsx`** — Removed the legacy top-right
  chrome `ChannelBug` (the LIVE badge already conveys "this is live"
  in the chrome) and replaced it with a bottom-right watermark
  rendered inside the `playerContainer` whenever `isBroadcastMode`
  is on. `programKey={tunedVideoId ?? tunedLocalVideoUrl ?? ""}` so
  the SSE/15s-poll/precision-timer that mutates the tuned slots
  drives the fade reset on each queue advance.

### Visual spec

- Position: bottom-right, `clamp(16px, 2.4vw, 28px)` inset on TV;
  fixed 14px on mobile.
- Background: `rgba(0,0,0,0.42)` + 8px blur + 1px `rgba(255,255,255,0.18)` border.
- Wordmark: white "TEMPLE TV", weight 700, 0.14em letter-spacing,
  `clamp(10px, 1.05vw, 13px)` on TV / 10px on mobile.
- Live-dot: `#FF0040` (the same accent the LIVE badge uses), 7-8px
  with a soft red glow.
- Final opacity: 0.7 — visible but never competing with the video.
- Fade-in: 700ms ease-out after a 3000ms delay. Fade-out is
  effectively instant on program change (key resets `opacity: 0`),
  matching how real broadcasters drop the bug between program
  segments.

### What this does NOT change

- The Round 9 "no-titles, no-up-next" directive is fully preserved —
  the watermark is a *station* identifier, not a *program* one. It
  shows the channel brand, never the sermon name.
- The underlying `nextItem` data continues to flow through the SSE /
  current-tune pipeline so the A/B inactive-slot preload still primes
  the next program (Round 7) and Round 8's black-frame-free swap
  still wins.

### Verification

TypeScript clean on `@workspace/mobile` and `@workspace/tv`. All four
workflow services start cleanly (api:8080, admin:23744, mobile:18115,
tv:23876).
