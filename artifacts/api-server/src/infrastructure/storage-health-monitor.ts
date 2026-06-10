/**
 * Storage health monitor.
 *
 * Periodically writes a tiny probe object, reads back its size via headObject,
 * and deletes it to verify that the database-backed blob store is writable and
 * responsive. This is an independent health signal separate from the DB pool
 * health monitor — a DB pool can be healthy (connections available) while the
 * storage_blobs table itself is corrupt, locked, or has run out of TOAST space.
 *
 * Circuit breaker model:
 *   • FAILURE_THRESHOLD (3) consecutive failures → healthy=false + ops-alert SSE
 *   • RECOVERY_THRESHOLD (2) consecutive successes → healthy=true + recovery alert
 *
 * Exposes getStorageHealthStatus() consumed by the broadcast-v2 /health endpoint.
 */
import { logger } from "./logger.js";
import { storage } from "./storage.js";

// Lazy import to avoid circular dep: storage → mail → storage (via env)
async function sendStorageDegradedAlert(lastError: string): Promise<void> {
  try {
    const { sendAdminAlert } = await import("../modules/mail/mail.service.js");
    await sendAdminAlert({
      subject: "Object storage health degraded",
      severity: "critical",
      body: [
        `Object storage probe has failed ${FAILURE_THRESHOLD} consecutive times.`,
        "",
        `Last error: ${lastError}`,
        "",
        "Impact: uploads, HLS segment delivery, and thumbnail retrieval may be broken.",
        "Check the admin dashboard → System Health for storage status.",
      ].join("\n"),
    });
  } catch (err) {
    logger.warn({ err }, "[storage-health] admin alert email failed (non-fatal)");
  }
}

const HEALTH_KEY = "__health_probe__";
const HEALTH_VALUE = Buffer.from("ok");
const FAILURE_THRESHOLD = 3;
const RECOVERY_THRESHOLD = 2;
const DEFAULT_INTERVAL_MS = 60_000;

export interface StorageHealthStatus {
  healthy: boolean;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastCheckAtMs: number | null;
  lastError: string | null;
  totalChecks: number;
  enabled: boolean;
}

class StorageHealthMonitorImpl {
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private checking = false;
  private healthy = true;
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private lastCheckAtMs: number | null = null;
  private lastError: string | null = null;
  private totalChecks = 0;

  start(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (this.timer || this.initialTimer) return;

    // Initial probe 5 s after boot so the pool is warm before we write.
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      void this.check();
    }, 5_000);
    this.initialTimer.unref?.();

    this.timer = setInterval(() => {
      void this.check().catch((err) =>
        logger.warn({ err }, "[storage-health] check threw unexpectedly (non-fatal)"),
      );
    }, intervalMs);
    this.timer.unref?.();
    logger.info({ intervalMs }, "[storage-health] storage health monitor started");
  }

  stop(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStatus(): StorageHealthStatus {
    return {
      healthy: this.healthy,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      lastCheckAtMs: this.lastCheckAtMs,
      lastError: this.lastError,
      totalChecks: this.totalChecks,
      enabled: storage().enabled,
    };
  }

  private async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    this.totalChecks++;
    const s = storage();

    if (!s.enabled) {
      // Storage not configured — mark always healthy (storage is optional).
      this.lastCheckAtMs = Date.now();
      this.checking = false;
      return;
    }

    try {
      // Write a minimal probe blob.
      await s.putObject({ key: HEALTH_KEY, body: HEALTH_VALUE, contentType: "application/octet-stream" });
      // Verify it exists with the correct size.
      const head = await s.headObject(HEALTH_KEY);
      if (!head.exists) {
        throw new Error("storage probe: putObject succeeded but headObject returned exists=false");
      }
      if (head.contentLength !== undefined && head.contentLength !== HEALTH_VALUE.byteLength) {
        throw new Error(
          `storage probe: size mismatch (got ${head.contentLength}, expected ${HEALTH_VALUE.byteLength})`,
        );
      }
      // Delete the probe object so we don't accumulate probe rows.
      await s.deleteObject(HEALTH_KEY);

      // ── Success path ─────────────────────────────────────────────────────
      const wasUnhealthy = !this.healthy;
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses++;
      this.lastCheckAtMs = Date.now();
      this.lastError = null;

      if (wasUnhealthy && this.consecutiveSuccesses >= RECOVERY_THRESHOLD) {
        this.healthy = true;
        logger.info("[storage-health] storage health RECOVERED ✓");
        const { adminEventBus } = await import("../modules/admin-ops/admin-event-bus.js");
        adminEventBus.push("ops-alert", {
          level: "info",
          title: "Storage health recovered",
          message: "Object storage write/head/delete probe succeeded — storage is healthy again.",
          detail: null,
          timestamp: new Date().toISOString(),
          source: "storage-health-monitor",
        });
      }
    } catch (err) {
      // ── Failure path ─────────────────────────────────────────────────────
      this.consecutiveFailures++;
      this.consecutiveSuccesses = 0;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.lastCheckAtMs = Date.now();

      if (this.consecutiveFailures === FAILURE_THRESHOLD) {
        this.healthy = false;
        logger.error(
          { consecutiveFailures: this.consecutiveFailures, lastError: this.lastError },
          "[storage-health] storage DEGRADED — consecutive write/head failures",
        );
        try {
          const { adminEventBus } = await import("../modules/admin-ops/admin-event-bus.js");
          adminEventBus.push("ops-alert", {
            level: "critical",
            title: "Storage health degraded",
            message: `Object storage probe failed ${FAILURE_THRESHOLD} consecutive times — uploads, HLS delivery, and thumbnails may be broken.`,
            detail: this.lastError,
            timestamp: new Date().toISOString(),
            source: "storage-health-monitor",
          });
        } catch {
          // adminEventBus import failure is non-fatal
        }
        // Email alert: SSE only reaches an open admin dashboard; email is the
        // out-of-band path when no one is watching (e.g. overnight outage).
        void sendStorageDegradedAlert(this.lastError ?? "unknown error");
      } else {
        logger.warn(
          { consecutiveFailures: this.consecutiveFailures, err },
          "[storage-health] storage probe failed (non-critical yet)",
        );
      }
    } finally {
      this.checking = false;
    }
  }
}

export const storageHealthMonitor = new StorageHealthMonitorImpl();
export function getStorageHealthStatus(): StorageHealthStatus {
  return storageHealthMonitor.getStatus();
}
