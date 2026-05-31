import { spawn } from "node:child_process";
import { logger } from "../../infrastructure/logger.js";
import { db, schema } from "../../infrastructure/db.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { sql } from "drizzle-orm";
import { env } from "../../config/env.js";

/**
 * Per-URL ffprobe duration cache. Keyed by the probe URL; entries survive
 * for the process lifetime (24-h TTL) so we only probe each unique URL once
 * per deployment — not on every 30-second poll cycle.
 *
 * null → probe already attempted but failed (don't retry until TTL expires).
 */
const durationProbeCache = new Map<string, { secs: number | null; at: number }>();
/**
 * Successful probe results are cached for 24 h — the real duration of a
 * server-side video file never changes.
 * Failed probe results (null) are cached for only 5 min so a transient
 * network hiccup or a temporarily-offline CDN doesn't lock the item into
 * a 30-minute placeholder for an entire process lifetime.
 */
const DURATION_PROBE_TTL_SUCCESS_MS = 24 * 60 * 60 * 1000;
const DURATION_PROBE_TTL_FAILURE_MS =  5 * 60 * 1000;
/**
 * Maximum number of entries in durationProbeCache before a sweep runs.
 * Each entry is a ~200-byte object (URL string + number + timestamp), so
 * 2 000 entries ≈ 400 KB — well within budget. The sweep removes all
 * expired entries (not just the oldest) so the map self-heals over time.
 */
const DURATION_PROBE_CACHE_MAX = 2_000;

function pruneExpiredProbeCache(): void {
  if (durationProbeCache.size < DURATION_PROBE_CACHE_MAX) return;
  const now = Date.now();
  for (const [url, entry] of durationProbeCache) {
    const ttl = entry.secs !== null ? DURATION_PROBE_TTL_SUCCESS_MS : DURATION_PROBE_TTL_FAILURE_MS;
    if (now - entry.at >= ttl) durationProbeCache.delete(url);
  }
}
/**
 * Increased from 20 s to 45 s. Remote MP4 files served without faststart
 * (moov atom at the end) require ffprobe to issue two HTTP range requests —
 * one to the start (ftyp/mdat) and one to the end (moov). On a 100+ Mbps
 * link with 200+ ms cross-continental RTT, two range requests + header parse
 * can exceed 20 s for large files (> 1 GB). 45 s gives a comfortable margin
 * while still failing fast enough not to block the entire sync cycle.
 */
const DURATION_PROBE_TIMEOUT_MS = 45_000;

/**
 * Probe the real duration of a remote video file via ffprobe.
 *
 * For non-faststart MP4s, ffprobe downloads only the beginning and end of
 * the file (seeking via Range requests) to locate the moov atom — it does NOT
 * download the full file. Typical probe time for a remote file: 2–8 s on a
 * 100 Mbps link with 100 ms RTT.
 *
 * Returns null if ffprobe is unavailable, the URL is unreachable, or the
 * probe times out. The caller falls back to the upstream-provided value.
 */
async function probeDurationSecs(url: string): Promise<{ secs: number | null; fresh: boolean }> {
  const cached = durationProbeCache.get(url);
  if (cached) {
    const ttl = cached.secs !== null ? DURATION_PROBE_TTL_SUCCESS_MS : DURATION_PROBE_TTL_FAILURE_MS;
    if (Date.now() - cached.at < ttl) return { secs: cached.secs, fresh: false };
  }

  const secs = await new Promise<number | null>((resolve) => {
    let output = "";
    let settled = false;

    const done = (result: number | null): void => {
      if (settled) return;
      settled = true;
      pruneExpiredProbeCache();
      durationProbeCache.set(url, { secs: result, at: Date.now() });
      resolve(result);
    };

    // Keep a reference to the child so the timeout handler can kill it.
    // The ref is populated synchronously by spawn() which is always called
    // before the 45-second timer could ever fire.
    let child: ReturnType<typeof spawn>;
    const timer = setTimeout(() => {
      try { child?.kill("SIGKILL"); } catch { /* already exited */ }
      done(null);
    }, DURATION_PROBE_TIMEOUT_MS);
    try {
      child = spawn("ffprobe", [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        // Increase analyzeduration and probesize for remote files that may
        // have the moov atom far into the file (non-faststart). The values
        // below allow ffprobe to read up to ~50 MB of index data which is
        // more than sufficient to locate the moov atom of any real sermon file.
        "-analyzeduration", "20000000",
        "-probesize", "20000000",
        url,
      ]);
    } catch {
      clearTimeout(timer);
      done(null);
      return;
    }

    child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(output) as { format?: { duration?: string } };
        const raw = parseFloat(parsed?.format?.duration ?? "");
        done(!isNaN(raw) && raw > 0 ? Math.round(raw) : null);
      } catch {
        done(null);
      }
    });
    child.on("error", () => { clearTimeout(timer); done(null); });
  });

  return { secs, fresh: true };
}

