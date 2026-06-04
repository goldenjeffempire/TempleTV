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
import {
  queueRepo,
  normalizeQueueUrl,
  markBadUrl,
  incrementBadUrlSkipCount,
  autoSuspendQueueItem,
  BAD_URL_SKIP_THRESHOLD,
} from "../repository/queue.repo.js";
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

/**
 * Consecutive scanner failures before the URL is proactively added to the
 * bad-URL cache (90 s TTL). Complements the stall-report-based escalation
 * path with a server-side circuit breaker for sources whose clients are
 * silently degrading rather than emitting stall reports.
 *
 * Set to 3 (≈ 6 minutes with 2-minute scan interval) — enough to
 * distinguish a transient CDN hiccup from a persistently broken source.
 */
const SCANNER_BAD_URL_THRESHOLD = 3;

/**
 * Probe a non-HLS URL for HTTP reachability using HEAD + Range.
 * 200 = full, 206 = partial OK, 416 = range not satisfiable but file exists.
 *
 * GET fallback: some CDNs and object-storage configs block HEAD while allowing
 * GET (returning 405 Method Not Allowed for HEAD). When the server returns 405
 * we fall back to a byte-range GET (bytes=0-1023) so one-way HEAD blocks don't
 * permanently mark valid sources as unreachable.
 * The response body is discarded immediately (getRes.body?.cancel()) to avoid
 * holding the connection open while only reading the headers.
 */
async function probeUrl(url: string): Promise<{ ok: boolean; status: number | null; reason?: string }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: ac.signal,
      headers: { Range: "bytes=0-0" },
    });
    clearTimeout(t);

    if (res.status === 405) {
      // HEAD not supported — fall back to a small GET to confirm the URL is live.
      const getAc = new AbortController();
      const getT = setTimeout(() => getAc.abort(), PROBE_TIMEOUT_MS);
      try {
        const getRes = await fetch(url, {
          method: "GET",
          signal: getAc.signal,
          headers: { Range: "bytes=0-1023" },
        });
        clearTimeout(getT);
        // Discard body immediately — we only need the status code.
        await getRes.body?.cancel().catch(() => {});
        const ok = getRes.status === 200 || getRes.status === 206 || getRes.status === 416;
        return { ok, status: getRes.status, reason: ok ? undefined : `GET fallback: HTTP ${getRes.status}` };
      } catch {
        clearTimeout(getT);
        return { ok: false, status: 405, reason: "HEAD rejected (405) and GET fallback failed" };
      }
    }

    const ok = res.status === 200 || res.status === 206 || res.status === 416;
    return { ok, status: res.status };
  } catch {
    clearTimeout(t);
    return { ok: false, status: null };
  }
}

/**
 * Validate an HLS manifest URL by fetching it and checking content.
 *
 * HEAD probes can return 200 for stale/empty manifests cached by a CDN.
 * A GET + content check ensures the playlist is actually valid:
 *   • Starts with #EXTM3U (required HLS header)
 *   • Contains at least one stream variant (#EXT-X-STREAM-INF) or
 *     segment reference (#EXTINF) — guards against empty master playlists
 *     from ingest sources that are live but not yet streaming.
 */
async function probeHlsManifest(url: string): Promise<{ ok: boolean; status: number | null; reason?: string }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: ac.signal,
      headers: { Accept: "application/vnd.apple.mpegurl, application/x-mpegurl, */*" },
    });
    clearTimeout(t);
    if (!res.ok) return { ok: false, status: res.status, reason: `HTTP ${res.status}` };

    const text = await res.text();
    if (!text.trimStart().startsWith("#EXTM3U")) {
      return { ok: false, status: res.status, reason: "invalid HLS manifest (missing #EXTM3U header)" };
    }
    const hasStreams = text.includes("#EXT-X-STREAM-INF");
    const hasSegments = text.includes("#EXTINF");
    if (!hasStreams && !hasSegments) {
      return { ok: false, status: res.status, reason: "empty HLS manifest (no streams or segments)" };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    clearTimeout(t);
    const reason = err instanceof Error && err.name === "AbortError" ? "timeout" : "network error";
    return { ok: false, status: null, reason };
  }
}

