import express, { Router } from "express";
import { recordPlaybackTelemetry } from "../lib/streamHealth";
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
} from "../lib/liveEvents";

const router = Router();

type BroadcastItem = typeof broadcastQueueTable.$inferSelect;
type ScheduleEntry = typeof scheduleTable.$inferSelect;

type BroadcastCurrentPayload = {
  item: BroadcastItem | null;
  nextItem: BroadcastItem | null;
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
  } | null;
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

async function getActiveLiveOverride() {
  const overrides = await cache.getOrSet(
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

async function getBroadcastQueue() {
  return cache.getOrSet(
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

      return {
        ...cached,
        positionSecs: livePositionSecs,
        progressPercent: liveProgressPercent,
        currentItemEndsAtMs: liveCurrentItemEndsAtMs,
        syncedAt,
        serverTimeMs: nowMs,
      };
    }
  }

  const [activeLiveOverride, scheduleEntries, queueItems] = await Promise.all([
    getActiveLiveOverride(),
    getScheduleEntries(),
    getBroadcastQueue(),
  ]);

  let result: BroadcastCurrentPayload;

  if (activeLiveOverride) {
    result = {
      item: null,
      nextItem: null,
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
      },
    };
    await cache.set(BROADCAST_PAYLOAD_CACHE_KEY, result, BROADCAST_PAYLOAD_TTL_MS);
    return result;
  }

  const activeSchedule = getActiveScheduleEntry(scheduleEntries as ScheduleEntry[]);

  if (activeSchedule?.contentType === "live") {
    result = {
      item: null,
      nextItem: null,
      index: 0,
      positionSecs: 0,
      totalSecs: 0,
      queueLength: 0,
      progressPercent: 0,
      syncedAt,
      serverTimeMs: nowMs,
      failoverReason: null,
      liveOverride: null,
      activeSchedule: {
        id: activeSchedule.id,
        title: activeSchedule.title,
        contentType: activeSchedule.contentType,
        contentId: activeSchedule.contentId,
        startTime: activeSchedule.startTime,
        endTime: activeSchedule.endTime,
      },
    };
    await cache.set(BROADCAST_PAYLOAD_CACHE_KEY, result, BROADCAST_PAYLOAD_TTL_MS);
    return result;
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
      };
      await cache.set(BROADCAST_PAYLOAD_CACHE_KEY, result, BROADCAST_PAYLOAD_TTL_MS);
      return result;
    }
  }

  if (queueItems.length === 0) {
    result = {
      item: null,
      nextItem: null,
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
    };
    await cache.set(BROADCAST_PAYLOAD_CACHE_KEY, result, BROADCAST_PAYLOAD_TTL_MS);
    return result;
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
  };
  await cache.set(BROADCAST_PAYLOAD_CACHE_KEY, result, BROADCAST_PAYLOAD_TTL_MS);
  return result;
}

// ---------------------------------------------------------------------------
// Transition ticker — detects automatic queue item advances and pushes SSE
// ---------------------------------------------------------------------------

/** The last payload whose `currentItemEndsAtMs` the ticker is watching. */
let _lastTrackedPayload: BroadcastCurrentPayload | null = null;
let _transitionTickHandle: ReturnType<typeof setInterval> | null = null;


async function _tickTransitions() {
  try {
    if (!_lastTrackedPayload) {
      _lastTrackedPayload = await buildBroadcastCurrentPayload();
      return;
    }

    const endsAtMs = _lastTrackedPayload.currentItemEndsAtMs;
    // No transition due yet — skip the DB round trip.
    if (!endsAtMs || Date.now() < endsAtMs) return;

    // The current item's clock has passed — rebuild from source and push.
    await invalidateBroadcastCache();
    const fresh = await buildBroadcastCurrentPayload(true);
    _lastTrackedPayload = fresh;
    broadcastLiveEvent("broadcast-current-updated", {
      reason: "item-transition",
      current: fresh,
    });
  } catch {
    // Never crash the ticker — silently swallow errors
  }
}

export function startBroadcastTransitionTicker(): void {
  if (_transitionTickHandle) return;
  // Kick off an immediate initial read so the ticker knows what to watch.
  buildBroadcastCurrentPayload()
    .then((p) => { _lastTrackedPayload = p; })
    .catch(() => {});
  // Tick at 500ms (was 2_000ms). The transition SSE tells clients to
  // promote the next queue item; clients also auto-swap on the active
  // video's `ended` event, but the SSE remains the source of truth for
  // metadata (now-playing card, up-next list). A faster tick keeps the
  // metadata in lock-step with the actual video transition so viewers
  // never see a mismatched title or stale "currently playing" badge.
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
      _lastTrackedPayload = current; // keep ticker in sync with manual changes
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
            return {
              result: {
                item: cursorItem,
                nextItem,
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
  const itemStartEpochSecs = epochSecs - positionSecs;
  const currentItemEndsAtMs = (itemStartEpochSecs + currentItem.durationSecs) * 1000;
  return {
    result: {
      item: currentItem,
      nextItem,
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

    return videos.map((video, index) => ({
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

    const playableItems = items.filter((item) => item.durationSecs > 0);
    if (playableItems.length === 0) return void res.json({ items: [] });

    const totalSecs = playableItems.reduce((acc, i) => acc + i.durationSecs, 0);
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
    // Live broadcast state — must NEVER be cached by the browser, the Render
    // edge, or any intermediary proxy. Stale state here is what produces the
    // "I'm 30s behind everyone else" desync that this endpoint exists to
    // prevent. The payload itself stays small (~1 KB), so re-fetching every
    // request costs nothing measurable.
    res
      .setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
      .setHeader("Pragma", "no-cache")
      .setHeader("Expires", "0")
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

  // Tell clients to retry connection after 5s on disconnect
  res.write("retry: 5000\n\n");
  flushRes();

  const client = addSSEClient(res, req.query.platform);

  try {
    const current = await buildBroadcastCurrentPayload();
    res.write(`event: broadcast-current-updated\ndata: ${JSON.stringify({ reason: "connected", current })}\n\n`);
    flushRes();
  } catch (err) {
    console.error("[SSE /broadcast/events] initial write failed:", err);
  }

  req.on("close", () => removeSSEClient(client));
});

// Tiny endpoint for player clients to report decoded/dropped frame deltas from
// HTMLVideoElement.getVideoPlaybackQuality(). Players are expected to POST a
// running delta every ~5 s. This feeds the dropped-frame field on the
// stream-health SSE channel — the only metric we genuinely cannot measure on
// the server.
router.post("/broadcast/playback-telemetry", express.json({ limit: "1kb" }), (req, res) => {
  const body = (req.body ?? {}) as { platform?: unknown; decoded?: unknown; dropped?: unknown };
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

  await db.transaction(async (tx) => {
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
    await db.transaction(async (tx) => {
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
