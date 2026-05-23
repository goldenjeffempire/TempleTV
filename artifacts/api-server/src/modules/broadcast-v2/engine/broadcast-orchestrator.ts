import { EventEmitter } from "node:events";
import { logger } from "../../../infrastructure/logger.js";
import { broadcastSequence, broadcastQueueDepth, broadcastQueueStuck, setBroadcastMode, SERVICE_LABELS } from "../../../infrastructure/metrics.js";
import { eventLogRepo } from "../repository/event-log.repo.js";
import { runtimeRepo } from "../repository/runtime.repo.js";
import { checkpointRepo } from "../repository/checkpoint.repo.js";
import { queueRepo, isKnownBadUrl, markBadUrl, clearAllBadUrls, clearBadUrl, BAD_URL_TTL_MS, incrementBadUrlSkipCount, resetBadUrlSkipCount, autoSuspendQueueItem, BAD_URL_SKIP_THRESHOLD, type RawQueueRow } from "../repository/queue.repo.js";
import { playbackAnalytics } from "./playback-analytics.js";
import { scanLibraryAndEnqueue } from "../../broadcast/auto-enqueue.service.js";
import type {
  V2EventType,
  V2Item,
  V2Mode,
  V2Override,
  V2ServerFrame,
  V2Snapshot,
  V2Source,
} from "../domain/types.js";

/**
 * How far ahead the orchestrator fires a `preload` frame to clients.
 * 60 s gives the B buffer enough time to download a significant portion of
 * the next MP4 (even a 300 MB file on typical broadband) before the current
 * item ends — eliminating the black-screen gap between queue items. HLS
 * sources benefit too: manifest + several segments are prefetched, so the
 * swap is truly instantaneous.
 *
 * Raised from 60 s → 90 s: the extra 30 s provides a safety margin for
 * large files on slow/congested connections where the first bytes can take
 * several seconds to arrive, and for MP4 sources where the browser must
 * download the moov atom before `canplay` fires.  The eager post-handoff
 * preload in the player FSM starts the load even earlier, so 90 s here is
 * now the fallback window rather than the sole guarantee.
 */
const PRELOAD_LEAD_MS = 120_000;
/**
 * Tick interval raised from 1 s → 2 s.
 *
 * The tick loop is purely computational (no I/O) but runs 60×/min at 1 s,
 * creating ephemeral V2Item objects on every call to snapshot() that the GC
 * must collect continuously.  At 2 s the loop still detects item advances
 * with sub-2-second precision — imperceptible for multi-hour sermons — while
 * halving the steady-state CPU and GC pressure at idle.  The PRELOAD_LEAD_MS
 * window (120 s) dwarfs the 2 s tick resolution, so preload frames are still
 * fired well ahead of each transition.
 */
const TICK_MS = 2_000;
/**
 * How often the position checkpoint is persisted to DB.
 * Only writes when checkpointDirty=true (state has actually changed), so
 * this interval is an upper bound on write frequency, not a guaranteed rate.
 * Reduced from 30 s to 5 s for tighter crash-recovery (max 5 s position
 * loss on restart). The dirty-flag gate keeps actual DB write rate low
 * during quiet periods; only active broadcasts incur the extra writes.
 */
const CHECKPOINT_INTERVAL_MS = 5_000;
const EVENT_LOG_TRIM_INTERVAL_MS = 60_000;

/**
 * Self-heal poll cadences.
 *
 * These timers run OUTSIDE the tick loop so tickInner() is purely
 * computational — it never schedules async DB work.  Separating them
 * eliminates the burst of DB queries that previously fired every 5th
 * tick (5 s cadence at 1 000 ms/tick) and was the primary cause of
 * sustained CPU and DB load at idle with 0 active connections.
 *
 * Empty cadence (10 s): being off-air is operator-visible, so we want
 * freshly-added items to promote quickly.
 * Stale cadence (30 s): picks up DB mutations (transcoding-complete,
 * external queue edits) that arrive without a bus-bridge signal within
 * 30 s instead of 60 s — halving the lag before a newly-ready HLS URL
 * becomes the active source on air.
 */
const SELF_HEAL_EMPTY_MS  = 10_000;
const SELF_HEAL_STALE_MS  = 30_000;
/**
 * After this many consecutive empty-queue polls (10 s × 6 = 60 s), the
 * orchestrator runs a full library scan and auto-enqueues every playable
 * `managed_videos` row that isn't already in `broadcast_queue`. This is the
 * 24/7 guarantee backstop: if every upstream auto-enqueue hook silently
 * failed (DB blip, code regression, operator import via an unhooked path),
 * the broadcast still self-heals back on-air within ~60 s.
 */
const EMPTY_POLLS_BEFORE_LIBRARY_SCAN = 6;

/**
 * Pre-resolved queue item stored in the orchestrator's in-memory items array.
 *
 * Source resolution (resolveSource + allowlist check) runs ONCE per item at
 * queue-load time (inside reloadInner), NOT on every snapshot() call. This
 * eliminates the "no playable source available" WARN log storm seen when
 * every WS/SSE client heartbeat re-triggered resolveSource() for every item
 * with an invalid URL.
 *
 * Bad-URL cache checks (isKnownBadUrl) remain at snapshot() time because they
 * are fast in-memory lookups and must reflect real-time player stall reports.
 */
interface CachedQueueItem {
  id: string;
  /** managed_videos.id — null for queue items that have no joined video row. */
  videoId: string | null;
  title: string;
  thumbnailUrl: string | null;
  durationSecs: number;
  /** Stored for fast bad-URL cache lookups in snapshot(). */
  primaryUrl: string | null;
  source: V2Source;
  failoverSource: { kind: "hls" | "mp4"; url: string } | null;
}

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
class BroadcastOrchestrator extends EventEmitter {
  readonly channelId = "main";
  private items: CachedQueueItem[] = [];
  private cycleStartedAtMs = Date.now();
  private cycleDurationMs = 0;
  private mode: V2Mode = "queue";
  private override: V2Override | null = null;
  /** Position checkpoint of the queue item paused under an override. */
  private queueCheckpoint: { itemId: string; positionMs: number } | null = null;
  private failover: { active: boolean; reason: string | null } = { active: false, reason: null };
  private sequence = 0;
  private tickTimer: NodeJS.Timeout | null = null;
  private checkpointTimer: NodeJS.Timeout | null = null;
  private trimTimer: NodeJS.Timeout | null = null;
  /**
   * Periodic keep-alive snapshot timer. Emits an authoritative snapshot to all
   * connected clients every 8 s so they can:
   *   1. Correct clock drift accumulated since the last item.advanced event.
   *   2. Exit SYNCING after a single-item queue cycle wrap (item.advanced
   *      never fires for the same item looping, so no snapshot is pushed
   *      unless this timer fires first).
   *   3. Recover from a missed snapshot frame without waiting for reconnect.
   */
  private keepAliveTimer: NodeJS.Timeout | null = null;
  /**
   * Dedicated self-heal timers (decoupled from tickInner so the tick loop
   * stays purely computational and never fires DB work).
   *
   * selfHealEmptyTimer  — fires every SELF_HEAL_EMPTY_MS when the queue is
   *   empty, so a freshly-added item promotes to LIVE quickly.
   * selfHealStaleTimer  — fires every SELF_HEAL_STALE_MS while running to
   *   catch queue mutations that arrived without a bus signal (drift-correct).
   */
  private selfHealEmptyTimer: NodeJS.Timeout | null = null;
  private selfHealStaleTimer: NodeJS.Timeout | null = null;
  /**
   * Number of consecutive empty-queue polls since the last time the queue
   * had items. Reset to 0 the moment any item is reloaded. When this hits
   * EMPTY_POLLS_BEFORE_LIBRARY_SCAN we fire a library scan as the 24/7
   * continuity backstop, then reset to 0 so we don't re-scan every tick.
   */
  private consecutiveEmptyPolls = 0;
  /**
   * Dirty flag for the position checkpoint.  Set whenever the orchestrator
   * emits a snapshot (state has changed).  persistCheckpoint() returns
   * immediately when this flag is false, eliminating the DB write for ticks
   * where nothing has changed (the common case at idle with an empty queue).
   */
  private checkpointDirty = false;
  private lastCurrentItemId: string | null = null;
  /**
   * The startsAtMs value from the last tick in which the current item was
   * identified. Used to detect single-item queue loop wrap-arounds: when the
   * same item ID is playing but startsAtMs jumps forward by more than 500 ms,
   * the cycle has wrapped and the preload gate must be reset so clients
   * receive a fresh preload frame for the new loop iteration.
   */
  private lastCurrentItemStartsAtMs: number | null = null;
  private preloadFiredForId: string | null = null;
  /**
   * Tracks item IDs for which a proactive HEAD probe has already been
   * scheduled in the current cycle.  Prevents duplicate probe requests
   * when tickInner fires multiple times while still inside the PRELOAD_LEAD_MS
   * window.  The set is capped at 200 entries; oldest entries are evicted
   * when the cap is hit (queues are far smaller, so this only guards against
   * very long-running instances without restarts).
   */
  private readonly probeAttemptedForId = new Set<string>();
  private started = false;
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
  private restoredCycleAnchor: number | null = null;
  /**
   * When true, emitFrame() and emitSnapshot() do NOT call this.emit("frame")
   * locally.  Set by the Redis fan-out module when this replica is elected a
   * "reader": frames arrive via injectFrame() from the Redis subscriber instead
   * of from the local tick loop.
   *
   * Default false = standalone / writer mode (existing behaviour).
   */
  private suppressLocalEmit = false;
  /**
   * Wall-clock ms when the last position checkpoint was written to DB.
   * Loaded during hydrate() and used as a fallback anchor in reloadInner()
   * when no runtime.startedAtMs is available. Using this instead of Date.now()
   * at restart time correctly accounts for server downtime:
   *   cycleStartedAtMs = savedAtMs − itemOffsetInCycle − positionWithinItem
   */
  private checkpointSavedAtMs: number | null = null;
  // Observability — exposed via /health so external monitors can see why
  // a stuck-at-sequence-0 orchestrator hasn't recovered. These are pure
  // in-memory counters; never reset by reload() so the values describe
  // the orchestrator's lifetime since process boot.
  private lastReloadAtMs: number | null = null;
  private lastReloadOk = false;
  private lastReloadError: string | null = null;
  private reloadAttempts = 0;
  private reloadSuccesses = 0;
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
  private lastCpItemId: string | null = null;
  private lastCpPositionMs: number | null = null;
  private lastCpWallMs: number | null = null;
  /**
   * Throttle for the "no playable local content" info log. The reload path
   * runs on a 10 s drift-poll cadence, so without throttling this single
   * branch produces 6 identical log lines per minute of OFF_AIR — pure noise
   * in production. We log at most once per 60 s while the condition holds.
   */
  private lastOffAirLogAtMs = 0;
  /**
   * Set by start() the first (and each subsequent) time the orchestrator
   * transitions from stopped → started. Used by /readyz to differentiate
   * "still booting" from "stuck at sequence 0".
   */
  private startedAtWallMs = 0;

