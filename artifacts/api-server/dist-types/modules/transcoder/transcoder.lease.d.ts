/**
 * Job Lease Manager — distributed lease TTL for transcoding jobs.
 *
 * Prevents jobs from getting permanently stuck when a worker process dies
 * mid-encode. Each worker atomically stamps `lease_expires_at` and `leased_by`
 * when it claims a job, and renews the lease every LEASE_RENEW_MS. If a
 * worker dies, its lease expires and any idle worker's next reclaim sweep
 * resets the job to 'queued' within ~90 s.
 *
 * Key guarantees:
 *  • Claim is atomic: UPDATE...WHERE status='queued' AND (lease IS NULL OR expired) RETURNING *
 *  • Renew is atomic: UPDATE...WHERE leased_by=thisWorker RETURNING *
 *  • Reclaim is safe across replicas: only resets expired leases owned by OTHER workers
 */
import { schema } from "../../infrastructure/db.js";
export declare class JobLeaseManager {
    private readonly log;
    get leaseTtlMs(): number;
    private leaseExpiry;
    /**
     * Atomically claim a queued job: pick the highest-priority queued/due job,
     * set lease_expires_at, leased_by, and status='processing'.
     *
     * Also handles reclaiming expired leases: includes jobs where
     * lease_expires_at < now() (regardless of leased_by) so idle workers
     * automatically recover dead-worker jobs.
     */
    claimJob(workerId: string): Promise<typeof schema.transcodingJobsTable.$inferSelect | null>;
    /**
     * Renew lease for a job currently owned by this worker.
     * Returns true if renewed, false if the lease was lost (stolen by reclaimer).
     */
    renewLease(jobId: string, workerId: string): Promise<boolean>;
    /**
     * Release lease on job completion/failure. Clears leasedBy + leaseExpiresAt.
     */
    releaseLease(jobId: string, workerId: string): Promise<void>;
    /**
     * Sweep for expired leases owned by OTHER workers and reset those jobs to queued.
     * Runs on a periodic interval (TRANSCODER_LEASE_RECLAIM_INTERVAL_MS, default 60s).
     */
    reclaimExpiredLeases(currentWorkerId: string): Promise<number>;
    /** List all active (processing) and recently expired leases — for admin diagnostics. */
    listActiveLeases(): Promise<{
        jobId: string;
        leasedBy: string | null;
        leaseExpiresAt: string | null;
        status: string;
        stage: string | null;
        isExpired: boolean;
    }[]>;
}
export declare const jobLeaseManager: JobLeaseManager;
