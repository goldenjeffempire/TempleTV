import express, { Router } from "express";
import { recordPlaybackTelemetry, recordRecoverEvent } from "../lib/streamHealth";
import {
  db,
  broadcastQueueTable,
  liveOverridesTable,
  playlistVideosTable,
  prayerRequestsTable,
  scheduleTable,
  videosTable,
} from "@workspace/db";
import { eq, asc, and, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { cache } from "../lib/cache";
import { BROADCAST_QUEUE_LOCK_KEY } from "../lib/broadcastQueueLock";
import {
  addSSEClient,
  broadcastLiveEvent,
  removeSSEClient,
  SSECapacityError,
} from "../lib/liveEvents";
import { validateStreamKey } from "../lib/liveIngestHealth";
import { logger } from "../lib/logger";
import { getClientIp } from "../middlewares/security";
import { getLiveStatus } from "./youtube";
import { recordBroadcastBuildLatency, type BroadcastBuildPath } from "../lib/broadcastLatency";

const router = Router();

type BroadcastItem = typeof broadcastQueueTable.$inferSelect;
type ScheduleEntry = typeof scheduleTable.$inferSelect;

type BroadcastCurrentPayload = {
  item: BroadcastItem | null;
  nextItem: BroadcastItem | null;
  /**
   * The next few items in the broadcast rotation after `item`, in air order.
   * Used by viewer-facing "Up Next" surfaces so the player feels like a TV
   * channel rather than an isolated video page. Capped at 3 distinct items
   * and wraps around the queue; never repeats the currently-airing item.
   * Empty when the queue has fewer than 2 playable items.
   */
  upcomingItems: BroadcastItem[];
  index: number;
  positionSecs: number;
  totalSecs: number;
  queueLength: number;
  progressPercent: number;
  syncedAt: string;
  serverTimeMs: number;
  failoverReason: string | null;
  /**
   * Unix epoch (ms) when the current item is expected to end and the next
   * one begins. Clients can set a precision timer to `currentItemEndsAtMs`
   * and self-tune without relying on polling or waiting for the next SSE.
   */
  currentItemEndsAtMs?: number;
  /**
   * Unix epoch (seconds) when the current item's playback started.
   * Allows clients to recalculate `positionSecs` from `Date.now()` without
   * a round-trip: `positionSecs = floor(Date.now()/1000) - itemStartEpochSecs`.
   */
  itemStartEpochSecs?: number;
  activeSchedule: {
    id: string;
    title: string;
    contentType: string;
    contentId: string | null;
    startTime: string;
    endTime: string | null;
  } | null;
  liveOverride: {
    id: string;
    title: string;
    startedAt: string;
    endsAt: string | null;
    remainingSecs?: number | null;
    /** Direct HLS source if the admin chose one. */
    hlsStreamUrl?: string | null;
    /**
     * 11-character YouTube video ID when the admin pasted a YouTube live URL
     * into Live Control. Players prefer this over `hlsStreamUrl` if both are
     * set — YouTube live is the simplest path and needs zero extra ingest.
     */
    youtubeVideoId?: string | null;
  } | null;
  /**
   * YouTube channel auto-detect signal. Surfaces the same `cachedLiveStatus`
   * the YouTube poller maintains so every viewer surface (TV Hero, TV Player,
   * mobile Hero, mobile Player) resolves the active live videoId from a
   * SINGLE SSE-pushed payload. Resolution priority everywhere is:
   *   1. liveOverride.youtubeVideoId (admin-pinned)  ← always wins
   *   2. ytVideoId (channel went live organically)
   *   3. queue item                                   ← player-only fallback
   * Without these fields, the Hero (which used to consult a separate poll)
   * could disagree with the Player (which only saw `liveOverride` + queue),
   * causing the cinematic CTA to advertise one stream while the player
   * pivoted to another.
   */
  ytLive: boolean;
  ytVideoId: string | null;
  ytTitle: string | null;
};

const CACHE_KEYS = {
  liveOverride: "broadcast:live_override",
  scheduleEntries: "broadcast:schedule_entries",
  broadcastQueue: "broadcast:queue",
} as const;

const BROADCAST_PAYLOAD_CACHE_KEY = "broadcast:current_payload";
const BROADCAST_PAYLOAD_TTL_MS = 5_000;

// ---------------------------------------------------------------------------
// Broadcast anchor — TV-station scheduling continuity
// ---------------------------------------------------------------------------
//
// Real television stations do NOT re-shuffle their lineup just because a new
// program was added to tomorrow's queue. Whatever is currently on-air keeps
// playing to the end, then the lineup advances in order.
//
// The naïve `epochSecs % totalSecs` formula does not give us that guarantee:
// the moment a new item is appended, `totalSecs` changes, the modulus moves,
// and the live edge can teleport into the middle of a different program. To
// the viewer this is an interruption — exactly what the user reports.
//
// The anchor pins the currently-airing item by its id and the wall-clock
// epoch when it started. Subsequent rebuilds honor the anchor: as long as
// the anchored item is still in the queue and its run hasn't fully elapsed,
// playback continues uninterrupted. Newly-uploaded items wait their turn and
// air only after the queue advances past them, in queue (sortOrder) order.
//
// Persisted in the distributed cache so multiple API instances stay in
// lockstep about what's "on-air" right now.
const BROADCAST_ANCHOR_CACHE_KEY = "broadcast:current_anchor";
const BROADCAST_ANCHOR_TTL_MS = 24 * 60 * 60 * 1000; // 24h

type BroadcastAnchor = {
  itemId: string;
  startEpochSecs: number;
};

async function getBroadcastAnchor(): Promise<BroadcastAnchor | null> {
  return await cache.get<BroadcastAnchor>(BROADCAST_ANCHOR_CACHE_KEY);
}

async function setBroadcastAnchor(anchor: BroadcastAnchor | null): Promise<void> {
  if (anchor === null) {
    await cache.del(BROADCAST_ANCHOR_CACHE_KEY);
  } else {
    await cache.set(BROADCAST_ANCHOR_CACHE_KEY, anchor, BROADCAST_ANCHOR_TTL_MS);
  }
}

type LiveOverrideRow = typeof liveOverridesTable.$inferSelect;

async function getActiveLiveOverride() {
  const overrides = await cache.getOrSet<LiveOverrideRow[]>(
    CACHE_KEYS.liveOverride,
    () =>
      db
        .select()
        .from(liveOverridesTable)
        .where(eq(liveOverridesTable.isActive, true))
        .orderBy(asc(liveOverridesTable.startedAt)),
    5_000,
  );
  const now = new Date();
  return overrides.find((override) => !override.endsAt || new Date(override.endsAt) > now) ?? null;
}

async function getScheduleEntries() {
  return cache.getOrSet(
    CACHE_KEYS.scheduleEntries,
    () => db.select().from(scheduleTable).where(eq(scheduleTable.isActive, true)),
    30_000,
  );
}

async function getBroadcastQueue(): Promise<BroadcastItem[]> {
  return cache.getOrSet<BroadcastItem[]>(
    CACHE_KEYS.broadcastQueue,
    () =>
      db
        .select()
        .from(broadcastQueueTable)
        .where(eq(broadcastQueueTable.isActive, true))
        .orderBy(asc(broadcastQueueTable.sortOrder)),
    10_000,
  );
}

async function invalidateBroadcastCache() {
  await Promise.all([
    cache.del(CACHE_KEYS.liveOverride),
    cache.del(CACHE_KEYS.scheduleEntries),
    cache.del(CACHE_KEYS.broadcastQueue),
    cache.del(BROADCAST_PAYLOAD_CACHE_KEY),
  ]);
}

export async function buildBroadcastCurrentPayload(skipCache = false) {
  const nowMs = Date.now();
  const syncedAt = new Date(nowMs).toISOString();

  // Latency instrumentation. We tag the final sample as "hot" if the cached
  // branch served the request and "cold" otherwise (the cold-build path is
  // the regression vector tracked by `broadcastLatencyWatchdog`). `finish`
  // is called on every return so the buffer stays accurate even if a future
  // edit adds another return path — `let __path` defaults to "cold" and only
  // the cached branch flips it before its return.
  const __t0 = Date.now();
  let __path: BroadcastBuildPath = "cold";
  const finish = <T>(value: T): T => {
    recordBroadcastBuildLatency(Date.now() - __t0, __path);
    return value;
  };

  if (!skipCache) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cached = await cache.get<any>(BROADCAST_PAYLOAD_CACHE_KEY);
    if (cached !== null) {
      // Recalculate position dynamically so a client joining a few seconds
      // after the cache was populated still gets the correct seek position.
      const nowEpochSecs = Math.floor(nowMs / 1000);
      let livePositionSecs: number = cached.positionSecs ?? 0;
      let liveProgressPercent: number = cached.progressPercent ?? 0;
      let liveCurrentItemEndsAtMs: number | undefined = cached.currentItemEndsAtMs;

      if (cached.itemStartEpochSecs != null && cached.item?.durationSecs) {
        livePositionSecs = Math.max(
          0,
          Math.min(nowEpochSecs - cached.itemStartEpochSecs, cached.item.durationSecs),
        );
        liveProgressPercent =
          cached.item.durationSecs > 0
            ? Math.round((livePositionSecs / cached.item.durationSecs) * 100)
            : 0;
        liveCurrentItemEndsAtMs =
          (cached.itemStartEpochSecs + cached.item.durationSecs) * 1000;
      }

      // Always overlay the freshest YouTube channel auto-detect signal on
      // top of the cached payload — `getLiveStatus()` is an O(1) in-memory
      // read, and overlaying here means the channel-scrape flip propagates
      // to viewers within the broadcast cache TTL window even if no other
      // broadcast event fires (e.g. the schedule is idle and queue is
      // unchanged). Without this overlay, the Hero would see a fresh
      // ytVideoId via its own poll while the Player (which reads SSE only)
      // would still see a stale `null` until the next admin action.
      const ytStatus = getLiveStatus();
      __path = "hot";
      return finish({
        ...cached,
        positionSecs: livePositionSecs,
        progressPercent: liveProgressPercent,
        currentItemEndsAtMs: liveCurrentItemEndsAtMs,
        syncedAt,
        serverTimeMs: nowMs,
        ytLive: ytStatus.isLive,
        ytVideoId: ytStatus.videoId,
        ytTitle: ytStatus.title,
      });
    }
  }

  const [activeLiveOverride, scheduleEntries, queueItems] = await Promise.all([
    getActiveLiveOverride(),
    getScheduleEntries(),
    getBroadcastQueue(),
  ]);

  // Snapshot the YouTube channel auto-detect signal once per fresh build so
  // every result branch surfaces the same ytVideoId/ytTitle pair to viewers.
  // The cached-return branch above re-reads `getLiveStatus()` so even cache
  // hits stay fresh; this snapshot just bakes the same shape into the
  // freshly-built result.
  const ytStatus = getLiveStatus();
  const ytFields = {
    ytLive: ytStatus.isLive,
    ytVideoId: ytStatus.videoId,
    ytTitle: ytStatus.title,
  } as const;

  let result: BroadcastCurrentPayload;

  if (activeLiveOverride) {
    result = {
      item: null,
      nextItem: null,
      upcomingItems: [],
      index: 0,
      positionSecs: 0,
      totalSecs: 0,
      queueLength: 0,
      progressPercent: 0,
      syncedAt,
      serverTimeMs: nowMs,
      failoverReason: null,
      activeSchedule: null,
      liveOverride: {
        id: activeLiveOverride.id,
        title: activeLiveOverride.title,
        startedAt: activeLiveOverride.startedAt.toISOString(),
        endsAt: activeLiveOverride.endsAt?.toISOString() ?? null,
        remainingSecs: activeLiveOverride.endsAt
          ? Math.max(0, Math.floor((new Date(activeLiveOverride.endsAt).getTime() - nowMs) / 1000))
          : null,
        hlsStreamUrl: activeLiveOverride.hlsStreamUrl ?? null,
        youtubeVideoId: activeLiveOverride.youtubeVideoId ?? null,
      },
      ...ytFields,
    };
    cache.setBackground(BROADCAST_PAYLOAD_CACHE_KEY, result, BROADCAST_PAYLOAD_TTL_MS);
    return finish(result);
  }

  const activeSchedule = getActiveScheduleEntry(scheduleEntries as ScheduleEntry[]);

  if (activeSchedule?.contentType === "live") {
    // The active schedule slot expects a live YouTube broadcast. If the
    // channel is genuinely live right now, viewers should see YouTube and
    // there's nothing for the queue to provide — return early with `item:
    // null` so player surfaces resolve the videoId from `ytVideoId`.
    //
    // BUT: if YouTube isn't actually live (channel hasn't started yet, or
    // dropped mid-service), the broadcast queue is supposed to act as the
    // failover so viewers — and Mission Control — still see *something*
    // playing. Falling all the way through to `item: null` here was
    // defeating the queue's whole purpose and made the admin dashboard +
    // /broadcast page show "Queue is empty" while a perfectly healthy
    // 4-item rotation was sitting unused.
    const activeScheduleMeta = {
      id: activeSchedule.id,
      title: activeSchedule.title,
      contentType: activeSchedule.contentType,
      contentId: activeSchedule.contentId,
      startTime: activeSchedule.startTime,
      endTime: activeSchedule.endTime,
    };

    if (ytStatus.isLive || queueItems.length === 0) {
      result = {
        item: null,
        nextItem: null,
        upcomingItems: [],
        index: 0,
        positionSecs: 0,
        totalSecs: 0,
        queueLength: 0,
        progressPercent: 0,
        syncedAt,
        serverTimeMs: nowMs,
        failoverReason: ytStatus.isLive
          ? null
          : "Live schedule slot is active but the YouTube channel is not streaming and the broadcast queue has no failover items.",
        liveOverride: null,
        activeSchedule: activeScheduleMeta,
        ...ytFields,
      };
      cache.setBackground(BROADCAST_PAYLOAD_CACHE_KEY, result, BROADCAST_PAYLOAD_TTL_MS);
      return finish(result);
    }

    // Live slot + YouTube off + queue available → use the queue as failover.
    const cachedAnchor = await getBroadcastAnchor();
    const { result: calculated, newAnchor } = calculateCurrentFromItems(queueItems, cachedAnchor);
    if (newAnchor) {
      await setBroadcastAnchor(newAnchor);
    }
    result = {
      ...calculated,
      // Preserve the user-visible failover signal (a real reason from
      // calculateCurrentFromItems takes precedence — e.g. "no items have a
      // valid duration").
      failoverReason:
        calculated.failoverReason ??
        "YouTube live broadcast not detected — playing from broadcast queue.",
      syncedAt,
      serverTimeMs: nowMs,
      liveOverride: null,
      activeSchedule: activeScheduleMeta,
      ...ytFields,
    };
    cache.setBackground(BROADCAST_PAYLOAD_CACHE_KEY, result, BROADCAST_PAYLOAD_TTL_MS);
    return finish(result);
  }

  if (activeSchedule && (activeSchedule.contentType === "playlist" || activeSchedule.contentType === "video")) {
    const scheduledItems = await getScheduledItems(activeSchedule);
    if (scheduledItems.length > 0) {
      // Scheduled programming (e.g. Sunday Service playlist) is admin-curated
      // and runs on its own clock — anchor continuity does not apply here.
      const { result: calculated } = calculateCurrentFromItems(scheduledItems);
      result = {
        ...calculated,
        syncedAt,
        serverTimeMs: nowMs,
        liveOverride: null,
        activeSchedule: {
          id: activeSchedule.id,
          title: activeSchedule.title,
          contentType: activeSchedule.contentType,
          contentId: activeSchedule.contentId,
          startTime: activeSchedule.startTime,
          endTime: activeSchedule.endTime,
        },
        ...ytFields,
      };
      cache.setBackground(BROADCAST_PAYLOAD_CACHE_KEY, result, BROADCAST_PAYLOAD_TTL_MS);
      return finish(result);
    }
  }

  if (queueItems.length === 0) {
    result = {
      item: null,
      nextItem: null,
      upcomingItems: [],
      index: 0,
      positionSecs: 0,
      totalSecs: 0,
      queueLength: 0,
      progressPercent: 0,
      syncedAt,
      serverTimeMs: nowMs,
      failoverReason: "Broadcast queue is empty.",
      activeSchedule: activeSchedule
        ? {
            id: activeSchedule.id,
            title: activeSchedule.title,
            contentType: activeSchedule.contentType,
            contentId: activeSchedule.contentId,
            startTime: activeSchedule.startTime,
            endTime: activeSchedule.endTime,
          }
        : null,
      liveOverride: null,
      ...ytFields,
    };
    cache.setBackground(BROADCAST_PAYLOAD_CACHE_KEY, result, BROADCAST_PAYLOAD_TTL_MS);
    return finish(result);
  }

  // Anchor-driven queue: preserves the currently-airing item across queue
  // mutations (uploads, reorders, deletions of OTHER items). New uploads
  // append to the end and air only when the queue advances to them, exactly
  // like a real TV station's lineup.
  const priorAnchor = await getBroadcastAnchor();
  const { result: calculated, newAnchor } = calculateCurrentFromItems(
    queueItems,
    priorAnchor,
  );
  if (
    newAnchor &&
    (!priorAnchor ||
      priorAnchor.itemId !== newAnchor.itemId ||
      priorAnchor.startEpochSecs !== newAnchor.startEpochSecs)
  ) {
    await setBroadcastAnchor(newAnchor);
  }
  result = {
    ...calculated,
    syncedAt,
    serverTimeMs: nowMs,
    activeSchedule: activeSchedule
      ? {
          id: activeSchedule.id,
          title: activeSchedule.title,
          contentType: activeSchedule.contentType,
          contentId: activeSchedule.contentId,
          startTime: activeSchedule.startTime,
          endTime: activeSchedule.endTime,
        }
      : null,
    liveOverride: null,
    ...ytFields,
  };
  cache.setBackground(BROADCAST_PAYLOAD_CACHE_KEY, result, BROADCAST_PAYLOAD_TTL_MS);
  return finish(result);
}

