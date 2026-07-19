export declare const cleanupWorker: {
    start(): void;
    stop(): void;
};
export declare function scheduleSourceCleanup(_videoId: string): Promise<void>;
export declare function runCleanupSweep(): Promise<{
    cleaned: number;
    failed: number;
    skipped: number;
}>;
