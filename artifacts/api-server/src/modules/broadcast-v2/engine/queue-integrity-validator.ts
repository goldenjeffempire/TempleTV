/**
 * Queue / media relationship integrity validator.
 *
 * Validates the active broadcast queue against the media library and
 * reports structural problems. Auto-fixes actionable issues:
 *
 *   NO_PLAYABLE_URL        — item has no URL on either the queue row or the
 *                            joined video row after COALESCE
 *   MISSING_BLOB           — item has a localVideoUrl but no corresponding row
 *                            in storage_blobs (blob was never assembled, was
 *                            deleted, or the key derivation failed).
 *                            AUTO-FIXED: item deactivated; reverse pass
 *                            re-activates when the blob appears.
 *   DUPLICATE_SORT_ORDER   — two or more items share the same sort_order;
 *                            queue ordering becomes non-deterministic
 *   EXCESSIVE_DURATION     — item duration > 12 h (likely data corruption)
 *   MISSING_VIDEO_JOIN     — videoId is set but the joined video row is NULL
 *                            (foreign-key violation — video was hard-deleted).
 *                            AUTO-FIXED: item logged; ops alerted.
 *   DUPLICATE_ACTIVE_VIDEO — same video_id appears in two or more active rows.
 *                            AUTO-FIXED: surplus rows deactivated.
 *   ORPHANED_VIDEO_REF     — queue item references a video that has no
 *                            playable URLs (video was deleted or never fully
 *                            uploaded)
 *   SUSPICIOUS_DURATION    — video.duration < 10 s — likely a probe failure;
 *                            background ffprobe reprobe auto-corrects it.
 *   ZERO_DURATION          — item carries zero or negative durationSecs.
 *
 * Results are cached and exposed via the /diagnostics endpoint. Non-fatal.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { sendBroadcastWebhook } from "../webhook/webhook.service.js";
import { db, schema } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { normalizeQueueUrl } from "../repository/queue.repo.js";

/**
 * Derive the storage_blobs key from a localVideoUrl.
 *
 * localVideoUrl formats seen in the wild:
 *   /api/v1/uploads/2024/01/15/abc.mp4        → uploads/2024/01/15/abc.mp4
 *   /api/uploads/2024/01/15/abc.mp4            → uploads/2024/01/15/abc.mp4
 *   https://api.../api/v1/uploads/path/f.mp4   → uploads/path/f.mp4
 *   uploads/2024/01/15/abc.mp4                 → uploads/2024/01/15/abc.mp4 (already a key)
 *
 * Returns null when the URL cannot be mapped to a storage key (e.g. external
 * YouTube URLs, HLS master playlists stored elsewhere, or malformed URLs).
 */
function deriveStorageKey(localVideoUrl: string): string | null {
  if (!localVideoUrl || localVideoUrl.trim() === "") return null;
  // Absolute URL — extract the path segment after /api/v[N]/uploads/ or /api/uploads/
  if (/^https?:\/\//i.test(localVideoUrl)) {
    const marker1 = "/api/v1/uploads/";
    const idx1 = localVideoUrl.indexOf(marker1);
    if (idx1 !== -1) return "uploads/" + localVideoUrl.slice(idx1 + marker1.length);
    const marker2 = "/api/uploads/";
    const idx2 = localVideoUrl.indexOf(marker2);
    if (idx2 !== -1) return "uploads/" + localVideoUrl.slice(idx2 + marker2.length);
    return null; // External URL — not in our storage
  }
  // Relative URL: /api/v1/uploads/... or /api/uploads/... or bare uploads/...
  const stripped = localVideoUrl.replace(/^\/(?:api\/(?:v\d+\/)?)?/, "");
  return stripped.startsWith("uploads/") ? stripped : null;
}

export type IssueSeverity = "error" | "warn" | "info";

export interface ValidationIssue {
  severity: IssueSeverity;
  itemId: string | null;
  itemTitle: string | null;
  code: string;
  message: string;
}

export interface ValidationReport {
  validatedAtMs: number;
  durationMs: number;
  totalItems: number;
  healthyItems: number;
  issues: ValidationIssue[];
  summary: { errors: number; warnings: number; infos: number };
}

class QueueIntegrityValidatorImpl {
  private lastReport: ValidationReport | null = null;
  private validating = false;
  /** Fingerprint of the last logged issue set — used to suppress duplicate WARN spam. */
  private lastIssueSig = "";

