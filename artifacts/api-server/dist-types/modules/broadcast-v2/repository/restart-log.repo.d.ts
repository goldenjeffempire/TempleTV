export type RestartResumeSource = "checkpoint" | "disk_backup" | "cold_start";
export interface RestartRecord {
    channelId: string;
    resumeSource: RestartResumeSource;
    resumeItemId: string | null;
    resumePositionMs: number;
    resumeSequence: number;
}
export interface RestartHistoryEntry {
    id: number;
    restartedAt: Date;
    resumeSource: string;
    resumeItemId: string | null;
    resumePositionMs: number;
    resumeSequence: number;
}
export declare const restartLogRepo: {
    /**
     * Write a restart record immediately after the orchestrator boots.
     * Non-throwing — a failed write must never prevent the daemon from starting.
     */
    write(rec: RestartRecord): Promise<void>;
    /**
     * Load the most recent restart records for a channel, newest first.
     */
    load(channelId: string, limit?: number): Promise<RestartHistoryEntry[]>;
    /**
     * Delete rows older than the most recent `keep` entries per channel.
     * Keeps the table bounded on long-running deployments.
     */
    prune(channelId: string, keep?: number): Promise<void>;
};
