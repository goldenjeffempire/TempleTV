import { eq } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";

const t = schema.playerPositionCheckpointTable;

export interface CheckpointRecord {
  channelId: string;
  itemId: string | null;
  positionMs: number;
  sourceHealth: "ok" | "degraded" | "failed";
  /**
   * Wall-clock ms when this checkpoint was written to the DB (populated on read
   * from `updated_at`; not required when writing — the DB sets it automatically).
   * Used by the orchestrator's boot-restore logic to correctly account for
   * server downtime:
   *   cycleStartedAtMs = savedAtMs − offsetOfItemInCycle − positionMs
   * Without this, the calculation uses Date.now() at restart time and the
   * restored position is behind by the duration the server was offline.
   */
  savedAtMs?: number;
}

export const checkpointRepo = {
  async load(channelId: string): Promise<CheckpointRecord | null> {
    const [row] = await db.select().from(t).where(eq(t.channelId, channelId)).limit(1);
    if (!row) return null;
    return {
      channelId: row.channelId,
      itemId: row.itemId,
      positionMs: row.positionMs,
      sourceHealth: (row.sourceHealth as CheckpointRecord["sourceHealth"]) ?? "ok",
      savedAtMs: row.updatedAt.getTime(),
    };
  },

  async save(rec: CheckpointRecord): Promise<void> {
    await db
      .insert(t)
      .values({
        channelId: rec.channelId,
        itemId: rec.itemId,
        positionMs: rec.positionMs,
        sourceHealth: rec.sourceHealth,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: t.channelId,
        set: {
          itemId: rec.itemId,
          positionMs: rec.positionMs,
          sourceHealth: rec.sourceHealth,
          updatedAt: new Date(),
        },
      });
  },
};