/**
 * Cross-environment broadcast queue mirror.
 *
 * Polls an upstream API's public `/api/broadcast/guide` endpoint and
 * upserts every active item into this server's local `broadcast_queue`
 * table. After each sync that produced any insert/update, fires the
 * `broadcast-queue-updated` event on the admin bus — which the v2 bus
 * bridge picks up and translates into `broadcastOrchestrator.reload()`.
 * The net effect: a queue change in production becomes visible on dev
 * within `PROD_SYNC_INTERVAL_MS` (default 30 s) and the dev v2
 * orchestrator promotes the new "current" item automatically, with
 * zero manual intervention.
 *
 * Design notes:
 *   - Read-only against upstream. Never POSTs, never authenticates.
 *     The `/broadcast/guide` route is public and rate-limited upstream.
 *   - Additive on the local DB. Items are upserted by `id`. Items that
 *     disappear from upstream are NOT deleted locally — that protects
 *     hand-curated dev test data and keeps the worst-case behavior to
 *     "you see one extra row that prod no longer has", never data loss.
 *   - URL rewrite: `localVideoUrl` from upstream is a relative path
 *     (`/api/v1/uploads/.../foo.mp4`). We absolutize it against the
 *     upstream base URL so the dev player can fetch the actual bytes
 *     from production's CDN.
 *   - Disabled by default. Activates only when `PROD_SYNC_API_URL` is
 *     set AND `PROD_SYNC_DISABLE` is false. Production should never
 *     set `PROD_SYNC_API_URL`.
 */

interface UpstreamGuideItem {
  id: string;
  youtubeId: string;
  title: string;
  thumbnailUrl: string;
  durationSecs: number;
  localVideoUrl: string | null;
  hlsMasterUrl: string | null;
  videoSource: string;
  startMs?: number;
  endMs?: number;
  isCurrent?: boolean;
}

interface UpstreamGuideResponse {
  items: UpstreamGuideItem[];
}

/**
 * Per-item state remembered across poll cycles within a single process
 * lifetime. Used to skip no-op DB upserts (values unchanged) and to avoid
 * firing `broadcast-queue-updated` when nothing actually changed — the
 * previous behaviour fired on every cycle because `upserted > 0` was always
 * true for 5 items even when all values were identical, triggering an
 * orchestrator reload every 30 s for no reason.
 */
interface ItemPollState {
  isActive: boolean;
  localUrl: string | null;
  hlsUrl: string | null;
  title: string;
  thumbnailUrl: string;
  durationSecs: number;
  videoSource: string;
  sortOrder: number;
}
const prevItemPollState = new Map<string, ItemPollState>();

/**
 * Last upstream-seen timestamp per item id. Used by the ghost-item sweep
 * below: items that disappear from upstream for longer than
 * GHOST_GRACE_MS are deactivated locally so the dev orchestrator does
 * not keep airing entries that prod has already removed. We never DELETE
 * the row — re-appearance instantly re-activates via the upsert path.
 */
const lastSeenAtMs = new Map<string, number>();
const GHOST_GRACE_MS = 10 * 60 * 1000;

