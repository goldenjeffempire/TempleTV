/**
 * Content Scheduling Worker
 *
 * Runs every 60 seconds. Checks managed_videos for rows with:
 *   • scheduled_publish_at   <= NOW() AND broadcast_only = true   → publishes (broadcastOnly=false)
 *   • scheduled_unpublish_at <= NOW() AND broadcast_only = false  → unpublishes (broadcastOnly=true)
 *
 * After acting, clears the corresponding scheduled_* timestamp so the
 * trigger only fires once. Logs each action to media_audit_log for the
 * audit trail.
 *
 * Uses workerSupervisor for circuit-breaker, deadman-switch, and metrics.
 * A sustained DB outage trips the circuit after 10 consecutive failures and
 * suppresses alerts until the auto-reset window passes. This prevents log
 * flooding and false-positive ops-alerts during brief DB unavailability.
 */
export declare function startContentSchedulingWorker(): void;
export declare function stopContentSchedulingWorker(): void;
