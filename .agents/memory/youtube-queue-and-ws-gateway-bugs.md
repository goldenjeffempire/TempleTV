---
name: YouTube queue item fix + WS gateway phantom listener + web adapter boundKind
description: 5 bugs fixed across web adapter, WS gateway, TV component, react hook, and mobile phase timer
---

## YouTube queue items stuck in PREPARING_ACTIVE forever (web adapter)

**Rule:** `web.ts` YouTube bind path must fire `buffer-ready` immediately. Without it, the machine waits in PREPARING_ACTIVE for a `canplay` event that never fires (no src on the video element), showing "Tuning in…" forever.

**Why:** The previous fix (skip `buf.el.src` + skip `armLoadTimer` for YouTube) prevented the `error` cascade, but the machine still needs `buffer-ready` to transition PREPARING_ACTIVE → PLAYING.

**How to apply:** In `bind()`, after setting `buf.boundUrl = url` and `buf.boundKind = "youtube"`, call `cb.send({ type: "buffer-ready", bufferId: id })` immediately and return. The iframe handles display; the video element has no role.

## YouTube play intent must skip video.play() + watchdog.arm() (web adapter)

**Rule:** `play` intent handler must guard with `if (buf.boundKind === "youtube") return;` to prevent `NotSupportedError` rejection and false-positive `buffer-stalled` from the watchdog (no `timeupdate` events ever fire on an empty element).

**How to apply:** `boundKind` is tracked as an optional field on `WebBuffer`. Set it in every `bind()` branch (`buf.boundKind = kind`) and clear it in `unbind()` (`buf.boundKind = null`).

## YouTube short URL extraction (TV component)

**Rule:** `new URL(url).searchParams.get("v")` returns null for `https://youtu.be/VIDEOID` format — the iframe silently does not render. Use `extractYouTubeId(url)` helper that also checks `u.hostname === "youtu.be"` → `u.pathname.slice(1)`.

**Why:** Admins frequently paste short URLs from YouTube's share button.

## WS gateway phantom listener accumulation

**Rule:** The `close` handler in `ws.gateway.ts` must (1) set `socketClosed = true` and (2) call `broadcastOrchestrator.off("frame", activeFrameHandler)` — NOT the bare `onFrame` reference. If a `resume` message is in-flight during close, `bufferFrame` replaces `onFrame` on the emitter. Closing with `onFrame` is a no-op and `bufferFrame` stays permanently registered.

**Why:** `socketClosed` is declared but was never set to `true`, so the in-flight check `if (socketClosed) return;` always passed, re-registering `onFrame` on a dead socket after the DB await resolved.

## useV2Broadcast forceReconnect (react hook)

**Rule:** Expose `forceReconnect: () => void` from `UseV2BroadcastResult`. FATAL overlay "Try Again" buttons must call `forceReconnect()` rather than `window.location.reload()` — transport reconnect is faster, stateless, and self-heals without re-bootstrapping the SPA.

## Mobile LIVE_OVERRIDE_ACTIVE phase timer leak

**Rule:** `isLoadingState` includes `LIVE_OVERRIDE_ACTIVE` for phase messaging during override loading. But once `videoReady=true`, `overlayContent` returns null (no overlay), so the 5 s interval drives invisible state updates. Add a `useEffect([snapshot.state, videoReady])` that clears `phaseTimerRef` when `LIVE_OVERRIDE_ACTIVE && videoReady`.