let pollTimer: NodeJS.Timeout | null = null;
// Consecutive failure counter — resets to 0 on any successful poll.
// Used to suppress repetitive WARN logs when the upstream is extended-down.
let consecutivePollFailures = 0;
let stats = {
  enabled: false,
  upstreamUrl: null as string | null,
  intervalMs: 0,
  lastPollAtMs: null as number | null,
  lastPollOk: false,
  lastPollError: null as string | null,
  lastUpsertCount: 0,
  lastSkippedUnreachableCount: 0,
  totalPolls: 0,
  totalUpserts: 0,
  consecutiveFailures: 0,
};

/**
 * Concurrency limiter for ffprobe processes spawned by probeDurationSecs.
 *
 * A large sync payload (e.g. 50 items all with durationSecs=1800) would
 * spawn 50 concurrent ffprobe processes if run inside a bare Promise.all.
 * On a resource-constrained server this exhausts PID limits and can OOM
 * the Node process. This semaphore limits concurrent ffprobe invocations
 * to FFPROBE_MAX_CONCURRENT regardless of how many items need probing.
 *
 * Implemented as a simple counter + callback queue — no external deps.
 */
const FFPROBE_MAX_CONCURRENT = 4;
let ffprobeRunning = 0;
const ffprobeWaiters: Array<() => void> = [];

async function withFfprobeSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (ffprobeRunning >= FFPROBE_MAX_CONCURRENT) {
    await new Promise<void>((resolve) => ffprobeWaiters.push(resolve));
  }
  ffprobeRunning++;
  try {
    return await fn();
  } finally {
    ffprobeRunning--;
    const next = ffprobeWaiters.shift();
    if (next) next();
  }
}

/**
 * Per-URL reachability cache. We HEAD-probe each candidate source URL
 * once every PROBE_TTL_MS to avoid hammering the upstream CDN on every
 * 30 s sync cycle. The probe exists because prod has historically
 * served queue items whose underlying upload files have been deleted —
 * mirroring those into dev produces a player with a 404 source and a
 * blank surface, which is the worst possible UX. Filtering at sync
 * time is cheaper than per-projection probes and keeps the
 * orchestrator/repo path completely untouched.
 */
const probeCache = new Map<string, { ok: boolean; checkedAtMs: number }>();
const PROBE_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 4_000;

async function isReachable(url: string): Promise<boolean> {
  const cached = probeCache.get(url);
  if (cached && Date.now() - cached.checkedAtMs < PROBE_TTL_MS) return cached.ok;
  let ok = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);

    if (url.includes(".m3u8")) {
      // HLS manifest: do a full GET and verify the response body is a valid
      // playlist (contains #EXTM3U and at least one stream or segment entry).
      // A HEAD probe returns 200 for stale CDN-cached manifests that contain
      // zero segments — content validation catches this before the item airs
      // and the orchestrator discovers a 404-on-every-segment dead stream.
      const res = await fetch(url, { method: "GET", signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) {
        ok = false;
      } else {
        const text = await res.text();
        ok =
          text.includes("#EXTM3U") &&
          (text.includes("#EXT-X-STREAM-INF") ||
            text.includes("#EXTINF") ||
            text.includes("#EXT-X-TARGETDURATION"));
      }
    } else {
      // Non-HLS: HEAD first; fall back to Range GET for CDNs that reject HEAD.
      let res = await fetch(url, { method: "HEAD", signal: ctrl.signal });
      if (res.status === 405 || res.status === 501) {
        res = await fetch(url, {
          method: "GET",
          headers: { Range: "bytes=0-0" },
          signal: ctrl.signal,
        });
      }
      clearTimeout(t);
      ok = res.ok || res.status === 206;
    }
  } catch {
    ok = false;
  }
  probeCache.set(url, { ok, checkedAtMs: Date.now() });
  return ok;
}

