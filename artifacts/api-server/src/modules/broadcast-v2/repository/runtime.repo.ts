import { eq } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import type { V2Mode } from "../domain/types.js";

const t = schema.broadcastRuntimeStateTable;

export interface RuntimeStateRecord {
  channelId: string;
  mode: V2Mode;
  currentItemId: string | null;
  startedAtMs: number | null;
  offsetMs: number;
  activeOverrideId: string | null;
  sequence: number;
}

export const runtimeRepo = {
  async load(channelId: string): Promise<RuntimeStateRecord | null> {
    const [row] = await db.select().from(t).where(eq(t.channelId, channelId)).limit(1);
    if (!row) return null;
    return {
      channelId: row.channelId,
      mode: (row.mode as V2Mode) ?? "queue",
      currentItemId: row.currentItemId,
      startedAtMs: row.startedAtMs ?? null,
      offsetMs: row.offsetMs,
      activeOverrideId: row.activeOverrideId,
      sequence: row.sequence,
    };
  },

  async save(rec: RuntimeStateRecord): Promise<void> {
    await db
      .insert(t)
      .values({
        channelId: rec.channelId,
        mode: rec.mode,
        currentItemId: rec.currentItemId,
        startedAtMs: rec.startedAtMs,
        offsetMs: rec.offsetMs,
        activeOverrideId: rec.activeOverrideId,
        sequence: rec.sequence,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: t.channelId,
        set: {
          mode: rec.mode,
          currentItemId: rec.currentItemId,
          startedAtMs: rec.startedAtMs,
          offsetMs: rec.offsetMs,
          activeOverrideId: rec.activeOverrideId,
          sequence: rec.sequence,
          updatedAt: new Date(),
        },
      });
  },

  async bumpSequence(channelId: string, next: number): Promise<void> {
    await db
      .update(t)
      .set({ sequence: next, updatedAt: new Date() })
      .where(eq(t.channelId, channelId));
  },
};
