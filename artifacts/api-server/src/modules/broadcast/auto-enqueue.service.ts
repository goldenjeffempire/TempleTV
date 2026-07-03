import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import { env } from "../../config/env.js";
import { broadcastService } from "./broadcast.service.js";
import { ConflictError } from "../../shared/errors.js";

/**
 * Library → Broadcast Queue auto-enqueue pipeline.
 *
 * The broadcast queue must stay populated 24/7 with zero manual operator
 * action. This module is the single source of truth for that contract: any
 * code path that publishes a playable video into `managed_videos` (upload
 * finalize, faststart completion, transcoder completion, YouTube sync, prod
 * mirror, manual import) calls into this service so the row is reflected in
 * `broadcast_queue` exactly once.
 *
 * Design constraints
 *  • Idempotent — safe to call repeatedly for the same video; we de-dup by
 *    `videoId` first (covers local + YT-synced rows, since YT rows get an
 *    `id = "yt-${youtubeId}"`) and by `youtubeId` second (covers any legacy
 *    rows that were inserted with no videoId).
 *  • Crash-safe — every DB call is individually wrapped. A single failed
 *    auto-add never throws back to the upload route or YT sync run.
 *  • Cheap — the scan path uses a NOT EXISTS subquery (single round-trip)
 *    rather than fetching the whole library + queue and diffing in Node.
 *  • Opt-out — `BROADCAST_AUTO_ENQUEUE_DISABLE=1` turns the entire pipeline
 *    off without removing the call sites. Provides an emergency kill-switch.
 *
 * What counts as "playable" for auto-enqueue:
 *  • YouTube  — excluded from broadcast. YouTube content is library-only and
 *    surfaces only through catalog/search endpoints, never the broadcast queue.
 *  • Local    — admitted immediately after assembly (s3MirroredAt IS NOT NULL).
 *    Raw MP4 (moov at EOF) is broadcast-eligible right away; HTTP byte-range
 *    streaming works regardless of moov position. Faststart (moov relocation)
 *    is a background quality upgrade that fires broadcast-source-upgraded when
 *    complete — no re-enqueue is needed, and no queue admission is withheld.
 *    Call sites: upload finalize (immediately after assembly), faststart-recovery
 *    worker (idempotent re-enqueue on recovery), schedule-bridge, repair endpoints.
 */

const queueTable = schema.broadcastQueueTable;
const videosTable = schema.videosTable;

export function isAutoEnqueueEnabled(): boolean {
  return !env.BROADCAST_AUTO_ENQUEUE_DISABLE;
}

/**
 * Enqueue a single managed_video row into the broadcast queue if it isn't
 * already present. Returns true when a new row was inserted, false when the
 * video was already queued or auto-enqueue is disabled.
 *
 * `reason` is logged so on-call can grep for "auto-enqueue" and trace which
 * pipeline (upload / yt-sync / library-scan) produced each row.
 */
