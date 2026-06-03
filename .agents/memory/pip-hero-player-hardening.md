---
name: PiP stream preservation & Hero/Player sync hardening
description: 4 production bugs fixed in the TV app's Hero/Player/PiP stack; key patterns for future PiP work.
---

## Bugs fixed

### 1. Muted video fallback in `enterPiP` (silent PiP window)
- **File:** `artifacts/tv/src/hooks/usePictureInPicture.ts`
- **Problem:** `enterPiP()` had a fallback `?? videos.find(v => !v.paused)` that selected the muted hero background video when no unmuted video was found, producing a PiP window with no audio.
- **Fix:** Removed the fallback — only unmuted+playing+readyState≥2 videos are eligible.

### 2. HLS stream killed when Hero remounts after PiP nav-back
- **Files:** `lib/player-core/src/react.ts`
- **Problem:** When user activated PiP from the Player and pressed Back, `pauseAllBroadcastSessions()` (called synchronously in `flushAndClosePlayer`) ran while the Player's video elements were still mounted. It called `adapter.apply({ type: "unbind" })` on both buffers including the one in PiP, destroying its HLS and freezing the PiP window.
- **Fix:** Added `releaseAdapter(session, preservePiP=true)` helper. When `preservePiP=true`, the buffer whose `el === document.pictureInPictureElement` is skipped — its `buf.detach` fn is saved to `_pipReservedEl/_pipReservedDetach`. `cleanupPiPReservedStream()` (exported) is called by `leavepictureinpicture` in `usePictureInPicture.ts`. Stale-reservation guard runs at top of `releaseAdapter` to clean up if PiP was closed without notification.

### 3. Stale buffer shown in PiP after A/B buffer swap
- **File:** `artifacts/tv/src/components/LiveBroadcastV2.tsx`
- **Problem:** PiP is pinned to a specific DOM `<video>` element. When the broadcast advanced (A→B handoff), PiP showed the old buffer's content.
- **Fix:** Added `videoRefA`/`videoRefB` local refs (chained with `attach.A/B` callbacks). Effect watches `snapshot.activeBufferId`; on change with PiP active, calls `exitPictureInPicture().then(() => newEl.requestPictureInPicture())`.

### 4. VOD play() didn't exit PiP before switching content
- **File:** `artifacts/tv/src/App.tsx`
- **Problem:** `play()` called `pauseAllBroadcastSessions()` while PiP was active → `releaseAdapter` preserved the PiP stream → orphaned HLS ran indefinitely while VOD played.
- **Fix:** `play()` now calls `document.exitPictureInPicture().catch(()=>{})` first. The resulting `leavepictureinpicture` event fires `cleanupPiPReservedStream()` after PiP exits, or the stale-reservation guard in `releaseAdapter` catches it.

## Architecture decisions

**Why:** `releaseAdapter` is the single place that releases video buffers. Centralizing the PiP-preservation logic there means neither `detachElements()` nor `pauseAllBroadcastSessions()` need to know about PiP separately.

**How to apply:** Any future code that calls `adapter.apply({ type: "unbind" })` directly must go through `releaseAdapter` to stay PiP-safe.

**Key invariant:** `_pipReservedEl` is always the element currently in `document.pictureInPictureElement`. Stale-reservation guard at the top of `releaseAdapter` enforces this.

**Visibility reconnect is already handled** in `useV2Broadcast` (lines 614-649 of react.ts) — `visibilitychange` fires `forceReconnect()` + `machine.send({type:"online"})`. No additional fix needed.