// ---------------------------------------------------------------------------
// Transition scheduler — fires SSE precisely at item boundaries
// ---------------------------------------------------------------------------
//
// Architecture (revised 2026-04-27):
//
// The original implementation polled every 500 ms and fired the
// transition SSE whenever `Date.now() >= endsAtMs`. That made the SSE
// arrive ≤500 ms LATE (plus client RTT), which translated into a
// visible black gap on the player surfaces because their `nextItem`
// preload was promoted only after the SSE arrived.
//
// The revised model uses a precision `setTimeout` armed at the exact
// `endsAtMs` boundary, plus a 10 s pre-warm timer that emits a
// `transition-imminent` event so clients can verify their preload
// state before the actual cut. The 500 ms safety-net interval is
// retained for two reasons:
//   1. Items without a known `endsAtMs` (live override, idle queue,
//      YouTube-driven slots) still need a periodic re-evaluation.
//   2. Recovery: if a precision timer is missed (process pause,
//      timer drift on a busy event loop), the safety tick catches up
//      within 500 ms instead of leaving the broadcast frozen.
//
// All three timers (precision, imminent, safety) are idempotent —
// each transition fires exactly once per `endsAtMs` boundary thanks
// to the `_firedForEndsAtMs` / `_imminentFiredForEndsAtMs` sentinels.

