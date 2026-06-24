/**
 * Web/TV adapter intent applier.
 *
 * Wires `PlayerMachine` AdapterIntent commands to a pair of HTML5 <video>
 * elements (or YouTube IFrames). Adapter never owns the FSM — it only
 * applies intents and feeds back buffer-* events to the FSM.
 */

import type { AdapterIntent, IntentHandler } from "../machine.js";
import type { PlayerEvent, V2Item, V2Override } from "../types.js";
import { Watchdog } from "../watchdog.js";

export interface WebBuffer {
  /** The <video> element bound to this buffer. */
  el: HTMLVideoElement;
  /** Currently bound source descriptor — for diff/avoid-rebind. */
  boundUrl: string | null;
  /**
   * Kind of the currently bound source ("hls", "mp4", "youtube", etc.).
   * Used by the `play` intent handler to skip native video.play() and
   * watchdog arming for YouTube sources — which are displayed via an
   * external iframe and have no native <video> media loaded.
   * Optional so callers that create WebBuffer literals (e.g. react.ts
   * `attachElements`) don't need to be updated — undefined is treated
   * identically to null by all consumers of this field.
   */
  boundKind?: string | null;
  /** Optional cleanup for hls.js / dash.js attachments. */
  detach?: () => void;
}

export interface WebAdapterCallbacks {
  /** Send player events back into the FSM. */
  send: (event: PlayerEvent) => void;
  /** Optional: load HLS via hls.js when needed (caller injects so this lib has no bundled hls.js dep). */
  attachHls?: (video: HTMLVideoElement, url: string) => () => void;
  /** Optional: load DASH via dash.js. */
  attachDash?: (video: HTMLVideoElement, url: string) => () => void;
  /** Optional: bind YouTube IFrame Player API. */
  attachYouTube?: (video: HTMLVideoElement, url: string) => () => void;
}

/**
 * How long to wait for `canplay` / `loadedmetadata` after a `bind` before
 * declaring the source unreachable.
 *
 * 20 s gives headroom for:
 *   - Non-faststart MP4s routed through the media proxy on high-latency
 *     connections (dev → API → CDN chain can add 2–5 s on cold TCP).
 *   - HLS manifest + first segment on a 2–3 Mbps mobile link.
 * The `progress` extension (BIND_PROGRESS_TIMEOUT_MS = 90 s) kicks in as
 * soon as any bytes arrive, so a large file never hits this deadline while
 * data is flowing.
 */
const BIND_LOAD_TIMEOUT_MS = 20_000;

/**
 * Extended timeout once `progress` fires during the bind phase.
 * `progress` means bytes are flowing — server is alive. We give large
 * MP4 files time to download past the moov atom. 90 s covers a 300 MB
 * file on a 30 Mbps link (typical home broadband) with headroom for
 * TCP slow-start and CDN first-byte latency.
 */
const BIND_PROGRESS_TIMEOUT_MS = 90_000;

// Watchdog thresholds — per-phase values passed directly to the Watchdog
// constructor below. See watchdog.ts for the 3-phase model documentation.
//
// Raised from 15/15/25 → 20/20/30 s to give more tolerance for buffering
// on slow/congested networks without causing spurious stall→skip cascades.
// Broadcast content (sermons, worship streams) regularly pauses to buffer
// on mobile links during initial segment fetch and mid-stream rebuffer;
// the old 15 s thresholds fired false-positive stalls too aggressively.
const WATCHDOG_INITIAL_LOAD_MS = 20_000;
const WATCHDOG_REBUFFER_MS     = 20_000;
const WATCHDOG_STABLE_MS       = 30_000;
const WATCHDOG_STABLE_PLAY_MS  = 30_000;

/**
 * How many seconds before the actual end of the video (per its `duration`
 * property) to fire a `buffer-near-end` event that proactively loads the
 * next item into the inactive buffer.
 *
 * This fires based on the HTML5 video element's real `duration` (the actual
 * encoded file length) rather than the server's scheduled `durationSecs`
 * (which may be a 1800-second placeholder for freshly-uploaded videos).
 * Using the real duration guarantees the preload fires at the right moment
 * even when the DB duration doesn't yet match the encoded file length —
 * the most common cause of SYNCING black-screen gaps between queue items.
 *
 * Matches PRELOAD_LEAD_MS in machine.ts (90 s).
 */
