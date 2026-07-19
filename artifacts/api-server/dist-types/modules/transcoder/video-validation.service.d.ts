/**
 * video-validation.service.ts
 *
 * Broadcast-grade video validation — 9 isolated checks run after faststart.
 *
 * Checks:
 *   1. FILE_INTEGRITY    — magic bytes + ffprobe container validity
 *   2. MOOV_PLACEMENT    — moov atom at start (faststart gate)
 *   3. CODEC_COMPAT      — H.264 + AAC/MP3/AC3 for broad platform support
 *   4. KEYFRAME_INTERVAL — max interval ≤ 10 s for Smart TV / mobile seeking
 *   5. AV_SYNC           — stream start_time offset ≤ 500 ms (audio dropout)
 *   6. FIRST_FRAME       — decode first 2 s of mdat (corruption detection)
 *   7. LAST_FRAME        — decode last 5 s (truncation detection)
 *   8. DURATION_ACCURACY — stored vs probed duration ≤ 10% deviation
 *   9. RANGE_SUPPORT     — HTTP 206 on loopback (player fast-seek)
 *
 * Design constraints:
 *   • One check failure NEVER aborts others — all 9 always run.
 *   • O(1) RSS: streaming download, no full-file buffering.
 *   • Every ffprobe/ffmpeg gets proc.unref() + SIGKILL AbortTimer.
 *   • Temp directory always deleted in finally — no leaks on thrown errors.
 *   • Total wall-clock budget: VALIDATION_JOB_TIMEOUT_MS (default 180 s).
 *
 * Status mapping:
 *   'failed'  — any check returned 'fail' (FILE_INTEGRITY or CODEC_COMPAT
 *               no-video-stream only — all other checks were softened to warn)
 *   'warn'    — at least one 'warn', no 'fail'
 *   'passed'  — all 'pass' or 'skip'
 *
 * Broadcast gate:
 *   Validation is ADVISORY ONLY — all statuses allow broadcast admission.
 *   null/pending/running/passed/warn/failed → broadcast-eligible.
 *   isPlayableForBroadcast() does NOT gate on validationStatus.
 *   Validation results surface in the admin UI and validation report so
 *   operators are informed, but never prevent a video from airing.
 *
 *   The two remaining hard-fail checks signal genuinely unplayable files:
 *     FILE_INTEGRITY  — ffprobe cannot parse the container at all.
 *     CODEC_COMPAT    — no video stream found (pure-audio container).
 *   Even these produce validationStatus='failed' for operator visibility
 *   only — they do not automatically remove the item from the queue.
 */
export type CheckStatus = "pass" | "warn" | "fail" | "skip";
export interface VideoCheckResult {
    check: string;
    status: CheckStatus;
    message: string;
    detail?: Record<string, unknown>;
}
export type ValidationStatus = "pending" | "running" | "passed" | "warn" | "failed";
export interface VideoValidationReport {
    videoId: string;
    status: ValidationStatus;
    checks: VideoCheckResult[];
    repairsPerformed: string[];
    remainingIssues: string[];
    durationMs: number;
    completedAt: string;
    /** True if a remux-based auto-remediation attempt was made (regardless of outcome). */
    remediationAttempted?: boolean;
    /**
     * Only set when status ends up 'failed' AFTER a remediation attempt:
     *   'CORRUPT_SOURCE'         — mdat present but moov permanently missing;
     *                              no stream-copy remux can recover this file.
     *   'REMEDIATION_EXHAUSTED'  — remux ran but the repaired output still
     *                              failed the same check(s).
     */
    rootCauseCode?: "CORRUPT_SOURCE" | "REMEDIATION_EXHAUSTED";
}
interface RunValidationOpts {
    /** Write results to DB (default true). */
    storeResult?: boolean;
    /** Already-fetched stored duration in seconds (avoids extra DB round-trip). */
    storedDurationSecs?: number | null;
    /** Whether faststartApplied flag is already known (avoids extra DB read). */
    faststartApplied?: boolean | null;
    /** localVideoUrl for the Range check. */
    localVideoUrl?: string | null;
}
/**
 * Run the full 9-check validation pipeline against a locally-stored MP4.
 *
 * Downloads the source blob to a temp file, runs all 9 checks, deletes the
 * temp file, persists the report in `managed_videos`, and returns the report.
 *
 * Meant to be called after faststart completes — both from the upload finalize
 * path and from the faststart recovery worker.
 */
export declare function runVideoValidation(videoId: string, objectKey: string, opts?: RunValidationOpts): Promise<VideoValidationReport>;
/**
 * Fire-and-forget wrapper. Sets validationStatus='pending', then schedules
 * runVideoValidation on the next tick. Safe to call from upload finalize
 * without blocking the HTTP response.
 *
 * Errors inside the validation job are fully caught and logged — they never
 * propagate to the caller.
 */
export declare function scheduleVideoValidation(videoId: string, objectKey: string, opts?: RunValidationOpts): void;
/**
 * Return the stored validation report from the DB without re-running checks.
 * Returns null if the video has not yet been validated.
 */
export declare function getStoredValidationReport(videoId: string): Promise<VideoValidationReport | null>;
export {};