/** The last payload the scheduler is tracking. */
let _lastTrackedPayload: BroadcastCurrentPayload | null = null;
/** 500 ms safety-net interval — recovers from missed precision fires. */
let _transitionTickHandle: ReturnType<typeof setInterval> | null = null;
/** Precision setTimeout armed at the exact `endsAtMs` of the current item. */
let _precisionTimer: ReturnType<typeof setTimeout> | null = null;
/** Pre-warm setTimeout armed at `endsAtMs - 10s` of the current item. */
let _imminentTimer: ReturnType<typeof setTimeout> | null = null;
/** Sentinels: the `endsAtMs` value for which we already fired each event. */
let _firedForEndsAtMs: number | null = null;
let _imminentFiredForEndsAtMs: number | null = null;

const PRE_WARM_LEAD_MS = 10_000;
/**
 * Cap on how far in the future a precision timer can be armed. Items
 * longer than this (rare — most queue items are 5–60 min) get rearmed
 * on the next safety tick rather than holding a long-lived timer.
 */
const PRECISION_TIMER_MAX_MS = 5 * 60_000;

function _clearPrecisionTimers(): void {
  if (_precisionTimer) {
    clearTimeout(_precisionTimer);
    _precisionTimer = null;
  }
  if (_imminentTimer) {
    clearTimeout(_imminentTimer);
    _imminentTimer = null;
  }
}

function _armPrecisionTimers(): void {
  _clearPrecisionTimers();
  const endsAtMs = _lastTrackedPayload?.currentItemEndsAtMs;
  if (!endsAtMs) return;

  const now = Date.now();

  // ── Pre-warm timer (T-10s) ───────────────────────────────────────────
  if (_imminentFiredForEndsAtMs !== endsAtMs) {
    const imminentDelay = endsAtMs - PRE_WARM_LEAD_MS - now;
    if (imminentDelay > 0 && imminentDelay <= PRECISION_TIMER_MAX_MS) {
      _imminentTimer = setTimeout(() => {
        _imminentTimer = null;
        _fireImminent(endsAtMs).catch((err) => {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "Broadcast transition-imminent fire failed",
          );
        });
      }, imminentDelay);
      _imminentTimer.unref?.();
    }
  }

  // ── Precision transition timer (T-0) ─────────────────────────────────
  if (_firedForEndsAtMs !== endsAtMs) {
    const fireDelay = Math.max(0, endsAtMs - now);
    if (fireDelay <= PRECISION_TIMER_MAX_MS) {
      _precisionTimer = setTimeout(() => {
        _precisionTimer = null;
        _fireTransition().catch((err) => {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "Broadcast precision transition fire failed",
          );
        });
      }, fireDelay);
      _precisionTimer.unref?.();
    }
  }
}

