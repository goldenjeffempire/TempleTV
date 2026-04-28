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
 * snapshot, and pages on-call via `sendOpsAlert` on TWO independent triggers:
 *
 *   1. ABSOLUTE: RSS sustained above a configurable threshold (catches a
 *      slow leak that's already filled most of the headroom, or an instance
 *      that boots high for some other reason).
 *
 *   2. RATE-OF-CHANGE: `external` (off-heap) growing faster than a
 *      configurable MiB/min slope across a rolling window (catches an
 *      aggressive leak BEFORE it crosses the absolute threshold — by the
 *      time RSS is at 900 MiB on a 2 GiB instance, on-call has minutes to
 *      respond; if the slope alert fires at +30 MiB/min while RSS is still
 *      at 400 MiB, on-call has tens of minutes).
 *
 * Recovery is automatic and one-shot for both, mirroring
 * `signedUrlCacheWatchdog` and `broadcastLatencyWatchdog`.
 *
 * Tunables (env-driven so an operator can adjust without a redeploy of code):
 *   - API_MEMORY_WATCHDOG_RSS_ALERT_MB              (default 900)
 *   - API_MEMORY_WATCHDOG_RSS_RECOVERY_MB           (default 700)
 *   - API_MEMORY_WATCHDOG_EXTERNAL_GROWTH_ALERT_MBPM    (default 30 MiB/min)
 *   - API_MEMORY_WATCHDOG_EXTERNAL_GROWTH_RECOVERY_MBPM (default 10 MiB/min)
 *   - API_MEMORY_WATCHDOG_SAMPLE_INTERVAL_MS        (default 60_000)
 *   - API_MEMORY_WATCHDOG_DISABLED                  (set to "1" to disable)
 *
 * Defaults are sized for Render's 2 GiB instance: 900 MiB alert is well below
 * the 1.38 GiB OOM kill point but high enough that an idle process (~150 MiB
 * RSS at startup) doesn't constantly trip it. 30 MiB/min on `external` is
 * slightly faster than the worst observed §23 ramp (~1 GiB / 30 min ≈ 33
 * MiB/min average, but real instantaneous ramp was much higher) — sized to
 * fire on a real leak within minutes while ignoring transient spikes from
 * one-off multipart-upload buffer allocations.
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

