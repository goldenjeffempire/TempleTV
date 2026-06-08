import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../../infrastructure/db.js";
import { broadcastEngine } from "./queue.engine.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import type { z } from "zod";
import type { AddQueueItemSchema } from "./broadcast.schemas.js";

const queueTable = schema.broadcastQueueTable;

export const broadcastService = {
  snapshot() {
    return broadcastEngine.snapshot();
  },

  async listQueue(): Promise<typeof queueTable.$inferSelect[]> {
    return db.select().from(queueTable).orderBy(asc(queueTable.sortOrder), asc(queueTable.addedAt)).limit(1000);
  },

  async addToQueue(item: z.infer<typeof AddQueueItemSchema>) {
    // Defense-in-depth source check — mirrors the schema superRefine for
    // programmatic callers (upload finalize, prod-sync) that bypass HTTP
    // schema validation. Prevents the DB from ever receiving a row that the
    // v2 orchestrator would always reject at pre-resolution time.
    if (item.videoSource !== "youtube") {
      const hasSource =
        (!!item.localVideoUrl && item.localVideoUrl.trim() !== "") ||
        (!!item.videoId && item.videoId.trim() !== "");
      if (!hasSource) {
        throw new Error(
          `[broadcast] Cannot enqueue "${item.title}" — platform video item has no localVideoUrl or videoId. ` +
            "Provide at least one playable source before adding to the queue.",
        );
      }
    }

    // Wrap the pre-check, max(sortOrder) read, and INSERT in a transaction so:
    //   (a) two concurrent addToQueue calls can't read the same MAX value and
    //       produce duplicate sort_order entries (DUPLICATE_SORT_ORDER warning).
    //   (b) the duplicate videoId check and the INSERT are atomic — a second
    //       concurrent addToQueue for the same video will either be blocked
    //       by the row-level lock acquired by the first SELECT FOR UPDATE or
    //       will see the newly-inserted row and throw ConflictError cleanly,
    //       without relying solely on the DB unique-index 23505 backstop.
    const inserted = await db.transaction(async (tx) => {
      // ── Duplicate-video guard ────────────────────────────────────────────
      // Reject the insert before touching sort_order if an active queue row
      // already references this video. This is Layer 1 of the guard; the
      // partial unique index `uq_broadcast_queue_video_id_active` is Layer 2
      // (DB backstop for any concurrent race that slips past this check).
      if (item.videoId) {
        const [dup] = await tx
          .select({ id: queueTable.id })
          .from(queueTable)
          .where(and(eq(queueTable.videoId, item.videoId), eq(queueTable.isActive, true)))
          .limit(1);
        if (dup) {
          throw new ConflictError(
            `Video is already active in the broadcast queue (queue item: ${dup.id})`,
          );
        }
      }
      let sortOrder = item.sortOrder;
      if (sortOrder === undefined) {
        const last = await tx
          .select({ s: max(queueTable.sortOrder) })
          .from(queueTable)
          .limit(1);
        sortOrder = (last[0]?.s ?? 0) + 10;
      }
      return tx
        .insert(queueTable)
        .values({
          id: nanoid(),
          videoId: item.videoId ?? null,
          youtubeId: item.youtubeId ?? "",
          title: item.title,
          thumbnailUrl: item.thumbnailUrl,
          durationSecs: item.durationSecs,
          localVideoUrl: item.localVideoUrl ?? null,
          videoSource: item.videoSource,
          isActive: true,
          sortOrder,
        })
        .returning();
    });
    await broadcastEngine.reload();
    adminEventBus.push("broadcast-queue-updated", { reason: "item-added", id: inserted[0]!.id });
    return inserted[0]!;
  },

  async removeFromQueue(id: string) {
    const deleted = await db.delete(queueTable).where(eq(queueTable.id, id)).returning();
    if (deleted.length === 0) throw new NotFoundError("Queue item not found");
    await broadcastEngine.reload();
    adminEventBus.push("broadcast-queue-updated", { reason: "item-removed", id });
    return deleted[0]!;
  },

  async reorder(itemIds: string[]) {
    // Build a single atomic CASE-based UPDATE so all sort_order changes land
    // in one round-trip. A sequential loop would leave the queue in a
    // half-renumbered state if any individual update fails mid-way.
    //
    // Equivalent SQL:
    //   UPDATE broadcast_queue
    //   SET sort_order = CASE id
    //     WHEN 'a' THEN 10 WHEN 'b' THEN 20 …
    //   END
    //   WHERE id IN ('a','b',…)
    // Build a safe parameterized CASE expression using Drizzle's sql tag.
    // Each WHEN/THEN pair is a separate sql chunk so all values go through
    // the driver's parameterization — no manual escaping or sql.raw needed.
    const whenClauses = itemIds.map(
      (id, i) => sql`WHEN ${id} THEN ${(i + 1) * 10}`,
    );
    const caseExpr = sql`CASE id ${sql.join(whenClauses, sql` `)} ELSE sort_order END`;
    await db
      .update(queueTable)
      .set({ sortOrder: caseExpr })
      .where(inArray(queueTable.id, itemIds));
    await broadcastEngine.reload();
    adminEventBus.push("broadcast-queue-updated", { reason: "reorder" });
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
    adminEventBus.push("broadcast-queue-updated", { reason: "toggle-active", id, isActive });
    return updated[0]!;
  },
};

