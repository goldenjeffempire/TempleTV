import type {
  PlayerEvent,
  PlayerSnapshot,
  PlayerState,
  V2Item,
  V2Override,
  V2Snapshot,
} from "./types.js";

/**
 * Determine the playback start position (seconds) for a `play` intent.
 *
 * HLS supports efficient segment-level seeking via the manifest — use the
 * wall-clock position so all viewers stay in sync regardless of when they
 * connect.
 *
 * MP4 / DASH / YouTube: always return 0.
 *
 * Why: seeking in a large non-faststart MP4 requires the browser to first
 * locate the moov atom, which is typically at the END of the file. The
 * browser must issue multiple Range requests through the media proxy to
 * find it; on a high-latency proxy chain (dev → API server → CDN) this
 * sequence routinely exhausts the stall watchdog before `loadedmetadata`
 * fires, triggering RECOVERING_PRIMARY → RECOVERING_FAILOVER → SKIP_PENDING
 * → `/report-stall` → source blacklisted → "Off Air".
 *
 * Playing from position 0 sidesteps moov-seeking entirely. The
 * `naturalItemEnd` callback writes the real duration back to the DB on the
 * first natural play-through, so all subsequent loops are scheduled
 * correctly without any operator action.
 */
function resolvePositionSecs(
  item: V2Item | V2Override | null | undefined,
  startsAtMs: number,
): number {
  if (!item) return 0;
  const kind = "source" in item
    ? (item as V2Item).source.kind
    : (item as V2Override).kind;
  if (kind === "hls") {
    const elapsed = Math.max(0, (Date.now() - startsAtMs) / 1000);
    // Cap at (durationSecs - 2) for V2Items with a known duration.
    //
    // Problem this fixes: if the DB row's durationSecs overestimates the
    // actual encoded video length (e.g. a 30-min file catalogued as 86400 s
    // due to a missing probe at upload), the stale-snapshot guard
    // (endsAtMs > Date.now()) never fires, so the machine binds the item
    // and requests a seek to `elapsed` seconds.  When elapsed > actual
    // encoded duration, AVPlayer / ExoPlayer either clamps to the last
    // frame and immediately fires didJustFinish, or surfaces a seek error.
    // Either path creates a rapid HANDOFF → rebind → worse-elapsed → repeat
    // loop on mobile — the "single HLS segment replaying" symptom.
    //
    // Capping at (durationSecs - 2) is safe: the stale-snapshot guard
    // already prevents binding when elapsed ≥ durationSecs in the normal
    // case.  The 2 s margin only matters when durationSecs is slightly
    // wrong, providing a valid in-bounds seek target so the player can
    // finish naturally and trigger the naturalEnd callback that corrects
    // the DB row for all future loops.
    if ("durationSecs" in item && (item as V2Item).durationSecs > 0) {
      return Math.min(elapsed, Math.max(0, (item as V2Item).durationSecs - 2));
    }
    return elapsed;
  }
  return 0;
}

/**
 * Deterministic playback state machine.
 *
 * Drives the A/B buffer model used on every surface. The machine itself
 * does NOT touch the DOM or any media element — adapters subscribe to
 * its `bind`, `play`, `pause`, `swap`, `unbind` intents and apply them
 * to the underlying player(s). This keeps the FSM testable and shareable
 * across web/tv/mobile.
 *
 * Invariants:
 *   - The active buffer always plays. The inactive buffer always preloads
 *     `next` if known, otherwise stays unbound.
 *   - We never destroy a buffer — only swap z-index/audio. This is what
 *     guarantees zero blank frames between items.
 *   - Server snapshots win on disagreement. Local errors trigger recovery
 *     transitions but the server's view of `current` is authoritative.
 *
 * State flow for a new item:
 *   BOOTSTRAP / SYNCING
 *     → (snapshot with new item) → PREPARING_ACTIVE
 *     → (buffer-ready) → PLAYING
 *     → (buffer-error once) → RECOVERING_PRIMARY
 *     → (buffer-ready after rebind) → PLAYING (primaryRetries reset)
 *     → (buffer-error again) → RECOVERING_FAILOVER
 *     → (buffer-ready) → PLAYING  |  (no failover) → SKIP_PENDING
 *     → (report-stall fires) → server skips → new snapshot → cycle repeats
 *     → SYNCING (no more items) → overlay "Off air"
 */

