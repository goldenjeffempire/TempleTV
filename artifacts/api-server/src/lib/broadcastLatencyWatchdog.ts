/**
 * Broadcast cold-rebuild latency regression watchdog.
 *
 * Mirrors the design of `signedUrlCacheWatchdog` — same sample cadence, same
 * rolling-window approach, same dual gates (rate AND volume), same
 * hysteresis between alert and recovery thresholds, same `sendOpsAlert`
 * primitive — but watches the cold-build p95 of `buildBroadcastCurrentPayload`
 * instead of cache hit-rate.
 *
 * The cold-build path is what every viewer pays right after a Render rotation
 * or any cache eviction, and a regression here surfaces as `/broadcast/current`
 * timing out / 5xx-ing under load — viewers see desync, the hero stalls,
 * and on-call gets paged via downstream symptoms instead of root cause.
 * Watching p95 directly catches the regression before the symptoms appear.
 *
 * Why p95 and not avg: a single 2s outlier doesn't matter if surrounding
 * builds are fast (transient PG hiccup, GC pause). Avg would smear that
 * single bad sample across the whole window. p95 says "did at least 5% of
 * cold builds in the window genuinely take >threshold ms?" — which is the
 * actual user-visible question.
 */

import { logger } from "./logger";
import { sendOpsAlert } from "./alerts";
import { broadcastLatencySnapshot } from "./broadcastLatency";

// ── Tunables ────────────────────────────────────────────────────────────────
//
// 60s sampling. Same cadence as the signed-URL watchdog.
const SAMPLE_INTERVAL_MS = 60 * 1000;
//
// 5-sample (5-minute) rolling window. We carry forward the snapshot's
// cumulative p95 between samples; the watchdog tracks the *current* p95
// (over the rolling buffer that broadcastLatency.ts maintains) rather than
// computing a delta — the buffer is bounded to the last 500 cold builds,
// which on a busy instance is the last few minutes anyway. We just want
// to confirm the regression is sustained, not a single outlier sample.
const WINDOW_SAMPLES = 5;
//
// Cold-build p95 threshold. A healthy cold build is sub-100ms (PG warm,
// 3 parallel reads, in-memory YouTube status overlay). The 994ms outlier
// we observed in production was the worst-case immediately post-rotation;
// 500ms is a comfortable middle ground that won't false-positive on a
// freshly-deployed instance whose PG pool is still warming up.
const ALERT_P95_MS = 500;
const RECOVERY_P95_MS = 250;
//
// Don't alert below this many cold builds in the buffer at sample time —
// 10 cold builds is enough that a single outlier can't pull p95 above
// 500ms on its own (95th percentile of 10 samples is the highest sample,
// but 10 samples in 5min = 2/min which is non-trivial traffic).
const MIN_COLD_BUILDS_FOR_ALERT = 10;
//
// 1h dedup on the regression alert. Same rationale as the signed-URL one:
// long enough that an investigating engineer doesn't get re-paged, short
// enough that a still-bad system resurfaces.
const DEDUP_TTL_SEC = 60 * 60;

interface Sample {
  at: number;
  coldP95Ms: number;
  coldSamplesInBuffer: number;
  coldCountTotal: number;
}

const samples: Sample[] = [];
let alertActive = false;
let started = false;
let timer: NodeJS.Timeout | null = null;

function pushSample(): Sample {
  const snap = broadcastLatencySnapshot();
  const sample: Sample = {
    at: Date.now(),
    coldP95Ms: snap.cold.p95,
    coldSamplesInBuffer: snap.cold.samples,
    coldCountTotal: snap.cold.total,
  };
  samples.push(sample);
  while (samples.length > WINDOW_SAMPLES) samples.shift();
  return sample;
}

/**
 * "Sustained regression" means: every sample in the window had p95 above the
 * alert threshold AND the buffer had enough volume to make that p95 trustworthy.
 * A single sample crossing the line is not enough — we need WINDOW_SAMPLES
 * consecutive bad samples.
 */
function isRegressed(): boolean {
  if (samples.length < WINDOW_SAMPLES) return false;
  return samples.every(
    (s) => s.coldP95Ms >= ALERT_P95_MS && s.coldSamplesInBuffer >= MIN_COLD_BUILDS_FOR_ALERT,
  );
}