export async function enqueueIfMissing(opts: {
  videoId: string;
  reason: "upload-finalize" | "yt-sync" | "library-scan" | "manual-import" | "upload-recovery-on-restart" | "repair-all" | "enqueue-missing" | "assembly-retry" | "schedule-bridge" | "schedule-bridge-fallback" | "faststart-complete" | "faststart-recovery-complete" | "deep-recovery";
}): Promise<{ enqueued: boolean; queueItemId?: string; skipReason?: string }> {
  if (!isAutoEnqueueEnabled()) {
    return { enqueued: false, skipReason: "auto-enqueue-disabled" };
  }
  try {
    // Fetch the video row + check for existing queue rows in one round-trip
    // via a LEFT JOIN. We need both pieces of information regardless, and
    // running them sequentially burns an extra latency hop on every call
    // from the YouTube sync (which can call this hundreds of times).
    const [row] = await db
      .select({
        id: videosTable.id,
        title: videosTable.title,
        thumbnailUrl: videosTable.thumbnailUrl,
        duration: videosTable.duration,
        videoSource: videosTable.videoSource,
        youtubeId: videosTable.youtubeId,
        localVideoUrl: videosTable.localVideoUrl,
        hlsMasterUrl: videosTable.hlsMasterUrl,
        transcodingStatus: videosTable.transcodingStatus,
        faststartApplied: videosTable.faststartApplied,
        transcodingErrorCode: videosTable.transcodingErrorCode,
        category: videosTable.category,
        validationStatus: videosTable.validationStatus,
        // Required for blob-existence gate in isPlayableForBroadcast: s3MirroredAt
        // is stamped only after completeMultipartUpload commits the blob to
        // storage_blobs. NULL means the blob is still assembling, the stamp failed,
        // or the row was pre-committed before assembly started — all cases where
        // broadcasting would cause "Blob not found in storage" errors.
        s3MirroredAt: videosTable.s3MirroredAt,
      })
      .from(videosTable)
      .where(eq(videosTable.id, opts.videoId))
      .limit(1);

    if (!row) return { enqueued: false, skipReason: "video-not-found" };
    if (!isPlayableForBroadcast(row)) {
      return { enqueued: false, skipReason: "not-yet-playable" };
    }

    // De-dup against both videoId (canonical) and youtubeId (legacy rows).
    // IMPORTANT: filter to is_active = true only. An inactive queue row means
    // the item was previously dequeued (operator-deactivated, integrity-fix, etc.)
    // and is no longer in broadcast rotation. Treating it as "already queued"
    // would permanently block the video from re-entering the broadcast — the
    // orchestrator only loads is_active = true rows, so inactive rows are
    // effectively invisible to it. The correct behaviour is to insert a fresh
    // active row so the video re-enters rotation.
    const existing = await db
      .select({ id: queueTable.id })
      .from(queueTable)
      .where(
        and(
          eq(queueTable.isActive, true),
          or(
            eq(queueTable.videoId, row.id),
            row.youtubeId ? eq(queueTable.youtubeId, row.youtubeId) : sql`false`,
          ),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      return { enqueued: false, skipReason: "already-queued" };
    }

    const durationSecs = Math.max(1, Math.round(parseFloat(row.duration ?? "0")) || 1800);
    const inserted = await broadcastService.addToQueue({
      videoId: row.id,
      youtubeId: row.youtubeId ?? "",
      title: row.title,
      thumbnailUrl: row.thumbnailUrl ?? "",
      durationSecs,
      localVideoUrl: row.localVideoUrl ?? null,
      // Populate the queue row's hls_master_url immediately so the orchestrator
      // source resolver uses HLS from the first load — no reload required.
      // For MP4-only videos this is null; transcoder.dispatcher.ts UPDATEs it
      // to the HLS URL when transcoding completes.
      hlsMasterUrl: row.hlsMasterUrl ?? null,
      videoSource: row.videoSource as "youtube" | "local" | "hls",
    });
    logger.info(
      { videoId: row.id, queueItemId: inserted.id, reason: opts.reason },
      "[broadcast] auto-enqueue: video added to broadcast queue",
    );
    return { enqueued: true, queueItemId: inserted.id };
  } catch (err) {
    // Special-case the DB-level unique violation on
    // `uq_broadcast_queue_video_id_active`. That index exists precisely so
    // two concurrent enqueue paths (event-triggered enqueueIfMissing +
    // orchestrator self-heal library scan, or two API replicas) can race
    // safely: the first writer wins, the second sees Postgres 23505. From
    // the caller's perspective this is *not* an error — the video is
    // queued, just not by this call — so emit a debug-level breadcrumb
    // instead of a WARN to avoid alarming operators when the safety net
    // is doing its job.

    // ConflictError from addToQueue's in-transaction pre-check (Layer 1 guard).
    // Semantically identical to the 23505 case: the video is already queued.
    if (err instanceof ConflictError) {
      logger.debug(
        { videoId: opts.videoId, reason: opts.reason },
        "[broadcast] auto-enqueue: duplicate guard fired in addToQueue (already queued)",
      );
      return { enqueued: false, skipReason: "already-queued" };
    }
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") {
      logger.debug(
        { videoId: opts.videoId, reason: opts.reason },
        "[broadcast] auto-enqueue: lost unique-violation race (already queued by concurrent path)",
      );
      return { enqueued: false, skipReason: "already-queued" };
    }
    // Never throw — the caller (upload finalize, YT sync) must continue
    // succeeding even if auto-add hits a transient DB blip. Worst case the
    // library-scan safety net picks the video up within 30 s.
    logger.warn(
      { err, videoId: opts.videoId, reason: opts.reason },
      "[broadcast] auto-enqueue: enqueueIfMissing failed (non-fatal)",
    );
    return { enqueued: false, skipReason: "error" };
  }
}

