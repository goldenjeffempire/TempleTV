/**
 * Prometheus metrics registry for Temple TV API.
 *
 * Exports a single prom-client Registry plus named metric instances.
 * All metrics carry `service` and `env` labels for multi-instance dashboards.
 *
 * Call-sites import only the metric they need and invoke a single method
 * (inc / dec / set / observe) — no logic belongs here.
 */
import {
  Registry,
  collectDefaultMetrics,
  Gauge,
  Histogram,
  Counter,
} from "prom-client";

const NODE_ENV = process.env.NODE_ENV ?? "development";

export const promRegistry = new Registry();

collectDefaultMetrics({
  register: promRegistry,
  labels: { service: "temple-tv-api", env: NODE_ENV },
});

const BASE = { service: "temple-tv-api", env: NODE_ENV } as const;

export const SERVICE_LABELS = BASE;

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency in seconds, by method, normalised route, and status code",
  labelNames: ["method", "route", "status_code", "service", "env"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [promRegistry],
});

export const httpRequestTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests handled",
  labelNames: ["method", "route", "status_code", "service", "env"] as const,
  registers: [promRegistry],
});

export const activeSseConnections = new Gauge({
  name: "sse_connections_active",
  help: "Number of currently open SSE connections (broadcast-v2 + legacy)",
  labelNames: ["surface", "service", "env"] as const,
  registers: [promRegistry],
});

export const activeWsConnections = new Gauge({
  name: "ws_connections_active",
  help: "Number of currently open WebSocket connections",
  labelNames: ["surface", "service", "env"] as const,
  registers: [promRegistry],
});

export const broadcastSequence = new Gauge({
  name: "broadcast_v2_sequence",
  help: "Current broadcast-v2 orchestrator sequence number",
  labelNames: ["channel", "service", "env"] as const,
  registers: [promRegistry],
});

export const broadcastModeGauge = new Gauge({
  name: "broadcast_v2_mode_active",
  help: "1 when the labelled mode is currently active on the given channel, else 0",
  labelNames: ["channel", "mode", "service", "env"] as const,
  registers: [promRegistry],
});

export const transcodingQueueDepth = new Gauge({
  name: "transcoding_queue_depth",
  help: "Number of transcoding jobs with status=queued",
  labelNames: ["service", "env"] as const,
  registers: [promRegistry],
});

export const broadcastQueueDepth = new Gauge({
  name: "broadcast_queue_depth",
  help: "Number of playable items currently in the broadcast queue (after pre-resolution)",
  labelNames: ["channel", "service", "env"] as const,
  registers: [promRegistry],
});

export const broadcastViewerCount = new Gauge({
  name: "broadcast_viewer_count",
  help: "Estimated concurrent viewers on the broadcast channel (sum of WS + SSE + recent REST polls)",
  labelNames: ["channel", "service", "env"] as const,
  registers: [promRegistry],
});

export const broadcastQueueStuck = new Gauge({
  name: "broadcast_queue_stuck",
  help: "1 when the orchestrator has been unable to advance for >30 s while items are present, else 0",
  labelNames: ["channel", "service", "env"] as const,
  registers: [promRegistry],
});

export const dbPoolConnectionsActive = new Gauge({
  name: "db_pool_connections_active",
  help: "pg pool connections currently checked out (in-use)",
  labelNames: ["service", "env"] as const,
  registers: [promRegistry],
});

export const dbPoolConnectionsIdle = new Gauge({
  name: "db_pool_connections_idle",
  help: "pg pool connections idle and available",
  labelNames: ["service", "env"] as const,
  registers: [promRegistry],
});

export const dbPoolConnectionsWaiting = new Gauge({
  name: "db_pool_connections_waiting",
  help: "clients waiting for an available pg pool connection",
  labelNames: ["service", "env"] as const,
  registers: [promRegistry],
});

export const dbPoolUtilizationRatio = new Gauge({
  name: "db_pool_utilization_ratio",
  help: "Fraction of max pool size currently in use (active / max), 0–1",
  labelNames: ["service", "env"] as const,
  registers: [promRegistry],
});

export const processRssGauge = new Gauge({
  name: "process_rss_bytes",
  help: "Process RSS memory in bytes (mirrors memory-watchdog threshold)",
  labelNames: ["service", "env"] as const,
  registers: [promRegistry],
});

export const broadcastSequenceAdvanceTotal = new Counter({
  name: "broadcast_v2_sequence_advance_total",
  help: "Total number of times the broadcast-v2 sequence has been bumped (any event type)",
  labelNames: ["channel", "service", "env"] as const,
  registers: [promRegistry],
});

