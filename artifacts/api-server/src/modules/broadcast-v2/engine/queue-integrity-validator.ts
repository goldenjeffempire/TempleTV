/**
 * Queue / media relationship integrity validator.
 *
 * Validates the active broadcast queue against the media library and
 * reports structural problems. Auto-fixes actionable issues:
 *
 *   ORPHANED_VIDEO_REF     — queue item references a video that has no
 *                            playable URLs (video was deleted or never fully
 *                            uploaded)
 *   NO_PLAYABLE_URL        — item has no URL on either the queue row or the
 *                            joined video row after COALESCE
 *   PLACEHOLDER_DURATION   — item still carries the 1800 s upload-time
 *                            placeholder; ffprobe has not run yet
 *   DUPLICATE_SORT_ORDER   — two or more items share the same sort_order;
 *                            queue ordering becomes non-deterministic
 *   EXCESSIVE_DURATION     — item duration > 12 h (likely data corruption)
 *   MISSING_VIDEO_JOIN     — videoId is set but the joined video row is NULL
 *                            (foreign-key violation — video was hard-deleted).
 *                            AUTO-FIXED: item is deactivated (is_active=false)
 *                            so the orchestrator stops serving it. Without this
 *                            fix, items whose referenced video was hard-deleted
 *                            keep entering the broadcast cycle — they have no
 *                            playable URL (if the queue row itself has no URL)
 *                            and cause repeated auto-skip cycles, or they air
 *                            a stale URL that will 404 to every client.
 *
 * Results are cached and exposed via the /diagnostics endpoint. Non-fatal.
 */
import { spawn } from "node:child_process";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { normalizeQueueUrl } from "../repository/queue.repo.js";

// ── Duration probe helper ─────────────────────────────────────────────────────
//
// Lightweight ffprobe call that reads only the container header from a URL.
// Used by the SUSPICIOUS_DURATION auto-reprobe path to correct stale < 10 s
// duration values written during the moov-atom upload race.  Probes the URL
// directly (ffprobe handles HTTP/HTTPS with range-request reads, so only the
// moov atom is transferred — no full file download needed).
//
// Returns null on any failure (ffprobe unavailable, timeout, corrupt header).

