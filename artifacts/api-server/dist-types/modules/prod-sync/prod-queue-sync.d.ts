declare let stats: {
    enabled: boolean;
    upstreamUrl: string | null;
    intervalMs: number;
    lastPollAtMs: number | null;
    lastPollOk: boolean;
    lastPollError: string | null;
    lastUpsertCount: number;
    lastSkippedUnreachableCount: number;
    totalPolls: number;
    totalUpserts: number;
    consecutiveFailures: number;
};
export declare const prodQueueSync: {
    start(): void;
    stop(): void;
    /** Status for /health. */
    getStatus(): typeof stats;
    /** Force an immediate poll (used by tests / manual trigger). */
    pollNow(): Promise<void>;
};
export {};
