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
