# Temple TV — Changelog

All notable changes to Temple TV are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## Unreleased

---

## v1.0.24 — 2026-06-13

### Release Name
Latest update done in the mobile app

### Changed
- **Version bump**: Android `versionCode` 69 → 70, iOS `buildNumber` `202606131431`. Targets v1.0.24 release candidate.

### Fixed (Mobile)
- **Bare `console.warn` in production builds** — two unguarded calls in `hooks/useEmergencyAlerts.ts` (`.catch` handler) and `app/_layout.tsx` (push-opt-in registration failure) now wrapped with `if (__DEV__)`. Prevents diagnostic noise appearing in device logs and crash reporters on production Hermes builds.

### Fixed (Server / Infrastructure)
- **`MEMORY_RESTART_RSS_MB` missing from `docker-compose.prod.yml`** (critical): The env var was absent, so the watchdog defaulted to 768 MB which is below `MEMORY_WARN_RSS_MB=1500 MB` — causing the process to enter a restart loop on any normal HLS traffic. Fixed: `MEMORY_RESTART_RSS_MB=1800` added explicitly.
- **Memory limits raised across all deployment layers** to match production-grade hosts (≥ 2 GiB RAM):
  - `env.ts` defaults: `MEMORY_WARN_RSS_MB` 512 → 1024 MB, `MEMORY_RESTART_RSS_MB` 768 → 1536 MB.
  - Replit `Start API` workflow: `--max-old-space-size` 900 → 2048, `MEMORY_WARN` 1000 → 1500, `MEMORY_RESTART` 1400 → 2500.
  - Replit deployment run command: same values as workflow above.
  - `package.json` `start:prod`: `--max-old-space-size` 460 → 1536 MB; added `start:render-paid` script for paid Render plans.
  - Docker Redis: `maxmemory` 512 MB → 1 GB, container limit 600 MB → 1200 MB.
  - `main.ts` pre-flight: boundary for MEMORY_RESTART warning raised 600 → 800 MB.
- **`memory-watchdog.ts` comments** updated with accurate per-host-class sizing formulas (2 GiB, 4 GiB, constrained 512 MiB).
- **`render.yaml`** documents paid-tier upgrade path: switch `startCommand` from `start:render-free` → `start:render-paid` and adjust `HLS_MAX_CONCURRENT` / `MEMORY_*` env vars proportionally.

---

## v1.0.23 — 2026-06-13

### Fixed
- **"Tap to reconnect" had no effect on the video buffer** (critical, mobile): The button called `forceReconnect()` which only reconnects the WebSocket transport. When in `RECOVERING_PRIMARY`, the FSM re-issues `play` (not `bind`) on the next snapshot, so `bindRevision` never changes and `BroadcastBuffer` never reloads the video element — the player stayed frozen indefinitely. Fix: added `machine.requestManualRebind()` which resets `primaryRetries`, issues a fresh `bind + play` intent (incrementing `bindRevision` so `BroadcastBuffer` reloads), and transitions to `PREPARING_ACTIVE`. Exposed as `forceRebind()` from `useV2BroadcastNative`. All `onRetry` callbacks in the player overlay now call `forceRebind()` instead of `forceReconnect()`.
- **TV "Try Again" button had no effect** (critical, TV): The FATAL overlay "Try Again" button called `forceReconnect()` — same root cause as the mobile bug above. `forceReconnect()` only re-establishes the WebSocket; the machine stays in FATAL until the server sends a new snapshot advancing the queue. Fix: `useV2Broadcast` (web hook) now exposes `forceRebind()` which calls `machine.requestManualRebind()` + `transport.forceReconnect()`. The TV "Try Again" button is now wired to `forceRebind()`.
- **TV had no escape from `RECOVERING_PRIMARY`** (TV): The TV overlay showed "Tuning in…" indefinitely during recovery with no user action available — unlike mobile which gained a retry button at 5 s. TV RECOVERING overlays now show a "Try Again" button after 10 s of continuous recovery, giving viewers an immediate rebind trigger before auto-recovery escalates to FATAL (which can take 2–4 min across 3–4 retry cycles). `RECOVERING_FAILOVER` also shows "Switching to backup stream…" as a distinct label.
- **`RECOVERING_PRIMARY` mobile retry button appeared too late** (10 s → 5 s): The "Tap to reconnect" button was shown at `loadingPhase >= 2` (10 seconds of continuous recovery). Reduced to `loadingPhase >= 1` (5 seconds) so the user gets a real escape hatch before the automatic 8 s load-timeout cycles through all retry attempts.
- **Silent ExoPlayer load timeout too long** (12 s → 8 s): `LOAD_TIMEOUT_MS` reduced from 12 s to 8 s. When ExoPlayer silently fails to load a manifest (no `onLoad`, no `onError`), the FSM now escalates to the next retry attempt in 8 s instead of 12 s, reducing the maximum stuck-window from ~36 s to ~24 s across 3 retry cycles.
- **Mobile hero never showed current program title**: `broadcastTitle` (derived from the V2 FSM snapshot) was computed but never rendered. The hero now displays the live program title between the ON AIR badge row and the Watch Live button while a broadcast is active.

