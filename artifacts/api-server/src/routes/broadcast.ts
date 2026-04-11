import { Router } from "express";
import { db, broadcastQueueTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { randomUUID } from "crypto";

const router = Router();

router.get("/broadcast/current", async (_req, res) => {
  const items = await db
    .select()
    .from(broadcastQueueTable)
    .where(eq(broadcastQueueTable.isActive, true))
    .orderBy(asc(broadcastQueueTable.sortOrder));

  if (items.length === 0) {
    return res.json({
      item: null,
      nextItem: null,
      index: 0,
      positionSecs: 0,
      totalSecs: 0,
      queueLength: 0,
      progressPercent: 0,
      syncedAt: new Date().toISOString(),
      failoverReason: "Broadcast queue is empty.",
    });
  }

  const playableItems = items.filter((item) => item.durationSecs > 0);
  if (playableItems.length === 0) {
    return res.json({
      item: null,
      nextItem: null,
      index: 0,
      positionSecs: 0,
      totalSecs: 0,
      queueLength: 0,
      progressPercent: 0,
      syncedAt: new Date().toISOString(),
      failoverReason: "No active broadcast items have a valid duration.",
    });
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
  res.json({
    item: currentItem,
    nextItem,
    index,
    positionSecs,
    totalSecs,
    queueLength: playableItems.length,
    progressPercent: currentItem.durationSecs > 0 ? Math.round((positionSecs / currentItem.durationSecs) * 100) : 0,
    syncedAt: new Date().toISOString(),
    failoverReason: null,
  });
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
      durationSecs: durationSecs ?? 1800,
      localVideoUrl: localVideoUrl ?? null,
      videoSource: videoSource ?? "youtube",
      sortOrder: maxOrder,
    })
    .returning();

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
  res.json(updated);
});

router.delete("/admin/broadcast/:id", async (req, res) => {
  const { id } = req.params as { id: string };
  await db.delete(broadcastQueueTable).where(eq(broadcastQueueTable.id, id));
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

  res.json({ ok: true });
});

export default router;
