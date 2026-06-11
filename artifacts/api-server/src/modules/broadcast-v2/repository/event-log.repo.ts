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
   * Prune event log rows older than `maxAgeMs` milliseconds (default 24 h)
   * while preserving at least the last `seqFloor` sequences per channel.
   *
   * The dual guard prevents over-deletion: a low-volume channel might have
   * only 200 events per day but operators still need the full replay window
   * for a WS client that disconnects overnight and resumes with a stale
   * `lastSequence`. The sequence floor (default 5000) guarantees those
   * replay events are always available regardless of age.
   *
   * Iterates per-channel so each channel gets its own floor calculation.
   * In the current single-channel deployment this is one iteration; the
   * structure naturally extends to multi-channel without schema changes.
   */
  async pruneOldEvents(maxAgeMs = 24 * 60 * 60_000, seqFloor = 5000): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - maxAgeMs);
      // Get all active channels that have any events older than the cutoff
      // so we don't iterate channels that have nothing to prune.
      const channels = await db
        .selectDistinct({ channelId: t.channelId })
        .from(t)
        .where(lt(t.createdAt, cutoff));

      for (const { channelId } of channels) {
        // Find the sequence floor: the highest sequence in this channel minus
        // seqFloor. Any row with sequence >= floor is kept even if it's old,
        // because a reconnecting client with lastSequence = floor-1 needs to
        // replay those rows. Rows below the floor AND older than cutoff are safe to delete.
        const [lastSeqRow] = await db
          .select({ s: t.sequence })
          .from(t)
          .where(eq(t.channelId, channelId))
          .orderBy(desc(t.sequence))
          .limit(1);
        const lastSeq = lastSeqRow?.s ?? 0;
        const floor = Math.max(0, lastSeq - seqFloor);

        if (floor === 0) continue; // fewer than seqFloor events total — nothing safe to prune

        await db.delete(t).where(
          and(
            eq(t.channelId, channelId),
            lt(t.createdAt, cutoff),
            lt(t.sequence, floor),
          ),
        );
      }
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