### Changed
- **Mobile version bump**: Android `versionCode` 68 → 70 (EAS auto-increments), iOS `buildNumber` `202606130001`. Targets v1.0.23 release candidate.

### Technical
- `lib/player-core/src/machine.ts`: added `public requestManualRebind()` — resets `primaryRetries`, `skipPendingCycles`, `skipPendingAnchorMs`, clears `fatalRecoveryTimer`, calls `bindActive()` + `emit play` + `transition PREPARING_ACTIVE`.
- `lib/player-core/src/react-native.ts`: added `forceRebind()` to `UseV2BroadcastNativeResult` interface and hook return. Calls `machine.requestManualRebind()` + debounced `transport.forceReconnect()`.
- `lib/player-core/src/react.ts`: added `forceRebind()` to `UseV2BroadcastResult` interface and hook return. Calls `machine.requestManualRebind()` + `transport.forceReconnect()`.
- `artifacts/mobile/components/V2PlayerContainer.tsx`: destructures `forceRebind` from hook; all `onRetry` overlay callbacks updated to `forceRebind`; LIVE_OVERRIDE_ACTIVE retains `forceReconnect` (rebinding would dismiss the admin override); `LOAD_TIMEOUT_MS` 12 s → 8 s.
- `artifacts/tv/src/components/LiveBroadcastV2.tsx`: destructures `forceRebind` from hook; FATAL "Try Again" wired to `forceRebind()`; `recoveringSecs` timer starts on RECOVERING entry and exposes "Try Again" at ≥ 10 s.
- `artifacts/mobile/app/(tabs)/index.tsx`: hero renders `broadcastTitle` when a broadcast is active; added `heroBroadcastTitle` style (18 pt bold white, text-shadow).

---

## v1.0.20 — 2026-06-12

### Changed
- **Mobile version bump**: Android `versionCode` 61 → 62, iOS `buildNumber` `202606120001`. Targets v1.0.20 release candidate.
- **EAS `production-android` autoIncrement**: changed from `false` → `true` so EAS automatically increments `versionCode` on subsequent production-android builds — no manual bump required after this release.

### Fixed
- **render.yaml SMTP defaults**: Added explicit `SMTP_SECURE: "false"` (STARTTLS, port 587) and `SMTP_FROM_NAME: "Temple TV | JCTM"` default values. Previously both were `sync: false` with no default, causing the production pre-flight to log them as missing variables on cold deployments where the Render dashboard hadn't been manually configured.
- **render.yaml queue/storage defaults**: Added `QUEUE_MIN_ITEMS: "5"` and `STORAGE_HEALTH_INTERVAL_MS: "120000"` as explicit values (was `sync: false`). Prevents the queue-health-guard and storage-health monitor from picking up undefined values on fresh deploys.
- **broadcast-v2 checkpoint deadlock guard**: `persistCheckpoint()` now races the DB write against a 45-second hard timeout. If a network partition or pg-proxy stall causes the pg statement to hang beyond `DB_STATEMENT_TIMEOUT_MS`, the `checkpointWriting` mutex is forcibly released so subsequent checkpoint intervals are not permanently blocked.

### Hardening (no user-visible change)
- All TypeScript targets (api-server, admin, libs) confirmed clean — zero errors.
- Broadcast-v2 health confirmed: `ok`, queue-mode, sequence advancing, SMTP verified on startup.

---

## v1.0.12 — 2026-05-29

### Changed
- **Version bump**: Android `versionCode` 48 → 49, iOS `buildNumber` `202605290001`. EAS production-android and production-ios profiles both carry `EXPO_PUBLIC_SENTRY_DSN` for consistent crash reporting.
- **EAS Node upgrade**: All EAS build profiles (development, development-device, preview, staging, production, production-ios, production-android, firetv, androidtv, appletv) upgraded from Node `20.18.0` → `22.14.0` (Active LTS). The `appletv` profile was also missing the `node` key entirely — added.

