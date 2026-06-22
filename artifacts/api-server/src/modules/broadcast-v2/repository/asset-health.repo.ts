/**
 * Asset Health Repository
 *
 * CRUD for the queue_asset_health table — the persistent state machine
 * that tracks automated repair attempts for broadcast queue items.
 */
import { eq, inArray, lte, sql, and, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, schema } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";
import type { QueueAssetHealthState, RepairLogEntry } from "@workspace/db";

const MAX_LOG_ENTRIES = 50;
const MAX_REPAIR_ATTEMPTS = 3;

/** Back-off schedule for repair retries (ms). */
const REPAIR_BACKOFF_MS = [
  2 * 60_000,   // 2 min after 1st failure
  10 * 60_000,  // 10 min after 2nd failure
  30 * 60_000,  // 30 min after 3rd failure (→ blocked after this)
];

function nextRetryAfterMs(attempts: number): number {
  const idx = Math.min(attempts, REPAIR_BACKOFF_MS.length - 1);
  return REPAIR_BACKOFF_MS[idx]!;
}

function clampLog(existing: RepairLogEntry[], added: RepairLogEntry): RepairLogEntry[] {
  const full = [...existing, added];
  return full.length > MAX_LOG_ENTRIES ? full.slice(full.length - MAX_LOG_ENTRIES) : full;
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface AssetHealthRow {
  id: string;
  queueItemId: string;
  videoId: string | null;
  state: QueueAssetHealthState;
  repairAttempts: number;
  lastRepairAt: Date | null;
  nextRetryAt: Date | null;
  lastErrorCode: string | null;
  lastError: string | null;
  suggestedFix: string | null;
  sourceHash: string | null;
  autoRepairPaused: boolean;
  repairLog: RepairLogEntry[];
  createdAt: Date;
  updatedAt: Date;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rowToDto(row: typeof schema.queueAssetHealthTable.$inferSelect): AssetHealthRow {
  return {
    id: row.id,
    queueItemId: row.queueItemId,
    videoId: row.videoId,
    state: (row.state as QueueAssetHealthState) ?? "healthy",
    repairAttempts: row.repairAttempts,
    lastRepairAt: row.lastRepairAt,
    nextRetryAt: row.nextRetryAt,
    lastErrorCode: row.lastErrorCode,
    lastError: row.lastError,
    suggestedFix: row.suggestedFix,
    sourceHash: row.sourceHash,
    autoRepairPaused: row.autoRepairPaused,
    repairLog: (row.repairLog as RepairLogEntry[] | null) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── Repository ────────────────────────────────────────────────────────────────

export const assetHealthRepo = {
  /**
   * Get or create a health row for a queue item.
   * Creates as "healthy" with zero attempts if not yet tracked.
   */
  async getOrCreate(queueItemId: string, videoId?: string | null): Promise<AssetHealthRow> {
    const existing = await db
      .select()
      .from(schema.queueAssetHealthTable)
      .where(eq(schema.queueAssetHealthTable.queueItemId, queueItemId))
      .limit(1);

    if (existing[0]) return rowToDto(existing[0]);

    const id = randomUUID();
    const rows = await db
      .insert(schema.queueAssetHealthTable)
      .values({
        id,
        queueItemId,
        videoId: videoId ?? null,
        state: "healthy",
        repairAttempts: 0,
        repairLog: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();

    if (rows[0]) return rowToDto(rows[0]);

    // Race: another call inserted first
    const race = await db
      .select()
      .from(schema.queueAssetHealthTable)
      .where(eq(schema.queueAssetHealthTable.queueItemId, queueItemId))
      .limit(1);
    if (race[0]) return rowToDto(race[0]);
    throw new Error(`[asset-health] getOrCreate failed for queueItemId=${queueItemId}`);
  },

  /** Fetch by queue item ID. Returns null if not tracked yet. */
  async getByQueueItemId(queueItemId: string): Promise<AssetHealthRow | null> {
    const rows = await db
      .select()
      .from(schema.queueAssetHealthTable)
      .where(eq(schema.queueAssetHealthTable.queueItemId, queueItemId))
      .limit(1);
    return rows[0] ? rowToDto(rows[0]) : null;
  },

  /** List all health rows, optionally filtered by state. */
  async list(opts?: { state?: QueueAssetHealthState; limit?: number }): Promise<AssetHealthRow[]> {
    const limit = opts?.limit ?? 500;
    const rows = opts?.state
      ? await db
          .select()
          .from(schema.queueAssetHealthTable)
          .where(eq(schema.queueAssetHealthTable.state, opts.state))
          .limit(limit)
      : await db
          .select()
          .from(schema.queueAssetHealthTable)
          .limit(limit);
    return rows.map(rowToDto);
  },

  /**
   * List items due for repair (quarantined, nextRetryAt ≤ now, autoRepairPaused = false).
   */
  async listDueForRepair(): Promise<AssetHealthRow[]> {
    const rows = await db
      .select()
      .from(schema.queueAssetHealthTable)
      .where(
        and(
          eq(schema.queueAssetHealthTable.state, "quarantined"),
          lte(schema.queueAssetHealthTable.nextRetryAt, new Date()),
          eq(schema.queueAssetHealthTable.autoRepairPaused, false),
        ),
      )
      .limit(20);
    return rows.map(rowToDto);
  },

  /**
   * Transition a queue item to "quarantined" state.
   * If already quarantined or blocked, only updates error info.
   */
  async markQuarantined(
    queueItemId: string,
    opts: {
      errorCode: string;
      error: string;
      suggestedFix?: string;
      actor?: "system" | "operator";
      sourceHash?: string;
    },
  ): Promise<AssetHealthRow> {
    const row = await this.getOrCreate(queueItemId);
    const logEntry: RepairLogEntry = {
      ts: new Date().toISOString(),
      actor: opts.actor ?? "system",
      action: "quarantine",
      detail: `${opts.errorCode}: ${opts.error}`,
      outcome: "pending",
    };
    const newLog = clampLog(row.repairLog, logEntry);
    const now = new Date();

    const updated = await db
      .update(schema.queueAssetHealthTable)
      .set({
        state: "quarantined",
        lastErrorCode: opts.errorCode,
        lastError: opts.error,
        suggestedFix: opts.suggestedFix ?? row.suggestedFix,
        sourceHash: opts.sourceHash ?? row.sourceHash,
        nextRetryAt: row.state === "quarantined" ? row.nextRetryAt : new Date(now.getTime() + REPAIR_BACKOFF_MS[0]!),
        repairLog: newLog,
        updatedAt: now,
      })
      .where(eq(schema.queueAssetHealthTable.queueItemId, queueItemId))
      .returning();

    return rowToDto(updated[0]!);
  },

  /**
   * Mark as "repairing" — worker is now actively attempting to fix this item.
   */
  async markRepairing(queueItemId: string): Promise<AssetHealthRow> {
    const row = await this.getOrCreate(queueItemId);
    const logEntry: RepairLogEntry = {
      ts: new Date().toISOString(),
      actor: "system",
      action: "repair_started",
      detail: `Attempt ${row.repairAttempts + 1}/${MAX_REPAIR_ATTEMPTS}`,
      outcome: "pending",
    };
    const newLog = clampLog(row.repairLog, logEntry);
    const now = new Date();

    const updated = await db
      .update(schema.queueAssetHealthTable)
      .set({
        state: "repairing",
        lastRepairAt: now,
        repairAttempts: row.repairAttempts + 1,
        repairLog: newLog,
        updatedAt: now,
      })
      .where(eq(schema.queueAssetHealthTable.queueItemId, queueItemId))
      .returning();

    return rowToDto(updated[0]!);
  },

  /**
   * Record a repair attempt outcome.
   *
   * - success → transitions to "approved"
   * - failure with attempts < MAX → back to "quarantined" with back-off
   * - failure with attempts >= MAX → "blocked"
   */
  async recordRepairOutcome(
    queueItemId: string,
    outcome: "success" | "failure",
    detail: string,
  ): Promise<AssetHealthRow> {
    const row = await this.getOrCreate(queueItemId);
    const logEntry: RepairLogEntry = {
      ts: new Date().toISOString(),
      actor: "system",
      action: outcome === "success" ? "repair_succeeded" : "repair_failed",
      detail,
      outcome,
    };
    const newLog = clampLog(row.repairLog, logEntry);
    const now = new Date();

    let newState: QueueAssetHealthState;
    let nextRetry: Date | null = null;

    if (outcome === "success") {
      newState = "approved";
    } else if (row.repairAttempts >= MAX_REPAIR_ATTEMPTS) {
      newState = "blocked";
    } else {
      newState = "quarantined";
      nextRetry = new Date(now.getTime() + nextRetryAfterMs(row.repairAttempts));
    }

    const updated = await db
      .update(schema.queueAssetHealthTable)
      .set({
        state: newState,
        nextRetryAt: nextRetry,
        repairLog: newLog,
        updatedAt: now,
      })
      .where(eq(schema.queueAssetHealthTable.queueItemId, queueItemId))
      .returning();

    return rowToDto(updated[0]!);
  },

  /**
   * Mark as healthy (clears repair state).
   */
  async markHealthy(
    queueItemId: string,
    opts?: { actor?: "system" | "operator"; detail?: string },
  ): Promise<AssetHealthRow> {
    const row = await this.getOrCreate(queueItemId);
    const logEntry: RepairLogEntry = {
      ts: new Date().toISOString(),
      actor: opts?.actor ?? "system",
      action: "cleared_healthy",
      detail: opts?.detail ?? "Source verified reachable",
      outcome: "success",
    };
    const newLog = clampLog(row.repairLog, logEntry);

    const updated = await db
      .update(schema.queueAssetHealthTable)
      .set({
        state: "healthy",
        lastErrorCode: null,
        lastError: null,
        nextRetryAt: null,
        repairLog: newLog,
        updatedAt: new Date(),
      })
      .where(eq(schema.queueAssetHealthTable.queueItemId, queueItemId))
      .returning();

    return rowToDto(updated[0]!);
  },

  /**
   * Manual operator approval — force state to "approved".
   */
  async manualApprove(
    queueItemId: string,
    actor: string,
    reason?: string,
  ): Promise<AssetHealthRow> {
    const row = await this.getOrCreate(queueItemId);
    const logEntry: RepairLogEntry = {
      ts: new Date().toISOString(),
      actor: "operator",
      action: "manual_approve",
      detail: reason ? `${actor}: ${reason}` : `Approved by ${actor}`,
      outcome: "success",
    };
    const newLog = clampLog(row.repairLog, logEntry);

    const updated = await db
      .update(schema.queueAssetHealthTable)
      .set({
        state: "approved",
        nextRetryAt: null,
        repairLog: newLog,
        updatedAt: new Date(),
      })
      .where(eq(schema.queueAssetHealthTable.queueItemId, queueItemId))
      .returning();

    return rowToDto(updated[0]!);
  },

  /**
   * Manual operator quarantine.
   */
  async manualQuarantine(
    queueItemId: string,
    actor: string,
    reason: string,
  ): Promise<AssetHealthRow> {
    const row = await this.getOrCreate(queueItemId);
    const logEntry: RepairLogEntry = {
      ts: new Date().toISOString(),
      actor: "operator",
      action: "manual_quarantine",
      detail: `${actor}: ${reason}`,
      outcome: "pending",
    };
    const newLog = clampLog(row.repairLog, logEntry);
    const now = new Date();

    const updated = await db
      .update(schema.queueAssetHealthTable)
      .set({
        state: "quarantined",
        lastError: reason,
        lastErrorCode: "OPERATOR_QUARANTINE",
        nextRetryAt: new Date(now.getTime() + REPAIR_BACKOFF_MS[0]!),
        repairLog: newLog,
        updatedAt: now,
      })
      .where(eq(schema.queueAssetHealthTable.queueItemId, queueItemId))
      .returning();

    return rowToDto(updated[0]!);
  },

  /**
   * Reset repair state — clears attempts, error, and transitions to quarantined
   * so the worker will retry from scratch.
   */
  async resetRepair(
    queueItemId: string,
    actor: string,
  ): Promise<AssetHealthRow> {
    const row = await this.getOrCreate(queueItemId);
    const logEntry: RepairLogEntry = {
      ts: new Date().toISOString(),
      actor: "operator",
      action: "repair_reset",
      detail: `Reset by ${actor} — repair cycle restarted`,
      outcome: "pending",
    };
    const newLog = clampLog(row.repairLog, logEntry);

    const updated = await db
      .update(schema.queueAssetHealthTable)
      .set({
        state: "quarantined",
        repairAttempts: 0,
        lastRepairAt: null,
        nextRetryAt: new Date(),
        autoRepairPaused: false,
        repairLog: newLog,
        updatedAt: new Date(),
      })
      .where(eq(schema.queueAssetHealthTable.queueItemId, queueItemId))
      .returning();

    return rowToDto(updated[0]!);
  },

  /**
   * Toggle autoRepairPaused for a queue item.
   */
  async setPaused(queueItemId: string, paused: boolean, actor: string): Promise<AssetHealthRow> {
    const row = await this.getOrCreate(queueItemId);
    const logEntry: RepairLogEntry = {
      ts: new Date().toISOString(),
      actor: "operator",
      action: paused ? "auto_repair_paused" : "auto_repair_resumed",
      detail: `By ${actor}`,
      outcome: "success",
    };
    const newLog = clampLog(row.repairLog, logEntry);

    const updated = await db
      .update(schema.queueAssetHealthTable)
      .set({
        autoRepairPaused: paused,
        repairLog: newLog,
        updatedAt: new Date(),
      })
      .where(eq(schema.queueAssetHealthTable.queueItemId, queueItemId))
      .returning();

    return rowToDto(updated[0]!);
  },

  /**
   * Bulk upsert: ensure every active queue item ID has a health row.
   * Safe to call on every worker scan cycle.
   */
  async ensureRowsForItems(
    items: Array<{ id: string; videoId?: string | null }>,
  ): Promise<void> {
    if (items.length === 0) return;

    const existing = await db
      .select({ queueItemId: schema.queueAssetHealthTable.queueItemId })
      .from(schema.queueAssetHealthTable)
      .where(
        inArray(
          schema.queueAssetHealthTable.queueItemId,
          items.map((i) => i.id),
        ),
      );

    const existingIds = new Set(existing.map((e) => e.queueItemId));
    const toCreate = items.filter((i) => !existingIds.has(i.id));
    if (toCreate.length === 0) return;

    await db
      .insert(schema.queueAssetHealthTable)
      .values(
        toCreate.map((item) => ({
          id: randomUUID(),
          queueItemId: item.id,
          videoId: item.videoId ?? null,
          state: "healthy",
          repairAttempts: 0,
          repairLog: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      )
      .onConflictDoNothing();
  },

  /**
   * Remove orphaned health rows for queue items that no longer exist.
   */
  async pruneOrphans(): Promise<number> {
    try {
      const result = await db.execute<{ n: number }>(sql`
        DELETE FROM queue_asset_health qah
        WHERE NOT EXISTS (
          SELECT 1 FROM broadcast_queue bq
          WHERE bq.id = qah.queue_item_id
        )
        RETURNING qah.id
      `);
      return result.rows.length;
    } catch (err) {
      logger.warn({ err }, "[asset-health] pruneOrphans failed (non-fatal)");
      return 0;
    }
  },

  /**
   * Summary stats for the health dashboard.
   */
  async getSummary(): Promise<{
    healthy: number;
    quarantined: number;
    repairing: number;
    approved: number;
    blocked: number;
    total: number;
  }> {
    try {
      const rows = await db.execute<{
        state: string;
        n: number;
      }>(sql`
        SELECT state, COUNT(*)::int AS n
        FROM queue_asset_health
        GROUP BY state
      `);
      const counts = { healthy: 0, quarantined: 0, repairing: 0, approved: 0, blocked: 0 };
      for (const r of rows.rows) {
        const key = r.state as keyof typeof counts;
        if (key in counts) counts[key] = Number(r.n);
      }
      return { ...counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
    } catch {
      return { healthy: 0, quarantined: 0, repairing: 0, approved: 0, blocked: 0, total: 0 };
    }
  },

  MAX_REPAIR_ATTEMPTS,
  REPAIR_BACKOFF_MS,
};