function _setLastTrackedPayload(p: BroadcastCurrentPayload | null): void {
  _lastTrackedPayload = p;
  _armPrecisionTimers();
}

async function _fireImminent(endsAtMs: number): Promise<void> {
  // Dedupe: this exact endsAtMs already had its imminent event fired.
  if (_imminentFiredForEndsAtMs === endsAtMs) return;
  // The current payload may have already advanced (manual skip,
  // override) — only fire if we're still tracking the same boundary.
  if (_lastTrackedPayload?.currentItemEndsAtMs !== endsAtMs) return;
  _imminentFiredForEndsAtMs = endsAtMs;
  // Re-emit the EXISTING tracked payload with a different `reason`. The
  // payload shape is unchanged, so older clients that don't switch on
  // `reason` simply re-apply the same metadata harmlessly. New clients
  // (TV proactive-swap path, mobile preload verifier) use this signal
  // to confirm their `nextItem` preload is warm and rearm if not.
  broadcastLiveEvent("broadcast-current-updated", {
    reason: "transition-imminent",
    current: _lastTrackedPayload,
    etaMs: PRE_WARM_LEAD_MS,
  });
}

async function _fireTransition(): Promise<void> {
  const endsAtMs = _lastTrackedPayload?.currentItemEndsAtMs;
  // Dedupe — both the precision timer and the safety interval can race
  // on a hot transition; only the first wins.
  if (endsAtMs && _firedForEndsAtMs === endsAtMs) return;
  if (endsAtMs) _firedForEndsAtMs = endsAtMs;

  await invalidateBroadcastCache();
  const fresh = await buildBroadcastCurrentPayload(true);
  // Update tracked payload + rearm timers for the NEW item in one step.
  _setLastTrackedPayload(fresh);
  broadcastLiveEvent("broadcast-current-updated", {
    reason: "item-transition",
    current: fresh,
  });
}

async function _tickTransitions(): Promise<void> {
  try {
    if (!_lastTrackedPayload) {
      // Cold start — fetch and arm. Subsequent ticks become no-ops.
      const initial = await buildBroadcastCurrentPayload();
      _setLastTrackedPayload(initial);
      return;
    }

    const endsAtMs = _lastTrackedPayload.currentItemEndsAtMs;

    // No known boundary (live override, YouTube live, idle queue) —
    // periodically rebuild so we pick up newly-scheduled items.
    if (!endsAtMs) return;

    // Already past the boundary AND precision timer didn't fire (timer
    // drift, process pause). Fall back to immediate fire.
    if (Date.now() >= endsAtMs && _firedForEndsAtMs !== endsAtMs) {
      await _fireTransition();
      return;
    }

    // Boundary in the future but no precision timer armed — usually means
    // a long-form item exceeded PRECISION_TIMER_MAX_MS at the time of
    // arming. Try to rearm now that we're closer.
    if (!_precisionTimer && Date.now() < endsAtMs) {
      _armPrecisionTimers();
    }
  } catch (err) {
    // Never crash the ticker — but DO log. A persistently-failing tick
    // (DB outage, schema drift, payload-build bug) was previously
    // invisible because this catch swallowed everything. With a structured
    // warn, it surfaces in logs / Sentry / Mission Control without ever
    // letting the error bubble out and kill the interval.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Broadcast transition tick failed — schedule transitions may be delayed",
    );
  }
}

export function startBroadcastTransitionTicker(): void {
  if (_transitionTickHandle) return;
  // Kick off an immediate initial read so the scheduler arms its
  // precision timers as early as possible.
  buildBroadcastCurrentPayload()
    .then((p) => { _setLastTrackedPayload(p); })
    .catch(() => {});
  // 500 ms safety-net interval. The precision setTimeout in
  // `_armPrecisionTimers` does the actual transition firing; this
  // interval only catches edge cases (unknown endsAtMs, items longer
  // than PRECISION_TIMER_MAX_MS, missed timers due to event-loop
  // pauses) so the broadcast can never freeze indefinitely.
  _transitionTickHandle = setInterval(_tickTransitions, 500);
  _transitionTickHandle.unref();
}

/**
 * Read the most recently rebuilt broadcast payload without touching the DB or
 * cache. Used by the per-second stream-health emitter so it can read current
 * on-air metadata in O(1) without I/O on the hot path.
 */
export function getLastTrackedBroadcastPayload(): BroadcastCurrentPayload | null {
  return _lastTrackedPayload;
}

export function emitBroadcastState(reason: string, detail: Record<string, unknown> = {}) {
  buildBroadcastCurrentPayload()
    .then((current) => {
      // _setLastTrackedPayload also rearms the precision timers so a
      // manual skip / override / queue mutation immediately picks up
      // the new boundary and pre-warms toward the new next item.
      _setLastTrackedPayload(current);
      broadcastLiveEvent("broadcast-current-updated", { reason, current, ...detail });
    })
    .catch(() => {});
}

function parseTimeToMinutes(value: string | null): number | null {
  if (!value) return null;
  const [h, m] = value.split(":").map((part) => Number(part));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return Math.max(0, Math.min(1439, h * 60 + m));
}

function getActiveScheduleEntry(entries: ScheduleEntry[], now = new Date()): ScheduleEntry | null {
  const day = now.getDay();
  const previousDay = (day + 6) % 7;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const activeEntries = entries.filter((entry) => {
    const start = parseTimeToMinutes(entry.startTime);
    if (start === null) return false;
    const end = parseTimeToMinutes(entry.endTime);

    if (end === null || end === start) {
      return entry.dayOfWeek === day && currentMinutes >= start;
    }

    if (end > start) {
      return entry.dayOfWeek === day && currentMinutes >= start && currentMinutes < end;
    }

    return (
      (entry.dayOfWeek === day && currentMinutes >= start) ||
      (entry.dayOfWeek === previousDay && currentMinutes < end)
    );
  });

  activeEntries.sort((a, b) => b.startTime.localeCompare(a.startTime));
  return activeEntries[0] ?? null;
}

function parseDurationSecs(value: string | null | undefined): number {
  if (!value) return 1800;
  if (!value.includes(":") && !value.match(/[a-z]/i)) {
    const plain = Number(value);
    if (Number.isFinite(plain) && plain > 0) return Math.max(60, Math.round(plain));
  }
  const parts = value.split(":").map((part) => Number(part));
  if (parts.every((part) => Number.isFinite(part))) {
    if (parts.length === 3) return Math.max(60, parts[0]! * 3600 + parts[1]! * 60 + parts[2]!);
    if (parts.length === 2) return Math.max(60, parts[0]! * 60 + parts[1]!);
  }
  const minutesMatch = value.match(/(\d+)\s*m/i);
  if (minutesMatch?.[1]) return Math.max(60, Number(minutesMatch[1]) * 60);
  return 1800;
}

