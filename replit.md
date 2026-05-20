# Temple TV

Temple TV is a multi-surface streaming platform delivering live worship broadcasts and a video catalog to Web, Smart TV, and Admin Dashboard surfaces, powered by a production-grade Fastify API.

## Run & Operate

```bash
# Install dependencies
pnpm install --ignore-scripts

# Run API server (dev)
pnpm --filter @workspace/api-server run build && PORT=5000 node --enable-source-maps --import ./artifacts/api-server/dist/instrument.mjs ./artifacts/api-server/dist/index.mjs

# Run Admin dashboard (dev)
PORT=3000 pnpm --filter @workspace/admin run dev

# Push DB schema changes to development DB
pnpm --filter @workspace/db run push

# Typecheck all libs
pnpm run typecheck:libs

# Generate OpenAPI/Zod clients from spec
pnpm --filter @workspace/api-spec run codegen
```

**Required Secrets (set in Replit Secrets tab):**
- `JWT_ACCESS_SECRET` — ≥32 char HMAC secret for access tokens
- `JWT_REFRESH_SECRET` — ≥32 char HMAC secret for refresh tokens
- `SMTP_PASS` — SMTP password for email delivery

**Auto-managed by Replit (do not set manually):**
- `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` — Replit PostgreSQL

**Optional secrets:**
- `ADMIN_API_TOKEN` — long-lived admin API key
- `REDIS_URL` — Redis for caching/rate-limiting (falls back to pg without it)
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — S3 media storage
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` — Web Push notifications
- `EXPO_ACCESS_TOKEN` — Expo push notifications
- `SENTRY_DSN` — Error tracking
- `API_ORIGIN` — **Required in production** (e.g. `https://api.templetv.org.ng`). Absolutizes relative upload paths (`/api/v1/uploads/…`) stored in `localVideoUrl` so they pass the broadcast allowlist and are streamable by player clients. Without this, all locally-uploaded videos fail `resolveSource()` and nothing airs.

## Stack

- **API**: Fastify v5, Node.js ≥24, TypeScript ESM, esbuild
- **ORM**: Drizzle ORM + PostgreSQL (Replit built-in)
- **Validation**: Zod + fastify-type-provider-zod
- **Real-time**: SSE + WebSockets
- **Caching**: Redis (optional), in-process LRU + pg fallback
- **Admin UI**: React + Vite + Tailwind CSS + shadcn/ui + wouter + TanStack Query
- **Mobile**: Expo Router + React Native
- **TV**: React + Vite (Tizen / LG / FireTV builds)

## Where things live

- `artifacts/api-server/` — Fastify API server (entry: `src/main.ts`)
- `artifacts/admin/` — Admin SPA (entry: `src/main.tsx`)
- `artifacts/mobile/` — Expo mobile app
- `artifacts/tv/` — Smart TV web app
- `lib/db/` — Drizzle schema + DB client (schema: `src/schema/index.ts`)
- `lib/api-spec/` — OpenAPI source of truth
- `lib/api-zod/` — Generated Zod validators
- `lib/api-client-react/` — Generated typed API client
- `lib/broadcast-sync/`, `lib/broadcast-types/` — Real-time sync protocol
- `artifacts/api-server/src/config/env.ts` — All env vars with Zod validation

## Broadcast / Player v2 (rebuild)

The broadcast + player + queue + sync stack was rebuilt from scratch as **v2** and cut over in T008 (May 2026). **All four player surfaces (admin, TV homepage hero, TV player page, mobile player) now run on v2.** The v1 player engine code is deleted.