class MediaIntegrityScannerImpl {
  // Split into two fields so stop() can unconditionally clear both without
  // a fragile instanceof check. `bootTimer` holds the initial-delay setTimeout;
  // `scanInterval` holds the recurring setInterval. Only one is non-null at
  // a time, but clearing null timers via clearTimeout/clearInterval is a no-op.
  private bootTimer: NodeJS.Timeout | null = null;
  private scanInterval: NodeJS.Timeout | null = null;
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
    if (this.bootTimer || this.scanInterval) return;
    const scheduleRecurring = (): void => {
      this.scanInterval = setInterval(() => {
        void this.scan().catch((err) =>
          logger.warn({ err }, "[media-scanner] scheduled scan error"),
        );
      }, intervalMs);
      this.scanInterval.unref?.();
    };
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      void this.scan()
        .catch((err) => logger.warn({ err }, "[media-scanner] initial scan error"))
        .finally(scheduleRecurring);
    }, INITIAL_DELAY_MS);
    this.bootTimer.unref?.();
    logger.info({ intervalMs, initialDelayMs: INITIAL_DELAY_MS }, "[media-scanner] started");
  }

  stop(): void {
    // Clear both timers unconditionally — clearTimeout/clearInterval are
    // safe no-ops on null or already-cleared handles, so no instanceof
    // guard is needed. Previously a fragile instanceof check could silently
    // fail, leaking the recurring scan interval across hot reloads.
    clearTimeout(this.bootTimer as NodeJS.Timeout);
    clearInterval(this.scanInterval as NodeJS.Timeout);
    this.bootTimer = null;
    this.scanInterval = null;
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
          const rawUrl = row.hlsMasterUrl ?? row.localVideoUrl ?? null;
          // Normalize relative paths (e.g. /api/hls/…/master.m3u8) to absolute
          // before probing. Relative URLs always fail the HEAD/GET fetch — the
          // scanner must resolve them using the same origin resolution order
          // (API_ORIGIN → RENDER_EXTERNAL_URL → REPLIT_DEV_DOMAIN → localhost)
          // that the orchestrator's toItem() uses.
          const url = normalizeQueueUrl(rawUrl);
          const kind: ScanItemResult["kind"] = row.hlsMasterUrl
            ? "hls"
            : row.localVideoUrl
              ? "mp4"
              : "unknown";
          const prev = this.failureCounts.get(row.id) ?? { count: 0, lastFailedAtMs: null };

          let ok = false;
          let httpStatus: number | null = null;
          let failReason: string | undefined;
          if (url) {
            try {
              // HLS manifests are validated by fetching and parsing content —
              // a HEAD probe can return 200 for stale CDN-cached empty playlists.
              const probe = kind === "hls"
                ? await probeHlsManifest(url)
                : await probeUrl(url);
              ok = probe.ok;
              httpStatus = probe.status;
              failReason = probe.reason;
            } catch (probeErr) {
              // probeHlsManifest / probeUrl should not throw (they catch
              // internally), but guard here so one item's unexpected error
              // can't abort the entire batch via Promise.all rejection.
              ok = false;
              failReason = probeErr instanceof Error ? probeErr.message : String(probeErr);
              logger.warn(
                { itemId: row.id, title: row.title, url, err: failReason },
                "[media-scanner] probe threw unexpectedly — treating as unreachable",
              );
            }
          }

          const newCount = ok ? 0 : prev.count + 1;
          const lastFailedAtMs = ok ? prev.lastFailedAtMs : Date.now();
          this.failureCounts.set(row.id, { count: newCount, lastFailedAtMs });

          if (!ok && newCount === 1) {
            logger.warn(
              { itemId: row.id, title: row.title, url, httpStatus, reason: failReason },
              "[media-scanner] queue item media unreachable (first detection)",
            );
            playbackAnalytics.record({
              type: "url_blocked",
              itemId: row.id,
              itemTitle: row.title,
              ts: Date.now(),
              meta: { url, httpStatus, reason: failReason, source: "media-scanner" },
            });
          } else if (!ok && newCount % 5 === 0) {
            logger.warn(
              { itemId: row.id, title: row.title, consecutiveFailures: newCount, url, reason: failReason },
              "[media-scanner] queue item media still unreachable",
            );
          }

          // ── Proactive bad-URL circuit breaker ─────────────────────────────
          // After SCANNER_BAD_URL_THRESHOLD consecutive scanner failures, add
          // the URL to the bad-URL cache (90 s TTL). On the next orchestrator
          // tick (≤ 2 s) isKnownBadUrl() will skip this item, preventing
          // viewers from continuing to receive a broken source.
          //
          // After BAD_URL_SKIP_THRESHOLD total increments, auto-suspend for
          // 5 minutes — same escalation the stall-report path uses, so both
          // paths converge to the same recovery mechanism.
          if (!ok && url && newCount === SCANNER_BAD_URL_THRESHOLD) {
            markBadUrl(url);
            logger.warn(
              { itemId: row.id, title: row.title, consecutiveFailures: newCount, url },
              "[media-scanner] proactively marking URL bad after repeated scan failures",
            );
            // Increment the per-item skip counter; escalate to suspension if threshold reached.
            const skipCount = incrementBadUrlSkipCount(row.id);
            if (skipCount >= BAD_URL_SKIP_THRESHOLD) {
              autoSuspendQueueItem(row.id, row.title, skipCount, url);
            }
          } else if (!ok && url && newCount > SCANNER_BAD_URL_THRESHOLD) {
            // Re-mark on every scan after threshold to keep TTL fresh.
            markBadUrl(url);
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