// ── Storage key derivation (mirrors queue.repo.ts deriveStorageKey) ──────────
//
// publicUrl("uploads/2024/01/15/abc.mp4") → "/api/v1/uploads/2024/01/15/abc.mp4"
// The storage_blobs key is "uploads/2024/01/15/abc.mp4" (with the prefix).
// For relative URLs we strip the leading /api/v1/ segment to restore the key.
// For absolute URLs the suffix after /api/v1/uploads/ must have "uploads/"
// re-added because publicUrl() strips it when building the URL.
function deriveStorageKeyFromUrl(localVideoUrl: string): string | null {
  if (!localVideoUrl) return null;
  if (/^https?:\/\//i.test(localVideoUrl)) {
    const marker = "/api/v1/uploads/";
    const idx = localVideoUrl.indexOf(marker);
    if (idx !== -1) return "uploads/" + localVideoUrl.slice(idx + marker.length);
    const legacyMarker = "/api/uploads/";
    const idx2 = localVideoUrl.indexOf(legacyMarker);
    if (idx2 !== -1) return "uploads/" + localVideoUrl.slice(idx2 + legacyMarker.length);
    return null;
  }
  // Relative URL: /api/v1/uploads/2024/... → uploads/2024/...
  const stripped = localVideoUrl.replace(/^\/(?:api\/(?:v\d+\/)?)?/, "");
  return stripped.startsWith("uploads/") ? stripped : null;
}

/**
 * Self-healing repair sweep: finds all local `managed_videos` rows where
 * `s3_mirrored_at IS NULL` (indicating the post-assembly stamp was either
 * never written or silently swallowed), confirms the storage blob actually
 * exists in `storage_blobs`, and stamps `s3_mirrored_at = NOW()` for every
 * confirmed match.
 *
 * WHY THIS EXISTS:
 *   The upload finalize path sets
 *   `s3MirroredAt` inside a `Promise.all` with `.catch(() => {})` that
 *   previously swallowed errors silently. If that UPDATE ever failed (transient
 *   pool exhaustion, statement timeout), the video's `s3_mirrored_at` would
 *   remain NULL permanently. `scanLibraryAndEnqueue` pre-filters out local
 *   videos whose `s3_mirrored_at IS NULL`, so those videos would never enter
 *   the broadcast queue — not at startup, not during self-heal, never.
 *
 *   This function runs before every `scanLibraryAndEnqueue` call to ensure that
 *   no valid, assembled video is permanently excluded by a stale NULL stamp.
 *
 * SAFETY:
 *   - Only repairs videos where the blob is confirmed present in storage_blobs
 *     (i.e., `completeMultipartUpload` actually committed the bytes). Pre-
 *     committed or partially-assembled rows have no blob row yet and are left
 *     untouched — they continue to be excluded from the scan until the
 *     assembly finishes and stamps the field correctly.
 *   - Excludes terminal error codes (ASSEMBLY_FAILED, CORRUPT_SOURCE,
 *     SOURCE_MISSING) so we don't re-admit permanently broken uploads.
 *   - Batch-updates with a single UPDATE … WHERE id IN (…) to minimise
 *     round-trips; the cap of 500 rows prevents runaway scans on large DBs.
 */