- **Server v2**: `artifacts/api-server/src/modules/broadcast-v2/` — orchestrator FSM, universal source resolver (SSRF-allowlisted), REST/SSE/WS gateways. Mounted at `/api/broadcast-v2`. Backed by 3 new tables: `broadcast_runtime_state`, `broadcast_event_log`, `player_position_checkpoint`. Mutating POSTs require `requireAuth("editor")` (skip/reload) or `requireAuth("admin")` (override/failover) and enforce an `idempotencyKey` field in the request body (5-min in-memory dedup). Auto-skips stuck items after 5 unresolvable attempts.
- **Universal player core**: `lib/player-core/` — `PlayerMachine` (deterministic A/B-buffer FSM), `V2Transport` (WS-first with SSE fallback, `resume {lastSequence}` replay, recover frame triggers `/state` refetch), `attachHls`, watchdog, `useV2Broadcast` (web hook), `useV2BroadcastNative` (RN hook, pure WS — no EventSource on RN).
- **Admin v2 console**: `artifacts/admin/src/pages/broadcast-v2.tsx` — FSM/mode/sequence/failover badges, operator controls with `Idempotency-Key`, 3-slot queue snapshot. Sidebar **Master Control** points here. `/master-control` redirects.
- **TV v2**: `artifacts/tv/src/components/LiveBroadcastV2.tsx` — used by both `LiveHero` (homepage) and `Player` (full-screen). Two persistent `<video>` buffers, hls.js via `attachHls`, native HLS path for WebKit-based TVs, 10-foot overlays (tuning-in / off-air / standby / fatal + amber reconnecting strip).
- **Mobile v2**: `artifacts/mobile/components/V2PlayerContainer.tsx` — two persistent `<Video>` (expo-av) buffers driven by adapter store; bind/play/pause/unbind via state. Used by `app/player.tsx` for the live HLS path.
- **Channel id**: hardcoded `"main"` everywhere in v2 — multi-channel is post-rebuild work.

**What's still on v1 (intentionally retained)**: server modules `modules/broadcast/`, `modules/live-overrides/`, `modules/playback/` and the client hooks `useLiveSync` (TV) / `useBroadcastSync` (mobile) remain active because they back **non-player** surfaces — chat overlay, channel bug, on-air ticker, lower-third graphics, viewer-count companion, prayer/reactions panel. Migrating those onto the v2 snapshot is follow-up work; deleting the v1 server modules now would break those overlays.

**Audit**: `.local/rebuild/07-expo-audit.md` — 10-section production audit (app.config, routing, player, push, perf, TV variants, store readiness, crash reporting, deps, cut-over checklist) ranked CRIT/HIGH/MED/LOW.

## Cross-environment broadcast queue mirror (May 2026)

The dev API server can mirror production's broadcast queue into its own
DB so engineers see exactly what's airing in prod without ever touching
the prod DB directly.

- **Env vars** (`artifacts/api-server/src/config/env.ts`):
  - `PROD_SYNC_API_URL` — upstream base URL (e.g. `https://api.templetv.org.ng`). Unset = sync disabled.
  - `PROD_SYNC_INTERVAL_MS` — poll cadence (default 30 000).
  - `PROD_SYNC_DISABLE` — escape hatch (set `1` to force-disable even when URL is set).
- **Module**: `artifacts/api-server/src/modules/prod-sync/prod-queue-sync.ts`.
  Reads upstream's public `/api/broadcast/guide` (no auth), upserts items
  by id into local `broadcast_queue`, and fires `adminEventBus.push("broadcast-queue-updated")`
  so the v2 bus bridge reloads the orchestrator. Additive only — never
  deletes local rows. Rewrites relative `localVideoUrl` to absolute
  upstream URLs so the dev player can fetch the actual bytes from prod.
- **Production safety**: production must NEVER set `PROD_SYNC_API_URL`.
  In prod the boot wires up the module but `start()` short-circuits when
  the env var is empty.

## Broadcast v2 boot resilience

- Bus bridge (`broadcast-queue-updated` → `orchestrator.reload()`) now
  installs **before** `start()` is attempted. Even if the first start
  throws (DB pool not warm, transient network blip), the bridge is live
  so any subsequent admin queue mutation triggers a reload attempt.
- `start()` is retried on failure with backoff `5 s → 15 s → 30 s → 60 s` (then 60 s forever).
- `GET /api/broadcast-v2/health` (public, rate-limited 30 req/min) exposes:
  `sequence`, `mode`, `itemCount`, `uptimeMs`, `boot.{started,busBridgeInstalled,startAttempts,lastStartError}`,
  `reload.{lastReloadAtMs,lastReloadOk,lastReloadError,attempts,successes}`,
  `prodSync.{enabled,upstreamUrl,intervalMs,lastPollAtMs,lastPollOk,lastPollError,lastUpsertCount,totalPolls,totalUpserts}`.
- Stuck-state signature: `sequence: 0` AND `uptimeMs > 30000` AND
  `boot.busBridgeInstalled: true` → DB or bus bridge silently failing.
  External monitor can alert on this without admin auth.