  constructor() {
    super();
    this.setMaxListeners(1024);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

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
  async start(): Promise<void> {
    if (this.started) return;

    // Hydrate always completes without throwing — worst case gives safe defaults.
    await this.hydrate();

    // reloadInner in start() context: retry up to 3 times with short back-off
    // before accepting OFF_AIR.  A single transient DB blip (pool not yet warm,
    // brief PG restart) previously caused an immediate OFF_AIR snapshot that
    // operators saw as a genuine outage even though the DB recovered within a
    // few seconds.  Three attempts at 0 / 1 s / 3 s costs at most 4 s and
    // covers virtually all transient pool errors without delaying healthy boots.
    {
      const BOOT_RETRY_DELAYS_MS = [0, 1_000, 3_000];
      let lastBootErr: unknown = null;
      let loaded = false;
      for (let attempt = 0; attempt < BOOT_RETRY_DELAYS_MS.length; attempt++) {
        const delay = BOOT_RETRY_DELAYS_MS[attempt]!;
        if (delay > 0) {
          await new Promise<void>(resolve => setTimeout(resolve, delay));
        }
        try {
          await this.reloadInner();
          loaded = true;
          break;
        } catch (err) {
          lastBootErr = err;
          logger.warn(
            { err, attempt: attempt + 1, maxAttempts: BOOT_RETRY_DELAYS_MS.length },
            "[broadcast-v2] initial queue load failed — will retry",
          );
        }
      }
      if (!loaded) {
        logger.error(
          { err: lastBootErr },
          "[broadcast-v2] initial queue load failed after all retries — booting in OFF_AIR mode (self-heal will retry)",
        );
        // Ensure we emit a snapshot so SSE/WS clients get a definitive OFF_AIR frame.
        this.items = [];
        this.cycleDurationMs = 0;
        this.emitSnapshot();
      }
    }

    // All initialisation done — mark as started and start timers.
    // This is the ONLY place this.started becomes true.
    this.started = true;
    this.startedAtWallMs = Date.now();

    // ── Tick loop (purely computational — no async/DB work ever) ──────────
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.tickTimer.unref?.();

    // ── Checkpoint persistence (dirty-flag gated) ─────────────────────────
    this.checkpointTimer = setInterval(() => this.persistCheckpoint(), CHECKPOINT_INTERVAL_MS);
    this.checkpointTimer.unref?.();

    // ── Event log trim (low-frequency housekeeping) ───────────────────────
    this.trimTimer = setInterval(() => eventLogRepo.trim(this.channelId), EVENT_LOG_TRIM_INTERVAL_MS);
    this.trimTimer.unref?.();

    // ── Keep-alive snapshot (raised 8 s → 15 s) ──────────────────────────
    // Clients tolerate 15 s between keep-alives; the tick loop handles
    // sub-2-second-precision item advances independently.
    // Guard: skip emitSnapshot() when no SSE/WS clients are subscribed.
    // The EventEmitter emit is cheap but snapshot() still allocates V2Item
    // objects that become immediate GC garbage with no consumers.  At idle
    // (0 connections) this eliminates 4 spurious snapshot() calls per minute.
    this.keepAliveTimer = setInterval(() => {
      if (this.started && this.listenerCount("frame") > 0) this.emitSnapshot();
    }, 15_000);
    this.keepAliveTimer.unref?.();

    // ── Self-heal timers (outside tick — no DB work in tickInner()) ───────
    // Empty-queue poll: check DB every 10 s so a freshly-added item is
    // promoted to LIVE quickly even if the admin-event-bus signal was missed.
    //
    // Belt-and-suspenders: every Nth empty poll (≈60 s when EMPTY_MS=10 s)
    // also fires a library scan. If the queue has been empty for a full
    // minute AND `managed_videos` contains playable rows that simply
    // weren't auto-enqueued (operator imported via a path that bypassed
    // the hooks, a previous DB blip swallowed the auto-add, an admin had
    // BROADCAST_AUTO_ENQUEUE_DISABLE on briefly), this guarantees the
    // broadcast comes back on-air without operator action. The scan is
    // itself a no-op when auto-enqueue is disabled.
    this.selfHealEmptyTimer = setInterval(() => {
      if (!this.started) return;
      if (this.items.length === 0) {
        this.scheduleSelfHealReload("empty-queue-poll");
        this.consecutiveEmptyPolls += 1;
        if (this.consecutiveEmptyPolls >= EMPTY_POLLS_BEFORE_LIBRARY_SCAN) {
          this.consecutiveEmptyPolls = 0;
          void scanLibraryAndEnqueue({
            reason: "self-heal-empty",
            maxToAdd: 100,
          })
            .then((res) => {
              if (res.enqueued > 0) {
                logger.info(
                  res,
                  "[broadcast-v2] self-heal: library scan promoted playable videos into empty queue — reloading",
                );
                this.scheduleSelfHealReload("self-heal-library-scan");
              }
            })
            .catch((err) => {
              logger.warn(
                { err },
                "[broadcast-v2] self-heal: library scan failed (non-fatal)",
              );
            });
        }
      } else {
        this.consecutiveEmptyPolls = 0;
      }
    }, SELF_HEAL_EMPTY_MS);
    this.selfHealEmptyTimer.unref?.();

    // Stale-queue drift correction: reload every 60 s while the queue is
    // populated to pick up reorders / additions that arrived without a
    // bus signal — without blocking the 2 s tick loop at all.
    this.selfHealStaleTimer = setInterval(() => {
      if (!this.started) return;
      if (this.items.length > 0) {
        this.scheduleSelfHealReload("drift-poll");
      }
    }, SELF_HEAL_STALE_MS);
    this.selfHealStaleTimer.unref?.();

    logger.info(
      { items: this.items.length, sequence: this.sequence,
        tickMs: TICK_MS, selfHealEmptyMs: SELF_HEAL_EMPTY_MS,
        selfHealStaleMs: SELF_HEAL_STALE_MS,
        checkpointMs: CHECKPOINT_INTERVAL_MS, keepAliveMs: 15_000 },
      "[broadcast-v2] orchestrator started",
    );
  }

  stop(): void {
    if (this.tickTimer)          clearInterval(this.tickTimer);
    if (this.checkpointTimer)    clearInterval(this.checkpointTimer);
    if (this.trimTimer)          clearInterval(this.trimTimer);
    if (this.keepAliveTimer)     clearInterval(this.keepAliveTimer);
    if (this.selfHealEmptyTimer) clearInterval(this.selfHealEmptyTimer);
    if (this.selfHealStaleTimer) clearInterval(this.selfHealStaleTimer);
    this.tickTimer          = null;
    this.checkpointTimer    = null;
    this.trimTimer          = null;
    this.keepAliveTimer     = null;
    this.selfHealEmptyTimer = null;
    this.selfHealStaleTimer = null;
    this.started = false;
  }

  /**
   * Recover from DB on boot.
   *
   * NEVER throws. Each individual DB call is wrapped in its own try/catch
   * so a missing table, dead pool, or bad row never prevents the orchestrator
   * from booting. Worst case: mode=queue, sequence=0 (clean OFF_AIR slate).
   */
  private async hydrate(): Promise<void> {
    // 1. Load persisted runtime state (mode + sequence + cycle anchor).
    try {
      const runtime = await runtimeRepo.load(this.channelId);
      if (runtime) {
        this.mode = runtime.mode;
        this.sequence = runtime.sequence;
        // PRIMARY restart-persistence: restore the cycle epoch so reloadInner()
        // does NOT clobber it with Date.now(). The cycle anchor is written on
        // every bump() call so this value is always the most recent reliable
        // anchor — even after minutes of server downtime the broadcast resumes
        // at exactly the correct real-time position.
        if (runtime.startedAtMs != null) {
          this.restoredCycleAnchor = runtime.startedAtMs;
          logger.info(
            { startedAtMs: runtime.startedAtMs },
            "[broadcast-v2] hydrate: loaded cycle anchor from runtime state",
          );
        }
      }
    } catch (err) {
      logger.warn(
        { err },
        "[broadcast-v2] hydrate: runtime state read failed — defaulting to queue mode / sequence 0",
      );
      this.mode = "queue";
      this.sequence = 0;
    }

    // 2. Sync sequence with the event log so replay is consistent.
    try {
      const lastSeq = await eventLogRepo.lastSequence(this.channelId);
      if (lastSeq > this.sequence) this.sequence = lastSeq;
    } catch (err) {
      logger.warn({ err }, "[broadcast-v2] hydrate: event log sequence read failed (non-fatal)");
    }

    // 3. Load position checkpoint so we can resume mid-item (fallback path).
    // The primary restore path uses runtime.startedAtMs (step 1) which is more
    // accurate. This checkpoint is only used when no runtime anchor is available
    // (e.g. first-ever boot after the runtime table was empty).
    try {
      const cp = await checkpointRepo.load(this.channelId);
      if (cp?.itemId) {
        this.queueCheckpoint = { itemId: cp.itemId, positionMs: cp.positionMs };
        this.checkpointSavedAtMs = cp.savedAtMs ?? null;
      }
    } catch (err) {
      logger.warn({ err }, "[broadcast-v2] hydrate: checkpoint read failed (non-fatal)");
    }

    // Architect-flagged: persisted mode may be `override` but the override
    // payload itself is not durable across restarts (deliberate: overrides
    // are transient operator actions). Coerce to `queue` so snapshot() can
    // project queue items rather than getting stuck in a no-op override branch.
    if (this.mode === "override" && !this.override) {
      this.mode = "queue";
      logger.warn({ channelId: this.channelId }, "[broadcast-v2] hydrate: dropping stale override mode");
    }
  }

  // ── Queue management ───────────────────────────────────────────────────

  /** Single in-flight reload promise so every caller (bus bridge, REST
   *  /reload, self-heal poll) coalesces onto the same DB read. */
  private reloadPromise: Promise<void> | null = null;

  /**
   * Timestamp of when the last reload completed. Used together with
   * RELOAD_COOLDOWN_MS to rate-limit burst reload triggers that would
   * otherwise fire sequential DB reads milliseconds apart (e.g. a queue
   * mutation SSE + a library-updated SSE arriving in the same tick).
   */
  private lastReloadCompletedAt = 0;
  private static readonly RELOAD_COOLDOWN_MS = 500;

  async reload(): Promise<void> {
    // All concurrent callers share the same in-flight promise — no duplicate
    // DB reads while a reload is already running.
    if (this.reloadPromise) return this.reloadPromise;

    // Rate-limit successive reloads. If a reload completed within the cooldown
    // window, absorb the burst by delaying slightly rather than hitting the DB
    // again immediately. Callers that arrive during the delay also coalesce
    // onto this promise via the `this.reloadPromise` guard above.
    const delay = Math.max(
      0,
      BroadcastOrchestrator.RELOAD_COOLDOWN_MS - (Date.now() - this.lastReloadCompletedAt),
    );

    this.reloadPromise = (
      delay > 0
        ? new Promise<void>(resolve => setTimeout(resolve, delay)).then(() => this.reloadInner())
        : this.reloadInner()
    ).finally(() => {
      this.lastReloadCompletedAt = Date.now();
      this.reloadPromise = null;
    });

    return this.reloadPromise;
  }

  private async reloadInner(): Promise<void> {
    this.reloadAttempts += 1;
    const prev = this.snapshot();
    const prevCurrentId = prev.current?.id ?? null;
    const reloadNow = Date.now();
    const prevPositionMs = prev.current
      ? Math.max(0, reloadNow - prev.current.startsAtMs)
      : 0;

    let rawRows: RawQueueRow[];
    try {
      rawRows = await queueRepo.loadActive();
    } catch (err) {
      // Persist the failure for /health diagnostics. Re-throw so the
      // caller (bus bridge / self-heal poll / REST /reload) sees it
      // and can decide whether to retry. The start() wrapper absorbs
      // this error and boots in OFF_AIR mode; post-boot callers log it.
      this.lastReloadAtMs = Date.now();
      this.lastReloadOk = false;
      this.lastReloadError = err instanceof Error ? err.message : String(err);
      throw err;
    }

    // Pre-resolve sources ONCE per load — toItem() calls resolveSource() which
    // may throw or warn. Doing this here means snapshot() never triggers
    // resolveSource(), eliminating the log storm where every connected WS/SSE
    // client caused N warnings per second (one per unresolvable queue item).
    const resolved: CachedQueueItem[] = [];
    for (const row of rawRows) {
      const v2 = queueRepo.toItem(row, 0); // startsAtMs=0 — only source fields used
      if (!v2) continue; // toItem already logged the reason
      resolved.push({
        id: row.id,
        videoId: row.videoId ?? null,
        title: row.title,
        thumbnailUrl: row.thumbnailUrl,
        durationSecs: row.durationSecs,
        // Store the RESOLVED (absolute) URL so that projectItem()'s
        // isKnownBadUrl() check correctly matches entries written by
        // markBadUrl() (which also receives the resolved source URL).
        // Previously this stored the raw DB value (possibly a relative
        // path like /api/v1/uploads/…), so projectItem() never matched
        // the bad-URL cache and the block was silently ignored at
        // snapshot time — the only effective block was the one in
        // toItem() itself, which also corrupted itemCount.
        primaryUrl: v2.source.url,
        source: v2.source,
        failoverSource: v2.failoverSource,
      });
    }
    // Auto-clear bad-URL cache for items that survived resolution.
    // When a broadcast-queue-updated event fires (e.g. faststart post-processing
    // completed, new upload finalized, or operator triggered a reload), any
    // previously-blocked URL belonging to a now-resolvable item should be playable
    // immediately — not held out for the remaining 45-second TTL.  Clearing here
    // means the NEXT snapshot() call will project those items as current/next
    // instead of skipping them, giving seamless recovery without operator action.
    for (const item of resolved) {
      if (item.primaryUrl) clearBadUrl(item.primaryUrl);
    }

    if (resolved.length === 0 && rawRows.length > 0) {
      // Every item in the queue was rejected — the system has no playable
      // content and will enter OFF_AIR safe mode.  This is an operator-action
      // event, not a code bug, so log at ERROR to surface it clearly.
      logger.error(
        { queueSize: rawRows.length },
        "[broadcast-v2] ALL queue items rejected at pre-resolution — entering OFF_AIR safe mode. " +
          "Action required: set API_ORIGIN=https://api.templetv.org.ng in production env (fixes relative URLs), " +
          "or re-upload / re-transcode the affected videos, then reload the queue from the admin console.",
      );
    } else if (resolved.length < rawRows.length) {
      logger.warn(
        { total: rawRows.length, playable: resolved.length, rejected: rawRows.length - resolved.length },
        "[broadcast-v2] reloadInner: some items rejected at pre-resolution — they will not air",
      );
    }

    if (resolved.length === 0) {
      // Throttle to once per 60 s — this branch is hit on every queue reload
      // (drift-poll cadence is 10 s) so without throttling we emit ~6 lines
      // per minute that say the same thing.
      const nowMs = Date.now();
      if (nowMs - this.lastOffAirLogAtMs > 60_000) {
        this.lastOffAirLogAtMs = nowMs;
        logger.info(
          "[broadcast-v2] reloadInner: no playable local content — broadcast will be OFF_AIR until videos are added to the queue",
        );
      }
    }

    // Snapshot the old item IDs BEFORE replacing this.items so we can detect
    // whether the queue content actually changed. An unchanged queue means the
    // reload was a routine 30-second drift-poll — we should not bump the
    // sequence or fire a queue.changed event in that case. Spurious events
    // cause the transport to call requestSnapshotRefresh(), which fetches a
    // second snapshot a few seconds later; because startsAtMs is computed from
    // Date.now(), the two snapshots can differ by enough to trigger the FSM's
    // drift-correction seek, causing visible video skips.
    const prevItemIds = this.items.map((i) => i.id).join(",");

    this.items = resolved;
    this.lastReloadAtMs = Date.now();
    this.lastReloadOk = true;
    this.lastReloadError = null;
    this.reloadSuccesses += 1;
    this.cycleDurationMs = this.items.reduce((s, r) => s + r.durationSecs * 1000, 0);
    // Mirror playable-queue depth as a Prometheus gauge for dashboards/alerts.
    broadcastQueueDepth.set({ channel: this.channelId, ...SERVICE_LABELS }, this.items.length);
    // Stuck signal: orchestrator started, queue populated, but no sequence
    // advance for >30s past start. Mirrors the /readyz stuck-detection rule.
    // 1 = stuck, 0 = healthy. Allows alert rules without re-implementing logic.
    const startedAtMs = this.startedAtWallMs;
    const stuck =
      this.started &&
      this.sequence === 0 &&
      this.items.length > 0 &&
      startedAtMs > 0 &&
      Date.now() - startedAtMs > 30_000;
    broadcastQueueStuck.set({ channel: this.channelId, ...SERVICE_LABELS }, stuck ? 1 : 0);

    if (prevCurrentId && this.items.length > 0) {
      const idx = this.items.findIndex((i) => i.id === prevCurrentId);
      if (idx !== -1) {
        let offsetMs = 0;
        for (let i = 0; i < idx; i++) offsetMs += this.items[i]!.durationSecs * 1000;
        this.cycleStartedAtMs = reloadNow - offsetMs - prevPositionMs;
      } else {
        this.cycleStartedAtMs = reloadNow;
      }
    } else {
      // Boot case: this.items was empty before this load (first reloadInner()
      // from start(), or the queue went from empty → populated).
      //
      // Restoration priority (highest → lowest accuracy):
      //
      //   1. runtime.startedAtMs (PRIMARY) — The cycle epoch is written to DB
      //      on every bump() call (item advance, queue change, override, etc.).
      //      Restoring it directly gives the exact real-time position with no
      //      arithmetic, even after minutes of server downtime. Set in hydrate()
      //      as this.restoredCycleAnchor.
      //
      //   2. Checkpoint savedAtMs (FALLBACK) — The 5-second position checkpoint
      //      carries the wall-clock time it was written (savedAtMs). Using that
      //      instead of Date.now() correctly accounts for server downtime:
      //        cycleStartedAtMs = savedAtMs − offsetOfItemInCycle − positionMs
      //      Only used when no runtime anchor is available (e.g. very first boot).
      //
      //   3. Fresh start — No persisted state exists; start from now (item 0).

      // Consume both one-shot fields so subsequent drift-poll reloads never
      // accidentally re-apply the boot anchor and reset a live cycle position.
      const restoredAnchor = this.restoredCycleAnchor;
      const cpSavedAtMs = this.checkpointSavedAtMs;
      this.restoredCycleAnchor = null;
      this.checkpointSavedAtMs = null;

      if (restoredAnchor !== null && this.items.length > 0) {
        // PRIMARY: cycle epoch from runtime state — most accurate, zero arithmetic.
        this.cycleStartedAtMs = restoredAnchor;
        logger.info(
          { cycleStartedAtMs: restoredAnchor, itemCount: this.items.length },
          "[broadcast-v2] restored cycle anchor from runtime state after restart",
        );
      } else if (!prevCurrentId && this.queueCheckpoint && this.items.length > 0) {
        // FALLBACK: position checkpoint with savedAtMs fix.
        // Formula: cycleStartedAtMs = savedAtMs − offsetOfItem − positionMs
        // (previously used reloadNow which was wrong by the server downtime duration)
        const cpIdx = this.items.findIndex((i) => i.id === this.queueCheckpoint!.itemId);
        if (cpIdx !== -1) {
          let cpOffsetMs = 0;
          for (let j = 0; j < cpIdx; j++) cpOffsetMs += this.items[j]!.durationSecs * 1000;
          const anchor = cpSavedAtMs ?? reloadNow;
          this.cycleStartedAtMs = anchor - cpOffsetMs - this.queueCheckpoint.positionMs;
          logger.info(
            {
              itemId: this.items[cpIdx]!.id,
              positionMs: this.queueCheckpoint.positionMs,
              anchor,
              usedSavedAtMs: cpSavedAtMs !== null,
            },
            "[broadcast-v2] restored cycle position from checkpoint after restart",
          );
        } else {
          this.cycleStartedAtMs = reloadNow;
        }
      } else {
        // FRESH START: no persisted state — broadcast starts from item 0.
        this.cycleStartedAtMs = reloadNow;
      }

      // Always clear the checkpoint after the boot restoration attempt so it
      // does not interfere with override-resume logic on subsequent reloads.
      this.queueCheckpoint = null;
    }

    // Only emit queue.changed (and the associated sequence bump + WS/SSE
    // snapshot blast) when the item set genuinely changed. For routine
    // drift-poll reloads that produced the same items, silently persist the
    // refreshed cycle anchor to the DB without broadcasting any events.
    const newItemIds = this.items.map((i) => i.id).join(",");
    const queueChanged = newItemIds !== prevItemIds;

    if (queueChanged) {
      await this.bump("queue.changed", { itemCount: this.items.length });
      this.emitSnapshot();
    } else {
      // Persist the refreshed cycleStartedAtMs so it survives a restart, but
      // do so silently (no sequence bump, no client events).
      void runtimeRepo
        .save({
          channelId: this.channelId,
          mode: this.mode,
          currentItemId: this.lastCurrentItemId,
          startedAtMs: this.cycleStartedAtMs,
          offsetMs: 0,
          activeOverrideId: this.override?.id ?? null,
          sequence: this.sequence,
        })
        .catch((err) => logger.warn({ err }, "[broadcast-v2] silent anchor persist failed"));
    }
  }

  // ── Snapshot building ──────────────────────────────────────────────────

  /**
   * Project a pre-resolved CachedQueueItem into a full V2Item with wall-clock
   * timing. Returns null only if the item's primary URL is currently in the
   * bad-URL cache (player stall report — fast in-memory lookup, no I/O).
   *
   * This is the ONLY path that constructs V2Item objects at snapshot time.
   * resolveSource() is intentionally NOT called here — it ran once at load
   * time inside reloadInner() and its result is stored in CachedQueueItem.
   */
  private projectItem(item: CachedQueueItem, startsAtMs: number): V2Item | null {
    if (item.primaryUrl && isKnownBadUrl(item.primaryUrl)) return null;
    return {
      id: item.id,
      title: item.title,
      thumbnailUrl: item.thumbnailUrl,
      durationSecs: item.durationSecs,
      source: item.source,
      failoverSource: item.failoverSource,
      startsAtMs,
      endsAtMs: startsAtMs + item.durationSecs * 1000,
    };
  }

  snapshot(): V2Snapshot {
    const now = Date.now();
    let current: V2Item | null = null;
    let next: V2Item | null = null;
    let nextNext: V2Item | null = null;

    if (this.mode === "override" && this.override) {
      // Synthesize an override "item" for clients that prefer the V2Item shape;
      // most clients render `override` directly.
    } else if (this.items.length > 0 && this.cycleDurationMs > 0) {
      const elapsed = ((now - this.cycleStartedAtMs) % this.cycleDurationMs + this.cycleDurationMs) % this.cycleDurationMs;
      let acc = 0;
      // Find the item whose time-slot contains `elapsed`. If `toItem()`
      // returns null for that slot (unresolvable URL), scan forward through
      // the remaining slots to find the first playable item. The auto-skip
      // in tick() will advance the cycle anchor on the next tick, but until
      // then we want to surface *some* valid current item so the FSM can
      // transition out of SYNCING and the overlay can show "Off air" only
      // when the entire queue is unresolvable — not on a single bad item.
      let foundIdx = -1;
      let foundStartsAtMs = 0;
      for (let i = 0; i < this.items.length; i++) {
        const span = this.items[i]!.durationSecs * 1000;
        if (elapsed < acc + span) {
          // This is the current time-slot. Try to project it.
          const startsAtMs = now - (elapsed - acc);
          const projected = this.projectItem(this.items[i]!, startsAtMs);
          if (projected !== null) {
            current = projected;
            foundIdx = i;
            foundStartsAtMs = startsAtMs;
          } else {
            // Slot unresolvable (bad-URL cache) — scan forward for the first
            // valid item. Use a virtual wall-clock cursor so next/nextNext
            // stay temporally consistent with the item we eventually bind.
            let scanCursor = now + (span - (elapsed - acc)); // start of next slot
            for (let j = 1; j < this.items.length; j++) {
              const si = (i + j) % this.items.length;
              const scan = this.projectItem(this.items[si]!, scanCursor);
              if (scan !== null) {
                current = scan;
                foundIdx = si;
                foundStartsAtMs = scanCursor;
                break;
              }
              scanCursor += this.items[si]!.durationSecs * 1000;
            }
          }
          break;
        }
        acc += span;
      }
      // Project next / nextNext relative to whichever item ended up as current.
      // Scan forward past any bad-URL items so the client always receives the
      // nearest two *playable* items to preload — even when multiple consecutive
      // queue slots are broken.  Without this, a run of bad items yields
      // next=null and nextNext=null; the inactive buffer is never primed and
      // every transition falls into a SYNCING gap.
      if (foundIdx !== -1) {
        let cursor = foundStartsAtMs + this.items[foundIdx]!.durationSecs * 1000;
        let goodsFound = 0;
        // Scan up to `items.length` slots forward (instead of `items.length - 1`)
        // so small queues (e.g. 2 items) can wrap around and populate `nextNext`
        // with the item that plays after `next`.  Without this fix, `nextNext` is
        // always null for 2-item queues: the loop exits when k == items.length
        // (2 < 2 is false) before finding the wrap-around slot.  As a result the
        // inactive buffer is never primed ahead of the loop boundary, causing a
        // SYNCING gap on every cycle wrap-around.
        for (let k = 1; k <= this.items.length && goodsFound < 2; k++) {
          const si = (foundIdx + k) % this.items.length;
          const it = this.items[si]!;
          const projected = this.projectItem(it, cursor);
          cursor += it.durationSecs * 1000;
          if (projected !== null) {
            goodsFound++;
            if (goodsFound === 1) next = projected;
            else nextNext = projected;
          }
        }
      }
    }

    return {
      channelId: this.channelId,
      sequence: this.sequence,
      serverTimeMs: now,
      mode: this.mode,
      current,
      next,
      nextNext,
      override: this.override,
      checkpoint: this.queueCheckpoint,
      failover: { ...this.failover },
    };
  }

  // ── Tick: detect transitions and emit preload/advance ──────────────────

  private autoSkipAttempts = 0;
  /** Timestamp (ms) when we first detected items loaded but all URLs blocked.
   *  Null when not in that state. Used for auto-recovery after the TTL window. */
  private allBlockedSinceMs: number | null = null;

  /** Circuit breaker: consecutive tick() failures before the circuit opens. */
  private readonly TICK_CIRCUIT_THRESHOLD = 5;
  /**
   * How long to pause the tick loop when the circuit is open (ms).
   * Reduced from 60 s to 15 s: 60 s of dead tick silence is unacceptable
   * for 24/7 broadcast — item advances are undetected during this window.
   * 15 s covers one keepAlive snapshot cycle and equals the heartbeat
   * interval, so clients stay informed even during the circuit-open window.
   */
  private readonly TICK_CIRCUIT_RESET_MS = 15_000;
  private tickFailures = 0;
  private tickCircuitOpen = false;

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
  private selfHealConsecutiveFails = 0;
  private selfHealBlockedUntilMs = 0;
  private static readonly SELF_HEAL_FAIL_THRESHOLD = 3;
  private static readonly SELF_HEAL_BACKOFF_STEPS_MS = [30_000, 60_000, 120_000, 300_000];

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
  private scheduleSelfHealReload(reason: string): void {
    const now = Date.now();
    if (this.selfHealConsecutiveFails >= BroadcastOrchestrator.SELF_HEAL_FAIL_THRESHOLD) {
      if (now < this.selfHealBlockedUntilMs) {
        // Still within the backoff window — skip silently.
        return;
      }
    }
    void this.reload()
      .then(() => {
        this.selfHealConsecutiveFails = 0;
        this.selfHealBlockedUntilMs = 0;
        if (this.items.length > 0) {
          // Routine drift-poll — log at DEBUG to avoid flooding production
          // logs every 20 s with an INFO message that signals no operator
          // action. The reload itself is silent (no sequence bump) when the
          // queue content hasn't changed.
          logger.debug(
            { reason, items: this.items.length },
            "[broadcast-v2] self-heal reload promoted queue items",
          );
        }
      })
      .catch((err) => {
        this.selfHealConsecutiveFails += 1;
        const stepIdx = Math.min(
          this.selfHealConsecutiveFails - 1,
          BroadcastOrchestrator.SELF_HEAL_BACKOFF_STEPS_MS.length - 1,
        );
        const backoffMs = BroadcastOrchestrator.SELF_HEAL_BACKOFF_STEPS_MS[stepIdx]!;
        this.selfHealBlockedUntilMs = Date.now() + backoffMs;
        logger.warn(
          { err, reason, consecutiveFails: this.selfHealConsecutiveFails, nextRetryInMs: backoffMs },
          "[broadcast-v2] self-heal reload failed — backing off",
        );
      });
  }

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
  private tick(): void {
    if (this.tickCircuitOpen) return;
    try {
      this.tickInner();
      // Success — reset consecutive-failure counter.
      if (this.tickFailures > 0) this.tickFailures = 0;
    } catch (err) {
      this.tickFailures += 1;
      logger.error(
        { err, consecutiveFailures: this.tickFailures, threshold: this.TICK_CIRCUIT_THRESHOLD },
        "[broadcast-v2] tick() error",
      );
      if (this.tickFailures >= this.TICK_CIRCUIT_THRESHOLD) {
        this.tickCircuitOpen = true;
        logger.error(
          { failures: this.tickFailures, resetMs: this.TICK_CIRCUIT_RESET_MS },
          "[broadcast-v2] tick circuit breaker OPEN — pausing tick loop, will self-heal on reset",
        );
        const resetTimer = setTimeout(() => {
          this.tickCircuitOpen = false;
          this.tickFailures = 0;
          logger.warn("[broadcast-v2] tick circuit breaker CLOSED — resuming");
          // Trigger an immediate self-heal reload so we re-evaluate the queue
          // without waiting for the next successful tick to fire.
          this.scheduleSelfHealReload("circuit-breaker-reset");
        }, this.TICK_CIRCUIT_RESET_MS);
        resetTimer.unref?.();
      }
    }
  }

  /**
   * Inner tick body — may throw. Called only by the outer tick() wrapper
   * which catches all errors and implements the circuit breaker.
   */
  private tickInner(): void {
    if (this.mode !== "queue") return;
    const snap = this.snapshot();
    if (!snap.current) {
      // Architect-flagged: a single bad item could stall the cycle. If we
      // have queue items but cannot project a current item, the most likely
      // cause is queueRepo.toItem() returning null for an unresolvable
      // source. Auto-skip up to 5 consecutive items before going quiet.
      if (this.items.length > 0 && this.cycleDurationMs > 0 && this.autoSkipAttempts < 5) {
        this.autoSkipAttempts += 1;
        // Advance the cycle anchor by one item-duration to skip the bad slot.
        const elapsed = ((Date.now() - this.cycleStartedAtMs) % this.cycleDurationMs + this.cycleDurationMs) % this.cycleDurationMs;
        let acc = 0;
        for (let i = 0; i < this.items.length; i++) {
          const span = this.items[i]!.durationSecs * 1000;
          if (elapsed < acc + span) {
            this.cycleStartedAtMs -= span - (elapsed - acc);
            void this.bump("item.skipped", { itemId: this.items[i]!.id, reason: "unresolvable" });
            this.emitSnapshot();
            break;
          }
          acc += span;
        }
      }
      // All-sources-blocked auto-recovery: when items are loaded but every URL
      // is in the bad-URL cache, track how long we've been in this state.
      // Once BAD_URL_TTL_MS has elapsed the cache entries would naturally
      // expire on the next isKnownBadUrl() call, but that call only happens
      // inside snapshot() which is driven by this same tick — so we proactively
      // clear the cache and reload here to resume playing without operator action.
      if (this.items.length > 0) {
        const now = Date.now();
        if (this.allBlockedSinceMs === null) {
          this.allBlockedSinceMs = now;
        } else if (now - this.allBlockedSinceMs >= BAD_URL_TTL_MS) {
          this.allBlockedSinceMs = null;
          logger.info(
            { items: this.items.length },
            "[broadcast-v2] all-sources-blocked TTL expired — auto-clearing bad-URL cache and reloading",
          );
          clearAllBadUrls();
          this.scheduleSelfHealReload("all-blocked-ttl-recovery");
          return;
        }
      }

      // Self-heal is handled by dedicated selfHealEmptyTimer (SELF_HEAL_EMPTY_MS)
      // which fires outside this tight loop so tickInner() stays DB-free.
      return;
    }
    this.allBlockedSinceMs = null;
    this.autoSkipAttempts  = 0;
    // Drift-correct self-heal is handled by selfHealStaleTimer (SELF_HEAL_STALE_MS)
    // which runs outside the tick loop so no DB work ever happens inside tick().

    // Detect advance (different item ID) or single-item loop wrap-around.
    if (this.lastCurrentItemId !== snap.current.id) {
      // Different item — straightforward advance.
      this.lastCurrentItemId = snap.current.id;
      this.preloadFiredForId = null;

      // ── Forward-scan anchor fix ───────────────────────────────────────────
      // When snapshot() cannot project the item whose elapsed time-slot is
      // active (bad-URL cache), it scans forward to find the next playable
      // item.  The scan cursor starts at the END of the blocked slot, so the
      // found item's startsAtMs is set to a FUTURE wall-clock time.
      //
      // Without this fix the consequences are severe:
      //
      //   1. The orchestrator NEVER advances cycleStartedAtMs while elapsed
      //      sits inside the bad item's slot.  It keeps projecting the same
      //      forward-scanned item as `current` for the full duration of the
      //      blocked slot (which can be hours).
      //
      //   2. Clients receive startsAtMs in the future → they compute
      //      positionSecs = (now - future) / 1000 → negative → clamped to 0 →
      //      they play the video from the beginning.  Fine on first bind.
      //
      //   3. When the client's video finishes (its natural play duration),
      //      the server's elapsed is STILL inside the bad item's slot, so
      //      snapshot() continues returning the same item as `current`.
      //      The keepalive snapshot reaches the client, activeItemId no longer
      //      matches (post-HANDOFF), the stale-guard doesn't fire (endsAtMs is
      //      far future), so the machine REBINDS and plays the item again from
      //      the start.  This repeats indefinitely, filling the bad item's
      //      entire time budget with looping replays of the same video.
      //
      //   4. The server-side preload timer fires 90 s before the item's
      //      SCHEDULED end (far future), not before the video's ACTUAL end,
      //      so the inactive buffer is never primed during the real playback
      //      window — causing a SYNCING gap on every transition.
      //
      // Fix: if the found item's startsAtMs is in the future (> now + 1 s),
      // immediately advance cycleStartedAtMs so that item's slot starts NOW.
      //
      // Formula: cycleStartedAtMs = now − Σ durationMs of items before this
      // item in the cycle.  After the adjustment, snapshot() returns
      // startsAtMs ≈ now, elapsed is correct, and the preload timer fires at
      // the right wall-clock time relative to the video's actual start.
      //
      // Guard (> now + 1 s) tolerates sub-second clock jitter so natural item
      // advances (startsAtMs within a tick of now) don't trigger the fix.
      const nowForAnchorFix = Date.now();
      if (snap.current.startsAtMs > nowForAnchorFix + 1000) {
        const idx = this.items.findIndex(it => it.id === snap.current!.id);
        if (idx !== -1) {
          let offsetMs = 0;
          for (let i = 0; i < idx; i++) offsetMs += this.items[i]!.durationSecs * 1000;
          this.cycleStartedAtMs = nowForAnchorFix - offsetMs;
          this.lastCurrentItemStartsAtMs = nowForAnchorFix;
          logger.info(
            {
              itemId: snap.current.id,
              skippedSlotMs: snap.current.startsAtMs - nowForAnchorFix,
              newCycleStartedAtMs: this.cycleStartedAtMs,
              itemOffsetMs: offsetMs,
            },
            "[broadcast-v2] forward-scan anchor fix — bad-URL slot skipped, cycle anchor advanced to now",
          );
        } else {
          this.lastCurrentItemStartsAtMs = snap.current.startsAtMs;
        }
      } else {
        this.lastCurrentItemStartsAtMs = snap.current.startsAtMs;
      }

      // bump() emits an `event` frame synchronously before any async work.
      // emitSnapshot() must follow immediately so all connected WS/SSE clients
      // receive the authoritative new state without waiting for the next
      // heartbeat (15 s window). Without this, clients play the previous item
      // indefinitely because the `event` frame is intentionally ignored by the
      // transport — only `snapshot` frames trigger machine state transitions.
      void this.bump("item.advanced", { itemId: snap.current.id, title: snap.current.title });
      this.emitSnapshot();
    } else if (
      // Single-item loop detection: same item ID but startsAtMs jumped
      // forward, meaning the cycle wrapped. cycleStartedAtMs is pinned
      // for the entire duration of one pass; it steps by ~durationMs at
      // the loop boundary, making startsAtMs jump accordingly.
      //
      // Without this branch, the preload gate (preloadFiredForId) is never
      // reset after the first pass, so clients never receive a preload
      // frame for subsequent loops and the inactive buffer stays unbound —
      // causing a SYNCING stall after the video ends on every repeat.
      this.lastCurrentItemStartsAtMs !== null &&
      snap.current.startsAtMs > this.lastCurrentItemStartsAtMs + 500
    ) {
      this.preloadFiredForId = null;
      this.lastCurrentItemStartsAtMs = snap.current.startsAtMs;
      // Emit item.advanced so clients know the loop restarted and update
      // their startsAtMs reference for wall-clock position correction.
      void this.bump("item.advanced", { itemId: snap.current.id, title: snap.current.title });
      this.emitSnapshot();
    }

    // Detect preload window
    if (snap.next && this.preloadFiredForId !== snap.next.id) {
      const msToEnd = snap.current.endsAtMs - Date.now();
      if (msToEnd <= PRELOAD_LEAD_MS && msToEnd > 0) {
        this.preloadFiredForId = snap.next.id;
        this.emitFrame({
          type: "preload",
          sequence: this.sequence,
          item: snap.next,
          leadMs: PRELOAD_LEAD_MS,
        });
        playbackAnalytics.record({
          type: "preload_fired",
          itemId: snap.next.id,
          itemTitle: snap.next.title,
          ts: Date.now(),
          meta: { msToEnd, leadMs: PRELOAD_LEAD_MS },
        });
        // Proactively validate the next item's URL in the background.
        // A broken URL is marked bad now — before any viewer loads it —
        // so the bad-URL forward scan silently skips it at transition time.
        this.scheduleProactiveProbe(snap.next);
      }
    }
  }

  // ── Commands ───────────────────────────────────────────────────────────

  async startOverride(input: { kind: V2Override["kind"]; url: string; title: string; endsAtMs: number | null; resumeQueueOnEnd: boolean }): Promise<V2Override> {
    // Checkpoint the current queue item if we're playing one.
    const snap = this.snapshot();
    if (this.mode === "queue" && snap.current) {
      this.queueCheckpoint = {
        itemId: snap.current.id,
        positionMs: Math.max(0, Date.now() - snap.current.startsAtMs),
      };
    }
    this.override = {
      id: `ov-${Date.now()}`,
      kind: input.kind,
      url: input.url,
      title: input.title,
      startedAtMs: Date.now(),
      endsAtMs: input.endsAtMs,
      resumeQueueOnEnd: input.resumeQueueOnEnd,
    };
    this.mode = "override";
    await this.bump("override.started", { override: this.override });
    this.emitFrame({ type: "takeover", sequence: this.sequence, override: this.override });
    this.emitSnapshot();
    return this.override;
  }

  async stopOverride(): Promise<void> {
    if (!this.override) return;
    const wasResumable = this.override.resumeQueueOnEnd;
    await this.bump("override.ended", { id: this.override.id });
    this.override = null;
    this.mode = "queue";
    if (wasResumable && this.queueCheckpoint && this.items.length > 0) {
      // Re-anchor cycleStartedAt so the saved item resumes at saved position.
      const idx = this.items.findIndex((i) => i.id === this.queueCheckpoint!.itemId);
      if (idx !== -1) {
        let offsetMs = 0;
        for (let i = 0; i < idx; i++) offsetMs += this.items[i]!.durationSecs * 1000;
        this.cycleStartedAtMs = Date.now() - offsetMs - this.queueCheckpoint.positionMs;
      }
    }
    this.queueCheckpoint = null;
    this.emitSnapshot();
  }

  async skip(): Promise<void> {
    if (this.items.length === 0 || this.cycleDurationMs === 0) return;
    const snap = this.snapshot();
    if (!snap.current) return;
    const remainingMs = snap.current.endsAtMs - Date.now();
    this.cycleStartedAtMs -= remainingMs;
    await this.bump("item.skipped", { itemId: snap.current.id });
    this.emitSnapshot();
  }

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
  async naturalItemEnd(itemId: string): Promise<{ acted: boolean }> {
    if (this.mode !== "queue") return { acted: false };
    if (this.items.length === 0 || this.cycleDurationMs === 0) return { acted: false };
    const snap = this.snapshot();
    if (!snap.current || snap.current.id !== itemId) return { acted: false };
    const remainingMs = snap.current.endsAtMs - Date.now();
    // Only advance if there is actually remaining time; if the slot has
    // already expired the next tick() will handle the advance naturally.
    if (remainingMs <= 0) return { acted: false };

    // Compute the actual elapsed duration before modifying cycleStartedAtMs:
    //   actual = (endsAtMs − remainingMs) − startsAtMs
    //          ≈ Date.now() − startsAtMs
    // Write this back to the DB so future loop iterations use the real length
    // instead of the 1800-second placeholder — improves timing accuracy for
    // every subsequent cycle without any operator action.
    const actualDurationSecs = Math.round(
      (snap.current.endsAtMs - remainingMs - snap.current.startsAtMs) / 1000,
    );
    if (actualDurationSecs > 10 && actualDurationSecs < 86_400) {
      void queueRepo
        .updateDurationSecs(itemId, actualDurationSecs)
        .then(() => {
          // Mirror the DB write-back into the in-memory items array so that
          // the NEXT cycle iteration uses the real duration without waiting
          // for the next self-heal reload (up to 60 s later). Without this,
          // the stale 1800-second placeholder stays in this.items and the
          // cycle timing is wrong for every subsequent loop.
          const idx = this.items.findIndex((i) => i.id === itemId);
          if (idx !== -1 && this.items[idx]) {
            this.items[idx] = { ...this.items[idx]!, durationSecs: actualDurationSecs };
            this.cycleDurationMs = this.items.reduce((s, r) => s + r.durationSecs * 1000, 0);
          }
        })
        .catch((err) =>
          logger.warn(
            { err, itemId, actualDurationSecs },
            "[broadcast-v2] naturalItemEnd: duration write-back failed (non-fatal)",
          ),
        );
    }

    this.cycleStartedAtMs -= remainingMs;
    // Item played successfully to its natural end — reset the URL-failure
    // counter so past probe/stall failures don't accumulate across restarts
    // or transient CDN blips.
    resetBadUrlSkipCount(itemId);
    await this.bump("item.advanced", { itemId, title: snap.current.title, naturalEnd: true });
    this.emitSnapshot();
    logger.info(
      { itemId, remainingMs, actualDurationSecs, title: snap.current.title },
      "[broadcast-v2] natural item end — cycle anchor advanced to now",
    );
    return { acted: true };
  }

  async forceFailover(reason: string): Promise<void> {
    this.failover = { active: true, reason };
    await this.bump("failover.engaged", { reason });
    this.emitSnapshot();
  }

  async clearFailover(): Promise<void> {
    if (!this.failover.active) return;
    this.failover = { active: false, reason: null };
    await this.bump("failover.cleared", {});
    this.emitSnapshot();
  }

  // ── Persistence helpers ────────────────────────────────────────────────

  private async bump(eventType: V2EventType, payload: unknown): Promise<void> {
    this.sequence += 1;
    const seq = this.sequence;
    // Persist state and event in the background so the tick loop stays cheap.
    void Promise.all([
      eventLogRepo.append(this.channelId, seq, eventType, payload),
      runtimeRepo.save({
        channelId: this.channelId,
        mode: this.mode,
        currentItemId: this.lastCurrentItemId,
        startedAtMs: this.cycleStartedAtMs,
        offsetMs: 0,
        activeOverrideId: this.override?.id ?? null,
        sequence: seq,
      }),
    ]).catch((err) => logger.warn({ err }, "[broadcast-v2] persistence error"));

    // Record analytics events for observable broadcast lifecycle signals.
    const p = payload as Record<string, unknown> | null | undefined;
    const itemId = (p?.itemId as string | undefined) ?? null;
    const itemTitle = (p?.title as string | undefined) ?? null;
    const ts = Date.now();
    if (eventType === "item.advanced") {
      if (p?.naturalEnd === true) {
        playbackAnalytics.record({ type: "natural_end", itemId, itemTitle, ts });
      } else {
        playbackAnalytics.record({ type: "item_advanced", itemId, itemTitle, ts });
      }
    } else if (eventType === "item.skipped") {
      playbackAnalytics.record({ type: "skip", itemId, itemTitle, ts, meta: { reason: p?.reason } });
    } else if (eventType === "queue.changed") {
      playbackAnalytics.record({ type: "reload", itemId: null, itemTitle: null, ts, meta: { itemCount: p?.itemCount } });
    }

    this.emitFrame({ type: "event", sequence: seq, eventType, payload });
  }

  private emitFrame(frame: V2ServerFrame): void {
    if (!this.suppressLocalEmit) {
      this.emit("frame", frame);
    }
  }

  private emitSnapshot(): void {
    const state = this.snapshot();
    this.checkpointDirty = true;
    broadcastSequence.set({ channel: this.channelId, ...SERVICE_LABELS }, this.sequence);
    setBroadcastMode(this.channelId, this.mode);
    if (!this.suppressLocalEmit) {
      this.emit("frame", { type: "snapshot", sequence: this.sequence, state } satisfies V2ServerFrame);
    }
  }

  /**
   * Public alias for `emitSnapshot()`.
   *
   * Exposed so external callers (REST routes, background probers) can push
   * an immediate snapshot to all connected WS/SSE clients without waiting
   * for the next tick or keep-alive interval.  Safe to call at any time;
   * the underlying emit is a no-op when `listenerCount("frame") === 0`.
   */
  pushSnapshot(): void {
    this.emitSnapshot();
  }

  /**
   * Control whether local tick-loop frame emissions reach SSE/WS clients.
   *
   * Called by the broadcast fan-out module:
   *   setSuppressLocalEmit(true)  → reader mode (frames come from Redis)
   *   setSuppressLocalEmit(false) → writer / standalone mode (default)
   */
  setSuppressLocalEmit(val: boolean): void {
    this.suppressLocalEmit = val;
  }

  /**
   * Inject a frame received from an external source (Redis fan-out) directly
   * into the local SSE/WS push path.
   *
   * Unlike emitFrame() / emitSnapshot(), this ALWAYS calls this.emit("frame")
   * regardless of suppressLocalEmit so that reader replicas can deliver
   * frames originating from the writer replica to their own connected clients.
   */
  injectFrame(frame: V2ServerFrame): void {
    this.emit("frame", frame);
  }

  // ── Proactive next-item URL validation ───────────────────────────────────
  //
  // When the preload window opens (PRELOAD_LEAD_MS before the current item
  // ends), the orchestrator fires a HEAD probe at the next item's source URL.
  // If the probe returns a definitive 4xx / 5xx the URL is marked bad
  // immediately — before any viewer attempts to load it — so the bad-URL
  // forward-scan in snapshot() silently advances to the item after next.
  // Viewers never see a stall; the broken item is silently skipped pre-air.
  //
  // Design constraints:
  //   • Non-blocking: runs in a detached async chain; tickInner() returns
  //     immediately and is never awaited by the probe.
  //   • Idempotent: probeAttemptedForId gates duplicate probes per cycle.
  //   • Conservative: only a definitive HTTP-error response (status ≥ 400)
  //     triggers markBadUrl(). Timeouts and network errors return null and
  //     are silently ignored — false positives on transient network blips
  //     must never silently drop healthy content.
  //   • YouTube-safe: YouTube embed URLs are skipped — they resolve as HTML
  //     pages, not video streams; a HEAD check would give a false positive.

  /**
   * Send an HTTP HEAD to `url` with a 5 s timeout.
   * Returns true  — server replied 1xx/2xx/3xx (reachable).
   * Returns false — server replied 4xx/5xx (definitively broken).
   * Returns null  — timeout, network error, or SSRF block (ambiguous — do not mark bad).
   */
  private async probeUrlReachability(url: string): Promise<boolean | null> {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 5_000);
      let res: Response;
      try {
        res = await fetch(url, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
      } finally {
        clearTimeout(timeout);
      }
      return res.status < 400;
    } catch {
      return null; // AbortError, NetworkError, or SSRF block — ambiguous
    }
  }

