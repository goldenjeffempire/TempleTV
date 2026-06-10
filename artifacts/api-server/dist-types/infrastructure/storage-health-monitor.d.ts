export interface StorageHealthStatus {
    healthy: boolean;
    consecutiveFailures: number;
    consecutiveSuccesses: number;
    lastCheckAtMs: number | null;
    lastError: string | null;
    totalChecks: number;
    enabled: boolean;
}
declare class StorageHealthMonitorImpl {
    private timer;
    private initialTimer;
    private checking;
    private healthy;
    private consecutiveFailures;
    private consecutiveSuccesses;
    private lastCheckAtMs;
    private lastError;
    private totalChecks;
    start(intervalMs?: number): void;
    stop(): void;
    getStatus(): StorageHealthStatus;
    private check;
}
export declare const storageHealthMonitor: StorageHealthMonitorImpl;
export declare function getStorageHealthStatus(): StorageHealthStatus;
export {};
