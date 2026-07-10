import { eq } from "drizzle-orm";
import { db, pgPool, schema } from "../../../infrastructure/db.js";

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
    // Use a pinned pool connection with manual BEGIN/COMMIT so that SET LOCAL
    // timeouts apply only to this write and cannot leak to other connections.
    //
    // We bypass db.transaction() intentionally: Drizzle's transaction wrapper
    // in node-postgres acquires a dedicated pool client then runs async setup
    // before sending BEGIN, introducing a multi-second delay in environments
    // that use PgBouncer-compatible pooling. The raw pool.connect() approach
    // avoids that setup path and completes in <10 ms.
    //
    // lock_timeout=3s: fail fast if the checkpoint row is locked by an orphaned
    // connection left over from a previous crash. statement_timeout=5s: kill the
    // write entirely if it gets stuck for any other reason.
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SET LOCAL statement_timeout = 5000; SET LOCAL lock_timeout = 3000",
      );
      await client.query(
        `INSERT INTO player_position_checkpoint
           (channel_id, item_id, position_ms, source_health, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (channel_id) DO UPDATE SET
           item_id       = EXCLUDED.item_id,
           position_ms   = EXCLUDED.position_ms,
           source_health = EXCLUDED.source_health,
           updated_at    = EXCLUDED.updated_at`,
        [rec.channelId, rec.itemId, rec.positionMs, rec.sourceHealth],
      );
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // best-effort rollback — ignore secondary errors
      }
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Delete a checkpoint row entirely. Used by the Midnight Prayers
   * queue-swap engine to clear its pending-resume checkpoint once the
   * main queue has been successfully restored — an absent row (vs. one
   * with itemId=null) is the unambiguous "nothing pending" signal used
   * by boot-time reconciliation.
   */
  async clear(channelId: string): Promise<void> {
    await db.delete(t).where(eq(t.channelId, channelId));
  },
};
