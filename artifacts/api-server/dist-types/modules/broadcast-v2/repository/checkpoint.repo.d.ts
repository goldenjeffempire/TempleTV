export interface CheckpointRecord {
    channelId: string;
    itemId: string | null;
    positionMs: number;
    sourceHealth: "ok" | "degraded" | "failed";
    /**
     * Wall-clock ms when this checkpoint was written to the DB (populated on read
     * from `updated_at`; not required when writing — the DB sets it automatically).
     * Used by the orchestrator's boot-restore logic to correctly account for
     * server downtime:
     *   cycleStartedAtMs = savedAtMs − offsetOfItemInCycle − positionMs
     * Without this, the calculation uses Date.now() at restart time and the
     * restored position is behind by the duration the server was offline.
     */
    savedAtMs?: number;
}
export declare const checkpointRepo: {
    load(channelId: string): Promise<CheckpointRecord | null>;
    save(rec: CheckpointRecord): Promise<void>;
};