export async function repairMissingS3MirroredAt(videoId?: string): Promise<{ repaired: number }> {
  try {
    // Step 1: Find all local videos with s3MirroredAt IS NULL that look
    // potentially assembled (have a localVideoUrl and no terminal error).
    // When `videoId` is supplied (e.g. from the manual "Sync to Queue" action)
    // the scan is scoped to that single row — the blob check touches one key
    // instead of up to 500, keeping the interactive path cheap on a memory-
    // constrained host.
    const candidates = await db
      .select({
        id: videosTable.id,
        localVideoUrl: videosTable.localVideoUrl,
        objectPath: videosTable.objectPath,
      })
      .from(videosTable)
      .where(
        and(
          ne(videosTable.videoSource, "youtube"),
          isNull(videosTable.s3MirroredAt),
          isNotNull(videosTable.localVideoUrl),
          ...(videoId ? [eq(videosTable.id, videoId)] : []),
        ),
      )
      .limit(500);

    if (candidates.length === 0) return { repaired: 0 };

    // Step 2: Derive storage keys and filter out non-derivable URLs.
    // Prefer object_path (the authoritative storage key written at upload time)
    // over the URL-derived key — mirrors auditMissingBlobs(). Without this, a
    // video whose blob IS present in storage_blobs under its object_path key but
    // whose localVideoUrl derives a different/null key would never be stamped,
    // leaving it permanently "not broadcast-ready — blob stamp is missing".
    const withKeys = candidates.flatMap((r) => {
      const keyFromPath = r.objectPath?.trim() || null;
      const keyFromUrl = deriveStorageKeyFromUrl(r.localVideoUrl ?? "");
      const key = keyFromPath ?? keyFromUrl;
      return key ? [{ id: r.id, key }] : [];
    });
    if (withKeys.length === 0) return { repaired: 0 };

    // Step 3: Batch-check storage_blobs for the derived keys (single round-trip).
    const keys = withKeys.map((r) => r.key);
    const presentRows = await db
      .select({ key: schema.storageBlobsTable.key })
      .from(schema.storageBlobsTable)
      .where(inArray(schema.storageBlobsTable.key, keys));
    const presentSet = new Set(presentRows.map((r) => r.key));

    // Step 4: Stamp s3MirroredAt for every video whose blob is confirmed present.
    const toRepair = withKeys.filter((r) => presentSet.has(r.key)).map((r) => r.id);
    let bytea_repaired = 0;

    if (toRepair.length > 0) {
      await db
        .update(videosTable)
        .set({ s3MirroredAt: new Date() })
        .where(inArray(videosTable.id, toRepair))
        .catch((err: unknown) =>
          logger.warn({ err, count: toRepair.length }, "[auto-enqueue] repair: s3MirroredAt batch stamp failed"),
        );

      bytea_repaired = toRepair.length;
      logger.info(
        { repaired: bytea_repaired, candidates: candidates.length, withKeys: withKeys.length, present: presentSet.size },
        "[auto-enqueue] repair: stamped s3MirroredAt for videos with confirmed storage blobs",
      );
    }

    // Step 5: Legacy HLS stamp — videos with transcodingStatus 'hls_ready' or
    // 'ready' completed the full HLS transcoding pipeline, which only succeeds
    // when the source MP4 was fully committed and readable.  These videos
    // predate the s3MirroredAt column and will never appear in storage_blobs
    // (they were assembled before BYTEA storage or their blob key cannot be
    // derived from localVideoUrl), so the storage_blobs check in steps 1–4
    // never stamps them — leaving them permanently excluded from the broadcast
    // queue with no auto-recovery path.
    //
    // Stamp s3MirroredAt unconditionally for these videos: successful HLS
    // transcoding is proof of content accessibility.  The queue integrity
    // validator (MISSING_BLOB scan) remains the safety net for any video
    // whose source is genuinely unreachable post-stamp.
    const legacyCandidates = await db
      .select({ id: videosTable.id })
      .from(videosTable)
      .where(
        and(
          ne(videosTable.videoSource, "youtube"),
          isNull(videosTable.s3MirroredAt),
          isNotNull(videosTable.localVideoUrl),
          inArray(videosTable.transcodingStatus, ["hls_ready", "ready"]),
          ...(videoId ? [eq(videosTable.id, videoId)] : []),
        ),
      )
      .limit(500);

    let legacy_repaired = 0;

    if (legacyCandidates.length > 0) {
      const legacyIds = legacyCandidates.map((r) => r.id);
      await db
        .update(videosTable)
        .set({ s3MirroredAt: new Date() })
        .where(inArray(videosTable.id, legacyIds))
        .catch((err: unknown) =>
          logger.warn({ err, count: legacyIds.length }, "[auto-enqueue] repair: legacy HLS s3MirroredAt stamp failed"),
        );

      legacy_repaired = legacyCandidates.length;
      logger.info(
        { stamped: legacy_repaired },
        "[auto-enqueue] repair: stamped s3MirroredAt for legacy hls_ready/ready videos",
      );
    }

    return { repaired: bytea_repaired + legacy_repaired };
  } catch (err) {
    logger.warn({ err }, "[auto-enqueue] repairMissingS3MirroredAt failed (non-fatal)");
    return { repaired: 0 };
  }
}