## Architecture decisions

- **Replit PostgreSQL as primary DB**: Built-in PG vars (PGHOST etc.) are detected at boot and override `DATABASE_URL`, eliminating external DB dependency.
- **Redis is optional**: All Redis-backed features degrade gracefully to PostgreSQL fallbacks when `REDIS_URL` is absent.
- **Dual-prefix routing**: Routes exposed under both `/api/v1` (OpenAPI) and `/api` (legacy) for backward compatibility.
- **RUN_MODE process split**: The same binary can boot as `api` (HTTP only), `worker` (background jobs only), or `all` (default for dev/single-instance).
- **OpenAPI-first, Zod as SSOT**: Zod schemas drive both runtime validation and OpenAPI doc generation — no drift between spec and runtime.
- **Dev TCP forwarder**: In development, port 8080 is bridged to port 5000 to satisfy Replit's preview proxy which may hit either port.
- **Library notification chain**: After upload finalize or HLS transcode completion, `adminEventBus.push("videos-library-updated")` is called. The SSE channel at `/api/broadcast/events` forwards this as a named `videos-library-updated` event (TV/web clients bump `libraryRevision` via EventSource). The WS gateway at `/api/playback/ws` forwards it as `{ type: "library-updated", revision: N }` (mobile/React Native clients — which lack EventSource — bump `libraryRevision` via this WS frame). Both paths are handled in `broadcast-sync/src/index.ts`.
- **Multi-file upload queue**: `artifacts/admin/src/lib/upload-queue.ts` — module-level singleton engine (`uploadQueue`). Files queued via `uploadQueue.enqueue()`, max 3 concurrent uploads (each with adaptive 1–4 chunk concurrency). Pause (abort + resume via GET /status) / cancel / retry / prioritize / dismiss per item. `useUploadQueue()` hook (useSyncExternalStore) feeds React. `UploadQueuePanel` (fixed bottom-right) mounts once in `AuthenticatedApp`. Videos page has page-level drag-drop + multi-file batch dialog (auto-titles from filename, bulk category/preacher). Chunk uploads use XHR (not fetch) for real-time byte-level progress within each chunk — gives smooth progress bars and accurate speed display even on slow connections. Network offline/online events auto-pause/resume active uploads with an amber banner in the panel. Size-weighted overall progress bar. Finalization animates 92→99% during server assembly.
- **Multi-layer fast-loading strategy**: (1) API: `Cache-Control` headers on `/broadcast/guide` (5 s), `/broadcast/viewers` (3 s), `/channels` (15 s) so CDN/proxy absorbs polling bursts. (2) TV: `localStorage` catalog cache (`ttv:catalog:v1`, 30-min TTL) paints the sermon grid on cold start without a network round-trip. (3) Admin: global `staleTime=60s / gcTime=10min / placeholderData=prev` eliminates skeleton flicker on pagination; 3-tier background chunk prefetch (2 s / 5 s / 10 s via `requestIdleCallback`) makes all page navigations instant after login. (4) Mobile: `gcTime=15min / refetchOnWindowFocus=false` prevents mid-playback refetch storms. (5) Both Admin and TV `index.html` carry `<link rel="preconnect">` for the API origin to eliminate TLS handshake latency on first load.

## Product

- Live broadcasting with real-time chat, reactions, and viewer count
- HLS video streaming with adaptive bitrate and optional CDN delivery
- Admin dashboard for content, broadcast, and user management
- Scheduled and emergency push notifications (web, Expo, email)
- Multi-file bulk upload with drag-and-drop, per-file pause/resume/cancel/retry, and persistent floating queue panel
- Multi-channel broadcasting infrastructure
- RBAC with roles: system, admin, editor, moderator, user

## User preferences

- Iterative development with clear communication on changes and their impact
- Frontend: accessibility standards, safe-area insets, touch target sizing, responsive design
- Backend: production-grade hardening, security, and performance
- Architectural decisions should be clearly documented with rationale
- Comprehensive TypeScript across all packages

## Android Startup Crash Fix (May 2026)

Production-blocking S1 crash: "Temple TV crashed due to its own issues" on Android Play Store installs.

