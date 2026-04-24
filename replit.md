# Temple TV (JCTM) Broadcasting Platform

## Overview

Temple TV (JCTM) is an enterprise-grade broadcasting platform offering a comprehensive media experience. It includes a cross-platform mobile app, a Smart TV web app, an admin dashboard, and a Node.js/Express API backend. Key capabilities include Live TV, Video-on-Demand (VOD) sermon library, 24/7 Radio mode, push notifications, offline video downloads, adaptive streaming, subscription management, user authentication, and a unified real-time broadcast synchronization system across all platforms. The platform aims to deliver a seamless and engaging content consumption experience.

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
- **Micro-frontend Approach:** Separation of concerns with distinct artifacts for mobile (`artifacts/mobile`), Smart TV (`artifacts/tv`), and admin (`artifacts/admin`).
- **Data Persistence:** PostgreSQL with Drizzle ORM for database management.
- **API Framework:** Express 5 for the backend API.
- **Validation:** Zod for schema validation.
- **Monorepo Management:** `pnpm` for package management and workspace organization.
- **Cross-Platform Mobile:** Expo (React Native) with `expo-router` for mobile development.
- **Admin Dashboard:** React/Vite for the administrative interface.
- **Adaptive Streaming:** HLS transcoding (FFmpeg) with adaptive bitrate (ABR) streaming for uploaded videos, served via Replit Object Storage (GCS). The transcoding pipeline (`artifacts/api-server/src/lib/transcoder.ts` + `lib/ffmpeg.ts`) is hardened for enterprise reliability:
    - **Boot-time preflight** (`assertFfmpegAvailable`) resolves and caches the `ffmpeg`/`ffprobe` binary paths once at server startup, honors `FFMPEG_PATH`/`FFPROBE_PATH` env overrides, and fails loud with an actionable error if either binary is missing.
    - **Strict input validation** (`validateAndProbeInput`) probes container + all streams before the encoder is initialized, throwing a `TerminalTranscodeError` for corrupt files / no video stream / invalid dimensions / zero duration / sub-1KB uploads. Terminal errors skip retries — they're permanent failures of the asset, not the system.
    - **Idle + wall-clock watchdogs** (`runFfmpeg`) kill any ffmpeg process that goes silent for 90s or exceeds a per-encode wall-clock cap (clamped between 5 min and 4 h, scaled by source duration). Kills are SIGTERM with a 5s grace before SIGKILL. Eliminates hung-encoder zombies.
    - **Atomic job claiming** uses Postgres `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING *` so multiple workers (or future multi-instance deployments) can never claim the same row.
    - **Per-variant fallback**: a single quality variant failure is logged, its partial output cleaned up, and the remaining ladder continues; the job only fails if ZERO variants are produced.
    - **Auto-retry with exponential backoff**: transient failures schedule `nextRetryAt = now + 30s/1m/2m...` (capped at 15m) for up to `maxAttempts` (default 3). The `startRetryTick` interval (30s) wakes the worker so backoff retries fire even with no new uploads. Crash-recovery (`resumePendingJobsOnStartup`) decrements `attempts` so an interrupted attempt doesn't burn the retry budget.
    - **Partial-success transparency**: jobs that succeed with a degraded ladder record `Partial: produced N/5 variants (skipped …)` in `errorMessage` so admins see degradation in the queue UI.
- **Caching:** Dual-layer Redis/in-memory caching for API responses and YouTube data, with transparent fallback.
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
    - **Auth-Gated Playback:** Non-authenticated viewers are blocked from video playback on every surface; the gate is presented as a polished modal (never a hard redirect) and the user's intended video is preserved through sign-up so they resume on the exact sermon they tapped.
        - **Backend:** Three device-link endpoints (`/api/auth/device-link/{create,claim,exchange}`) backed by the `device_link_codes` table — 8-char codes (ABCD-1234, unambiguous alphabet), 10-min TTL, single-use. Implemented in `artifacts/api-server/src/routes/device-link.ts`.
        - **Mobile:** Module-level binder (`artifacts/mobile/utils/auth-gate.ts`) lets non-React utilities like `navigateToSermon` consult live auth state without becoming hooks. `AuthContext` exposes `openAuthGate / pendingPlayback / consumePendingPlayback`. The gate modal (`components/AuthGateModal.tsx`) is mounted at the root in `_layout.tsx`. Login + signup screens consume the pending target on success and resume playback. A defensive `useEffect` in `app/player.tsx` re-gates deep links / shared URLs landing on the route directly. `/link` page lets the user pair their TV by entering the on-screen code.
        - **TV:** Minimal localStorage auth (`artifacts/tv/src/lib/auth.ts`) with subscriber pattern. `App.tsx` funnels every `onPlay` through `gatedPlay()`. The TV `AuthGateModal` POSTs `/create`, displays the code at couch-readable scale (>5rem), and polls `/exchange` via a ref-managed recursive `setTimeout` (one in-flight poll, no leakage). Auto-regenerates on expiry with a `creatingRef` guard preventing overlapping creates.
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
3. Wrapped the four raw-fetch sites in retry: `pages/broadcast.tsx`, `pages/videos.tsx`, `components/command-palette.tsx` (each had an identical local `adminFetch` helper — retry now applied only to GET/HEAD), and `pages/live-monitor.tsx fetchHealth`.

**Auth-probe hardening (security fix flagged by code review):**

The first review caught an auth-bypass class: the two startup probes (`auth-gate.tsx probeAdminAccess` and `admin-key-dialog.tsx verifyAdminToken`) treated any `res.ok` as success without parsing the body. Combined with `fetchWithTransientRetry`'s JSON-content-type bypass, an HTML response mislabelled as `application/json` could theoretically have let an unauthenticated user past the gate.

- `auth-gate.tsx probeAdminAccess`: replaced raw fetch with `adminGet<unknown>("/admin/stats")`. The central client already does real `safeJson` parsing, so an HTML body throws `AdminApiError` and the probe correctly maps to `server-down` rather than returning `{ kind: "ok" }`. Catch branch maps `AdminApiError.status` to existing `GateState` shapes (401 → `needs-token`, 503 → `server-misconfigured`, 0 → `server-down`).
- `admin-key-dialog.tsx verifyAdminToken`: cannot use `adminGet` because it must verify a token the operator just typed (not yet stored in localStorage). Kept `fetchWithTransientRetry` for retry behavior, but added an explicit `text() → JSON.parse → typeof === "object"` check inside the `res.ok` branch. Parse failure or non-object shape returns `{ ok: false }` with a clear message rather than passing the verification.

**Architect review:** First pass FAIL (missed the two auth probes); second pass FAIL (caught the auth-bypass class on the JSON content-type bypass); third pass **PASS** confirming the auth probes now require parseable JSON success responses and eliminating the false-positive auth path on proxy/SPA fallback responses.

**Coverage claim:** Survey of `await fetch(` across `artifacts/admin/src` now shows only `services/adminApi.ts` itself (already retry-protected) and `components/VideoUploadModal.tsx` (chunk PUTs, intentionally never retried since they are mutating).

## External Dependencies

- **Database:** PostgreSQL
- **ORM:** Drizzle ORM
- **Cloud Storage:** Google Cloud Storage (Replit Object Storage)
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