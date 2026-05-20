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
    /** Trim event log to the last MAX_RETENTION_PER_CHANNEL rows per channel. */
    trim(channelId: string): Promise<void>;
};
