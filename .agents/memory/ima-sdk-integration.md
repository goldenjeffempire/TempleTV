---
name: IMA SDK integration — TV
description: Google IMA HTML5 SDK integration patterns and durable TV configuration guidance.
---

# Google IMA / GAM Integration

## TV Web App (`artifacts/tv`)

**SDK loading:** `https://imasdk.googleapis.com/js/sdkloader/ima3.js` is loaded
via a synchronous `<script>` tag in `index.html`, before the app module. IMA is
provided through the global `google.ima` namespace.

**Type declarations:** `artifacts/tv/src/types/google-ima.d.ts` contains the
minimal ambient namespace for the API surface in use. Do not add
`@types/google.ima`; it collides with the ambient `@types/google.maps`
namespace.

**Environment:** `VITE_IMA_AD_TAG_URL` is a GAM VMAP URL. When unset, the
AdManager must be a complete no-op. Its type is declared in
`artifacts/tv/src/vite-env.d.ts`.

**Architecture:** `artifacts/tv/src/lib/adManager.ts` (`AdManager` class),
`artifacts/tv/src/hooks/useAdManager.ts` (React hook), and the `adContainerRef`
div in `LiveBroadcastV2.tsx`.

## Durable decisions

- Use VMAP rather than individual VAST tags so GAM controls preroll and midroll
  scheduling server-side.
- Mute and unmute live HLS buffers during breaks instead of pausing; this
  preserves broadcast FSM state.
- Disable VPAID (`VpaidMode.DISABLED`); Smart TV environments do not support it.
- Apply a 30-minute localStorage frequency cap to prevent accidental remounts
  from re-requesting.
- Keep the ad container at z-index 28, above the stall spinner (22) and
  progress bar (25).
- Run only with `variant="player"`, never `variant="hero"` (ambient background).
- Request on the first PLAYING FSM state, after the stream is confirmed live.

VMAP keeps break timing server-controlled and avoids client-side timer logic,
leaving ad operations in control of the schedule.