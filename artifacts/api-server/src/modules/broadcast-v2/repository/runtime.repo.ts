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
  failoverActive: boolean;
  failoverReason: string | null;
}

export interface PersistedBadUrlState {
  /** url → expiresAtMs */
  urlCache: Record<string, number>;
  /** itemId → consecutive failure count */
  skipCounts: Record<string, number>;
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
      failoverActive: row.failoverActive ?? false,
      failoverReason: row.failoverReason ?? null,
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
        failoverActive: rec.failoverActive,
        failoverReason: rec.failoverReason,
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
          failoverActive: rec.failoverActive,
          failoverReason: rec.failoverReason,
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

  /**
   * Persist the bad-URL blacklist and skip-count maps so they survive a
   * server restart. Writes only the `bad_url_cache` column — does not
   * clobber any other runtime state. Non-throwing; callers fire-and-forget.
   */
  async saveBadUrlCache(channelId: string, state: PersistedBadUrlState): Promise<void> {
    await db
      .update(t)
      .set({ badUrlCache: state as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(t.channelId, channelId));
  },

  /**
   * Load the persisted bad-URL state. Returns null when no row exists or
   * the column is NULL. The caller is responsible for filtering expired
   * urlCache entries by checking `expiresAtMs > Date.now()`.
   */
  async loadBadUrlCache(channelId: string): Promise<PersistedBadUrlState | null> {
    const [row] = await db
      .select({ badUrlCache: t.badUrlCache })
      .from(t)
      .where(eq(t.channelId, channelId))
      .limit(1);
    if (!row?.badUrlCache) return null;
    return row.badUrlCache as unknown as PersistedBadUrlState;
  },

  /**
   * Persist the media-integrity-scanner's per-item consecutive failure counts
   * so they survive process restarts. Writes only the `scanner_failure_counts`
   * column — does not clobber any other runtime state. Non-throwing; callers
   * fire-and-forget.
   */
  async saveFailureCounts(
    channelId: string,
    counts: Record<string, { count: number; lastFailedAtMs: number | null }>,
  ): Promise<void> {
    await db
      .update(t)
      .set({ scannerFailureCounts: counts as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(t.channelId, channelId));
  },

  /**
   * Load the persisted scanner failure counts. Returns null when no row exists
   * or the column is NULL (first boot, column just added, or deliberately cleared).
   */
  async loadFailureCounts(
    channelId: string,
  ): Promise<Record<string, { count: number; lastFailedAtMs: number | null }> | null> {
    const [row] = await db
      .select({ scannerFailureCounts: t.scannerFailureCounts })
      .from(t)
      .where(eq(t.channelId, channelId))
      .limit(1);
    if (!row?.scannerFailureCounts) return null;
    return row.scannerFailureCounts as unknown as Record<
      string,
      { count: number; lastFailedAtMs: number | null }
    >;
  },

  /**
   * Persist the current broadcast queue as a DB-backed snapshot so it survives
   * process restarts even when the broadcast_queue table is temporarily
   * unreachable. Primary DR source — eliminates the /tmp filesystem dependency.
   * Non-throwing; callers fire-and-forget.
   */
  async saveQueueBackup(
    channelId: string,
    backup: { channelId: string; savedAt: number; items: unknown[] },
  ): Promise<void> {
    await db
      .update(t)
      .set({ queueBackup: backup as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(t.channelId, channelId));
  },

  /**
   * Load the DB-backed queue snapshot. Returns null when no row exists, the
   * column is NULL, the backup is empty, or the savedAt timestamp is older
   * than 24 hours (pre-signed CDN URLs may have expired).
   */
  async loadQueueBackup(
    channelId: string,
  ): Promise<{ channelId: string; savedAt: number; items: unknown[] } | null> {
    const [row] = await db
      .select({ queueBackup: t.queueBackup })
      .from(t)
      .where(eq(t.channelId, channelId))
      .limit(1);
    if (!row?.queueBackup) return null;
    const backup = row.queueBackup as unknown as { channelId: string; savedAt: number; items: unknown[] };
    if (!Array.isArray(backup.items) || backup.items.length === 0) return null;
    return backup;
  },
};
