/**
 * Rolling-window viewer drift aggregator for broadcast sync telemetry.
 *
 * Every connected player calls POST /report-position every ~30 s while
 * content is playing.  The server computes
 *
 *   driftMs = expectedPositionMs − reportedPositionMs
 *
 * and records it here.  Positive driftMs means the viewer is *behind*
 * the server's authoritative position (common on slow networks or cold
 * CPU).  Negative means the viewer is *ahead* (rare; occurs when the
 * client's clock offset is slightly over-corrected).
 *
 * The ring buffer holds RING_SIZE samples.  getStats(windowMs) filters
 * to the most recent windowMs of samples so stale data from paused or
 * closed viewers automatically falls off the stats.
 *
 * This module is intentionally free of DB I/O and external dependencies
 * — all state is in-process so it cannot block or fail the broadcast path.
 */

const RING_SIZE = 1_024;

export interface DriftSample {
  itemId: string;
  driftMs: number;
  ts: number;
}

export interface ViewerDriftStats {
  sampleCount: number;
  windowMs: number;
  /** Median drift across viewers in the window.  Positive = behind. */
  p50Ms: number | null;
  /** 95th-percentile drift — worst-tail viewer experience. */
  p95Ms: number | null;
  /** Maximum absolute drift observed in the window. */
  maxMs: number | null;
  /** Minimum (most-ahead) drift observed in the window. */
  minMs: number | null;
  /** Mean drift across all samples in the window. */
  avgMs: number | null;
  /** Wall-clock ms of the most recent sample, or null if ring is empty. */
  lastSampleAtMs: number | null;
}

class DriftAggregator {
  private readonly ring: (DriftSample | undefined)[] = new Array<DriftSample | undefined>(RING_SIZE).fill(undefined);
  private head = 0;
  private filled = 0;

  record(itemId: string, driftMs: number): void {
    this.ring[this.head] = { itemId, driftMs: Math.round(driftMs), ts: Date.now() };
    this.head = (this.head + 1) % RING_SIZE;
    if (this.filled < RING_SIZE) this.filled++;
  }

  getStats(windowMs = 90_000): ViewerDriftStats {
    const cutoff = Date.now() - windowMs;
    const values: number[] = [];
    let lastSampleAtMs: number | null = null;

    for (let i = 0; i < this.filled; i++) {
      const sample = this.ring[i];
      if (!sample || sample.ts < cutoff) continue;
      values.push(sample.driftMs);
      if (lastSampleAtMs === null || sample.ts > lastSampleAtMs) lastSampleAtMs = sample.ts;
    }

    if (values.length === 0) {
      return {
        sampleCount: 0,
        windowMs,
        p50Ms: null,
        p95Ms: null,
        maxMs: null,
        minMs: null,
        avgMs: null,
        lastSampleAtMs: null,
      };
    }

    values.sort((a, b) => a - b);
    const len = values.length;
    const p50 = values[Math.floor(len * 0.5)]!;
    const p95 = values[Math.min(Math.floor(len * 0.95), len - 1)]!;
    const max = values[len - 1]!;
    const min = values[0]!;
    const avg = Math.round(values.reduce((s, v) => s + v, 0) / len);

    return { sampleCount: len, windowMs, p50Ms: p50, p95Ms: p95, maxMs: max, minMs: min, avgMs: avg, lastSampleAtMs };
  }

  /** Total number of samples recorded since process start (for debugging). */
  getTotalRecorded(): number {
    return this.filled;
  }
}

export const driftAggregator = new DriftAggregator();
