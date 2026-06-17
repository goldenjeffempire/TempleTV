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

import { and, desc, eq, isNull, lt, ne, or } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger as rootLogger } from "../../infrastructure/logger.js";
import { env } from "../../config/env.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { transcoderLeaseReclaimTotal, SERVICE_LABELS } from "../../infrastructure/metrics.js";
import { emitJobEvent } from "./transcoder.job-events.js";

const jobs = schema.transcodingJobsTable;

export class JobLeaseManager {
  private readonly log = rootLogger.child({ module: "job-lease-manager" });

  get leaseTtlMs(): number { return env.TRANSCODER_LEASE_TTL_MS; }

  private leaseExpiry(): Date {
    return new Date(Date.now() + this.leaseTtlMs);
  }

  /**
   * Atomically claim a queued job: pick the highest-priority queued/due job,
   * set lease_expires_at, leased_by, and status='processing'.
   *
   * Also handles reclaiming expired leases: includes jobs where
   * lease_expires_at < now() (regardless of leased_by) so idle workers
   * automatically recover dead-worker jobs.
   */
  async claimJob(workerId: string): Promise<typeof schema.transcodingJobsTable.$inferSelect | null> {
    const now = new Date();
    const leaseExpiry = this.leaseExpiry();

    try {
      const candidates = await db
        .select()
        .from(jobs)
        .where(and(
          eq(jobs.status, "queued"),
          or(
            isNull(jobs.nextRetryAt),
            lt(jobs.nextRetryAt, now),
          ),
        ))
        .orderBy(desc(jobs.priority), jobs.createdAt)
        .limit(5);

      if (candidates.length === 0) return null;

      for (const candidate of candidates) {
        const claimed = await db
          .update(jobs)
          .set({
            status: "processing",
            stage: "pending",
            stageProgress: 0,
            startedAt: now,
            progress: 0,
            errorMessage: null,
            leaseExpiresAt: leaseExpiry,
            leasedBy: workerId,
          })
          .where(and(
            eq(jobs.id, candidate.id),
            eq(jobs.status, "queued"),
          ))
          .returning();

        if (claimed[0]) {
          await emitJobEvent({
            jobId: claimed[0].id,
            workerId,
            eventType: "lease_claimed",
            stage: "pending",
            payload: { leaseExpiry: leaseExpiry.toISOString() },
          });
          return claimed[0];
        }
      }
      return null;
    } catch (err) {
      this.log.warn({ err, workerId }, "lease manager: claimJob failed");
      return null;
    }
  }

  /**
   * Renew lease for a job currently owned by this worker.
   * Returns true if renewed, false if the lease was lost (stolen by reclaimer).
   */
  async renewLease(jobId: string, workerId: string): Promise<boolean> {
    try {
      const out = await db
        .update(jobs)
        .set({ leaseExpiresAt: this.leaseExpiry() })
        .where(and(
          eq(jobs.id, jobId),
          eq(jobs.leasedBy, workerId),
          eq(jobs.status, "processing"),
        ))
        .returning({ id: jobs.id });
      return out.length > 0;
    } catch (err) {
      this.log.debug({ err, jobId }, "lease manager: renewLease failed (non-fatal)");
      return false;
    }
  }

  /**
   * Release lease on job completion/failure. Clears leasedBy + leaseExpiresAt.
   */
  async releaseLease(jobId: string, workerId: string): Promise<void> {
    try {
      await db
        .update(jobs)
        .set({ leaseExpiresAt: null, leasedBy: null })
        .where(and(eq(jobs.id, jobId), eq(jobs.leasedBy, workerId)));
    } catch {
      /* non-fatal — job may already be in terminal state */
    }
  }

