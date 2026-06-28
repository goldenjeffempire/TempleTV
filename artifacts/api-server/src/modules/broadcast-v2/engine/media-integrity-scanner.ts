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
import { env } from "../../../config/env.js";
import { registerNamedStore } from "../../../infrastructure/cache.js";
import {
  queueRepo,
  normalizeQueueUrl,
  markBadUrl,
  incrementBadUrlSkipCount,
  autoSuspendQueueItem,
  BAD_URL_SKIP_THRESHOLD,
  clearBadUrl,
  isKnownBadUrl,
  resetBadUrlSkipCount,
  markUrlBadBySource,
  getUrlConfidenceState,
} from "../repository/queue.repo.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { playbackAnalytics } from "./playback-analytics.js";
import { runtimeRepo } from "../repository/runtime.repo.js";
/**
 * Build the X-Internal-Token headers for internal probe requests.
 * Sent with every probe so the /uploads/* handler's optional internal-bypass
 * path can skip external proxy delays when INTERNAL_HLS_BYPASS_SECRET is set.
 */
function internalProbeHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (env.INTERNAL_HLS_BYPASS_SECRET) {
    headers["x-internal-token"] = env.INTERNAL_HLS_BYPASS_SECRET;
  }
  return headers;
}

/**
 * Convert an own-origin HLS or upload URL to http://127.0.0.1:PORT/… for local
 * probing. Mirrors BroadcastOrchestrator.toLocalhostProbeUrl() exactly so
 * HLS *and* locally-uploaded MP4 probes always hit the API via loopback rather
 * than going out through the external Replit / CDN proxy.
 *
 * Why this matters for uploads:
 *   When NODE_ENV=production and REPLIT_DEV_DOMAIN is set, normalizeQueueUrl()
 *   absolutises relative /api/v1/uploads/… paths to
 *   https://<REPLIT_DEV_DOMAIN>/api/v1/uploads/…. Probing that external URL
 *   requires the request to leave the process, traverse Replit's proxy, hit the
 *   Vite dev-server at port 5000, be forwarded to port 8080, and then reach the
 *   upload handler. Any transient proxy hiccup (rate-limit, cold-start, timeout)
 *   causes the probe to fail and the video to be marked bad — even though the
 *   BYTEA blob is sitting untouched in PostgreSQL. Loopback probes are immune to
 *   those external factors.
 */