async function probeDurationFromUrl(url: string): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    let proc: ReturnType<typeof spawn> | null = null;
    try {
      proc = spawn("ffprobe", [
        "-v", "quiet",
        "-print_format", "json",
        "-show_entries", "format=duration",
        url,
      ]);
    } catch {
      resolve(null);
      return;
    }
    let stdout = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    const t = setTimeout(() => { try { proc?.kill(); } catch { /**/ } resolve(null); }, 45_000);
    proc.on("close", () => {
      clearTimeout(t);
      try {
        const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
        const dur = parseFloat(parsed.format?.duration ?? "");
        resolve(!isNaN(dur) && dur > 0 ? dur : null);
      } catch { resolve(null); }
    });
    proc.on("error", () => { clearTimeout(t); resolve(null); });
  });
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
          qHlsUrl: q.hlsMasterUrl,
          videoId2: v.id,
          vLocalUrl: v.localVideoUrl,
          vHlsUrl: v.hlsMasterUrl,
          vDuration: v.duration,
          vSource: v.videoSource,
          vStatus: v.transcodingStatus,
          vFaststart: v.faststartApplied,
          vErrCode: v.transcodingErrorCode,
        })
        .from(q)
        .leftJoin(v, eq(q.videoId, v.id))
        .where(eq(q.isActive, true))
        .orderBy(asc(q.sortOrder));

      // Items with SUSPICIOUS_DURATION collected here for background reprobe
      // after the main issue-detection loop (max 3 per cycle).
      const suspiciousDurationItems: Array<{ id: string; videoId: string; localUrl: string }> = [];

      for (const row of rows) {
        const hasAnyUrl =
          row.qHlsUrl || row.qLocalUrl || row.vHlsUrl || row.vLocalUrl;

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

        if (row.videoId && row.videoId2 !== null && !row.vLocalUrl && !row.vHlsUrl) {
          issues.push({
            severity: "error",
            itemId: row.id,
            itemTitle: row.title,
            code: "ORPHANED_VIDEO_REF",
            message: `Video '${row.videoId}' exists but has no playable URLs — upload may be incomplete`,
          });
        }

        // UNPLAYABLE_CORRUPT_UPLOAD: video transcoding permanently failed AND
        // the source file is known-unplayable (no moov atom / CORRUPT_SOURCE error
        // OR faststart was never applied). Without HLS there is no fallback stream.
        // These items WILL cause repeated auto-skip cycles every tick — they must
        // be deactivated immediately to stop burning skip budget. The auto-fix
        // below handles the deactivation; the reverse pass re-activates them if
        // HLS ever becomes available (e.g. via remote re-transcode).
        if (
          row.videoId &&
          row.videoId2 !== null &&
          !row.qHlsUrl &&
          !row.vHlsUrl &&
          row.vStatus === "failed"
        ) {
          const isCorrupt = row.vErrCode === "CORRUPT_SOURCE";
          const isSourceMissing = row.vErrCode === "SOURCE_MISSING";
          const isDiskFull = row.vErrCode === "DISK_FULL";
          const noFaststart = !row.vFaststart;
          if (isCorrupt || isSourceMissing || noFaststart) {
            issues.push({
              severity: "error",
              itemId: row.id,
              itemTitle: row.title,
              code: "UNPLAYABLE_CORRUPT_UPLOAD",
              message:
                `Video '${row.videoId}' has transcodingStatus='failed' with ` +
                (isCorrupt
                  ? "CORRUPT_SOURCE error — moov atom absent; re-upload the source file"
                  : isSourceMissing
                  ? "SOURCE_MISSING error — source blob deleted from storage; re-upload the source file"
                  : isDiskFull
                  ? "DISK_FULL error — transcoding failed due to insufficient disk space; free disk space and use Retry to re-transcode"
                  : "faststartApplied=false — moov at EOF, raw MP4 cannot be streamed; re-transcode or re-upload the source file") +
                " and no HLS fallback. Item will skip every tick until deactivated.",
            });
          }
        }

        if (row.durationSecs === 1800) {
          const vDur = row.vDuration ? parseFloat(row.vDuration) : 0;
          // HLS and DASH items self-report duration via their manifests; the
          // 1800 s stored value is an expected placeholder that the orchestrator
          // never relies on for scheduling (it uses live playback telemetry for
          // HLS transitions). YouTube items similarly have no local ffprobe
          // target. Only flag the warning for local MP4-only items.
          const hasHls = !!(row.qHlsUrl || row.vHlsUrl);
          const isYoutube = row.vSource === "youtube";
          if (!hasHls && !isYoutube && (!vDur || isNaN(vDur))) {
            issues.push({
              severity: "warn",
              itemId: row.id,
              itemTitle: row.title,
              code: "PLACEHOLDER_DURATION",
              message: "Item uses 1800 s placeholder — ffprobe has not produced a real duration yet",
            });
          }
        }

        // Detect suspiciously short probe results — likely a probe-failure from
        // the moov-atom upload race (ffprobe ran before faststart flushed the
        // atom to the start of the file).  loadActive() treats < 10 s as a
        // probe failure and falls back to the queue row's durationSecs, but the
        // corrupted value should still be surfaced here so operators can see it.
        if (row.vDuration) {
          const vDur = parseFloat(row.vDuration);
          if (!isNaN(vDur) && vDur > 0 && vDur < 10) {
            issues.push({
              severity: "warn",
              itemId: row.id,
              itemTitle: row.title,
              code: "SUSPICIOUS_DURATION",
              message: `video.duration='${row.vDuration}' is < 10 s — likely a probe failure from an upload race; re-process video to fix`,
            });
            // Collect for background reprobe: only local uploads with a video
            // row (not YouTube — they have no local file to re-probe).
            if (
              row.videoId2 !== null &&
              row.vLocalUrl &&
              row.vSource !== "youtube"
            ) {
              suspiciousDurationItems.push({ id: row.id, videoId: row.videoId2, localUrl: row.vLocalUrl });
            }
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
      // The partial unique index `uq_broadcast_queue_video_id_active` prevents
      // new duplicates but cannot retroactively fix rows inserted before the
      // index existed, rows touched by direct DB operations, or any rare race
      // that briefly bypassed application-layer guards.
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
          // Mark all but the first (lowest sort_order — already asc-sorted)
          // for deactivation. Keep ids[0]; suppress ids[1..n].
          for (let i = 1; i < ids.length; i++) duplicateVideoItemIds.push(ids[i]!);
        }
      }

      // ── Auto-fix: deactivate surplus DUPLICATE_ACTIVE_VIDEO items ──────────
      // Keep the copy with the lowest sort_order (earliest in the broadcast
      // schedule). Deactivate every extra copy so the orchestrator never
      // loads the same video twice. Uses is_active=false + marker so operators
      // can identify why a row was deactivated.
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
        } catch (fixErr) {
          logger.warn(
            { err: fixErr, count: duplicateVideoItemIds.length },
            "[queue-validator] AUTO-FIX: failed to deactivate DUPLICATE_ACTIVE_VIDEO surplus items (non-fatal)",
          );
        }
      }

      // ── Auto-fix: reassign sort_order for DUPLICATE_SORT_ORDER items ───────
      // Duplicate sort_order values cause non-deterministic queue ordering —
      // the DB query uses ORDER BY sort_order, so ties resolve to arbitrary
      // DB page order, which can differ between reloads. The fix reassigns
      // ALL active items (not just the duplicates) to a clean monotonic
      // sequence (gap of 10) in the order they appear in the current query
      // result. rows is already ordered by asc(sortOrder) so the existing
      // intended sequence is preserved.
      if (duplicateItemIds.length > 0) {
        try {
          await db.transaction(async (tx) => {
            for (let i = 0; i < rows.length; i++) {
              await tx
                .update(schema.broadcastQueueTable)
                .set({ sortOrder: (i + 1) * 10 })
                .where(eq(schema.broadcastQueueTable.id, rows[i]!.id));
            }
          });
          logger.warn(
            { count: duplicateItemIds.length, totalReassigned: rows.length },
            "[queue-validator] AUTO-FIX: reassigned sort_order for all active items to restore deterministic queue ordering",
          );
          adminEventBus.push("broadcast-queue-updated", {
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

      // ── Auto-fix: deactivate MISSING_VIDEO_JOIN items ─────────────────────
      // Items whose referenced managed_videos row no longer exists (hard-deleted)
      // must be removed from active broadcast rotation. Without this fix:
      //   • The orchestrator's loadActive() LEFT JOIN returns them with null
      //     video columns. If the queue row has its own localVideoUrl, the item
      //     airs from a potentially stale/404 URL with no fallback.
      //   • If the queue row has no URL, toItem() fails → auto-skip cycle fires
      //     every tick, burning skip budget and flooding logs.
      // Deactivating is non-destructive (is_active=false, row preserved) and
      // immediately consistent: the next orchestrator reload won't load these
      // items. The auto-enqueue pipeline (enqueueIfMissing) now correctly
      // ignores inactive rows, so the video would be re-added if it were
      // somehow re-uploaded — but that can't happen for hard-deleted videos.
      const missingJoinIds = issues
        .filter((i) => i.severity === "error" && i.code === "MISSING_VIDEO_JOIN" && i.itemId)
        .map((i) => i.itemId!);
      if (missingJoinIds.length > 0) {
        try {
          await db
            .update(schema.broadcastQueueTable)
            .set({
              isActive: false,
              // Record the specific reason for deactivation so the reverse pass
              // below can ONLY re-activate rows this validator deactivated —
              // never rows disabled by operators or other code paths. Without
              // this marker, is_active=false alone is insufficient to distinguish
              // "validator auto-deactivated" from "intentionally off by operator".
              validatorDeactivatedReason: "missing_video_join",
            })
            .where(inArray(schema.broadcastQueueTable.id, missingJoinIds));
          logger.error(
            { count: missingJoinIds.length, itemIds: missingJoinIds },
            "[queue-validator] AUTO-FIX: deactivated MISSING_VIDEO_JOIN items " +
            "(referenced managed_videos rows were hard-deleted) — " +
            "these items are removed from broadcast rotation",
          );
          // Trigger orchestrator reload so the engine immediately stops serving
          // the deactivated items without waiting for the next drift-poll.
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
      // When a managed_videos row is restored after a DB anomaly (e.g. a botched
      // hard-delete was rolled back, a row was re-imported via YouTube sync, or
      // an admin manually re-linked a video), the corresponding broadcast_queue
      // item may still be sitting as is_active=false from a previous validator
      // run that correctly deactivated it. Without this reverse pass the item
      // never returns to air — the operator would have to manually toggle it back.
      //
      // We only re-activate items that:
      //   1. Are currently inactive (is_active=false)
      //   2. Have a non-null videoId (i.e. they were a managed-video queue entry)
      //   3. Have a valid, resolvable managed_videos join (the row exists again)
      //   4. Have at least one playable URL (localVideoUrl or hlsMasterUrl) so
      //      we don't re-activate an item that will immediately auto-skip again
      //
      // Run reverse pass regardless of whether any MISSING_VIDEO_JOIN issues
      // fired this cycle: the video restoration may have happened between two
      // validator runs, so the active-queue scan above would show 0 issues but
      // the inactive rows (still deactivated from a previous run) need restoring.
      // Safety: only re-activate rows whose `validatorDeactivatedReason` is
      // explicitly "missing_video_join" — this ensures we never touch rows that
      // operators intentionally disabled or that other code paths deactivated
      // for unrelated reasons.
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
              AND (mv.local_video_url IS NOT NULL OR mv.hls_master_url IS NOT NULL)
              AND mv.transcoding_status NOT IN ('encoding', 'processing')
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
              .set({
                isActive: true,
                // Clear the deactivation marker now that the row is back in rotation
                // so a future operator disable is not incorrectly treated as a prior
                // validator deactivation.
                validatorDeactivatedReason: null,
              })
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
          } catch (fixErr) {
            logger.warn(
              { err: fixErr, count: restoredIds.length },
              "[queue-validator] AUTO-FIX (reverse): failed to re-activate restored items (non-fatal)",
            );
          }
        }
      }

      // ── Auto-fix: deactivate UNPLAYABLE_CORRUPT_UPLOAD items ─────────────────
      // Items whose video has permanently failed transcoding AND has no moov at
      // byte-0 (CORRUPT_SOURCE or faststart_applied=false) AND has no HLS are
      // structurally unplayable — every orchestrator tick will auto-skip them,
      // burning the 5-skip budget and eventually triggering dead-air filler.
      // Deactivating them stops the skip spiral and lets the validator surface a
      // clear "re-upload required" message in the diagnostics endpoint.
      //
      // Reverse pass below re-activates when HLS becomes available (e.g. after a
      // successful remote re-transcode triggered by the operator).
      const corruptUploadItemIds = rows
        .filter((r) => {
          if (!r.videoId || r.videoId2 === null) return false;
          if (r.qHlsUrl || r.vHlsUrl) return false; // HLS available — safe
          if (r.vStatus !== "failed") return false;  // still transcoding — leave active
          return r.vErrCode === "CORRUPT_SOURCE" || r.vErrCode === "SOURCE_MISSING" || !r.vFaststart;
        })
        .map((r) => r.id);

      if (corruptUploadItemIds.length > 0) {
        try {
          await db
            .update(schema.broadcastQueueTable)
            .set({
              isActive: false,
              validatorDeactivatedReason: "corrupt_upload",
            })
            .where(inArray(schema.broadcastQueueTable.id, corruptUploadItemIds));
          logger.error(
            { count: corruptUploadItemIds.length, itemIds: corruptUploadItemIds },
            "[queue-validator] AUTO-FIX: deactivated UNPLAYABLE_CORRUPT_UPLOAD items " +
            "(transcodingStatus=failed + no faststart/CORRUPT_SOURCE + no HLS) — " +
            "removed from broadcast rotation; re-upload the source file or trigger a remote re-transcode to restore",
          );
          adminEventBus.push("broadcast-queue-updated", {
            reason: "integrity-fix-corrupt-upload",
            count: corruptUploadItemIds.length,
          });
        } catch (fixErr) {
          logger.warn(
            { err: fixErr, count: corruptUploadItemIds.length },
            "[queue-validator] AUTO-FIX: failed to deactivate UNPLAYABLE_CORRUPT_UPLOAD items (non-fatal)",
          );
        }
      }

      // ── Auto-fix (reverse): re-activate corrupt_upload items that now have HLS ──
      // When a video that was previously deactivated as corrupt_upload gains an
      // HLS manifest (operator used the remote re-transcode tool or manually
      // re-uploaded a fixed source), its queue item must return to rotation.
      {
        type RevivedRow = { id: string; title: string };
        let revivedCorruptRows: RevivedRow[] = [];
        try {
          const result = await db.execute<RevivedRow>(sql`
            SELECT bq.id, bq.title
            FROM broadcast_queue bq
            INNER JOIN managed_videos mv ON mv.id = bq.video_id
            WHERE bq.is_active = false
              AND bq.validator_deactivated_reason = 'corrupt_upload'
              AND (
                mv.hls_master_url IS NOT NULL
                OR mv.faststart_applied = true
              )
          `);
          revivedCorruptRows = (result.rows as RevivedRow[]) ?? [];
        } catch (qErr) {
          logger.debug(
            { err: qErr },
            "[queue-validator] reverse-UNPLAYABLE_CORRUPT_UPLOAD query failed (non-fatal)",
          );
        }

        if (revivedCorruptRows.length > 0) {
          const revivedIds = revivedCorruptRows.map((r) => r.id);
          try {
            await db
              .update(schema.broadcastQueueTable)
              .set({ isActive: true, validatorDeactivatedReason: null })
              .where(inArray(schema.broadcastQueueTable.id, revivedIds));
            logger.warn(
              { count: revivedIds.length, itemIds: revivedIds },
              "[queue-validator] AUTO-FIX (reverse): re-activated corrupt_upload items " +
              "whose video now has an HLS manifest — items returned to broadcast rotation",
            );
            adminEventBus.push("broadcast-queue-updated", {
              reason: "integrity-fix-revived-corrupt-upload",
              count: revivedIds.length,
            });
          } catch (fixErr) {
            logger.warn(
              { err: fixErr, count: revivedIds.length },
              "[queue-validator] AUTO-FIX (reverse): failed to re-activate corrupt_upload items (non-fatal)",
            );
          }
        }
      }

      // ── Auto-fix: deactivate ORPHANED_VIDEO_REF items that will never become playable ──
      // Items whose referenced video exists but has no playable URLs anywhere
      // (neither on the video row nor on the queue row itself) will never air.
      // They cause repeated auto-skip cycles (one per orchestrator tick), burning
      // skip budget and flooding logs with "resolveSource returned null" warnings.
      //
      // Safety guards applied before deactivation:
      //   • vStatus in {queued, encoding, processing} → skip: actively transcoding
      //     and will gain URLs within minutes.
      //   • vSource='youtube' → skip: YouTube items resolve via youtubeId, not a
      //     local URL; they legitimately have no localVideoUrl/hlsMasterUrl.
      //   • qLocalUrl or qHlsUrl set on the queue row → skip: item IS playable
      //     via the queue row's own URL regardless of the video-row state.
      //
      // All other vStatus values (null, 'failed', 'done', 'hls_ready', or any
      // unknown status) combined with zero playable URLs = permanently unplayable.
      // The reverse-pass below re-activates these rows if the video later gains
      // playable URLs (e.g. after a successful re-transcode or re-upload).
      const orphanedFailedIds = rows
        .filter((r) => {
          const isOrphaned =
            r.videoId !== null &&
            r.videoId2 !== null &&
            !r.vLocalUrl &&
            !r.vHlsUrl &&
            !r.qLocalUrl &&
            !r.qHlsUrl;
          const isYoutube = r.vSource === "youtube";
          const isActivelyTranscoding =
            r.vStatus === "queued" ||
            r.vStatus === "encoding" ||
            r.vStatus === "processing";
          return isOrphaned && !isYoutube && !isActivelyTranscoding;
        })
        .map((r) => r.id);

      if (orphanedFailedIds.length > 0) {
        try {
          await db
            .update(schema.broadcastQueueTable)
            .set({
              isActive: false,
              // Tag the row so the reverse pass below can re-activate it if the
              // video later gains playable URLs (e.g. after a successful re-transcode
              // or re-upload), and so operators can distinguish validator-disabled
              // rows from intentionally operator-disabled ones.
              validatorDeactivatedReason: "orphaned_video_ref",
            })
            .where(inArray(schema.broadcastQueueTable.id, orphanedFailedIds));
          logger.error(
            { count: orphanedFailedIds.length, itemIds: orphanedFailedIds },
            "[queue-validator] AUTO-FIX: deactivated ORPHANED_VIDEO_REF items " +
            "(video row exists but has no playable URLs; transcodingStatus is 'failed' or null) — " +
            "removed from broadcast rotation; re-transcode or re-upload the source file to restore",
          );
          adminEventBus.push("broadcast-queue-updated", {
            reason: "integrity-fix-orphaned-video-ref",
            count: orphanedFailedIds.length,
          });
        } catch (fixErr) {
          logger.warn(
            { err: fixErr, count: orphanedFailedIds.length },
            "[queue-validator] AUTO-FIX: failed to deactivate ORPHANED_VIDEO_REF items (non-fatal)",
          );
        }
      }

      // ── Auto-fix (reverse): re-activate ORPHANED_VIDEO_REF items that now have playable URLs ──
      // When a video is successfully re-transcoded or re-uploaded after a previous failure,
      // its broadcast_queue item may still be deactivated from the auto-fix above.
      // Re-activate it so the content returns to air automatically.
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
              AND (mv.local_video_url IS NOT NULL OR mv.hls_master_url IS NOT NULL)
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
              "whose video now has playable URLs — items returned to broadcast rotation",
            );
            adminEventBus.push("broadcast-queue-updated", {
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

      // ── Background: reprobe SUSPICIOUS_DURATION items ─────────────────────
      // Fire at most 3 concurrent reprobe tasks per cycle (fire-and-forget).
      // Each task normalises the video's localVideoUrl to an absolute URL and
      // runs ffprobe directly on it (HTTP range-request reads only — no full
      // file download). On success, both managed_videos.duration and
      // broadcast_queue.duration_secs are corrected and a queue-updated event
      // is emitted so the orchestrator reloads with the new duration.
      if (suspiciousDurationItems.length > 0) {
        const toReprobe = suspiciousDurationItems.slice(0, 3);
        for (const item of toReprobe) {
          void (async () => {
            try {
              const absUrl = normalizeQueueUrl(item.localUrl);
              if (!absUrl) return;
              const dur = await probeDurationFromUrl(absUrl);
              if (!dur || dur < 1) {
                logger.debug(
                  { itemId: item.id, url: absUrl },
                  "[queue-validator] SUSPICIOUS_DURATION reprobe returned no valid duration (non-fatal)",
                );
                return;
              }
              await db.execute(sql`
                UPDATE managed_videos SET duration = ${String(dur)} WHERE id = ${item.videoId}
              `);
              await db.execute(sql`
                UPDATE broadcast_queue SET duration_secs = ${Math.ceil(dur)} WHERE id = ${item.id}
              `);
              logger.info(
                { itemId: item.id, videoId: item.videoId, newDurSecs: Math.ceil(dur) },
                "[queue-validator] AUTO-FIX: SUSPICIOUS_DURATION reprobe corrected duration — managed_videos and broadcast_queue updated",
              );
              adminEventBus.push("broadcast-queue-updated", {
                reason: "integrity-fix-suspicious-duration-reprobe",
                itemId: item.id,
                videoId: item.videoId,
              });
            } catch (err) {
              logger.warn(
                { err, itemId: item.id },
                "[queue-validator] SUSPICIOUS_DURATION reprobe failed (non-fatal)",
              );
            }
          })();
        }
      }

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

      // Build a lightweight fingerprint so repeated runs with identical issues
      // don't spam WARN every 2 minutes.  Only log when the issue set changes.
      const sig = issues.map((i) => `${i.code}:${i.itemId ?? ""}:${i.message}`).sort().join("|");
      if (issues.length > 0) {
        if (sig !== this.lastIssueSig) {
          logger.warn(
            { errors: report.summary.errors, warnings: report.summary.warnings, total: rows.length },
            "[queue-validator] validation found issues",
          );
          this.lastIssueSig = sig;
          // Push SSE so the admin dashboard learns of new issues immediately —
          // without waiting for the next diagnostics poll.
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
          // Notify that all issues have cleared.
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