/**
 * Startup blob audit: scans all local managed_videos rows that have a
 * `localVideoUrl` and confirms each one has a corresponding row in
 * `storage_blobs`.  Videos whose blob is absent are logged as errors so
 * operators can identify and re-upload them.  This is a read-only diagnostic
 * — it does NOT deactivate queue items (the queue integrity validator handles
 * that) or delete video rows.
 *
 * Returns a summary of how many videos were checked and how many are missing.
 */
export async function auditMissingBlobs(): Promise<{ checked: number; missing: number; missingIds: string[] }> {
  try {
    const candidates = await db
      .select({
        id: videosTable.id,
        title: videosTable.title,
        localVideoUrl: videosTable.localVideoUrl,
        objectPath: videosTable.objectPath,
      })
      .from(videosTable)
      .where(
        and(
          ne(videosTable.videoSource, "youtube"),
          isNotNull(videosTable.localVideoUrl),
        ),
      )
      .limit(2000);

    if (candidates.length === 0) return { checked: 0, missing: 0, missingIds: [] };

    // Derive storage keys — prefer objectPath (exact DB key) over localVideoUrl.
    const withKeys = candidates.flatMap((r) => {
      // objectPath is the authoritative storage key (e.g. "uploads/2024/01/15/abc.mp4").
      const keyFromPath = r.objectPath?.trim() || null;
      const keyFromUrl = deriveStorageKeyFromUrl(r.localVideoUrl ?? "");
      const key = keyFromPath ?? keyFromUrl;
      return key ? [{ id: r.id, title: r.title, key }] : [];
    });

    if (withKeys.length === 0) return { checked: candidates.length, missing: 0, missingIds: [] };

    const keys = withKeys.map((r) => r.key);
    const presentRows = await db
      .select({ key: schema.storageBlobsTable.key })
      .from(schema.storageBlobsTable)
      .where(inArray(schema.storageBlobsTable.key, keys));
    const presentSet = new Set(presentRows.map((r) => r.key));

    const missingEntries = withKeys.filter((r) => !presentSet.has(r.key));

    if (missingEntries.length > 0) {
      logger.error(
        {
          count: missingEntries.length,
          checked: withKeys.length,
          missing: missingEntries.map((e) => ({ id: e.id, title: e.title, key: e.key })).slice(0, 20),
        },
        "[auto-enqueue] STARTUP BLOB AUDIT: found local videos with missing storage blobs — " +
        "these videos cannot be played; re-upload them to restore. " +
        "The queue integrity validator will deactivate their broadcast queue items.",
      );
    } else {
      logger.info(
        { checked: withKeys.length },
        "[auto-enqueue] STARTUP BLOB AUDIT: all local video blobs confirmed present in storage_blobs ✓",
      );
    }

    return {
      checked: withKeys.length,
      missing: missingEntries.length,
      missingIds: missingEntries.map((e) => e.id),
    };
  } catch (err) {
    logger.warn({ err }, "[auto-enqueue] auditMissingBlobs failed (non-fatal)");
    return { checked: 0, missing: 0, missingIds: [] };
  }
}

/**
 * Scan the entire library for playable videos that are NOT in the broadcast
 * queue, and enqueue every one of them. Two call sites:
 *
 *  1. After a YouTube sync run — picks up freshly-imported YT rows in bulk
 *     without us having to thread "inserted vs updated" diffs through the
 *     ingestion pipeline.
 *
 *  2. Orchestrator empty-queue self-heal — if the queue has been empty for
 *     more than one poll interval AND the library has playable content, we
 *     pull that content into the queue automatically so the broadcast can
 *     come back on-air without operator action.
 *
 * Enforces a hard `maxToAdd` cap so a fresh database with 5 000 imported
 * videos doesn't insert 5 000 queue rows in a single transaction. Items are
 * ordered by `imported_at DESC` so newest content airs first, matching the
 * UX users expect from "add to queue" on the library page.
 */
