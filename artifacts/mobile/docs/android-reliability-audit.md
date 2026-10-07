# Android reliability audit — 2026-10-07

## Baseline captured before remediation

Reported Play release: 1.0.70 / 138; user-perceived crashes 4.67%, ANRs
1.18%. These are user-supplied aggregate measurements, not crash diagnoses.
No cluster stack traces, ANR thread dumps, affected-device breakdown, or exact
image/R8 diagnostic call stacks were supplied. Attribution remains open.

### Architecture and toolchain

- Expo prebuild monorepo, Expo Router, React Native 0.86.3, Expo ~57.0.23.
- Static app.json is the native build source of truth; Android directory is
  generated and excluded from cloud archives.
- app.json: Android min 24, target/compile 36, build tools 36.0.0,
  NDK 27.2.12479018, Kotlin 2.1.20. Local Java: OpenJDK 21.0.7.
- Local generated Android: Gradle wrapper 9.3.1, Hermes/new architecture enabled,
  four ABIs. Generated version is stale (1.0.68 / 136), unlike managed config.
- Release minification and resource shrinking already enabled; optimize default
  ProGuard config and R8 full mode enabled. Custom rules keep entire Expo,
  React Native, Kotlin, OkHttp, Media3, Sentry and other packages, including
  removed expo-av/legacy video code. This directly inhibits optimization;
  whether it explains Play's exact warning is unverified.
- Generated release signing uses debug template. Production signing must be
  injected by the release build process and certificate checked on its output.
  No credential values were inspected.
- No adb, Android SDK/local.properties, emulator, or connected device found.
  Native build/install/stress verification is blocked in this environment.

### Runtime inventory and reviewed risks

- expo-image already serves most thumbnails. React Native Image remains in
  broadcast posters/up-next/countdown. Existing image sizes constrain layout,
  but these paths do not explicitly select the project's optimized pipeline.
- expo-video owns native local and dual-slot broadcast playback; TrackPlayer
  owns radio/background media. YouTube uses a native WebView.
- Two broadcast buffers are intentional for handoff; do not remove the
  second player or introduce a second PiP owner.
- Broadcast cleanup calls synchronous `player.replace(null)` in addition to
  useVideoPlayer's automatic release. This performs redundant source work
  during teardown and risks calling an already released SharedObject.
- Local-player retry schedules an unowned 700 ms timeout; listener cleanup
  does not cancel it on source change. A stale retry can replace a new source.
  Async load completions only check mounted state, not whether source changed.
- PiP receiver unregister uses the current ReactContext instead of the
  registering Context. ReactContext loss/recreation can leave it registered.
- PiP UI work captures an Activity before queuing and lacks a finishing/
  destroyed-activity guard when the queued callback actually runs.
- Repository search found no app-owned BitmapFactory/decodeStream/
  decodeByteArray, synchronous network, Thread.sleep or runBlocking work.
  This does NOT exclude transitive native image decoders or prove no ANRs.
- Startup has phase tracing, Sentry, a global JS exception handler delegating
  to the previous handler, and route/component error boundaries.
- API requests use timeout/retry helpers and connectivity context; no network
  results should be inferred from cached content alone.
- Home limits category strips and uses horizontal FlatLists; library is
  virtualized. Download progress is already throttled.
- Player-core native sessions, broadcast subscriptions, auth, notification
  callbacks, AppState handlers and polling were searched/reviewed for cleanup.
  Midnight-prayers config polling clears intervals at last unsubscribe but an
  in-flight fetch can recreate the window timer after unsubscribe.
- Many legacy catches still suppress errors. This audit does not certify
  every path or rewrite all recovery code without device/cluster evidence.

## Release gate

Do not submit another build with consumed versionCode 138. Select a fresh
versionCode during release preparation. Do not describe JS tests or source
inspection as Android device testing, or claim Play rates improved.

Required before production sign-off: production cluster traces, regenerated
native build, minified APK/AAB and matching upload certificate, installed
release critical-flow tests (including hero-to-player), notification/PiP/radio,
offline/background/orientation transitions, low-memory repeated navigation,
and multi-hour broadcast soak with memory/CPU/startup measurements.

## A. Findings and attribution

1. **Confirmed crash path:** PiP title methods were called under the Android
   12/API 31 gate, but were introduced in API 33. API 31/32 can throw
   NoSuchMethodError, which is not caught by Exception. Both native entry
   points were affected. Official reference:
   https://developer.android.com/reference/android/app/PictureInPictureParams.Builder#setTitle(java.lang.CharSequence)
   No production stack was available to measure its contribution to 4.67%.
2. **Confirmed lifecycle defects:** local playback retries outlive their
   source/listener; async completions check mounting but not source-effect
   disposal; final schedule unsubscribe does not cancel in-flight work; PiP
   receiver cleanup depends on the current rather than original Context.
3. **Teardown risk:** redundant source replacement races the hook-owned
   SharedObject release. A synchronous replacement also adds unnecessary
   teardown work. This is not a measured ANR attribution.