type CalculateCurrentResult = {
  item: BroadcastItem | null;
  nextItem: BroadcastItem | null;
  upcomingItems: BroadcastItem[];
  index: number;
  positionSecs: number;
  totalSecs: number;
  queueLength: number;
  progressPercent: number;
  failoverReason: string | null;
  itemStartEpochSecs?: number;
  currentItemEndsAtMs?: number;
};

/**
 * Build the "Up Next" preview list — the next N distinct items after the
 * current one in the rotation. Wraps around the queue but never repeats the
 * currently-airing item, and never returns more items than the queue has
 * (so a 2-item queue produces exactly one upcoming item).
 */
function buildUpcomingItems(
  items: BroadcastItem[],
  currentIdx: number,
  count: number = 3,
): BroadcastItem[] {
  if (items.length <= 1) return [];
  const max = Math.min(count, items.length - 1);
  const out: BroadcastItem[] = [];
  for (let i = 1; i <= max; i++) {
    const it = items[(currentIdx + i) % items.length];
    if (it) out.push(it);
  }
  return out;
}

/**
 * Compute the live edge of the broadcast queue.
 *
 * Two strategies, in order:
 *  1. **Anchor-driven (preferred when a fresh anchor exists).**
 *     Honors the currently-airing item: as long as the anchored item is
 *     still in the queue and its run hasn't fully elapsed, we keep playing
 *     it from the anchor's `startEpochSecs`. When its run ends we walk
 *     forward through the queue in `sortOrder` until we land on the item
 *     that should be on-air right now. This is what makes mid-broadcast
 *     uploads append-only — they never interrupt the current program.
 *  2. **Epoch-modulo fallback (cold start, anchor lost, or anchor's item
 *     was removed from the queue).**
 *     `epochSecs % totalSecs` finds the live edge as if the entire queue
 *     had been looping forever. Suitable for the very first calculation
 *     after a deploy or cache flush, but otherwise undesirable because
 *     queue mutations shift the result.
 *
 * Returns the calculated state and the anchor it should be persisted as
 * — the caller writes it back to the distributed cache.
 */
function calculateCurrentFromItems(
  items: BroadcastItem[],
  anchor: BroadcastAnchor | null = null,
): { result: CalculateCurrentResult; newAnchor: BroadcastAnchor | null } {
  const playableItems = items.filter((item) => item.durationSecs > 0);
  if (playableItems.length === 0) {
    return {
      result: {
        item: null,
        nextItem: null,
        upcomingItems: [],
        index: 0,
        positionSecs: 0,
        totalSecs: 0,
        queueLength: 0,
        progressPercent: 0,
        failoverReason: "No active broadcast items have a valid duration.",
      },
      newAnchor: null,
    };
  }

  const totalSecs = playableItems.reduce((acc, i) => acc + i.durationSecs, 0);
  const epochSecs = Math.floor(Date.now() / 1000);

  // ── 1. Anchor-driven path ────────────────────────────────────────────
  if (anchor) {
    const anchorIdx = playableItems.findIndex((it) => it.id === anchor.itemId);
    if (anchorIdx !== -1) {
      const anchorEnd =
        anchor.startEpochSecs + playableItems[anchorIdx]!.durationSecs;

      // If the anchor is way in the past (more than a full lap behind the
      // current epoch), bail out to modulo — walking forward would loop the
      // queue many times and is a sign the server was down for an extended
      // period. Modulo gives the user the right "live now" edge instantly.
      if (epochSecs < anchorEnd + totalSecs) {
        let cursorIdx = anchorIdx;
        let cursorStart = anchor.startEpochSecs;

        // Walk forward through the queue advancing past items whose run has
        // fully elapsed. Bounded at 2 full laps for safety — we already
        // bailed to modulo if we were further behind than that.
        const maxSteps = playableItems.length * 2 + 1;
        for (let step = 0; step < maxSteps; step++) {
          const cursorItem = playableItems[cursorIdx]!;
          const cursorEnd = cursorStart + cursorItem.durationSecs;

          if (epochSecs < cursorEnd) {
            const positionSecs = Math.max(0, epochSecs - cursorStart);
            const nextItem =
              playableItems[(cursorIdx + 1) % playableItems.length] ?? null;
            const upcomingItems = buildUpcomingItems(playableItems, cursorIdx);
            return {
              result: {
                item: cursorItem,
                nextItem,
                upcomingItems,
                index: cursorIdx,
                positionSecs,
                totalSecs,
                queueLength: playableItems.length,
                progressPercent:
                  cursorItem.durationSecs > 0
                    ? Math.round((positionSecs / cursorItem.durationSecs) * 100)
                    : 0,
                failoverReason: null,
                itemStartEpochSecs: cursorStart,
                currentItemEndsAtMs: cursorEnd * 1000,
              },
              newAnchor: { itemId: cursorItem.id, startEpochSecs: cursorStart },
            };
          }

          // This item has fully elapsed — advance to the next item in queue
          // (sortOrder) order. The next item starts exactly when this one ended,
          // so the broadcast clock stays continuous and frame-accurate.
          cursorStart = cursorEnd;
          cursorIdx = (cursorIdx + 1) % playableItems.length;
        }
      }
      // else: anchor too stale → fall through to modulo
    }
    // else: anchored item was removed from queue → fall through to modulo
  }

  // ── 2. Epoch-modulo fallback ─────────────────────────────────────────
  const position = totalSecs > 0 ? epochSecs % totalSecs : 0;

  let cumulative = 0;
  let currentItem = playableItems[0]!;
  let positionSecs = 0;
  let index = 0;

  for (let i = 0; i < playableItems.length; i++) {
    const item = playableItems[i]!;
    if (position < cumulative + item.durationSecs) {
      currentItem = item;
      positionSecs = position - cumulative;
      index = i;
      break;
    }
    cumulative += item.durationSecs;
  }

  const nextItem = playableItems[(index + 1) % playableItems.length] ?? null;
  const upcomingItems = buildUpcomingItems(playableItems, index);
  const itemStartEpochSecs = epochSecs - positionSecs;
  const currentItemEndsAtMs = (itemStartEpochSecs + currentItem.durationSecs) * 1000;
  return {
    result: {
      item: currentItem,
      nextItem,
      upcomingItems,
      index,
      positionSecs,
      totalSecs,
      queueLength: playableItems.length,
      progressPercent:
        currentItem.durationSecs > 0
          ? Math.round((positionSecs / currentItem.durationSecs) * 100)
          : 0,
      failoverReason: null,
      itemStartEpochSecs,
      currentItemEndsAtMs,
    },
    newAnchor: { itemId: currentItem.id, startEpochSecs: itemStartEpochSecs },
  };
}

