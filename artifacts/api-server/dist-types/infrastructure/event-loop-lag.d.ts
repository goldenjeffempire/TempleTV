/**
 * Event-loop lag monitor.
 *
 * Uses setImmediate to measure how long the event loop is blocked between
 * ticks. A healthy Node process sees lag <10 ms; anything sustained above
 * 100 ms indicates a blocking operation (synchronous crypto, large
 * JSON.parse, DNS resolution, or CPU starvation on constrained hosts).
 *
 * On Render free tier (0.1 vCPU), CPU starvation under concurrent broadcast
 * load can push lag to 100–500 ms, causing health-check timeouts that Render
 * interprets as an unhealthy instance → SIGTERM cycles.
 *
 * State is exposed via getEventLoopLagMs() and isEventLoopLagAlertActive()
 * for the GET /admin/diagnostics/memory endpoint (merged into watchdog state).
 */
export interface LagSample {
    ts: number;
    lagMs: number;
}
/**
 * Start the event-loop lag monitor.  Idempotent — second call is a no-op.
 * The setInterval is `.unref()`-ed so it never prevents clean process exit.
 */
export declare function startEventLoopLagMonitor(): void;
/**
 * Stop the event-loop lag monitor (called during graceful shutdown so the
 * interval does not hold the event loop open after all other subsystems
 * have stopped).
 */
export declare function stopEventLoopLagMonitor(): void;
/** Most-recently measured event-loop lag in milliseconds. */
export declare function getEventLoopLagMs(): number;
/** Whether the sustained-lag alert is currently active. */
export declare function isEventLoopLagAlertActive(): boolean;
/** Rolling 60-sample history for sparkline rendering. */
export declare function getEventLoopLagHistory(): LagSample[];
