export declare const eventLogRepo: {
    append(channelId: string, sequence: number, eventType: string, payload: unknown): Promise<void>;
    replayFrom(channelId: string, fromSequence: number, limit?: number): Promise<{
        id: number;
        channelId: string;
        sequence: number;
        eventType: string;
        payload: unknown;
        createdAt: Date;
    }[]>;
    lastSequence(channelId: string): Promise<number>;
    /**
     * Prune event log rows older than `maxAgeMs` milliseconds (default 24 h)
     * while preserving at least the last `seqFloor` sequences per channel.
     *
     * The dual guard prevents over-deletion: a low-volume channel might have
     * only 200 events per day but operators still need the full replay window
     * for a WS client that disconnects overnight and resumes with a stale
     * `lastSequence`. The sequence floor (default 5000) guarantees those
     * replay events are always available regardless of age.
     *
     * Iterates per-channel so each channel gets its own floor calculation.
     * In the current single-channel deployment this is one iteration; the
     * structure naturally extends to multi-channel without schema changes.
     */
    pruneOldEvents(maxAgeMs?: number, seqFloor?: number): Promise<void>;
    /** Trim event log to the last MAX_RETENTION_PER_CHANNEL rows per channel. */
    trim(channelId: string): Promise<void>;
};