### Fixed
- **`apiBase.ts` console.warn in production builds**: Protocol auto-fix warning (`EXPO_PUBLIC_API_URL` missing `https://`) was emitted unconditionally in release builds. Guarded with `__DEV__` so it only surfaces during development; the auto-fix still applies silently in production.
- **`SEED_ADMIN_FORCE` production safety guard**: `main.ts` now emits a `logger.error`-level alert when `SEED_ADMIN_FORCE=true` is detected with `NODE_ENV=production`, making the destructive every-boot account wipe impossible to miss in production log aggregation. The behaviour is unchanged — set `SEED_ADMIN_FORCE=false` in production secrets to disable.
- **`PRELOAD_LEAD_MS` comment drift in broadcast orchestrator**: Comment said "Raised from 60 s → 90 s" and "so 90 s here is now the fallback window" while the constant was already `120_000` ms. Updated to "Raised from 90 s → 120 s" and "so 120 s here is now the fallback window" to match the code.

### Security / ProGuard
- **Firebase / GMS keep rules**: Added `-keep class com.google.firebase.**`, `-keep class com.google.android.gms.**`, and `-dontwarn` suppressions. Prevents R8 from stripping FCM receiver and Play-Services classes in minified production builds, which caused silent push-notification failures on some devices.
- **Enum safety rule**: Added `-keepclassmembers enum * { public static **[] values(); public static ** valueOf(java.lang.String); }` to prevent R8 from removing enum entries referenced only by reflection (affects media-session state enums in `kotlin-audio-engine`).
- **Parcelable creator rule**: Added `-keep class * implements android.os.Parcelable { ... }` to preserve generated `CREATOR` fields required by Android IPC / Intent extras.

### Fixed
- **production-ios Sentry DSN missing** from `eas.json`: `EXPO_PUBLIC_SENTRY_DSN` was set in `production` and `production-android` but absent from `production-ios`. Crash reports from iOS production builds were silently dropped. Now consistent across all production profiles.

### Reliability (server — carried from Unreleased)
- **SSRF allowlist hardening** in `broadcast-v2/resolver/universal-source-resolver.ts`: reject userinfo URLs (`http://user@host/`); deny private/loopback/link-local/CGNAT/multicast IPv4 literals; deny IPv6 loopback / ULA (`fc00::/7`) / link-local (`fe80::/10`). `localhost`/`127.0.0.1` permitted in dev/test only; gated by `NODE_ENV !== "production"`.
- **Reconnect storm mitigation**: `lib/player-core/src/transport.ts` `forceReconnect()` now jitters 0–300 ms before reopening the WebSocket.
- **Boot retry backoff fix**: `broadcast-v2/index.ts` `ensureBroadcastV2Started()` increments `startAttempts` only on actual start failure.
- **Upload finalize → orchestrator reload**: `chunked-upload.routes.ts` finalize now pushes `broadcast-queue-updated` alongside `videos-library-updated`.
- **AppState listener leak guard**: `V2PlayerContainer.tsx` adds a `mounted` flag so queued AppState `change` events flushed after unmount cannot poke transport methods.
- **Orientation lock race fix**: `app/player.tsx` `enterFullscreen` / `exitFullscreen` use an `orientationIntentRef` so a stale `LANDSCAPE` promise resolving after a quick back-tap re-applies the current intent (PORTRAIT_UP), eliminating the "home tab stuck in landscape" bug.
- **Prod-sync ghost sweep**: `prod-queue-sync.ts` tracks `lastSeenAtMs` per item id; items absent from upstream for >10 minutes are deactivated locally.

---

## v1.0.7 — 2026-05-22

### Added
- **Library / Broadcasting split**: server `GET /api/videos` accepts `?source=youtube|local` (cache bypass via `isFiltered`). Mobile `fetchVideos` / `usePaginatedVideos` / `library.tsx` pass `source:"youtube"`; TV `fetchVideos` does the same. Local uploads are now broadcasting-only; the public library shows YouTube only.

### Fixed
- **Android red-screen `Compiling JS failed`** on Replit canvas Expo simulator. Root cause: `services/notifications.native.ts:129` `require("../google-services.json")` was statically resolved by Metro, but the placeholder file had been removed. Metro then emitted a `TransformError` JSON payload as the bundle body, which Hermes choked on. Fix: restored `artifacts/mobile/google-services.json` placeholder (matching `com.templetv.jctm` package). EAS builds remain unaffected — `eas-build-pre-install.sh` overwrites with the real file from `GOOGLE_SERVICES_JSON_BASE64`.

---

## v1.0.5 — May 2026 — Android Production Readiness

