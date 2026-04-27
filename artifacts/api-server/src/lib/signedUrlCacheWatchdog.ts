/**
 * Signed-URL cache regression watchdog.
 *
 * The two media-redirect middlewares both keep a per-key in-memory presigned
 * URL cache to avoid re-signing on every HTML5 `<video>` Range request. When
 * that cache is doing its job, a steady playback session reports a hit-rate
 * (`cached / hits`) of roughly 95%. A sustained drop to <50% means something
 * regressed: TTL too short, key churn, every viewer hitting a different file,
 * or a code change that's bypassing the cache. Whatever the cause, the API
 * is now re-signing far more aggressively than it should be — wasting CPU
 * and (more importantly) hammering the S3 SigV4 sign rate limit.
 *
 * This module samples `signedUrlMetricsSnapshot()` at a fixed cadence,
 * computes the *delta* hit-rate over a rolling 5-minute window (so a healthy
 * historical period can't mask a current regression), and pages on-call via
 * the existing `sendOpsAlert` primitive when the rate is bad AND the window
 * has enough hits to be statistically meaningful.
 *
 * Recovery is automatic: as soon as the rolling-window rate climbs back
 * above the recovery threshold, the dedup key clears and a follow-up
 * "recovered" alert fires once. There's no manual reset.
 */

import { logger } from "./logger";
import { sendOpsAlert } from "./alerts";
import { signedUrlMetricsSnapshot } from "./signedUrlMetrics";

// ── Tunables ────────────────────────────────────────────────────────────────
//
// 60s sampling cadence — fine enough to catch a regression within a single
// alert dedup window, coarse enough that the watchdog itself is invisible
// in CPU profiles.
const SAMPLE_INTERVAL_MS = 60 * 1000;
//
// 5-minute rolling window — five 60s samples. Short enough that a real
// regression pages within ~6 minutes of onset, long enough that a brief
// run of hard-to-cache requests (a CDN edge probing fresh files, a single
// admin previewing every recently-uploaded MP4) doesn't false-positive.
const WINDOW_SAMPLES = 5;
//
// Don't fire below this many hits in the window — small samples have wild
// variance and would alert constantly on a low-traffic instance. 100 hits
// per 5min ≈ 20 redirects per minute, which is the floor at which a
// regression actually matters.
const MIN_HITS_FOR_ALERT = 100;
//
// Below this hit-rate, fire the alert (with dedup).
const ALERT_HIT_RATE = 0.5;
//
// Above this hit-rate, clear the suppression and fire a one-shot
// "recovered" alert. Note the gap between alert and recovery thresholds
// (50% → 70%) — this hysteresis prevents alert flap when the rate
// oscillates around 50%.
const RECOVERY_HIT_RATE = 0.7;
//
// Dedup key TTL. Once we've fired the regression alert, we suppress
// repeats for an hour — long enough that on-call has time to investigate
// without being re-paged, short enough that a regression that's still
// active after the engineer fixed something else gets re-surfaced.
const DEDUP_TTL_SEC = 60 * 60;

interface Sample {
  at: number;
  fresh: number;
  cached: number;
}

// Rolling buffer of the last N samples (oldest first).
const samples: Sample[] = [];

// Tracks whether we're currently in an "alerted" state so we can fire the
// matching recovery alert exactly once when the rate climbs back. Process-
// local — survives only until the next deploy, which is fine: a redeploy
// resets the metric counters too, so re-evaluation starts from scratch.
let alertActive = false;

let started = false;
let timer: NodeJS.Timeout | null = null;

function pushSample(): Sample {
  const snap = signedUrlMetricsSnapshot();
  const sample: Sample = {
    at: Date.now(),
    fresh: snap.total.fresh,
    cached: snap.total.cached,
  };
  samples.push(sample);
  while (samples.length > WINDOW_SAMPLES) samples.shift();
  return sample;
}

function evaluateWindow(): { hits: number; cached: number; rate: number } | null {
  if (samples.length < WINDOW_SAMPLES) return null;
  const oldest = samples[0];
  const newest = samples[samples.length - 1];
  const fresh = newest.fresh - oldest.fresh;
  const cached = newest.cached - oldest.cached;
  const hits = fresh + cached;
  if (hits <= 0) return { hits: 0, cached: 0, rate: 0 };
  return { hits, cached, rate: cached / hits };
}