4. **Image optimization gap:** remaining broadcast surfaces used a separate
   image pipeline. No app-owned manual bitmap decode was found. Play's exact
   decoder warning remains unattributed without its call stack.
5. **R8 optimization blocker:** extensive blanket keeps and blanket dontwarns,
   plus legacy template keeps; actual warning/size savings unmeasured.

## B–E. Implemented remediation

- Corrected both PiP title gates to API 33; API 31 auto-enter/seamless behavior
  remains unchanged. Added cancellation/stale-Activity checks inside queued
  UI callbacks and explicit native logs for failed PiP operations.
- Receiver now uses and retains its registering application Context, clears
  ownership during destruction, and logs unexpected unregister failures.
- Local-player retries are cancelled during listener cleanup, duplicate
  pending retries are suppressed, and obsolete load/retry completions cannot
  seek/play/update the replacement screen. Empty sources unload the player.
- Removed redundant on-unmount replacements; expo-video's hook owns release.
  Intentional radio-mode unloading and A/B broadcast handoff remain intact.
- Last schedule unsubscribe aborts requests; timed requests clear their timer
  and abort listener. Late completions cannot recreate polling.
- Broadcast images use existing expo-image, memory/disk caching, view-size
  downscaling, local placeholders and source-specific failure fallback.
- Removed blanket custom library keeps/warning suppression. Retained
  symbolication metadata and narrow optimizable custom-module construction
  rules. Installed consumer configs remain responsible for library JNI and
  reflection contracts. A prebuild plugin removes only the two known legacy
  blanket rules from Expo's application template, not library consumer rules.
- Minify/shrink/full mode remain enabled. SDK, ABIs, identifiers, permissions,
  and signing credentials unchanged. No dependencies added or removed.
- Excluded existing release artifacts from future source archives.

Important files: app.json; plugins/with-release-r8.js; plugins/with-gradle-config.js;
modules/expo-pip-android/.../ExpoPipAndroidModule.kt;
components/LocalVideoPlayer.tsx; components/V2PlayerContainer.tsx;
components/RemoteImage.tsx; components/player/BroadcastCompanion.tsx;
components/player/CountdownOverlay.tsx; __tests__/android-reliability.test.ts.

## F. Verification results

| Check | Result |
| --- | --- |
| All mobile Node tests, including new regression contracts | **205 passed**, 0 failed |
| Mobile TypeScript | Passed |
| Production Android JS/Hermes export | Passed, 7.2 MB HBC bundle |
| Android prebuild | Passed; generated version now agrees with 1.0.70 / 138 |
| Generated application R8 rules | Narrow rules present; blanket template rules absent |
| Touched TS/TSX lint | 0 errors, 14 warnings (mostly existing disable directives and static require conventions) |
| API test script | **33 passed**, 0 failed |
| Player-core test script | No tests executed: existing script only echoes “vitest not available” |
| Whole-repository lint | Failed: 18 errors, 137 warnings outside the remediation's targeted lint pass |
| Whole-repository typecheck | API, admin, TV, mobile passed; overall run timed out at mockup sandbox |
| Expo dependency compatibility check | Failed: 11 Expo patch-level mismatches; no upgrades attempted without native verification |
| Gradle debug/release APK + release AAB invocation | Timed out during initialization, no output APK/AAB; Android SDK also absent |
| Browser hero → player → back | Passed; player remained mounted for 5.2 seconds |
| Live playback in browser preview | Not verified: direct Metro origin lacks API routes; SSE/WS and production-API CORS failures |
| Device/emulator install, native PiP, notifications/radio | Not run: no SDK/adb/device |
| Low-memory/stress, multi-hour soak, CPU/memory/ANR measurement | Not run: no device/instrumented release |

The managed workflow bootstrap also reported React Native Metro-config peer
drift (0.86.0 versus 0.86.3), a missing API test-only types peer, and a local
DevTools binary missing libglib. Metro itself started and browser navigation
was tested. These are not proven causes of production crashes.

Regression contracts inspect native source/config; they do not execute Kotlin
on Android. JavaScript export is not native compilation, R8 execution, signing,
or verification of an installable AAB. Repository validation regenerated API
declaration outputs, and workflow bootstrap refreshed lockfile peer metadata;
neither represents an API behavior change.

## G–H. Remaining risks and release decision

**NOT READY FOR PRODUCTION.**

Still required: obtain expanded traces for remaining crash/ANR clusters and exact image/R8
diagnostics; resolve dependency/toolchain and repository-check blockers; build
and inspect a signed minified release; verify its upload certificate; install
on Android 12/12L (the corrected crash path) and other supported device classes;
verify native hero navigation, playback, PiP, notifications, radio, offline/
background transitions and sustained low-memory playback. Existing silent
recovery paths need targeted follow-through using the diagnostic clusters.
No claim is made that Play metrics have improved or all ANRs are eliminated.

## Additional Google Play evidence and targeted buffer mitigation

The subsequently supplied release-138 issue-list screenshots identify:

