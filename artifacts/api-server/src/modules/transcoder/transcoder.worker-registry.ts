/**
 * Worker Registry — persistent record of transcoder worker processes.
 *
 * Each live worker process registers on start(), heartbeats every 30 s, and
 * deregisters on stop(). The registry is backed by the `transcoding_workers`
 * PostgreSQL table so it survives restarts and is visible to every replica.
 *
 * The stale-worker pruner removes rows whose last_heartbeat_at is older than
 * WORKER_STALE_THRESHOLD_MS (default 2× the heartbeat interval = 120 s).
 * This ensures the admin worker panel never shows ghost workers.
 */

import { randomUUID } from "node:crypto";
import os from "node:os";
import { eq, lt } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger as rootLogger } from "../../infrastructure/logger.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { transcoderWorkerCount, SERVICE_LABELS } from "../../infrastructure/metrics.js";

const workers = schema.transcodingWorkersTable;

export const HEARTBEAT_INTERVAL_MS = 30_000;
const WORKER_STALE_THRESHOLD_MS = 2 * HEARTBEAT_INTERVAL_MS + 5_000; // 65 s buffer

export interface WorkerInfo {
  workerId: string;
  hostname: string;
  pid: number;
  startedAt: Date;
  lastHeartbeatAt: Date;
  currentJobId: string | null;
  currentStage: string | null;
  jobsCompleted: number;
  jobsFailed: number;
  version: string | null;
  isStale: boolean;
}

class WorkerRegistry {
  private workerId: string = randomUUID();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private jobsCompleted = 0;
  private jobsFailed = 0;
  private currentJobId: string | null = null;
  private currentStage: string | null = null;
  private readonly log = rootLogger.child({ service: "worker-registry" });

  get id(): string { return this.workerId; }

  async register(): Promise<void> {
    try {
      await db.insert(workers).values({
        workerId: this.workerId,
        hostname: os.hostname(),
        pid: process.pid,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        currentJobId: null,
        currentStage: null,
        jobsCompleted: 0,
        jobsFailed: 0,
        version: process.env.npm_package_version ?? null,
      }).onConflictDoUpdate({
        target: workers.workerId,
        set: {
          hostname: os.hostname(),
          pid: process.pid,
          startedAt: new Date(),
          lastHeartbeatAt: new Date(),
          currentJobId: null,
          currentStage: null,
          version: process.env.npm_package_version ?? null,
        },
      });

      this.log.info(
        { workerId: this.workerId, pid: process.pid },
        "transcoder worker registered",
      );

      this.heartbeatTimer = setInterval(() => {
        void this.heartbeat();
      }, HEARTBEAT_INTERVAL_MS);
      this.heartbeatTimer.unref();

      await this.updateWorkerCount();
    } catch (err) {
      this.log.warn({ err }, "worker registry: register failed (non-fatal — continuing without DB registration)");
    }
  }

  async heartbeat(opts?: { jobId?: string | null; stage?: string | null }): Promise<void> {
    if (opts?.jobId !== undefined) this.currentJobId = opts.jobId;
    if (opts?.stage !== undefined) this.currentStage = opts.stage;
    try {
      await db.update(workers)
        .set({
          lastHeartbeatAt: new Date(),
          currentJobId: this.currentJobId,
          currentStage: this.currentStage,
          jobsCompleted: this.jobsCompleted,
          jobsFailed: this.jobsFailed,
        })
        .where(eq(workers.workerId, this.workerId));

      adminEventBus.push("transcoding-worker-update", {
        workerId: this.workerId,
        currentJobId: this.currentJobId,
        currentStage: this.currentStage,
      });
    } catch (err) {
      this.log.debug({ err }, "worker registry: heartbeat failed (non-fatal)");
    }
  }

  async setJobState(jobId: string | null, stage: string | null): Promise<void> {
    this.currentJobId = jobId;
    this.currentStage = stage;
    await this.heartbeat({ jobId, stage });
  }

  recordJobCompleted(): void { this.jobsCompleted++; }
  recordJobFailed(): void { this.jobsFailed++; }

  async deregister(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    try {
      await db.delete(workers).where(eq(workers.workerId, this.workerId));
      this.log.info({ workerId: this.workerId }, "transcoder worker deregistered");
    } catch (err) {
      this.log.warn({ err }, "worker registry: deregister failed (non-fatal)");
    }
    await this.updateWorkerCount();
  }

  async pruneStale(maxAgeMs = WORKER_STALE_THRESHOLD_MS): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - maxAgeMs);
      const out = await db.delete(workers)
        .where(lt(workers.lastHeartbeatAt, cutoff))
        .returning({ workerId: workers.workerId });
      if (out.length > 0) {
        this.log.warn(
          { count: out.length, workerIds: out.map((r) => r.workerId) },
          "worker registry: pruned stale workers",
        );
      }
      await this.updateWorkerCount();
      return out.length;
    } catch (err) {
      this.log.warn({ err }, "worker registry: pruneStale failed (non-fatal)");
      return 0;
    }
  }

  async getAll(): Promise<WorkerInfo[]> {
    try {
      const rows = await db.select().from(workers).orderBy(workers.lastHeartbeatAt);
      const now = Date.now();
      return rows.map((r) => ({
        ...r,
        isStale: now - r.lastHeartbeatAt.getTime() > WORKER_STALE_THRESHOLD_MS,
      }));
    } catch (err) {
      this.log.warn({ err }, "worker registry: getAll failed");
      return [];
    }
  }

  private async updateWorkerCount(): Promise<void> {
    try {
      const rows = await db.select().from(workers);
      transcoderWorkerCount.set(SERVICE_LABELS, rows.length);
    } catch {
      /* non-fatal */
    }
  }
}

export const workerRegistry = new WorkerRegistry();
