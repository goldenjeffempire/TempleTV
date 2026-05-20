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
    validate(): Promise<ValidationReport>;
    getLastReport(): ValidationReport | null;
    private empty;
}
export declare const queueIntegrityValidator: QueueIntegrityValidatorImpl;
export {};
