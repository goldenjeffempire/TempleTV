export interface CleanupStats {
    lastRunAtMs: number | null;
    lastRunDurationMs: number | null;
    totalRuns: number;
    lastOrphanedRefCount: number;
    orphanedRefCandidates: Array<{
        id: string;
        title: string;
        videoId: string;
    }>;
    lastError: string | null;
    nextRunAtMs: number | null;
}
declare class OrphanCleanupWorkerImpl {
    private timer;
    private nextRunAtMs;
    private stats;
    start(intervalMs?: number): void;
    stop(): void;
    getStats(): CleanupStats;
    sweep(): Promise<void>;
}
export declare const orphanCleanupWorker: OrphanCleanupWorkerImpl;
export {};
