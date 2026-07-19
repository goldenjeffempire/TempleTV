export interface AutoRefillStatus {
    enabled: boolean;
    lastRunAtMs: number | null;
    lastRefillAtMs: number | null;
    lastRefillCount: number;
    totalRefilled: number;
    /** Populated when all library videos are YouTube-sourced (no local candidates). */
    libraryIsYouTubeOnly: boolean;
    libraryYouTubeCount: number;
    libraryLocalCount: number;
}
export declare function getAutoRefillStatus(): AutoRefillStatus;
export declare function startAutoQueueRefill(): void;
export declare function stopAutoQueueRefill(): void;
