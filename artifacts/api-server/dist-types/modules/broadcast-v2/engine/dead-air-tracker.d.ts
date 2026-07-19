export interface DeadAirIncident {
    id: string;
    /** Epoch-ms when the channel went off-air. */
    startedAtMs: number;
    /** Epoch-ms when the channel recovered. null = currently off-air. */
    endedAtMs: number | null;
    /** Duration in ms. null = still open. */
    durationMs: number | null;
    /** Why the channel was off-air. */
    reason: "empty" | "all_blocked" | "unknown";
    /** How the channel recovered. null = still open or in override mode. */
    recoveryMode: string | null;
}
export interface DeadAirStats {
    totalIncidents: number;
    openIncident: DeadAirIncident | null;
    recentIncidents: DeadAirIncident[];
    longestIncidentMs: number;
    totalDeadAirMs: number;
    /** Approximate on-air uptime percentage since tracker was installed. */
    onAirPct: number | null;
    /** Whether the orchestrator frame stream appears healthy. */
    frameLivenessOk: boolean;
    /** Epoch-ms of the most recent frame received. 0 = none yet. */
    lastFrameAtMs: number;
}
export declare function getDeadAirStats(): DeadAirStats;
export declare function installDeadAirTracker(): void;
export declare function uninstallDeadAirTracker(): void;
