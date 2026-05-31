---
name: HLS.js & transcoder playback quality sprints 22-25
description: Multi-sprint improvements to HLS.js config, transcoder pipeline, GPU compositing, TV safe-area coverage, CSS containment, and cross-surface memoization
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

## Sprint 25 — CSS containment, cross-surface memoization, optimistic updates

### TV `index.css` — card + row containment
- `.tt-card`: added `contain: layout` — isolates card-level layout changes from sibling cards during hover/focus. Do NOT add `contain: paint` — it clips `transform: scale(1.04)` composited animations.
- `.tv-row`: added `will-change: opacity` + `contain: layout` — row focus fades now run fully on compositor thread, rows are layout-isolated from each other.

### `HlsVideoPlayer.tsx` — config completeness
Added `workerPath: undefined` and `autoStartLoad: true` (both were defaults; now explicit for documentation parity with `LiveBroadcastV2`).

### Mobile `index.tsx` — `HeroSection` + `CategoryRow` memoized
Both wrapped with `React.memo`. `HeroSection` re-renders only when `syncState` or `fallbackSermon` reference changes. `CategoryRow` re-renders only when `sermons` or `category` changes. Important: the `React.memo(function Name(){}` form — close with `});`, not `}`.

### Mobile `library.tsx` — `ContinueWatchingRow` hardened
- `PLACEHOLDER_IMG = require(...)` hoisted to module level (was inside component body — `require()` on every render is cached by Metro but wastes a property lookup per render).
- Wrapped with `React.memo`.
- `navigateToItem` wrapped with `useCallback(fn, [])` — stable reference across re-renders.

### Admin `videos.tsx` — optimistic updates for toggle mutations
`featureMutation`, `lockMutation`, `publishMutation` all upgraded from invalidate-on-success to full optimistic pattern:
1. `onMutate`: `cancelQueries` + `getQueriesData` snapshot + `setQueriesData` optimistic patch
2. `onError`: restore snapshot via `ctx.prev.forEach(([key, data]) => qc.setQueryData(key, data))`
3. `onSettled`: invalidate (moved from `onSuccess`)

Context type is inferred by TanStack Query — no explicit generic needed.

### Mobile type bug fixes
- `ChatPanel.tsx`: `state === "error"` was dead code — `ChatConnectionState` never includes `"error"`. Removed.
- `search.tsx`: `styles.footerText` was used but never defined in `StyleSheet.create`. Added `{ fontSize: 13, textAlign: "center" }`.