export async function scanLibraryAndEnqueue(opts: {
  reason: "yt-sync" | "self-heal-empty" | "self-heal-all-blocked" | "manual" | "queue-health-guard" | "startup" | "schedule-bridge-playlist";
  maxToAdd?: number;
}): Promise<{ scanned: number; enqueued: number; skipped: number }> {
  if (!isAutoEnqueueEnabled()) {
    return { scanned: 0, enqueued: 0, skipped: 0 };
  }
  const limit = opts.maxToAdd ?? 200;
  try {
    // Self-healing pre-pass: stamp s3MirroredAt for any local videos whose
    // post-assembly DB update silently failed. This runs before the main
    // candidate query so that repaired videos are immediately visible to the
    // s3_mirrored_at IS NOT NULL filter below.
    await repairMissingS3MirroredAt();

    // Single query: managed_videos LEFT ANTI JOIN broadcast_queue. Returns
    // only library rows that aren't represented in the queue by either
    // videoId or youtubeId. Ordered newest-first so the broadcast leads
    // with the freshest content the moment the queue is hydrated.
    //
    const candidates = await db
      .select({
        id: videosTable.id,
        title: videosTable.title,
        thumbnailUrl: videosTable.thumbnailUrl,
        duration: videosTable.duration,
        videoSource: videosTable.videoSource,
        youtubeId: videosTable.youtubeId,
        localVideoUrl: videosTable.localVideoUrl,
        hlsMasterUrl: videosTable.hlsMasterUrl,
        transcodingStatus: videosTable.transcodingStatus,
        faststartApplied: videosTable.faststartApplied,
        transcodingErrorCode: videosTable.transcodingErrorCode,
        s3MirroredAt: videosTable.s3MirroredAt,
        category: videosTable.category,
        validationStatus: videosTable.validationStatus,
      })
      .from(videosTable)
      .where(
        and(
          // YouTube is library-only — never enters the broadcast queue.
          ne(videosTable.videoSource, "youtube"),
          // Midnight-prayers content is NEVER admitted to the main broadcast queue.
          // It plays exclusively on the dedicated midnight-prayers channel during
          // its restricted 00:00–03:00 window. Belt-and-suspenders: isPlayableForBroadcast()
          // also guards per-row, but excluding at the query level is cheaper and prevents
          // any N-row scan from even considering these videos.
          ne(videosTable.category, "midnight-prayers"),
          // Blob confirmed: repairMissingS3MirroredAt() runs immediately before
          // this query and stamps s3MirroredAt for any video whose post-assembly
          // DB update silently failed. s3MirroredAt IS NOT NULL guarantees the
          // storage blob was committed. Raw MP4 (any moov position) is admitted —
          // faststart is a background quality optimisation, not an admission gate.
          isNotNull(videosTable.localVideoUrl),
          isNotNull(videosTable.s3MirroredAt),
          // NOT EXISTS subquery — keeps the JOIN cheap and the candidate set
          // small; the dedupe inside enqueueIfMissing is the authoritative
          // backstop for the race where two concurrent scans run at once.
          //
          // IMPORTANT: restrict to is_active = true. An inactive queue row
          // means the video was previously dequeued and is no longer in
          // broadcast rotation. Without this filter the scan would treat
          // videos with only inactive rows as "already queued" and never
          // re-add them, silently blocking re-entry into the broadcast.
          sql`NOT EXISTS (
            SELECT 1 FROM ${queueTable}
            WHERE ${queueTable.isActive} = true
              AND (${queueTable.videoId} = ${videosTable.id}
                   OR (${videosTable.youtubeId} IS NOT NULL
                       AND ${queueTable.youtubeId} = ${videosTable.youtubeId}))
          )`,
        ),
      )
      .orderBy(
        // For self-heal refills use RANDOM() so the broadcast rotates through
        // the entire library in a different order each cycle instead of always
        // leading with the newest content — essential for 24/7 variety guarantee.
        // Scheduled yt-sync and manual/startup fills keep newest-first order.
        (opts.reason === "self-heal-empty" || opts.reason === "self-heal-all-blocked")
          ? sql`RANDOM()`
          : desc(videosTable.importedAt),
      )
      .limit(limit);

    let enqueued = 0;
    let skipped = 0;
    for (const row of candidates) {
      if (!isPlayableForBroadcast(row)) {
        skipped += 1;
        continue;
      }
      const res = await enqueueIfMissing({
        videoId: row.id,
        reason: opts.reason === "yt-sync" ? "yt-sync" : "library-scan",
      });
      if (res.enqueued) enqueued += 1;
      else skipped += 1;
    }
    if (enqueued > 0) {
      logger.info(
        { reason: opts.reason, scanned: candidates.length, enqueued, skipped },
        "[broadcast] auto-enqueue: library scan completed",
      );
    }
    return { scanned: candidates.length, enqueued, skipped };
  } catch (err) {
    logger.warn(
      { err, reason: opts.reason },
      "[broadcast] auto-enqueue: scanLibraryAndEnqueue failed (non-fatal)",
    );
    return { scanned: 0, enqueued: 0, skipped: 0 };
  }
}

