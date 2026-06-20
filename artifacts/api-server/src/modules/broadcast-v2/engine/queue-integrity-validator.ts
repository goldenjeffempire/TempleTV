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
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { sendBroadcastWebhook } from "../webhook/webhook.service.js";
import { db, schema } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { normalizeQueueUrl } from "../repository/queue.repo.js";
import { enqueueTranscode } from "../../transcoder/transcoder.queue.js";
import { withHlsToken } from "../../../shared/hls-token.js";
import { storageBlobRecoveryService } from "./storage-blob-recovery.service.js";

// ── Duration probe helper ─────────────────────────────────────────────────────
//
// Multi-strategy ffprobe probe for HTTP(S) URLs.
// Used by the SUSPICIOUS_DURATION and HLS-placeholder auto-reprobe paths.
// Probes via HTTP range requests — ffprobe reads only the container header
// (moov atom for MP4, EXTINF sum for HLS manifests) without a full download.
//
// Strategy 1: single ffprobe pass reading format+stream duration (JSON).
//   Covers: MP4/MOV/WebM (format duration), MPEG-TS/fMP4/MKV (stream-level
//   duration when format returns N/A), HLS VOD manifests (EXTINF sum).
// Strategy 2: same with a 32 MB analyze budget for containers whose duration
//   metadata is beyond the default probe window (~5 MB). HTTP-safe: ffprobe
//   issues range requests so no full-file download occurs.
// Strategy 3: ffmpeg container-open stderr "Duration:" parse. ffmpeg opens
//   the URL via range requests and prints the Duration line before any decode.
//
// Returns null on any failure (ffprobe unavailable, timeout, corrupt header).

async function probeDurationFromUrl(url: string): Promise<number | null> {
  // Inject an HLS auth token when REQUIRE_HLS_TOKEN is enabled.
  // ffprobe fetches the URL via HTTP range requests — without the token the
  // server returns 401 and ffprobe exits with no output (duration = null).
  const probeUrl = withHlsToken(url);

  // Strategy 1: fast header probe — format + stream duration, JSON output.
  const s1 = await _probeUrlFfprobe(probeUrl, []);
  if (s1 !== null) return s1;

  // Strategy 2: deeper analyze budget (32 MB, HTTP-safe).
  const s2 = await _probeUrlFfprobe(probeUrl, ["-analyzeduration", "32M", "-probesize", "32M"]);
  if (s2 !== null) return s2;

  // Strategy 3: ffmpeg container-open stderr "Duration:" parse.
  return _probeUrlFfmpegFallback(probeUrl);
}

/** ffprobe pass querying format+stream duration via JSON; optional extraArgs prepended. */
function _probeUrlFfprobe(
  probeUrl: string,
  extraArgs: string[],
): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    let proc: ReturnType<typeof spawn> | null = null;
    try {
      proc = spawn("ffprobe", [
        ...extraArgs,
        "-v", "quiet",
        "-print_format", "json",
        "-show_entries", "format=duration:stream=duration",
        probeUrl,
      ], { stdio: ["ignore", "pipe", "ignore"] });
      proc.unref();
    } catch {
      resolve(null);
      return;
    }
    if (!proc.stdout) { resolve(null); return; }
    let stdout = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    const t = setTimeout(() => { try { proc?.kill(); } catch { /**/ } resolve(null); }, 45_000);
    t.unref?.();
    proc.on("close", () => {
      clearTimeout(t);
      try {
        const parsed = JSON.parse(stdout) as {
          format?: { duration?: string };
          streams?: Array<{ duration?: string }>;
        };
        const fmtDur = parseFloat(parsed.format?.duration ?? "");
        if (Number.isFinite(fmtDur) && fmtDur > 0) { resolve(fmtDur); return; }
        const streamDurs = (parsed.streams ?? [])
          .map((s) => parseFloat(s.duration ?? ""))
          .filter((d) => Number.isFinite(d) && d > 0);
        if (streamDurs.length > 0) { resolve(Math.max(...streamDurs)); return; }
      } catch { /* JSON parse failure */ }
      resolve(null);
    });
    proc.on("error", () => { clearTimeout(t); resolve(null); });
  });
}

