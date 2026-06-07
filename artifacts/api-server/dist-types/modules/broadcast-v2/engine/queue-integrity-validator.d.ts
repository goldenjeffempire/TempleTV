export type IssueSeverity = "error" | "warn" | "info";
export interface ValidationIssue {
    severity: IssueSeverity;
    itemId: string | null;
    itemTitle: string | null;
    code: string;
    message: string;
}
export interface ValidationReport {
    validatedAtMs: number;
    durationMs: number;
    totalItems: number;
    healthyItems: number;
    issues: ValidationIssue[];
    summary: {
        errors: number;
        warnings: number;
        infos: number;
    };
}
declare class QueueIntegrityValidatorImpl {
    private lastReport;
    private validating;
    /** Fingerprint of the last logged issue set — used to suppress duplicate WARN spam. */
    private lastIssueSig;
    /**
     * Monotonically-incrementing cycle counter. Incremented at the start of each
     * validate() call. Used to rate-limit checks that don't need to run every
     * cycle (e.g. STUCK_ENCODING_NO_JOB every 3rd cycle).
     */
    private validatorCycleCount;
    private storageCbFailures;
    private storageCbOpenUntilMs;
    private static readonly STORAGE_CB_THRESHOLD;
    private static readonly STORAGE_CB_OPEN_MS;
    validate(): Promise<ValidationReport>;
    getLastReport(): ValidationReport | null;
    private empty;
}
export declare const queueIntegrityValidator: QueueIntegrityValidatorImpl;
export {};
