interface SweepStats {
    orphanedSessionsRemoved: number;
    orphanedChunksRemoved: number;
    corruptBlobsDeleted: number;
    stuckTranscodeReset: number;
    errors: number;
}
export declare const cleanupWorker: {
    start(): void;
    stop(): void;
    /** Run a sweep immediately (for testing / admin "run now" trigger). */
    sweep(): Promise<SweepStats>;
};
export {};