function toLocalhostProbeUrl(url: string): string {
  try {
    const u = new URL(url);
    const ownHostnames = [
      env.API_ORIGIN,
      process.env["RENDER_EXTERNAL_URL"],
      process.env["DEV_DOMAIN"],
      process.env["REPLIT_DEV_DOMAIN"],
    ]
      .filter(Boolean)
      .map((h) => {
        try {
          return new URL(/^https?:\/\//i.test(h!) ? h! : `https://${h!}`).hostname;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as string[];

    // Match both HLS manifest paths AND locally-uploaded video (uploads) paths.
    // `uploads?` matches the singular `upload` route alias as well as `uploads`.
    if (ownHostnames.includes(u.hostname) && /\/api(?:\/v1)?\/(?:hls|uploads?)\//.test(u.pathname)) {
      u.protocol = "http:";
      u.hostname = "127.0.0.1";
      u.port = String(env.PORT ?? 8080);
      return u.toString();
    }
  } catch {
    /* malformed URL — return as-is */
  }
  return url;
}

// Channel ID used for runtime state persistence — matches the hardcoded "main"
// channel used throughout the broadcast-v2 module.
const CHANNEL_ID = "main";

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
const DEFAULT_INTERVAL_MS = 5 * 60_000;
// INITIAL_DELAY_MS is read from env.MEDIA_SCANNER_INITIAL_DELAY_MS (default 90 s).
// Using a function to defer the env read until after env.ts is fully initialised
// (avoids TDZ issues when the module is imported early in the startup sequence).
const getInitialDelayMs = () => env.MEDIA_SCANNER_INITIAL_DELAY_MS;

/**
 * Consecutive scanner failures before the URL is proactively added to the
 * bad-URL cache (90 s TTL). Complements the stall-report-based escalation
 * path with a server-side circuit breaker for sources whose clients are
 * silently degrading rather than emitting stall reports.
 *
 * Set to 3 (≈ 6 minutes with 2-minute scan interval) — enough to
 * distinguish a transient CDN hiccup from a persistently broken source.
 */
const SCANNER_BAD_URL_THRESHOLD = 5;

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
  const intHeaders = internalProbeHeaders();
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: ac.signal,
      headers: { ...intHeaders, Range: "bytes=0-0" },
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
          headers: { ...intHeaders, Range: "bytes=0-1023" },
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

class MediaIntegrityScannerImpl {
  // Split into two fields so stop() can unconditionally clear both without
  // a fragile instanceof check. `bootTimer` holds the initial-delay setTimeout;
  // `scanInterval` holds the recurring setInterval. Only one is non-null at
  // a time, but clearing null timers via clearTimeout/clearInterval is a no-op.
  private bootTimer: NodeJS.Timeout | null = null;
  private scanInterval: NodeJS.Timeout | null = null;
  private scanning = false;
  private readonly failureCounts = new Map<string, { count: number; lastFailedAtMs: number | null }>();

  /** Returns the current size of the failure-count map.
   *  Used by the memory diagnostics named-store registry. */
  failureCountsSize(): number { return this.failureCounts.size; }
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

    // Restore persisted failure counts from the previous process run so that
    // URLs which were accumulating consecutive failures before a restart
    // continue from where they left off instead of resetting to 0. Without
    // this, a bad URL could dodge auto-suspension indefinitely by triggering
    // restarts before SCANNER_BAD_URL_THRESHOLD consecutive failures accumulate.
    void runtimeRepo
      .loadFailureCounts(CHANNEL_ID)
      .then((saved) => {
        if (!saved) return;
        let restored = 0;
        for (const [id, entry] of Object.entries(saved)) {
          if (entry && typeof entry.count === "number") {
            this.failureCounts.set(id, entry);
            restored++;
          }
        }
        if (restored > 0) {
          logger.info({ restored }, "[media-scanner] restored failure counts from DB");
        }
      })
      .catch((err) => {
        logger.warn({ err }, "[media-scanner] failed to restore failure counts (non-fatal — starting fresh)");
      });

    const scheduleRecurring = (): void => {
      this.scanInterval = setInterval(() => {
        void this.scan().catch((err) =>
          logger.warn({ err }, "[media-scanner] scheduled scan error"),
        );
      }, intervalMs);
      this.scanInterval.unref?.();
    };
    const initialDelayMs = getInitialDelayMs();
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      void this.scan()
        .catch((err) => logger.warn({ err }, "[media-scanner] initial scan error"))
        .finally(scheduleRecurring);
    }, initialDelayMs);
    this.bootTimer.unref?.();
    logger.info({ intervalMs, initialDelayMs }, "[media-scanner] started");
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
    // Tracks items whose bad-URL block was cleared in this scan cycle because
    // their source became reachable again.  Used after the loop to signal the
    // orchestrator to reload so recovered items re-enter rotation immediately.
    const recoveredItemIds = new Set<string>();
    for (let i = 0; i < rows.length; i += MAX_CONCURRENT) {
      const batch = rows.slice(i, i + MAX_CONCURRENT);
      const batchResults = await Promise.all(
        batch.map(async (row): Promise<ScanItemResult> => {
          // MP4-only pipeline: localVideoUrl is the sole playback source.
          const rawUrl = row.localVideoUrl ?? null;
          // Normalize relative paths (e.g. /api/v1/uploads/…) to absolute
          // before probing. Relative URLs always fail the HEAD/GET fetch — the
          // scanner must resolve them using the same origin resolution order
          // (REPLIT_DEV_DOMAIN → API_ORIGIN → RENDER_EXTERNAL_URL → localhost)
          // that the orchestrator's toItem() uses.
          const url = normalizeQueueUrl(rawUrl);
          const kind: ScanItemResult["kind"] = row.localVideoUrl ? "mp4" : "unknown";
          const prev = this.failureCounts.get(row.id) ?? { count: 0, lastFailedAtMs: null };

          let ok = false;
          let httpStatus: number | null = null;
          let failReason: string | undefined;
          if (url) {
            try {
              // toLocalhostProbeUrl() rewrites own-origin /api/v1/uploads/… URLs
              // to http://127.0.0.1:PORT/… so probes hit the API directly via
              // loopback, bypassing the external Replit proxy. This prevents
              // transient proxy timeouts from falsely marking healthy BYTEA blobs
              // as unreachable and triggering bad-URL blocks.
              // Bad-URL tracking uses the original `url` (pre-loopback rewrite)
              // so the cache key matches what the orchestrator resolves.
              const localhostUrl = toLocalhostProbeUrl(url);
              const probe = await probeUrl(localhostUrl);
              ok = probe.ok;
              httpStatus = probe.status;
              failReason = probe.reason;
            } catch (probeErr) {
              // probeUrl should not throw (it catches internally), but guard here
              // so one item's unexpected error can't abort the entire batch via
              // Promise.all rejection.
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

          // ── Source recovery: clear bad-URL block immediately ─────────────
          // When a previously-failing item's source becomes reachable again,
          // remove it from the bad-URL cache right now rather than waiting for
          // the TTL (90 s – 10 min) or suspension TTL (5 min) to expire
          // naturally.  Without this, a 5-min suspension keeps an item off-air
          // even after the CDN / HLS server recovers seconds later.
          //
          // Also clear the confidence source-set so that the orchestrator's
          // prior "gap1" evidence (a single proactive probe failure that hadn't
          // yet reached the blocking threshold) is wiped.  Without this wipe, a
          // recovered URL could reach gap2 on its next proactive probe failure
          // combined with the stale "orchestrator-probe" evidence left behind.
          //
          // After clearing the block we push `broadcast-queue-updated` so the
          // orchestrator reloads on the next self-heal tick (≤ 30 s) and the
          // recovered item enters rotation immediately.
          if (ok && prev.count > 0 && url && (isKnownBadUrl(url) || getUrlConfidenceState(url) !== "healthy")) {
            clearBadUrl(url); // clears bad-URL cache, failure count, AND confidence source-set
            resetBadUrlSkipCount(row.id);
            recoveredItemIds.add(row.id);
            logger.info(
              { itemId: row.id, title: row.title, url, previousFailures: prev.count },
              "[media-scanner] source recovered — cleared bad-URL block, confidence state, and skip counter",
            );
          }

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
          // this source's evidence to the confidence system.  If a second
          // independent source (e.g. orchestrator-probe) has already flagged
          // this URL, the confidence state becomes gap2 and the URL enters the
          // bad-URL cache.  If we are the only source so far, the state is gap1
          // (logged warning only) — a second system must confirm before blocking.
          //
          // After BAD_URL_SKIP_THRESHOLD total increments the item is
          // auto-suspended (5-min in-memory TTL) — same escalation the
          // stall-report path uses, so all paths converge to the same recovery.
          if (!ok && url && newCount === SCANNER_BAD_URL_THRESHOLD) {
            const confState = markUrlBadBySource(url, "scanner");
            logger.warn(
              { itemId: row.id, title: row.title, consecutiveFailures: newCount, url, confState },
              "[media-scanner] URL flagged by scanner after repeated failures",
            );
            // Only increment the skip counter and auto-suspend when the URL is
            // actually blocked (gap2+).  In gap1 the URL is still in rotation —
            // incrementing the skip counter pre-emptively would push the item
            // towards suspension before it is even known to be broken.
            if (confState !== "gap1") {
              const skipCount = incrementBadUrlSkipCount(row.id);
              if (skipCount >= BAD_URL_SKIP_THRESHOLD) {
                autoSuspendQueueItem(row.id, row.title, skipCount, url);
              }
            }
          } else if (!ok && url && newCount > SCANNER_BAD_URL_THRESHOLD) {
            // Re-mark on every scan after threshold to keep the bad-URL cache
            // TTL fresh (the source-set already contains "scanner" from the
            // first threshold hit, so markUrlBadBySource is idempotent here).
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

    // ── Prune stale failureCounts entries ─────────────────────────────────
    // Items that were deactivated or removed from the queue between scans
    // leave orphan entries in failureCounts.  In long-running deployments
    // where items are frequently cycled in/out, these accumulate without
    // bound and slowly inflate RSS.  Pruning is O(N) on the current scan
    // size (typically < a few hundred items) so the cost is negligible.
    const currentScanIds = new Set(results.map((r) => r.id));
    for (const id of this.failureCounts.keys()) {
      if (!currentScanIds.has(id)) {
        this.failureCounts.delete(id);
      }
    }

    // ── Signal orchestrator to reload when sources have recovered ────────────
    // If any blocked items became reachable in this scan, push a bus event
    // so the orchestrator reloads them into rotation without waiting for the
    // next self-heal drift-poll (≤ 30 s) or bad-URL TTL expiry (90 s–5 min).
    if (recoveredItemIds.size > 0) {
      adminEventBus.push("broadcast-queue-updated", {
        reason: "scanner-recovery",
        recoveredItemIds: [...recoveredItemIds],
        count: recoveredItemIds.size,
      });
      logger.info(
        { recoveredCount: recoveredItemIds.size, itemIds: [...recoveredItemIds] },
        "[media-scanner] source(s) recovered — signalling orchestrator to reload",
      );
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

    // Persist failure counts to DB after every scan so they survive process
    // restarts. Fire-and-forget — a failed write is logged but does not affect
    // scan results or the next scan cycle.
    const countsSnapshot = Object.fromEntries(this.failureCounts.entries());
    void runtimeRepo
      .saveFailureCounts(CHANNEL_ID, countsSnapshot)
      .catch((err) => {
        logger.warn({ err }, "[media-scanner] failed to persist failure counts (non-fatal)");
      });

    this.scanning = false;
    return this.report;
  }

  /**
   * Reset all accumulated probe failure counts to zero.
   *
   * Call this after fixing an infrastructure issue (e.g. HLS 401 misconfiguration)
   * so that items which built up consecutive failure counts during the broken period
   * do not hit the auto-suspension threshold on their next successful probe cycle.
   * Also persists the cleared state to DB so the reset survives a process restart.
   */
  clearFailureCounts(): void {
    const cleared = this.failureCounts.size;
    this.failureCounts.clear();
    void runtimeRepo
      .saveFailureCounts(CHANNEL_ID, {})
      .catch((err) => logger.warn({ err }, "[media-scanner] clearFailureCounts: persist failed (non-fatal)"));
    if (cleared > 0) {
      logger.info({ cleared }, "[media-scanner] failure counts cleared (self-heal)");
    }
  }
}

export const mediaIntegrityScanner = new MediaIntegrityScannerImpl();

// Register the failure-count Map with the memory diagnostics registry so it
// appears in GET /admin/diagnostics/memory and is tracked by peak-sampling.
// The Map is properly pruned on every scan cycle (items removed from the
// queue are evicted), so this is purely for observability, not eviction.
registerNamedStore("media-scanner-failure-counts", () => mediaIntegrityScanner.failureCountsSize());

// Register the three-source confidence source-set Map so operators can see
// how many URLs are currently accumulating evidence across independent systems.
// Entries are evicted lazily on writes and on clearBadUrl() calls, so the
// size is bounded.
registerNamedStore("url-bad-source-sets", () => getUrlBadSourceSetsSize());