function absolutizeUrl(rawUrl: string | null, base: string): string | null {
  if (!rawUrl) return null;
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
    // Rewrite deprecated URLs to the current canonical upstream host.
    // DB rows may carry HLS/upload URLs pointing to:
    //   • *.onrender.com  — the old Render service hostname (deprecated)
    //   • api.templetv.org.ng — the old API subdomain before domain migration
    // Both are rewritten to PROD_SYNC_API_URL (now admin.templetv.org.ng) so
    // all client surfaces (admin preview, TV, mobile) can load them without
    // hitting CORS errors or defunct hostnames.
    try {
      const parsed = new URL(rawUrl);
      if (
        parsed.hostname.endsWith(".onrender.com") ||
        parsed.hostname === "api.templetv.org.ng"
      ) {
        const upstreamParsed = new URL(base);
        parsed.protocol = upstreamParsed.protocol;
        parsed.hostname = upstreamParsed.hostname;
        parsed.port = upstreamParsed.port;
        return parsed.toString();
      }
    } catch {
      // If either URL is malformed, fall through and return as-is.
    }
    return rawUrl;
  }
  // Relative URL — absolutize against the upstream base
  const cleanBase = base.replace(/\/+$/, "");
  const cleanPath = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
  return `${cleanBase}${cleanPath}`;
}