### Fixed
- **Android startup crash** (Play Store installs): "Temple TV crashed due to its own issues".
  - **Root #1 (CRIT)**: ProGuard/R8 was stripping `com.doublesymmetry.kotlinaudio.**` (used by `react-native-track-player` v4.x). `MusicService` foreground service crashed with `NoClassDefFoundError` before the JS bundle loaded. Added `-keep class com.doublesymmetry.kotlinaudio.** { *; }`.
  - **Root #2 (HIGH)**: Missing ProGuard rules for Kotlin runtime (`kotlin.**`, `kotlinx.**`, `kotlinx.coroutines.**`) and full React Native New Architecture (`com.facebook.react.**`, `.bridge.**`, `.uimanager.**`). Also missing reflection metadata keepattributes (`Signature`, `*Annotation*`, `EnclosingMethod`, `InnerClasses`).
  - **Root #3 (MED)**: Static `import { Icon, Label, NativeTabs } from "expo-router/unstable-native-tabs"` in `app/(tabs)/_layout.tsx` ran NativeBottomTabs init chain on Android even though the path is iOS 18+ only. Converted to lazy `require()` inside `NativeTabLayout`.
  - Files: `artifacts/mobile/app.json` (ProGuard rules, `versionCode` 24→25), `artifacts/mobile/app/(tabs)/_layout.tsx`.
  - Forensic report: `artifacts/mobile/ROOT_CAUSE_REPORT.md`.
- **Key ProGuard principle**: when adding a new native module, check its *internal* package names — `react-native-track-player` wraps `kotlin-audio-engine`, both need keep rules.