  /**
   * Schedule a background HEAD probe for `item`'s source URL.
   * If the probe returns a definitive failure, marks both primary and
   * failover URLs bad and pushes an immediate snapshot so all clients
   * advance past the broken item before it would have started playing.
   */
  private scheduleProactiveProbe(item: V2Item): void {
    const key = item.id;
    if (this.probeAttemptedForId.has(key)) return;
    this.probeAttemptedForId.add(key);
    // Bounded eviction: prevents unbounded growth on very long-running instances.
    if (this.probeAttemptedForId.size > 200) {
      const oldest = this.probeAttemptedForId.values().next().value;
      if (oldest != null) this.probeAttemptedForId.delete(oldest);
    }

    const url = item.source?.url ?? null;
    if (!url) return;

    void (async () => {
      const reachable = await this.probeUrlReachability(url);
      if (reachable !== false) return; // ok or ambiguous — leave rotation unchanged
      markBadUrl(url);
      if (item.failoverSource?.url) markBadUrl(item.failoverSource.url);
      logger.warn(
        { itemId: item.id, title: item.title, url, sequence: this.sequence },
        "[broadcast-v2] proactive probe: next item URL unreachable — pre-marking bad before any viewer stalls",
      );
      this.emitSnapshot(); // push new state to all clients immediately
      // Increment the per-item failure counter. If it reaches the threshold,
      // deactivate the item in DB and reload so it is removed from the cycle.
      const failCount = incrementBadUrlSkipCount(item.id);
      if (failCount >= BAD_URL_SKIP_THRESHOLD) {
        await autoSuspendQueueItem(item.id, item.title ?? null, failCount);
        void this.reload();
      }
    })();
  }