export const broadcastSkipTotal = new Counter({
  name: "broadcast_v2_skip_total",
  help: "Total number of operator-triggered or auto-skip events on the broadcast queue",
  labelNames: ["channel", "service", "env"] as const,
  registers: [promRegistry],
});

export const broadcastBadUrlCount = new Gauge({
  name: "broadcast_v2_bad_url_count",
  help: "Current number of source URLs in the bad-URL blacklist cache",
  labelNames: ["channel", "service", "env"] as const,
  registers: [promRegistry],
});

const ALL_MODES = ["queue", "override", "failover"] as const;

/**
 * Atomically flip the broadcast mode gauge: set the active mode to 1,
 * all others to 0.  Accepts the channel id and the new mode string.
 */
export function setBroadcastMode(channel: string, mode: string): void {
  for (const m of ALL_MODES) {
    broadcastModeGauge.set(
      { channel, mode: m, ...BASE },
      m === mode ? 1 : 0,
    );
  }
}

// ── Broadcast engine health metrics ──────────────────────────────────────────
// These 5 metrics give Prometheus dashboards and alerts real-time insight into
// the broadcast engine's health: is it progressing? skipping? hitting FATAL?
// how many bad URLs are blocked? how many active items are in the queue?

/**
 * Total number of sequence advances since process start.
 * Monotonically increasing — a flat line on a dashboard means the engine
 * is not progressing (stuck, empty queue, or all-sources-blocked).
 */
export const broadcastSequenceTotal = new Counter({
  name: "broadcast_sequence_total",
  help: "Total number of broadcast sequence advances (item advances, skips, mode changes) since process start",
  labelNames: ["channel", "service", "env"] as const,
  registers: [promRegistry],
});

// broadcastSkipTotal already defined above (broadcast_v2_skip_total).

/**
 * Total number of FATAL (all-sources-blocked / cycle-exhaustion) events
 * since process start. Each increment means the orchestrator cycled through
 * every queue item without finding a playable source and went off-air.
 */
export const broadcastFatalTotal = new Counter({
  name: "broadcast_fatal_total",
  help: "Total number of all-sources-blocked / cycle-exhaustion FATAL events since process start",
  labelNames: ["channel", "service", "env"] as const,
  registers: [promRegistry],
});

// broadcastBadUrlCount already defined above (broadcast_v2_bad_url_count).

/**
 * Number of active items in the broadcast queue (DB rows with is_active=true).
 * Separate from transcoding_queue_depth. A value of 0 while the channel is
 * expected on-air indicates a queue management problem.
 */
export const broadcastQueueActiveItems = new Gauge({
  name: "broadcast_queue_active_items",
  help: "Number of active items currently loaded in the broadcast orchestrator's in-memory queue",
  labelNames: ["channel", "service", "env"] as const,
  registers: [promRegistry],
});

export const transcoderWorkerCount = new Gauge({
  name: "transcoder_worker_count",
  help: "Number of live transcoder worker processes registered in the worker registry",
  labelNames: ["service", "env"] as const,
  registers: [promRegistry],
});

export const transcoderActiveJobCount = new Gauge({
  name: "transcoder_active_job_count",
  help: "Number of transcoding jobs currently processing (across all concurrent slots)",
  labelNames: ["service", "env"] as const,
  registers: [promRegistry],
});

export const transcoderDlqDepth = new Gauge({
  name: "transcoder_dlq_depth",
  help: "Number of jobs in the dead-letter queue awaiting operator review",
  labelNames: ["service", "env"] as const,
  registers: [promRegistry],
});

export const transcoderLeaseReclaimTotal = new Counter({
  name: "transcoder_lease_reclaim_total",
  help: "Total number of expired job leases reclaimed from dead workers",
  labelNames: ["service", "env"] as const,
  registers: [promRegistry],
});

export const transcoderStageTransitionTotal = new Counter({
  name: "transcoder_stage_transition_total",
  help: "Total stage transitions by stage name",
  labelNames: ["stage", "service", "env"] as const,
  registers: [promRegistry],
});

export const transcoderJobDurationSeconds = new Histogram({
  name: "transcoder_job_duration_seconds",
  help: "Total wall-clock time for completed transcoding jobs",
  labelNames: ["status", "service", "env"] as const,
  buckets: [30, 60, 120, 300, 600, 900, 1800, 3600, 7200],
  registers: [promRegistry],
});