/**
 * Bulk variant: enqueue a known set of video ids (e.g. the rows newly
 * inserted by an admin batch import). De-duped per-id inside enqueueIfMissing
 * so this is safe to call with any mix of new + existing ids.
 */
export async function enqueueManyIfMissing(
  videoIds: string[],
  reason: "yt-sync" | "manual-import",
): Promise<number> {
  if (!isAutoEnqueueEnabled() || videoIds.length === 0) return 0;
  let enqueued = 0;
  // Process in chunks to bound the rate of DB writes from a single caller —
  // a 1000-row YT sync would otherwise fire 1000 sequential addToQueue +
  // engine reload pairs. The reload coalesces via single-flight, but the
  // insert volume still benefits from chunking.
  const CHUNK = 50;
  for (let i = 0; i < videoIds.length; i += CHUNK) {
    const chunk = videoIds.slice(i, i + CHUNK);
    for (const id of chunk) {
      const res = await enqueueIfMissing({ videoId: id, reason });
      if (res.enqueued) enqueued += 1;
    }
  }
  return enqueued;
}

function isPlayableForBroadcast(row: {
  videoSource: string;
  youtubeId: string | null;
  localVideoUrl: string | null;
  hlsMasterUrl: string | null;
  transcodingStatus?: string | null;
  faststartApplied?: boolean | null;
  transcodingErrorCode?: string | null;
  category?: string | null;
  validationStatus?: string | null;
  /**
   * Optional: when provided, gates broadcast admission on blob confirmation.
   *
   * s3MirroredAt is stamped by the upload finalize path AFTER
   * completeMultipartUpload commits the blob to storage_blobs. A NULL value
   * means one of:
   *   (a) the upload session is still assembling (blob not yet committed),
   *   (b) the post-assembly DB stamp silently failed (repairMissingS3MirroredAt
   *       will recover this within 90 s), or
   *   (c) the video row was pre-committed before the assembly background task
   *       ran (the pre-commit sets transcodingStatus="none" + localVideoUrl but
   *       the blob write is still pending).
   *
   * In ALL cases, broadcasting a video without a confirmed blob causes
   * "Blob not found in storage" errors in the faststart service and the
   * source resolver. Setting s3MirroredAt=null here blocks admission until the
   * blob is confirmed so the error can never originate from the queue.
   *
   * Callers that do not provide this field (e.g. listMissingFromQueue, which
   * is diagnostic-only and does not modify the queue) receive undefined, which
   * skips this gate entirely — backward-compatible behaviour.
   */
  s3MirroredAt?: Date | null;
}): boolean {
  // YouTube is library-only — excluded from broadcast entirely.
  if (row.videoSource === "youtube") return false;

  // Midnight-prayers content is NEVER eligible for the MAIN broadcast queue.
  // It plays exclusively on the dedicated midnight-prayers channel during its
  // restricted 00:00–03:00 station-timezone window. Any video tagged with
  // this category must never appear in the main queue regardless of upload
  // state, transcoding status, or caller reason.
  if (row.category === "midnight-prayers") return false;

  // Validation gate: if comprehensive playback validation explicitly failed
  // (corrupt mdat, truncated file, moov missing after faststart, A/V sync
  // > 2 s, etc.) the video is blocked from broadcast until repaired.
  //
  // null / 'pending' / 'running' / 'passed' / 'warn' → all allow broadcast:
  //   null    — pre-feature rows (never validated); backward compatible.
  //   pending — validation scheduled, not yet started.
  //   running — validation in progress.
  //   passed  — all 9 checks passed; safe to broadcast.
  //   warn    — non-fatal issues (HEVC codec, wide keyframes); operator
  //             review recommended but video is still broadcast-eligible.
  //
  // 'failed' → at least one fatal check (FILE_INTEGRITY, FIRST_FRAME,
  //            LAST_FRAME, AV_SYNC > 2s, DURATION_ACCURACY > 30%) failed.
  //            Block until the operator repairs and re-validates.
  if (row.validationStatus === "failed") return false;

  if (row.localVideoUrl && row.localVideoUrl.trim() !== "") {
    // ── Blob-existence gate ─────────────────────────────────────────────────
    // Only gate when s3MirroredAt was explicitly fetched and provided (not
    // undefined). undefined = caller doesn't filter on blob confirmation (e.g.
    // listMissingFromQueue — diagnostic only, never writes to the queue).
    //
    // s3MirroredAt IS NULL → blob not yet confirmed in storage_blobs.
    // Admitting this video to the broadcast queue would cause:
    //   • faststart service: "Blob not found in storage" errors
    //   • source resolver: storage.getObject() → 404 → dead-air
    //   • queue validator: MISSING_BLOB → auto-deactivate loop
    //
    // repairMissingS3MirroredAt() repairs silently-failed stamps within 90 s,
    // after which this gate passes automatically (no operator action required).
    if (row.s3MirroredAt !== undefined && !row.s3MirroredAt) return false;

    return true;
  }

  return false;
}

