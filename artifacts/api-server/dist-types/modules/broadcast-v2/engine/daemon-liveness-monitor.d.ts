/**
 * Daemon Liveness Monitor
 *
 * When the API server runs in proxy mode (BROADCAST_DAEMON_URL is set), this
 * module periodically health-checks the broadcast daemon and emits an ops alert
 * when it is unreachable for an extended period. It also tracks downtime windows
 * so the admin panel can show when the daemon was last seen alive.
 *
 * The monitor is intentionally lightweight:
 *   - One HTTP GET to /health every POLL_INTERVAL_MS (default 30 s)
 *   - Alert fires after CONSECUTIVE_FAILURES_BEFORE_ALERT failures (default 3 = 90 s)
 *   - Recovery is logged when the daemon comes back
 *   - All state is in-memory (the restart log covers boot events)
 */
/**
 * Start the daemon liveness monitor.  Safe to call multiple times.
 * Only active when BROADCAST_DAEMON_URL is configured (proxy mode).
 */
export declare function startDaemonLivenessMonitor(): void;
/**
 * Stop the daemon liveness monitor.
 */
export declare function stopDaemonLivenessMonitor(): void;
/**
 * Return the current liveness state for the /health endpoint.
 */
export declare function getDaemonLivenessStatus(): {
    monitoring: boolean;
    lastSeenAliveMs: number | null;
    consecutiveFailures: number;
    alertFired: boolean;
    downSinceMs: number | null;
    lastCheckAtMs: number | null;
};
