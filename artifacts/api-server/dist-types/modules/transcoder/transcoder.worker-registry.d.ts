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
export declare const HEARTBEAT_INTERVAL_MS = 30000;
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
declare class WorkerRegistry {
    private workerId;
    private heartbeatTimer;
    private jobsCompleted;
    private jobsFailed;
    private currentJobId;
    private currentStage;
    private readonly log;
    get id(): string;
    register(): Promise<void>;
    heartbeat(opts?: {
        jobId?: string | null;
        stage?: string | null;
    }): Promise<void>;
    setJobState(jobId: string | null, stage: string | null): Promise<void>;
    recordJobCompleted(): void;
    recordJobFailed(): void;
    deregister(): Promise<void>;
    pruneStale(maxAgeMs?: number): Promise<number>;
    getAll(): Promise<WorkerInfo[]>;
    private updateWorkerCount;
}
export declare const workerRegistry: WorkerRegistry;
export {};