function isRecovered(): boolean {
  if (samples.length < WINDOW_SAMPLES) return false;
  return samples.every((s) => s.coldP95Ms <= RECOVERY_P95_MS);
}

async function tick(): Promise<void> {
  try {
    const sample = pushSample();
    if (samples.length < WINDOW_SAMPLES) return; // Warming up.

    if (!alertActive && isRegressed()) {
      alertActive = true;
      const worst = Math.max(...samples.map((s) => s.coldP95Ms));
      logger.warn(
        {
          coldP95Ms: sample.coldP95Ms,
          windowWorstP95Ms: worst,
          coldSamplesInBuffer: sample.coldSamplesInBuffer,
          windowMins: (WINDOW_SAMPLES * SAMPLE_INTERVAL_MS) / 60_000,
        },
        "Broadcast cold-build p95 regression detected — paging on-call",
      );
      void sendOpsAlert({
        severity: "warning",
        title: "Broadcast payload cold-build latency regression",
        message:
          `The cold-rebuild p95 of buildBroadcastCurrentPayload has been at or above ` +
          `${ALERT_P95_MS}ms for ${(WINDOW_SAMPLES * SAMPLE_INTERVAL_MS) / 60_000} consecutive ` +
          `minutes (current p95: ${sample.coldP95Ms}ms, worst in window: ${worst}ms). ` +
          `Healthy is <100ms. Viewers hitting /broadcast/current after a cache eviction will ` +
          `see noticeable lag and likely SSE desync. Check PG connection-pool health, the three ` +
          `parallel reads inside buildBroadcastCurrentPayload (getActiveLiveOverride, ` +
          `getScheduleEntries, getBroadcastQueue), and recent code changes to the broadcast ` +
          `cache TTL or invalidation paths.`,
        fields: [
          { label: "Current p95", value: `${sample.coldP95Ms}ms` },
          { label: "Worst p95 in window", value: `${worst}ms` },
          { label: "Cold samples in buffer", value: sample.coldSamplesInBuffer.toLocaleString() },
          { label: "Cold builds since boot", value: sample.coldCountTotal.toLocaleString() },
          { label: "Window length", value: `${(WINDOW_SAMPLES * SAMPLE_INTERVAL_MS) / 60_000} min` },
          { label: "Alert threshold", value: `>=${ALERT_P95_MS}ms p95` },
        ],
        dedupKey: `broadcast-cold-build-regression:${Math.floor(Date.now() / (DEDUP_TTL_SEC * 1000))}`,
        dedupTtlSec: DEDUP_TTL_SEC,
      }).catch(() => {});
      return;
    }

    if (alertActive && isRecovered()) {
      alertActive = false;
      logger.info(
        { coldP95Ms: sample.coldP95Ms },
        "Broadcast cold-build p95 recovered",
      );
      void sendOpsAlert({
        severity: "info",
        title: "Broadcast payload cold-build latency recovered",
        message:
          `Cold-rebuild p95 has settled below ${RECOVERY_P95_MS}ms for ` +
          `${(WINDOW_SAMPLES * SAMPLE_INTERVAL_MS) / 60_000} consecutive minutes ` +
          `(current p95: ${sample.coldP95Ms}ms). The earlier regression alert is cleared.`,
        fields: [
          { label: "Current p95", value: `${sample.coldP95Ms}ms` },
          { label: "Cold samples in buffer", value: sample.coldSamplesInBuffer.toLocaleString() },
        ],
        dedupKey: `broadcast-cold-build-recovered:${Math.floor(Date.now() / (5 * 60_000))}`,
        dedupTtlSec: 5 * 60,
      }).catch(() => {});
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "broadcastLatencyWatchdog tick failed",
    );
  }
}

export function startBroadcastLatencyWatchdog(): void {
  if (started) return;
  started = true;
  pushSample();
  timer = setInterval(() => {
    void tick();
  }, SAMPLE_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  logger.info(
    {
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      windowMins: (WINDOW_SAMPLES * SAMPLE_INTERVAL_MS) / 60_000,
      alertAboveP95Ms: ALERT_P95_MS,
      recoverBelowP95Ms: RECOVERY_P95_MS,
      minColdBuildsForAlert: MIN_COLD_BUILDS_FOR_ALERT,
    },
    "Broadcast latency watchdog started",
  );
}

export function stopBroadcastLatencyWatchdog(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
  samples.length = 0;
  alertActive = false;
}
