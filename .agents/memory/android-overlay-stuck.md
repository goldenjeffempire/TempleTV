---
name: Android "Tuning in" overlay stuck — same-URL recovery rebind bug
description: Root cause and fix for expo-av not re-firing onLoad on same-URL recovery rebinds, leaving RECOVERING_PRIMARY stuck.
---

## The Bug

**Symptom:** Android plays audio but "Tuning in…" overlay never clears.

**Root cause (traced precisely):**

1. Initial load succeeds: `onLoad` fires → `lastLoadedUrlRef.current = url` (after fix) → `buffer-ready` fires → FSM → PLAYING → audio starts.
2. Something triggers `buffer-error` on the active buffer (stall watchdog, network blip, or failed seek).
3. FSM → RECOVERING_PRIMARY, emits new `bind` intent (same item, same URL, new `bindRevision`).
4. Adapter bumps `bindRevision`. BroadcastBuffer re-renders.
5. Reset effect fires (dep: `bindRevision`): `setLoadedRevision(-1)` — resets the load gate.
6. **KEY BUG:** expo-av's `<Video>` component compares `source.uri` by string value. Since the URL string is UNCHANGED, expo-av does NOT unmount/reload and does NOT re-fire `onLoad`.
7. `loadedRevision` stays at -1. The play effect guards: `if (loadedRevision !== state.bindRevision) return` — play is blocked.
8. `buffer-ready` is never fired for the new revision. FSM stays in RECOVERING_PRIMARY forever.
9. Audio from the original load continues playing (expo-av was never interrupted).
10. Result: audio plays, overlay shows "Tuning in…" — indefinitely.

## The Fix

**Primary fix — same-URL recovery fast-path** (`lastLoadedUrlRef`):

```typescript
// In BroadcastBuffer:
const lastLoadedUrlRef = useRef<string | null>(null);

// In onLoad handler:
lastLoadedUrlRef.current = url;  // record the URL expo-av loaded

// In bindRevision reset effect:
if (url !== null && url === lastLoadedUrlRef.current) {
  // expo-av still has this URL loaded. Immediately fire buffer-ready.
  setLoadedRevision(state.bindRevision);
  if (lastReportedRevision.current !== state.bindRevision) {
    lastReportedRevision.current = state.bindRevision;
    reportBufferEvent({ type: "buffer-ready", bufferId });
  }
  // actualDurationMsRef stays valid — same video, same duration.
} else {
  // New URL — full reset; wait for onLoad.
  setLoadedRevision(-1);
  actualDurationMsRef.current = null;
}
```

**Secondary fix — `onReadyForDisplay` as backup buffer-ready signal:**

On Android, `onLoad` fires on metadata decode; `onReadyForDisplay` fires on first video-frame render (can be 100–500 ms later). The `lastReportedRevision` guard prevents double-firing.

```typescript
onReadyForDisplay={() => {
  setLoadedRevision(state.bindRevision);
  if (lastReportedRevision.current !== state.bindRevision) {
    lastReportedRevision.current = state.bindRevision;
    reportBufferEvent({ type: "buffer-ready", bufferId });
  }
}}
```

**Tertiary fix — `HLS_LIVE_SYNC_INTERVAL_MS` 15 s → 30 s:**

The 15 s re-latch caused perceptible micro-stalls on weak Android connections. 30 s matches the standard live HLS target segment duration.

## Why

**Why:**
- expo-av's Video component uses the `uri` string as the key for reloading. Same string → no reload → no `onLoad`.
- RECOVERING_PRIMARY is triggered by `buffer-error` (stall watchdog after 20 s, network blip, failed seek near end of VOD).
- The FSM's recovery correctly bumps `bindRevision` to force the play effect to re-seek. But without `lastLoadedUrlRef`, the play effect would be gated forever on `loadedRevision !== bindRevision`.

**How to apply:**
- Any time expo-av's Video component is used with a potentially unchanged source, `onLoad` cannot be relied upon to fire after a React state update. Track loaded URLs explicitly and handle same-URL recovery.
- The `lastReportedRevision` ref deduplicates buffer-ready across both `onLoad` and `onReadyForDisplay`.
