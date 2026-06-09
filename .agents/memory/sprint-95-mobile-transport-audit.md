---
name: Mobile transport + player audit sprint 95
description: 3 genuine bugs found across transport.ts (2) and player.tsx (1); 15+ false positives documented from 6-subagent comprehensive audit.
---

## Genuine Bugs Fixed

### 1. transport.ts — RN stuck in SSE-preference mode after 3 WS failures (Medium)
- **Root cause**: `connectSse()` line 715 checks `typeof EventSource === "undefined"` → calls `scheduleReconnect()` and returns. If `wsPreferSseUntilWsOpens=true`, every reconnect cycle: `scheduleReconnect → tick → connectWs → wsPreferSseUntilWsOpens → connectSse → scheduleReconnect`. WS only probed every `WS_PROBE_INTERVAL_SSE_ROUNDS` (typically 5) cycles. On RN, SSE will *never* succeed, so the flag is permanently counter-productive.
- **Fix**: In `connectSse()`, when EventSource is undefined AND `wsPreferSseUntilWsOpens=true`, clear the flag + reset `wsFailStreak=0` and `sseReconnectCount=0` before `scheduleReconnect()`. Next tick goes straight to `connectWs`.
- **Why**: Only applies to RN (EventSource undefined). Web SSE works normally. Clearing wsFailStreak is safe because RN has no SSE option — WS is the only transport; the preference flag should never have been entered on RN in the first place.

### 2. transport.ts — `doRequestSnapshot` missing stopped guard on primary fetch path (Low)
- **Root cause**: The retry path (line 927) already has `if (this.stopped) return;`, but the primary success path (line 944) did not. `stop()` called while an 8s fetch was in flight → `saveSnapshotCache` + `onPlayerEvent` fired into a dead/evicted session.
- **Fix**: Added `if (this.stopped) return;` after `await res.json()` on the primary (non-retry) success path.

### 3. player.tsx — PrayerSection setState on unmounted component (Low)
- **Root cause**: `PrayerSection` is a standalone component rendered inside the player. If the user taps "Send Prayer" then immediately navigates back (hardware back), the `.then()` and `.catch()` callbacks fire `setSending(false)` / `setSubmitted(true)` on an unmounted component — triggering React Native warnings and potential errors in strict mode.
- **Fix**: Added `isMountedRef = useRef(true)` + `useEffect(() => { isMountedRef.current = true; return () => { isMountedRef.current = false; }; }, [])`. Both `.then()` and `.catch()` guard on `if (!isMountedRef.current) return;` before any setState.

## False Positives Confirmed (6-subagent audit)

### player.tsx false positives
- **isBroadcastV2 flag with both youtubeId+hlsUrl**: Logic is correct — hlsUrl presence makes `isYoutube=false` and forces BroadcastV2/HLS path. No dual-engine.
- **Audio cleanup DoNotMix hardcode**: Matches global policy in `_layout.tsx`. No net change.
- **Audio async race on unmount**: Native module calls are serialized; the cleanup call (issued last) wins.
- **Countdown timer stale closure**: `startCountdown` bails at `if (countdownTimerRef.current) return` — only one timer can run; `goToNext` already guards `if (!nextSermon) return`.
- **navigateToRelated router.replace**: Intentional design (binge-watch without back-stack growth).
- **Orientation lock spam-tap**: `orientationIntentRef` handles it.

### LocalVideoPlayer, MiniPlayer, HeroSection, YoutubePlayer — all clean
- Stall watchdogs, same-URL recovery, A/B buffering, double-tap guard, hero-to-fullscreen, YouTube AppState recovery all confirmed robust.

### _layout.tsx — all clean
- Deep-link whitelist comprehensive; notification routing covers all types; QueryClient config correct for mobile; ErrorBoundary covers full tree + per-player; notification permission timing follows platform guidelines; Sentry configured correctly.

### react.ts web hook — forceReconnect debounce gap (minor optimization, not a bug)
- The web hook already guards against double visibilitychange+focus by only using visibilitychange. The debounce difference from RN is a minor optimization. No crash risk. Not fixed.

### Broadcast sync, nowPlaying, audioController — all clean
- iOS zombie WS: resolved via `reconnectKey` query-param rotation on 10s background.
- Lock-screen leaks: prevented by `broadcastMode` gating in `PlaybackService`.
- AudioLane mutual exclusion: correct in audioController + PlayerContext.
- NowPlaying persistence loss on cold start: intentional product design for a live broadcast app.