  private async persistCheckpoint(): Promise<void> {
    // Fast-path: nothing has changed since the last write — skip the DB round-trip.
    // This eliminates checkpoint writes during idle periods (empty queue, override
    // mode with no activity) which previously fired unconditionally every 5 s.
    if (!this.checkpointDirty) return;
    const snap = this.snapshot();
    if (!snap.current) {
      // Queue is empty or in override — nothing to checkpoint; clear dirty flag
      // so we don't retry immediately on the next interval.
      this.checkpointDirty = false;
      return;
    }
    this.checkpointDirty = false;
    const now = Date.now();
    const positionMs = Math.max(0, now - snap.current.startsAtMs);
    // Mirror the checkpoint in memory synchronously so getDriftInfo() can
    // compare the live position against the last persisted position without
    // a DB round-trip. We capture wall-clock time HERE (not in the DB
    // callback) so the reference timestamp is accurate to the snapshot.
    this.lastCpItemId = snap.current.id;
    this.lastCpPositionMs = positionMs;
    this.lastCpWallMs = now;
    await checkpointRepo
      .save({
        channelId: this.channelId,
        itemId: snap.current.id,
        positionMs,
        sourceHealth: this.failover.active ? "failed" : "ok",
      })
      .catch((err) => logger.warn({ err }, "[broadcast-v2] checkpoint write failed"));
  }

