---
name: LIVE_OVERRIDE_ACTIVE HLS/RTMP coverage gaps
description: 5 bugs where HLS/RTMP override activation was silently mishandled across machine, mobile, and TV surfaces
---

## The rule
Every state guard or watchdog that handles PLAYING must also handle LIVE_OVERRIDE_ACTIVE for HLS/RTMP overrides, because LIVE_OVERRIDE_ACTIVE is a persistent "playing" state — it never transitions to PLAYING.

**Why:** LIVE_OVERRIDE_ACTIVE was added primarily with YouTube in mind (YouTube uses an iframe and bypasses the native video element entirely). Guards that list PLAYING/HANDOFF/PREPARING_NEXT but omit LIVE_OVERRIDE_ACTIVE silently fail when an HLS or RTMP override is active.

## The 5 bugs fixed

**1. `machine.ts` — `onBufferStalled` ignored LIVE_OVERRIDE_ACTIVE**
- HLS.js stall events (reported as `buffer-stalled`) were silently discarded when state was LIVE_OVERRIDE_ACTIVE.
- A stalled HLS/RTMP override would hang forever on TV/web with no recovery.
- Fix: added `LIVE_OVERRIDE_ACTIVE` to the escalation condition in `onBufferStalled`.

**2. `V2PlayerContainer.tsx` — `fsmIsWaiting` excluded LIVE_OVERRIDE_ACTIVE**
- The 12-second load-timeout watchdog and buffering-stall watchdog inside BroadcastBuffer only arm when `fsmIsWaiting=true`.
- With LIVE_OVERRIDE_ACTIVE excluded, an ExoPlayer silent failure on the override URL left the mobile player stuck indefinitely.
- Fix: added `LIVE_OVERRIDE_ACTIVE` to `fsmIsWaiting`.

**3. `V2PlayerContainer.tsx` — `isLoadingState` excluded LIVE_OVERRIDE_ACTIVE**
- The loading-phase interval timer (for progressive overlay messages) never started during override loading.
- Fix: added `LIVE_OVERRIDE_ACTIVE` to `isLoadingState`.

**4. `V2PlayerContainer.tsx` — `overlayContent` had no HLS LIVE_OVERRIDE_ACTIVE case**
- `overlayContent` returned `null` for HLS/RTMP overrides → no overlay text/spinner while loading.
- Also: `videoReady` was declared AFTER `overlayContent`, so the memo couldn't gate on first-frame readiness.
- Fix: moved `videoReady` declaration before `overlayContent`; added explicit LIVE_OVERRIDE_ACTIVE case gated on `videoReady` ("Switching to Live Override" / "Loading Override…"); added `videoReady` to useMemo deps.

**5. `LiveBroadcastV2.tsx` (TV) — overlay returned `null` for HLS LIVE_OVERRIDE_ACTIVE**
- TV overlay fell through to `null` during override loading → silent black screen on TV while HLS.js fetched the manifest.
- Fix: added `overridePlaying` state (set by `playing` event on the active video element); overlay shows "Tuning in…" until `overridePlaying=true`, then returns `null`.

## How to apply
When reviewing/writing code that branches on FSM state for active-playback behavior:
- YouTube overrides: state is LIVE_OVERRIDE_ACTIVE but the native video element is idle (excludeYouTube=true). Watchdogs won't fire because there's no Video/video element.
- HLS/RTMP overrides: state is LIVE_OVERRIDE_ACTIVE AND the native element is actively loading/playing. All watchdogs/overlays/gates that apply to PLAYING should also apply here.
- LIVE_OVERRIDE_ACTIVE never transitions to PLAYING — it's the terminal "override is on" state. UI that needs to know "is video visible?" must use first-frame signals (videoReady on mobile, overridePlaying on TV), not FSM state.