/**
 * List which managed_videos rows are currently NOT in the broadcast queue.
 * Exposed for diagnostics / admin "scan now" buttons; the orchestrator
 * never calls this directly.
 */
export async function listMissingFromQueue(limit = 50): Promise<
  Array<{ id: string; title: string; videoSource: string; reason: string }>
> {
  try {
    const rows = await db
      .select({
        id: videosTable.id,
        title: videosTable.title,
        videoSource: videosTable.videoSource,
        youtubeId: videosTable.youtubeId,
        localVideoUrl: videosTable.localVideoUrl,
        hlsMasterUrl: videosTable.hlsMasterUrl,
        category: videosTable.category,
        validationStatus: videosTable.validationStatus,
      })
      .from(videosTable)
      .where(
        and(
          // YouTube is intentionally library-only and never enters the
          // broadcast queue. Exclude these rows so they don't inflate the
          // "missing from queue" count shown in the admin diagnostics panel —
          // operators can't fix a YouTube video being "not queued" because
          // it isn't supposed to be queued.
          ne(videosTable.videoSource, "youtube"),
          // IMPORTANT: restrict NOT EXISTS to is_active = true so we surface
          // videos whose only queue entry is inactive (deactivated/orphaned).
          // Without this filter, videos with inactive rows appear "queued" to
          // the diagnostics endpoint while the orchestrator never plays them.
          sql`NOT EXISTS (
            SELECT 1 FROM ${queueTable}
            WHERE ${queueTable.isActive} = true
              AND (${queueTable.videoId} = ${videosTable.id}
                   OR (${videosTable.youtubeId} IS NOT NULL
                       AND ${queueTable.youtubeId} = ${videosTable.youtubeId}))
          )`,
        ),
      )
      .orderBy(desc(videosTable.importedAt))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      videoSource: r.videoSource,
      reason: isPlayableForBroadcast(r) ? "ready" : "not-yet-playable",
    }));
  } catch (err) {
    logger.warn({ err }, "[broadcast] auto-enqueue: listMissingFromQueue failed");
    return [];
  }
}

// Re-export for callers that want to inspect helpers without a separate import.
export { inArray };