export type AdapterIntent =
  | { type: "bind"; bufferId: "A" | "B"; item: V2Item | V2Override }
  | { type: "play"; bufferId: "A" | "B"; positionSecs: number }
  | { type: "pause"; bufferId: "A" | "B" }
  | { type: "swap"; activeBufferId: "A" | "B" }
  | { type: "unbind"; bufferId: "A" | "B" }
  | { type: "show-overlay"; kind: "offline" | "failover"; reason: string | null }
  | { type: "hide-overlay" };

export type IntentHandler = (intent: AdapterIntent) => void;

/**
 * How far in advance the server sends a `preload` frame for the next item.
 * 90 s gives the inactive B buffer time to download a significant portion of
 * the next MP4 before the A buffer ends — crucial for large files (200–300 MB)
 * on typical broadband where 10 s is not enough to buffer the moov atom.
 * HLS sources benefit too: 90 s loads the manifest + several segments ahead,
 * eliminating the black-screen gap between queue items. Raised from 60 s to
 * provide a safety margin for slow/congested connections and large MP4 sources
 * where the browser must download the moov atom before `canplay` fires.
 */
const PRELOAD_LEAD_MS = 90_000;

/**
 * How long the active buffer must be stuck (no timeupdate progress) before
 * the watchdog declares a stall. 15 s balances:
 *   - HLS: manifest + first segment on a slow connection
 *   - Large MP4: initial buffering past the moov atom on a 10 Mbps link
 *   - Brief CDN hiccups or mid-stream rebuffer pauses
 * without being so long that a genuinely broken source blocks the queue
 * for a full broadcast segment. Reduced from 20 s — 15 s means a bad item
 * is detected and skipped one full tick cycle sooner, cutting the maximum
 * per-item black-screen window from ~20 s to ~15 s.
 */
const STALL_THRESHOLD_MS = 15_000;

export class PlayerMachine {
  private snapshot: PlayerSnapshot = {
    state: "BOOTSTRAP",
    activeBufferId: "A",
    bufferA: null,
    bufferB: null,
    lastServerSnapshot: null,
    lastSequence: 0,
  };
  private listeners = new Set<(snap: PlayerSnapshot) => void>();
  private primaryRetries = 0;
  /**
   * Called when the active buffer ends with no inactive item ready.
   * Wire this to `transport.requestSnapshot()` so the client fetches
   * fresh state immediately instead of waiting for the next server
   * keep-alive (up to 8 s after the orchestrator change).
   */
  private onNeedSnapshotCb: (() => void) | null = null;

  /**
   * Called when the active buffer fires a natural `ended` event and the
   * HANDOFF to the inactive buffer succeeds.  Wire this to POST /natural-end
   * so the server immediately advances the cycle anchor (in case durationSecs
   * on the queue row is longer than the actual video file).
   */
  private onNaturalEndCb: ((itemId: string) => void) | null = null;

  /**
   * The ID of the last item that fired a natural `ended` event on the active
   * buffer.  Used as a post-HANDOFF guard: prevents `onSnapshot()` from
   * re-binding the just-finished item when the server's snapshot still shows
   * it as `current` (because the server hasn't received the naturalEnd signal
   * yet and hasn't advanced its wall-clock anchor).
   *
   * Cleared when the server's snapshot confirms a genuinely different current
   * item, guaranteeing we always accept the server as authoritative after
   * it has caught up.
   */
  private lastEndedItemId: string | null = null;
  /**
   * Wall-clock timestamp (Date.now()) when lastEndedItemId was last set.
   * Enforces a 30-second TTL on the post-natural-end guard: if the
   * naturalItemEnd POST never reached the server (network error) the server
   * keeps showing the ended item as current with endsAtMs far in the future.
   * Without a TTL the guard would block rebinding for the entire remaining
   * slot — potentially 1800 s if the default placeholder was never corrected.
   * After 30 s the guard is cleared and normal snapshot processing resumes.
   */
  private lastEndedAtMs: number | null = null;

  /**
   * The `startsAtMs` value from the server snapshot that caused the machine
   * to enter SKIP_PENDING due to exhausted retries on the active buffer.
   *
   * Purpose: prevent the machine from endlessly re-binding the same
   * unloadable source. Without this guard, `handleServerSnapshot` would
   * reset `primaryRetries` and call `bindActive()` on every incoming
   * snapshot tick (every ~5 s) even though the source hasn't changed —
   * producing an infinite PREPARING_ACTIVE → RECOVERING → SKIP_PENDING loop
   * that hammers the browser's media pipeline on a video it cannot load
   * (e.g. a large non-faststart MP4 whose moov atom discovery exceeds the
   * 90-second progress timeout).
   *
   * Cleared when:
   *  - The server issues a fresh `startsAtMs` for the same item (new cycle).
   *  - The server advances to a different item (handled by the isNewItem
   *    branch which resets `primaryRetries` and calls `bindActive`).
   *  - `onForceSkip()` is called (operator action — always rebind).
   */
  private skipPendingAnchorMs: number | null = null;

