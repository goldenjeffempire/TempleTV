export interface ExhaustionStatus {
    timeToEmptyMs: number | null;
    timeToEmptyFmt: string | null;
    activeItemCount: number;
    level: "ok" | "warn" | "critical";
    lastCheckedAtMs: number | null;
    lastWarnAlertAtMs: number | null;
    lastCritAlertAtMs: number | null;
    /** True when an override is suppressing exhaustion alerts. */
    overrideSuppressed: boolean;
    overrideKind: string | null;
    overrideTitle: string | null;
}
export declare function getExhaustionStatus(): ExhaustionStatus;
export declare function startExhaustionMonitor(): void;
export declare function stopExhaustionMonitor(): void;
