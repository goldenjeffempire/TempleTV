import { and, desc, eq, gt, lt } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";

const t = schema.broadcastEventLogTable;

const MAX_RETENTION_PER_CHANNEL = 1000;

/**
 * Maximum JSON payload size (bytes) that will be stored in the event log.
 * Payloads exceeding this are replaced with a truncation sentinel so a
 * runaway accumulator (e.g. a bug producing giant override payloads) never
 * causes ERR_STRING_TOO_LONG when the JSONB column is read back, never
 * bloats the table, and never triggers a pg query-string-length error.
 */
const MAX_PAYLOAD_JSON_BYTES = 64 * 1024; // 64 KB

export const eventLogRepo = {
  async append(channelId: string, sequence: number, eventType: string, payload: unknown): Promise<void> {
    // Guard against oversized payloads before they reach the DB.
    let safePayload: unknown = payload;
    try {
      const json = JSON.stringify(payload);
      if (json.length > MAX_PAYLOAD_JSON_BYTES) {
        logger.warn(
          { channelId, sequence, eventType, jsonBytes: json.length, cap: MAX_PAYLOAD_JSON_BYTES },
          "[broadcast-v2] event log payload truncated — exceeds 64 KB cap",
        );
        safePayload = {
          _truncated: true,
          _originalBytes: json.length,
          _cap: MAX_PAYLOAD_JSON_BYTES,
          eventType,
        };
      }
    } catch (serErr) {
      logger.warn(
        { serErr, channelId, sequence, eventType },
        "[broadcast-v2] event log payload serialization failed — storing sentinel",
      );
      safePayload = { _truncated: true, _serializationError: true, eventType };
    }

    try {
      await db.insert(t).values({ channelId, sequence, eventType, payload: safePayload as object });
    } catch (err) {
      // Sequence collisions indicate a programming error — log loudly but don't crash.
      logger.error({ err, channelId, sequence, eventType }, "[broadcast-v2] event log append failed");
    }
  },

  async replayFrom(channelId: string, fromSequence: number, limit = 200) {
    return db
      .select()
      .from(t)
      .where(and(eq(t.channelId, channelId), gt(t.sequence, fromSequence)))
      .orderBy(t.sequence)
      .limit(limit);
  },

  async lastSequence(channelId: string): Promise<number> {
    const [row] = await db
      .select({ s: t.sequence })
      .from(t)
      .where(eq(t.channelId, channelId))
      .orderBy(desc(t.sequence))
      .limit(1);
    return row?.s ?? 0;
  },

  /**
   * Prune event log rows older than `maxAgeMs` milliseconds (default 24 h).
   *
   * Complements the per-channel sequence-based trim() — that one keeps the
   * last 1000 events regardless of age. This one clears out long-lived
   * channels where 1000 events span multiple days and old rows accumulate
   * indefinitely. Called by a WorkerSupervisor task every 6 h.
   *
   * Deletes across ALL channels in one query so a single sweep handles
   * multi-channel deployments correctly.
   */
  async pruneOldEvents(maxAgeMs = 24 * 60 * 60_000): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - maxAgeMs);
      await db.delete(t).where(lt(t.createdAt, cutoff));
    } catch (err) {
      logger.warn({ err }, "[broadcast-v2] event log prune failed (non-fatal)");
    }
  },

  /** Trim event log to the last MAX_RETENTION_PER_CHANNEL rows per channel. */
  async trim(channelId: string): Promise<void> {
    try {
      const [{ s: cutoffSeq } = { s: 0 }] = await db
        .select({ s: t.sequence })
        .from(t)
        .where(eq(t.channelId, channelId))
        .orderBy(desc(t.sequence))
        .limit(1)
        .offset(MAX_RETENTION_PER_CHANNEL);
      if (cutoffSeq && cutoffSeq > 0) {
        await db.delete(t).where(and(eq(t.channelId, channelId), lt(t.sequence, cutoffSeq)));
      }
    } catch (err) {
      logger.warn({ err, channelId }, "[broadcast-v2] event log trim failed");
    }
  },
};