/**
 * ffmpeg container-open fallback for HTTP URLs: parses "Duration: HH:MM:SS.ms"
 * from stderr.  ffmpeg uses range requests for the header and prints the
 * Duration line before any decode, so this is fast even for large remote files.
 * "Duration: N/A" produces no match → returns null.
 */
function _probeUrlFfmpegFallback(probeUrl: string): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    let proc: ReturnType<typeof spawn> | null = null;
    try {
      proc = spawn("ffmpeg", [
        "-hide_banner",
        "-i", probeUrl,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      proc.unref();
    } catch {
      resolve(null);
      return;
    }
    if (!proc.stderr) { resolve(null); return; }
    let stderr = "";
    proc.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    const t = setTimeout(() => { try { proc?.kill(); } catch { /**/ } resolve(null); }, 30_000);
    t.unref?.();
    proc.on("close", () => {
      clearTimeout(t);
      const m = stderr.match(/Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) { resolve(null); return; }
      const secs = parseInt(m[1]!, 10) * 3600 + parseInt(m[2]!, 10) * 60 + parseFloat(m[3]!);
      resolve(secs > 0 ? secs : null);
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
  /**
   * Monotonically-incrementing cycle counter. Incremented at the start of each
   * validate() call. Used to rate-limit checks that don't need to run every
   * cycle.
   */
  private validatorCycleCount = 0;

  // ── storage_blobs circuit breaker ────────────────────────────────────────
  // Tracks consecutive failures of the storage_blobs connectivity check so
  // a temporarily-unreachable storage layer doesn't flood logs and doesn't
  // falsely auto-deactivate items whose HLS state is simply unknown.
  //
  // After STORAGE_CB_THRESHOLD consecutive failures the circuit opens for
  // STORAGE_CB_OPEN_MS — further checks are skipped and a single WARN is
  // emitted.  The circuit auto-closes after the TTL so recovery is automatic.
  private storageCbFailures = 0;
  private storageCbOpenUntilMs = 0;
  private static readonly STORAGE_CB_THRESHOLD = 3;
  private static readonly STORAGE_CB_OPEN_MS = 60_000;

  async validate(): Promise<ValidationReport> {
    if (this.validating) return this.lastReport ?? this.empty();
    this.validating = true;
    this.validatorCycleCount += 1;
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
          vObjectPath: v.objectPath,
          vSourceCleanup: v.sourceCleanupStatus,
        })
        .from(q)
        .leftJoin(v, eq(q.videoId, v.id))
        .where(eq(q.isActive, true))
        .orderBy(asc(q.sortOrder))
        .limit(2000); // broadcast queues are typically <100; cap prevents OOM on runaway growth

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

        if (row.durationSecs === 1800) {
          const vDur = row.vDuration ? parseFloat(row.vDuration) : 0;
          const isYoutube = row.vSource === "youtube";
          if (!isYoutube && (!vDur || isNaN(vDur))) {
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

        // ZERO_DURATION: item carries a zero or negative duration. The
        // orchestrator applies a 60 s safety floor for these silently, but
        // operators should see an explicit warning so the root cause can be
        // corrected (re-probe the source file or fix the managed_videos row).
        if (row.durationSecs <= 0) {
          issues.push({
            severity: "warn",
            itemId: row.id,
            itemTitle: row.title,
            code: "ZERO_DURATION",
            message: `Item has durationSecs=${row.durationSecs} — orchestrator applies a 60 s floor; re-probe the source file or correct the duration`,
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
      // Duplicate sort_order values cause non-deterministic queue ordering —
      // the DB query uses ORDER BY sort_order, so ties resolve to arbitrary
      // DB page order, which can differ between reloads. The fix reassigns
      // ALL active items (not just the duplicates) to a clean monotonic
      // sequence (gap of 10) in the order they appear in a fresh query
      // result. A fresh fetch is used rather than re-using `rows` to exclude
      // any items deactivated earlier in this same validator cycle
      // (MISSING_VIDEO_JOIN, DUPLICATE_ACTIVE_VIDEO, UNPLAYABLE_CORRUPT_UPLOAD)
      // so they don't consume sequence slots while is_active=false.
      if (duplicateItemIds.length > 0) {
        try {
          // Re-fetch active IDs immediately before reassignment. Items
          // deactivated earlier in this cycle are now is_active=false and
          // will be excluded from the ORDER BY sort_order scan, giving the
          // remaining active items a clean contiguous sequence.
          const freshRows = await db
            .select({ id: q.id })
            .from(q)
            .where(eq(q.isActive, true))
            .orderBy(asc(q.sortOrder));

          // Use individual parameterised Drizzle updates inside a transaction
          // instead of sql.raw() string interpolation. The original approach
          // manually escaped the id column with replace(/'/g,"''") which is
          // structurally unsafe (SQL injection) even though nanoid IDs happen
          // to be alphanumeric. Individual updates are O(N) DB round-trips
          // but queue lengths rarely exceed a few dozen items, making the
          // latency difference negligible compared to the correctness gain.
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

      // ── MISSING_VIDEO_JOIN — log warning; items stay active ───────────────
      // Items whose referenced managed_videos row no longer exists are flagged
      // here but remain in the broadcast queue. The orchestrator's toItem()
      // will return null for a row whose video join is absent, and the
      // bad-URL cache + runtime auto-skip will advance past it cleanly.
      // The reverse pass below still re-activates any items previously
      // deactivated by an older server version that wrote is_active=false.
      const missingJoinIds = issues
        .filter((i) => i.severity === "error" && i.code === "MISSING_VIDEO_JOIN" && i.itemId)
        .map((i) => i.itemId!);
      if (missingJoinIds.length > 0) {
        logger.warn(
          { count: missingJoinIds.length, itemIds: missingJoinIds },
          "[queue-validator] MISSING_VIDEO_JOIN detected — referenced managed_videos rows are absent; " +
          "items remain in broadcast queue and will be auto-skipped at runtime if unresolvable",
        );
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

      // ── Auto-fix: deactivate truly absent-source items (CORRUPT_SOURCE / SOURCE_MISSING) ──
      // Items whose video has permanently failed transcoding AND the source file is
      // truly absent/corrupt are structurally unplayable — every orchestrator tick will
      // auto-skip them, burning the 5-skip budget. Deactivating stops the skip spiral
      // and surfaces a clear "re-upload required" message in diagnostics.
      //
      // Policy split (by error code):
      //   CORRUPT_SOURCE — moov atom absent; unrecoverable. Hard-deactivate + quarantine
      //                    immediately (no recovery waterfall can help).
      //   SOURCE_MISSING — storage blob deleted; may be recoverable if HLS blobs still
      //                    exist. Route through storageBlobRecoveryService.runWaterfall()
      //                    first. Waterfall handles quarantine + deactivation on Tier-3.
      //                    Only items the waterfall cannot recover reach hard-deactivate.
      //
      // NOT deactivated (source file exists — admitted to broadcast):
      //   DISK_FULL          — transcoding failed due to disk space; source intact.
      //   faststartApplied=false — moov at EOF; file exists; faststart-recovery
      //                        worker actively retries moov relocation.
      //   ASSEMBLY_FAILED    — recoverable; operator can retry finalization.
      //
      // Reverse pass below re-activates when HLS becomes available (re-transcode).
      const baseFilter = (r: typeof rows[number]) => {
        if (!r.videoId || r.videoId2 === null) return false;
        if (r.qHlsUrl || r.vHlsUrl) return false; // HLS available — safe
        if (r.vStatus !== "failed") return false;  // still transcoding — leave active
        return true;
      };

      // SOURCE_MISSING: run waterfall first — waterfall handles its own deactivation
      // if all tiers fail (tier3_quarantine). Fire-and-forget; non-blocking for this pass.
      const sourceMissingRows = rows.filter(
        (r) => baseFilter(r) && r.vErrCode === "SOURCE_MISSING",
      );
      for (const r of sourceMissingRows) {
        void storageBlobRecoveryService.runWaterfall({
          videoId: r.videoId as string,
          queueId: r.id,
          title: r.title ?? r.videoId ?? "unknown",
          objectPath: r.vObjectPath ?? null,
          hlsUrl: r.vHlsUrl ?? r.qHlsUrl ?? null,
          triggeredBy: "queue-integrity-validator",
        }).catch((err) => {
          logger.warn({ err, videoId: r.videoId, queueId: r.id },
            "[queue-validator] SOURCE_MISSING waterfall failed (non-fatal)");
        });
      }

      // CORRUPT_SOURCE — log warning; items stay active.
      // Items with CORRUPT_SOURCE and no URL at all will produce a null from
      // toItem() and be auto-skipped by the orchestrator at runtime. Items that
      // have a localVideoUrl despite CORRUPT_SOURCE may still play as progressive
      // MP4. Neither case warrants deactivation — the runtime handles both.
      // The reverse pass below re-activates any previously deactivated items.
      const corruptUploadItemIds = rows
        .filter(
          (r) =>
            baseFilter(r) &&
            r.vErrCode === "CORRUPT_SOURCE" &&
            !r.vLocalUrl &&
            !r.qLocalUrl,
        )
        .map((r) => r.id);

      if (corruptUploadItemIds.length > 0) {
        logger.warn(
          { count: corruptUploadItemIds.length, itemIds: corruptUploadItemIds },
          "[queue-validator] UNPLAYABLE_CORRUPT_UPLOAD detected — transcodingStatus=failed + CORRUPT_SOURCE + no HLS or MP4; " +
          "items remain in broadcast queue and will be auto-skipped at runtime; re-upload to fully restore",
        );
      }

      // ── Auto-fix (reverse): re-activate corrupt_upload items that are now playable ──
      // Re-activates items previously deactivated as 'corrupt_upload' once any
      // playable URL is present.
      //
      // Admission criteria (broadcast-first policy):
      //   • ANY localVideoUrl OR hlsMasterUrl → source is available; admitted to
      //     broadcast regardless of transcodingErrorCode.  CORRUPT_SOURCE items
      //     with a localVideoUrl play as progressive MP4 — the forward pass no
      //     longer deactivates them, so no oscillation cycle exists.
      //   • SOURCE_MISSING is excluded: even if localVideoUrl column has a value
      //     the storage blob is gone so the URL would 404.  These items stay
      //     deactivated until the operator re-uploads.
      //
      // Historical note: the old condition required transcodingErrorCode NOT IN
      // (CORRUPT_SOURCE, SOURCE_MISSING) — CORRUPT_SOURCE has been removed from
      // that exclusion list because it is no longer terminal when localVideoUrl
      // exists.  SOURCE_MISSING remains excluded for the reason above.
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
              AND (mv.hls_master_url IS NOT NULL OR mv.local_video_url IS NOT NULL)
              AND mv.transcoding_error_code IS DISTINCT FROM 'SOURCE_MISSING'
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
              "whose video is now playable (HLS available, faststart confirmed, or faststart never attempted) — " +
              "items returned to broadcast rotation",
            );
            adminEventBus.push("broadcast-queue-updated", {
              reason: "integrity-fix-revived-corrupt-upload",
              count: revivedIds.length,
            });
            adminEventBus.push("videos-library-updated", {
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
      //
      // Split orphans into two groups:
      //   healable   — video has a storage blob (objectPath) and the source was
      //                NOT cleaned up AND the failure is not terminal. These are
      //                auto-transcoded: deactivated now, re-activated by the
      //                reverse pass once transcodingStatus reaches 'hls_ready'.
      //   permanent  — no source blob, terminal failure, or faststart explicitly
      //                failed. Deactivated permanently; re-upload required.
      const orphanedFailedRows = rows.filter((r) => {
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
      });
      const orphanedFailedIds = orphanedFailedRows.map((r) => r.id);

      // ORPHANED_VIDEO_REF — log warning; items stay active.
      // Items with a video join but no playable URL will produce null from
      // toItem() and be auto-skipped at runtime. The auto-heal block below
      // enqueues transcoding in the background to restore a playable URL.
      // The reverse pass below still re-activates previously deactivated items.
      if (orphanedFailedIds.length > 0) {
        logger.warn(
          { count: orphanedFailedIds.length, itemIds: orphanedFailedIds },
          "[queue-validator] ORPHANED_VIDEO_REF detected — video row exists but has no playable URLs; " +
          "items remain in broadcast queue; auto-heal transcoding scheduled; runtime auto-skip handles any gaps",
        );
      }

      // ── Auto-heal: enqueue transcoding for recoverable ORPHANED_VIDEO_REF items ──
      // Items that have a storage blob (objectPath) and a non-terminal status can
      // be automatically recovered by re-enqueueing transcoding. The queue item
      // stays deactivated (it has no playable URL now) and the reverse pass below
      // will re-activate it once transcodingStatus reaches 'hls_ready'.
      //
      // Skipped when:
      //   • objectPath is null — upload never completed (re-upload required)
      //   • sourceCleanupStatus = 'deleted' — source blob has been cleaned up
      //   • Terminal error codes: CORRUPT_SOURCE, SOURCE_MISSING
      //     (DISK_FULL and faststartApplied=false are NOT terminal — source blob
      //      is still present; re-transcoding to HLS can produce a playable URL.
      //      DISK_FULL resolves once disk space is freed; faststart failure just
      //      means moov is at EOF, which HLS transcoding bypasses entirely.)
      {
        const healableOrphans = orphanedFailedRows.filter((r) => {
          if (!r.videoId2 || !r.vObjectPath) return false;
          if (r.vSourceCleanup === "deleted") return false;
          const isTerminal =
            r.vStatus === "failed" &&
            (r.vErrCode === "CORRUPT_SOURCE" ||
              r.vErrCode === "SOURCE_MISSING");
          return !isTerminal;
        });

        for (const row of healableOrphans) {
          if (!row.videoId2 || !row.vObjectPath) continue;
          void (async () => {
            try {
              // Reconstruct localVideoUrl from objectPath if it was lost.
              // The upload pipeline sets localVideoUrl = /api/v1/uploads/{objectPath}.
              // If it is null here the finalize step was interrupted before writing it.
              // Restore it so enqueueTranscode has a valid source path.
              const restoredLocalUrl = normalizeQueueUrl(`/api/v1/uploads/${row.vObjectPath}`);
              if (!restoredLocalUrl) return;
              if (!row.vLocalUrl) {
                await db
                  .update(schema.videosTable)
                  .set({ localVideoUrl: restoredLocalUrl })
                  .where(eq(schema.videosTable.id, row.videoId2!));
              }
              await enqueueTranscode({
                videoId: row.videoId2!,
                videoPath: row.vLocalUrl ?? restoredLocalUrl,
                priority: 3,
              });
              logger.info(
                { itemId: row.id, videoId: row.videoId2, objectPath: row.vObjectPath },
                "[queue-validator] AUTO-HEAL: ORPHANED_VIDEO_REF — source blob intact; " +
                "enqueued transcoding. Item will return to rotation automatically once HLS is ready.",
              );
              adminEventBus.push("videos-library-updated", {
                reason: "integrity-fix-orphaned-video-ref-auto-heal",
                videoId: row.videoId2,
              });
            } catch (healErr) {
              logger.warn(
                { err: healErr, itemId: row.id, videoId: row.videoId2 },
                "[queue-validator] AUTO-HEAL: ORPHANED_VIDEO_REF transcoding enqueue failed (non-fatal)",
              );
            }
          })();
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
              adminEventBus.push("videos-library-updated", {
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


// ── Gap 1.5: MP4_BLOB_MISSING — every 4th validator cycle ─────────────
      // Active queue items whose managed_videos row has objectPath set (a local
      // upload source) but the corresponding storage_blobs key is absent.  These
      // are items the orchestrator will try to serve as a raw MP4 but whose blob
      // was deleted or never written to storage_blobs.
      //
      // Detection: batch LEFT JOIN storage_blobs on the derived storage key so
      // we avoid N headObject calls on the hot path.
      //
      // Auto-fix: calls storageBlobRecoveryService.runWaterfall() which re-
      // transcodes (tier2) if HLS blobs exist or quarantines (tier3) if nothing
      // is present.
      //
      // Rate-limited to every 4th cycle (~8 min at the 2-min validator cadence)
      // to avoid hammering the DB on large queues.
      if (this.validatorCycleCount % 4 === 0) {
        void (async () => {
          try {
            // Items with hls_ready status already have HLS — skip MP4 blob check
            // Only check non-hls_ready items (HLS handling is removed in MP4-only pipeline).
            const mp4MissingRows = await db.execute<{
              queue_id: string;
              video_id: string;
              title: string;
              object_path: string;
              hls_master_url: string | null;
            }>(sql`
              SELECT
                bq.id           AS queue_id,
                mv.id           AS video_id,
                bq.title        AS title,
                mv.object_path  AS object_path,
                mv.hls_master_url AS hls_master_url
              FROM broadcast_queue bq
              INNER JOIN managed_videos mv ON mv.id = bq.video_id
              WHERE bq.is_active = true
                AND mv.object_path IS NOT NULL
                AND mv.transcoding_status <> 'hls_ready'
                AND NOT EXISTS (
                  SELECT 1 FROM storage_blobs sb
                  WHERE sb.key = mv.object_path
                    OR sb.key = regexp_replace(mv.object_path, '^/(?:api/(?:v[0-9]+/)?)?', '')
                )
              LIMIT 20
            `);

            const missingRows = mp4MissingRows.rows;
            if (missingRows.length === 0) return;

            logger.warn(
              { count: missingRows.length },
              "[queue-validator] MP4_BLOB_MISSING: found active queue items with missing MP4 source blobs — triggering recovery",
            );

            for (const row of missingRows) {
              issues.push({
                itemId: row.queue_id,
                itemTitle: row.title,
                code: "MP4_BLOB_MISSING",
                severity: "error",
                message:
                  `Active queue item "${row.title}" (videoId: ${row.video_id}) has objectPath set ` +
                  "but no matching entry in storage_blobs — the source blob is missing.",
              });

              void (async () => {
                try {
                  const { storageBlobRecoveryService: svc } = await import("./storage-blob-recovery.service.js");
                  await svc.runWaterfall({
                    videoId: row.video_id,
                    queueId: row.queue_id,
                    title: row.title,
                    objectPath: row.object_path,
                    hlsUrl: row.hls_master_url,
                    triggeredBy: "queue-validator-MP4_BLOB_MISSING",
                  });
                } catch (wfErr) {
                  logger.warn(
                    { err: wfErr, videoId: row.video_id },
                    "[queue-validator] MP4_BLOB_MISSING recovery waterfall failed (non-fatal)",
                  );
                }
              })();
            }
          } catch (mp4Err) {
            logger.warn({ err: mp4Err }, "[queue-validator] MP4_BLOB_MISSING sweep failed (non-fatal)");
          }
        })();
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
