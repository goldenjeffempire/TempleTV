/**
 * Media pipeline state machine.
 *
 * Single source of truth for where a locally-uploaded video sits in the
 * UPLOADING → VERIFYING → STORED → FASTSTART → METADATA → READY → QUEUED →
 * BROADCASTING pipeline. Every stage write goes through `setPipelineStage()`,
 * which enforces forward-only transitions (skipping a stage or re-entering an
 * earlier one silently is impossible) and is idempotent (re-setting the same
 * stage is a structured-log no-op, not a DB write).
 *
 * `computeCanonicalStage()` derives the stage that the *ground-truth* columns
 * (objectPath, s3MirroredAt, faststartApplied, validationStatus,
 * transcodingErrorCode) imply. The watchdog (`pipeline-stage-watchdog.ts`)
 * calls this periodically and repairs any drift — this is what makes stale
 * caches, crashed workers, or a missed status write self-heal instead of
 * leaving a video permanently stuck or falsely marked ready.
 *
 * IMPORTANT: this module never *decides* to do work (run faststart, run
 * validation, enqueue). It only records where a video is. The actual step
 * triggers stay in their existing owners (faststart.service.ts,
 * video-validation.service.ts, auto-enqueue.service.ts) — this keeps the
 * blast radius small and avoids re-implementing already-hardened logic.
 */

import { eq } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";