async function getScheduledItems(entry: ScheduleEntry): Promise<BroadcastItem[]> {
  if (!entry.contentId) return [];

  if (entry.contentType === "video") {
    const [video] = await db.select().from(videosTable).where(eq(videosTable.id, entry.contentId)).limit(1);
    if (!video) return [];
    return [{
      id: `schedule-${entry.id}-${video.id}`,
      videoId: video.id,
      youtubeId: video.youtubeId,
      title: video.title,
      thumbnailUrl: video.thumbnailUrl,
      durationSecs: parseDurationSecs(video.duration),
      localVideoUrl: video.localVideoUrl,
      videoSource: video.videoSource,
      isActive: true,
      sortOrder: 0,
      addedAt: new Date(),
    }];
  }

  if (entry.contentType === "playlist") {
    const videos = await db
      .select()
      .from(playlistVideosTable)
      .where(eq(playlistVideosTable.playlistId, entry.contentId))
      .orderBy(asc(playlistVideosTable.sortOrder));

    return videos.map((video: typeof playlistVideosTable.$inferSelect, index: number) => ({
      id: `schedule-${entry.id}-${video.id}`,
      videoId: video.videoId,
      youtubeId: video.youtubeId ?? "",
      title: video.title,
      thumbnailUrl: video.thumbnailUrl,
      durationSecs: parseDurationSecs(video.duration),
      localVideoUrl: (video as Record<string, unknown>).localVideoUrl as string | null ?? null,
      videoSource: (video as Record<string, unknown>).videoSource as string ?? "youtube",
      isActive: true,
      sortOrder: index,
      addedAt: video.addedAt,
    }));
  }

  return [];
}

