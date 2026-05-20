import { spawn } from "node:child_process";
import { logger } from "../../infrastructure/logger.js";
import { db, schema } from "../../infrastructure/db.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { eq, sql } from "drizzle-orm";
import { env } from "../../config/env.js";

/**
 * Per-URL ffprobe duration cache. Keyed by the probe URL; entries survive
 * for the process lifetime (24-h TTL) so we only probe each unique URL once
 * per deployment — not on every 30-second poll cycle.
 *
 * null → probe already attempted but failed (don't retry until TTL expires).
 */
const durationProbeCache = new Map<string, { secs: number | null; at: number }>();
const DURATION_PROBE_TTL_MS = 24 * 60 * 60 * 1000;
const DURATION_PROBE_TIMEOUT_MS = 20_000;

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
async function probeDurationSecs(url: string): Promise<number | null> {
  const cached = durationProbeCache.get(url);
  if (cached && Date.now() - cached.at < DURATION_PROBE_TTL_MS) return cached.secs;

  return new Promise<number | null>((resolve) => {
    let output = "";
    let settled = false;

    const done = (secs: number | null): void => {
      if (settled) return;
      settled = true;
      durationProbeCache.set(url, { secs, at: Date.now() });
      resolve(secs);
    };

    const timer = setTimeout(() => done(null), DURATION_PROBE_TIMEOUT_MS);

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("ffprobe", [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-analyzeduration", "5000000",
        "-probesize", "5000000",
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

let pollTimer: NodeJS.Timeout | null = null;
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
};

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
    // HEAD first; some origins (e.g. signed-URL CDNs) reject HEAD with
    // 405 — fall back to a Range GET in that case so we still get a
    // truthful answer without downloading the body.
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
  } catch {
    ok = false;
  }
  probeCache.set(url, { ok, checkedAtMs: Date.now() });
  return ok;
}

function absolutizeUrl(rawUrl: string | null, base: string): string | null {
  if (!rawUrl) return null;
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) return rawUrl;
  // base is like "https://api.templetv.org.ng" — strip trailing slash, append
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
    stats.lastPollAtMs = Date.now();
    stats.lastPollOk = false;
    stats.lastPollError = err instanceof Error ? err.message : String(err);
    logger.warn({ err, url }, "[prod-sync] upstream poll failed");
    return;
  }

  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (items.length === 0) {
    stats.lastPollAtMs = Date.now();
    stats.lastPollOk = true;
    stats.lastPollError = null;
    stats.lastUpsertCount = 0;
    return;
  }

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
      // durationSecs is the default 1800-second placeholder. HLS sources
      // self-report duration via EXT-X-TARGETDURATION; youtube items have no
      // local file to probe. The result is cached per-URL for the process
      // lifetime so subsequent poll cycles are instant.
      let probedDurationSecs: number | null = null;
      if (reachable && localUrl && !hlsUrl && safeSource === "local" && Number(item.durationSecs) <= 1800) {
        probedDurationSecs = await probeDurationSecs(localUrl);
        if (probedDurationSecs !== null) {
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
            videoSource: newState.videoSource,
            isActive: newState.isActive,
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

  stats.lastPollAtMs = Date.now();
  stats.lastPollOk = true;
  stats.lastPollError = null;
  stats.lastUpsertCount = upserted;
  stats.lastSkippedUnreachableCount = skippedUnreachable;
  stats.totalUpserts += upserted;

  if (upserted > 0) {
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

// Suppress "imported but unused" warning when sql isn't referenced —
// retained because future scoped deletes will need it (e.g. soft-delete
// rows that disappear from upstream after a configurable grace period).
void sql;