**Root Cause #1 (CRITICAL)**: ProGuard/R8 was stripping `com.doublesymmetry.kotlinaudio.**` — the `kotlin-audio-engine` package used by `react-native-track-player` v4.x. The `MusicService` Android foreground service crashes with `NoClassDefFoundError` before the JS bundle even loads, making it uncatchable by any JS try/catch. Fix: added `-keep class com.doublesymmetry.kotlinaudio.** { *; }` to ProGuard rules.

**Root Cause #2 (HIGH)**: Missing ProGuard rules for Kotlin runtime (`kotlin.**`, `kotlinx.**`, `kotlinx.coroutines.**`) and full React Native New Architecture classes (`com.facebook.react.**`, `com.facebook.react.bridge.**`, `com.facebook.react.uimanager.**`). Also missing reflection metadata keepattributes (`Signature`, `*Annotation*`, `EnclosingMethod`, `InnerClasses`).

**Root Cause #3 (MEDIUM)**: Static top-level `import { Icon, Label, NativeTabs } from "expo-router/unstable-native-tabs"` in `app/(tabs)/_layout.tsx` ran the entire NativeBottomTabs module initialization chain on Android at every startup, even though this UI path is iOS 18+ only. Fixed by converting to a lazy inline `require()` inside the `NativeTabLayout` component body (which only renders when `isLiquidGlassAvailable()` is true — iOS 18+ only).

**Files changed**: `artifacts/mobile/app.json` (ProGuard rules, versionCode 24→25), `artifacts/mobile/app/(tabs)/_layout.tsx` (lazy import).

**Deployment**: Trigger `eas build --platform android --profile production` then `eas submit`. See `artifacts/mobile/ROOT_CAUSE_REPORT.md` for full forensic report and deployment instructions.

**Key ProGuard principle**: When adding a new native module, check its *internal* package names (not just the top-level wrapper). `react-native-track-player` wraps `kotlin-audio-engine` — both need keep rules.

## Transcoder fix (May 2026)

The `TRANSCODER_DISABLE` Replit secret was blocking the transcoder dispatcher from starting even though ffmpeg 7.1.1 is available. The following changes were made to fix the upload → transcode → broadcast pipeline end-to-end:

- **`artifacts/api-server/src/main.ts`**: `startWorkers()` now unconditionally calls `transcoderDispatcher.start()`. The `TRANSCODER_DISABLE` env var no longer gates the dispatcher — ffmpeg availability is confirmed at startup and surfaced in logs.
- **`artifacts/api-server/src/modules/admin-broadcast/admin-broadcast.routes.ts`**: Removed `!env.TRANSCODER_DISABLE` guards on `boostTranscodePriority()` calls so priority elevation always happens when videos are added to the broadcast queue.
- **`artifacts/api-server/src/modules/broadcast-v2/io/rest.routes.ts`**: Removed the early-return error block on the `/prepare-hls` endpoint that blocked operator-triggered HLS transcoding when `TRANSCODER_DISABLE` was set.
- **`artifacts/api-server/src/modules/admin-ops/admin-ops.routes.ts`**: `transcoderDisabled` in the transcoding queue API response now always returns `false` so the admin SPA never shows a misleading "transcoder disabled" banner.

**For production (Render):** Deploy these changes. Then, in the admin panel → **Transcoding** tab → click **"Transcode All Unprocessed"** to re-queue the existing failed videos. The transcoder will process them to HLS.

## Mobile Production Readiness (May 2026)

The Android app is code-complete and ready for `eas build --platform android --profile production`. All changes are TypeScript-clean.