router.get("/broadcast/guide", async (_req, res) => {
  try {
    const activeLiveOverride = await getActiveLiveOverride();
    if (activeLiveOverride) {
      return void res.json({ items: [], liveOverride: { title: activeLiveOverride.title } });
    }

    const activeScheduleEntries = await getScheduleEntries();
    const activeSchedule = getActiveScheduleEntry(activeScheduleEntries as ScheduleEntry[]);
    const items = activeSchedule && activeSchedule.contentType !== "live"
      ? await getScheduledItems(activeSchedule)
      : await getBroadcastQueue();

    const playableItems = items.filter((item: BroadcastItem) => item.durationSecs > 0);
    if (playableItems.length === 0) return void res.json({ items: [] });

    const totalSecs = playableItems.reduce((acc: number, i: BroadcastItem) => acc + i.durationSecs, 0);
    const epochSecs = Math.floor(Date.now() / 1000);
    const cyclePos = epochSecs % totalSecs;

    let cumulative = 0;
    let currentIdx = 0;
    let positionInCurrent = 0;
    for (let i = 0; i < playableItems.length; i++) {
      const item = playableItems[i]!;
      if (cyclePos < cumulative + item.durationSecs) {
        currentIdx = i;
        positionInCurrent = cyclePos - cumulative;
        break;
      }
      cumulative += item.durationSecs;
    }

    const guideItems: Array<{
      id: string; youtubeId: string; title: string; thumbnailUrl: string;
      durationSecs: number; localVideoUrl: string | null; videoSource: string;
      startMs: number; endMs: number; isCurrent: boolean;
      positionSecs: number; progressPercent: number;
    }> = [];
    const nowMs = Date.now();
    let wallClockStartMs = nowMs - positionInCurrent * 1000;
    const limit = Math.min(24, playableItems.length * 3);

    for (let i = 0; i < limit; i++) {
      const idx = (currentIdx + i) % playableItems.length;
      const item = playableItems[idx]!;
      const isCurrent = i === 0;
      guideItems.push({
        id: item.id,
        youtubeId: item.youtubeId,
        title: item.title,
        thumbnailUrl: item.thumbnailUrl,
        durationSecs: item.durationSecs,
        localVideoUrl: item.localVideoUrl ?? null,
        videoSource: item.videoSource ?? "youtube",
        startMs: wallClockStartMs,
        endMs: wallClockStartMs + item.durationSecs * 1000,
        isCurrent,
        positionSecs: isCurrent ? positionInCurrent : 0,
        progressPercent: isCurrent && item.durationSecs > 0 ? Math.round((positionInCurrent / item.durationSecs) * 100) : 0,
      });
      wallClockStartMs += item.durationSecs * 1000;
      if (wallClockStartMs > nowMs + 24 * 3600 * 1000) break;
    }

    res.json({ items: guideItems });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/broadcast/current", async (_req, res) => {
  try {
    // Live broadcast state — must stay fresh, but a tiny shared-cache window
    // with stale-while-revalidate dramatically smooths the cold-rebuild path
    // (observed at 994ms once on a freshly-booted Render instance) without
    // ever serving stale state for more than a few seconds. The hot path
    // through `buildBroadcastCurrentPayload` is < 5ms because it reads from
    // the in-memory + PG distributed cache; the SWR header lets a CDN /
    // Render edge / shared cache absorb fan-out bursts after a deploy.
    //
    // Browsers are intentionally NOT given a private cache (max-age=0,
    // s-maxage=2 only) — only shared caches benefit. This avoids the
    // "I'm 30s behind everyone else" desync that this endpoint exists to
    // prevent on the per-viewer hot path; SSE remains the source of truth
    // for live updates.
    res
      .setHeader(
        "Cache-Control",
        "public, max-age=0, s-maxage=2, stale-while-revalidate=10",
      )
      .json(await buildBroadcastCurrentPayload());
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/broadcast/events", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Disable Nagle buffering so each SSE frame is sent immediately
  req.socket?.setNoDelay(true);

  res.flushHeaders();

  const flushRes = () => {
    const r = res as unknown as { flush?: () => void };
    if (typeof r.flush === "function") r.flush();
  };

  // Tell clients to retry connection after a JITTERED interval on disconnect.
  // A fixed 5s value across all clients caused a thundering herd on every
  // process restart: thousands of TVs/mobiles/admins reconnecting at the same
  // 5s mark could blow past MAX_SSE_CLIENTS_GLOBAL and surface as a wave of
  // 503s to legitimate users. Per-connection jitter (3–8s) spreads the
  // reconnect wave across a 5-second window, smoothing the load curve.
  const retryMs = 3000 + Math.floor(Math.random() * 5000);
  res.write(`retry: ${retryMs}\n\n`);
  flushRes();

  let client;
  try {
    client = addSSEClient(res, req.query.platform, getClientIp(req));
  } catch (e) {
    if (e instanceof SSECapacityError) {
      res.setHeader("Retry-After", String(e.retryAfterSecs));
      try { res.end(); } catch {}
      return;
    }
    throw e;
  }

  try {
    const current = await buildBroadcastCurrentPayload();
    res.write(`event: broadcast-current-updated\ndata: ${JSON.stringify({ reason: "connected", current })}\n\n`);
    flushRes();
  } catch (err) {
    logger.error({ err }, "[SSE /broadcast/events] initial write failed");
  }

  req.on("close", () => removeSSEClient(client));
});

// Tiny endpoint for player clients to report decoded/dropped frame deltas from
// HTMLVideoElement.getVideoPlaybackQuality(). Players are expected to POST a
// running delta every ~5 s. This feeds the dropped-frame field on the
// stream-health SSE channel — the only metric we genuinely cannot measure on
// the server.
//
// 2026-04-27: same endpoint also accepts a discriminated `event: "recover"`
// payload (no decoded/dropped fields) marking that a viewer's player took
// the `recoverBroadcastPlayback()` path. Single endpoint = single CORS rule,
// single CDN cache exclusion, single rate-limit envelope. The discriminator
// is checked first so legacy frame-quality clients (which never set `event`)
// continue to work unmodified — backward compat is the entire point.
router.post("/broadcast/playback-telemetry", express.json({ limit: "1kb" }), (req, res) => {
  const body = (req.body ?? {}) as {
    platform?: unknown;
    event?: unknown;
    decoded?: unknown;
    dropped?: unknown;
  };
  if (body.event === "recover") {
    recordRecoverEvent(body.platform);
    res.status(204).end();
    return;
  }
  const decoded = Number(body.decoded);
  const dropped = Number(body.dropped);
  recordPlaybackTelemetry(body.platform, decoded, dropped);
  res.status(204).end();
});

// Lightweight metadata endpoint for radio clients — returns only the current
// track title, preacher, thumbnail, and timing info. Cheaper than /broadcast/current
// because it returns a subset of the payload. Ideal for frequent polling.
router.get("/broadcast/metadata", async (_req, res) => {
  try {
    const payload = await buildBroadcastCurrentPayload();
    const item = payload.item;
    res
      .setHeader("Cache-Control", "public, max-age=4, s-maxage=4")
      .json({
        title: payload.liveOverride?.title ?? item?.title ?? null,
        thumbnailUrl: item?.thumbnailUrl ?? null,
        videoSource: item?.videoSource ?? null,
        positionSecs: payload.positionSecs,
        durationSecs: item?.durationSecs ?? 0,
        progressPercent: payload.progressPercent,
        queueLength: payload.queueLength,
        isLive: !!payload.liveOverride,
        syncedAt: payload.syncedAt,
        serverTimeMs: payload.serverTimeMs,
      });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/admin/broadcast", async (_req, res) => {
  try {
    const items = await db
      .select()
      .from(broadcastQueueTable)
      .orderBy(asc(broadcastQueueTable.sortOrder));
    res.json(items);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

// ── Queue source-health probe ─────────────────────────────────────────────────
// Operational diagnostic for the queue page. Walks every queue item and issues
// a HEAD request against its source URL with a short timeout, so producers can
// see at a glance which queue items point at dead assets. The most common
// reason an item goes dead in practice: a legacy `/api/uploads/<uuid>.mp4` URL
// whose disk file is gone (Render's filesystem is ephemeral and was never
// mirrored to S3 for that upload). Reading the playback channel is enough to
// surface this — the broken-item skip will roll past it at airtime — but
// surfacing the dead URLs proactively lets the producer clean the queue
// before viewers ever see a transition gap.
//
// We deliberately use a HEAD (not GET) and a tight 5s budget per item, all in
// parallel, so the whole queue completes in roughly one round-trip even with
// dozens of items. Items with no source URL (YouTube items use youtubeId
// only) are reported as "skipped" rather than "broken" so they don't pollute
// the bad-item count.
router.get("/admin/broadcast/health", async (_req, res) => {
  try {
    const items = await db
      .select()
      .from(broadcastQueueTable)
      .orderBy(asc(broadcastQueueTable.sortOrder));

    type HealthStatus = "ok" | "broken" | "skipped";
    interface HealthResult {
      id: string;
      title: string;
      url: string | null;
      videoSource: string | null;
      status: HealthStatus;
      httpStatus?: number;
      error?: string;
      checkedMs: number;
    }

    const TIMEOUT_MS = 5000;
    async function probe(item: BroadcastItem): Promise<HealthResult> {
      const url = item.localVideoUrl ?? null;
      // YouTube-only items (no localVideoUrl) aren't ours to verify; skip.
      if (!url) {
        return {
          id: item.id,
          title: item.title,
          url: null,
          videoSource: item.videoSource ?? null,
          status: "skipped",
          checkedMs: 0,
        };
      }
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const startedAt = Date.now();
      try {
        // HEAD with redirect:"follow" so the /api/uploads → S3 redirect path
        // is honoured exactly as the player would experience it. The server
        // returns 200 on a present file (disk or S3) and 404 on a dead one.
        const r = await fetch(url, {
          method: "HEAD",
          redirect: "follow",
          signal: ctrl.signal,
        });
        clearTimeout(t);
        return {
          id: item.id,
          title: item.title,
          url,
          videoSource: item.videoSource ?? null,
          status: r.ok ? "ok" : "broken",
          httpStatus: r.status,
          checkedMs: Date.now() - startedAt,
        };
      } catch (err) {
        clearTimeout(t);
        return {
          id: item.id,
          title: item.title,
          url,
          videoSource: item.videoSource ?? null,
          status: "broken",
          error: err instanceof Error ? err.message : String(err),
          checkedMs: Date.now() - startedAt,
        };
      }
    }

    const results = await Promise.all(items.map(probe));
    type ProbeResult = (typeof results)[number];
    const summary = {
      total: results.length,
      ok: results.filter((r: ProbeResult) => r.status === "ok").length,
      broken: results.filter((r: ProbeResult) => r.status === "broken").length,
      skipped: results.filter((r: ProbeResult) => r.status === "skipped").length,
      checkedAt: new Date().toISOString(),
    };
    res.json({ summary, items: results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/broadcast", async (req, res) => {
  const body = req.body as {
    videoId?: string;
    youtubeId?: string;
    title?: string;
    thumbnailUrl?: string;
    durationSecs?: number;
    localVideoUrl?: string;
    videoSource?: string;
  };

  let { videoId, youtubeId, title, thumbnailUrl, localVideoUrl, videoSource } = body;
  let resolvedDurationSecs = body.durationSecs ?? 0;

  // When videoId is provided, look up the video from the DB and fill in any
  // missing fields. This allows callers to add a video to the queue by ID only.
  if (videoId) {
    const [video] = await db.select().from(videosTable).where(eq(videosTable.id, videoId)).limit(1);
    if (video) {
      title = title ?? video.title;
      youtubeId = youtubeId ?? video.youtubeId;
      thumbnailUrl = thumbnailUrl ?? video.thumbnailUrl ?? "";
      localVideoUrl = localVideoUrl ?? video.hlsMasterUrl ?? video.localVideoUrl ?? undefined;
      videoSource = videoSource ?? video.videoSource;
      if (resolvedDurationSecs <= 0 && video.duration) {
        const detected = parseDurationSecs(video.duration);
        if (detected > 0) resolvedDurationSecs = detected;
      }
    }
  }

  if (!title?.trim()) {
    return void res.status(400).json({ error: "title is required" });
  }
  const resolvedSource = videoSource ?? (localVideoUrl ? "local" : "youtube");
  if (resolvedSource === "youtube" && !youtubeId) {
    return void res.status(400).json({ error: "youtubeId is required for YouTube videos" });
  }
  if (resolvedSource === "local" && !localVideoUrl) {
    return void res.status(400).json({ error: "localVideoUrl is required for local videos" });
  }

  if (resolvedDurationSecs <= 0) resolvedDurationSecs = 1800;

  // Acquire the advisory lock first, then run dedup-check + insert/update in a
  // single transaction. Lock key matches the one in admin.ts. Without this,
  // two concurrent POSTs for the same videoId could both miss the existing-row
  // check and insert duplicate rows.
  let item: (typeof broadcastQueueTable.$inferSelect) | undefined;
  let wasUpdate = false;

  type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  await db.transaction(async (tx: DbTx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BROADCAST_QUEUE_LOCK_KEY})`);

    const [existingMatch] = videoId
      ? await tx
          .select()
          .from(broadcastQueueTable)
          .where(eq(broadcastQueueTable.videoId, videoId))
          .limit(1)
      : [];

    if (existingMatch) {
      wasUpdate = true;
      const [updated] = await tx
        .update(broadcastQueueTable)
        .set({
          youtubeId: youtubeId ?? existingMatch.youtubeId,
          title: title.trim(),
          thumbnailUrl: thumbnailUrl ?? existingMatch.thumbnailUrl,
          durationSecs: resolvedDurationSecs,
          localVideoUrl: localVideoUrl ?? existingMatch.localVideoUrl,
          videoSource: resolvedSource,
          isActive: true,
        })
        .where(eq(broadcastQueueTable.id, existingMatch.id))
        .returning();
      item = updated;
    } else {
      const [inserted] = await tx
        .insert(broadcastQueueTable)
        .values({
          id: randomUUID(),
          videoId: videoId ?? null,
          youtubeId: youtubeId ?? "",
          title: title.trim(),
          thumbnailUrl: thumbnailUrl ?? "",
          durationSecs: resolvedDurationSecs,
          localVideoUrl: localVideoUrl ?? null,
          videoSource: resolvedSource,
          sortOrder: sql`COALESCE((SELECT MAX(${broadcastQueueTable.sortOrder}) + 1 FROM ${broadcastQueueTable}), 0)`,
        })
        .returning();
      item = inserted;
    }
  });

  if (!item) return void res.status(500).json({ error: "Failed to save queue item" });

  await invalidateBroadcastCache();
  broadcastLiveEvent("broadcast-queue-updated", { id: item.id, reason: wasUpdate ? "updated" : "added", queuedAt: new Date().toISOString() });
  emitBroadcastState(wasUpdate ? "queue-updated" : "queue-added", { id: item.id });
  res.status(201).json(item);
});

router.patch("/admin/broadcast/:id", async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const { durationSecs, isActive, title } = req.body as {
      durationSecs?: number;
      isActive?: boolean;
      title?: string;
    };

    const updates: Partial<typeof broadcastQueueTable.$inferInsert> = {};
    if (durationSecs !== undefined) {
      if (typeof durationSecs !== "number" || durationSecs < 0) {
        return void res.status(400).json({ error: "durationSecs must be a non-negative number" });
      }
      updates.durationSecs = Math.round(durationSecs);
    }
    if (isActive !== undefined) updates.isActive = isActive;
    if (title !== undefined) {
      if (!title.trim()) return void res.status(400).json({ error: "title cannot be empty" });
      updates.title = title.trim();
    }

    if (Object.keys(updates).length === 0) {
      return void res.status(400).json({ error: "No valid fields to update" });
    }

    const [updated] = await db
      .update(broadcastQueueTable)
      .set(updates)
      .where(eq(broadcastQueueTable.id, id))
      .returning();

    if (!updated) return void res.status(404).json({ error: "Item not found" });
    await invalidateBroadcastCache();
    broadcastLiveEvent("broadcast-queue-updated", { id, reason: "updated", queuedAt: new Date().toISOString() });
    emitBroadcastState("queue-updated", { id });
    res.json(updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.delete("/admin/broadcast/:id", async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const [deleted] = await db
      .delete(broadcastQueueTable)
      .where(eq(broadcastQueueTable.id, id))
      .returning();
    if (!deleted) return void res.status(404).json({ error: "Item not found" });
    await invalidateBroadcastCache();
    broadcastLiveEvent("broadcast-queue-updated", { id, reason: "deleted", queuedAt: new Date().toISOString() });
    emitBroadcastState("queue-deleted", { id });
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.put("/admin/broadcast/reorder", async (req, res) => {
  try {
    const { orderedIds } = req.body as { orderedIds: string[] };
    if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== "string")) {
      return void res.status(400).json({ error: "orderedIds must be an array of strings" });
    }
    if (orderedIds.length === 0) {
      return void res.status(400).json({ error: "orderedIds cannot be empty" });
    }

    // Use a transaction so all sort orders are updated atomically
    type DbTx2 = Parameters<Parameters<typeof db.transaction>[0]>[0];
    await db.transaction(async (tx: DbTx2) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx
          .update(broadcastQueueTable)
          .set({ sortOrder: i })
          .where(eq(broadcastQueueTable.id, orderedIds[i]!));
      }
    });

    await invalidateBroadcastCache();
    broadcastLiveEvent("broadcast-queue-updated", { orderedIds, reason: "reordered", queuedAt: new Date().toISOString() });
    emitBroadcastState("queue-reordered", { orderedIds });
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

const VALID_REACTION_TYPES = ["amen", "fire", "hallelujah"] as const;
type ReactionType = typeof VALID_REACTION_TYPES[number];

router.post("/broadcast/reaction", (req, res) => {
  const { type } = req.body as { type?: string };
  if (!type || !VALID_REACTION_TYPES.includes(type as ReactionType)) {
    return void res.status(400).json({ error: "type must be amen, fire, or hallelujah" });
  }
  broadcastLiveEvent("live-reaction", { type, ts: Date.now() });
  res.json({ ok: true });
});

/**
 * Public RTMP-gateway publish webhook — used by nginx-rtmp / srs / MediaLive
 * `on_publish` callbacks to authorize an incoming RTMP/RTMPS/SRT publish
 * attempt before the gateway forwards a single byte upstream.
 *
 * Gateways pass the encoder's stream name + key as form-encoded body fields:
 *   nginx-rtmp:  `name=<endpoint-name>&key=<stream-key>`
 *
 * Security model:
 *   - The endpoint is intentionally public (RTMP gateways can't carry an
 *     admin bearer token) but is gated entirely on stream-key validation —
 *     unknown name, disabled endpoint, or wrong key all return 403.
 *   - Comparison is constant-time (see `safeEqual` in liveIngestHealth.ts).
 *   - We never echo back the configured key, only success/failure.
 *   - Every rejection is logged so unauthorized publish attempts can be
 *     audited from the server logs.
 *
 * Most encoders pass the stream key as the second path segment of the RTMP
 * URL (`rtmp://host/app/<key>`), so RTMP gateways typically send `name=app`
 * and `key=<key>`. Configure your endpoint's `name` field accordingly.
 */
router.post("/live-ingest/auth", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, string>;
    // nginx-rtmp uses `name`/`key`; some gateways use `stream`/`token`.
    const name = body.name ?? body.stream ?? "";
    const key = body.key ?? body.token ?? "";
    const result = await validateStreamKey(name, key);
    if (result.allowed) {
      // Returning 200 is the universal "publish allowed" signal across nginx-
      // rtmp / srs / MediaLive callbacks. Body is informational only.
      res.status(200).json({ allowed: true });
    } else {
      // 403 is the universal "publish denied" signal — the gateway will drop
      // the inbound connection before any frames flow upstream.
      res.status(403).json({ allowed: false });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/broadcast/prayer", async (req, res) => {
  try {
    const { name, message } = req.body as { name?: string; message?: string };
    if (!message?.trim()) {
      return void res.status(400).json({ error: "message is required" });
    }
    const [inserted] = await db
      .insert(prayerRequestsTable)
      .values({
        id: randomUUID(),
        name: name?.trim() || null,
        message: message.trim(),
      })
      .returning();
    res.json({ ok: true, id: inserted.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

export default router;
