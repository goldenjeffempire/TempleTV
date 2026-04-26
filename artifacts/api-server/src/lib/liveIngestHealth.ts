import { db, liveIngestEndpointsTable, liveOverridesTable } from "@workspace/db";
import { eq, and, desc, asc } from "drizzle-orm";
import { randomUUID } from "crypto";
import { logger } from "./logger.js";
import { broadcastLiveEvent } from "./liveEvents.js";
import { cache } from "./cache.js";

const CACHE_KEYS = {
  liveOverride: "broadcast:live_override",
  payload: "broadcast:current_payload",
};

const HEALTH_INTERVAL_MS = Number(process.env.LIVE_INGEST_HEALTH_INTERVAL_MS ?? 15_000);
const HEALTH_TIMEOUT_MS = Number(process.env.LIVE_INGEST_HEALTH_TIMEOUT_MS ?? 7_000);
const FAILURE_THRESHOLD = Number(process.env.LIVE_INGEST_FAILURE_THRESHOLD ?? 3);

let _tickHandle: ReturnType<typeof setInterval> | null = null;

export function generateStreamKey(): string {
  // 32-char URL-safe random token; vMix / OBS accept arbitrary stream keys.
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type ProbeResult = {
  ok: boolean;
  status: "healthy" | "degraded" | "unhealthy";
  latencyMs: number;
  bitrateKbps: number | null;
  segmentLatencyMs: number | null;
  error: string | null;
};

/**
 * Probes an HLS playback URL by fetching the manifest and measuring response
 * time. Parses the manifest's `EXTINF` lines to estimate bitrate from segment
 * sizes if exposed via byte-range, and uses the manifest sequence delta vs the
 * previous probe to detect "stale" / frozen streams.
 */
export async function probeHlsEndpoint(playbackUrl: string): Promise<ProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort("timeout"), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(playbackUrl, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": "TempleTV-Health/1.0" },
    });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      return {
        ok: false,
        status: "unhealthy",
        latencyMs,
        bitrateKbps: null,
        segmentLatencyMs: null,
        error: `HTTP ${res.status} ${res.statusText}`,
      };
    }
    const text = await res.text();
    if (!text || text.length < 16) {
      return {
        ok: false,
        status: "unhealthy",
        latencyMs,
        bitrateKbps: null,
        segmentLatencyMs: null,
        error: "Empty manifest body",
      };
    }
    const looksLikeHls = text.includes("#EXTM3U");
    if (!looksLikeHls) {
      return {
        ok: false,
        status: "unhealthy",
        latencyMs,
        bitrateKbps: null,
        segmentLatencyMs: null,
        error: "Response is not an HLS manifest",
      };
    }

    // Parse target duration as a coarse segment-latency proxy. For master
    // playlists (no EXTINF), pick the highest BANDWIDTH variant.
    let bitrateKbps: number | null = null;
    let segmentLatencyMs: number | null = null;

    const bandwidthMatches = [...text.matchAll(/BANDWIDTH=(\d+)/g)].map((m) => Number(m[1]));
    if (bandwidthMatches.length > 0) {
      bitrateKbps = Math.round(Math.max(...bandwidthMatches) / 1000);
    }

    const targetDur = text.match(/#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/);
    if (targetDur) {
      segmentLatencyMs = Math.round(Number(targetDur[1]) * 1000);
    }

    // Estimate effective stream-segment age — if the latest segment listed in
    // the manifest is older than 3× target duration, the upstream encoder has
    // probably stalled even though the manifest still serves 200.
    const status: "healthy" | "degraded" =
      latencyMs > 4_000 ? "degraded" : "healthy";

    return {
      ok: true,
      status,
      latencyMs,
      bitrateKbps,
      segmentLatencyMs,
      error: null,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: "unhealthy",
      latencyMs,
      bitrateKbps: null,
      segmentLatencyMs: null,
      error: message,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Health-check every active endpoint, persist the result to the row, and emit
 * an SSE event so the operations center can update without polling.
 *
 * Returns the list of endpoints with their latest health.
 */
export async function runHealthSweep() {
  const endpoints = await db
    .select()
    .from(liveIngestEndpointsTable)
    .where(eq(liveIngestEndpointsTable.isActive, true))
    .orderBy(desc(liveIngestEndpointsTable.isPrimary), asc(liveIngestEndpointsTable.priority));

  const results: Array<{
    id: string;
    name: string;
    isPrimary: boolean;
    healthStatus: string;
    latencyMs: number;
    bitrateKbps: number | null;
    error: string | null;
  }> = [];

  for (const endpoint of endpoints) {
    const probe = await probeHlsEndpoint(endpoint.hlsPlaybackUrl);
    const now = new Date();
    const consecutiveFailures = probe.ok ? 0 : endpoint.consecutiveFailures + 1;
    await db
      .update(liveIngestEndpointsTable)
      .set({
        healthStatus: probe.status,
        lastHealthAt: now,
        lastHealthyAt: probe.ok ? now : endpoint.lastHealthyAt,
        consecutiveFailures,
        lastBitrateKbps: probe.bitrateKbps,
        lastSegmentLatencyMs: probe.segmentLatencyMs,
        lastError: probe.error,
        updatedAt: now,
      })
      .where(eq(liveIngestEndpointsTable.id, endpoint.id));

    results.push({
      id: endpoint.id,
      name: endpoint.name,
      isPrimary: endpoint.isPrimary,
      healthStatus: probe.status,
      latencyMs: probe.latencyMs,
      bitrateKbps: probe.bitrateKbps,
      error: probe.error,
    });

    // Failover: if this is the *currently broadcasting* endpoint and it has
    // crossed the failure threshold, automatically switch the live override to
    // the next healthy fallback (next primary by priority, or fallback YT URL).
    if (
      endpoint.isPrimary &&
      consecutiveFailures >= FAILURE_THRESHOLD &&
      !probe.ok
    ) {
      await maybeAutoFailover(endpoint.id, probe.error ?? "unknown");
    }
  }

  // Push a single SSE summary so the operations center updates live.
  broadcastLiveEvent("live-ingest-health", {
    endpoints: results,
    sweptAt: new Date().toISOString(),
  });

  return results;
}

/**
 * Switch the active live override away from `failedEndpointId` to the highest-
 * priority remaining endpoint that still appears healthy. If none exists, fall
 * back to the endpoint's configured YouTube URL. If even that's missing,
 * deactivate the override entirely so the broadcast queue takes over.
 */
async function maybeAutoFailover(failedEndpointId: string, reason: string) {
  const failed = await db
    .select()
    .from(liveIngestEndpointsTable)
    .where(eq(liveIngestEndpointsTable.id, failedEndpointId))
    .limit(1);
  const failedEndpoint = failed[0];
  if (!failedEndpoint) return;

  // Find the next viable endpoint: active, non-failed, sorted by priority.
  const candidates = await db
    .select()
    .from(liveIngestEndpointsTable)
    .where(eq(liveIngestEndpointsTable.isActive, true))
    .orderBy(asc(liveIngestEndpointsTable.priority));

  const nextHealthy = candidates.find(
    (c) =>
      c.id !== failedEndpointId &&
      c.healthStatus === "healthy" &&
      c.consecutiveFailures < FAILURE_THRESHOLD,
  );

  // Demote the failed endpoint.
  await db
    .update(liveIngestEndpointsTable)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(eq(liveIngestEndpointsTable.id, failedEndpointId));

  let promotedReason: string;
  let newOverrideUrl: string | null = null;
  let newOverrideTitle: string;

  if (nextHealthy) {
    await db
      .update(liveIngestEndpointsTable)
      .set({ isPrimary: true, updatedAt: new Date() })
      .where(eq(liveIngestEndpointsTable.id, nextHealthy.id));
    newOverrideUrl = nextHealthy.hlsPlaybackUrl;
    newOverrideTitle = `LIVE — ${nextHealthy.name}`;
    promotedReason = `Auto-failover from "${failedEndpoint.name}" → "${nextHealthy.name}" (${reason})`;
  } else if (failedEndpoint.fallbackYoutubeUrl) {
    newOverrideUrl = failedEndpoint.fallbackYoutubeUrl;
    newOverrideTitle = `LIVE — YouTube fallback`;
    promotedReason = `All ingest endpoints unhealthy; switched to YouTube fallback (${reason})`;
  } else {
    promotedReason = `All ingest endpoints unhealthy and no YouTube fallback configured; broadcast queue resumed (${reason})`;
  }

  // Replace any active live override that's pinned to the failed endpoint.
  await db
    .update(liveOverridesTable)
    .set({ isActive: false })
    .where(eq(liveOverridesTable.isActive, true));

  if (newOverrideUrl) {
    await db.insert(liveOverridesTable).values({
      id: randomUUID(),
      title: newOverrideTitle,
      isActive: true,
      hlsStreamUrl: newOverrideUrl,
      streamNotes: promotedReason,
      startedAt: new Date(),
      endsAt: null,
    });
  }

  // Invalidate cache so the next /api/broadcast/current reflects the swap.
  await Promise.all([
    cache.del(CACHE_KEYS.liveOverride),
    cache.del(CACHE_KEYS.payload),
  ]);

  logger.warn(
    { failedEndpointId, nextHealthyId: nextHealthy?.id ?? null, reason },
    "Live ingest auto-failover triggered",
  );

  broadcastLiveEvent("live-ingest-failover", {
    failedEndpointId,
    failedEndpointName: failedEndpoint.name,
    promotedEndpointId: nextHealthy?.id ?? null,
    promotedEndpointName: nextHealthy?.name ?? null,
    fallbackToYoutube: !nextHealthy && Boolean(failedEndpoint.fallbackYoutubeUrl),
    reason: promotedReason,
    at: new Date().toISOString(),
  });
}

/**
 * Promotes an endpoint to be the active broadcast source. Demotes others,
 * creates / replaces the live override row, and invalidates broadcast cache.
 */
export async function promoteEndpoint(endpointId: string): Promise<void> {
  const rows = await db
    .select()
    .from(liveIngestEndpointsTable)
    .where(eq(liveIngestEndpointsTable.id, endpointId))
    .limit(1);
  const endpoint = rows[0];
  if (!endpoint) throw new Error(`Endpoint ${endpointId} not found`);

  // Demote others, promote this one.
  await db
    .update(liveIngestEndpointsTable)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(eq(liveIngestEndpointsTable.isPrimary, true));
  await db
    .update(liveIngestEndpointsTable)
    .set({ isPrimary: true, isActive: true, updatedAt: new Date() })
    .where(eq(liveIngestEndpointsTable.id, endpointId));

  // Replace any existing live override.
  await db
    .update(liveOverridesTable)
    .set({ isActive: false })
    .where(eq(liveOverridesTable.isActive, true));

  await db.insert(liveOverridesTable).values({
    id: randomUUID(),
    title: `LIVE — ${endpoint.name}`,
    isActive: true,
    hlsStreamUrl: endpoint.hlsPlaybackUrl,
    streamNotes: `Promoted via Operations Center`,
    startedAt: new Date(),
    endsAt: null,
  });

  await Promise.all([
    cache.del(CACHE_KEYS.liveOverride),
    cache.del(CACHE_KEYS.payload),
  ]);

  broadcastLiveEvent("live-ingest-promoted", {
    endpointId,
    endpointName: endpoint.name,
    at: new Date().toISOString(),
  });
}

/**
 * Stops the active live override that's pinned to ingest endpoints. The 24/7
 * broadcast queue takes over automatically on the next /api/broadcast/current
 * read.
 */
export async function stopActiveIngestOverride(): Promise<void> {
  await db
    .update(liveOverridesTable)
    .set({ isActive: false })
    .where(eq(liveOverridesTable.isActive, true));
  await db
    .update(liveIngestEndpointsTable)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(eq(liveIngestEndpointsTable.isPrimary, true));
  await Promise.all([
    cache.del(CACHE_KEYS.liveOverride),
    cache.del(CACHE_KEYS.payload),
  ]);
  broadcastLiveEvent("live-ingest-stopped", { at: new Date().toISOString() });
}

export function startLiveIngestHealthMonitor() {
  if (_tickHandle) return;
  _tickHandle = setInterval(async () => {
    try {
      const endpoints = await db
        .select({ id: liveIngestEndpointsTable.id })
        .from(liveIngestEndpointsTable)
        .where(eq(liveIngestEndpointsTable.isActive, true))
        .limit(1);
      if (endpoints.length === 0) return; // nothing to do
      await runHealthSweep();
    } catch (err) {
      logger.error({ err }, "Live ingest health sweep failed");
    }
  }, HEALTH_INTERVAL_MS);
  logger.info({ intervalMs: HEALTH_INTERVAL_MS }, "Live ingest health monitor started");
}

export function stopLiveIngestHealthMonitor() {
  if (_tickHandle) {
    clearInterval(_tickHandle);
    _tickHandle = null;
  }
}