const NEAR_END_LEAD_SECS = 90;

/**
 * Return type of `createWebAdapter`.
 *
 * `apply`   — the `IntentHandler` fed into `PlayerMachine`.
 * `destroy` — removes all DOM event listeners and clears internal timers.
 *             Must be called when the adapter is no longer needed (before
 *             creating a new adapter for the same <video> elements) so that
 *             old listeners cannot fire stale `buffer-error` / `buffer-ready`
 *             events into the FSM after the elements have been re-attached to
 *             a fresh adapter. Especially important in React Strict Mode where
 *             effects run twice, and in SPA navigation where the same element
 *             can be passed to `attachElements` across multiple mounts.
 */
export interface WebAdapterHandle {
  apply: IntentHandler;
  destroy: () => void;
}

export function createWebAdapter(
  bufferA: WebBuffer,
  bufferB: WebBuffer,
  cb: WebAdapterCallbacks,
  initialActiveId: "A" | "B" = "A",
): WebAdapterHandle {
  const buffers: Record<"A" | "B", WebBuffer> = { A: bufferA, B: bufferB };

  // AbortController for DOM event listeners. Aborting it removes every
  // listener added with `{ signal }` in one synchronous call, with no need
  // to keep an explicit list of (element, type, fn) triples.
  const listenerAbort = new AbortController();
  const { signal } = listenerAbort;

  // Set initial z-index, opacity, and mute state from initialActiveId.  This
  // matters when re-attaching elements to a running session whose active buffer
  // is B (e.g. after a single-item loop handoff happened while the component
  // was unmounted).  Without it the new elements would paint in the wrong order
  // for one frame before the first swap intent corrects them.
  //
  // Opacity is set in addition to z-index because `object-fit: contain` leaves
  // the letterbox/pillarbox areas of the <video> element transparent in
  // Chromium-based browsers.  Without opacity control, the inactive buffer
  // (z-index 1) bleeds through those transparent areas and renders a visible
  // second video stream behind the active buffer — the "duplicate video" bug.
  // Setting opacity:0 on the inactive buffer hides it visually while keeping
  // it in the DOM so the browser continues buffering/decoding its content.
  const initialActive = buffers[initialActiveId];
  const initialInactive = buffers[initialActiveId === "A" ? "B" : "A"];
  initialActive.el.style.zIndex = "2";
  initialActive.el.style.opacity = "1";
  initialActive.el.muted = false;
  initialInactive.el.style.zIndex = "1";
  initialInactive.el.style.opacity = "0";
  initialInactive.el.muted = true;

  const watchdog = new Watchdog({
    initialLoadThresholdMs: WATCHDOG_INITIAL_LOAD_MS,
    rebufferThresholdMs:    WATCHDOG_REBUFFER_MS,
    stableThresholdMs:      WATCHDOG_STABLE_MS,
    stablePlayMs:           WATCHDOG_STABLE_PLAY_MS,
    onStall: () => {
      cb.send({ type: "buffer-stalled", bufferId: activeId });
    },
  });

  let activeId: "A" | "B" = initialActiveId;

  // Tracks the last (boundUrl + duration) key for which buffer-near-end was
  // fired per buffer.  A composite key prevents re-firing on the same item
  // (timeupdate fires many times per second) while automatically resetting
  // when the bound URL or reported duration changes (new item or loop pass).
  const nearEndFiredKey: Record<"A" | "B", string | null> = { A: null, B: null };

  // Tracks whether each buffer has produced at least one real timeupdate
  // advance since its last bind/load.  This flag is the primary guard
  // against false-positive `ended` events caused by seek-past-end:
  //
  //   When resolvePositionSecs() returns a value ≥ the video's actual
  //   encoded duration (e.g. because durationSecs in the DB is a 1800 s
  //   placeholder and the client joins late), the browser clamps
  //   `currentTime` to `duration` and fires `ended` before any timeupdate
  //   event — sometimes within tens of milliseconds of the seek.  Without
  //   this guard, that instant `ended` propagates as a genuine natural-end
  //   signal, triggering premature HANDOFF and advancing the broadcast anchor
  //   on the server side, pushing ALL connected clients to the next item far
  //   too early.
  //
  //   By requiring at least one timeupdate advance before honoring `ended`,
  //   we ensure the video actually played some frames before the transition.
  //   The flag is reset on every bind() that triggers a full element reload,
  //   so it stays fresh across item transitions and loop passes.
  const hasSeenTimeupdateSinceLoad: Record<"A" | "B", boolean> = { A: false, B: false };

  // Per-buffer bind load timeout.
  const loadTimers: Record<"A" | "B", ReturnType<typeof setTimeout> | null> = { A: null, B: null };

  function clearLoadTimer(id: "A" | "B"): void {
    if (loadTimers[id] !== null) {
      clearTimeout(loadTimers[id]!);
      loadTimers[id] = null;
    }
  }

  function armLoadTimer(id: "A" | "B"): void {
    clearLoadTimer(id);
    // Give the inactive (preload) buffer 3× more time before declaring a
    // timeout.  The active buffer must fail fast so recovery is quick; the
    // inactive buffer has the entire preload window (≥ 90 s) to retrieve
    // content, so a tight 10 s deadline causes premature errors on large
    // MP4 files or slow connections.
    const timeoutMs = id === activeId ? BIND_LOAD_TIMEOUT_MS : BIND_LOAD_TIMEOUT_MS * 3;
    loadTimers[id] = setTimeout(() => {
      loadTimers[id] = null;
      cb.send({ type: "buffer-error", bufferId: id, error: "load-timeout" });
    }, timeoutMs);
  }

  // Wire buffer events (once per buffer).
  for (const id of ["A", "B"] as const) {
    const buf = buffers[id];

    // All listeners pass `{ signal }` so `listenerAbort.abort()` in `destroy()`
    // removes every handler in one call — no manual tracking needed.
    buf.el.addEventListener("loadedmetadata", () => {
      clearLoadTimer(id);
      cb.send({ type: "buffer-ready", bufferId: id });
    }, { signal });
    buf.el.addEventListener("canplay", () => {
      clearLoadTimer(id);
      cb.send({ type: "buffer-ready", bufferId: id });
    }, { signal });
    buf.el.addEventListener("error", () => {
      clearLoadTimer(id);
      cb.send({ type: "buffer-error", bufferId: id, error: "media-error" });
    }, { signal });
    buf.el.addEventListener("ended", () => {
      clearLoadTimer(id);
      // Guard against false-positive `ended` events caused by seek-past-end.
      //
      // When resolvePositionSecs() computes a target position ≥ the video's
      // actual encoded duration (e.g. because the DB carries a 1800 s
      // placeholder and the client joins late), the browser clamps currentTime
      // to duration and immediately fires `ended` — often within < 100 ms,
      // before any timeupdate event has had a chance to fire.  Sending
      // buffer-ended in this case would trigger premature HANDOFF, advancing
      // the broadcast anchor on the server and jumping ALL connected clients
      // to the next item far too early.
      //
      // Requiring at least one timeupdate advance since the last bind/load
      // guarantees the element actually played at least one decoded frame
      // before the transition is honoured.  A genuine natural-end always
      // sees timeupdate events during playback; only a seek-that-overshoots
      // produces `ended` with hasSeenTimeupdateSinceLoad === false.
      //
      // Clear the bound URL unconditionally so the next bind() call always
      // performs a full src + load() reset (critical for single-item loops).
      buf.boundUrl = null;
      if (!hasSeenTimeupdateSinceLoad[id]) {
        // False-positive suppressed.  The stall watchdog will fire if the
        // element is genuinely stuck; do not send buffer-ended here.
        return;
      }
      cb.send({ type: "buffer-ended", bufferId: id });
    }, { signal });

    buf.el.addEventListener("progress", () => {
      // `progress` fires when the browser has received more data from the
      // server. Two actions:
      //
      // 1. If still in the bind load window, extend it to the large-file
      //    timeout so a big non-faststart MP4 has time to buffer past moov.
      if (loadTimers[id] !== null) {
        clearTimeout(loadTimers[id]!);
        loadTimers[id] = setTimeout(() => {
          loadTimers[id] = null;
          cb.send({ type: "buffer-error", bufferId: id, error: "load-timeout" });
        }, BIND_PROGRESS_TIMEOUT_MS);
      }
      // 2. If this is the active buffer, signal the watchdog that data is
      //    flowing. This prevents false-positive stall detection during a
      //    mid-playback rebuffer pause where `currentTime` is frozen but
      //    the network is actively delivering the next segment.
      if (id === activeId) watchdog.notifyActive();
    }, { signal });

    buf.el.addEventListener("timeupdate", () => {
      // Record that this buffer produced at least one decoded frame since its
      // last bind.  Set for both active and inactive buffers so that when an
      // inactive preloaded buffer becomes active after HANDOFF, any earlier
      // playback progress it made is correctly reflected.
      if (!hasSeenTimeupdateSinceLoad[id]) hasSeenTimeupdateSinceLoad[id] = true;
      if (id !== activeId) return;
      watchdog.feed(buf.el.currentTime);
      // Fire buffer-near-end based on the video element's ACTUAL duration
      // (encoded file length) rather than the server's scheduled durationSecs.
      // This triggers proactive preloading of the next item even when the DB
      // carries a 1800 s placeholder for freshly-uploaded videos, eliminating
      // the SYNCING black-screen gap that occurs when the preload frame from the
      // server arrives too late (or not at all) before the video naturally ends.
      const { currentTime, duration } = buf.el;
      if (duration > 0 && isFinite(duration) && duration - currentTime <= NEAR_END_LEAD_SECS) {
        const nearEndKey = `${buf.boundUrl ?? ""}@${Math.floor(duration)}`;
        if (nearEndFiredKey[id] !== nearEndKey) {
          nearEndFiredKey[id] = nearEndKey;
          cb.send({ type: "buffer-near-end", bufferId: id });
        }
      }
    }, { signal });

    buf.el.addEventListener("waiting", () => {
      // "waiting" fires when the browser pauses to buffer more data.
      // Notify the watchdog that something is happening so a single
      // "waiting" event doesn't count as dead silence. The `progress`
      // handler above provides the stronger "data flowing" signal; this
      // is a belt-and-suspenders notification for environments where
      // `progress` may be throttled.
      if (id === activeId) watchdog.notifyActive();
    }, { signal });

    buf.el.addEventListener("playing", () => {
      // Actual playback resumed after buffering — reset watchdog baseline
      // so accumulated paused time doesn't inflate the stall counter.
      if (id === activeId) watchdog.feed(buf.el.currentTime);
    }, { signal });

    buf.el.addEventListener("seeking", () => {
      // A seek temporarily freezes `currentTime` while the browser jumps
      // to the target. Notify the watchdog so a slow seek to a new segment
      // doesn't look like a stall to the position-advance check.
      if (id === activeId) watchdog.notifyActive();
    }, { signal });

    buf.el.addEventListener("seeked", () => {
      // Seek landed — feed the actual new position to establish the
      // post-seek baseline for stall detection.
      if (id === activeId) watchdog.feed(buf.el.currentTime);
    }, { signal });
  }

  /** Tears down this adapter: removes all DOM event listeners and clears timers. */
  function destroy(): void {
    // Aborting the controller removes every listener registered with { signal }
    // in one synchronous call — prevents stale handlers from firing buffer-error /
    // buffer-ready events into the FSM after detachElements().
    listenerAbort.abort();
    clearLoadTimer("A");
    clearLoadTimer("B");
    watchdog.disarm();
  }

  function apply(intent: AdapterIntent): void {
    switch (intent.type) {
      case "bind":
        return bind(buffers[intent.bufferId], intent.bufferId, intent.item);
      case "play": {
        const buf = buffers[intent.bufferId];
        // YouTube sources are displayed via an external iframe — the <video>
        // element has no src and cannot be played. Calling play() would reject
        // with NotSupportedError, and arming the watchdog would fire
        // buffer-stalled after WATCHDOG_INITIAL_LOAD_MS with no timeupdate
        // events, triggering a spurious RECOVERING_PRIMARY cascade. Skip both.
        if (buf.boundKind === "youtube") return;
        // Only seek if position differs by more than 4 seconds to avoid
        // jarring seeks from minor clock-skew between successive snapshots.
        // 2 s was too tight: the transport's belt-and-suspenders REST fetch
        // for item.advanced events can arrive 2–3 s after the WS snapshot,
        // producing a same-item snapshot with a slightly different Date.now()
        // base; the 2 s guard was not enough to absorb that difference.
        // 4 s is still well within the range where a real drift correction
        // (e.g. after a server restart) needs to re-sync the playhead.
        const targetSecs = intent.positionSecs;
        const currentSecs = buf.el.currentTime;
        if (Math.abs(currentSecs - targetSecs) > 4) {
          buf.el.currentTime = targetSecs;
        }
        const playPromise = buf.el.play();
        if (playPromise) {
          playPromise.catch(() => {
            // Autoplay blocked by browser policy. Mute and retry — a muted
            // video is permitted by every browser's autoplay policy and lets
            // the stream continue visually. The user can unmute later.
            if (intent.bufferId === activeId) {
              buf.el.muted = true;
              void buf.el.play().catch(() => {
                // Muted play also rejected (rare — page may be fully hidden,
                // sandboxed, or a Smart TV with strict autoplay rules).
                // Retry once more after 1 s: browsers sometimes allow play
                // after the event-loop clears the autoplay policy evaluation.
                // If this third attempt also fails, the stall watchdog fires
                // within its current-phase threshold and triggers FSM recovery.
                setTimeout(() => {
                  if (intent.bufferId !== activeId) return;
                  void buf.el.play().catch(() => { /* stall watchdog handles */ });
                }, 1_000);
              });
            }
          });
        }
        watchdog.arm();
        return;
      }
      case "pause":
        buffers[intent.bufferId].el.pause();
        watchdog.disarm();
        return;
      case "swap": {
        activeId = intent.activeBufferId;
        const top = buffers[activeId];
        const bot = buffers[activeId === "A" ? "B" : "A"];
        top.el.style.zIndex = "2";
        top.el.style.opacity = "1";
        top.el.muted = false;
        bot.el.style.zIndex = "1";
        bot.el.style.opacity = "0";
        bot.el.muted = true;
        // Re-arm watchdog on the new active buffer. notifyActive() resets
        // the clock immediately so the new buffer gets a full grace window
        // from the moment it becomes active, regardless of how long it was
        // sitting idle as the inactive preload.
        watchdog.disarm();
        watchdog.arm();
        watchdog.notifyActive();
        return;
      }
      case "unbind":
        clearLoadTimer(intent.bufferId);
        return unbind(buffers[intent.bufferId]);
      case "show-overlay":
      case "hide-overlay":
        // UI components observe FSM snapshot directly — no DOM action here.
        return;
    }
  }

  function bind(buf: WebBuffer, id: "A" | "B", item: V2Item | V2Override): void {
    const url = "source" in item ? item.source.url : item.url;
    // Reset per-URL sentinels whenever the bound URL changes so they fire
    // again for the freshly loaded item.
    if (buf.boundUrl !== url) {
      nearEndFiredKey[id] = null;
      // New URL — the element has not yet played any frames of this content.
      hasSeenTimeupdateSinceLoad[id] = false;
    }
    if (buf.boundUrl === url) {
      // An ended element reports readyState=4 and error=null — both
      // "healthy" by the checks below — but calling play() on it without
      // a prior load() does not restart the video on all browsers (especially
      // Smart TVs). Treat ended elements as unhealthy so the full
      // pause→detach→src→load path runs, resetting the element cleanly.
      const isHealthy = buf.el.error === null && buf.el.readyState >= 1 && !buf.el.ended;
      if (isHealthy) {
        clearLoadTimer(id);
        return;
      }
      // Element is errored/unloaded: tear down any existing hls.js attachment
      // and let the normal bind path below re-initialise everything cleanly.
      if (buf.detach) {
        buf.detach();
        buf.detach = undefined;
      }
      buf.boundUrl = null; // force full reload path
      // Force-reloading the same URL — treat as a fresh start since the old
      // element state (playback position, decoded frames) is being discarded.
      hasSeenTimeupdateSinceLoad[id] = false;
      nearEndFiredKey[id] = null;
    }
    // Pause the element before detaching / swapping source. An in-flight
    // `play()` promise rejects with AbortError in Chromium when the src is
    // changed while play is pending; that AbortError fires the video element's
    // `error` event in some browsers, causing a spurious `buffer-error` that
    // kicks off an unwanted recovery cycle. Pausing first drains the promise.
    try { buf.el.pause(); } catch { /* ignore if already stopped */ }
    if (buf.detach) {
      buf.detach();
      buf.detach = undefined;
    }
    const kind = "source" in item ? item.source.kind : item.kind;
    if (kind === "hls") {
      if (buf.el.canPlayType("application/vnd.apple.mpegurl")) {
        buf.el.src = url;
        buf.el.load();
      } else if (cb.attachHls) {
        buf.detach = cb.attachHls(buf.el, url);
      } else {
        buf.el.src = url;
        buf.el.load();
      }
    } else if (kind === "dash" && cb.attachDash) {
      buf.detach = cb.attachDash(buf.el, url);
    } else if (kind === "youtube") {
      // YouTube URLs cannot be played natively by the <video> element.
      // Loading them causes an `error` event → buffer-error → RECOVERING_PRIMARY
      // cascade even in LIVE_OVERRIDE_ACTIVE state (onBufferError has no state guard).
      // Skip native loading entirely.
      //
      // Fire buffer-ready immediately so the FSM can transition out of
      // PREPARING_ACTIVE → PLAYING without waiting for a <video> canplay event
      // that will never come. For LIVE_OVERRIDE_ACTIVE the machine already
      // gates stall escalation on override.kind, so a spurious watchdog tick
      // is harmless — but not firing buffer-ready left the machine stuck in
      // PREPARING_ACTIVE forever, showing "Tuning in…" indefinitely for any
      // YouTube item in the broadcast queue.
      //
      // If an external YouTube handler is provided (e.g., TV iframe), wire it up.
      if (cb.attachYouTube) {
        buf.detach = cb.attachYouTube(buf.el, url);
      }
      buf.boundUrl = url;
      buf.boundKind = "youtube";
      // Emit synchronously — safe because `send` only queues a PlayerEvent
      // into the machine's event buffer; it does not call back into the adapter.
      cb.send({ type: "buffer-ready", bufferId: id });
      return; // skip armLoadTimer — no native media loading occurs
    } else {
      buf.el.src = url;
      buf.el.load();
    }
    buf.boundUrl = url;
    buf.boundKind = kind;
    armLoadTimer(id);
  }

  function unbind(buf: WebBuffer): void {
    // Pause before clearing src. An in-flight `play()` promise rejects with
    // AbortError when src is removed in Chrome/Edge; that rejection can
    // propagate as a video element `error` event and fire a spurious
    // `buffer-error` into the FSM. Pausing first ensures the promise has
    // already settled before we remove the source.
    try { buf.el.pause(); } catch { /* ignore */ }
    if (buf.detach) {
      buf.detach();
      buf.detach = undefined;
    }
    buf.el.removeAttribute("src");
    buf.el.load();
    buf.boundUrl = null;
    buf.boundKind = null;
  }

  return { apply, destroy };
}
