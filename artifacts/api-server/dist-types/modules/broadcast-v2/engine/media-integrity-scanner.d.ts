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
    private timer;
    private scanning;
    private readonly failureCounts;
    private report;
    start(intervalMs?: number): void;
    stop(): void;
    getReport(): MediaScanReport;
    scan(): Promise<MediaScanReport>;
}
export declare const mediaIntegrityScanner: MediaIntegrityScannerImpl;
export {};
