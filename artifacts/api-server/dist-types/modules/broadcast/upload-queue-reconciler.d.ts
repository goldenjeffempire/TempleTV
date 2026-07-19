/**
 * Upload Queue Reconciler — final safety-net for the upload→queue pipeline.
 *
 * PROBLEM: the primary enqueue path (chunked-upload finalize background task)
 * handles ~99% of uploads correctly. The remaining 1% can slip through due to:
 *   • Transient DB pool exhaustion at enqueue time (enqueueIfMissing returns
 *     skipReason:"error" and gives up — no retry scheduled)
 *   • s3MirroredAt stamp silently failing (Promise.all .catch swallows the
 *     error; video stays s3MirroredAt=NULL; isPlayableForBroadcast rejects it)
 *   • Process crash / SIGTERM arriving between blob commit and enqueue call
 *   • s3MirroredAt update racing with enqueueIfMissing in the same ms window
 *   • Legacy S3 finalize path (media-uploads.routes.ts) missing enqueueIfMissing
 *
 * SOLUTION: this worker runs every 60 seconds with a 30 s initial delay. It:
 *   1. Runs repairMissingS3MirroredAt() first — stamps any confirmed blobs
 *      whose post-assembly DB update silently failed, making them visible to
 *      the s3MirroredAt IS NOT NULL filter below.
 *   2. Scans for local videos uploaded in the last 24 hours that have a
 *      confirmed blob (s3MirroredAt IS NOT NULL) but NO active queue row.
 *   3. Calls enqueueIfMissing() for each — idempotent, safe to call repeatedly.
 *   4. Fires broadcast-queue-updated + orchestrator reload so the newly-queued
 *      video is available for broadcast immediately.
 *
 * This worker is the final backstop. The primary path handles the fast case;
 * this worker guarantees correctness within 60 seconds in all other cases.
 * No operator action is ever required to recover a missed enqueue.
 */
export declare const uploadQueueReconciler: {
    scan(): Promise<{
        scanned: number;
        enqueued: number;
        repaired: number;
    }>;
};
