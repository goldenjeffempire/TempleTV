---
name: Mobile deep-audit hardening batch 2
description: 6 real bugs found and fixed in a 6-way parallel audit; 9 items verified already-correct (audit false positives). Covers fetchWithRetry zombie connections, app.json fullscreen orientation, NetworkContext interval leak, player unmount orientation bleed, hls.js slot teardown hygiene.
---

## Fixed bugs

### fetchWithRetry — default per-attempt timeout (artifacts/mobile/lib/fetchWithRetry.ts)
Added `FETCH_TIMEOUT_MS = 15_000`. When caller provides no AbortSignal, each fetch attempt uses `AbortSignal.timeout(FETCH_TIMEOUT_MS)` via `perAttemptInit`. Caller-provided signal always takes precedence. A timeout fires as `DOMException("TimeoutError")` — not caught by the `signal?.aborted` or `"AbortError"` guards — so it correctly falls through to the retry loop.

**Why:** On mobile, zombie TCP connections (OS keep-alive open, app layer silent) cause fetch() to hang indefinitely. Without a default timeout there is no recovery except the user killing the app.

### app.json orientation + expo-screen-orientation plugin
Changed `"orientation": "portrait"` → `"orientation": "default"`. Changed `"expo-screen-orientation"` plugin string → `["expo-screen-orientation", { "initialOrientation": "DEFAULT" }]`.

**Why:** `"portrait"` bakes `android:screenOrientation="portrait"` into AndroidManifest.xml at the activity level. On many Android devices this overrides `ScreenOrientation.lockAsync(LANDSCAPE)` from expo-screen-orientation, silently blocking fullscreen landscape video. `"default"` allows the OS + dynamic lock to manage orientation.

### NetworkContext — web interval not cleared (artifacts/mobile/context/NetworkContext.tsx)
Added `if (intervalRef.current) clearInterval(intervalRef.current);` to the web-path effect cleanup (the native path already had this; the web path was missing it).

**Why:** `applyStatus()` calls `restartInterval()` which stores an interval in `intervalRef.current`. The web cleanup removed event listeners but never cleared this interval, leaving a 30s polling loop running after the provider unmounted (memory leak, background network traffic).

### player.tsx — orientation unlock on screen unmount (artifacts/mobile/app/player.tsx)
Added empty-dep `useEffect` whose cleanup calls `ScreenOrientation.lockAsync(PORTRAIT_UP)`. This fires whenever the player screen is torn down regardless of how navigation happened.

**Why:** `exitFullscreen()` restores portrait when the user explicitly exits. But deep-link pushes, OS back gestures bypassing the Modal's `onRequestClose`, and tab switches while fullscreen all unmount the screen without calling `exitFullscreen`. The LANDSCAPE lock then bleeds into the home screen and all subsequent screens.

### player.tsx — navInFlightRef reset on unmount (artifacts/mobile/app/player.tsx)
Added `navInFlightRef.current = false` to the countdown-cleanup unmount effect.

**Why:** expo-router can cache screen instances. If `navInFlightRef.current === true` when a cached screen re-activates, all Prev/Next taps are silently blocked until a `videoId` change fires the reset effect. Resetting on unmount ensures a clean slate on every re-activation.

### LocalVideoPlayer — hls.js slot teardown hygiene (artifacts/mobile/components/LocalVideoPlayer.tsx)
Two sites updated:
1. **Slot rebind** (line ~575): `prev.destroy()` → `prev.detachMedia(); prev.destroy()`
2. **Preload fatal error** (line ~688): same detachMedia+destroy, plus `video.src = ""; video.load()` to blank the `<video>` element.

**Why:** `hls.destroy()` alone can leave the `<video>` element's `src` pointing at a dead `MediaSource` object on some browsers. The next `loadSource()` then attaches a new HLS instance to an element with stale state, causing "Failed to attach media, MSE not open" errors. `detachMedia()` first releases the SourceBuffer cleanly. After a preload-mode fatal error, blanking `video.src` + calling `load()` resets the element to `HAVE_NOTHING` so the subsequent cold-load starts from a clean state.

## Verified already-correct (audit false positives — no change needed)

- **transport.ts forceReconnect**: `this.stopped` check already at line 308; `lastFrameMs` reset in `start()`.
- **machine.ts lastEndedItemId TTL**: 30s fallback is intentional — guards against naturalItemEnd POST failure leaving player dark for the full slot duration.
- **LocalVideoPlayer stall watchdog**: guarded by `!isPlaying` (line 503) + `!s.isPlaying` (line 508); no false positives from pause.
- **player.tsx countdown cleanup**: timer + fire-handle both cleaned up in unmount effect.
- **search.tsx AsyncStorage JSON.parse**: already wrapped in try-catch (lines 51-56).
- **useVideos.ts cache JSON.parse**: already wrapped in try-catch (lines 140-152).
- **broadcast.ts SSE EventSource**: `addEventListener` never throws in practice; es captured before return.
- **LocalVideoPlayer loadedmetadata {once:true}**: auto-removes; element GC'd on unmount.
