---
name: Broadcast sync — MP4 and periodic drift correction
description: Three sync bugs in player-core that caused devices to play at different positions; fixes applied to machine.ts and react.ts.
---

## Rules

### 1. resolvePositionSecs must cover all seekable VOD kinds
`lib/player-core/src/machine.ts` — `resolvePositionSecs()`

The function previously returned 0 for non-HLS sources. This caused every device watching **MP4** content to start from position 0 regardless of when it joined — making late joiners completely out of sync.

**Fix:** `if (kind === "hls" || kind === "mp4" || kind === "dash")` — exclude only `youtube` (iframe, no native seek) and `rtmp` (live stream, no VOD position).

**How to apply:** Whenever adding a new VOD source kind, check `resolvePositionSecs` and extend the condition.

### 2. PLAYING state must emit `play` on every snapshot
`lib/player-core/src/machine.ts` — PLAYING branch of `onServerSnapshot()`

The old code only corrected drift when `startsAtMs` shifted > 5 s between consecutive snapshots of the same item — only catching server restarts, never gradual drift.

**Fix:** Always emit `{ type: "play", positionSecs }` in PLAYING state on each incoming snapshot (keepalive every 15 s). Guards:
- `positionSecs > 0` — prevents seeking youtube/rtmp to position 0
- `inLoopTransitionWindow = (nowMs - startsAtMs) < 4_000` — prevents seeking during the natural loop handoff

The adapter's 4 s dead band (`|currentTime - positionSecs| > 4`) suppresses no-op seeks when the device is already in sync.

**Why:** The `positionSecs` target and `video.currentTime` advance at the same rate during normal playback, so `|target - current| ≈ 0` for an in-sync device and no seek fires. A drifted device has `|target - current| > 4` → seek corrects it within the next keepalive cycle.

### 3. replayStateToAdapter must cover mp4/dash on SPA remounts
`lib/player-core/src/react.ts` — `replayStateToAdapter()`

On TV page navigation or tab switching (component remount), the function previously only computed an elapsed-based position for HLS. MP4 sources restarted from 0.

**Fix:** `if ((sourceKind === "hls" || sourceKind === "mp4" || sourceKind === "dash") && startsAtMs)`

## What NOT to seek
- `youtube` — displayed via iframe, `<video>` element has no src, `boundKind === "youtube"` guard in adapter returns early anyway
- `rtmp` — live stream, seeking to elapsed would re-seek to 0 (return 0 from resolvePositionSecs) and destroy the live feed

## Mobile drift guard
`DRIFT_SEEK_SUPPRESS_MS = 30_000` in `V2PlayerContainer.tsx` stays at 30 s — mobile seeks are expensive (cause AVPlayer rebuffer). The most important mobile fix is that the **initial join always seeks to the correct wall-clock position** (initial seek guard: `lastPlayedPositionMs === null`). Ongoing drift on mobile is accepted up to 30 s before a corrective seek fires.
