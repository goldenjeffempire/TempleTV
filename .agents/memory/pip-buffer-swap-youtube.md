---
name: PiP buffer-swap + YouTube-in-PiP (mobile V2PlayerContainer)
description: Two PiP bugs in V2PlayerContainer: Android freezes on A/B handoff in PiP; YouTube override causes black PiP window.
---

## Bug 1 — PiP surface frozen on A/B buffer swap
**Symptom:** On Android, when the broadcast performs a HANDOFF (A→B or B→A) while the app is in PiP mode, the PiP window stays frozen on the last frame of the old buffer even though audio from the new item plays.

**Fix:** Add a `useEffect([activeBufferId])` in `V2PlayerContainer` that calls `updatePipParams(16, 9, true)` (→ `setPictureInPictureParams`) when `isInPictureInPictureMode()`. This forces Android to re-capture the activity window content for the PiP surface. On API < 31, `setPictureInPictureParams` is a no-op.

## Bug 2 — YouTube override in PiP → black window
**Symptom:** When a YouTube live override starts while the app is in PiP mode, the PiP window goes black (expo-av cannot render a YouTube WebView inside a PiP surface).

**Fix:** Add a `useEffect([isYouTubeOverride])` that calls `onFatal?.()` when `isYouTubeOverride` transitions from false → true AND `isInPictureInPictureMode()` is true. `onFatal` triggers `router.back()` in `player.tsx`, bringing the Activity to foreground where the YouTube iframe can render.

## Bug 3 — FATAL during PiP leaves frozen overlay
**Fix:** In `player.tsx` `handleFatal`, call `cancelPipRestoreNotification()` + check `isInPictureInPictureMode()` before `router.back()`. This prevents a dangling PiP restore notification after the fatal navigation.

**Imports:** `isInPictureInPictureMode`, `updatePipParams`, `cancelPipRestoreNotification` from `../modules/expo-pip-android/src` (relative, not package name — TS resolution).
