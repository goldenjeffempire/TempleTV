export interface TranscodingAutoRetryStatus {
    enabled: boolean;
    lastRunAt: number | null;
    lastRunFound: number;
    lastRunQueued: number;
}
export declare function getTranscodingAutoRetryStatus(): TranscodingAutoRetryStatus;
export declare function transcodingAutoRetryScan(): Promise<void>;
