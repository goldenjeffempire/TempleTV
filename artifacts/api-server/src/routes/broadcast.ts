import { Router } from "express";
import {
  db,
  broadcastQueueTable,
  liveOverridesTable,
  playlistVideosTable,
  scheduleTable,
  videosTable,
} from "@workspace/db";
import { eq, asc, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import { cache } from "../lib/cache";
import {
  addSSEClient,
  broadcastLiveEvent,
  removeSSEClient,
} from "../lib/liveEvents";

const router = Router();

type BroadcastItem = typeof broadcastQueueTable.$inferSelect;
type ScheduleEntry = typeof scheduleTable.$inferSelect;

const CACHE_KEYS = {
  liveOverride: "broadcast:live_override",
  scheduleEntries: "broadcast:schedule_entries",
  broadcastQueue: "broadcast:queue",
} as const;

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
  ]);
}

async function buildBroadcastCurrentPayload() {
  const nowMs = Date.now();
  const syncedAt = new Date(nowMs).toISOString();

  const activeLiveOverride = await getActiveLiveOverride();
  if (activeLiveOverride) {
    return {
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
  }

  const activeScheduleEntries = await getScheduleEntries();
  const activeSchedule = getActiveScheduleEntry(activeScheduleEntries as ScheduleEntry[]);

  if (activeSchedule?.contentType === "live") {
    return {
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
  }

  if (activeSchedule && (activeSchedule.contentType === "playlist" || activeSchedule.contentType === "video")) {
    const scheduledItems = await getScheduledItems(activeSchedule);
    if (scheduledItems.length > 0) {
      const calculated = calculateCurrentFromItems(scheduledItems);
      return {
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
    }
  }

  const items = await getBroadcastQueue();

  if (items.length === 0) {
    return {
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
      activeSchedule,
      liveOverride: null,
    };
  }

  const calculated = calculateCurrentFromItems(items);
  return {
    ...calculated,
    syncedAt,
    serverTimeMs: nowMs,
    activeSchedule,
    liveOverride: null,
  };
}

function emitBroadcastState(reason: string, detail: Record<string, unknown> = {}) {
  buildBroadcastCurrentPayload()
    .then((current) => {
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

function calculateCurrentFromItems(items: BroadcastItem[]) {
  const playableItems = items.filter((item) => item.durationSecs > 0);
  if (playableItems.length === 0) {
    return {
      item: null,
      nextItem: null,
      index: 0,
      positionSecs: 0,
      totalSecs: 0,
      queueLength: 0,
      progressPercent: 0,
      failoverReason: "No active broadcast items have a valid duration.",
    };
  }

  const totalSecs = playableItems.reduce((acc, i) => acc + i.durationSecs, 0);
  const epochSecs = Math.floor(Date.now() / 1000);
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
  return {
    item: currentItem,
    nextItem,
    index,
    positionSecs,
    totalSecs,
    queueLength: playableItems.length,
    progressPercent: currentItem.durationSecs > 0 ? Math.round((positionSecs / currentItem.durationSecs) * 100) : 0,
    failoverReason: null,
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
      youtubeId: video.youtubeId,
      title: video.title,
      thumbnailUrl: video.thumbnailUrl,
      durationSecs: parseDurationSecs(video.duration),
      localVideoUrl: null,
      videoSource: "youtube",
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
      return res.json({ items: [], liveOverride: { title: activeLiveOverride.title } });
    }

    const activeScheduleEntries = await getScheduleEntries();
    const activeSchedule = getActiveScheduleEntry(activeScheduleEntries as ScheduleEntry[]);
    const items = activeSchedule && activeSchedule.contentType !== "live"
      ? await getScheduledItems(activeSchedule)
      : await getBroadcastQueue();

    const playableItems = items.filter((item) => item.durationSecs > 0);
    if (playableItems.length === 0) return res.json({ items: [] });

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
    res.json(await buildBroadcastCurrentPayload());
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/broadcast/events", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const client = addSSEClient(res);

  try {
    const current = await buildBroadcastCurrentPayload();
    res.write(`event: broadcast-current-updated\ndata: ${JSON.stringify({ reason: "connected", current })}\n\n`);
  } catch {}

  req.on("close", () => removeSSEClient(client));
});

router.get("/admin/broadcast", async (_req, res) => {
  const items = await db
    .select()
    .from(broadcastQueueTable)
    .orderBy(asc(broadcastQueueTable.sortOrder));
  res.json(items);
});

router.post("/admin/broadcast", async (req, res) => {
  const { videoId, youtubeId, title, thumbnailUrl, durationSecs, localVideoUrl, videoSource } = req.body as {
    videoId?: string;
    youtubeId: string;
    title: string;
    thumbnailUrl?: string;
    durationSecs?: number;
    localVideoUrl?: string;
    videoSource?: string;
  };

  if (!youtubeId || !title) {
    return res.status(400).json({ error: "youtubeId and title are required" });
  }

  let resolvedDurationSecs = durationSecs ?? 0;

  if (resolvedDurationSecs <= 0 && videoId) {
    const [video] = await db.select().from(videosTable).where(eq(videosTable.id, videoId)).limit(1);
    if (video?.duration) {
      const detected = parseDurationSecs(video.duration);
      if (detected > 60) resolvedDurationSecs = detected;
    }
  }

  if (resolvedDurationSecs <= 0) resolvedDurationSecs = 1800;

  const existing = await db
    .select()
    .from(broadcastQueueTable)
    .orderBy(asc(broadcastQueueTable.sortOrder));

  const maxOrder = existing.length > 0 ? Math.max(...existing.map((i) => i.sortOrder)) + 1 : 0;

  const [item] = await db
    .insert(broadcastQueueTable)
    .values({
      id: randomUUID(),
      videoId: videoId ?? null,
      youtubeId,
      title,
      thumbnailUrl: thumbnailUrl ?? "",
      durationSecs: resolvedDurationSecs,
      localVideoUrl: localVideoUrl ?? null,
      videoSource: videoSource ?? "youtube",
      sortOrder: maxOrder,
    })
    .returning();

  await invalidateBroadcastCache();
  broadcastLiveEvent("broadcast-queue-updated", { id: item.id, reason: "added", queuedAt: new Date().toISOString() });
  emitBroadcastState("queue-added", { id: item.id });
  res.status(201).json(item);
});

router.patch("/admin/broadcast/:id", async (req, res) => {
  const { id } = req.params as { id: string };
  const { durationSecs, isActive, title } = req.body as {
    durationSecs?: number;
    isActive?: boolean;
    title?: string;
  };

  const updates: Partial<typeof broadcastQueueTable.$inferInsert> = {};
  if (durationSecs !== undefined) updates.durationSecs = durationSecs;
  if (isActive !== undefined) updates.isActive = isActive;
  if (title !== undefined) updates.title = title;

  const [updated] = await db
    .update(broadcastQueueTable)
    .set(updates)
    .where(eq(broadcastQueueTable.id, id))
    .returning();

  if (!updated) return res.status(404).json({ error: "Item not found" });
  await invalidateBroadcastCache();
  broadcastLiveEvent("broadcast-queue-updated", { id, reason: "updated", queuedAt: new Date().toISOString() });
  emitBroadcastState("queue-updated", { id });
  res.json(updated);
});

router.delete("/admin/broadcast/:id", async (req, res) => {
  const { id } = req.params as { id: string };
  await db.delete(broadcastQueueTable).where(eq(broadcastQueueTable.id, id));
  await invalidateBroadcastCache();
  broadcastLiveEvent("broadcast-queue-updated", { id, reason: "deleted", queuedAt: new Date().toISOString() });
  emitBroadcastState("queue-deleted", { id });
  res.json({ ok: true });
});

router.put("/admin/broadcast/reorder", async (req, res) => {
  const { orderedIds } = req.body as { orderedIds: string[] };
  if (!Array.isArray(orderedIds)) {
    return res.status(400).json({ error: "orderedIds must be an array" });
  }

  await Promise.all(
    orderedIds.map((id, index) =>
      db
        .update(broadcastQueueTable)
        .set({ sortOrder: index })
        .where(eq(broadcastQueueTable.id, id))
    )
  );

  await invalidateBroadcastCache();
  broadcastLiveEvent("broadcast-queue-updated", { orderedIds, reason: "reordered", queuedAt: new Date().toISOString() });
  emitBroadcastState("queue-reordered", { orderedIds });
  res.json({ ok: true });
});

export default router;
