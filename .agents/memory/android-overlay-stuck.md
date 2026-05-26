---
name: Android "Tuning in" overlay stuck — same-URL recovery rebind bug + recovery spiral
description: Root causes and all fixes for expo-av "Tuning in…" stuck on Android: same-URL no-onLoad, recovery seek spiral, silent load failure, HLS type detection.
---

## Bug 1: Same-URL recovery — onLoad never re-fires

**Symptom:** Android plays audio but "Tuning in…" overlay never clears (first occurrence).

**Root cause:** expo-av's `<Video>` component compares `source.uri` by string. Same string → no reload → no `onLoad` → `buffer-ready` never fires for the new `bindRevision` → FSM stays in RECOVERING_PRIMARY forever.

**Fix: `lastLoadedUrlRef` + same-URL fast-path** (V2PlayerContainer.tsx, reset effect):
```typescript
if (url !== null && url === lastLoadedUrlRef.current) {
  isSameUrlRecoveryRef.current = true;   // NEW: flag for play effect
  clearLoadTimeout();
  setLoadedRevision(state.bindRevision);
  if (lastReportedRevision.current !== state.bindRevision) {
    lastReportedRevision.current = state.bindRevision;
    reportBufferEvent({ type: "buffer-ready", bufferId });
  }
} else {
  isSameUrlRecoveryRef.current = false;
  setLoadedRevision(-1);
  actualDurationMsRef.current = null;
  // arm load timeout (see Bug 3)
}
```

**Secondary: `onReadyForDisplay`** as backup buffer-ready (Android: video-frame ready fires later than metadata onLoad).

## Bug 2: Recovery spiral — playFromPositionAsync causes re-stall loop

**Symptom:** Same-URL fast-path fires buffer-ready → play effect calls `playFromPositionAsync(N)` → ExoPlayer flushes buffer and re-fetches segments at position N → fetch exceeds BUFFERING_STALL_THRESHOLD_MS → buffer-error → RECOVERING again → same-URL fast-path → seek again → infinite loop. Audio plays, overlay stuck.

**Root cause:** After same-URL recovery, the play effect used the calculated `positionSecs` (e.g. 3600 s into a long video) causing a full ExoPlayer buffer flush on every recovery attempt.

**Fix: `isSameUrlRecoveryRef` one-shot flag** (V2PlayerContainer.tsx, play effect):
```typescript
if (isLiveHls || isSameUrlRecoveryRef.current) {
  // Use playAsync() — no buffer flush, resumes from buffered position.
  // For same-URL recovery: ExoPlayer keeps its segments; broadcast sync
  // re-latches within HLS_LIVE_SYNC_INTERVAL_MS (30 s).
  isSameUrlRecoveryRef.current = false; // consume flag
  playStartMsRef.current = Date.now();
  v.playAsync().catch(() => { reportBufferEvent({ type: "buffer-error", ... }); });
} else {
  // Normal VOD HLS seek with drift guard (playFromPositionAsync).
}
```

## Bug 3: Silent load failure — onLoad never fires (manifest hang / codec deadlock)

**Symptom:** Android ExoPlayer fails to fire `onLoad` or `onError` (manifest parse failure, codec negotiation deadlock, manifest fetch timing out). FSM stuck in PREPARING_ACTIVE indefinitely even though the buffering watchdog (20 s, isBuffering=true) didn't fire.

**Fix: `loadTimeoutRef` — LOAD_TIMEOUT_MS = 25 s** (V2PlayerContainer.tsx):
- Starts on new-URL bind for active+playing buffers.
- Fires `buffer-error` with code `"load-timeout"` if `onLoad` hasn't arrived.
- Cancelled in `onLoad` (success) and on each `bindRevision` change.
- Complements (not replaces) the existing `BUFFERING_STALL_THRESHOLD_MS = 20 s` watchdog.

## Fix 4: HLS content-type hint for ExoPlayer

**Symptom:** Some ExoPlayer 2.x builds fall back to progressive download for HLS URLs with long query strings, causing manifest parse failures and black video while audio plays.

**Fix:** `overrideFileExtensionWithValue: 'm3u8'` in expo-av source object for HLS items:
```typescript
const avSource = isHls
  ? { uri: url, overrideFileExtensionWithValue: "m3u8" as const }
  : { uri: url };
```

## HLS encoding improvements (transcoder.service.ts)

- `HLS_SEGMENT_SECS = 2` (was 4): faster time-to-first-frame, smaller seek refetch window, aligns with KEYFRAME_INTERVAL_SECS=2 so every segment starts with IDR.
- `hls_flags: independent_segments+split_by_time`: deterministic time-aligned cutting regardless of source framerate.

## Why / How to apply

- expo-av's Video never unmounts for same source URI → must track loaded URLs in refs, not rely on onLoad.
- RECOVERING_PRIMARY same-URL: use `playAsync()` not `playFromPositionAsync(N)` to prevent ExoPlayer buffer flush.
- Load timeout (25 s) > buffering watchdog (20 s) — covers silent failures where isBuffering stays false.
- `overrideFileExtensionWithValue` is on `AVPlaybackSourceObject` — valid expo-av v14+ prop.
- HLS_SEGMENT_SECS and KEYFRAME_INTERVAL_SECS must stay equal for IDR-aligned segments.
