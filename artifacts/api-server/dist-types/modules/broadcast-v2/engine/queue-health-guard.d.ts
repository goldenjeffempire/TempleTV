export interface QueueHealthGuardStatus {
    lastCheckAtMs: number | null;
    lastActiveCount: number | null;
    lastRebuildAtMs: number | null;
    totalRebuilds: number;
    lastRebuildAdded: number;
    belowThreshold: boolean;
    threshold: number;
}
declare class QueueHealthGuardImpl {
    private lastCheckAtMs;
    private lastActiveCount;
    private lastRebuildAtMs;
    private totalRebuilds;
    private lastRebuildAdded;
    private belowThreshold;
    private lastOpsAlertAtMs;
    getStatus(): QueueHealthGuardStatus;
    scan(): Promise<void>;
}
export declare const queueHealthGuard: QueueHealthGuardImpl;
export declare function getQueueHealthGuardStatus(): QueueHealthGuardStatus;
export {};
