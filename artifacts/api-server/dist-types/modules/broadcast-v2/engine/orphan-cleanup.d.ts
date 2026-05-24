export interface CleanupStats {
    lastRunAtMs: number | null;
    lastRunDurationMs: number | null;
    totalRuns: number;
    lastOrphanedRefCount: number;
    lastOrphanedRefsDeactivated: number;
    orphanedRefCandidates: Array<{
        id: string;
        title: string;
        videoId: string;
    }>;
    lastStaleSessiosClosed: number;
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
