---
name: Mobile HLS single-segment loop bug
description: Root causes and fixes for expo-av HLS playing only one segment repeatedly instead of following the full broadcast timeline.
---

## The Bug
On mobile, HLS broadcast content replayed a single segment (4–10 s) in a tight loop instead of following the full broadcast timeline like the admin web preview.

## Root Causes

### 1. Seek past encoded end of video (primary cause)
`resolvePositionSecs` in `machine.ts` returns `(Date.now() - startsAtMs) / 1000` for HLS. If the DB row's `durationSecs` overestimates the actual video length (e.g. a 30-min file catalogued as 86400 s due to a failed duration probe at upload), `positionSecs` >> actual encoded duration. `playFromPositionAsync(hugeMs)` on expo-av / AVPlayer snaps to the last frame and fires `didJustFinish` within ~1 s → FSM HANDOFF → same item rebound with even larger positionSecs → loop.

### 2. No actual-duration guard in the mobile buffer
The play effect called `playFromPositionAsync(state.positionSecs * 1000)` without checking whether the position exceeded the real video duration reported by the native player.

### 3. No HLS quick-finish detection
`didJustFinish` from a bad seek was treated identically to a genuine natural end → `buffer-ended` → HANDOFF. No retry-from-zero mechanism existed.

### 4. No live/VOD HLS distinction
For true live HLS (infinite playlist), calling `playFromPositionAsync()` is wrong — `playAsync()` is the correct call to attach to the live edge. `durationMillis === null/undefined/Infinity` from expo-av's `onLoad` distinguishes live from VOD.

## Fixes Applied

**`lib/player-core/src/machine.ts` — `resolvePositionSecs`**
- Cap HLS elapsed position at `min(elapsed, durationSecs - 2)` for V2Items with a known `durationSecs`. Prevents the machine from ever requesting a seek beyond the expected video end.

**`artifacts/mobile/components/V2PlayerContainer.tsx` — `BroadcastBuffer`**
- `actualDurationMsRef`: captures `durationMillis` from expo-av's `onLoad` as ground truth.
- Live vs VOD detection: `durationMillis === null/Infinity` → live HLS → `playAsync()` (live edge). Finite `durationMillis` → VOD HLS → `playFromPositionAsync(min(positionMs, actualMs - 2000))`.
- Quick-finish guard: `playStartMsRef` tracks when play started. If `didJustFinish` fires within 5 s (HLS_QUICK_FINISH_THRESHOLD_MS), it's a spurious finish → retry from position 0 (up to 2 retries), then escalate to `buffer-ended`.
- Live-sync interval: `playAsync()` every 30 s on active+playing HLS buffers to re-latch to the live edge. No-op on already-playing VOD HLS.
- All tracking refs reset on `bindRevision` change.

**`artifacts/mobile/context/NetworkContext.tsx`**
- Fixed pre-existing TS error: `isOnlineRef` was referenced but never declared.

**Why:** AVPlayer/ExoPlayer handle out-of-range HLS seeks differently from hls.js on web: instead of clamping gracefully, they fire `didJustFinish` or an error immediately, triggering the HANDOFF loop. The fix grounds every HLS seek in the real encoded duration from the native player.
