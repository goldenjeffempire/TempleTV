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
} from "../repository/queue.repo.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { playbackAnalytics } from "./playback-analytics.js";
import { runtimeRepo } from "../repository/runtime.repo.js";
import { withHlsToken } from "../../../shared/hls-token.js";

/**
 * Build the X-Internal-Token headers for internal probe requests.
 * Mirrors the orchestrator's internalProbeHeaders() so the scanner
 * benefits from the same HLS-auth bypass.
 */
function internalProbeHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (env.INTERNAL_HLS_BYPASS_SECRET) {
    headers["x-internal-token"] = env.INTERNAL_HLS_BYPASS_SECRET;
  }
  return headers;
}

/**
 * Convert an own-origin HLS URL to http://127.0.0.1:PORT/… for local probing.
 * Identical logic to BroadcastOrchestrator.toLocalhostProbeUrl() — keeps probes
 * on loopback so the HLS auth bypass always fires, avoiding 401 failures when
 * REQUIRE_HLS_TOKEN=true and the probe URL uses the external API_ORIGIN.
 */
function toLocalhostProbeUrl(url: string): string {
  try {
    const u = new URL(url);
    const ownHostnames = [
      env.API_ORIGIN,
      process.env["RENDER_EXTERNAL_URL"],
      process.env["DEV_DOMAIN"],
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

    if (ownHostnames.includes(u.hostname) && /\/api(?:\/v1)?\/hls\//.test(u.pathname)) {
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
const DEFAULT_INTERVAL_MS = 2 * 60_000;
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

/**
 * Extract the first variant playlist URI from a master HLS manifest body.
 * Returns a fully-resolved absolute URL, or null if none can be found.
 *
 * HLS spec: a URI immediately follows each #EXT-X-STREAM-INF line.
 * The URI may be relative (resolved against the master URL's directory)
 * or absolute.
 */
function extractFirstVariantUrl(masterText: string, masterUrl: string): string | null {
  const lines = masterText.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]?.trim() ?? "";
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    // The URI is on the very next non-comment, non-blank line.
    const uri = lines[i + 1]?.trim() ?? "";
    if (!uri || uri.startsWith("#")) continue;
    if (uri.startsWith("http://") || uri.startsWith("https://")) return uri;
    // Resolve relative URI against master playlist's directory.
    try {
      const base = new URL(masterUrl);
      // Strip filename component so relative URIs resolve correctly.
      base.pathname = base.pathname.replace(/\/[^/]*$/, "/");
      return new URL(uri, base).href;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Extract the first segment URI from a variant HLS playlist body.
 * Returns a fully-resolved absolute URL, or null if none can be found.
 * Non-comment, non-blank lines that are not #EXT* tags are segment URIs.
 */
function extractFirstSegmentUrl(variantText: string, variantUrl: string): string | null {
  const lines = variantText.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
    try {
      const base = new URL(variantUrl);
      base.pathname = base.pathname.replace(/\/[^/]*$/, "/");
      return new URL(trimmed, base).href;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * HEAD-probe a single HLS segment to confirm it is accessible.
 * Only a definitive 404 is treated as failure. Timeouts and 5xx responses
 * are ambiguous (CDN / storage transient) and return ok: true to avoid
 * false-positive deactivations of otherwise healthy items.
 */
async function probeFirstSegment(
  url: string,
  intHeaders: Record<string, string>,
): Promise<{ ok: boolean; status: number | null; reason?: string }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "HEAD", signal: ac.signal, headers: { ...intHeaders } });
    clearTimeout(t);
    if (res.status === 404) {
      return { ok: false, status: 404, reason: "segment 404 — deleted or expired from storage" };
    }
    return { ok: true, status: res.status };
  } catch {
    clearTimeout(t);
    return { ok: true, status: null };
  }
}

/**
 * Probe a single HLS variant playlist to confirm it has actual segments (#EXTINF).
 * A valid master playlist can reference a variant that is 404 or empty, causing
 * all clients to stall without the server ever seeing an error on the master URL.
 * This probe catches that failure mode before the item ever reaches air.
 *
 * Additionally probes the first segment URI to catch the case where segments
 * were deleted from storage after the playlist was written (e.g. storage migration,
 * TTL-based cleanup, or a partial-success transcode that wrote the playlist but
 * failed before uploading all segments).
 */
async function probeHlsVariant(
  url: string,
): Promise<{ ok: boolean; status: number | null; reason?: string }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  const intHeaders = internalProbeHeaders();
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: ac.signal,
      headers: { ...intHeaders, Accept: "application/vnd.apple.mpegurl, application/x-mpegurl, */*" },
    });
    clearTimeout(t);
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, status: res.status, reason: `variant HTTP ${res.status}` };
    }
    // Read up to 32 KB — enough for any real variant playlist.
    const HLS_VARIANT_MAX_BYTES = 32 * 1024;
    const reader = res.body?.getReader();
    let text = "";
    if (reader) {
      const decoder = new TextDecoder();
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        received += value.byteLength;
        text += decoder.decode(value, { stream: !done });
        if (received >= HLS_VARIANT_MAX_BYTES) {
          reader.cancel().catch(() => undefined);
          break;
        }
      }
    } else {
      text = await res.text();
    }
    if (!text.includes("#EXTINF")) {
      return {
        ok: false,
        status: res.status,
        reason: "HLS variant playlist contains no #EXTINF segments",
      };
    }
    // Probe the first segment URI to catch the case where segments were deleted
    // from storage after the playlist was written. The variant text check above
    // only confirms the playlist is well-formed; the segments themselves may be
    // 404 (storage migration, TTL cleanup, partial-success transcode).
    // Only definitive 404 is treated as failure to avoid false positives from
    // CDN transients. The segment URL inherits the variant URL's internal token
    // via relative-URL resolution against the already-tokenised variant URL.
    const firstSegUrl = extractFirstSegmentUrl(text, url);
    if (firstSegUrl) {
      const segResult = await probeFirstSegment(withHlsToken(firstSegUrl), intHeaders);
      if (!segResult.ok) {
        return {
          ok: false,
          status: segResult.status,
          reason: `HLS segment unreachable: ${segResult.reason ?? `HTTP ${segResult.status}`}`,
        };
      }
    }
    return { ok: true, status: res.status };
  } catch (err) {
    clearTimeout(t);
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? "variant probe timeout"
        : "variant probe network error";
    return { ok: false, status: null, reason };
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
  const intHeaders = internalProbeHeaders();
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: ac.signal,
      headers: { ...intHeaders, Accept: "application/vnd.apple.mpegurl, application/x-mpegurl, */*" },
    });
    clearTimeout(t);
    if (!res.ok) return { ok: false, status: res.status, reason: `HTTP ${res.status}` };

    // Guard against CDN returning a multi-MB garbage body for a "200 OK"
    // manifest URL. Read at most 64 KB — enough for any real HLS playlist.
    const HLS_MAX_BODY_BYTES = 64 * 1024;
    const contentLength = Number(res.headers.get("content-length") ?? 0);
    if (contentLength > HLS_MAX_BODY_BYTES) {
      return { ok: false, status: res.status, reason: `HLS manifest too large (${contentLength} bytes) — not a valid playlist` };
    }
    const reader = res.body?.getReader();
    let text = "";
    if (reader) {
      const decoder = new TextDecoder();
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        received += value.byteLength;
        text += decoder.decode(value, { stream: !done });
        if (received >= HLS_MAX_BODY_BYTES) {
          reader.cancel().catch(() => undefined);
          break;
        }
      }
    } else {
      text = await res.text();
    }
    if (!text.trimStart().startsWith("#EXTM3U")) {
      return { ok: false, status: res.status, reason: "invalid HLS manifest (missing #EXTM3U header)" };
    }
    const hasStreams = text.includes("#EXT-X-STREAM-INF");
    const hasSegments = text.includes("#EXTINF");
    if (!hasStreams && !hasSegments) {
      return { ok: false, status: res.status, reason: "empty HLS manifest (no streams or segments)" };
    }
    // Deep validation: master playlists (#EXT-X-STREAM-INF present, no #EXTINF)
    // may reference variant playlists that are 404 or empty. The master returns
    // HTTP 200 with valid structure, but every client stalls immediately when it
    // tries to load the variant. Probe the first variant URI to catch this before
    // the item airs — "silent dead air" from broken variant playlists is the most
    // common undetected HLS failure mode.
    if (hasStreams && !hasSegments) {
      const variantUrl = extractFirstVariantUrl(text, url);
      if (variantUrl) {
        const variantProbe = await probeHlsVariant(withHlsToken(toLocalhostProbeUrl(variantUrl)));
        if (!variantProbe.ok) {
          return {
            ok: false,
            status: variantProbe.status,
            reason: `HLS variant unreachable: ${variantProbe.reason ?? "unknown"}`,
          };
        }
      }
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
          const rawUrl = row.hlsMasterUrl ?? row.localVideoUrl ?? null;
          // Normalize relative paths (e.g. /api/hls/…/master.m3u8) to absolute
          // before probing. Relative URLs always fail the HEAD/GET fetch — the
          // scanner must resolve them using the same origin resolution order
          // (API_ORIGIN → RENDER_EXTERNAL_URL → localhost)
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
              // toLocalhostProbeUrl() rewrites own-origin HLS URLs to localhost so
              // the probe always hits this server directly (bypassing REQUIRE_HLS_TOKEN).
              // withHlsToken() adds a token as belt-and-suspenders for multi-node setups.
              // The bad-URL tracking below uses the original `url` (no token/localhost)
              // so token-rotation doesn't affect circuit-breaker de-duplication.
              const localhostUrl = kind === "hls" ? toLocalhostProbeUrl(url) : url;
              const probeTarget = kind === "hls" ? withHlsToken(localhostUrl) : url;
              const probe = kind === "hls"
                ? await probeHlsManifest(probeTarget)
                : await probeUrl(probeTarget);
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

          // ── Source recovery: clear bad-URL block immediately ─────────────
          // When a previously-failing item's source becomes reachable again,
          // remove it from the bad-URL cache right now rather than waiting for
          // the TTL (90 s – 10 min) or suspension TTL (5 min) to expire
          // naturally.  Without this, a 5-min suspension keeps an item off-air
          // even after the CDN / HLS server recovers seconds later.
          //
          // After clearing the block we push `broadcast-queue-updated` so the
          // orchestrator reloads on the next self-heal tick (≤ 30 s) and the
          // recovered item enters rotation immediately.
          if (ok && prev.count > 0 && url && isKnownBadUrl(url)) {
            clearBadUrl(url);
            resetBadUrlSkipCount(row.id);
            recoveredItemIds.add(row.id);
            logger.info(
              { itemId: row.id, title: row.title, url, previousFailures: prev.count },
              "[media-scanner] source recovered — cleared bad-URL block and reset skip counter",
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