  constructor(private readonly emit: IntentHandler) {}

  setNeedSnapshotCallback(fn: () => void): void {
    this.onNeedSnapshotCb = fn;
  }

  setNaturalEndCallback(fn: (itemId: string) => void): void {
    this.onNaturalEndCb = fn;
  }

  getSnapshot(): PlayerSnapshot {
    return this.snapshot;
  }

  subscribe(fn: (snap: PlayerSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(next: Partial<PlayerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const l of this.listeners) l(this.snapshot);
  }

  private transition(state: PlayerState): void {
    if (this.snapshot.state === state) return;
    this.set({ state });
  }

  // ── Public API ─────────────────────────────────────────────────────────

  send(event: PlayerEvent): void {
    switch (event.type) {
      case "snapshot":
        return this.onSnapshot(event.snapshot);
      case "preload":
        return this.onPreload(event.item, event.leadMs);
      case "takeover":
        return this.onTakeover(event.override);
      case "buffer-ready":
        return this.onBufferReady(event.bufferId);
      case "buffer-error":
        return this.onBufferError(event.bufferId, event.error);
      case "buffer-stalled":
        return this.onBufferStalled(event.bufferId);
      case "buffer-ended":
        return this.onBufferEnded(event.bufferId);
      case "online":
        return this.onOnline();
      case "offline":
        return this.onOffline();
      case "force-skip":
        return this.onForceSkip();
    }
  }

  // ── Event handlers ─────────────────────────────────────────────────────

  private onSnapshot(server: V2Snapshot): void {
    // Capture the previous server snapshot BEFORE updating so the same-item
    // drift-correction branch below can compare old vs new startsAtMs.
    const prevServerSnapshot = this.snapshot.lastServerSnapshot;

    // Always record the latest server state unconditionally. UI layers
    // (admin preview, TV overlay, mobile player) read lastServerSnapshot for
    // title, failover reason, and "off air" status. lastSequence drives the
    // transport's `resume {lastSequence}` replay on reconnect.
    // Previously this was never set, so every surface always saw null.
    this.set({ lastServerSnapshot: server, lastSequence: server.sequence });

    if (server.mode === "override" && server.override) {
      return this.engageOverride(server.override);
    }

    if (server.mode === "offline_hold") {
      this.transition("OFFLINE_HOLD");
      this.emit({ type: "show-overlay", kind: "offline", reason: null });
      return;
    }

    if (!server.current) {
      // No content currently scheduled — stop playback and show idle UI.
      // Only pause/unbind if we're actually playing something to avoid
      // needlessly interrupting a buffer that's still valid.
      if (this.snapshot.bufferA !== null || this.snapshot.bufferB !== null) {
        this.emit({ type: "pause", bufferId: "A" });
        this.emit({ type: "pause", bufferId: "B" });
        this.emit({ type: "unbind", bufferId: "A" });
        this.emit({ type: "unbind", bufferId: "B" });
        this.set({ bufferA: null, bufferB: null });
      }
      this.transition("SYNCING");
      return;
    }

    const activeId = this.snapshot.activeBufferId;
    const activeItem = activeId === "A" ? this.snapshot.bufferA : this.snapshot.bufferB;
    const activeItemId = activeItem && "id" in activeItem ? (activeItem as V2Item).id : null;

    if (activeItemId !== server.current.id) {
      // ── Stale-snapshot guard ─────────────────────────────────────────
      // If the server's claimed current item has already passed its
      // wall-clock end time (endsAtMs ≤ now), this snapshot arrived in
      // the narrow window between:
      //   (a) the client's buffer-ended / HANDOFF completing, and
      //   (b) the server's next 1-second tick advancing the cycle anchor.
      //
      // Rebinding the active buffer to an item whose slot has expired
      // would cause two failure modes:
      //   1. Post-HANDOFF: the just-promoted new item gets evicted and
      //      replaced with the ended item — visible as a video restart
      //      with a black flash every item transition.
      //   2. Post-SYNCING (no inactive buffer): the ended item is
      //      reloaded from position 0 instead of moving on, producing
      //      an unwanted loop of the last item before advancing.
      //
      // Safe exit: the server's next snapshot (< 1 s away, driven by
      // the 1-second tick or the 8-second keep-alive) will carry the
      // correct current item. The machine stays in its current state
      // (PLAYING / SYNCING) without touching the buffers.
      //
      // Exception: override mode is always authoritative regardless of
      // endsAtMs (overrides may not have a wall-clock end time, and they
      // are checked above before reaching this branch).
      if (server.current.endsAtMs <= Date.now()) {
        return;
      }

      // ── Post-natural-end guard ────────────────────────────────────────
      // When a video finishes before its server-scheduled slot expires,
      // the client fires `naturalItemEnd` and the machine performs a
      // HANDOFF to the next buffer.  The server may take up to one tick
      // (≤ 1 s) to advance its anchor, during which its snapshot still
      // reports the just-finished item as `current` — with `endsAtMs`
      // in the future, so the stale-snapshot guard above does NOT catch it.
      //
      // Without this guard `bindActive(server.current)` would re-bind the
      // ended item onto the now-active buffer, rolling back the HANDOFF
      // and forcing the viewer to watch the remainder of the server's
      // slot before the item actually advances.  This produces the
      // "broadcast stops / same video loops" symptom for any video whose
      // recorded duration is shorter than its queue `durationSecs`.
      //
      // Safe exit: `lastEndedItemId` is cleared as soon as the server
      // confirms a different `current` item, so we never permanently
      // block a legitimately re-queued item.
      if (
        this.lastEndedItemId !== null &&
        server.current.id === this.lastEndedItemId &&
        server.current.endsAtMs > Date.now()
      ) {
        // TTL safety valve: if the naturalItemEnd POST failed to reach the
        // server (network error, timeout), the server keeps showing this
        // item as current with endsAtMs far in the future. After 30 s we
        // assume the signal was lost — clear the guard and allow rebinding
        // so the player doesn't stay dark for the full slot duration.
        if (this.lastEndedAtMs !== null && Date.now() - this.lastEndedAtMs > 30_000) {
          this.lastEndedItemId = null;
          this.lastEndedAtMs = null;
          // Fall through to bindActive below.
        } else {
          return;
        }
      }

      // Server confirmed a different current item — clear the ended-item
      // guard so this item can be bound normally in the future.
      if (this.lastEndedItemId !== null && server.current.id !== this.lastEndedItemId) {
        this.lastEndedItemId = null;
        this.lastEndedAtMs = null;
      }

      // Different item — bind, start loading, and wait for buffer-ready
      // before declaring PLAYING. Transitioning directly to PLAYING before
      // the media is loaded means the stall watchdog can't fire during
      // the initial load phase, and the overlay disappears while a black
      // screen is showing. PREPARING_ACTIVE keeps the FSM honest: the
      // player surface knows the item is loading, not playing yet.
      this.primaryRetries = 0;
      this.bindActive(server.current);
      const positionSecs = resolvePositionSecs(server.current, server.current.startsAtMs);
      this.emit({ type: "play", bufferId: activeId, positionSecs });
      this.transition("PREPARING_ACTIVE");
    } else {
      // Same item still playing.
      if (
        this.snapshot.state === "BOOTSTRAP" ||
        this.snapshot.state === "SYNCING" ||
        this.snapshot.state === "PREPARING_ACTIVE"
      ) {
        // No active recovery — server confirming same item means we can
        // start/resume immediately. Re-seek to wall-clock position to
        // correct any drift accumulated since the last item.advanced event.
        const positionSecs = resolvePositionSecs(server.current, server.current.startsAtMs);
        this.emit({ type: "play", bufferId: activeId, positionSecs });
        this.transition("PLAYING");
      } else if (
        this.snapshot.state === "RECOVERING_PRIMARY" ||
        this.snapshot.state === "RECOVERING_FAILOVER"
      ) {
        // Active source recovery in progress. The server confirming the same
        // item does NOT mean the source loaded — the adapter is still waiting
        // for buffer-ready or buffer-error from the re-bound element.
        //
        // Re-issue play() to keep the element active (e.g. after a transport
        // reconnect where the adapter restarted), but do NOT transition to
        // PLAYING. Doing so would:
        //   (a) hide the "Retrying source…" overlay before the source is
        //       confirmed playable — false positive for the viewer.
        //   (b) arm the stall watchdog on an element that is still loading
        //       (in PLAYING state), causing buffer-stalled → onBufferError →
        //       primaryRetries increments, burning through the retry budget
        //       on a source that would have recovered cleanly.
        //   (c) prevent onBufferReady from resetting primaryRetries — it
        //       only resets in RECOVERING_* states, so if the machine is in
        //       PLAYING when canplay fires, primaryRetries stays elevated and
        //       the next genuine transient error escalates too aggressively.
        //
        // Correct path: buffer-ready → transition("PLAYING") + reset retries,
        //               buffer-error → escalate recovery or SKIP_PENDING.
        const positionSecs = resolvePositionSecs(server.current, server.current.startsAtMs);
        this.emit({ type: "play", bufferId: activeId, positionSecs });
        // State stays in RECOVERING_* — driven by buffer-ready/buffer-error.
      } else if (this.snapshot.state === "SKIP_PENDING") {
        // Single-item queue: server skipped back to the same item with a
        // fresh cycle anchor (new startsAtMs). Fully rebind and restart —
        // the element is in an error/ended state and play() alone won't
        // restart it.  Reset primaryRetries so the fresh attempt gets a
        // full error budget.
        //
        // Guard: only rebind when the server has issued a NEW startsAtMs
        // (the orchestrator genuinely restarted the slot). If the anchor
        // is unchanged the source is the same broken URL — retrying here
        // would loop forever (bind → timeout → SKIP_PENDING → rebind on
        // next snapshot tick, every ~5 s) for large non-faststart MP4s
        // or any permanently unloadable source. Stay in SKIP_PENDING so
        // the overlay remains visible and the operator knows action is
        // needed, rather than silently hammering the media pipeline.
        if (
          this.skipPendingAnchorMs !== null &&
          server.current.startsAtMs === this.skipPendingAnchorMs
        ) {
          // Same slot anchor — do not rebind. Overlay stays visible.
          return;
        }
        // Fresh anchor (or no anchor recorded) — safe to retry.
        this.skipPendingAnchorMs = null;
        this.primaryRetries = 0;
        this.bindActive(server.current);
        const positionSecs = resolvePositionSecs(server.current, server.current.startsAtMs);
        this.emit({ type: "play", bufferId: activeId, positionSecs });
        this.transition("PREPARING_ACTIVE");
      } else if (this.snapshot.state === "PLAYING") {
        // Drift correction for long-running 24/7 clients. The server
        // periodically recalibrates the cycle anchor (checkpoint restoration
        // after restart). If startsAtMs for this same item shifts by more
        // than 5 s between successive snapshots the cycle was genuinely
        // recalibrated — re-seek to the authoritative wall-clock position.
        //
        // The 5 s threshold (raised from 2 s) avoids false-positive seeks
        // caused by the small time difference between a WS-pushed snapshot and
        // a REST snapshot requested by the transport a few seconds later.
        //
        // Loop-transition guard: when a single-item queue wraps, the server
        // fires item.advanced and a new snapshot whose startsAtMs is ~D ms
        // in the future (new loop just started). positionSecs would be ≈ 0,
        // seeking the video back to the beginning while it is still naturally
        // finishing the previous pass. We suppress the seek if the new
        // startsAtMs is strictly in the future (haven't entered the new loop
        // yet) or within the first 4 s of the new loop — the preloaded
        // inactive buffer and the `ended` event will handle the handoff.
        if (prevServerSnapshot?.current?.id === server.current.id) {
          const driftMs = Math.abs(server.current.startsAtMs - prevServerSnapshot.current.startsAtMs);
          if (driftMs > 5000) {
            const nowMs = Date.now();
            // resolvePositionSecs returns 0 for non-HLS sources so we never
            // seek a playing MP4 back to position 0 during a drift correction.
            // The guard below (positionSecs > 0) skips the emit entirely for
            // non-HLS, preserving continuous playback without interruption.
            const positionSecs = resolvePositionSecs(server.current, server.current.startsAtMs);
            if (positionSecs > 0) {
              // Suppress if we are in the loop-transition window: the new
              // startsAtMs is ≤ 4 s old.  The natural `ended` + A/B swap path
              // will produce a seamless loop without any seek.
              const inLoopTransitionWindow = (nowMs - server.current.startsAtMs) < 4_000;
              if (!inLoopTransitionWindow) {
                this.emit({ type: "play", bufferId: activeId, positionSecs });
              }
            }
          }
        }
      }
    }

    // Always keep the inactive buffer aligned with server.next.
    // Fall back to server.nextNext when next is null (e.g. URL blocked by
    // the bad-source cache) so the buffer is never left completely unloaded.
    const nextToPreload = server.next ?? server.nextNext;
    if (nextToPreload) {
      this.bindInactive(nextToPreload);
    }

    if (server.failover.active) {
      this.emit({ type: "show-overlay", kind: "failover", reason: server.failover.reason });
    } else {
      this.emit({ type: "hide-overlay" });
    }
  }

  private onPreload(item: V2Item, _leadMs: number): void {
    this.bindInactive(item);
    // Only transition to PREPARING_NEXT if we're currently PLAYING —
    // don't downgrade a higher-priority state.
    if (this.snapshot.state === "PLAYING") {
      this.transition("PREPARING_NEXT");
    }
  }

  private onTakeover(override: V2Override): void {
    this.engageOverride(override);
  }

  private onBufferReady(bufferId: "A" | "B"): void {
    if (bufferId === this.snapshot.activeBufferId) {
      if (
        this.snapshot.state === "PREPARING_ACTIVE" ||
        this.snapshot.state === "RECOVERING_PRIMARY" ||
        this.snapshot.state === "RECOVERING_FAILOVER"
      ) {
        // Buffer loaded successfully — reset retry counter so the next
        // error on this item gets a fresh budget. Without this, an error
        // during RECOVERING_PRIMARY that resolves immediately would leave
        // primaryRetries=1, causing the next error to jump straight to
        // RECOVERING_FAILOVER instead of trying primary again.
        this.primaryRetries = 0;
        this.transition("PLAYING");
      }
    }
  }

  private onBufferError(bufferId: "A" | "B", _error: string): void {
    if (bufferId !== this.snapshot.activeBufferId) {
      // The INACTIVE buffer failed to preload. Clear the FSM's item reference
      // so that when the active buffer fires `ended`, onBufferEnded() sees
      // inactiveItem = null and transitions to SYNCING instead of attempting a
      // handoff to a broken element.
      if (bufferId === "A") this.set({ bufferA: null });
      else this.set({ bufferB: null });
      // Request a fresh snapshot immediately so onSnapshot() re-triggers
      // bindInactive() within < 1 s. Without this, the machine waits up to
      // 8 s for the orchestrator's next keep-alive before retrying the preload,
      // leaving the inactive buffer empty and risking a black-screen gap on
      // the next item transition.
      this.onNeedSnapshotCb?.();
      return;
    }
    this.primaryRetries += 1;
    if (this.primaryRetries === 1) {
      // Silent reload of the same source.
      this.transition("RECOVERING_PRIMARY");
      const item = bufferId === "A" ? this.snapshot.bufferA : this.snapshot.bufferB;
      if (item) {
        this.emit({ type: "bind", bufferId, item });
        const server = this.snapshot.lastServerSnapshot;
        const startsAtMs =
          server?.current && "startsAtMs" in server.current
            ? (server.current as V2Item).startsAtMs
            : Date.now();
        const positionSecs = resolvePositionSecs(item as V2Item, startsAtMs);
        this.emit({ type: "play", bufferId, positionSecs });
      }
    } else if (this.primaryRetries === 2) {
      // Try failover source if one is available; otherwise do one more
      // silent reload of the primary. A single stall can be a transient
      // network hiccup — giving the primary a second chance avoids
      // unnecessarily cycling the broadcast queue.
      const item = bufferId === "A" ? this.snapshot.bufferA : this.snapshot.bufferB;
      if (item && "failoverSource" in item && item.failoverSource) {
        this.transition("RECOVERING_FAILOVER");
        const fb: V2Item = { ...(item as V2Item), source: { ...item.failoverSource, expiresAtMs: null } };
        this.emit({ type: "bind", bufferId, item: fb });
        this.emit({ type: "play", bufferId, positionSecs: 0 });
      } else {
        // No failover — try primary once more before giving up.
        this.transition("RECOVERING_PRIMARY");
        if (item) {
          this.emit({ type: "bind", bufferId, item });
          const server = this.snapshot.lastServerSnapshot;
          const startsAtMs =
            server?.current && "startsAtMs" in server.current
              ? (server.current as V2Item).startsAtMs
              : Date.now();
          const positionSecs = resolvePositionSecs(item as V2Item, startsAtMs);
          this.emit({ type: "play", bufferId, positionSecs });
        }
      }
    } else {
      // Give up — request server-side skip.
      // Fires on the 3rd error: after two primary retries (or one primary
      // retry + one failover attempt), the source is considered unplayable.
      //
      // Record the current item's startsAtMs as the skip-pending anchor so
      // that handleServerSnapshot knows NOT to rebind the same broken source
      // on the next snapshot tick (which would loop indefinitely).
      const srv = this.snapshot.lastServerSnapshot;
      this.skipPendingAnchorMs =
        srv?.current && "startsAtMs" in srv.current
          ? (srv.current as V2Item).startsAtMs
          : null;
      this.transition("SKIP_PENDING");
      this.primaryRetries = 0;
      // Proactively fetch a fresh snapshot so the stall-reporter effect in
      // react.ts (and its RN equivalent) can immediately match the FSM's
      // SKIP_PENDING item against the server's current item and fire the
      // /report-stall POST.  Without this the effect waits for the next
      // transport frame (up to 8 s keep-alive) before it sees the SKIP_PENDING
      // item confirmed as server-current — creating an 8 s black-screen delay
      // before the server is even notified that the source is unplayable.
      this.onNeedSnapshotCb?.();
    }
  }

  private onBufferStalled(bufferId: "A" | "B"): void {
    // Only treat stalls on the active buffer as errors; inactive buffer
    // stalls (preloading) are expected and should not trigger recovery.
    if (bufferId !== this.snapshot.activeBufferId) return;
    // Escalate to error recovery when the player is in any "should be
    // playing or almost playing" state. PREPARING_ACTIVE is included so
    // the watchdog can fire during initial load — a source that hangs
    // for 8+ seconds while buffering is just as broken as one that stalls
    // mid-play. We exclude BOOTSTRAP/SYNCING/OFFLINE_HOLD where silence
    // is structurally expected.
    const state = this.snapshot.state;
    if (
      state === "PLAYING" ||
      state === "PREPARING_ACTIVE" ||
      state === "PREPARING_NEXT" ||
      state === "HANDOFF"
    ) {
      this.onBufferError(bufferId, "stalled");
    }
  }

  private onBufferEnded(bufferId: "A" | "B"): void {
    if (bufferId !== this.snapshot.activeBufferId) return;
    // Hand off to the inactive buffer if it's bound.
    const inactiveId = this.swappedId(bufferId);
    const inactiveItem = inactiveId === "A" ? this.snapshot.bufferA : this.snapshot.bufferB;

    // Capture the item that just ended so we can:
    //   (a) set lastEndedItemId for the post-HANDOFF guard, and
    //   (b) notify the server via the naturalEnd callback so it
    //       advances the cycle anchor immediately (in case durationSecs
    //       on the queue row exceeds the actual video file length).
    const endedItem = bufferId === "A" ? this.snapshot.bufferA : this.snapshot.bufferB;
    const endedItemId = endedItem && "id" in endedItem ? (endedItem as V2Item).id : null;

    // Clear the ended buffer's FSM state so the next bindInactive() call
    // does NOT skip re-binding when the same item loops (single-item queue).
    // Without this, bindInactive() sees the same item ID in the "old active"
    // buffer and returns early, leaving the adapter holding an ended video
    // element that can't be restarted without a full load() reset.
    if (bufferId === "A") this.set({ bufferA: null });
    else this.set({ bufferB: null });

    if (!inactiveItem) {
      // Set lastEndedItemId BEFORE requesting a snapshot so that if the
      // immediate GET /state response arrives before the server processes the
      // POST /natural-end below, onSnapshot() will not rebind the just-ended
      // item from position 0.  Without this guard the player briefly restarts
      // the ended video every time no inactive buffer was preloaded.
      if (endedItemId) {
        this.lastEndedItemId = endedItemId;
        this.lastEndedAtMs = Date.now();
      }
      // Immediately fetch fresh state rather than waiting for the server's
      // next keep-alive (8 s after the orchestrator change).  This cuts the
      // SYNCING gap to < 1 s for single-item loops and cases where the
      // inactive buffer failed to preload in time.
      this.onNeedSnapshotCb?.();
      this.transition("SYNCING");
      // Still signal the server even without a preloaded inactive buffer —
      // the snapshot that arrives will reflect the advanced anchor.
      if (endedItemId) this.onNaturalEndCb?.(endedItemId);
      return;
    }

    // Record that this item ended naturally before engaging the HANDOFF so
    // onSnapshot() guards against re-binding it from a stale server snapshot.
    if (endedItemId) {
      this.lastEndedItemId = endedItemId;
      this.lastEndedAtMs = Date.now();
    }

    this.transition("HANDOFF");
    this.emit({ type: "swap", activeBufferId: inactiveId });
    // Play the inactive buffer from the start of the next item (position 0).
    this.emit({ type: "play", bufferId: inactiveId, positionSecs: 0 });
    this.set({ activeBufferId: inactiveId });
    this.transition("PLAYING");
    this.primaryRetries = 0;

    // Signal the server that this item ended naturally so it can advance
    // the cycle anchor immediately, keeping all clients in sync.
    if (endedItemId) this.onNaturalEndCb?.(endedItemId);

    // ── Eager post-handoff preload ────────────────────────────────────────
    // The just-freed buffer (old `bufferId`, now the inactive slot) was
    // cleared to null above.  Start loading the next item into it immediately
    // instead of waiting for the server's preload frame (which fires up to
    // durationSecs − PRELOAD_LEAD_MS seconds from now) or the next
    // keep-alive snapshot (≤ 30 s).  The wider window dramatically reduces
    // the chance of a SYNCING gap on the next transition.
    //
    // Guard for multi-item queues: if the snapshot is from BEFORE the
    // server's item.advanced event, lastServerSnapshot.next still points at
    // the item we just activated (inactiveItem).  Binding that URL into the
    // freed buffer would duplicate the active source.  We detect this by
    // checking next.id === activatedId and deferring — the correct next item
    // arrives in the imminent item.advanced snapshot.
    //
    // For single-item queues (next.id === current.id === activatedId) the
    // same item must loop, so we always preload it regardless.
    const snap = this.snapshot.lastServerSnapshot;
    const nextToEagerBind = snap?.next ?? snap?.nextNext;
    if (nextToEagerBind && "durationSecs" in inactiveItem) {
      const activatedId = (inactiveItem as V2Item).id;
      const isSingleItemLoop =
        snap?.current != null &&
        "id" in snap.current &&
        (snap.current as { id: string }).id === nextToEagerBind.id;
      if (isSingleItemLoop || nextToEagerBind.id !== activatedId) {
        this.bindInactive(nextToEagerBind);
      }
    }
  }

  private onOnline(): void {
    if (this.snapshot.state === "OFFLINE_HOLD") {
      this.transition("SYNCING");
      this.emit({ type: "hide-overlay" });
    }
  }

  private onOffline(): void {
    // If the player already has content loaded (PLAYING, PREPARING_*, RECOVERING_*,
    // HANDOFF, SKIP_PENDING, LIVE_OVERRIDE_ACTIVE), do NOT blank the screen.
    // Video buffers hold pre-downloaded data that keeps playing through brief
    // network drops (a few seconds for MP4, much longer for HLS with a deep
    // buffer).  If the buffer truly empties, the stall watchdog fires and the
    // normal RECOVERING → SKIP_PENDING path handles it.
    //
    // Only enter OFFLINE_HOLD from states that have no content to show
    // (BOOTSTRAP, SYNCING) where a blank screen is already the reality.
    const state = this.snapshot.state;
    if (
      state === "BOOTSTRAP" ||
      state === "SYNCING" ||
      state === "OFFLINE_HOLD"
    ) {
      this.transition("OFFLINE_HOLD");
      this.emit({ type: "show-overlay", kind: "offline", reason: null });
    }
    // For all other states: let playback continue uninterrupted.  The overlay
    // appears via the stall/error escalation path if the buffer runs dry.
  }

  private onForceSkip(): void {
    // Operator-triggered skip — clear the anchor so the next server snapshot
    // is allowed to rebind (the operator explicitly wants to try again or move on).
    this.skipPendingAnchorMs = null;
    this.transition("SKIP_PENDING");
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private engageOverride(override: V2Override): void {
    const inactiveId = this.swappedId(this.snapshot.activeBufferId);
    this.emit({ type: "bind", bufferId: inactiveId, item: override });
    this.emit({ type: "play", bufferId: inactiveId, positionSecs: 0 });
    this.emit({ type: "swap", activeBufferId: inactiveId });
    if (inactiveId === "A") this.set({ bufferA: override, activeBufferId: "A" });
    else this.set({ bufferB: override, activeBufferId: "B" });
    this.transition("LIVE_OVERRIDE_ACTIVE");
  }

  private bindActive(item: V2Item | V2Override): void {
    const id = this.snapshot.activeBufferId;
    this.emit({ type: "bind", bufferId: id, item });
    if (id === "A") this.set({ bufferA: item });
    else this.set({ bufferB: item });
  }

  private bindInactive(item: V2Item | V2Override): void {
    const id = this.swappedId(this.snapshot.activeBufferId);
    const current = id === "A" ? this.snapshot.bufferA : this.snapshot.bufferB;
    if (current && "id" in current && (current as V2Item).id === (item as V2Item).id) return;
    this.emit({ type: "bind", bufferId: id, item });
    if (id === "A") this.set({ bufferA: item });
    else this.set({ bufferB: item });
  }

  private swappedId(id: "A" | "B"): "A" | "B" {
    return id === "A" ? "B" : "A";
  }
}

export const PRELOAD_LEAD_MS_DEFAULT = PRELOAD_LEAD_MS;
export const STALL_THRESHOLD_MS_DEFAULT = STALL_THRESHOLD_MS;
