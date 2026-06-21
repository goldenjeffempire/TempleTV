/**
 * Disk usage watchdog for the scratch partition.
 *
 * Periodically samples statfs(storagePaths.scratch) and:
 *   1. Logs a structured warning when usage > SCRATCH_WARN_PERCENT (default 70 %)
 *   2. Fires an ops-alert + emergency stale-dir sweep when > SCRATCH_ALERT_PERCENT (default 85 %)
 *   3. Exports isDiskConstrained() so transcoder / faststart can abort pre-flight
 *      rather than starting a job that will exhaust the filesystem mid-encode.
 *
 * The watchdog is intentionally non-fatal: a statfs failure degrades to a warn
 * log and clears the constrained flag so jobs are not permanently blocked by a
 * momentary filesystem error.
 */

import { statfs } from "node:fs/promises";
import { logger } from "./logger.js";
import { env } from "../config/env.js";
import { storagePaths, sweepStaleTempDirs } from "./storage-paths.js";
import { adminEventBus } from "../modules/admin-ops/admin-event-bus.js";

// ── Internal state ────────────────────────────────────────────────────────────

let _timer: NodeJS.Timeout | null = null;
let _lastUsedPercent = 0;
let _lastTotalMb = 0;
let _lastFreeMb = 0;
let _constrained = false;
let _alertCooldownUntil = 0;
let _sampleCount = 0;

const ALERT_COOLDOWN_MS = 15 * 60_000;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns true when scratch disk usage is at or above SCRATCH_ALERT_PERCENT.
 * Callers use this as a pre-flight gate before starting disk-heavy operations.
 */
export function isDiskConstrained(): boolean {
  return _constrained;
}

export interface DiskWatchdogState {
  scratchPath: string;
  usedPercent: number;
  totalMb: number;
  freeMb: number;
  constrained: boolean;
  warnPercent: number;
  alertPercent: number;
  sampleCount: number;
}

export function getDiskWatchdogState(): DiskWatchdogState {
  return {
    scratchPath: storagePaths.scratch,
    usedPercent: _lastUsedPercent,
    totalMb: _lastTotalMb,
    freeMb: _lastFreeMb,
    constrained: _constrained,
    warnPercent: env.SCRATCH_WARN_PERCENT,
    alertPercent: env.SCRATCH_ALERT_PERCENT,
    sampleCount: _sampleCount,
  };
}

// ── Sampling ──────────────────────────────────────────────────────────────────

async function sample(): Promise<void> {
  try {
    const fs = await statfs(storagePaths.scratch);
    const { blocks: totalBlocks, bfree: freeBlocks, bsize: blockSize } = fs;

    if (totalBlocks === 0) return;

    const totalBytes = totalBlocks * blockSize;
    const freeBytes  = freeBlocks  * blockSize;
    const usedPercent = Math.round(((totalBytes - freeBytes) / totalBytes) * 100);

    _lastUsedPercent = usedPercent;
    _lastTotalMb     = Math.round(totalBytes / 1024 / 1024);
    _lastFreeMb      = Math.round(freeBytes  / 1024 / 1024);
    _sampleCount++;

    if (usedPercent >= env.SCRATCH_ALERT_PERCENT) {
      _constrained = true;

      logger.error(
        {
          usedPercent,
          freeMb: _lastFreeMb,
          totalMb: _lastTotalMb,
          scratchPath: storagePaths.scratch,
          warnPercent: env.SCRATCH_WARN_PERCENT,
          alertPercent: env.SCRATCH_ALERT_PERCENT,
        },
        "[disk-watchdog] CRITICAL: scratch partition above alert threshold — triggering emergency stale-dir sweep",
      );

      if (Date.now() > _alertCooldownUntil) {
        _alertCooldownUntil = Date.now() + ALERT_COOLDOWN_MS;
        adminEventBus.push("ops-alert", {
          kind: "disk-pressure",
          severity: "critical",
          message:
            `Scratch partition ${usedPercent}% full (${_lastFreeMb} MB free / ${_lastTotalMb} MB total). ` +
            `Emergency stale-dir cleanup triggered. ` +
            `Consider setting STORAGE_PATH=/var/data (Render Disk) or reducing HLS_MAX_CONCURRENT.`,
          scratchPath: storagePaths.scratch,
          freeMb: _lastFreeMb,
          totalMb: _lastTotalMb,
        });
      }

      // Emergency sweep: aggressively reclaim dirs older than 30 minutes.
      const removed = await sweepStaleTempDirs({ maxAgeMs: 30 * 60_000 }).catch((err: unknown) => {
        logger.warn({ err }, "[disk-watchdog] emergency sweep failed");
        return 0;
      });
      logger.info({ removed }, "[disk-watchdog] emergency sweep finished");

    } else if (usedPercent >= env.SCRATCH_WARN_PERCENT) {
      _constrained = false;
      logger.warn(
        { usedPercent, freeMb: _lastFreeMb, totalMb: _lastTotalMb, scratchPath: storagePaths.scratch },
        "[disk-watchdog] scratch partition approaching capacity",
      );
    } else {
      _constrained = false;
      logger.debug(
        { usedPercent, freeMb: _lastFreeMb, totalMb: _lastTotalMb },
        "[disk-watchdog] scratch partition ok",
      );
    }
  } catch (err) {
    // Non-fatal: the scratch dir may not exist yet on first boot.
    // Clear constrained so jobs are not blocked by a transient fs error.
    _constrained = false;
    logger.warn({ err, scratchPath: storagePaths.scratch }, "[disk-watchdog] statfs failed — skipping disk check");
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export function startDiskWatchdog(): void {
  if (_timer) return;

  void (async () => {
    try { await sample(); } catch { /* non-fatal initial sample */ }
  })();

  _timer = setInterval(() => {
    void (async () => {
      try { await sample(); } catch { /* non-fatal */ }
    })();
  }, env.DISK_WATCHDOG_INTERVAL_MS);
  _timer.unref();

  logger.info(
    {
      intervalMs: env.DISK_WATCHDOG_INTERVAL_MS,
      warnPercent: env.SCRATCH_WARN_PERCENT,
      alertPercent: env.SCRATCH_ALERT_PERCENT,
      scratchPath: storagePaths.scratch,
    },
    "[disk-watchdog] started",
  );
}

export function stopDiskWatchdog(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
