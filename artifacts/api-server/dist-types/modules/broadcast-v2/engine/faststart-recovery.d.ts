/**
 * Faststart recovery worker.
 *
 * Closes the v1/v2 admission gap that produces "Off Air" even though the
 * v1 `/broadcast/guide` reports a currently-playing local MP4.
 *
 * Root cause:
 *   `queueRepo.loadActive()` (broadcast-v2/repository/queue.repo.ts) enforces
 *   STRICT BROADCAST POLICY — for managed_videos rows where
 *   `transcoding_status ∈ (none, queued, encoding)` it admits the row ONLY
 *   when `faststart_applied = true`. Un-faststarted MP4s have the moov atom
 *   at EOF and trigger SKIP_PENDING dead-air loops on every player surface
 *   that binds them.
 *
 *   When faststart did not run during the upload-finalize chain (network
 *   blip, ffmpeg crash, restart between finalize and the void runFaststart
 *   call, etc.) the row sits in the broadcast_queue forever, invisible to
 *   v2, and the channel reports Off Air despite a perfectly good source
 *   blob in object storage.
 *
 * This worker:
 *   1. Periodically scans for active queue items whose joined managed_videos
 *      row is local-source, has an objectPath, has faststart_applied=false,
 *      and is in a status that requires faststart for admission.
 *   2. Fires `runFaststart()` for each candidate (fire-and-forget — the
 *      function already handles status restore on failure).
 *   3. Enforces an in-memory attempt cap (3) and in-flight set so we never
 *      stampede ffmpeg or loop on a permanently corrupt source.
 *
 * Safety:
 *   - Attempt counters reset on process restart by design — operators can
 *     re-trigger by redeploying, and ffmpeg cost is bounded by FASTSTART
 *     timeout (15 min) anyway. Persisting counters would require a schema
 *     migration that the column-resilience hot path in queue.repo.ts proves
 *     is risky during incremental deploys.
 *   - Never throws into the supervisor — every error is logged and swallowed
 *     so a single corrupt file does not stop recovery for the rest.
 *   - Uses the same runFaststart entry point that admin "Re-apply faststart"
 *     uses, so any future hardening to that function applies here too.
 */
interface RecoveryStats {
    enabled: boolean;
    installedAt: number | null;
    lastSweepAt: number | null;
    lastSweepCandidates: number;
    lastSweepDispatched: number;
    totalSweeps: number;
    totalDispatched: number;
    totalSucceeded: number;
    totalFailed: number;
    totalGivenUp: number;
    lastError: string | null;
    lastErrorAt: number | null;
}
export declare const faststartRecoveryWorker: {
    sweep(): Promise<void>;
    markEnabled(): void;
    getStats(): Readonly<RecoveryStats>;
    /** Test/admin-only: reset attempt counters so retried items get a fresh chance. */
    resetAttempts(videoId?: string): void;
    /** Diagnostic: number of permanently-given-up videos this process lifetime. */
    getGivenUpCount(): number;
};
export {};
