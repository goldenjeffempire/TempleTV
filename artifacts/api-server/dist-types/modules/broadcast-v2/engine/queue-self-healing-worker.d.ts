interface ScanResult {
    scanned: number;
    quarantined: number;
    repaired: number;
    blocked: number;
    recovered: number;
    orphansPruned: number;
    durationMs: number;
}
export declare const queueSelfHealingWorker: {
    scan(): Promise<ScanResult>;
    getLastScanMs(): number;
    isRunning(): boolean;
};
export {};