  // ── Read accessors ────────────────────────────────────────────────────

  getSequence(): number {
    return this.sequence;
  }

  /** Number of in-memory queue items currently driving the broadcast cycle. */
  getItemCount(): number {
    return this.items.length;
  }

  /**
   * Returns the current in-memory queue item IDs in their scheduled order.
   * Used by the play-now endpoint to build the new ordered list without
   * an extra DB round-trip — the items array is always in sync after reload.
   */
  getItems(): { id: string; localVideoUrl: string | null; hlsMasterUrl: string | null }[] {
    return this.items.map((i) => ({
      id: i.id,
      localVideoUrl: i.source.kind === "mp4" || i.source.kind === "youtube" ? i.source.url : null, // youtube watch URLs stored here
      hlsMasterUrl: i.source.kind === "hls" || i.source.kind === "dash" ? i.source.url : null,
    }));
  }

  /** Reload diagnostics for /health. */
  getReloadStats(): {
    lastReloadAtMs: number | null;
    lastReloadOk: boolean;
    lastReloadError: string | null;
    attempts: number;
    successes: number;
  } {
    return {
      lastReloadAtMs: this.lastReloadAtMs,
      lastReloadOk: this.lastReloadOk,
      lastReloadError: this.lastReloadError,
      attempts: this.reloadAttempts,
      successes: this.reloadSuccesses,
    };
  }

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
  } {
    const DRIFT_ALERT_THRESHOLD_MS = 30_000;
    const STALE_CP_TTL_MS = 120_000;
    const now = Date.now();
    const snap = this.snapshot();
    const currentId = snap.current?.id ?? null;
    const currentPositionMs = snap.current
      ? Math.max(0, now - snap.current.startsAtMs)
      : null;

    let driftMs: number | null = null;
    if (
      this.mode !== "override" &&
      currentId !== null &&
      currentPositionMs !== null &&
      this.lastCpItemId !== null &&
      this.lastCpItemId === currentId &&
      this.lastCpWallMs !== null &&
      this.lastCpPositionMs !== null &&
      now - this.lastCpWallMs < STALE_CP_TTL_MS
    ) {
      // Where the checkpoint projection says we should be right now:
      const expectedPositionMs = this.lastCpPositionMs + (now - this.lastCpWallMs);
      driftMs = currentPositionMs - expectedPositionMs;
    }

    return {
      cycleStartedAtMs: this.cycleStartedAtMs,
      cycleDurationMs: this.cycleDurationMs,
      currentItemId: currentId,
      currentItemPositionMs: currentPositionMs,
      lastCpItemId: this.lastCpItemId,
      lastCpPositionMs: this.lastCpPositionMs,
      lastCpWallMs: this.lastCpWallMs,
      driftMs,
      driftAlerted: driftMs !== null && Math.abs(driftMs) > DRIFT_ALERT_THRESHOLD_MS,
      driftThresholdMs: DRIFT_ALERT_THRESHOLD_MS,
    };
  }

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
  } {
    const blocked = this.allBlockedSinceMs !== null;
    return {
      allSourcesBlocked: blocked,
      allBlockedSinceMs: this.allBlockedSinceMs,
      allBlockedDurationMs: blocked ? Date.now() - this.allBlockedSinceMs! : null,
    };
  }

  /**
   * Wall-clock timestamp (ms) of the moment `start()` last transitioned the
   * orchestrator from stopped → started.  Returns 0 before the first
   * successful boot.  Used by /readyz to decide whether enough time has
   * passed since boot to call a still-at-sequence-0 orchestrator "stuck"
   * rather than just "still booting".
   */
  getStartedAtMs(): number {
    return this.startedAtWallMs;
  }

  isStarted(): boolean {
    return this.started;
  }
}

export const broadcastOrchestrator = new BroadcastOrchestrator();