  async validate(): Promise<ValidationReport> {
    if (this.validating) return this.lastReport ?? this.empty();
    this.validating = true;
    const start = Date.now();
    const issues: ValidationIssue[] = [];

    try {
      const q = schema.broadcastQueueTable;
      const v = schema.videosTable;

      const rows = await db
        .select({
          id: q.id,
          title: q.title,
          videoId: q.videoId,
          durationSecs: q.durationSecs,
          sortOrder: q.sortOrder,
          qLocalUrl: q.localVideoUrl,
          videoId2: v.id,
          vLocalUrl: v.localVideoUrl,
          vDuration: v.duration,
          vSource: v.videoSource,
        })
        .from(q)
        .leftJoin(v, eq(q.videoId, v.id))
        .where(eq(q.isActive, true))
        .orderBy(asc(q.sortOrder))
        .limit(2000);

      // Items with placeholder 1800s on the queue row but a real duration on the
      // joined video row — collected for a single-pass DB UPDATE at the end.
      const placeholderDurationItems: Array<{ id: string; realDur: number }> = [];

      for (const row of rows) {
        // A playable URL is the local MP4 URL on either the queue row itself or
        // the joined managed_videos row (platform is MP4-only).
        const hasAnyUrl = row.qLocalUrl || row.vLocalUrl;

        if (!hasAnyUrl) {
          issues.push({
            severity: "error",
            itemId: row.id,
            itemTitle: row.title,
            code: "NO_PLAYABLE_URL",
            message: "Item has no playable URL on queue row or joined video row",
          });
        }

        if (row.videoId && row.videoId2 === null) {
          issues.push({
            severity: "error",
            itemId: row.id,
            itemTitle: row.title,
            code: "MISSING_VIDEO_JOIN",
            message: `videoId '${row.videoId}' references a video row that no longer exists (hard-deleted)`,
          });
        }

        // ORPHANED_VIDEO_REF: the joined video row exists but has no playable URL
        // on it at all (neither a local MP4 on the queue row nor on the video row).
        if (row.videoId && row.videoId2 !== null && !row.vLocalUrl && !row.qLocalUrl) {
          issues.push({
            severity: "error",
            itemId: row.id,
            itemTitle: row.title,
            code: "ORPHANED_VIDEO_REF",
            message: `Video '${row.videoId}' exists but has no playable URL — upload may be incomplete`,
          });
        }

        // Detect suspiciously short probe results — likely a probe-failure from
        // the moov-atom upload race. Duration will self-correct via naturalItemEnd.
        if (row.vDuration) {
          const vDur = parseFloat(row.vDuration);
          if (!isNaN(vDur) && vDur > 0 && vDur < 10) {
            issues.push({
              severity: "warn",
              itemId: row.id,
              itemTitle: row.title,
              code: "SUSPICIOUS_DURATION",
              message: `video.duration='${row.vDuration}' is < 10 s — likely a probe failure from an upload race; re-upload video to fix`,
            });
          }
        }

        if (row.durationSecs > 12 * 3_600) {
          issues.push({
            severity: "warn",
            itemId: row.id,
            itemTitle: row.title,
            code: "EXCESSIVE_DURATION",
            message: `Duration is ${Math.round(row.durationSecs / 3_600)} h — possible data corruption`,
          });
        }

        if (row.durationSecs <= 0) {
          issues.push({
            severity: "warn",
            itemId: row.id,
            itemTitle: row.title,
            code: "ZERO_DURATION",
            message: `Item has durationSecs=${row.durationSecs} — orchestrator applies a 60 s floor; re-probe the source file or correct the duration`,
          });
        }

        // NOTE: FASTSTART_PENDING check removed. Raw MP4 (moov at EOF) is
        // admitted to the broadcast queue directly — HTTP byte-range streaming
        // works regardless of moov position. The faststartRecoveryWorker
        // upgrades quality in the background; no de-queuing is required.

        // Detect 1800-s placeholder where the joined managed_videos row already
        // has a real duration.  We collect these for a single-pass DB fix below
        // so the orchestrator picks up the real duration on its next reload and
        // the naturalItemEnd guard uses the correct 5 % threshold (not 90 s).
        if (row.durationSecs === 1800 && row.videoId2 !== null && row.vDuration) {
          const realDur = parseFloat(row.vDuration);
          if (Number.isFinite(realDur) && realDur > 10 && realDur < 86_400 && Math.round(realDur) !== 1800) {
            placeholderDurationItems.push({ id: row.id, realDur });
            issues.push({
              severity: "info",
              itemId: row.id,
              itemTitle: row.title,
              code: "PLACEHOLDER_DURATION",
              message: `Queue row still carries 1800-s placeholder but managed_videos.duration=${row.vDuration} — auto-correcting`,
            });
          }
        }
      }

      // ── MISSING_BLOB: localVideoUrl set but no blob in storage_blobs ──────
      // Even though a queue item may have a localVideoUrl, the underlying
      // storage_blobs row can be absent (upload never completed, blob was
      // deleted manually, or the key derivation is stale after a migration).
      // The orchestrator will fail at play time with "Blob not found in storage"
      // for every attempt, causing repeated auto-skip cycles.
      //
      // Strategy: batch-derive storage keys for all items that have a URL,
      // then single-query storage_blobs to check which keys are present.
      // Only items with a derivable "uploads/" key are checked — external URLs
      // (YouTube, HLS CDN) are skipped.
      {
        type BlobCheckEntry = { itemId: string; itemTitle: string; key: string };
        const blobCheckEntries: BlobCheckEntry[] = [];

        for (const row of rows) {
          // Only check items that have a URL (no URL → already flagged NO_PLAYABLE_URL)
          const effectiveUrl = row.qLocalUrl ?? row.vLocalUrl;
          if (!effectiveUrl) continue;
          const key = deriveStorageKey(effectiveUrl);
          if (!key) continue; // External/YouTube/CDN URL — not in our storage
          blobCheckEntries.push({
            itemId: row.id,
            itemTitle: row.title ?? "(untitled)",
            key,
          });
        }

        if (blobCheckEntries.length > 0) {
          try {
            const keysToCheck = blobCheckEntries.map((e) => e.key);
            const presentRows = await db
              .select({ key: schema.storageBlobsTable.key })
              .from(schema.storageBlobsTable)
              .where(inArray(schema.storageBlobsTable.key, keysToCheck));
            const presentSet = new Set(presentRows.map((r) => r.key));

            for (const entry of blobCheckEntries) {
              if (!presentSet.has(entry.key)) {
                issues.push({
                  severity: "error",
                  itemId: entry.itemId,
                  itemTitle: entry.itemTitle,
                  code: "MISSING_BLOB",
                  message:
                    `storage_blobs has no row for key="${entry.key}" — ` +
                    "the blob was never assembled, was deleted, or the upload failed. " +
                    "Re-upload the video to restore it.",
                });
              }
            }
          } catch (blobCheckErr) {
            logger.warn(
              { err: blobCheckErr },
              "[queue-validator] MISSING_BLOB check failed (non-fatal) — skipping blob verification this cycle",
            );
          }
        }
      }

      const sortOrders = new Map<number, string[]>();
      for (const row of rows) {
        const ids = sortOrders.get(row.sortOrder) ?? [];
        ids.push(row.id);
        sortOrders.set(row.sortOrder, ids);
      }
      const duplicateItemIds: string[] = [];
      for (const [order, ids] of sortOrders) {
        if (ids.length > 1) {
          issues.push({
            severity: "warn",
            itemId: null,
            itemTitle: null,
            code: "DUPLICATE_SORT_ORDER",
            message: `sort_order=${order} shared by ${ids.length} items: ${ids.join(", ")}`,
          });
          for (const id of ids) duplicateItemIds.push(id);
        }
      }

      // ── DUPLICATE_ACTIVE_VIDEO — same video_id in two or more active rows ──
      const videoIdSeen = new Map<string, string[]>();
      for (const row of rows) {
        if (!row.videoId) continue;
        const ids = videoIdSeen.get(row.videoId) ?? [];
        ids.push(row.id);
        videoIdSeen.set(row.videoId, ids);
      }
      const duplicateVideoItemIds: string[] = [];
      for (const [vid, ids] of videoIdSeen) {
        if (ids.length > 1) {
          issues.push({
            severity: "error",
            itemId: null,
            itemTitle: null,
            code: "DUPLICATE_ACTIVE_VIDEO",
            message: `video_id '${vid}' appears in ${ids.length} active queue items: ${ids.join(", ")}`,
          });
          for (let i = 1; i < ids.length; i++) duplicateVideoItemIds.push(ids[i]!);
        }
      }

      // ── Auto-fix: deactivate surplus DUPLICATE_ACTIVE_VIDEO items ──────────
      if (duplicateVideoItemIds.length > 0) {
        try {
          await db
            .update(schema.broadcastQueueTable)
            .set({
              isActive: false,
              validatorDeactivatedReason: "duplicate_active_video",
            })
            .where(inArray(schema.broadcastQueueTable.id, duplicateVideoItemIds));
          logger.error(
            { count: duplicateVideoItemIds.length, itemIds: duplicateVideoItemIds },
            "[queue-validator] AUTO-FIX: deactivated DUPLICATE_ACTIVE_VIDEO surplus items " +
            "— same video_id appeared more than once in the active queue; " +
            "lowest-sort_order copy kept, extras deactivated",
          );
          adminEventBus.push("broadcast-queue-updated", {
            reason: "integrity-fix-duplicate-active-video",
            count: duplicateVideoItemIds.length,
          });
          adminEventBus.push("videos-library-updated", {
            reason: "integrity-fix-duplicate-active-video",
            count: duplicateVideoItemIds.length,
          });
          sendBroadcastWebhook("item_deactivated", "main", {
            reason: "duplicate_active_video",
            count: duplicateVideoItemIds.length,
            itemIds: duplicateVideoItemIds,
          });
        } catch (fixErr) {
          logger.warn(
            { err: fixErr, count: duplicateVideoItemIds.length },
            "[queue-validator] AUTO-FIX: failed to deactivate DUPLICATE_ACTIVE_VIDEO surplus items (non-fatal)",
          );
        }
      }

      // ── Auto-fix: reassign sort_order for DUPLICATE_SORT_ORDER items ───────
      if (duplicateItemIds.length > 0) {
        try {
          const freshRows = await db
            .select({ id: q.id })
            .from(q)
            .where(eq(q.isActive, true))
            .orderBy(asc(q.sortOrder));

          await db.transaction(async (tx) => {
            for (let i = 0; i < freshRows.length; i++) {
              const row = freshRows[i]!;
              await tx
                .update(schema.broadcastQueueTable)
                .set({ sortOrder: (i + 1) * 10 })
                .where(eq(schema.broadcastQueueTable.id, row.id));
            }
          });

          logger.warn(
            { count: duplicateItemIds.length, totalReassigned: freshRows.length },
            "[queue-validator] AUTO-FIX: reassigned sort_order for all active items to restore deterministic queue ordering",
          );
          adminEventBus.push("broadcast-queue-updated", {
            reason: "integrity-fix-duplicate-sort-order",
            count: duplicateItemIds.length,
          });
          adminEventBus.push("videos-library-updated", {
            reason: "integrity-fix-duplicate-sort-order",
            count: duplicateItemIds.length,
          });
        } catch (fixErr) {
          logger.warn(
            { err: fixErr, count: duplicateItemIds.length },
            "[queue-validator] AUTO-FIX: failed to reassign sort_order for DUPLICATE_SORT_ORDER items (non-fatal)",
          );
        }
      }

      // ── Auto-fix: deactivate MISSING_VIDEO_JOIN items ────────────────────
      // Items whose referenced managed_videos row no longer exists are
      // deactivated so the orchestrator stops serving them. Without this fix,
      // items whose referenced video was hard-deleted keep entering the
      // broadcast cycle — they have no playable URL and cause repeated
      // auto-skip cycles. The reverse pass below re-activates them if the
      // video row is later restored.
      const missingJoinIds = issues
        .filter((i) => i.severity === "error" && i.code === "MISSING_VIDEO_JOIN" && i.itemId)
        .map((i) => i.itemId!);
      if (missingJoinIds.length > 0) {
        try {
          await db
            .update(schema.broadcastQueueTable)
            .set({ isActive: false, validatorDeactivatedReason: "missing_video_join" })
            .where(inArray(schema.broadcastQueueTable.id, missingJoinIds));
          logger.warn(
            { count: missingJoinIds.length, itemIds: missingJoinIds },
            "[queue-validator] AUTO-FIX: deactivated MISSING_VIDEO_JOIN items — referenced managed_videos rows are absent; " +
            "re-upload or restore the video to return these items to rotation",
          );
          adminEventBus.push("broadcast-queue-updated", {
            reason: "integrity-fix-missing-video-join",
            count: missingJoinIds.length,
          });
        } catch (fixErr) {
          logger.warn(
            { err: fixErr, count: missingJoinIds.length },
            "[queue-validator] AUTO-FIX: failed to deactivate MISSING_VIDEO_JOIN items (non-fatal)",
          );
        }
      }

      // ── Auto-fix (reverse): re-activate items deactivated by MISSING_VIDEO_JOIN ──
      {
        type RestoredRow = { id: string; title: string };
        let restoredRows: RestoredRow[] = [];
        try {
          const result = await db.execute<RestoredRow>(sql`
            SELECT bq.id, bq.title
            FROM broadcast_queue bq
            INNER JOIN managed_videos mv ON mv.id = bq.video_id
            WHERE bq.is_active = false
              AND bq.validator_deactivated_reason = 'missing_video_join'
              AND mv.local_video_url IS NOT NULL
          `);
          restoredRows = (result.rows as RestoredRow[]) ?? [];
        } catch (qErr) {
          logger.debug(
            { err: qErr },
            "[queue-validator] reverse-MISSING_VIDEO_JOIN query failed (non-fatal)",
          );
        }

        if (restoredRows.length > 0) {
          const restoredIds = restoredRows.map((r) => r.id);
          try {
            await db
              .update(schema.broadcastQueueTable)
              .set({ isActive: true, validatorDeactivatedReason: null })
              .where(inArray(schema.broadcastQueueTable.id, restoredIds));
            logger.warn(
              { count: restoredIds.length, itemIds: restoredIds },
              "[queue-validator] AUTO-FIX (reverse): re-activated broadcast_queue items " +
              "whose managed_videos row was restored — items returned to broadcast rotation",
            );
            adminEventBus.push("broadcast-queue-updated", {
              reason: "integrity-fix-restored-video-join",
              count: restoredIds.length,
            });
            adminEventBus.push("videos-library-updated", {
              reason: "integrity-fix-restored-video-join",
              count: restoredIds.length,
            });
          } catch (fixErr) {
            logger.warn(
              { err: fixErr, count: restoredIds.length },
              "[queue-validator] AUTO-FIX (reverse): failed to re-activate restored items (non-fatal)",
            );
          }
        }
      }

      // ── Auto-fix: deactivate MISSING_BLOB items ──────────────────────────
      // Items whose storage blob is absent are removed from the active rotation
      // so the orchestrator stops trying to play them (repeated source resolution
      // failures drive the auto-skip counter up and cause dead-air bursts).
      // The reverse pass below re-activates them when the blob is restored
      // (e.g. after a successful re-upload or a manual blob repair).
      const missingBlobIds = issues
        .filter((i) => i.severity === "error" && i.code === "MISSING_BLOB" && i.itemId)
        .map((i) => i.itemId!);
      if (missingBlobIds.length > 0) {
        try {
          await db
            .update(schema.broadcastQueueTable)
            .set({ isActive: false, validatorDeactivatedReason: "missing_blob" })
            .where(inArray(schema.broadcastQueueTable.id, missingBlobIds));
          logger.error(
            { count: missingBlobIds.length, itemIds: missingBlobIds },
            "[queue-validator] AUTO-FIX: deactivated MISSING_BLOB items — storage_blobs has no row " +
            "for their localVideoUrl key; re-upload or restore the video blob to return them to rotation",
          );
          adminEventBus.push("broadcast-queue-updated", {
            reason: "integrity-fix-missing-blob",
            count: missingBlobIds.length,
          });
          adminEventBus.push("videos-library-updated", {
            reason: "integrity-fix-missing-blob",
            count: missingBlobIds.length,
          });
          sendBroadcastWebhook("item_deactivated", "main", {
            reason: "missing_blob",
            count: missingBlobIds.length,
            itemIds: missingBlobIds,
          });
        } catch (fixErr) {
          logger.warn(
            { err: fixErr, count: missingBlobIds.length },
            "[queue-validator] AUTO-FIX: failed to deactivate MISSING_BLOB items (non-fatal)",
          );
        }
      }

      // ── Auto-fix (reverse): re-activate MISSING_BLOB items whose blob is now present ──
      {
        type BlobRestoredRow = { id: string; title: string; local_video_url: string | null; q_local_url: string | null };
        let blobRestoredRows: BlobRestoredRow[] = [];
        try {
          const result = await db.execute<BlobRestoredRow>(sql`
            SELECT bq.id, bq.title, mv.local_video_url, bq.local_video_url AS q_local_url
            FROM broadcast_queue bq
            LEFT JOIN managed_videos mv ON mv.id = bq.video_id
            WHERE bq.is_active = false
              AND bq.validator_deactivated_reason = 'missing_blob'
          `);
          blobRestoredRows = (result.rows as BlobRestoredRow[]) ?? [];
        } catch (qErr) {
          logger.debug({ err: qErr }, "[queue-validator] reverse-MISSING_BLOB query failed (non-fatal)");
        }

        if (blobRestoredRows.length > 0) {
          // For each deactivated item, check if its blob is now present.
          const reactivatableIds: string[] = [];
          try {
            const withKeys = blobRestoredRows.flatMap((r) => {
              const effectiveUrl = r.q_local_url ?? r.local_video_url;
              if (!effectiveUrl) return [];
              const key = deriveStorageKey(effectiveUrl);
              if (!key) return [];
              return [{ id: r.id, key }];
            });

            if (withKeys.length > 0) {
              const keys = withKeys.map((e) => e.key);
              const presentRows = await db
                .select({ key: schema.storageBlobsTable.key })
                .from(schema.storageBlobsTable)
                .where(inArray(schema.storageBlobsTable.key, keys));
              const presentSet = new Set(presentRows.map((r) => r.key));
              for (const entry of withKeys) {
                if (presentSet.has(entry.key)) reactivatableIds.push(entry.id);
              }
            }
          } catch (blobCheckErr) {
            logger.debug({ err: blobCheckErr }, "[queue-validator] reverse-MISSING_BLOB blob check failed (non-fatal)");
          }

          if (reactivatableIds.length > 0) {
            try {
              await db
                .update(schema.broadcastQueueTable)
                .set({ isActive: true, validatorDeactivatedReason: null })
                .where(inArray(schema.broadcastQueueTable.id, reactivatableIds));
              logger.info(
                { count: reactivatableIds.length, itemIds: reactivatableIds },
                "[queue-validator] AUTO-FIX (reverse): re-activated MISSING_BLOB items " +
                "whose storage blob has been restored — items returned to broadcast rotation",
              );
              adminEventBus.push("broadcast-queue-updated", {
                reason: "integrity-fix-blob-restored",
                count: reactivatableIds.length,
              });
              adminEventBus.push("videos-library-updated", {
                reason: "integrity-fix-blob-restored",
                count: reactivatableIds.length,
              });
            } catch (fixErr) {
              logger.warn(
                { err: fixErr, count: reactivatableIds.length },
                "[queue-validator] AUTO-FIX (reverse): failed to re-activate MISSING_BLOB items (non-fatal)",
              );
            }
          }
        }
      }

      // NOTE: FASTSTART_PENDING auto-fix removed — raw MP4 admitted directly.
      // No de-queuing for faststart_pending reason is performed.

      // ── Auto-fix (reverse): re-activate ORPHANED_VIDEO_REF items that now have a local URL ──
      {
        type RevivedRow = { id: string; title: string };
        let revivedRows: RevivedRow[] = [];
        try {
          const result = await db.execute<RevivedRow>(sql`
            SELECT bq.id, bq.title
            FROM broadcast_queue bq
            INNER JOIN managed_videos mv ON mv.id = bq.video_id
            WHERE bq.is_active = false
              AND bq.validator_deactivated_reason = 'orphaned_video_ref'
              AND mv.local_video_url IS NOT NULL
          `);
          revivedRows = (result.rows as RevivedRow[]) ?? [];
        } catch (qErr) {
          logger.debug(
            { err: qErr },
            "[queue-validator] reverse-ORPHANED_VIDEO_REF query failed (non-fatal)",
          );
        }

        if (revivedRows.length > 0) {
          const revivedIds = revivedRows.map((r) => r.id);
          try {
            await db
              .update(schema.broadcastQueueTable)
              .set({ isActive: true, validatorDeactivatedReason: null })
              .where(inArray(schema.broadcastQueueTable.id, revivedIds));
            logger.warn(
              { count: revivedIds.length, itemIds: revivedIds },
              "[queue-validator] AUTO-FIX (reverse): re-activated ORPHANED_VIDEO_REF items " +
              "whose video now has a local URL — items returned to broadcast rotation",
            );
            adminEventBus.push("broadcast-queue-updated", {
              reason: "integrity-fix-revived-orphaned-video-ref",
              count: revivedIds.length,
            });
            adminEventBus.push("videos-library-updated", {
              reason: "integrity-fix-revived-orphaned-video-ref",
              count: revivedIds.length,
            });
          } catch (fixErr) {
            logger.warn(
              { err: fixErr, count: revivedIds.length },
              "[queue-validator] AUTO-FIX (reverse): failed to re-activate ORPHANED_VIDEO_REF items (non-fatal)",
            );
          }
        }
      }

      // ── Auto-fix: repair PLACEHOLDER_DURATION items ────────────────────────
      // When the queue row carries the 1800-s upload-time sentinel but the joined
      // managed_videos row already holds a real probe duration, write it into
      // broadcast_queue in a single UPDATE so the orchestrator's next reload sees
      // the correct value.  No event is fired here — the orchestrator's drift-poll
      // will pick up the change within 10 s.
      if (placeholderDurationItems.length > 0) {
        try {
          for (const fix of placeholderDurationItems) {
            await db.execute(sql`
              UPDATE broadcast_queue
              SET duration_secs = ${Math.round(fix.realDur)}
              WHERE id = ${fix.id}
                AND duration_secs = 1800
            `);
          }
          logger.info(
            { count: placeholderDurationItems.length },
            "[queue-validator] AUTO-FIX: corrected PLACEHOLDER_DURATION (1800 s) → real duration for queue rows",
          );
          adminEventBus.push("broadcast-queue-updated", {
            reason: "integrity-fix-placeholder-duration",
            count: placeholderDurationItems.length,
          });
        } catch (fixErr) {
          logger.warn(
            { err: fixErr, count: placeholderDurationItems.length },
            "[queue-validator] AUTO-FIX: placeholder duration repair failed (non-fatal)",
          );
        }
      }

      // SUSPICIOUS_DURATION auto-reprobe removed: videos broadcast directly
      // via their original MP4 source. Duration will self-correct via
      // naturalItemEnd write-back when the item completes a full play cycle.

      const errorIds = new Set(issues.filter((i) => i.severity === "error" && i.itemId).map((i) => i.itemId!));
      const healthyItems = rows.filter((r) => !errorIds.has(r.id)).length;
      const report: ValidationReport = {
        validatedAtMs: start,
        durationMs: Date.now() - start,
        totalItems: rows.length,
        healthyItems,
        issues,
        summary: {
          errors: issues.filter((i) => i.severity === "error").length,
          warnings: issues.filter((i) => i.severity === "warn").length,
          infos: issues.filter((i) => i.severity === "info").length,
        },
      };

      this.lastReport = report;

      const sig = issues.map((i) => `${i.code}:${i.itemId ?? ""}:${i.message}`).sort().join("|");
      if (issues.length > 0) {
        if (sig !== this.lastIssueSig) {
          logger.warn(
            { errors: report.summary.errors, warnings: report.summary.warnings, total: rows.length },
            "[queue-validator] validation found issues",
          );
          this.lastIssueSig = sig;
          adminEventBus.push("broadcast-v2-queue-issues", {
            errors: report.summary.errors,
            warnings: report.summary.warnings,
            total: rows.length,
            issues: issues.map((i) => ({ code: i.code, severity: i.severity, message: i.message })),
          });
        }
      } else {
        if (this.lastIssueSig !== "") {
          logger.info({ total: rows.length }, "[queue-validator] all queue items healthy");
          this.lastIssueSig = "";
          adminEventBus.push("broadcast-v2-queue-issues", { errors: 0, warnings: 0, total: rows.length, issues: [] });
        }
      }
      return report;
    } catch (err) {
      logger.warn({ err }, "[queue-validator] validation failed (non-fatal)");
      return this.empty();
    } finally {
      this.validating = false;
    }
  }

  getLastReport(): ValidationReport | null {
    return this.lastReport;
  }

  private empty(): ValidationReport {
    return {
      validatedAtMs: Date.now(),
      durationMs: 0,
      totalItems: 0,
      healthyItems: 0,
      issues: [],
      summary: { errors: 0, warnings: 0, infos: 0 },
    };
  }
}

export const queueIntegrityValidator = new QueueIntegrityValidatorImpl();