export const PIPELINE_STAGES = [
  "uploading",
  "verifying",
  "stored",
  "faststart",
  "metadata",
  "ready",
  "queued",
  "broadcasting",
  "failed",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

// Ordinal rank for forward-only transition enforcement. 'failed' is
// deliberately excluded — it is reachable from any stage (a terminal
// side-exit, not a forward step) and is itself always exitable by a repair
// (re-upload / manual retry) that restarts the machine at 'uploading'.
const STAGE_RANK: Record<Exclude<PipelineStage, "failed">, number> = {
  uploading: 0,
  verifying: 1,
  stored: 2,
  faststart: 3,
  metadata: 4,
  ready: 5,
  queued: 6,
  broadcasting: 7,
};

export function isPipelineStage(value: unknown): value is PipelineStage {
  return typeof value === "string" && (PIPELINE_STAGES as readonly string[]).includes(value);
}

interface PipelineRow {
  transcodingStatus?: string | null;
  transcodingErrorCode?: string | null;
  objectPath?: string | null;
  s3MirroredAt?: Date | null;
  faststartApplied?: boolean | null;
  validationStatus?: string | null;
}

/**
 * Derive the stage implied by ground-truth columns alone. This intentionally
 * ignores the currently-stored `pipelineStage` value — it answers "what
 * SHOULD the stage be right now" so the watchdog can detect and correct
 * drift (stuck jobs, crashed workers, races that left the flag stale).
 *
 * This does NOT distinguish 'uploading' vs 'verifying' vs 'queued' vs
 * 'broadcasting' — those four are event-driven (upload session state, queue
 * membership, orchestrator "now playing") rather than derivable purely from
 * the managed_videos row, so callers that already know one of those states
 * should call `setPipelineStage()` directly instead of relying on this.
 */
export function computeCanonicalStage(row: PipelineRow): Exclude<PipelineStage, "uploading" | "verifying" | "queued" | "broadcasting"> {
  if (row.transcodingStatus === "failed" && !row.faststartApplied) return "failed";
  if (row.transcodingErrorCode === "SOURCE_MISSING" || row.transcodingErrorCode === "CORRUPT_SOURCE") return "failed";
  if (row.validationStatus === "failed") return "failed";

  if (!row.objectPath) return "failed";
  if (!row.s3MirroredAt) return "stored"; // not really — caller should treat "no objectPath yet" upstream as verifying/uploading
  if (!row.faststartApplied) return "faststart";
  if (row.validationStatus === "passed" || row.validationStatus === "warn") return "ready";
  return "metadata";
}

/**
 * Idempotent, forward-only stage writer.
 *
 * - No-ops (does not touch the DB) when the video is already at `stage`.
 * - Refuses to move backward along the pipeline UNLESS `allowBackward` is
 *   set (only the watchdog's drift-repair path sets this) or the target is
 *   'failed' (always allowed — a terminal exit from any point).
 * - Every real transition is a single structured log line with the video id,
 *   from-stage, to-stage, and reason, so the whole pipeline is traceable
 *   from logs alone.
 */
export async function setPipelineStage(
  videoId: string,
  stage: PipelineStage,
  reason: string,
  opts: { allowBackward?: boolean } = {},
): Promise<boolean> {
  const videos = schema.videosTable;
  const [current] = await db
    .select({ pipelineStage: videos.pipelineStage })
    .from(videos)
    .where(eq(videos.id, videoId))
    .limit(1);

  if (!current) {
    logger.warn({ videoId, stage, reason }, "[pipeline-stage] setPipelineStage: video not found");
    return false;
  }

  const from = isPipelineStage(current.pipelineStage) ? current.pipelineStage : null;

  if (from === stage) {
    // Idempotent no-op — already there. Common on retries/re-runs.
    return false;
  }

  const isForced = stage === "failed" || opts.allowBackward;
  if (!isForced && from && from !== "failed") {
    const fromRank = STAGE_RANK[from as Exclude<PipelineStage, "failed">];
    const toRank = STAGE_RANK[stage as Exclude<PipelineStage, "failed">];
    if (fromRank !== undefined && toRank !== undefined && toRank < fromRank) {
      logger.warn(
        { videoId, from, to: stage, reason },
        "[pipeline-stage] blocked illegal backward transition (use reconcilePipelineStage for repairs)",
      );
      return false;
    }
    // Also block skipping ahead by more than one stage — every stage must
    // actually be entered, never jumped over.
    if (fromRank !== undefined && toRank !== undefined && toRank > fromRank + 1) {
      logger.warn(
        { videoId, from, to: stage, reason },
        "[pipeline-stage] blocked stage-skip transition (missing intermediate stage)",
      );
      return false;
    }
  }

  await db
    .update(videos)
    .set({ pipelineStage: stage, pipelineStageUpdatedAt: new Date() })
    .where(eq(videos.id, videoId));

  logger.info({ videoId, from, to: stage, reason }, "[pipeline-stage] transition");
  return true;
}

/**
 * Force-reset a video back to the start of the pipeline (e.g. a fresh
 * re-upload replacing a previously failed/stuck file). Bypasses the
 * forward-only guard because this is a legitimate restart, not drift.
 */
export async function resetPipelineStage(videoId: string, reason: string): Promise<void> {
  await setPipelineStage(videoId, "uploading", reason, { allowBackward: true });
}

/**
 * Recompute the canonical stage from ground-truth columns and repair drift.
 * Never downgrades 'queued' or 'broadcasting' (those are event-driven, not
 * derivable from computeCanonicalStage) unless the underlying video is
 * actually failed/blob-missing — in which case correcting to 'failed' is
 * exactly the self-heal we want (a queued item whose source vanished should
 * not keep reporting 'queued').
 */
export async function reconcilePipelineStage(videoId: string): Promise<{ corrected: boolean; from: string | null; to: string | null }> {
  const videos = schema.videosTable;
  const [row] = await db
    .select({
      pipelineStage: videos.pipelineStage,
      transcodingStatus: videos.transcodingStatus,
      transcodingErrorCode: videos.transcodingErrorCode,
      objectPath: videos.objectPath,
      s3MirroredAt: videos.s3MirroredAt,
      faststartApplied: videos.faststartApplied,
      validationStatus: videos.validationStatus,
    })
    .from(videos)
    .where(eq(videos.id, videoId))
    .limit(1);

  if (!row) return { corrected: false, from: null, to: null };

  const current = isPipelineStage(row.pipelineStage) ? row.pipelineStage : null;
  const canonical = computeCanonicalStage(row);

  // Never regress an event-driven stage (queued/broadcasting) toward
  // 'stored'/'faststart'/'metadata'/'ready' based on ground truth alone —
  // those columns don't know about queue membership. Only allow the
  // canonical value to override when it says 'failed' (a real problem).
  if ((current === "queued" || current === "broadcasting") && canonical !== "failed") {
    return { corrected: false, from: current, to: current };
  }

  if (current === canonical) {
    return { corrected: false, from: current, to: current };
  }

  const changed = await setPipelineStage(
    videoId,
    canonical,
    `watchdog reconciliation: ground truth implies '${canonical}', was '${current ?? "unset"}'`,
    { allowBackward: true },
  );

  return { corrected: changed, from: current, to: canonical };
}
