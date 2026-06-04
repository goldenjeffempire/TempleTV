---
name: PiP entered while YouTube override already active
description: V2PlayerContainer must exit-on-YouTube-override using the COMBINED (override AND in-PiP) condition, not the rising edge of either.
---

# Black PiP when override is already active at PiP entry

`artifacts/mobile/components/V2PlayerContainer.tsx` cannot show a YouTube override
inside the OS Picture-in-Picture window (native `<Video>` is idle; the override
plays in an iframe/overlay outside PiP). When both conditions hold it must fire
`onFatal` so `player.tsx` cancels the PiP notification and tears PiP down.

**Bug:** the exit effect originally watched only the *rising edge* of
`isYouTubeOverride`. If the user entered PiP while a YouTube override was ALREADY
active, no rising edge fired → black PiP forever.

**Fix / how to apply:** drive the effect off the COMBINED condition
`isYouTubeOverride && (isInPip ?? isInPictureInPictureMode())`. `isInPip?: boolean`
is a reactive prop threaded from `player.tsx` (interface → wrapper destructure → JSX
forward → every `BroadcastHlsPlayer` call site); it falls back to the imperative
`isInPictureInPictureMode()` when undefined so either entry order is covered. Fire
once per combined-active session via a `youtubeInPipExitFiredRef` that resets when
either condition clears, and gate to the primary driver only
(`if (minimal || suppressEvents) return;`) so the 2–3 mounted containers don't each
fire `onFatal`.

**Why the gating matters:** without `minimal`/`suppressEvents` gating, multiple
mounted containers (HeroSection + V2PlayerContainer×2) each fire duplicate
navigation/fatal events. This is the same primary-driver discipline used elsewhere
in the mobile player stack.
