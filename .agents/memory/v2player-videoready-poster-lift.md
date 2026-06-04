---
name: V2PlayerContainer videoReady poster-lift safety net
description: Why the mobile poster gate must not depend solely on onReadyForDisplay, and why visual fallbacks must not all be gated on posterUrl
---

# videoReady poster-lift must have an isPlaying fallback

The `videoReady` state in `artifacts/mobile/components/V2PlayerContainer.tsx` gates when the
poster/ambient overlay is lifted off the `<Video>` surface. The FSM reaches PLAYING (dismisses the
tuning overlay) via THREE buffer-ready paths: `onLoad`, `onReadyForDisplay`, and the `isPlaying`
fast-path in `onPlaybackStatusUpdate`. But `videoReady` was historically lifted by **only**
`onReadyForDisplay`.

**Why this breaks:** across the expo-av / ExoPlayer build matrix `onReadyForDisplay` is unreliable —
some builds never fire it, others fire it *before* `onLoad` where the buffer-ready dedup guard
(`lastReportedRevision`) swallows the paired `onVideoReady` call. Result: `videoReady` stays false
forever → poster freezes over actually-playing video; and if the item has no thumbnail, every visual
fallback (ambient, sharp poster, corner first-frame spinner) was gated on `posterUrl` existing, so
the viewer saw a **bare black screen** with no affordance.

**How to apply:**
- Keep an idempotent `onVideoReady?.()` call in `onPlaybackStatusUpdate` gated on
  `isLoaded && isPlaying && !isBuffering`, placed OUTSIDE the buffer-ready dedup guard. `onVideoReady`
  is only wired for the active buffer (`buffers.X.active ? handleVideoReady : undefined`) and
  `setVideoReady(true)` is idempotent, so calling it on the 500 ms status cadence is cheap.
- Never gate ALL visual fallbacks on `posterUrl`. Provide a centered first-frame spinner
  (`firstFrameLoadingCentered`) for the no-poster case so the surface is never bare black during the
  first-frame window.
- If A/B handoff early-lift is ever seen in telemetry, pass `bufferId` to `onVideoReady` and gate in
  the parent against `activeBufferId` before setting `videoReady=true` (architect-suggested optional
  hardening; existing `videoReady` resets on `activeBindRevision` change + leaving playing-family
  states already mitigate it).