async function pollOnce(): Promise<void> {
  const upstream = env.PROD_SYNC_API_URL;
  if (!upstream) return;
  stats.totalPolls += 1;
  const url = `${upstream.replace(/\/+$/, "")}/api/broadcast/guide`;
  let payload: UpstreamGuideResponse;
  try {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timeoutId);
    if (!res.ok) {
      throw new Error(`upstream returned HTTP ${res.status}`);
    }
    payload = (await res.json()) as UpstreamGuideResponse;
  } catch (err) {
    consecutivePollFailures++;
    stats.consecutiveFailures = consecutivePollFailures;
    stats.lastPollAtMs = Date.now();
    stats.lastPollOk = false;
    stats.lastPollError = err instanceof Error ? err.message : String(err);
    // Emit WARN on the 1st failure and every 10th thereafter (~5 min at the
    // default 30 s interval). Intermediate failures are logged at DEBUG to
    // prevent log spam when the upstream is extended-down (e.g. maintenance).
    // The `consecutiveFailures` field in getStatus() always reflects the
    // true current count for monitoring dashboards.
    const shouldWarn = consecutivePollFailures === 1 || consecutivePollFailures % 10 === 0;
    if (shouldWarn) {
      logger.warn(
        { err, url, consecutiveFailures: consecutivePollFailures },
        "[prod-sync] upstream poll failed",
      );
    } else {
      logger.debug(
        { url, consecutiveFailures: consecutivePollFailures },
        "[prod-sync] upstream poll failed (suppressed — upstream still down)",
      );
    }
    return;
  }

  // Reset consecutive failure counter and expose in stats on any successful fetch.
  consecutivePollFailures = 0;
  stats.consecutiveFailures = 0;

  const items = Array.isArray(payload?.items) ? payload.items : [];
  // NOTE: we deliberately do NOT early-return on empty payloads. An empty
  // upstream guide is a legitimate "queue cleared" signal that must reach
  // the ghost-sweep loop below — otherwise an admin clearing the prod
  // queue would leave the dev mirror stuck with the last known items
  // until something else mutated upstream.

  // Pass 1 — resolve URLs and probe reachability IN PARALLEL.
  //
  // Previous code probed each item sequentially. With 3 unreachable items and
  // a 4 s timeout each, the first cycle after boot (or after the 5-min probe
  // cache expires) blocked for ~12 s. Running probes concurrently reduces that
  // to a single 4 s window regardless of how many items fail.
  //
  // Prefer HLS for probing: HLS master playlists are typically on a CDN and
  // are far more reachable from dev than raw MP4 uploads on prod-local disk.
  interface Resolved {
    item: UpstreamGuideItem;
    localUrl: string | null;
    hlsUrl: string | null;
    probeUrl: string | null;
    reachable: boolean;
    safeSource: string;
    sortOrder: number;
    probedDurationSecs: number | null;
  }

  const resolved: Resolved[] = await Promise.all(
    items.map(async (item, i) => {
      const localUrl = absolutizeUrl(item.localVideoUrl, upstream);
      const hlsUrl = absolutizeUrl(item.hlsMasterUrl, upstream);
      const probeUrl = hlsUrl ?? localUrl;
      const reachable = probeUrl ? await isReachable(probeUrl) : false;
      const safeSource =
        item.videoSource === "youtube" && !localUrl && !hlsUrl ? "youtube" : "local";

      // Probe the real duration for reachable MP4-only items whose upstream
      // durationSecs is EXACTLY the 1800-second placeholder sentinel. HLS
      // sources self-report duration via EXT-X-TARGETDURATION; youtube items
      // have no local file to probe. Items with a real (non-placeholder)
      // duration — even if short, e.g. a 4-minute sermon clip — are skipped.
      // The result is cached per-URL for 24 h so subsequent poll cycles are
      // instant (no ffprobe spawned after the first successful probe).
      let probedDurationSecs: number | null = null;
      if (reachable && localUrl && !hlsUrl && safeSource === "local" && Number(item.durationSecs) === 1800) {
        const probeResult = await withFfprobeSlot(() => probeDurationSecs(localUrl));
        probedDurationSecs = probeResult.secs;
        // Only log when a fresh ffprobe was actually run — cache hits are silent
        // to avoid "ffprobe resolved…" appearing on every 30 s poll cycle.
        if (probeResult.fresh && probedDurationSecs !== null) {
          logger.info(
            { itemId: item.id, probedDurationSecs, placeholder: item.durationSecs, url: localUrl },
            "[prod-sync] ffprobe resolved real duration for queue item",
          );
        }
      }

      return { item, localUrl, hlsUrl, probeUrl, reachable, safeSource, sortOrder: i, probedDurationSecs };
    }),
  );

  // Determine global reachability: if at least one item is reachable we can
  // safely deactivate the broken ones. If ALL items fail (e.g. entire prod
  // server unreachable, or all uploads are on server-local paths not exposed
  // publicly), keep them all active — an orchestrator auto-skip loop is
  // preferable to a permanently empty queue and a permanently off-air broadcast.
  const anyReachable = resolved.some((r) => r.reachable);

  // Pass 2 — upsert only rows whose values changed since the last cycle, then
  // fire the orchestrator-reload bus event only if any row actually changed.
  //
  // Previous code unconditionally upserted ALL items on every 30 s cycle and
  // fired `broadcast-queue-updated` whenever `upserted > 0 || skippedUnreachable > 0`,
  // which was always true. This triggered an orchestrator reload every 30 s even
  // when nothing had changed — unnecessary DB writes and log spam.
  let upserted = 0;
  let skippedUnreachable = 0;

  for (const { item, localUrl, hlsUrl, probeUrl, reachable, safeSource, sortOrder, probedDurationSecs } of resolved) {
    // YouTube items are library-only and must not enter the local broadcast
    // queue — they trigger media-scanner 204 warnings and dead-air auto-skip
    // loops since the v2 orchestrator's source resolver cannot play YouTube
    // watch URLs. Check `item.videoSource` (the canonical upstream field),
    // not `safeSource` which may resolve to "local" when localVideoUrl
    // happens to contain a YouTube watch URL.
    if (item.videoSource === "youtube") continue;

    if (!reachable) skippedUnreachable += 1;

    // Deactivate unreachable rows only when at least one peer is reachable.
    // When the whole upstream is dark we leave everything active so the queue
    // is not zeroed — the v2 orchestrator's auto-skip + allBlockedSince TTL
    // recovery mechanism handles the temporary outage gracefully.
    const isActive = reachable || !anyReachable;

    const newState: ItemPollState = {
      isActive,
      localUrl: localUrl ?? hlsUrl,
      hlsUrl,
      title: item.title || "Untitled",
      thumbnailUrl: item.thumbnailUrl || "",
      durationSecs: probedDurationSecs ?? Math.max(1, Number(item.durationSecs) || 1800),
      videoSource: safeSource,
      sortOrder,
    };

    const prev = prevItemPollState.get(item.id);
    const changed =
      !prev ||
      prev.isActive !== newState.isActive ||
      prev.localUrl !== newState.localUrl ||
      prev.hlsUrl !== newState.hlsUrl ||
      prev.title !== newState.title ||
      prev.durationSecs !== newState.durationSecs ||
      prev.videoSource !== newState.videoSource ||
      prev.sortOrder !== newState.sortOrder;

    if (!changed) continue;

    try {
      await db
        .insert(schema.broadcastQueueTable)
        .values({
          id: item.id,
          videoId: null,
          youtubeId: item.youtubeId || "",
          title: newState.title,
          thumbnailUrl: newState.thumbnailUrl,
          durationSecs: newState.durationSecs,
          localVideoUrl: newState.localUrl,
          hlsMasterUrl: newState.hlsUrl,
          videoSource: newState.videoSource,
          isActive: newState.isActive,
          sortOrder: newState.sortOrder,
        })
        .onConflictDoUpdate({
          target: schema.broadcastQueueTable.id,
          set: {
            title: newState.title,
            thumbnailUrl: newState.thumbnailUrl,
            durationSecs: newState.durationSecs,
            localVideoUrl: newState.localUrl,
            hlsMasterUrl: newState.hlsUrl,
            videoSource: newState.videoSource,
            // Only deactivate when upstream marks an item unreachable (isActive=false).
            // Never re-activate a row that an admin has manually deactivated —
            // prod-sync owns reachability state, not administrative intent.
            // SQL: if upstream says false → deactivate; otherwise keep current DB value.
            isActive: sql`CASE WHEN excluded.is_active = false THEN false ELSE broadcast_queue.is_active END`,
            sortOrder: newState.sortOrder,
          },
        });
      upserted += 1;
      prevItemPollState.set(item.id, newState);
    } catch (err) {
      logger.warn({ err, itemId: item.id }, "[prod-sync] upsert row failed");
    }

    // Log reachability changes only when the item state actually changed so
    // the logs reflect real transitions, not repeated no-ops.
    if (!reachable) {
      if (anyReachable) {
        logger.info(
          { itemId: item.id, url: probeUrl, isActive },
          "[prod-sync] upstream item URL is unreachable — deactivated (other reachable items exist)",
        );
      } else {
        logger.warn(
          { itemId: item.id, url: probeUrl, isActive, anyReachable },
          "[prod-sync] upstream item URL is unreachable — kept active (no reachable items, orchestrator will auto-skip)",
        );
      }
    }
  }

  // Ghost-item sweep: any id we've seen previously but is absent from this
  // poll's payload gets its lastSeenAtMs frozen; once the gap exceeds the
  // grace window we deactivate the local row so the dev orchestrator drops
  // it from rotation. The row is preserved — re-appearance in any future
  // poll re-activates via the normal upsert path above. This closes the
  // "additive-only over weeks" gap from the May 2026 audit.
  //
  // Safety guard: skip the ghost deactivation pass when all items in the
  // current payload were unreachable (anyReachable=false) and the payload
  // is non-empty. This situation arises when the CDN is entirely down but
  // the upstream API itself is reachable — all item probe URLs fail while
  // the upstream guide fetch succeeds. Running the sweep in this state would
  // deactivate items that prod can't serve right now but which will return
  // once the CDN recovers, producing a total queue wipe. Skipping keeps the
  // local queue intact; the orchestrator's auto-skip loop handles the outage.
  // The sweep resumes on the next cycle where at least one item is reachable.
  const nowSweepMs = Date.now();
  const currentIds = new Set(resolved.map((r) => r.item.id));
  for (const id of currentIds) lastSeenAtMs.set(id, nowSweepMs);
  let ghostDeactivated = 0;
  if (!anyReachable && items.length > 0) {
    logger.debug(
      { itemCount: items.length },
      "[prod-sync] ghost sweep skipped — no upstream items were reachable this cycle (CDN outage guard); queue left intact",
    );
  } else {
    for (const [id, seenAt] of lastSeenAtMs) {
      if (currentIds.has(id)) continue;
      if (nowSweepMs - seenAt < GHOST_GRACE_MS) continue;
      const prev = prevItemPollState.get(id);
      if (!prev || !prev.isActive) {
        // Already deactivated — drop the tracking entry so the map does
        // not grow unbounded for items that prod removed long ago.
        lastSeenAtMs.delete(id);
        continue;
      }
      try {
        await db
          .update(schema.broadcastQueueTable)
          .set({ isActive: false })
          .where(sql`${schema.broadcastQueueTable.id} = ${id}`);
        prevItemPollState.set(id, { ...prev, isActive: false });
        lastSeenAtMs.delete(id);
        ghostDeactivated += 1;
        logger.info(
          { itemId: id, missingForMs: nowSweepMs - seenAt },
          "[prod-sync] item missing upstream beyond grace window — deactivated locally (ghost sweep)",
        );
      } catch (err) {
        logger.warn({ err, itemId: id }, "[prod-sync] ghost deactivation failed");
      }
    }
  }

  stats.lastPollAtMs = Date.now();
  stats.lastPollOk = true;
  stats.lastPollError = null;
  stats.lastUpsertCount = upserted;
  stats.lastSkippedUnreachableCount = skippedUnreachable;
  stats.totalUpserts += upserted;

  if (upserted > 0 || ghostDeactivated > 0) {
    // Tell the v2 orchestrator to reload from the (now-updated) DB only when
    // rows actually changed. The bus bridge in modules/broadcast-v2/index.ts
    // debounces 250 ms so rapid back-to-back mutations coalesce into one
    // reload. Skipping the event when nothing changed eliminates the ~30 s
    // reload storm that occurred when prod-sync repeatedly deactivated the
    // same 3 unreachable items on every poll cycle.
    adminEventBus.push("broadcast-queue-updated", {
      reason: "prod-sync",
      upserted,
      skippedUnreachable,
    });
    logger.info(
      { upserted, skippedUnreachable, totalItems: items.length, url, anyReachable },
      "[prod-sync] sync cycle complete — changes written",
    );
  }
}

