/**
 * Auto-Heal Monitor — 5-second broadcast operations watchdog.
 *
 * Continuously scans all broadcasting subsystems and takes immediate
 * remediation actions for acute failures that the longer-interval workers
 * (broadcast-health-monitor @ 60 s, queue-health-guard @ 3 min, etc.) would
 * miss in the first critical window.
 *
 * WHAT THIS DOES
 * ──────────────
 * Every SCAN_INTERVAL_MS (5 s) it evaluates seven health signals:
 *
 *   1. BROADCAST_STUCK      — sequence not advancing > STUCK_THRESHOLD_MS (90 s)
 *                             while queue has items → triggers orchestrator.reload()
 *   2. DEAD_AIR             — dead-air incident open > DEAD_AIR_THRESHOLD_MS (30 s)
 *                             → triggers orchestrator.reload()
 *   3. QUEUE_EMPTY          — active item count = 0 → triggers library scan
 *   4. ALL_ITEMS_BLOCKED    — all queue items suspended/blocked
 *                             → triggers reEnableAllSuspended()
 *   5. WORKER_CIRCUIT_OPEN  — any critical worker circuit transitions to open
 *                             → pushes ops-alert SSE event immediately
 *   6. MEMORY_PRESSURE      — RSS > rssWarnMb → pushes alert (GC handled by watchdog)
 *   7. ORCHESTRATOR_DOWN    — orchestrator not started > BOOT_GRACE_MS after process boot
 *                             → logs critical alert
 *
 * Each signal has an independent cooldown so rapid successive incidents don't
 * fire repeated remediations. Cooldowns survive process restarts via
 * in-memory timestamps (reset on restart, which is acceptable — a restart
 * itself is a recovery event).
 *
 * All actions are logged to a ring buffer (MAX_LOG_ENTRIES = 500) that is
 * exposed via getAutoHealStatus() and consumed by the /autoheal/status
 * REST endpoint. Each action is also pushed to the admin SSE bus as an
 * `autoheal-action` event so the monitoring page updates in real-time.
 */
export interface AutoHealAction {
    id: string;
    timestamp: number;
    service: string;
    action: string;
    severity: "info" | "warn" | "error" | "critical";
    result: "triggered" | "skipped" | "failed" | "noop";
    details: string;
}
export interface ActiveAlert {
    id: string;
    service: string;
    code: string;
    severity: "warn" | "error" | "critical";
    message: string;
    firstSeenAt: number;
    lastSeenAt: number;
    count: number;
}
export interface ServiceStatus {
    name: string;
    label: string;
    status: "healthy" | "degraded" | "critical" | "unknown";
    detail: string;
    lastCheckedAt: number;
}
export interface AutoHealMetrics {
    broadcastSequence: number;
    broadcastItemCount: number;
    broadcastMode: string;
    sequenceAdvanceAgeMs: number;
    deadAirOpenMs: number | null;
    memoryRssMb: number;
    memoryWarnMb: number;
    memoryRestartMb: number;
    workerHealthyCount: number;
    workerTotalCount: number;
    autonomyScore: number;
}
export interface AutoHealStatus {
    monitorStartedAt: number;
    lastScanAt: number | null;
    scanCount: number;
    totalActionsTriggered: number;
    activeAlerts: ActiveAlert[];
    services: ServiceStatus[];
    recentActions: AutoHealAction[];
    metrics: AutoHealMetrics;
}
export declare function getAutoHealStatus(): AutoHealStatus;
export declare function triggerManualScan(): Promise<{
    scanCount: number;
    actionsTriggered: number;
}>;
export declare const autoHealMonitor: {
    start(): void;
    stop(): void;
};
