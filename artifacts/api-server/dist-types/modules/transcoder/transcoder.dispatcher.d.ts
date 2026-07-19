export declare const transcoderDispatcher: {
    start(): void;
    stop(): void;
    nudge(): void;
    getHeartbeat(): {
        ffmpegAvailable: boolean;
        stopped: boolean;
        isRunning: boolean;
        circuitOpen: boolean;
        circuitOpenRemainingMs: number | null;
        currentJobId: string | null;
        currentJobVideoId: string | null;
        lastHeartbeatAt: number | null;
        lastCompletedAt: number | null;
        lastCompletedJobId: string | null;
        lastCompletedStatus: "done" | "failed" | null;
        storageCircuitOpenUntil: number;
        storageErrorStreak: number;
    };
};
