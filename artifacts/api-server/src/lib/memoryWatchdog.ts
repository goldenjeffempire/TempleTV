/**
 * In-process memory watchdog.
 *
 * Render killed the API service with SIGKILL at ~1.38 GiB RSS during sustained
 * `/api/uploads/*.mp4` traffic (see RELEASE_AUDIT.md §23). Heap was small —
 * the leak was off-heap (process.memoryUsage().external grew to ~1.2 GiB)
 * driven by unbounded middleware caches, an unbounded AWS SDK socket pool,
 * and S3 → client streams that weren't destroyed on client abort.
 *
 * §23's defensive fixes give the process a deterministic worst-case memory
 * footprint, but a future regression — a new unbounded cache, a new code path
 * that holds Buffers, an SDK upgrade that changes default agent behavior —
 * could silently re-introduce the leak. By the time Render's OOM killer
 * fires we've already taken downtime.
 *
 * This watchdog samples `process.memoryUsage()` every 60s, logs a structured
 * snapshot, and pages on-call via `sendOpsAlert` when RSS crosses a
 * configurable threshold for a sustained window. Recovery is automatic and
 * one-shot, mirroring `signedUrlCacheWatchdog` and `broadcastLatencyWatchdog`.
 *
 * Tunables (env-driven so an operator can adjust without a redeploy of code):
 *   - API_MEMORY_WATCHDOG_RSS_ALERT_MB       (default 900)
 *   - API_MEMORY_WATCHDOG_RSS_RECOVERY_MB    (default 700)
 *   - API_MEMORY_WATCHDOG_SAMPLE_INTERVAL_MS (default 60_000)
 *   - API_MEMORY_WATCHDOG_DISABLED           (set to "1" to disable)
 *
 * Defaults are sized for Render's 2 GiB instance: 900 MiB alert is well below
 * the 1.38 GiB OOM kill point but high enough that an idle process (~150 MiB
 * RSS at startup) doesn't constantly trip it.
 */

import { logger } from "./logger";
import { sendOpsAlert } from "./alerts";

const SAMPLE_INTERVAL_MS = (() => {
  const v = Number.parseInt(process.env.API_MEMORY_WATCHDOG_SAMPLE_INTERVAL_MS ?? "", 10);
  return Number.isFinite(v) && v >= 5_000 ? v : 60_000;
})();

const RSS_ALERT_BYTES = (() => {
  const v = Number.parseInt(process.env.API_MEMORY_WATCHDOG_RSS_ALERT_MB ?? "", 10);
  return (Number.isFinite(v) && v > 0 ? v : 900) * 1024 * 1024;
})();

const RSS_RECOVERY_BYTES = (() => {
  const v = Number.parseInt(process.env.API_MEMORY_WATCHDOG_RSS_RECOVERY_MB ?? "", 10);
  return (Number.isFinite(v) && v > 0 ? v : 700) * 1024 * 1024;
})();

// How many consecutive samples must exceed the threshold before paging.
// 3 samples × 60s = 3 minutes — long enough that a transient spike (a single
// large multipart-upload buffer) doesn't false-positive, short enough that
// a real leak pages well before the OOM kill.
const SUSTAIN_SAMPLES = 3;

const DEDUP_TTL_SEC = 60 * 60;

let started = false;
let timer: NodeJS.Timeout | null = null;
let consecutiveOver = 0;
let alertActive = false;

function fmtMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function tick(): void {
  try {
    const m = process.memoryUsage();
    const snapshot = {
      rssMb: Math.round(m.rss / 1024 / 1024),
      heapUsedMb: Math.round(m.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(m.heapTotal / 1024 / 1024),
      externalMb: Math.round(m.external / 1024 / 1024),
      arrayBuffersMb: Math.round(m.arrayBuffers / 1024 / 1024),
    };
    // Always log the snapshot — operators can grep this in Mission Control to
    // see the pre-incident memory trajectory after an OOM, even if the alert
    // never fired (e.g. cliff-edge regression that crossed threshold and
    // OOM-killed within a single sample window).
    logger.info(snapshot, "memory snapshot");

    if (m.rss >= RSS_ALERT_BYTES) {
      consecutiveOver += 1;
    } else if (m.rss <= RSS_RECOVERY_BYTES) {
      consecutiveOver = 0;
      if (alertActive) {
        alertActive = false;
        logger.info(snapshot, "Memory RSS recovered below threshold");
        void sendOpsAlert({
          severity: "info",
          title: "API memory RSS recovered",
          message:
            `RSS has fallen back to ${fmtMb(m.rss)} (recovery threshold ${fmtMb(RSS_RECOVERY_BYTES)}). ` +
            `The earlier high-memory alert is cleared.`,
          fields: [
            { label: "RSS", value: fmtMb(m.rss) },
            { label: "Heap used", value: fmtMb(m.heapUsed) },
            { label: "External", value: fmtMb(m.external) },
            { label: "Array buffers", value: fmtMb(m.arrayBuffers) },
          ],
          dedupKey: `api-memory-recovered:${Math.floor(Date.now() / (5 * 60_000))}`,
          dedupTtlSec: 5 * 60,
        }).catch(() => {});
      }
    }
    // Any sample between the alert and recovery thresholds is hysteresis-zone:
    // don't reset the consecutive counter (so a flapping sample near the
    // alert line still trips), don't fire recovery either.

    if (!alertActive && consecutiveOver >= SUSTAIN_SAMPLES) {
      alertActive = true;
      logger.warn(
        { ...snapshot, sustainSamples: SUSTAIN_SAMPLES },
        "Memory RSS sustained above alert threshold — paging on-call",
      );
      void sendOpsAlert({
        severity: "warning",
        title: "API memory RSS above threshold",
        message:
          `RSS has been above ${fmtMb(RSS_ALERT_BYTES)} for ${SUSTAIN_SAMPLES} consecutive ` +
          `${SAMPLE_INTERVAL_MS / 1000}s samples (current ${fmtMb(m.rss)}). ` +
          `External=${fmtMb(m.external)}, heap=${fmtMb(m.heapUsed)}. ` +
          `If external is the dominant component, suspect off-heap leak (Buffer/native). ` +
          `If heap is dominant, suspect a JS-object retention leak. ` +
          `See RELEASE_AUDIT.md §23 for the prior off-heap regression playbook.`,
        fields: [
          { label: "RSS", value: fmtMb(m.rss) },
          { label: "Heap used", value: fmtMb(m.heapUsed) },
          { label: "Heap total", value: fmtMb(m.heapTotal) },
          { label: "External", value: fmtMb(m.external) },
          { label: "Array buffers", value: fmtMb(m.arrayBuffers) },
          { label: "Alert threshold", value: fmtMb(RSS_ALERT_BYTES) },
          { label: "Sustained samples", value: String(SUSTAIN_SAMPLES) },
        ],
        dedupKey: `api-memory-rss-high:${Math.floor(Date.now() / (DEDUP_TTL_SEC * 1000))}`,
        dedupTtlSec: DEDUP_TTL_SEC,
      }).catch(() => {});
    }
  } catch (err) {
    // Watchdog must NEVER crash the process — log and move on.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "memoryWatchdog tick failed",
    );
  }
}

export function startMemoryWatchdog(): void {
  if (started) return;
  if (process.env.API_MEMORY_WATCHDOG_DISABLED === "1") {
    logger.info("Memory watchdog disabled via API_MEMORY_WATCHDOG_DISABLED=1");
    return;
  }
  started = true;
  // Emit one snapshot immediately so the boot-time baseline is in the logs
  // before the first 60s window elapses — useful when comparing against an
  // OOM-killed predecessor process.
  tick();
  timer = setInterval(tick, SAMPLE_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  logger.info(
    {
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      rssAlertMb: Math.round(RSS_ALERT_BYTES / 1024 / 1024),
      rssRecoveryMb: Math.round(RSS_RECOVERY_BYTES / 1024 / 1024),
      sustainSamples: SUSTAIN_SAMPLES,
    },
    "Memory watchdog started",
  );
}

export function stopMemoryWatchdog(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
  consecutiveOver = 0;
  alertActive = false;
}