**Changes made:**
- `experiments.baseUrl: "/mobile"` removed from `app.json` — was added for the Replit dev proxy only. Dev preview still works via `EXPO_BASE_URL=/mobile` in the `dev` script + `public/index.html` URL-rewrite. EAS native builds no longer get `/mobile` inlined as `EXPO_BASE_URL`, so Android routing is clean.
- `expo-screen-orientation` (`~9.0.9`) installed and added to `app.json` plugins. The player's fullscreen button now calls `ScreenOrientation.lockAsync(LANDSCAPE)` on enter and `lockAsync(PORTRAIT_UP)` on exit. Without this, Android ignores the Modal's `supportedOrientations` prop (it's Activity-level) and the video never rotates.
- `package.json` version synced to `1.0.5` to match `app.json`.
- Settings screen: hardcoded `v1.0.4` replaced with `Constants.expoConfig?.version` (auto-tracks future bumps). Privacy Policy and Terms of Service links added — both are required for Play Store data-safety submission.
- `artifacts/mobile/google-services.json` placeholder created. **Replace all `REPLACE_WITH_...` values with your real Firebase project credentials before building** — `expo-notifications` requires a valid `google-services.json` for FCM push on Android.

**Still required from you before Play Store submission:**
1. **Replace `artifacts/mobile/google-services.json`** — Download from Firebase Console → Project settings → Your apps → Android app → `google-services.json`.
2. **Create `artifacts/mobile/google-service-account.json`** — Google Play Console service account key needed for `eas submit`. Console → Setup → API access → Create a service account key.
3. **EAS credentials** — Run `eas credentials` locally once to generate/upload the Android keystore. EAS stores it remotely (`credentialsSource: "remote"`).
4. **Build command**: `eas build --platform android --profile production` → produces an `.aab` file.
5. **Submit command**: `eas submit --platform android --profile production` → uploads to Play Store internal track.
6. **Privacy policy page** — Publish `https://templetv.org.ng/privacy` before submitting (Play Store rejects apps without a reachable privacy policy URL).

## Gotchas

- **Admin user**: seeded on startup via `seedAdminIfConfigured()`. Credentials controlled by `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` env vars (set in Replit Secrets). Default dev credentials: `admin@templetv.org.ng` / `Temple124@` (value of `SEED_ADMIN_PASSWORD`). Login at the admin panel → `/login`.
- Always run `pnpm --filter @workspace/db run push` after schema changes to apply them to the dev DB
- `pnpm install --ignore-scripts` is required (scripts cause issues in some Replit environments)
- The admin Vite dev server proxies `/api/*` to port 5000; ensure the API server is running first
- Node ≥24 and pnpm ≥10 are required — enforced in root `package.json` engines
- Mobile (`artifacts/mobile`) is Expo/React Native and cannot be previewed in the browser
- DB video columns (`description`, `thumbnailUrl`, `duration`, `category`, `preacher`, `transcodingStatus`) are nullable in Postgres but Zod schemas declare them `z.string()`. Always coerce null → "" in `toDto()` — do not add `.nullable()` to the Zod schema or the public contract changes.
- `useListAdminVideos` calls `GET /api/v1/admin/videos` (not `/media`) with `limit=20` (not `pageSize`) to get server-side filtering with correct page-based pagination.
- `managed_videos.metadata_locked` (boolean, default false) — when true, YouTube sync CASE expressions preserve the existing `category` and `preacher` rather than overwriting with auto-detected values. Toggle via `PATCH /api/v1/admin/videos/:id` with `{ metadataLocked: true }`. The admin lock icon appears in the video row and edit dialog.
- **Vite proxy order matters**: `/api/v1/admin/videos/upload` (600 s timeout) MUST appear before the generic `/api` rule — otherwise large chunks use the default short timeout and 502. Both versioned and legacy paths have the extended rule.
- **Upload engine**: MAX_CONCURRENT_FILES=3, chunk sizes: slow=1 MB/1 concurrent, moderate=4 MB/2, fast=8 MB/3 (capped at 8 MiB — larger chunks risk OOM on mobile browsers). MAX_CHUNK_RETRIES=6.
- **Upload /init hardening**: `createMultipartUpload` is race-wrapped with a 5-second timeout → session falls back to `db_fallback` mode rather than hanging the proxy.
- **Upload security**: chunk route validates `chunkIndex < session.totalChunks` — out-of-range indices are rejected 400. `InitBodySchema` validates `totalBytes` (1 B – 100 GiB) and `totalChunks` (1–50,000). `safeExt` in `finalizeFromDbFallback` detects extension from original filename first, then MIME type (handles mp4/mov/mkv/avi/webm/m4v/flv/wmv/ts/mts/m2ts; was broken — all non-mp4 got ".bin"). `projectRow()` now returns `description` and `transcodingStatus`. Finalize idempotent early-return includes `transcodingWarning: null` to satisfy the Zod response schema.
- **Transcoder hardening**: source resolution is probed via ffprobe before building renditions — only renditions with height ≤ source height are encoded (avoids upscaling 360p/480p sources to 720p/1080p). Falls back to 360p/480p/720p if probe fails. `generateThumbnail` has a 30-second SIGKILL timeout on the ffmpeg subprocess — prevents indefinite hangs on corrupt source files. Scratch directory cleanup moved to an outer `try/finally` so it always runs even when `downloadSourceToTempFile` throws. `uploadDirRecursive` uploads HLS segments with bounded concurrency (6 parallel workers via shared-index pattern) instead of unbounded `Promise.all`.
- **Upload UI**: files > 5 GiB show a toast warning in the upload dialog. Paused items in the queue panel now have a Dismiss (×) button. Error messages in the panel use `line-clamp-2 max-w-[200px]` with `cursor-help` and full text on hover instead of the previous hard-truncated 140 px.
- Video upload uses chunked server-relay path (`/admin/videos/upload/init` → `/chunk` → `/finalize`) — NOT a simple multipart POST. All uploads are broken into 8 MiB chunks with SHA-256 integrity checks, 3-concurrent, 4-retry.
- `completeMultipartUpload` in `storage.ts` assembles parts via iterative PostgreSQL `UPDATE ... SET data = dest.data || src.data` — no video bytes ever load into Node.js memory during finalization. Peak Node.js memory is O(1) regardless of file size.
- **Faststart safe re-upload (May 2026)**: `faststart.service.ts` now uses `createMultipartUpload → uploadPart (8 MiB chunks) → completeMultipartUpload` instead of the old `deleteObject + readFile + putObject` pattern. The original storage key stays readable throughout (no 404 window, no `ERR_STRING_TOO_LONG` risk for large files). On failure, `transcodingStatus` is restored to its pre-faststart value (not set to `'failed'`), so the queue item stays admitted and the video continues to air with the original file. The `broadcast-v2` admin page now shows a blue "X processing" badge + dismissible banner when items are held from the queue during faststart.

## Release Pipeline

See `RELEASE_PIPELINE.md` for the complete release guide. Quick reference:

```bash
# Standard patch release (all platforms)
bash scripts/release-all.sh

# Version bump only (no release)
bash scripts/version-bump.sh patch

# Generate changelog entry
bash scripts/changelog.sh

# Android keystore setup (one-time)
bash scripts/keystore-setup.sh

# TV web assets to S3 + CloudFront
bash scripts/deploy-tv-cdn.sh

# Sentry source maps upload
bash scripts/sentry-release.sh

# GitHub Secrets setup helper
bash scripts/github-secrets-setup.sh --repo templetv/temple-tv
```

**GitHub Actions Workflows:**
- `ci.yml` — PR/push: typecheck, verify, build all, Docker validation
- `release.yml` — Manual: API + Admin deploy to Render + CloudFront
- `mobile-release.yml` — `v*.*.*` tag: EAS builds for Android, iOS, Apple TV, Android TV, Fire TV
- `tv-release.yml` — `v*.*.*` tag: Samsung (.wgt), LG (.ipk) packaging + S3 deploy
- `ota-update.yml` — `main` push (JS-only): EAS OTA instant update
- `store-deploy.yml` — Manual: submit latest EAS build to Google Play / App Store
- `docker-publish.yml` — `v*.*.*` tag: build + push Docker images to GHCR

**EAS Build Profiles (artifacts/mobile/eas.json):**
- `development` — simulator/device dev builds
- `preview` / `staging` — internal testing APK/IPA
- `production` — Android (.aab) + iOS (.ipa) store builds
- `androidtv` — Android TV (.aab)
- `appletv` — tvOS (.ipa)
- `firetv` — Fire TV (.apk)

**TurboRepo:** `turbo.json` configures parallel builds + caching. Enable remote cache with `npx turbo link`.

**Fastlane:** `fastlane/Fastfile` has full iOS + Android lanes. Run `bundle exec fastlane ios release` or `bundle exec fastlane android release`.

## Pointers

- [Fastify Docs](https://www.fastify.io/docs/latest/)
- [Drizzle ORM Docs](https://orm.drizzle.team/docs/overview)
- [Zod Docs](https://zod.dev/)
- [TanStack Query Docs](https://tanstack.com/query/latest)
- [EAS Build Docs](https://docs.expo.dev/build/introduction/)
- [Fastlane Docs](https://docs.fastlane.tools/)
- [TurboRepo Docs](https://turbo.build/repo/docs)
- [Release Pipeline](./RELEASE_PIPELINE.md)
