import { EventEmitter } from "node:events";
import type { V2Override, V2ServerFrame, V2Snapshot } from "../domain/types.js";
/**
 * Server-authoritative broadcast orchestrator.
 *
 * Single source of truth for what's airing on each channel. The in-memory
 * state is durable: every transition is appended to `broadcast_event_log`
 * and the cycle anchor is checkpointed to `broadcast_runtime_state` so a
 * server restart resumes mid-stream within a few seconds.
 *
 * Emits `frame` (V2ServerFrame) events that the IO gateways fan out.
 *
 * Crash-safety guarantees:
 *  - hydrate() NEVER throws — any DB failure falls back to safe defaults
 *    (mode=queue, sequence=0) and the orchestrator boots in OFF_AIR mode.
 *  - reloadInner() on DB error falls back to an empty queue (OFF_AIR) so
 *    the orchestrator is always operational; self-heal ticks will retry.
 *  - start() only sets this.started=true after ALL initialisation succeeds.
 *    On failure it resets started=false so the retry mechanism can try again.
 *  - No uncaught exceptions; all async errors are caught and logged.
 */
declare class BroadcastOrchestrator extends EventEmitter {
    readonly channelId = "main";
    private items;
    private cycleStartedAtMs;
    private cycleDurationMs;
    private mode;
    private override;
    /** Position checkpoint of the queue item paused under an override. */
    private queueCheckpoint;
    private failover;
    private sequence;
    private tickTimer;
    private checkpointTimer;
    private trimTimer;
    /**
     * Periodic keep-alive snapshot timer. Emits an authoritative snapshot to all
     * connected clients every 8 s so they can:
     *   1. Correct clock drift accumulated since the last item.advanced event.
     *   2. Exit SYNCING after a single-item queue cycle wrap (item.advanced
     *      never fires for the same item looping, so no snapshot is pushed
     *      unless this timer fires first).
     *   3. Recover from a missed snapshot frame without waiting for reconnect.
     */
    private keepAliveTimer;
    /**
     * Dedicated self-heal timers (decoupled from tickInner so the tick loop
     * stays purely computational and never fires DB work).
     *
     * selfHealEmptyTimer  — fires every SELF_HEAL_EMPTY_MS when the queue is
     *   empty, so a freshly-added item promotes to LIVE quickly.
     * selfHealStaleTimer  — fires every SELF_HEAL_STALE_MS while running to
     *   catch queue mutations that arrived without a bus signal (drift-correct).
     */
    private selfHealEmptyTimer;
    private selfHealStaleTimer;
    /**
     * Dirty flag for the position checkpoint.  Set whenever the orchestrator
     * emits a snapshot (state has changed).  persistCheckpoint() returns
     * immediately when this flag is false, eliminating the DB write for ticks
     * where nothing has changed (the common case at idle with an empty queue).
     */
    private checkpointDirty;
    private lastCurrentItemId;
    /**
     * The startsAtMs value from the last tick in which the current item was
     * identified. Used to detect single-item queue loop wrap-arounds: when the
     * same item ID is playing but startsAtMs jumps forward by more than 500 ms,
     * the cycle has wrapped and the preload gate must be reset so clients
     * receive a fresh preload frame for the new loop iteration.
     */
    private lastCurrentItemStartsAtMs;
    private preloadFiredForId;
    /**
     * Tracks item IDs for which a proactive HEAD probe has already been
     * scheduled in the current cycle.  Prevents duplicate probe requests
     * when tickInner fires multiple times while still inside the PRELOAD_LEAD_MS
     * window.  The set is capped at 200 entries; oldest entries are evicted
     * when the cap is hit (queues are far smaller, so this only guards against
     * very long-running instances without restarts).
     */
    private readonly probeAttemptedForId;
    private started;
    /**
     * Persisted cycle epoch loaded from `broadcast_runtime_state.started_at_ms`
     * during hydrate(). Set once at boot, consumed (set to null) the first time
     * reloadInner() runs so subsequent drift-poll reloads don't re-apply it.
     *
     * This is the PRIMARY restart-persistence mechanism: cycleStartedAtMs is
     * written to DB on every bump() call (item advance, queue change, etc.) so
     * it always reflects the most recent authoritative cycle anchor. Restoring
     * it here means the broadcast resumes at the exact real-time position even
     * after minutes of server downtime — no arithmetic needed.
     */
    private restoredCycleAnchor;
    /**
     * When true, emitFrame() and emitSnapshot() do NOT call this.emit("frame")
     * locally.  Set by the Redis fan-out module when this replica is elected a
     * "reader": frames arrive via injectFrame() from the Redis subscriber instead
     * of from the local tick loop.
     *
     * Default false = standalone / writer mode (existing behaviour).
     */
    private suppressLocalEmit;
    /**
     * Wall-clock ms when the last position checkpoint was written to DB.
     * Loaded during hydrate() and used as a fallback anchor in reloadInner()
     * when no runtime.startedAtMs is available. Using this instead of Date.now()
     * at restart time correctly accounts for server downtime:
     *   cycleStartedAtMs = savedAtMs − itemOffsetInCycle − positionWithinItem
     */
    private checkpointSavedAtMs;
    private lastReloadAtMs;
    private lastReloadOk;
    private lastReloadError;
    private reloadAttempts;
    private reloadSuccesses;
    /**
     * Drift monitor: mirrors the most recently persisted position checkpoint
     * in memory so getDriftInfo() can compare the orchestrator's real-time
     * position against where the checkpoint expected it to be — without any
     * DB round-trip on every /health poll.
     *
     * Set synchronously inside persistCheckpoint() after the DB write fires
     * (we don't wait for the DB promise because we need the wall-clock time
     * to be accurate to the moment of the snapshot, not the DB response time).
     */
    private lastCpItemId;
    private lastCpPositionMs;
    private lastCpWallMs;
    constructor();
    /**
     * Boot the orchestrator. NEVER throws — any failure falls back to a safe
     * default state and the system boots in OFF_AIR mode with the self-heal
     * tick loop retrying queue loads every 10 s.
     *
     * Critical ordering fix: this.started is only set to TRUE after all
     * initialisation succeeds. On failure it remains FALSE so the retry
     * mechanism in index.ts (which checks isStarted()) will correctly
     * schedule another attempt instead of seeing a broken "started" state.
     */
    start(): Promise<void>;
    stop(): void;
    /**
     * Recover from DB on boot.
     *
     * NEVER throws. Each individual DB call is wrapped in its own try/catch
     * so a missing table, dead pool, or bad row never prevents the orchestrator
     * from booting. Worst case: mode=queue, sequence=0 (clean OFF_AIR slate).
     */
    private hydrate;
    /** Single in-flight reload promise so every caller (bus bridge, REST
     *  /reload, self-heal poll) coalesces onto the same DB read. */
    private reloadPromise;
    /**
     * Timestamp of when the last reload completed. Used together with
     * RELOAD_COOLDOWN_MS to rate-limit burst reload triggers that would
     * otherwise fire sequential DB reads milliseconds apart (e.g. a queue
     * mutation SSE + a library-updated SSE arriving in the same tick).
     */
    private lastReloadCompletedAt;
    private static readonly RELOAD_COOLDOWN_MS;
    reload(): Promise<void>;
    private reloadInner;
    /**
     * Project a pre-resolved CachedQueueItem into a full V2Item with wall-clock
     * timing. Returns null only if the item's primary URL is currently in the
     * bad-URL cache (player stall report — fast in-memory lookup, no I/O).
     *
     * This is the ONLY path that constructs V2Item objects at snapshot time.
     * resolveSource() is intentionally NOT called here — it ran once at load
     * time inside reloadInner() and its result is stored in CachedQueueItem.
     */
    private projectItem;
    snapshot(): V2Snapshot;
    private autoSkipAttempts;
    /** Timestamp (ms) when we first detected items loaded but all URLs blocked.
     *  Null when not in that state. Used for auto-recovery after the TTL window. */
    private allBlockedSinceMs;
    /** Circuit breaker: consecutive tick() failures before the circuit opens. */
    private readonly TICK_CIRCUIT_THRESHOLD;
    /**
     * How long to pause the tick loop when the circuit is open (ms).
     * Reduced from 60 s to 15 s: 60 s of dead tick silence is unacceptable
     * for 24/7 broadcast — item advances are undetected during this window.
     * 15 s covers one keepAlive snapshot cycle and equals the heartbeat
     * interval, so clients stay informed even during the circuit-open window.
     */
    private readonly TICK_CIRCUIT_RESET_MS;
    private tickFailures;
    private tickCircuitOpen;
    /**
     * Consecutive self-heal failure counter and backoff state.
     *
     * When loadActive() throws repeatedly (e.g. DB schema mismatch, pool down)
     * the self-heal timers fire every 10–30 s and would flood production logs
     * with "[broadcast-v2] self-heal reload failed" on every attempt.
     * After SELF_HEAL_FAIL_THRESHOLD consecutive failures we back off
     * exponentially (cap: SELF_HEAL_BACKOFF_CAP_MS) before allowing another
     * attempt.  The failure counter resets on any successful reload.
     */
    private selfHealConsecutiveFails;
    private selfHealBlockedUntilMs;
    private static readonly SELF_HEAL_FAIL_THRESHOLD;
    private static readonly SELF_HEAL_BACKOFF_STEPS_MS;
    /**
     * Fire a reload() in the background. Coalescing is owned by reload()
     * itself (single-flight promise), so the bus bridge, REST /reload, and
     * this poll all share the same in-flight call.
     *
     * After SELF_HEAL_FAIL_THRESHOLD consecutive failures the method backs off
     * to avoid flooding logs with identical errors when the underlying issue
     * is persistent (e.g. missing DB column, pool down). Any successful reload
     * resets the counter so normal cadence resumes immediately.
     */
    private scheduleSelfHealReload;
    /**
     * Outer tick() — crash-safe wrapper with circuit breaker.
     *
     * The setInterval callback MUST NOT throw: an unhandled rejection inside
     * setInterval is fatal (uncaughtException → process.exit(1)). This wrapper
     * ensures tickInner() errors are always caught, counted, and logged. After
     * TICK_CIRCUIT_THRESHOLD consecutive failures the circuit opens and the
     * tick loop pauses for TICK_CIRCUIT_RESET_MS (60 s) before self-healing.
     * This prevents a persistently broken tick from burning CPU in a tight loop
     * while still allowing automatic recovery when the root cause is transient.
     */
    private tick;
    /**
     * Inner tick body — may throw. Called only by the outer tick() wrapper
     * which catches all errors and implements the circuit breaker.
     */
    private tickInner;
    startOverride(input: {
        kind: V2Override["kind"];
        url: string;
        title: string;
        endsAtMs: number | null;
        resumeQueueOnEnd: boolean;
    }): Promise<V2Override>;
    stopOverride(): Promise<void>;
    skip(): Promise<void>;
    /**
     * Signal that a player client watched the current item to its natural end
     * before the server's scheduled wall-clock slot expired.
     *
     * This happens when `durationSecs` on the queue row is longer than the
     * actual video file (common for legacy rows with a 1800 s default). Without
     * this call the orchestrator would hold on the old item's slot until the
     * wall-clock catches up, causing every connected player to be pulled back
     * onto the already-finished item on the next snapshot.
     *
     * Safe for concurrent calls from multiple clients:
     *   - First caller: `snap.current.id === itemId` → advances the anchor.
     *   - Subsequent callers: the anchor has already moved, so
     *     `snap.current.id !== itemId` → no-op.
     *
     * Returns `acted: true` when the anchor was actually advanced; callers can
     * use this to decide whether to log or suppress duplicate calls.
     */
    naturalItemEnd(itemId: string): Promise<{
        acted: boolean;
    }>;
    forceFailover(reason: string): Promise<void>;
    clearFailover(): Promise<void>;
    private bump;
    private emitFrame;
    private emitSnapshot;
    /**
     * Public alias for `emitSnapshot()`.
     *
     * Exposed so external callers (REST routes, background probers) can push
     * an immediate snapshot to all connected WS/SSE clients without waiting
     * for the next tick or keep-alive interval.  Safe to call at any time;
     * the underlying emit is a no-op when `listenerCount("frame") === 0`.
     */
    pushSnapshot(): void;
    /**
     * Control whether local tick-loop frame emissions reach SSE/WS clients.
     *
     * Called by the broadcast fan-out module:
     *   setSuppressLocalEmit(true)  → reader mode (frames come from Redis)
     *   setSuppressLocalEmit(false) → writer / standalone mode (default)
     */
    setSuppressLocalEmit(val: boolean): void;
    /**
     * Inject a frame received from an external source (Redis fan-out) directly
     * into the local SSE/WS push path.
     *
     * Unlike emitFrame() / emitSnapshot(), this ALWAYS calls this.emit("frame")
     * regardless of suppressLocalEmit so that reader replicas can deliver
     * frames originating from the writer replica to their own connected clients.
     */
    injectFrame(frame: V2ServerFrame): void;
    /**
     * Send an HTTP HEAD to `url` with a 5 s timeout.
     * Returns true  — server replied 1xx/2xx/3xx (reachable).
     * Returns false — server replied 4xx/5xx (definitively broken).
     * Returns null  — timeout, network error, or SSRF block (ambiguous — do not mark bad).
     */
    private probeUrlReachability;
    /**
     * Schedule a background HEAD probe for `item`'s source URL.
     * If the probe returns a definitive failure, marks both primary and
     * failover URLs bad and pushes an immediate snapshot so all clients
     * advance past the broken item before it would have started playing.
     */
    private scheduleProactiveProbe;
    private persistCheckpoint;
    getSequence(): number;
    /** Number of in-memory queue items currently driving the broadcast cycle. */
    getItemCount(): number;
    /**
     * Returns the current in-memory queue item IDs in their scheduled order.
     * Used by the play-now endpoint to build the new ordered list without
     * an extra DB round-trip — the items array is always in sync after reload.
     */
    getItems(): {
        id: string;
        localVideoUrl: string | null;
        hlsMasterUrl: string | null;
    }[];
    /** Reload diagnostics for /health. */
    getReloadStats(): {
        lastReloadAtMs: number | null;
        lastReloadOk: boolean;
        lastReloadError: string | null;
        attempts: number;
        successes: number;
    };
    /**
     * Cycle anchor drift diagnostics for /health.
     *
     * Compares the orchestrator's live item position against the position
     * recorded in the most recent in-memory checkpoint mirror. A healthy
     * orchestrator should show |driftMs| < a few hundred milliseconds
     * (checkpoint cadence is 5 s, so expected drift is 0–5 000 ms at most).
     *
     * driftMs > 0 → orchestrator is AHEAD of where the checkpoint said it
     *               would be (e.g. a skip bumped the anchor).
     * driftMs < 0 → orchestrator is BEHIND (anchor moved forward incorrectly,
     *               which was the pre-fix restart bug: negative drift of minutes
     *               or hours).
     *
     * driftMs is null when:
     *  - No checkpoint has been captured yet (< 5 s after boot)
     *  - The orchestrator is in override mode (no queue item to compare)
     *  - The current item differs from the checkpointed item (normal item
     *    transition — a new checkpoint fires within 5 s and comparison resumes)
     *  - The last checkpoint is older than 2 minutes (stale — the orchestrator
     *    may have been paused, off-air, or stuck; comparison would be misleading)
     */
    getDriftInfo(): {
        cycleStartedAtMs: number;
        cycleDurationMs: number;
        currentItemId: string | null;
        currentItemPositionMs: number | null;
        lastCpItemId: string | null;
        lastCpPositionMs: number | null;
        lastCpWallMs: number | null;
        driftMs: number | null;
        driftAlerted: boolean;
        driftThresholdMs: number;
    };
    /**
     * All-sources-blocked diagnostics for /health.
     *
     * When every queue item has its URL in the bad-URL cache the orchestrator
     * enters an all-blocked state and tracks the wall-clock entry time in
     * `allBlockedSinceMs`. The auto-recovery fires after BAD_URL_TTL_MS, but
     * operators see a window of several minutes with nothing on air.
     *
     * Exposing this in /health lets:
     *   1. The admin console show an actionable banner with a "Clear blocks"
     *      button (one click vs. waiting for the TTL).
     *   2. External uptime monitors alert on the condition without needing
     *      authenticated access (health is public + rate-limited).
     */
    getAllBlockedInfo(): {
        allSourcesBlocked: boolean;
        allBlockedSinceMs: number | null;
        allBlockedDurationMs: number | null;
    };
    isStarted(): boolean;
}
export declare const broadcastOrchestrator: BroadcastOrchestrator;
export {};