const EXTERNAL_GROWTH_ALERT_MBPM = (() => {
  const v = Number.parseInt(process.env.API_MEMORY_WATCHDOG_EXTERNAL_GROWTH_ALERT_MBPM ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 30;
})();

const EXTERNAL_GROWTH_RECOVERY_MBPM = (() => {
  const v = Number.parseInt(process.env.API_MEMORY_WATCHDOG_EXTERNAL_GROWTH_RECOVERY_MBPM ?? "", 10);
  return Number.isFinite(v) && v >= 0 ? v : 10;
})();

// How many consecutive samples must exceed each threshold before paging.
// 3 samples × 60s = 3 minutes — long enough that a transient spike (a single
// large multipart-upload buffer) doesn't false-positive, short enough that
// a real leak pages well before the OOM kill.
const SUSTAIN_SAMPLES = 3;

// Rolling window for the slope calculation. 5 samples × 60s = 5 minutes — the
// slope is computed as (newest.external - oldest.external) / windowMins, so
// the window must be long enough that a single high-byte sample doesn't
// dominate (a 100 MiB transient over a 1-min window reads as +100 MiB/min;
// over a 5-min window it reads as +20 MiB/min). 5 minutes is the same window
// length that signedUrlCacheWatchdog uses for the same statistical reason.
const SLOPE_WINDOW_SAMPLES = 5;

const DEDUP_TTL_SEC = 60 * 60;

interface Sample {
  at: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

const samples: Sample[] = [];

let started = false;
let timer: NodeJS.Timeout | null = null;
let consecutiveRssOver = 0;
let consecutiveSlopeOver = 0;
let rssAlertActive = false;
let slopeAlertActive = false;

function fmtMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * Return a deep link to the operations Mission Control card so an alert
 * recipient can jump straight from the page into the diagnostics panel.
 *
 * Resolution order (each may be absent in any environment):
 *   1. ADMIN_PUBLIC_URL — explicit operator override, takes precedence
 *   2. RENDER_EXTERNAL_URL — set automatically on Render, the production env
 *   3. REPLIT_DEV_DOMAIN — the dev workflow on Replit (HTTPS auto-added)
 *   4. fallback to a relative URL — better than nothing, click-to-copy works
 *      and an operator on the same machine can paste into a tab
 *
 * The returned URL ends with `#memory` so the operations page can scroll to
 * and briefly highlight the matching card on load.
 */
function getOperationsDeepLink(): string {
  const explicit = process.env.ADMIN_PUBLIC_URL?.trim();
  if (explicit) return `${explicit.replace(/\/+$/, "")}/operations#memory`;
  const render = process.env.RENDER_EXTERNAL_URL?.trim();
  if (render) return `${render.replace(/\/+$/, "")}/operations#memory`;
  const replit = process.env.REPLIT_DEV_DOMAIN?.trim();
  if (replit) {
    const proto = replit.startsWith("http") ? "" : "https://";
    return `${proto}${replit.replace(/\/+$/, "")}/operations#memory`;
  }
  return "/operations#memory";
}

function pushSample(m: NodeJS.MemoryUsage): Sample {
  const sample: Sample = {
    at: Date.now(),
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
  };
  samples.push(sample);
  while (samples.length > SLOPE_WINDOW_SAMPLES) samples.shift();
  return sample;
}

/**
 * Returns the slope of `external` memory growth in MiB per minute over the
 * full rolling window. Returns `null` while the buffer is still warming up
 * (fewer than SLOPE_WINDOW_SAMPLES samples) — slope on a partial window is
 * statistically unreliable and would false-positive at startup.
 */
function externalGrowthMbPerMin(): number | null {
  if (samples.length < SLOPE_WINDOW_SAMPLES) return null;
  const oldest = samples[0];
  const newest = samples[samples.length - 1];
  const deltaBytes = newest.external - oldest.external;
  const deltaMin = (newest.at - oldest.at) / 60_000;
  if (deltaMin <= 0) return 0;
  return deltaBytes / 1024 / 1024 / deltaMin;
}

function tick(): void {
  try {
    const m = process.memoryUsage();
    pushSample(m);
    const slope = externalGrowthMbPerMin();
    const snapshot = {
      rssMb: Math.round(m.rss / 1024 / 1024),
      heapUsedMb: Math.round(m.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(m.heapTotal / 1024 / 1024),
      externalMb: Math.round(m.external / 1024 / 1024),
      arrayBuffersMb: Math.round(m.arrayBuffers / 1024 / 1024),
      externalGrowthMbPerMin: slope === null ? null : Math.round(slope * 10) / 10,
    };
    // Always log the snapshot — operators can grep this in Mission Control to
    // see the pre-incident memory trajectory after an OOM, even if the alert
    // never fired (e.g. cliff-edge regression that crossed threshold and
    // OOM-killed within a single sample window).
    logger.info(snapshot, "memory snapshot");

    // ── Trigger 1: absolute RSS threshold ────────────────────────────────
    if (m.rss >= RSS_ALERT_BYTES) {
      consecutiveRssOver += 1;
    } else if (m.rss <= RSS_RECOVERY_BYTES) {
      consecutiveRssOver = 0;
      if (rssAlertActive) {
        rssAlertActive = false;
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
    // don't reset the consecutive counter, don't fire recovery either.

    if (!rssAlertActive && consecutiveRssOver >= SUSTAIN_SAMPLES) {
      rssAlertActive = true;
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
          { label: "Mission Control", value: getOperationsDeepLink() },
        ],
        dedupKey: `api-memory-rss-high:${Math.floor(Date.now() / (DEDUP_TTL_SEC * 1000))}`,
        dedupTtlSec: DEDUP_TTL_SEC,
      }).catch(() => {});
    }

    // ── Trigger 2: external memory growth-rate ───────────────────────────
    // Independent of the absolute RSS trigger — a fast leak can fire this
    // alert with hundreds of MiB of headroom remaining, giving on-call far
    // more lead time than the absolute trigger alone would.
    if (slope !== null) {
      if (slope >= EXTERNAL_GROWTH_ALERT_MBPM) {
        consecutiveSlopeOver += 1;
      } else if (slope <= EXTERNAL_GROWTH_RECOVERY_MBPM) {
        consecutiveSlopeOver = 0;
        if (slopeAlertActive) {
          slopeAlertActive = false;
          logger.info(
            { ...snapshot, slopeMbPerMin: snapshot.externalGrowthMbPerMin },
            "External memory growth-rate recovered",
          );
          void sendOpsAlert({
            severity: "info",
            title: "API external-memory growth recovered",
            message:
              `External memory growth has fallen to ${slope.toFixed(1)} MiB/min ` +
              `(recovery threshold ${EXTERNAL_GROWTH_RECOVERY_MBPM} MiB/min). ` +
              `The earlier off-heap-growth alert is cleared.`,
            fields: [
              { label: "External", value: fmtMb(m.external) },
              { label: "Growth rate", value: `${slope.toFixed(1)} MiB/min` },
              { label: "Recovery threshold", value: `${EXTERNAL_GROWTH_RECOVERY_MBPM} MiB/min` },
            ],
            dedupKey: `api-memory-external-growth-recovered:${Math.floor(Date.now() / (5 * 60_000))}`,
            dedupTtlSec: 5 * 60,
          }).catch(() => {});
        }
      }
      // Hysteresis zone (between recovery and alert thresholds): leave the
      // consecutive counter alone, no recovery either.

      if (!slopeAlertActive && consecutiveSlopeOver >= SUSTAIN_SAMPLES) {
        slopeAlertActive = true;
        const projectedMinUntilRssAlert =
          slope > 0 ? Math.max(0, (RSS_ALERT_BYTES - m.rss) / 1024 / 1024 / slope) : Infinity;
        logger.warn(
          {
            ...snapshot,
            sustainSamples: SUSTAIN_SAMPLES,
            slopeMbPerMin: snapshot.externalGrowthMbPerMin,
            projectedMinUntilRssAlert: Number.isFinite(projectedMinUntilRssAlert)
              ? Math.round(projectedMinUntilRssAlert)
              : null,
          },
          "External memory growth-rate sustained above alert — paging on-call",
        );
        void sendOpsAlert({
          severity: "warning",
          title: "API external-memory growth-rate alert",
          message:
            `External memory has grown at ${slope.toFixed(1)} MiB/min for ${SUSTAIN_SAMPLES} ` +
            `consecutive ${SAMPLE_INTERVAL_MS / 1000}s samples (alert threshold ` +
            `${EXTERNAL_GROWTH_ALERT_MBPM} MiB/min). Current external=${fmtMb(m.external)}, ` +
            `RSS=${fmtMb(m.rss)}. ` +
            (Number.isFinite(projectedMinUntilRssAlert)
              ? `At this rate, RSS would cross the absolute alert threshold ` +
                `(${fmtMb(RSS_ALERT_BYTES)}) in ~${Math.round(projectedMinUntilRssAlert)} min. `
              : "") +
            `This usually means an off-heap leak — see RELEASE_AUDIT.md §23 for the prior ` +
            `regression playbook (unbounded middleware caches, AWS SDK socket pool, ` +
            `non-destroyed S3 streams on client abort).`,
          fields: [
            { label: "Growth rate", value: `${slope.toFixed(1)} MiB/min` },
            { label: "External", value: fmtMb(m.external) },
            { label: "RSS", value: fmtMb(m.rss) },
            { label: "Alert threshold", value: `${EXTERNAL_GROWTH_ALERT_MBPM} MiB/min` },
            { label: "Sustained samples", value: String(SUSTAIN_SAMPLES) },
            ...(Number.isFinite(projectedMinUntilRssAlert)
              ? [
                  {
                    label: "Projected to RSS-alert",
                    value: `~${Math.round(projectedMinUntilRssAlert)} min`,
                  },
                ]
              : []),
            { label: "Mission Control", value: getOperationsDeepLink() },
          ],
          dedupKey: `api-memory-external-growth:${Math.floor(Date.now() / (DEDUP_TTL_SEC * 1000))}`,
          dedupTtlSec: DEDUP_TTL_SEC,
        }).catch(() => {});
      }
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
      externalGrowthAlertMbPerMin: EXTERNAL_GROWTH_ALERT_MBPM,
      externalGrowthRecoveryMbPerMin: EXTERNAL_GROWTH_RECOVERY_MBPM,
      slopeWindowSamples: SLOPE_WINDOW_SAMPLES,
      slopeWindowMins: (SLOPE_WINDOW_SAMPLES * SAMPLE_INTERVAL_MS) / 60_000,
      sustainSamples: SUSTAIN_SAMPLES,
    },
    "Memory watchdog started",
  );
}

/**
 * Snapshot of the watchdog's current internal state — exposed so admin
 * diagnostics can show operators the same signal the pager sees, without
 * leaving the Mission Control panel. All fields are pre-computed by the
 * watchdog itself so the UI does not have to duplicate the slope math.
 */
export interface MemoryWatchdogState {
  enabled: boolean;
  sampleIntervalMs: number;
  thresholds: {
    rssAlertMb: number;
    rssRecoveryMb: number;
    externalGrowthAlertMbPerMin: number;
    externalGrowthRecoveryMbPerMin: number;
    sustainSamples: number;
    slopeWindowSamples: number;
  };
  current: {
    externalGrowthMbPerMin: number | null;
    consecutiveRssOver: number;
    consecutiveSlopeOver: number;
  };
  alerts: {
    rssAlertActive: boolean;
    slopeAlertActive: boolean;
  };
}

export function getMemoryWatchdogState(): MemoryWatchdogState {
  return {
    enabled: started,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    thresholds: {
      rssAlertMb: Math.round(RSS_ALERT_BYTES / 1024 / 1024),
      rssRecoveryMb: Math.round(RSS_RECOVERY_BYTES / 1024 / 1024),
      externalGrowthAlertMbPerMin: EXTERNAL_GROWTH_ALERT_MBPM,
      externalGrowthRecoveryMbPerMin: EXTERNAL_GROWTH_RECOVERY_MBPM,
      sustainSamples: SUSTAIN_SAMPLES,
      slopeWindowSamples: SLOPE_WINDOW_SAMPLES,
    },
    current: {
      externalGrowthMbPerMin: (() => {
        const slope = externalGrowthMbPerMin();
        return slope === null ? null : Math.round(slope * 10) / 10;
      })(),
      consecutiveRssOver,
      consecutiveSlopeOver,
    },
    alerts: {
      rssAlertActive,
      slopeAlertActive,
    },
  };
}

export function stopMemoryWatchdog(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
  consecutiveRssOver = 0;
  consecutiveSlopeOver = 0;
  rssAlertActive = false;
  slopeAlertActive = false;
  samples.length = 0;
}
