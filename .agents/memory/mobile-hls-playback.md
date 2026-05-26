---
name: Mobile HLS playback — end-guard and drift-seek fixes
description: Root causes and constants for the "single segment replay" loop on mobile broadcast player
---

## Rule
Four-layer defense against the VOD HLS "single segment replay" loop on mobile:

1. **HLS_END_GUARD_MS = 8_000** (V2PlayerContainer.tsx) — clamp target to `actualDurationMs - 8000`.
   Must be > HLS_QUICK_FINISH_THRESHOLD_MS (5 000) by a margin or clamped seeks trigger quick-finish.
   
2. **machine.ts durationSecs cap = durationSecs - 10** (was -2) — server-side defense-in-depth.
   Aligns with client guard for cases where expo-av onLoad hasn't fired yet.

3. **Quick-finish retry uses `playAsync()` for live HLS** — `playFromPositionAsync(0)` on a live stream
   seeks to oldest DVR segment, trailing further behind the live edge on each retry.

4. **Drift-correction seek guard (HLS_SMALL_DRIFT_SKIP_MS = 30_000)** — track `playheadMsRef` from
   `onPlaybackStatusUpdate.positionMillis`; suppress re-seek if playhead already within 30 s of target.
   Initial seek always fires (playStartMsRef guard). Only large drifts (server restart, clock skew > 30 s) seek.

**Why:** Every `playFromPositionAsync` on mobile drops AVPlayer/ExoPlayer's buffer and stalls 0.5-2 s.
The old 2 000 ms end-guard left a 3 s window (2-5 s from end) that triggered quick-finish, then the
retry from 0 desynced the player from the broadcast timeline.
