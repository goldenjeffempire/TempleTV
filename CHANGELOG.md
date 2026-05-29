# Temple TV — Changelog

All notable changes to Temple TV are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## Unreleased

---

## v1.0.12 — 2026-05-29

### Changed
- **Version bump**: Android `versionCode` 47 → 48, iOS `buildNumber` `202605290000`. EAS production-android and production-ios profiles both carry `EXPO_PUBLIC_SENTRY_DSN` for consistent crash reporting.

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