### Changed (Mobile production readiness)
- Removed `experiments.baseUrl: "/mobile"` from `app.json` (was Replit-dev-proxy-only). Dev preview still works via `EXPO_BASE_URL=/mobile` in the `dev` script + `public/index.html` URL-rewrite. EAS native builds no longer get `/mobile` inlined.
- Installed `expo-screen-orientation` (`~9.0.9`) and added to `app.json` plugins. Player fullscreen calls `ScreenOrientation.lockAsync(LANDSCAPE)` on enter, `PORTRAIT_UP` on exit (Android ignores `Modal` `supportedOrientations` — it's Activity-level).
- `package.json` version synced to `1.0.5`.
- Settings screen: hardcoded `v1.0.4` replaced with `Constants.expoConfig?.version`. Added Privacy Policy and Terms of Service links.
- Created `artifacts/mobile/google-services.json` placeholder. Replace `REPLACE_WITH_*` values with real Firebase credentials before EAS builds.

### Required before Play Store submission
1. Replace `artifacts/mobile/google-services.json` (Firebase Console → Project settings → Android app).
2. Create `artifacts/mobile/google-service-account.json` (Play Console → Setup → API access → service account key).
3. Run `eas credentials` once to generate/upload the Android keystore.
4. `eas build --platform android --profile production` → `.aab`.
5. `eas submit --platform android --profile production`.
6. Publish privacy policy at `https://templetv.org.ng/privacy`.

---

## May 2026 — Transcoder fix

`TRANSCODER_DISABLE` Replit secret was blocking the transcoder dispatcher from starting even though ffmpeg 7.1.1 was available.

- `artifacts/api-server/src/main.ts`: `startWorkers()` unconditionally calls `transcoderDispatcher.start()`. `TRANSCODER_DISABLE` no longer gates the dispatcher.
- `artifacts/api-server/src/modules/admin-broadcast/admin-broadcast.routes.ts`: removed `!env.TRANSCODER_DISABLE` guards on `boostTranscodePriority()` calls.
- `artifacts/api-server/src/modules/broadcast-v2/io/rest.routes.ts`: removed early-return on `/prepare-hls` that blocked operator-triggered HLS transcoding.
- `artifacts/api-server/src/modules/admin-ops/admin-ops.routes.ts`: `transcoderDisabled` in the transcoding queue API response always returns `false`.

**Production action:** deploy these changes, then in admin panel → Transcoding tab → click "Transcode All Unprocessed" to re-queue existing failed videos.

---

## May 2026 — Broadcast v2 boot resilience

- Bus bridge (`broadcast-queue-updated` → `orchestrator.reload()`) now installs **before** `start()` is attempted. Even if the first start throws, the bridge is live so any subsequent admin queue mutation triggers a reload.
- `start()` retried on failure with backoff `5 → 15 → 30 → 60 s` (then 60 s forever).
- `GET /api/broadcast-v2/health` (public, rate-limited 30 req/min) exposes runtime/boot/reload/prodSync status.
- Stuck-state signature: `sequence: 0 && uptimeMs > 30000 && boot.busBridgeInstalled: true` → DB or bus bridge silently failing.

---

## May 2026 — Cross-environment broadcast queue mirror

Dev API can mirror prod's broadcast queue into its own DB. See `replit.md` "Cross-environment broadcast queue mirror" section and `artifacts/api-server/src/modules/prod-sync/prod-queue-sync.ts`. Additive-only by id; rewrites relative `localVideoUrl` to absolute upstream URLs. Production hard guard: refuses to mirror when `NODE_ENV === "production"`.

---

## May 2026 — Faststart safe re-upload

`faststart.service.ts` now uses `createMultipartUpload → uploadPart (8 MiB chunks) → completeMultipartUpload` instead of the old `deleteObject + readFile + putObject` pattern. The original storage key stays readable throughout (no 404 window, no `ERR_STRING_TOO_LONG` for large files). On failure, `transcodingStatus` is restored to its pre-faststart value rather than `'failed'`, so the queue item stays admitted and the video continues to air with the original file. The `broadcast-v2` admin page shows a blue "X processing" badge + dismissible banner when items are held from the queue during faststart.

---

## May 2026 — Upload pipeline hardening

- **`/init` hardening**: `createMultipartUpload` race-wrapped with a 5-second timeout → session falls back to `db_fallback` mode rather than hanging the proxy.
- **Upload security**: chunk route validates `chunkIndex < session.totalChunks`. `InitBodySchema` validates `totalBytes` (1 B – 100 GiB), `totalChunks` (1–50 000). `safeExt` in `finalizeFromDbFallback` detects extension from filename first, then MIME type — handles mp4/mov/mkv/avi/webm/m4v/flv/wmv/ts/mts/m2ts (was broken — all non-mp4 got `.bin`). `projectRow()` returns `description` and `transcodingStatus`. Finalize idempotent early-return includes `transcodingWarning: null` to satisfy the Zod response schema.
- **Transcoder hardening**: source resolution probed via ffprobe before building renditions — only renditions with height ≤ source height are encoded (avoids upscaling 360p/480p sources). Falls back to 360p/480p/720p if probe fails. `generateThumbnail` has a 30-second SIGKILL timeout. Scratch directory cleanup moved to outer `try/finally`. `uploadDirRecursive` uploads HLS segments with bounded concurrency (6 workers).
- **Upload UI**: files > 5 GiB show a toast warning in the upload dialog. Paused items have a Dismiss (×) button. Error messages use `line-clamp-2 max-w-[200px]` with `cursor-help` and full text on hover.

---

## v1.0.0 — 2026-05-07

### Added
- Multi-surface streaming platform: Web, Smart TV (Samsung Tizen + LG webOS), Admin Dashboard, Mobile (iOS + Android + Apple TV + Android TV + Fire TV)
- Live broadcasting with real-time SSE chat, emoji reactions, and viewer count
- HLS video streaming with adaptive bitrate and optional CloudFront CDN delivery
- Admin dashboard (React + Vite + shadcn/ui) with full content, broadcast, and user management
- Scheduled and emergency push notifications via Web Push (VAPID), Expo, and SMTP email
- Multi-file bulk upload engine: drag-and-drop, per-file pause/resume/cancel/retry, floating queue panel
- Multi-channel broadcasting infrastructure with real-time sync
- RBAC with roles: system, admin, editor, moderator, user
- YouTube sync with metadata lock support (`metadataLocked` flag)
- Fastify v5 API with OpenAPI 3.1 spec, Zod validators, SSE + WebSocket real-time gateway
- PostgreSQL (primary DB) + Redis (optional caching, fallback to pg)
- Docker multi-stage builds for API, Admin, TV surfaces
- Full CI/CD pipeline: GitHub Actions (CI + release + mobile + TV + OTA + Docker + store deploy)
- Expo EAS builds for all platforms (development, preview, staging, production, androidtv, appletv, firetv)
- Fastlane automation: iOS (Match certs, TestFlight, App Store) + Android (Play Store, Firebase Distribution)
- Samsung Tizen .wgt + LG webOS .ipk packaging
- TurboRepo monorepo with parallel builds and GitHub Actions cache
- Drizzle ORM schema with full migration history
- Sentry error tracking with source map upload for all surfaces
- render.yaml with 4 services (API, Admin, Web, TV) on free tier
- git pre-commit hook (verify gate on TS/spec changes)
- Post-deploy smoke test, secrets vault verification, rollback scripts
- Single `pnpm run release:production` command for zero-manual-step releases
