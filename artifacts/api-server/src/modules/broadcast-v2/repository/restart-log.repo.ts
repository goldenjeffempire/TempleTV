import { desc, eq, sql } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";

const t = schema.broadcastDaemonRestartsTable;

export type RestartResumeSource = "checkpoint" | "disk_backup" | "cold_start";

export interface RestartRecord {
  channelId: string;
  resumeSource: RestartResumeSource;
  resumeItemId: string | null;
  resumePositionMs: number;
  resumeSequence: number;
}

export interface RestartHistoryEntry {
  id: number;
  restartedAt: Date;
  resumeSource: string;
  resumeItemId: string | null;
  resumePositionMs: number;
  resumeSequence: number;
}

export const restartLogRepo = {
  /**
   * Write a restart record immediately after the orchestrator boots.
   * Non-throwing — a failed write must never prevent the daemon from starting.
   */
  async write(rec: RestartRecord): Promise<void> {
    try {
      await db.insert(t).values({
        channelId: rec.channelId,
        resumeSource: rec.resumeSource,
        resumeItemId: rec.resumeItemId,
        resumePositionMs: rec.resumePositionMs,
        resumeSequence: rec.resumeSequence,
      });
      logger.info(
        {
          channelId: rec.channelId,
          resumeSource: rec.resumeSource,
          resumePositionMs: rec.resumePositionMs,
          resumeSequence: rec.resumeSequence,
        },
        "[broadcast-v2] daemon boot recorded in restart log",
      );
      // Prune old records non-fatally (fire-and-forget)
      void restartLogRepo.prune(rec.channelId).catch(() => {/* non-fatal */});
    } catch (err) {
      logger.warn({ err }, "[broadcast-v2] restart log write failed (non-fatal)");
    }
  },

  /**
   * Load the most recent restart records for a channel, newest first.
   */
  async load(channelId: string, limit = 20): Promise<RestartHistoryEntry[]> {
    const rows = await db
      .select()
      .from(t)
      .where(eq(t.channelId, channelId))
      .orderBy(desc(t.restartedAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      restartedAt: r.restartedAt,
      resumeSource: r.resumeSource,
      resumeItemId: r.resumeItemId,
      resumePositionMs: r.resumePositionMs,
      resumeSequence: Number(r.resumeSequence),
    }));
  },

  /**
   * Delete rows older than the most recent `keep` entries per channel.
   * Keeps the table bounded on long-running deployments.
   */
  async prune(channelId: string, keep = 500): Promise<void> {
    // Delete any row for this channel that isn't in the top `keep` by id
    await db.execute(
      sql`DELETE FROM broadcast_daemon_restarts
          WHERE channel_id = ${channelId}
            AND id NOT IN (
              SELECT id FROM broadcast_daemon_restarts
              WHERE channel_id = ${channelId}
              ORDER BY id DESC
              LIMIT ${keep}
            )`,
    );
  },
};