export const prodQueueSync = {
  start(): void {
    if (pollTimer) return;
    // Hard production guard — refuse to mirror under any circumstances
    // when NODE_ENV is "production". The env-var gate is a soft guard;
    // this is the belt-and-suspenders backstop. Without it, a production
    // deploy that accidentally inherited PROD_SYNC_API_URL would either
    // self-DDoS (mirror against itself) or pollute prod with a random
    // upstream's queue, depending on the value.
    if (env.NODE_ENV === "production") {
      logger.info("[prod-sync] disabled — NODE_ENV=production");
      stats.enabled = false;
      return;
    }
    if (!env.PROD_SYNC_API_URL || env.PROD_SYNC_DISABLE) {
      stats.enabled = false;
      return;
    }
    stats.enabled = true;
    stats.upstreamUrl = env.PROD_SYNC_API_URL;
    stats.intervalMs = env.PROD_SYNC_INTERVAL_MS;
    logger.info(
      { upstream: env.PROD_SYNC_API_URL, intervalMs: env.PROD_SYNC_INTERVAL_MS },
      "[prod-sync] starting cross-env queue sync",
    );
    // Fire one immediate poll so dev catches up at boot, then schedule.
    void pollOnce();
    pollTimer = setInterval(() => {
      void pollOnce();
    }, env.PROD_SYNC_INTERVAL_MS);
    pollTimer.unref?.();
  },

  stop(): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    stats.enabled = false;
  },

  /** Status for /health. */
  getStatus(): typeof stats {
    return { ...stats };
  },

  /** Force an immediate poll (used by tests / manual trigger). */
  async pollNow(): Promise<void> {
    await pollOnce();
  },
};

