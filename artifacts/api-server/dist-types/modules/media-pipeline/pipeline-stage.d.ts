/**
 * Media pipeline state machine.
 *
 * Single source of truth for where a locally-uploaded video sits in the
 * UPLOADING → VERIFYING → STORED → METADATA → READY → QUEUED →
 * BROADCASTING pipeline. Every stage write goes through `setPipelineStage()`,
 * which enforces forward-only transitions (skipping a stage or re-entering an
 * earlier one silently is impossible) and is idempotent (re-setting the same
 * stage is a structured-log no-op, not a DB write).
 *
 * `computeCanonicalStage()` derives the stage that the *ground-truth* columns
 * (objectPath, s3MirroredAt, validationStatus, transcodingErrorCode) imply.
 * The watchdog (`pipeline-stage-watchdog.ts`) calls this periodically and
 * repairs any drift — this is what makes stale caches, crashed workers, or a
 * missed status write self-heal instead of leaving a video permanently stuck
 * or falsely marked ready.
 *
 * IMPORTANT: this module never *decides* to do work (run validation, enqueue).
 * It only records where a video is. The actual step triggers stay in their
 * existing owners (video-validation.service.ts, auto-enqueue.service.ts) —
 * this keeps the blast radius small and avoids re-implementing already-hardened
 * logic.
 */
export declare const PIPELINE_STAGES: readonly ["uploading", "verifying", "stored", "metadata", "ready", "queued", "broadcasting", "failed"];
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export declare function isPipelineStage(value: unknown): value is PipelineStage;
interface PipelineRow {
    transcodingStatus?: string | null;
    transcodingErrorCode?: string | null;
    objectPath?: string | null;
    s3MirroredAt?: Date | null;
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
export declare function computeCanonicalStage(row: PipelineRow): Exclude<PipelineStage, "uploading" | "verifying" | "queued" | "broadcasting">;
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
export declare function setPipelineStage(videoId: string, stage: PipelineStage, reason: string, opts?: {
    allowBackward?: boolean;
}): Promise<boolean>;
/**
 * Force-reset a video back to the start of the pipeline (e.g. a fresh
 * re-upload replacing a previously failed/stuck file). Bypasses the
 * forward-only guard because this is a legitimate restart, not drift.
 */
export declare function resetPipelineStage(videoId: string, reason: string): Promise<void>;
/**
 * Recompute the canonical stage from ground-truth columns and repair drift.
 * Never downgrades 'queued' or 'broadcasting' (those are event-driven, not
 * derivable from computeCanonicalStage) unless the underlying video is
 * actually failed/blob-missing — in which case correcting to 'failed' is
 * exactly the self-heal we want (a queued item whose source vanished should
 * not keep reporting 'queued').
 */
export declare function reconcilePipelineStage(videoId: string): Promise<{
    corrected: boolean;
    from: string | null;
    to: string | null;
}>;
export {};
