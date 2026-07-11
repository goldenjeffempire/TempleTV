---
name: Player no-source error UI and nav-latch safety valve
description: Mobile player.tsx fixes for silent blank screen and stuck Prev/Next lock; read before touching player.tsx render branches or navInFlightRef.
---

`app/player.tsx`'s final render branch (used when a video is neither live,
YouTube, nor has an HLS/MP4 url) used to render only a static thumbnail/
placeholder `Image` with no message and no recovery action — visually
indistinguishable from a stuck loading screen. Fixed by adding an explicit
"This video is unavailable" state (message + Go Back / Close action) gated on
a `hasNoSource` boolean, in both the inline and fullscreen-modal render paths.

Separately, `navInFlightRef` (locks Prev/Next during a transition) was only
ever cleared by the `videoId`-change effect or on unmount. If `router.replace()`
silently failed to change `videoId` (e.g. swallowed by an upstream nav guard),
the lock could strand forever and permanently disable Prev/Next.

**Fix:** a 4s safety-valve `setTimeout` is armed whenever the latch is set
(`armNavInFlightSafety`), force-clearing it if the expected `videoId` effect
never fires. Cleared/rearmed alongside the existing clear paths.

**Why:** both were multi-day "silent failure with no recovery path" bugs —
worth remembering the pattern (any lock/latch tied to an async event that
might not fire needs its own timeout release), not just the specific fix.

**How to apply:** if adding new navigation locks or "no content" render
branches in this file, follow the same two patterns: give every latch a
timeout escape hatch, and never let a resolved-but-empty state render nothing
actionable.