  /**
   * Sweep for expired leases owned by OTHER workers and reset those jobs to queued.
   * Runs on a periodic interval (TRANSCODER_LEASE_RECLAIM_INTERVAL_MS, default 60s).
   */
  async reclaimExpiredLeases(currentWorkerId: string): Promise<number> {
    const now = new Date();
    try {
      const expiredJobs = await db
        .select({
          id: jobs.id,
          videoId: jobs.videoId,
          attempts: jobs.attempts,
          maxAttempts: jobs.maxAttempts,
          leasedBy: jobs.leasedBy,
        })
        .from(jobs)
        .where(and(
          eq(jobs.status, "processing"),
          lt(jobs.leaseExpiresAt, now),
          ne(jobs.leasedBy, currentWorkerId),
        ));

      if (expiredJobs.length === 0) return 0;

      let reclaimed = 0;
      for (const expired of expiredJobs) {
        const newAttempts = expired.attempts + 1;
        const exceeded = newAttempts >= expired.maxAttempts;

        const out = await db
          .update(jobs)
          .set({
            status: exceeded ? "failed" : "queued",
            stage: "pending",
            stageProgress: 0,
            progress: 0,
            attempts: newAttempts,
            startedAt: null,
            lastProgressAt: null,
            completedAt: exceeded ? new Date() : null,
            leaseExpiresAt: null,
            leasedBy: null,
            errorMessage: exceeded
              ? `Job permanently failed: lease expired ${newAttempts} times — worker died mid-encode. Operator review required.`
              : `Lease reclaimed from dead worker (attempt ${newAttempts}/${expired.maxAttempts}) — re-queuing for retry.`,
          })
          .where(and(
            eq(jobs.id, expired.id),
            eq(jobs.status, "processing"),
            lt(jobs.leaseExpiresAt, now),
          ))
          .returning({ id: jobs.id });

        if (out.length > 0) {
          reclaimed++;
          transcoderLeaseReclaimTotal.inc(SERVICE_LABELS);

          await emitJobEvent({
            jobId: expired.id,
            workerId: currentWorkerId,
            eventType: "lease_reclaimed",
            stage: "pending",
            payload: {
              deadWorker: expired.leasedBy,
              newAttempts,
              exceeded,
            },
          }).catch(() => { /* non-fatal */ });

          // Sync managed_videos to match the reclaimed job's new status so the
          // video never gets stuck at "encoding" after a dead-worker permanent
          // failure. The hls_ready guard prevents a race where HLS completed
          // just before this watchdog ran — we must never downgrade a done video.
          if (expired.videoId) {
            const videosTable = schema.videosTable;
            if (exceeded) {
              await db.update(videosTable)
                .set({
                  transcodingStatus: "failed",
                  transcodingErrorCode: "STUCK_JOB",
                  transcodingErrorMessage:
                    `Job permanently failed: lease expired ${newAttempts} time(s) — worker died mid-encode. ` +
                    `Operator review required.`,
                })
                .where(and(
                  eq(videosTable.id, expired.videoId),
                  ne(videosTable.transcodingStatus, "hls_ready"),
                ))
                .catch(() => { /* non-fatal */ });
            } else {
              await db.update(videosTable)
                .set({ transcodingStatus: "queued" })
                .where(and(
                  eq(videosTable.id, expired.videoId),
                  ne(videosTable.transcodingStatus, "hls_ready"),
                ))
                .catch(() => { /* non-fatal */ });
            }
          }

          adminEventBus.push("transcoding-update", {
            videoId: expired.videoId,
            jobId: expired.id,
            status: exceeded ? "failed" : "queued",
            progress: 0,
          });

          this.log.warn(
            { jobId: expired.id, deadWorker: expired.leasedBy, newAttempts, exceeded },
            "lease manager: reclaimed expired job from dead worker",
          );
        }
      }

      return reclaimed;
    } catch (err) {
      this.log.warn({ err }, "lease manager: reclaimExpiredLeases failed (non-fatal)");
      return 0;
    }
  }
  /** List all active (processing) and recently expired leases — for admin diagnostics. */
  async listActiveLeases(): Promise<{
    jobId: string;
    leasedBy: string | null;
    leaseExpiresAt: string | null;
    status: string;
    stage: string | null;
    isExpired: boolean;
  }[]> {
    const now = new Date();
    try {
      const rows = await db
        .select({
          id: jobs.id,
          leasedBy: jobs.leasedBy,
          leaseExpiresAt: jobs.leaseExpiresAt,
          status: jobs.status,
          stage: jobs.stage,
        })
        .from(jobs)
        .where(eq(jobs.status, "processing"))
        .orderBy(desc(jobs.leaseExpiresAt))
        .limit(100);

      return rows.map((r) => ({
        jobId: r.id,
        leasedBy: r.leasedBy,
        leaseExpiresAt: r.leaseExpiresAt?.toISOString() ?? null,
        status: r.status,
        stage: r.stage,
        isExpired: r.leaseExpiresAt ? r.leaseExpiresAt < now : false,
      }));
    } catch (err) {
      this.log.warn({ err }, "lease manager: listActiveLeases failed");
      return [];
    }
  }
}

export const jobLeaseManager = new JobLeaseManager();
