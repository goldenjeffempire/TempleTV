/**
 * Periodic media URL integrity scanner.
 *
 * Probes all active broadcast queue items' source URLs for HTTP reachability
 * using HEAD + Range:bytes=0-0 requests with a configurable timeout. Runs on
 * a supervised interval (default: 2 minutes) with bounded concurrency
 * (MAX_CONCURRENT=4) to avoid hammering the upstream server.
 *
 * The scanner is informational and non-destructive — it does NOT mutate the
 * bad-URL cache or deactivate items. Detection of consecutive failures is
 * exposed via /diagnostics so operators can take action.
 *
 * Integration with playbackAnalytics: records "url_blocked" on the first
 * failure for each item so the analytics report shows trending health.
 */
import { logger } from "../../../infrastructure/logger.js";
import { queueRepo } from "../repository/queue.repo.js";
import { playbackAnalytics } from "./playback-analytics.js";

export interface ScanItemResult {
  id: string;
  title: string;
  url: string | null;
  kind: "hls" | "mp4" | "unknown";
  reachable: boolean;
  httpStatus: number | null;
  consecutiveFailures: number;
  lastCheckedAtMs: number;
  lastFailedAtMs: number | null;
}

export interface MediaScanReport {
  lastScanAtMs: number | null;
  scanDurationMs: number | null;
  totalItems: number;
  reachable: number;
  unreachable: number;
  scanning: boolean;
  items: ScanItemResult[];
}

const PROBE_TIMEOUT_MS = 8_000;
const MAX_CONCURRENT = 4;
const DEFAULT_INTERVAL_MS = 2 * 60_000;
const INITIAL_DELAY_MS = 45_000;

async function probeUrl(url: string): Promise<{ ok: boolean; status: number | null }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: ac.signal,
      headers: { Range: "bytes=0-0" },
    });
    clearTimeout(t);
    // 200 = full response, 206 = partial OK, 416 = range invalid but file exists
    const ok = res.status === 200 || res.status === 206 || res.status === 416;
    return { ok, status: res.status };
  } catch {
    clearTimeout(t);
    return { ok: false, status: null };
  }
}

class MediaIntegrityScannerImpl {
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  private readonly failureCounts = new Map<string, { count: number; lastFailedAtMs: number | null }>();
  private report: MediaScanReport = {
    lastScanAtMs: null,
    scanDurationMs: null,
    totalItems: 0,
    reachable: 0,
    unreachable: 0,
    scanning: false,
    items: [],
  };

  start(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (this.timer) return;
    const scheduleRecurring = (): void => {
      this.timer = setInterval(() => {
        void this.scan().catch((err) =>
          logger.warn({ err }, "[media-scanner] scheduled scan error"),
        );
      }, intervalMs);
      this.timer.unref?.();
    };
    const boot = setTimeout(() => {
      void this.scan()
        .catch((err) => logger.warn({ err }, "[media-scanner] initial scan error"))
        .finally(scheduleRecurring);
    }, INITIAL_DELAY_MS);
    boot.unref?.();
    this.timer = boot;
    logger.info({ intervalMs, initialDelayMs: INITIAL_DELAY_MS }, "[media-scanner] started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getReport(): MediaScanReport {
    return { ...this.report, scanning: this.scanning };
  }

  async scan(): Promise<MediaScanReport> {
    if (this.scanning) return this.getReport();
    this.scanning = true;
    const startMs = Date.now();
    logger.debug("[media-scanner] scan starting");

    let rows: Awaited<ReturnType<typeof queueRepo.loadActive>>;
    try {
      rows = await queueRepo.loadActive();
    } catch (err) {
      logger.warn({ err }, "[media-scanner] loadActive failed — skipping scan");
      this.scanning = false;
      return this.getReport();
    }

    const results: ScanItemResult[] = [];
    for (let i = 0; i < rows.length; i += MAX_CONCURRENT) {
      const batch = rows.slice(i, i + MAX_CONCURRENT);
      const batchResults = await Promise.all(
        batch.map(async (row): Promise<ScanItemResult> => {
          const url = row.hlsMasterUrl ?? row.localVideoUrl ?? null;
          const kind: ScanItemResult["kind"] = row.hlsMasterUrl
            ? "hls"
            : row.localVideoUrl
              ? "mp4"
              : "unknown";
          const prev = this.failureCounts.get(row.id) ?? { count: 0, lastFailedAtMs: null };

          let ok = false;
          let httpStatus: number | null = null;
          if (url) {
            const probe = await probeUrl(url);
            ok = probe.ok;
            httpStatus = probe.status;
          }

          const newCount = ok ? 0 : prev.count + 1;
          const lastFailedAtMs = ok ? prev.lastFailedAtMs : Date.now();
          this.failureCounts.set(row.id, { count: newCount, lastFailedAtMs });

          if (!ok && newCount === 1) {
            logger.warn(
              { itemId: row.id, title: row.title, url, httpStatus },
              "[media-scanner] queue item media unreachable (first detection)",
            );
            playbackAnalytics.record({
              type: "url_blocked",
              itemId: row.id,
              itemTitle: row.title,
              ts: Date.now(),
              meta: { url, httpStatus, source: "media-scanner" },
            });
          } else if (!ok && newCount % 5 === 0) {
            logger.warn(
              { itemId: row.id, title: row.title, consecutiveFailures: newCount, url },
              "[media-scanner] queue item media still unreachable",
            );
          }

          return {
            id: row.id,
            title: row.title,
            url,
            kind,
            reachable: ok,
            httpStatus,
            consecutiveFailures: newCount,
            lastCheckedAtMs: Date.now(),
            lastFailedAtMs,
          };
        }),
      );
      results.push(...batchResults);
    }

    const reachable = results.filter((r) => r.reachable).length;
    this.report = {
      lastScanAtMs: startMs,
      scanDurationMs: Date.now() - startMs,
      totalItems: results.length,
      reachable,
      unreachable: results.length - reachable,
      scanning: false,
      items: results,
    };
    logger.info(
      {
        total: results.length,
        reachable,
        unreachable: results.length - reachable,
        durationMs: this.report.scanDurationMs,
      },
      "[media-scanner] scan complete",
    );
    this.scanning = false;
    return this.report;
  }
}

export const mediaIntegrityScanner = new MediaIntegrityScannerImpl();