async function tick(): Promise<void> {
  try {
    pushSample();
    const window = evaluateWindow();
    if (!window) return; // Still warming up — need WINDOW_SAMPLES samples first.

    if (window.hits < MIN_HITS_FOR_ALERT) {
      // Not enough traffic to trust the sample. Don't alert and don't
      // recover — the system is effectively idle.
      return;
    }

    if (!alertActive && window.rate < ALERT_HIT_RATE) {
      alertActive = true;
      logger.warn(
        {
          hitRate: Math.round(window.rate * 1000) / 1000,
          hits: window.hits,
          cached: window.cached,
          windowMins: (WINDOW_SAMPLES * SAMPLE_INTERVAL_MS) / 60_000,
        },
        "Signed-URL cache hit-rate regression detected — paging on-call",
      );
      void sendOpsAlert({
        severity: "warning",
        title: "Signed-URL cache hit-rate regression",
        message:
          `The signed-URL cache hit-rate has dropped to ${(window.rate * 100).toFixed(1)}% over ` +
          `the last ${(WINDOW_SAMPLES * SAMPLE_INTERVAL_MS) / 60_000} minutes ` +
          `(${window.cached} reused / ${window.hits} hits). ` +
          `Healthy is ≥80%. The API is re-signing far more aggressively than it should be — ` +
          `check for code changes to s3RedirectFirst / staticWithS3Fallback, ` +
          `unusual key churn (every viewer hitting a different file), or a TTL config regression.`,
        fields: [
          { label: "Window hit-rate", value: `${(window.rate * 100).toFixed(1)}%` },
          { label: "Window cached", value: window.cached.toLocaleString() },
          { label: "Window total hits", value: window.hits.toLocaleString() },
          { label: "Window length", value: `${(WINDOW_SAMPLES * SAMPLE_INTERVAL_MS) / 60_000} min` },
          { label: "Threshold", value: `<${ALERT_HIT_RATE * 100}%` },
        ],
        // Dedup at the hour — if it's still bad an hour later, we re-page.
        dedupKey: `signed-url-cache-regression:${Math.floor(Date.now() / (DEDUP_TTL_SEC * 1000))}`,
        dedupTtlSec: DEDUP_TTL_SEC,
      }).catch(() => {});
      return;
    }

    if (alertActive && window.rate >= RECOVERY_HIT_RATE) {
      alertActive = false;
      logger.info(
        {
          hitRate: Math.round(window.rate * 1000) / 1000,
          hits: window.hits,
        },
        "Signed-URL cache hit-rate recovered",
      );
      void sendOpsAlert({
        severity: "info",
        title: "Signed-URL cache hit-rate recovered",
        message:
          `The signed-URL cache hit-rate has climbed back to ${(window.rate * 100).toFixed(1)}% ` +
          `over the last ${(WINDOW_SAMPLES * SAMPLE_INTERVAL_MS) / 60_000} minutes. The earlier ` +
          `regression alert is cleared.`,
        fields: [
          { label: "Window hit-rate", value: `${(window.rate * 100).toFixed(1)}%` },
          { label: "Window total hits", value: window.hits.toLocaleString() },
        ],
        // Recovery is one-shot per process — no dedup needed beyond a small
        // window to coalesce a recovery that fires within the same minute
        // as a sample boundary on multiple replicas.
        dedupKey: `signed-url-cache-recovered:${Math.floor(Date.now() / (5 * 60_000))}`,
        dedupTtlSec: 5 * 60,
      }).catch(() => {});
    }
  } catch (err) {
    // Watchdog must NEVER crash the process — log and move on.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "signedUrlCacheWatchdog tick failed",
    );
  }
}

export function startSignedUrlCacheWatchdog(): void {
  if (started) return;
  started = true;
  // Prime the buffer with a first sample immediately so the warm-up phase
  // is just (WINDOW_SAMPLES - 1) more ticks instead of WINDOW_SAMPLES + 1.
  pushSample();
  timer = setInterval(() => {
    void tick();
  }, SAMPLE_INTERVAL_MS);
  // Don't let the watchdog timer keep the event loop alive on its own —
  // graceful shutdown (SIGTERM drain) shouldn't be held open by a metric
  // sampler that has no in-flight work.
  if (typeof timer.unref === "function") timer.unref();
  logger.info(
    {
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      windowMins: (WINDOW_SAMPLES * SAMPLE_INTERVAL_MS) / 60_000,
      alertBelowRate: ALERT_HIT_RATE,
      recoverAboveRate: RECOVERY_HIT_RATE,
      minHitsForAlert: MIN_HITS_FOR_ALERT,
    },
    "Signed-URL cache watchdog started",
  );
}

export function stopSignedUrlCacheWatchdog(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
  samples.length = 0;
  alertActive = false;
}
