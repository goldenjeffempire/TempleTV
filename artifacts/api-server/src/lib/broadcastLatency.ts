/**
 * Broadcast payload build-latency observability.
 *
 * `buildBroadcastCurrentPayload` has two distinct paths:
 *   - **cached** — reads the in-memory + PG distributed cache; should resolve
 *     in single-digit ms. The transition ticker keeps it warm on the live path.
 *   - **cold (fromCache=false)** — rebuilds from PG (live override + schedule
 *     entries + queue items, three reads in parallel) plus YouTube live status.
 *     This path was observed at 994ms in production logs on a freshly-rotated
 *     Render instance, and is the regression vector this module exists to
 *     watch.
 *
 * Both paths are sampled into a fixed-size ring buffer (no allocation per
 * call beyond a number, no DB writes). The cold-path samples drive the
 * watchdog (`lib/broadcastLatencyWatchdog.ts`); the snapshot is also exposed
 * on `/admin/ops/status` so the admin Operations page can surface latency
 * trends without parsing logs.
 */

const BUFFER_SIZE = 500;

interface RingBuffer {
  data: number[];
  count: number; // Total samples ever recorded — wraps at Number.MAX_SAFE_INTEGER, fine forever in practice.
  cursor: number;
}

function makeBuffer(): RingBuffer {
  return { data: [], count: 0, cursor: 0 };
}

function push(buf: RingBuffer, value: number): void {
  buf.count += 1;
  if (buf.data.length < BUFFER_SIZE) {
    buf.data.push(value);
  } else {
    buf.data[buf.cursor] = value;
    buf.cursor = (buf.cursor + 1) % BUFFER_SIZE;
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  // Sort a copy so we don't disturb the ring-buffer ordering.
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank method — fine for ops dashboards, no need for full
  // linear interpolation on 500-sample windows.
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const cold = makeBuffer();
const hot = makeBuffer();
const startedAt = Date.now();

export type BroadcastBuildPath = "cold" | "hot";

export function recordBroadcastBuildLatency(ms: number, path: BroadcastBuildPath): void {
  // Defensive: a NaN or Infinity here would poison percentile math forever.
  if (!Number.isFinite(ms) || ms < 0) return;
  if (path === "cold") push(cold, ms);
  else push(hot, ms);
}

export interface BroadcastLatencySnapshot {
  startedAt: string;
  uptimeSecs: number;
  cold: { samples: number; total: number; p50: number; p95: number; p99: number; max: number };
  hot: { samples: number; total: number; p50: number; p95: number; p99: number; max: number };
}

function summarise(buf: RingBuffer): BroadcastLatencySnapshot["cold"] {
  return {
    samples: buf.data.length,
    total: buf.count,
    p50: Math.round(percentile(buf.data, 50)),
    p95: Math.round(percentile(buf.data, 95)),
    p99: Math.round(percentile(buf.data, 99)),
    max: buf.data.length === 0 ? 0 : Math.round(Math.max(...buf.data)),
  };
}

export function broadcastLatencySnapshot(): BroadcastLatencySnapshot {
  return {
    startedAt: new Date(startedAt).toISOString(),
    uptimeSecs: Math.round((Date.now() - startedAt) / 1000),
    cold: summarise(cold),
    hot: summarise(hot),
  };
}

/**
 * Test-only — clears both buffers. Not exported from index; intentionally
 * accessible for unit tests that want a deterministic starting state.
 */
export function _resetBroadcastLatencyBuffersForTests(): void {
  cold.data.length = 0;
  cold.count = 0;
  cold.cursor = 0;
  hot.data.length = 0;
  hot.count = 0;
  hot.cursor = 0;
}
