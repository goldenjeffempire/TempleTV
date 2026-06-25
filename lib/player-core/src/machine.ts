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
 * @param clockOffsetMs  Server-client clock offset: serverTimeMs − Date.now(),
 *   measured at the last hello/heartbeat/snapshot frame. Positive = server clock
 *   ahead of local clock. Applied to Date.now() so the position calculation uses
 *   server time rather than the (potentially skewed) local OS clock. On mobile
 *   devices whose OS clock has never synced NTP, the offset can exceed 30 seconds
 *   — the primary cause of admin-mobile VOD HLS desync.
 */
function resolvePositionSecs(
  item: V2Item | V2Override | null | undefined,
  startsAtMs: number,
  clockOffsetMs = 0,
): number {
  if (!item) return 0;
  const kind = "source" in item
    ? (item as V2Item).source.kind
    : (item as V2Override).kind;
  // Seekable VOD kinds: hls, mp4, dash.
  // NOT seekable: youtube (iframe, no native seek), rtmp (live stream, no VOD position).
  // Without this, every device watching MP4 content starts from position 0
  // regardless of when they joined — the primary cause of broadcast desync.
  if (kind === "hls" || kind === "mp4" || kind === "dash") {
    // Apply server-calibrated clock: Date.now() + clockOffsetMs ≈ serverTime.
    // startsAtMs is always in server time (set by the orchestrator), so the
    // elapsed calculation must also be in server time or the position drifts
    // by exactly the device clock skew.
    const nowMs = Date.now() + clockOffsetMs;
    const elapsed = Math.max(0, (nowMs - startsAtMs) / 1000);
    // Cap at (durationSecs - 10) for V2Items with a known duration.
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
    // Why 10 s (was 2 s): the mobile player's HLS_END_GUARD_MS is 8 000 ms.
    // The server-side cap must be ≥ client-side guard so that, when
    // durationSecs ≈ actualDurationMs, the machine already lands the seek
    // target well before the end. The client still applies its own clamp
    // (Math.max(0, actualDurationMs - HLS_END_GUARD_MS)) as a second layer,
    // but aligning the server cap to 10 s gives defense-in-depth and prevents
    // spurious quick-finish events even when actualDurationMs is unavailable
    // (e.g. while the expo-av onLoad has not yet fired for the new item).
    if ("durationSecs" in item && (item as V2Item).durationSecs > 0) {
      return Math.min(elapsed, Math.max(0, (item as V2Item).durationSecs - 10));
    }
    return elapsed;
  }
  // youtube and rtmp: no VOD seek position — callers treat 0 as "don't seek".
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
 * Set to 120 s to match the server default BROADCAST_PRELOAD_LEAD_MS so the
 * machine's post-HANDOFF eager-bind threshold is consistent with the server's
 * preload frame emission timing.
 */
const PRELOAD_LEAD_MS = 120_000;

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

/**
 * How many successive same-anchor snapshots while in SKIP_PENDING before
 * transitioning to FATAL.  Each snapshot represents one escape-valve
 * forceReconnect cycle (~8 s), so 3 cycles ≈ 24 s of unresolvable stall.
 */
const SKIP_PENDING_FATAL_THRESHOLD = 3;

/**
 * How long (ms) the machine stays in FATAL before automatically retrying
 * from SYNCING.  Self-heals without user interaction once a stream clears.
 *
 * Successive FATAL entries use exponential backoff (capped at
 * FATAL_BACKOFF_MAX_MS) so many clients sharing a permanently broken source
 * do not all hammer the API in lockstep (thundering herd). The attempt
 * counter resets whenever the machine reaches PLAYING.
 *
 * Reduced from 30 s → 10 s so the admin preview and viewer surfaces
 * recover within one tick cycle rather than waiting half a minute after
 * an HLS 404 or a transient MP4 load failure.  The 2× exponential backoff
 * still applies on repeated entries (10 → 20 → 40 → 80 → 160 → 240 s cap).
 */
const FATAL_AUTO_RECOVERY_MS = 10_000;

/**
 * Upper ceiling for the FATAL auto-recovery backoff.
 * Schedule: 30 s → 60 s → 120 s → 240 s (cap) → 240 s → …
 */
const FATAL_BACKOFF_MAX_MS = 240_000;

export class PlayerMachine {
  private snapshot: PlayerSnapshot = {
    state: "BOOTSTRAP",
    activeBufferId: "A",
    bufferA: null,
    bufferB: null,
    lastServerSnapshot: null,
    lastSequence: 0,
    fatalAttemptCount: 0,
    fatalEnteredAtMs: null,
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
   * Server-client clock offset in milliseconds (serverTime − localTime).
   * Updated by setClockOffsetMs() whenever the transport measures a new
   * offset from a hello / heartbeat / snapshot frame. Applied in every
   * resolvePositionSecs() call so position calculations use server time
   * instead of the potentially-skewed local OS clock.
   */
  private clockOffsetMs = 0;

  /**
   * Timer that fires shortly before the active buffer's source URL expires
   * (if `source.expiresAtMs` is set on the item). Fires the onNeedSnapshot
   * callback so the transport fetches a fresh snapshot with a renewed URL
   * before the current one stops serving — preventing a silent buffer-error
   * mid-broadcast when a pre-signed CDN URL times out.
   */
  private sourceExpiryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Item ID that was active when `sourceExpiryTimer` was last scheduled.
   * Guards against a superseded timer firing a snapshot request after the
   * active item has already changed — the timer was scheduled for a URL that
   * is no longer in use, so the request would be a no-op at best or cause a
   * stale-snapshot FSM rollback at worst.
   */
  private sourceExpiryItemId: string | null = null;

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
   * After 30 s the guard is extended and the naturalEnd signal is retried
   * (see naturalEndRetries). After 3 retries (90 s total) the guard clears.
   */
  private lastEndedAtMs: number | null = null;
  /**
   * Number of times the 30-second natural-end guard TTL has been extended to
   * retry the POST /natural-end signal. Capped at 3: after 90 s total the
   * guard is cleared and the server's snapshot is authoritative.
   *
   * Previous behaviour: on TTL expiry the guard was cleared immediately and
   * bindActive() was called — re-binding the just-ended item and looping it
   * for the remainder of the server-scheduled slot (potentially minutes).
   * Now: extend the guard window, retry the POST, and only rebind as a
   * last resort after 3 failures (~90 s), by which time the server's own
   * slot TTL will almost certainly have advanced the anchor anyway.
   */
  private naturalEndRetries = 0;

  /**
   * Wall-clock timestamp (Date.now()) when the machine last entered the
   * PLAYING state, regardless of which path brought it there (initial
   * buffer-ready, HANDOFF completion, FATAL recovery, server restart).
   *
   * Used as a belt-and-suspenders guard in onBufferEnded(): if `ended` fires
   * within MIN_PLAYBACK_BEFORE_HANDOFF_MS of entering PLAYING, the event is
   * most likely a false positive (e.g. a preloaded buffer that was seeked
   * past its actual end, or a race between canplay and ended on a very short
   * segment). In that case HANDOFF is suppressed and the stall watchdog
   * handles recovery through the normal error path.
   */
  private playingEnteredMs: number | null = null;

  /**
   * The `startsAtMs` value from the server snapshot at the moment the last
   * natural-end event fired. Used to detect single-item queue loops where
   * the orchestrator advances the cycle anchor for the same item ID.
   *
   * Problem this solves: on a single-item queue, `lastEndedItemId` never
   * clears (because `server.current.id` never changes) — the post-HANDOFF
   * guard blocks rebinding for 30 s (then retries for up to 90 s), producing
   * a black-screen gap between every loop of the same video.
   *
   * Fix: when the server snapshot for the same item carries a NEW `startsAtMs`
   * (the orchestrator created a fresh slot), the guard is cleared immediately
   * so the loop restarts within < 1 s instead of waiting 30+ s.
   */
  private lastEndedItemStartsAtMs: number | null = null;

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
  /**
   * Counts successive same-anchor SKIP_PENDING snapshots.  Reaches
   * SKIP_PENDING_FATAL_THRESHOLD then transitions to FATAL.
   */
  private skipPendingCycles = 0;
  /** Handle for the FATAL → SYNCING auto-recovery timer. */
  private fatalRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Number of consecutive FATAL entries since the last successful PLAYING
   * state.  Drives exponential backoff so many clients sharing a broken
   * source do not all reconnect in lockstep every 30 s.
   */
  private fatalAttemptCount = 0;

  /**
   * Which buffer ID has fired `buffer-ready` (canplay / loadedmetadata) as
   * the inactive preload target.  The machine only tracks the INACTIVE
   * buffer's readiness here — the active buffer's readiness drives
   * PREPARING_ACTIVE → PLAYING transitions via the active branch of
   * `onBufferReady`.
   *
   * Reset to null whenever `bindInactive()` loads a new item so stale
   * readiness signals from a previous cycle don't carry over.  Also reset
   * in `doHandoff()` after the swap so the freshly-demoted inactive buffer
   * starts clean for the next preload cycle.
   */
  private inactiveReadyBufferId: "A" | "B" | null = null;

  /**
   * Deferred HANDOFF state: when the active buffer fires `ended` but the
   * inactive buffer's `canplay` has not yet fired, the HANDOFF is held
   * here until the inactive buffer becomes ready (or MAX_HANDOFF_WAIT_MS
   * elapses as a safety valve).
   */
  private pendingHandoff: {
    endedBufferId: "A" | "B";
    inactiveId: "A" | "B";
    inactiveItem: V2Item | V2Override;
    endedItemId: string | null;
  } | null = null;

  /** Safety-valve timer that forces the deferred HANDOFF even if the inactive
   *  buffer's canplay event never fires (e.g. browser throttling, very slow
   *  connection). */
  private pendingHandoffTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly emit: IntentHandler) {}

  setNeedSnapshotCallback(fn: () => void): void {
    this.onNeedSnapshotCb = fn;
  }

  setNaturalEndCallback(fn: (itemId: string) => void): void {
    this.onNaturalEndCb = fn;
  }

  /**
   * Update the server-client clock offset so resolvePositionSecs uses
   * server time instead of the local OS clock. Call this whenever the
   * transport measures a new offset from a hello / heartbeat / snapshot frame.
   *
   * The offset is `serverTimeMs − Date.now()`. Positive = server ahead.
   */
  setClockOffsetMs(offsetMs: number): void {
    this.clockOffsetMs = offsetMs;
  }

  /**
   * Initiated by a user "Tap to reconnect" action — resets the recovery
   * budget and starts a fresh PREPARING_ACTIVE cycle for the current item
   * WITHOUT consuming the `primaryRetries` budget.
   *
   * This is the correct handler for manual user-initiated retries because:
   *  - Unlike injecting a synthetic buffer-error (which increments
   *    `primaryRetries` toward SKIP_PENDING), this gives a clean start.
   *  - Unlike `forceReconnect()` on the transport (which only reconnects
   *    the WS), this re-issues the `bind` intent so the BroadcastBuffer
   *    adapter increments its `bindRevision` and reloads the video element
   *    — fixing the "Tap to reconnect has no visible effect" bug where
   *    the player stays frozen in RECOVERING_PRIMARY indefinitely.
   *
   * Safe to call in any state. Transitions to SYNCING (and requests a fresh
   * snapshot) when there is no current item to bind.
   */
  public requestManualRebind(): void {
    const server = this.snapshot.lastServerSnapshot;
    if (!server?.current || !("startsAtMs" in server.current)) {
      // No scheduled item available — return to SYNCING and request a
      // fresh snapshot so the transport re-evaluates server state immediately.
      this.transition("SYNCING");
      this.onNeedSnapshotCb?.();
      return;
    }
    const item = server.current as V2Item;
    const activeId = this.snapshot.activeBufferId;

    // Clear the FATAL backoff timer — transition() also clears it when
    // leaving FATAL, but clearing it here first prevents a brief window
    // where the timer could fire between this call and transition().
    if (this.fatalRecoveryTimer !== null) {
      clearTimeout(this.fatalRecoveryTimer);
      this.fatalRecoveryTimer = null;
    }

    // Reset all retry / skip counters so the next error cycle gets a full
    // budget instead of the accumulated state from prior automatic retries.
    this.primaryRetries = 0;
    this.skipPendingCycles = 0;
    this.skipPendingAnchorMs = null;

    // Re-bind the current item. This increments `bindRevision` in the
    // mobile adapter even if the source URL is unchanged — the BroadcastBuffer
    // useEffect([state.bindRevision]) fires, runs the same-URL fast-path
    // (if expo-av still has the URL loaded) or arms a fresh load-timeout
    // (if the native player needs to reload from scratch).
    this.bindActive(item);
    const positionSecs = resolvePositionSecs(item, item.startsAtMs, this.clockOffsetMs);
    this.emit({ type: "play", bufferId: activeId, positionSecs });
    this.transition("PREPARING_ACTIVE");
  }

  /**
   * Schedule a proactive snapshot request to fire 90 s before the active
   * source URL expires (if `source.expiresAtMs` is set). This ensures the
   * transport fetches a fresh snapshot — with a renewed pre-signed URL —
   * before the current one stops serving, avoiding a silent buffer-error
   * mid-broadcast. Any previously scheduled timer is cancelled first.
   *
   * Only schedules if the expiry is within the next 10 minutes. URLs with
   * longer lifetimes don't need proactive refresh — the normal server-push
   * or reconnect cycle will provide a new URL in time.
   */
  private scheduleSourceExpiryWatch(item: V2Item | V2Override): void {
    this.clearSourceExpiryTimer();
    if (!("source" in item)) return; // V2Override has no expiresAtMs
    const v2item = item as V2Item;
    const expiresAtMs = v2item.source.expiresAtMs;
    if (!expiresAtMs) return;
    // Use server-calibrated clock for the expiry calculation.
    const nowMs = Date.now() + this.clockOffsetMs;
    const msUntilExpiry = expiresAtMs - nowMs;
    // Fire 90 s before expiry so the transport can refresh the URL in time.
    const fireInMs = Math.max(0, msUntilExpiry - 90_000);
    // Only schedule for URLs expiring within 10 minutes — longer lifetimes
    // are covered by the normal snapshot-push and reconnect cycle.
    if (fireInMs > 10 * 60_000) return;
    // Tag the timer with the item ID so the callback can bail out if the
    // active item has already changed by the time the timer fires.
    const itemId = v2item.id;
    this.sourceExpiryItemId = itemId;
    this.sourceExpiryTimer = setTimeout(() => {
      this.sourceExpiryTimer = null;
      // Guard: only request a snapshot if this item is still the active one.
      // If the active item changed (HANDOFF, server skip, override), the URL
      // refresh is irrelevant and the request would be wasted or cause a
      // stale-snapshot FSM rollback.
      if (this.sourceExpiryItemId !== itemId) return;
      this.sourceExpiryItemId = null;
      this.onNeedSnapshotCb?.();
    }, fireInMs);
  }

  private clearSourceExpiryTimer(): void {
    if (this.sourceExpiryTimer !== null) {
      clearTimeout(this.sourceExpiryTimer);
      this.sourceExpiryTimer = null;
    }
    this.sourceExpiryItemId = null;
  }

  /**
   * Release all internal resources held by this machine instance.
   *
   * Must be called when the owning session/transport is torn down to prevent
   * the `sourceExpiryTimer` from keeping the machine alive past its intended
   * lifetime and firing a snapshot request into a dead transport. Listeners
   * are also cleared so GC can collect them.
   */
  destroy(): void {
    this.clearSourceExpiryTimer();
    this.clearPendingHandoff();
    if (this.fatalRecoveryTimer !== null) {
      clearTimeout(this.fatalRecoveryTimer);
      this.fatalRecoveryTimer = null;
    }
    this.listeners.clear();
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
    // Cancel FATAL auto-recovery whenever the machine leaves FATAL — whether
    // via operator retry, the auto-recovery timer itself, or a new snapshot.
    if (state !== "FATAL" && this.fatalRecoveryTimer !== null) {
      clearTimeout(this.fatalRecoveryTimer);
      this.fatalRecoveryTimer = null;
    }
    // Reset the FATAL backoff counter when the machine successfully reaches
    // PLAYING.  The source proved recoverable so the next FATAL entry (if any)
    // restarts the backoff from the base 30 s rather than 240 s.
    if (state === "PLAYING") {
      this.fatalAttemptCount = 0;
      // Stamp the wall-clock time at which PLAYING was entered.  Used by
      // onBufferEnded() to detect false-positive `ended` events that fire
      // before the video has had any meaningful playback time (e.g. a seek
      // that overshot the actual video duration, or a preloaded buffer that
      // was already at its end position when it became active after HANDOFF).
      this.playingEnteredMs = Date.now();
    }
    // Publish FATAL countdown fields so UI surfaces can show an accurate live
    // countdown rather than a static "30 seconds" message.
    // fatalAttemptCount is incremented by the caller BEFORE transition("FATAL")
    // so this.fatalAttemptCount is already the updated value here.
    if (state === "FATAL") {
      this.set({ state, fatalAttemptCount: this.fatalAttemptCount, fatalEnteredAtMs: Date.now() });
    } else if (state === "PLAYING") {
      this.set({ state, fatalAttemptCount: 0, fatalEnteredAtMs: null });
    } else {
      this.set({ state, fatalEnteredAtMs: null });
    }
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
      case "buffer-near-end":
        return this.onBufferNearEnd(event.bufferId);
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
    //
    // Only advance lastSequence when the incoming sequence is strictly higher.
    // Out-of-order SSE events (e.g. a replayed low-sequence frame arriving
    // after the transport has already processed a higher one) must not cause
    // the resume cursor to regress — that would replay already-seen events and
    // trigger duplicate bind/seek operations in the player FSM.
    const nextSeq = server.sequence > this.snapshot.lastSequence
      ? server.sequence
      : this.snapshot.lastSequence;
    this.set({ lastServerSnapshot: server, lastSequence: nextSeq });

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
      if (server.current.endsAtMs <= Date.now() + this.clockOffsetMs) {
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
        server.current.endsAtMs > Date.now() + this.clockOffsetMs
      ) {
        // ── Single-item queue loop fast-path ─────────────────────────────
        // When the orchestrator restarts the same item (single-item queue)
        // it advances `startsAtMs` to create a fresh slot. A changed anchor
        // for the same item ID means the server has already processed our
        // naturalEnd signal and moved on — clear the guard immediately so
        // the loop restarts within < 1 s instead of waiting 30+ s.
        if (
          this.lastEndedItemStartsAtMs !== null &&
          server.current.startsAtMs !== this.lastEndedItemStartsAtMs
        ) {
          this.lastEndedItemId = null;
          this.lastEndedAtMs = null;
          this.lastEndedItemStartsAtMs = null;
          this.naturalEndRetries = 0;
          // Fall through to bindActive below.
        } else if (this.lastEndedAtMs !== null && Date.now() - this.lastEndedAtMs > 5_000) {
          // TTL safety valve: if the naturalItemEnd POST failed to reach the
          // server (network error, timeout), the server keeps showing this
          // item as current with endsAtMs far in the future. After 5 s we
          // assume the signal was lost — extend the guard and retry the POST
          // so the server can advance. After 3 retries (~15 s total) the
          // guard is released as a last resort.
          //
          // Reduced from 30 s → 5 s: a 30 s retry window caused a visible
          // off-air gap on every item transition whenever the first POST
          // was dropped (brief WS reconnect, server restart). 5 s is still
          // long enough to avoid a race with the server's own processing.
          this.naturalEndRetries += 1;
          if (this.naturalEndRetries <= 3) {
            this.lastEndedAtMs = Date.now(); // extend guard by another 5 s
            this.onNaturalEndCb?.(server.current.id); // retry POST /natural-end
            return;
          }
          // 3 retries exhausted — give up and let the server state win.
          // But only re-bind if the server has confirmed a genuinely NEW
          // item. If server.current still shows the just-ended item the
          // naturalEnd POST hasn't been processed yet — stay dark and wait
          // for the next server frame rather than replaying the ended video.
          const exhaustedEndedId = this.lastEndedItemId;
          this.naturalEndRetries = 0;
          this.lastEndedItemId = null;
          this.lastEndedAtMs = null;
          this.lastEndedItemStartsAtMs = null;
          if (server.current.id === exhaustedEndedId) {
            this.onNeedSnapshotCb?.();
            return;
          }
          // Fall through to bindActive below (server has advanced).
        } else {
          // Still within the guard window — re-poll for fresh server state
          // so the machine sees the advanced anchor as soon as the server
          // processes the naturalItemEnd POST (usually within 1-2 s).
          // requestSnapshot() has an inflight guard so rapid calls are safe.
          if (this.lastEndedAtMs !== null && Date.now() - this.lastEndedAtMs > 3_000) {
            this.onNeedSnapshotCb?.();
          }
          return;
        }
      }

      // Server confirmed a different current item — clear the ended-item
      // guard so this item can be bound normally in the future.
      if (this.lastEndedItemId !== null && server.current.id !== this.lastEndedItemId) {
        this.lastEndedItemId = null;
        this.lastEndedAtMs = null;
        this.lastEndedItemStartsAtMs = null;
        this.naturalEndRetries = 0; // reset retry counter for the next natural-end event
      }

      // Different item — bind, start loading, and wait for buffer-ready
      // before declaring PLAYING. Transitioning directly to PLAYING before
      // the media is loaded means the stall watchdog can't fire during
      // the initial load phase, and the overlay disappears while a black
      // screen is showing. PREPARING_ACTIVE keeps the FSM honest: the
      // player surface knows the item is loading, not playing yet.
      this.primaryRetries = 0;
      this.bindActive(server.current);
      const positionSecs = resolvePositionSecs(server.current, server.current.startsAtMs, this.clockOffsetMs);
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
        // start/resume immediately. Re-seek to server-calibrated position to
        // correct any drift accumulated since the last item.advanced event.
        const positionSecs = resolvePositionSecs(server.current, server.current.startsAtMs, this.clockOffsetMs);
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
        const positionSecs = resolvePositionSecs(server.current, server.current.startsAtMs, this.clockOffsetMs);
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
          // Same slot anchor still airing — count escape-valve reconnect cycles.
          // Once SKIP_PENDING_FATAL_THRESHOLD is reached the source is considered
          // permanently unplayable on this client; enter FATAL so the UI shows a
          // clear "stream temporarily unavailable" message with a 30 s auto-retry
          // countdown instead of an infinite loading spinner.
          this.skipPendingCycles++;
          if (this.skipPendingCycles >= SKIP_PENDING_FATAL_THRESHOLD) {
            this.skipPendingCycles = 0;
            this.skipPendingAnchorMs = null;
            // Increment BEFORE transition("FATAL") so transition() sees the
            // updated count and publishes it in the snapshot immediately.
            // This lets UI surfaces (TV overlay, admin preview) display the
            // correct exponential-backoff countdown on the first render of the
            // FATAL state rather than showing the stale previous value.
            this.fatalAttemptCount++;
            this.transition("FATAL");
            // Clear any stale recovery timer from a previous FATAL entry.
            // transition() only clears fatalRecoveryTimer when *leaving* FATAL,
            // so a timer from the prior FATAL state would otherwise fire and
            // exit FATAL prematurely (mid-backoff) if it hadn't expired yet.
            if (this.fatalRecoveryTimer !== null) clearTimeout(this.fatalRecoveryTimer);
            const fatalBackoffMs = Math.min(
              FATAL_AUTO_RECOVERY_MS * Math.pow(2, this.fatalAttemptCount - 1),
              FATAL_BACKOFF_MAX_MS,
            );
            // Per-client jitter: spread reconnects across ±15% of the backoff
            // window so a fleet of clients sharing a broken source don't all
            // hammer the server in lockstep every 30 s. Cap at 5 s to keep
            // the spread proportional on the short initial retry.
            const fatalJitterMs = Math.random() * Math.min(fatalBackoffMs * 0.15, 5_000);
            this.fatalRecoveryTimer = setTimeout(() => {
              this.fatalRecoveryTimer = null;
              if (this.snapshot.state === "FATAL") {
                this.transition("SYNCING");
                this.onNeedSnapshotCb?.();
              }
            }, fatalBackoffMs + fatalJitterMs);
          }
          return;
        }
        // Fresh anchor (or no anchor recorded) — safe to retry.
        this.skipPendingAnchorMs = null;
        this.skipPendingCycles = 0;
        this.primaryRetries = 0;
        this.bindActive(server.current);
        const positionSecs = resolvePositionSecs(server.current, server.current.startsAtMs, this.clockOffsetMs);
        this.emit({ type: "play", bufferId: activeId, positionSecs });
        this.transition("PREPARING_ACTIVE");
      } else if (this.snapshot.state === "PLAYING") {
        // Periodic sync correction on every incoming snapshot (keepalive every
        // 15 s, plus belt-and-suspenders REST fetches after item.advanced).
        //
        // The previous approach only corrected when startsAtMs shifted > 5 s
        // between consecutive snapshots — this only caught server restarts and
        // never corrected ongoing playback drift between devices (e.g. HLS
        // segment boundary misalignment, late joiners starting from wrong
        // position, or gradual decode-timing divergence).
        //
        // Now: emit a `play` intent on every snapshot. The adapter's 4 s dead
        // band (web) suppresses the actual seek when the playhead is already
        // close to the expected position, so in-sync devices feel nothing.
        // Drifted devices (> 4 s off) are corrected automatically on the next
        // keepalive cycle without waiting for a server reload.
        //
        // resolvePositionSecs returns 0 for non-seekable sources (youtube, rtmp),
        // so the positionSecs > 0 guard below prevents seeking those to position 0.
        //
        // Loop-transition guard: when a single-item queue wraps, startsAtMs is
        // set to a moment ≤ 4 s ago. positionSecs ≈ 0, which would re-seek the
        // video back to the start while it is still naturally finishing the
        // previous pass. Suppress seeks for the first 4 s of a new loop anchor —
        // the preloaded inactive buffer and the `ended` event handle the handoff.
        const positionSecs = resolvePositionSecs(server.current, server.current.startsAtMs, this.clockOffsetMs);
        if (positionSecs > 0) {
          const nowMs = Date.now() + this.clockOffsetMs;
          const inLoopTransitionWindow = (nowMs - server.current.startsAtMs) < 4_000;
          if (!inLoopTransitionWindow) {
            this.emit({ type: "play", bufferId: activeId, positionSecs });
          }
        }
      } else if (this.snapshot.state === "FATAL") {
        // ── FATAL early-exit from server anchor refresh ───────────────────
        // A machine in FATAL is normally "deaf" to incoming snapshots for the
        // full backoff period (30 s – 240 s) because none of the other
        // branches above match.  This means that even when the operator fixes
        // the stream on the server side and the orchestrator restarts the item
        // slot with a fresh startsAtMs, every connected client stays frozen in
        // FATAL until its auto-recovery timer fires.
        //
        // Fix: if the server has issued a NEW startsAtMs for the same item
        // (the slot was restarted, typically because an admin re-queued or
        // corrected the source), immediately clear the backoff timer and
        // rebind as if we are recovering from scratch.  The client gets a
        // full primaryRetries budget on the fresh attempt.
        //
        // If startsAtMs is unchanged the slot is the same broken instance —
        // do nothing and let fatalRecoveryTimer fire on its natural schedule,
        // respecting the exponential backoff so we don't hammer a permanently
        // dead source.
        //
        // Note: a different item arriving from the server (activeItemId !==
        // server.current.id) is already handled by the "New item" branch
        // further up, which calls transition("PREPARING_ACTIVE") and thereby
        // clears fatalRecoveryTimer via the transition() guard at line ~400.
        if (
          prevServerSnapshot?.current?.id === server.current.id &&
          prevServerSnapshot.current.startsAtMs !== server.current.startsAtMs
        ) {
          // Clear the backoff timer — transition() would also do this, but
          // clearing it explicitly here makes the intent unambiguous.
          if (this.fatalRecoveryTimer !== null) {
            clearTimeout(this.fatalRecoveryTimer);
            this.fatalRecoveryTimer = null;
          }
          this.skipPendingCycles = 0;
          this.skipPendingAnchorMs = null;
          this.primaryRetries = 0;
          this.bindActive(server.current);
          const positionSecs = resolvePositionSecs(
            server.current,
            server.current.startsAtMs,
            this.clockOffsetMs,
          );
          this.emit({ type: "play", bufferId: activeId, positionSecs });
          this.transition("PREPARING_ACTIVE");
        }
        // If startsAtMs is unchanged: stay in FATAL, let the backoff timer
        // fire naturally. This prevents thundering-herd retries on a source
        // that is still broken.
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
    } else {
      // ── Inactive buffer became ready ─────────────────────────────────────
      // Track that canplay / loadedmetadata fired on the inactive preload
      // buffer.  This tells onBufferEnded() that the first frame is decoded
      // and the swap can happen without a black-frame flash.
      this.inactiveReadyBufferId = bufferId;

      // If the active buffer already ended while we were waiting for the
      // inactive buffer to finish loading (common with very short items
      // where the near-end trigger fires at t=0 and ended fires within
      // seconds), a deferred HANDOFF is waiting here — execute it now.
      if (
        this.pendingHandoff !== null &&
        this.pendingHandoff.inactiveId === bufferId
      ) {
        if (this.pendingHandoffTimer !== null) {
          clearTimeout(this.pendingHandoffTimer);
          this.pendingHandoffTimer = null;
        }
        const h = this.pendingHandoff;
        this.pendingHandoff = null;
        this.doHandoff(h.endedBufferId, h.inactiveId, h.inactiveItem, h.endedItemId);
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
        const positionSecs = resolvePositionSecs(item as V2Item, startsAtMs, this.clockOffsetMs);
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
          const positionSecs = resolvePositionSecs(item as V2Item, startsAtMs, this.clockOffsetMs);
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
    } else if (
      state === "RECOVERING_PRIMARY" ||
      state === "RECOVERING_FAILOVER"
    ) {
      // The source being recovered is actively loading. A stall during
      // recovery means the recovery attempt itself is failing — the
      // adapter's Watchdog has determined no playback progress after the
      // threshold. Escalate through the normal error path so primaryRetries
      // increments correctly and the machine advances to
      // RECOVERING_FAILOVER → SKIP_PENDING rather than hanging silently
      // until only the bind load-timeout (15 s) fires.
      //
      // No YouTube-override exemption is needed here: RECOVERING_PRIMARY
      // and RECOVERING_FAILOVER can only be entered from PLAYING states
      // using native video (HLS / MP4). A YouTube override in
      // LIVE_OVERRIDE_ACTIVE exits to SYNCING when it ends — never to
      // RECOVERING_* — so the stall always refers to a native element.
      this.onBufferError(bufferId, "stalled");
    } else if (state === "LIVE_OVERRIDE_ACTIVE") {
      // Differentiate by override kind:
      //
      // YouTube overrides: the native <video> element is idle — YouTube
      // renders entirely via an external iframe. The web adapter binds no
      // src to the video element, so `timeupdate` never fires and the
      // Watchdog eventually fires buffer-stalled harmlessly. Escalating
      // would transition to RECOVERING_PRIMARY and destroy the iframe.
      //
      // HLS / RTMP overrides: the native element IS actively loading and
      // decoding. A stall means the manifest or segments stopped arriving.
      // Escalate to RECOVERING_PRIMARY so the broadcast automatically
      // falls back to the regular queue instead of hanging silently.
      const activeItem = bufferId === "A" ? this.snapshot.bufferA : this.snapshot.bufferB;
      const isYouTube =
        activeItem !== null &&
        !("source" in activeItem) &&
        (activeItem as V2Override).kind === "youtube";
      if (!isYouTube) {
        this.onBufferError(bufferId, "stalled");
      }
    }
  }

  private onBufferEnded(bufferId: "A" | "B"): void {
    if (bufferId !== this.snapshot.activeBufferId) return;

    // ── State guard ────────────────────────────────────────────────────────
    // Only honour natural-end events in states where the video is confirmed
    // to be playing.  In PREPARING_ACTIVE the element has been loaded but
    // `canplay` / buffer-ready may not yet have fired — an `ended` event here
    // is almost certainly a seek-past-end false positive (the browser clamped
    // currentTime to duration and fired ended before canplay).  In RECOVERING_*
    // the adapter is re-binding or retrying; treating ended as authoritative
    // there would trigger HANDOFF out of a broken recovery cycle.
    // LIVE_OVERRIDE_ACTIVE is included because finite HLS/MP4 overrides can
    // legitimately fire `ended` when the override stream ends.
    const state = this.snapshot.state;
    if (
      state !== "PLAYING" &&
      state !== "PREPARING_NEXT" &&
      state !== "LIVE_OVERRIDE_ACTIVE"
    ) return;

    // ── Minimum-playback guard ─────────────────────────────────────────────
    // If the machine entered PLAYING less than MIN_PLAYBACK_BEFORE_HANDOFF_MS
    // ago, this `ended` is suspicious: it could come from a preloaded buffer
    // that was seeked to a position very close to the video's actual end (or
    // past it) and fired ended almost immediately after `canplay`.  Suppress
    // HANDOFF and let the stall watchdog handle recovery through its normal
    // error path if the element truly cannot produce any more frames.
    const MIN_PLAYBACK_BEFORE_HANDOFF_MS = 2_000;
    if (
      this.playingEnteredMs !== null &&
      Date.now() - this.playingEnteredMs < MIN_PLAYBACK_BEFORE_HANDOFF_MS
    ) return;

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

    const handoffStartMs = Date.now();

    if (!inactiveItem) {
      // Set lastEndedItemId BEFORE requesting a snapshot so that if the
      // immediate GET /state response arrives before the server processes the
      // POST /natural-end below, onSnapshot() will not rebind the just-ended
      // item from position 0.  Without this guard the player briefly restarts
      // the ended video every time no inactive buffer was preloaded.
      if (endedItemId) {
        this.lastEndedItemId = endedItemId;
        this.lastEndedAtMs = handoffStartMs;
        this.lastEndedItemStartsAtMs = this.snapshot.lastServerSnapshot?.current?.startsAtMs ?? null;
      }
      console.debug(
        "[player] buffer-ended → SYNCING (no preloaded inactive buffer)",
        { bufferId, endedItemId, stateAtEnd: this.snapshot.state, ts: handoffStartMs },
      );
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
      this.lastEndedAtMs = handoffStartMs;
      this.lastEndedItemStartsAtMs = this.snapshot.lastServerSnapshot?.current?.startsAtMs ?? null;
    }

    const inactiveItemId = "id" in inactiveItem ? (inactiveItem as V2Item).id : "override";
    console.debug(
      "[player] buffer-ended → HANDOFF",
      {
        activeBuffer: bufferId,
        nextBuffer: inactiveId,
        endedItemId,
        nextItemId: inactiveItemId,
        stateAtEnd: this.snapshot.state,
        ts: handoffStartMs,
      },
    );

    this.transition("HANDOFF");
    this.emit({ type: "swap", activeBufferId: inactiveId });
    // Play the inactive buffer from the start of the next item (position 0).
    this.emit({ type: "play", bufferId: inactiveId, positionSecs: 0 });
    this.set({ activeBufferId: inactiveId });
    this.transition("PLAYING");

    console.debug(
      "[player] HANDOFF complete → PLAYING",
      { activeBuffer: inactiveId, nextItemId: inactiveItemId, handoffDurationMs: Date.now() - handoffStartMs },
    );
    this.primaryRetries = 0;

    // Signal the server that this item ended naturally so it can advance
    // the cycle anchor immediately, keeping all clients in sync.
    if (endedItemId) this.onNaturalEndCb?.(endedItemId);

    // Immediately request a fresh snapshot after HANDOFF so drift correction
    // for the newly-active item fires in < 1 s rather than waiting up to 8 s
    // for the next keepalive frame.  Every other "needs fresh state now" path
    // in the machine (SYNCING, SKIP_PENDING, onBufferError) already calls this;
    // the HANDOFF path was the only one missing it.  The server will respond
    // with the updated startsAtMs for the new current item, which
    // resolvePositionSecs() uses to place the playhead at the correct wall-clock
    // position — eliminating the brief position-0 phase that was visible
    // during item transitions on slow or reconnecting transports.
    this.onNeedSnapshotCb?.();

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

  private onBufferNearEnd(bufferId: "A" | "B"): void {
    // Only act on the active buffer's near-end signal.
    if (bufferId !== this.snapshot.activeBufferId) return;

    // Only proactively preload during stable playback states.  In recovering /
    // handoff / skip states the inactive buffer may already be in use or the
    // state machine is handling a failure — let those paths run their course.
    const state = this.snapshot.state;
    if (
      state !== "PLAYING" &&
      state !== "PREPARING_ACTIVE" &&
      state !== "PREPARING_NEXT"
    ) return;

    // If the inactive buffer is already loaded (server preload frame arrived
    // in time), nothing to do — HANDOFF will use it naturally.
    const inactiveId = this.swappedId(this.snapshot.activeBufferId);
    const inactiveItem = inactiveId === "A" ? this.snapshot.bufferA : this.snapshot.bufferB;
    if (inactiveItem) return;

    // Proactively bind the server's known next item into the idle inactive
    // buffer so HANDOFF can fire immediately when the active video ends,
    // eliminating the SYNCING → black-screen gap caused by late or missing
    // server preload frames (common when durationSecs in the DB is a 1800 s
    // placeholder that doesn't match the actual encoded file length).
    const server = this.snapshot.lastServerSnapshot;
    const nextToPreload = server?.next ?? server?.nextNext;
    if (!nextToPreload) {
      console.debug(
        "[player] buffer-near-end: no next item to preload (server snapshot has no next/nextNext)",
        { bufferId, state: this.snapshot.state },
      );
      return;
    }
    const nextItemId = "id" in nextToPreload ? nextToPreload.id : "override";
    console.debug(
      "[player] buffer-near-end → proactive preload",
      { bufferId, nextItemId, state: this.snapshot.state },
    );
    this.bindInactive(nextToPreload);
  }

  private onOnline(): void {
    if (this.snapshot.state === "OFFLINE_HOLD") {
      this.transition("SYNCING");
      this.emit({ type: "hide-overlay" });
      // Proactively fetch a fresh snapshot so the FSM exits SYNCING in < 1 s
      // rather than waiting up to 8 s for the transport's next keep-alive.
      // The transport is reconnecting concurrently (forceReconnect is called by
      // the consumer alongside notifyOnline), but a parallel REST fetch via
      // onNeedSnapshotCb fills the window between the machine entering SYNCING
      // and the WS/SSE coming back up.  If the transport delivers a frame first
      // the extra REST response is deduplicated by the sequence guard in
      // onSnapshot (server.sequence <= this.snapshot.lastSequence → ignored).
      this.onNeedSnapshotCb?.();
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
    // Queue item's source expiry watch is irrelevant while an override is active.
    this.clearSourceExpiryTimer();
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
    // Proactively request a fresh snapshot before the source URL expires.
    this.scheduleSourceExpiryWatch(item);
  }

  private bindInactive(item: V2Item | V2Override): void {
    const id = this.swappedId(this.snapshot.activeBufferId);
    const current = id === "A" ? this.snapshot.bufferA : this.snapshot.bufferB;
    // Early-exit only when the inactive buffer already holds the SAME item
    // AND the same cycle-start anchor (startsAtMs).
    //
    // Why startsAtMs matters: on a single-item queue, after HANDOFF the old
    // active buffer (now inactive) still holds item X from the previous loop
    // pass — it is at the end of the video. The server then fires item.advanced
    // with a fresh startsAtMs for the new loop pass. Without the startsAtMs
    // comparison, the early-exit fires (same ID) and the inactive buffer is
    // never rebound. When the current active buffer ends, HANDOFF swaps to
    // an already-ended buffer → black screen / SYNCING stall every loop.
    //
    // V2Override has `startedAtMs` not `startsAtMs`, so the `"startsAtMs" in`
    // guard naturally skips the check for overrides and falls through to the
    // rebind path — correct, since override loop-prevention is handled elsewhere.
    if (
      current &&
      "id" in current &&
      (current as V2Item).id === (item as V2Item).id &&
      "startsAtMs" in current &&
      "startsAtMs" in item &&
      Math.abs((current as V2Item).startsAtMs - (item as V2Item).startsAtMs) <= 2_000
    ) return;
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