- `ExpoPipAndroidModule` / `java.lang.NoSuchMethodError`: **19 affected
  users, 117 events, 86.7% of listed events**. A subsequently supplied
  expanded production stack confirms the missing method is
  `PictureInPictureParams.Builder.setTitle(java.lang.CharSequence)` on
  **Android 12 / SDK 31**. The call originates in the custom PiP module's
  queued callback. This confirms the corrected API-compatibility defect as
  the root cause of this cluster, not just a suspected title match. Both
  title calls now require API 33. Installed-release verification and
  post-release metrics are still required to confirm the outcome.
- `ExoPlayerImplInternal.shouldContinueLoading` and
  `DirectByteBuffer.asReadOnlyBuffer`: separate `OutOfMemoryError` clusters,
  one event each. These prove production memory failures, not the total
  allocation source or a specific leak.
- `VideoPlayer.close` / `invokeSuspend`: an input-dispatch ANR during
  native player shutdown. Removing redundant application teardown avoids
  duplicate work but does not prove this library release ANR is fixed.
- Other low-count clusters include native poll/input-dispatch ANRs, no-focus
  ANRs, graphics shader/native crashes, GC waiting, FrameLayout NPE,
  WebView/autofill, and IllegalStateException. Expanded traces are still
  required; generic input-dispatch titles do not identify a culprit.

Android local playback and both broadcast slot instances now use a shared
24 MiB per-player media-buffer target, a 20-second forward window, and a
2-second playback threshold. Time does not override the byte target.
The iOS/web policy and intentional dual-slot handoff are unchanged.

This is a targeted memory-pressure mitigation, not a measured OOM resolution
or a hard cap on app memory. Native allocator granularity, decoded frames,
WebView, images and other players have separate memory costs. Sustained
low-memory/high-bitrate playback and source-transition tests remain required.
The release decision remains **NOT READY FOR PRODUCTION**.

Verification after this buffer change: **207 mobile tests passed**; mobile
TypeScript passed; targeted lint reported **0 errors, 12 warnings**. The initial
local type-check process exhausted its Node heap allowance; the same check
passed with a 2 GiB build-time allowance. This is not an Android-runtime result.
The restarted Metro preview rendered the application shell/loading state;
missing local API routes and WebSocket connections still prevent live-playback
verification. Existing Metro peer/dependency and local DevTools warnings remain.

## Confirmed native player-shutdown ANR and follow-through

The supplied Android 14 / SDK 34 release-138 trace shows the **main thread**
in timed waiting:

```text
Object.wait
ConditionVariable.blockUninterruptible
ExoPlayerImplInternal.release
ExoPlayerImpl.release
VideoPlayer$close$2.invokeSuspend
```

This confirms the sampled UI-thread blocking location is native player
release. It does not show how long the wait lasted or provide detailed
playback-thread stacks explaining slow native cleanup. Several playback/
loader threads are listed; their presence alone is not proof of a leak.

Two additional mitigations:

1. The Android home hero now mounts its native preview only while home is
   focused and the full broadcast player is not open. Its metadata/session
   subscription remains alive, preserving broadcast state and allowing the
   preview to resume on return. iOS/web behavior and full-player PiP ownership
   are unchanged. This removes retained hidden preview decoders/buffers.
2. A tracked **expo-video 57.0.4** pnpm patch configures Media3's supported
   `setReleaseTimeoutMs(100L)` builder setting. ExoPlayer keeps its main
   application looper; no release calls are moved to an incompatible thread.
   The setting bounds the synchronous internal-release wait, not the entire
   close method or native cleanup duration. Media3 can report a release timeout
   on slow devices. The same API also governs foreground-mode waits.

Media3 API contract:
https://developer.android.com/reference/androidx/media3/exoplayer/ExoPlayer.Builder#setReleaseTimeoutMs(long)

Patch, manifest registration and lockfile hash were generated together by
pnpm. The initial commit's install reached a git-hook prepare script blocked
by the workspace sandbox; repeating with lifecycle scripts disabled completed
without modifying git configuration. Frozen-lockfile installation passed,
and the resolved installed native source contains the timeout setting.
Regenerate/revalidate the patch before upgrading expo-video.

Additional files: app/(tabs)/index.tsx; lib/heroPreviewPolicy.ts;
patches/expo-video@57.0.4.patch; root package.json/pnpm-lock.yaml patch metadata;
__tests__/android-reliability.test.ts.

Verification: **210 mobile tests passed**, TypeScript passed, production
Android JS/Hermes export passed (7.2 MB), targeted lint **0 errors / 8 existing
warnings**. After a lint-only regex correction, all 14 reliability contracts
passed again. Native Kotlin compilation and device measurements remain blocked
by the missing SDK/device. Neither mitigation is a verified production ANR
elimination; test repeated navigation, PiP, app background/foreground and
simultaneous radio ownership on slow/low-memory Android devices before shipping.

**Release decision remains NOT READY FOR PRODUCTION.**
