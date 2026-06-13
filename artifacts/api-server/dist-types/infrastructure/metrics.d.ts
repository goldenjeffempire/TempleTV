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
export declare const httpRequestDuration: Histogram<"service" | "env" | "method" | "route" | "status_code">;
export declare const httpRequestTotal: Counter<"service" | "env" | "method" | "route" | "status_code">;
export declare const activeSseConnections: Gauge<"service" | "env" | "surface">;
export declare const activeWsConnections: Gauge<"service" | "env" | "surface">;
export declare const broadcastSequence: Gauge<"channel" | "service" | "env">;
export declare const broadcastModeGauge: Gauge<"mode" | "channel" | "service" | "env">;
export declare const transcodingQueueDepth: Gauge<"service" | "env">;
export declare const broadcastQueueDepth: Gauge<"channel" | "service" | "env">;
export declare const broadcastViewerCount: Gauge<"channel" | "service" | "env">;
export declare const broadcastQueueStuck: Gauge<"channel" | "service" | "env">;
export declare const dbPoolConnectionsActive: Gauge<"service" | "env">;
export declare const dbPoolConnectionsIdle: Gauge<"service" | "env">;
export declare const dbPoolConnectionsWaiting: Gauge<"service" | "env">;
export declare const dbPoolUtilizationRatio: Gauge<"service" | "env">;
export declare const processRssGauge: Gauge<"service" | "env">;
/**
 * Atomically flip the broadcast mode gauge: set the active mode to 1,
 * all others to 0.  Accepts the channel id and the new mode string.
 */
export declare function setBroadcastMode(channel: string, mode: string): void;
