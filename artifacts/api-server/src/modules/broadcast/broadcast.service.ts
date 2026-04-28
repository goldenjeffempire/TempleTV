import { asc, desc, eq, max } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../../infrastructure/db.js";
import { broadcastEngine } from "./queue.engine.js";
import { NotFoundError } from "../../shared/errors.js";
import { z } from "zod";
import type { AddQueueItemSchema } from "./broadcast.schemas.js";

const queueTable = schema.broadcastQueueTable;

export const broadcastService = {
  snapshot() {
    return broadcastEngine.snapshot();
  },

  async listQueue(): Promise<typeof queueTable.$inferSelect[]> {
    return db.select().from(queueTable).orderBy(asc(queueTable.sortOrder), asc(queueTable.addedAt));
  },

  async addToQueue(item: z.infer<typeof AddQueueItemSchema>) {
    let sortOrder = item.sortOrder;
    if (sortOrder === undefined) {
      const last = await db
        .select({ s: max(queueTable.sortOrder) })
        .from(queueTable)
        .limit(1);
      sortOrder = (last[0]?.s ?? 0) + 10;
    }
    const inserted = await db
      .insert(queueTable)
      .values({
        id: nanoid(),
        videoId: item.videoId ?? null,
        youtubeId: item.youtubeId,
        title: item.title,
        thumbnailUrl: item.thumbnailUrl,
        durationSecs: item.durationSecs,
        localVideoUrl: item.localVideoUrl ?? null,
        videoSource: item.videoSource,
        isActive: true,
        sortOrder,
      })
      .returning();
    await broadcastEngine.reload();
    return inserted[0]!;
  },

  async removeFromQueue(id: string) {
    const deleted = await db.delete(queueTable).where(eq(queueTable.id, id)).returning();
    if (deleted.length === 0) throw new NotFoundError("Queue item not found");
    await broadcastEngine.reload();
    return deleted[0]!;
  },

  async reorder(itemIds: string[]) {
    let order = 10;
    for (const id of itemIds) {
      await db.update(queueTable).set({ sortOrder: order }).where(eq(queueTable.id, id));
      order += 10;
    }
    await broadcastEngine.reload();
    return broadcastEngine.snapshot();
  },

  async toggleActive(id: string, isActive: boolean) {
    const updated = await db
      .update(queueTable)
      .set({ isActive })
      .where(eq(queueTable.id, id))
      .returning();
    if (updated.length === 0) throw new NotFoundError("Queue item not found");
    await broadcastEngine.reload();
    return updated[0]!;
  },
};

export { desc };
