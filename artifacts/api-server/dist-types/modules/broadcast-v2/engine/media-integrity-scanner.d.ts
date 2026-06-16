export interface ScanItemResult {
    id: string;
    title: string;
    url: string | null;
    kind: "hls" | "mp4" | "unknown";
    reachable: boolean;
    httpStatus: number | null;
    consecutiveFailures: number;
    lastCheckedAtMs: number;
    lastFailedAtMs: number | null;
}
export interface MediaScanReport {
    lastScanAtMs: number | null;
    scanDurationMs: number | null;
    totalItems: number;
    reachable: number;
    unreachable: number;
    scanning: boolean;
    items: ScanItemResult[];
}
declare class MediaIntegrityScannerImpl {
    private bootTimer;
    private scanInterval;
    private scanning;
    private readonly failureCounts;
    /** Returns the current size of the failure-count map.
     *  Used by the memory diagnostics named-store registry. */
    failureCountsSize(): number;
    private report;
    start(intervalMs?: number): void;
    stop(): void;
    getReport(): MediaScanReport;
    scan(): Promise<MediaScanReport>;
    /**
     * Reset all accumulated probe failure counts to zero.
     *
     * Call this after fixing an infrastructure issue (e.g. HLS 401 misconfiguration)
     * so that items which built up consecutive failure counts during the broken period
     * do not hit the auto-suspension threshold on their next successful probe cycle.
     * Also persists the cleared state to DB so the reset survives a process restart.
     */
    clearFailureCounts(): void;
}
export declare const mediaIntegrityScanner: MediaIntegrityScannerImpl;
export {};
