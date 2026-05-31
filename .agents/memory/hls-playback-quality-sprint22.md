---
name: HLS.js & transcoder playback quality sprints 22-24
description: Multi-sprint improvements to HLS.js config, transcoder pipeline, GPU compositing, and TV safe-area coverage across all player surfaces
---

## HLS.js config — all three TV surfaces now fully aligned

`LiveBroadcastV2`, `HlsVideoPlayer`, `BroadcastPreviewV2` share identical HLS.js settings:

- `abrEwmaDefaultEstimate: 10_000_000` (10 Mbps optimistic start)
- `abrEwmaFastLive: 3.0`, `abrEwmaSlowLive: 9.0`
- `liveSyncDurationCount: 3`, `liveMaxLatencyDurationCount: 10`
- `maxFragLookUpTolerance: 0.15`
- `appendErrorMaxRetry: 8`
- Retry: frag 12/400ms/6000ms, manifest 10/400ms, level 10/400ms, nudge 10/0.2

## stallRecoveryTimer leak — fixed on all surfaces

`LiveBroadcastV2` and `HlsVideoPlayer` both had a 30s `setTimeout` with no ref.
Fix: `stallRecoveryTimer` / `stallRecoveryTimerHls` ref + `hls.destroy` override to `clearTimeout`.

**Why:** Timer fires on destroyed `hls` instance → silent throw on some hls.js versions + 30s closure memory leak.

**How to apply:** Any new HLS player surface must follow this same pattern.

## Transcoder: deblock=-1:-1

Added to `-x264-params`: `me=umh:subme=7:direct=auto:deblock=-1:-1`

**Why:** `fast` preset default `deblock=0:0` blurs high-contrast edges. At CRF=21 + raised bitrates the encode has enough bits; reducing the deblock threshold sharpens on-screen text and lower-thirds. Most visible at 720p+.

## TV safe areas — complete coverage

All TV UI elements now use `--tv-safe-h` / `--tv-safe-v` CSS vars (defined in `index.css` as `clamp(48px,5vw,96px)` / `clamp(32px,4vh,72px)`):

- `Player.tsx`: back button, PiP button (with `calc(var(--tv-safe-h,32px)+54px)` offset)
- `BroadcastLiveCompanion.tsx`: `left`, `bottom`
- `ChatOverlay.tsx`: both open-button and panel (style prop overrides Tailwind `bottom-6 right-6`)
- `LiveHero.tsx`: fallback banner `top`
- `LiveBroadcastV2.tsx`: ON AIR badge uses `var(--tv-safe-*, clamp(...))` — clamp fallback for admin preview context which has no `--tv-safe-*`

**Note:** LiveBroadcastV2 is used in both TV and admin. Always use `var(--tv-safe-*, fallback)` pattern, not bare `--tv-safe-*`, so admin preview still renders correctly.

## GPU compositing improvements

- `index.css video {}`: added `will-change: transform` — forces GPU compositor layer at parse time, prevents late-promotion decode stall on Tizen/webOS
- `LiveBroadcastV2.tsx` root div: `contain: "layout style paint"`, `isolation: "isolate"`
- `HlsVideoPlayer.tsx` root div: `contain: isFs ? "layout style" : "layout style paint"`, `isolation: "isolate"` — `paint` disabled in fullscreen to avoid same clipping issue as `overflow:hidden`

**Why:** Without `contain`, 60fps badge-pulse animation triggers full-page layout recalculation on every frame on Tizen 4-6 / webOS 5-6.

**How to apply:** Any new fullscreen player container should get `contain: "layout style paint"` + `isolation: "isolate"`. If the container supports fullscreen, conditionally drop `paint` while in fullscreen state.
