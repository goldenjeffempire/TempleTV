/**
 * Prometheus metrics registry for Temple TV API.
 *
 * Exports a single prom-client Registry plus named metric instances.
 * All metrics carry `service` and `env` labels for multi-instance dashboards.
 *
 * Call-sites import only the metric they need and invoke a single method
 * (inc / dec / set / observe) — no logic belongs here.
 */
import { Registry, Gauge, Histogram, Counter } from "prom-client";
export declare const promRegistry: Registry<"text/plain; version=0.0.4; charset=utf-8">;
export declare const SERVICE_LABELS: {
    readonly service: "temple-tv-api";
    readonly env: string;
};
export declare const httpRequestDuration: Histogram<"method" | "service" | "env" | "route" | "status_code">;
export declare const httpRequestTotal: Counter<"method" | "service" | "env" | "route" | "status_code">;
export declare const activeSseConnections: Gauge<"service" | "env" | "surface">;
export declare const activeWsConnections: Gauge<"service" | "env" | "surface">;
export declare const broadcastSequence: Gauge<"channel" | "service" | "env">;
export declare const broadcastModeGauge: Gauge<"mode" | "channel" | "service" | "env">;
export declare const transcodingQueueDepth: Gauge<"service" | "env">;
export declare const transcoderStageDurationMs: Histogram<"status" | "stage" | "service" | "env">;
export declare const transcoderConcurrentJobs: Gauge<"service" | "env">;
export declare const broadcastQueueDepth: Gauge<"channel" | "service" | "env">;
export declare const broadcastViewerCount: Gauge<"channel" | "service" | "env">;
export declare const broadcastQueueStuck: Gauge<"channel" | "service" | "env">;
export declare const dbPoolConnectionsActive: Gauge<"service" | "env">;
export declare const dbPoolConnectionsIdle: Gauge<"service" | "env">;
export declare const dbPoolConnectionsWaiting: Gauge<"service" | "env">;
export declare const dbPoolUtilizationRatio: Gauge<"service" | "env">;
export declare const processRssGauge: Gauge<"service" | "env">;
export declare const broadcastSequenceAdvanceTotal: Counter<"channel" | "service" | "env">;
export declare const broadcastSkipTotal: Counter<"channel" | "service" | "env">;
export declare const broadcastBadUrlCount: Gauge<"channel" | "service" | "env">;
/**
 * Atomically flip the broadcast mode gauge: set the active mode to 1,
 * all others to 0.  Accepts the channel id and the new mode string.
 */
export declare function setBroadcastMode(channel: string, mode: string): void;
/**
 * Total number of sequence advances since process start.
 * Monotonically increasing — a flat line on a dashboard means the engine
 * is not progressing (stuck, empty queue, or all-sources-blocked).
 */
export declare const broadcastSequenceTotal: Counter<"channel" | "service" | "env">;
/**
 * Total number of FATAL (all-sources-blocked / cycle-exhaustion) events
 * since process start. Each increment means the orchestrator cycled through
 * every queue item without finding a playable source and went off-air.
 */
export declare const broadcastFatalTotal: Counter<"channel" | "service" | "env">;
/**
 * Number of active items in the broadcast queue (DB rows with is_active=true).
 * Separate from transcoding_queue_depth. A value of 0 while the channel is
 * expected on-air indicates a queue management problem.
 */
export declare const broadcastQueueActiveItems: Gauge<"channel" | "service" | "env">;
export declare const transcoderWorkerCount: Gauge<"service" | "env">;
export declare const transcoderActiveJobCount: Gauge<"service" | "env">;
export declare const transcoderDlqDepth: Gauge<"service" | "env">;
export declare const transcoderLeaseReclaimTotal: Counter<"service" | "env">;
export declare const transcoderStageTransitionTotal: Counter<"stage" | "service" | "env">;
export declare const transcoderJobDurationSeconds: Histogram<"status" | "service" | "env">;
/**
 * Estimated seconds of content remaining in the active broadcast queue.
 * Sum of duration_secs across all is_active=true rows.
 * Alert when this drops below your SLO threshold (e.g. < 3600 s = 1 h warn).
 */
export declare const queueTimeToEmptySeconds: Gauge<"channel" | "service" | "env">;
/**
 * Total number of exhaustion-level ops-alerts emitted (by severity level).
 * Monotonically increasing; a rising rate indicates chronic queue under-supply.
 */
export declare const queueExhaustionWarnTotal: Counter<"level" | "service" | "env">;
/**
 * Total number of videos automatically added to the broadcast queue by the
 * auto-refill worker. Monotonically increasing.
 */
export declare const queueAutoRefillTotal: Counter<"service" | "env">;
/**
 * Total bytes stored in the object storage bucket (from storage_blobs index).
 */
export declare const storageTotalBytes: Gauge<"service" | "env">;
/**
 * Number of blobs tracked in storage_blobs.
 */
export declare const storageBlobCount: Gauge<"service" | "env">;
/**
 * Number of supervised workers currently running (circuit closed).
 */
export declare const workerRunningCount: Gauge<"service" | "env">;
/**
 * Number of supervised workers with circuit breaker open (suspended due to failures).
 */
export declare const workerCircuitOpenCount: Gauge<"service" | "env">;
/**
 * Total number of times any worker's circuit breaker was manually reset by an operator.
 */
export declare const workerCircuitResetTotal: Counter<"worker" | "service" | "env">;
/**
 * Backlog sizes for the scheduled-notification dispatcher, refreshed once
 * per dispatcher tick. `state` distinguishes pending-due (waiting to be
 * claimed), sending (in-flight — should normally be ~0 between ticks),
 * and dead_letter (permanently exhausted).
 */
export declare const scheduledNotifBacklogGauge: Gauge<"state" | "service" | "env">;
/**
 * Total dispatch attempts by outcome. `result` is "sent" or "failed" (a
 * failed attempt that hasn't necessarily exhausted retries yet).
 */
export declare const scheduledNotifDispatchedTotal: Counter<"result" | "service" | "env">;
/**
 * Total scheduled notifications that exhausted SCHEDULED_NOTIF_MAX_ATTEMPTS
 * and were permanently dead-lettered (status=failed, deadLetteredAt set).
 */
export declare const scheduledNotifDeadLetterTotal: Counter<"service" | "env">;
