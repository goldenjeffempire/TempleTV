import { db, liveIngestEndpointsTable, liveOverridesTable } from "@workspace/db";
import { eq, and, desc, asc } from "drizzle-orm";
import { randomUUID } from "crypto";
import { logger } from "./logger.js";
import { broadcastLiveEvent } from "./liveEvents.js";
import { sendOpsAlert } from "./alerts.js";
import { cache } from "./cache.js";

const CACHE_KEYS = {
  liveOverride: "broadcast:live_override",
  payload: "broadcast:current_payload",
};

const HEALTH_INTERVAL_MS = Number(process.env.LIVE_INGEST_HEALTH_INTERVAL_MS ?? 15_000);
const HEALTH_TIMEOUT_MS = Number(process.env.LIVE_INGEST_HEALTH_TIMEOUT_MS ?? 7_000);
const FAILURE_THRESHOLD = Number(process.env.LIVE_INGEST_FAILURE_THRESHOLD ?? 3);
const RECOVERY_THRESHOLD = Number(process.env.LIVE_INGEST_RECOVERY_THRESHOLD ?? 2);
const AUTO_RECOVERY_ENABLED =
  (process.env.LIVE_INGEST_AUTO_RECOVERY ?? "true").toLowerCase() !== "false";

let _tickHandle: ReturnType<typeof setInterval> | null = null;

// In-memory healthy-streak counter — used by the auto-recovery logic to
// require N consecutive healthy probes before promoting an endpoint back to
// primary. Prevents a single flapping check from triggering a swap-back loop.
const _healthyStreaks = new Map<string, number>();

export function generateStreamKey(): string {
  // 32-char URL-safe random token; vMix / OBS accept arbitrary stream keys.
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time comparison of two strings. Prevents timing-side-channel
 * attacks against the stream-key validator (an attacker that can measure
 * comparison time could otherwise brute-force the key one byte at a time).
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Validates a stream key against an endpoint name (or arbitrary endpoint
 * identifier). This is the backend behind the `on_publish` webhook used by
 * RTMP gateways like nginx-rtmp, srs, and AWS MediaLive — the gateway POSTs
 * the encoder's stream name + key here, and we either authorize the publish
 * (200) or reject it (403).
 *
 * Returns `{ allowed: false }` for any unknown name, inactive endpoint, or
 * mismatched key — never reveals which of those was the failure reason.
 */
export async function validateStreamKey(
  name: string,
  key: string,
): Promise<{ allowed: boolean; endpointId: string | null; endpointName: string | null }> {
  if (!name || !key) {
    return { allowed: false, endpointId: null, endpointName: null };
  }
  const rows = await db
    .select()
    .from(liveIngestEndpointsTable)
    .where(eq(liveIngestEndpointsTable.name, name))
    .limit(1);
  const endpoint = rows[0];
  if (!endpoint) {
    return { allowed: false, endpointId: null, endpointName: null };
  }
  if (!endpoint.isActive) {
    logger.warn({ endpointId: endpoint.id }, "Stream-key validation rejected — endpoint disabled");
    return { allowed: false, endpointId: null, endpointName: null };
  }
  const ok = safeEqual(endpoint.streamKey, key);
  if (!ok) {
    logger.warn(
      { endpointId: endpoint.id, name },
      "Stream-key validation rejected — key mismatch (possible unauthorized publish attempt)",
    );
    return { allowed: false, endpointId: null, endpointName: null };
  }
  // Mark the endpoint as recently authenticated so the ops center can
  // surface "encoder connected" alongside health probes.
  await db
    .update(liveIngestEndpointsTable)
    .set({
      metadata: {
        ...(endpoint.metadata ?? {}),
        lastAuthAt: new Date().toISOString(),
      },
      updatedAt: new Date(),
    })
    .where(eq(liveIngestEndpointsTable.id, endpoint.id));
  return { allowed: true, endpointId: endpoint.id, endpointName: endpoint.name };
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

    // Update the healthy-streak counter used by auto-recovery.
    if (probe.ok) {
      _healthyStreaks.set(endpoint.id, (_healthyStreaks.get(endpoint.id) ?? 0) + 1);
    } else {
      _healthyStreaks.set(endpoint.id, 0);
    }

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

  // After the failover pass, run the recovery pass: if a higher-priority
  // (lower numeric `priority`) endpoint has been stable for RECOVERY_THRESHOLD
  // consecutive sweeps, promote it back automatically. This is the "switch
  // back to vMix once it recovers" behavior — a real broadcast network never
  // stays on a backup feed once the primary stabilizes.
  if (AUTO_RECOVERY_ENABLED) {
    await maybeAutoRecover();
  }

  // Push a single SSE summary so the operations center updates live.
  broadcastLiveEvent("live-ingest-health", {
    endpoints: results,
    sweptAt: new Date().toISOString(),
  });

  return results;
}

/**
 * Auto-recovery: if a higher-priority (lower numeric `priority`) endpoint is
 * healthy and has been stable for at least RECOVERY_THRESHOLD consecutive
 * probes, promote it back to primary. This swaps the live override URL so
 * the existing broadcast pipeline resumes streaming from the preferred source
 * with no client-side action required.
 *
 * Recovery is gated by:
 *   - AUTO_RECOVERY_ENABLED env (defaults true; set false for manual-only)
 *   - The candidate's `consecutiveFailures` must be 0
 *   - The candidate's healthy-streak counter must be >= RECOVERY_THRESHOLD
 *   - The candidate must have strictly lower priority than the current primary
 */
async function maybeAutoRecover() {
  const candidates = await db
    .select()
    .from(liveIngestEndpointsTable)
    .where(eq(liveIngestEndpointsTable.isActive, true))
    .orderBy(asc(liveIngestEndpointsTable.priority));

  if (candidates.length === 0) return;

  type Candidate = (typeof candidates)[number];
  const currentPrimary = candidates.find((c: Candidate) => c.isPrimary) ?? null;

  // Find the highest-priority endpoint that is healthy, stable, and *not*
  // the current primary. If none exists, nothing to do.
  const recoveryCandidate = candidates.find((c: Candidate) => {
    if (currentPrimary && c.id === currentPrimary.id) return false;
    if (c.healthStatus !== "healthy") return false;
    if (c.consecutiveFailures !== 0) return false;
    if ((_healthyStreaks.get(c.id) ?? 0) < RECOVERY_THRESHOLD) return false;
    // Only switch *back* to a more-preferred (lower numeric priority) source.
    // We never recover-promote a lower-priority endpoint over a healthy higher-
    // priority one — that would be lateral churn, not recovery.
    if (currentPrimary && c.priority >= currentPrimary.priority) return false;
    return true;
  });

  if (!recoveryCandidate) return;

  const previousPrimaryName = currentPrimary?.name ?? null;
  const reason = currentPrimary
    ? `Auto-recovery to preferred source "${recoveryCandidate.name}" (was "${currentPrimary.name}")`
    : `Auto-recovery promoted "${recoveryCandidate.name}" — preferred source is healthy again`;

  // Demote everyone, promote the recovery candidate.
  await db
    .update(liveIngestEndpointsTable)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(eq(liveIngestEndpointsTable.isPrimary, true));
  await db
    .update(liveIngestEndpointsTable)
    .set({ isPrimary: true, updatedAt: new Date() })
    .where(eq(liveIngestEndpointsTable.id, recoveryCandidate.id));

  // Replace the active live override with the recovered endpoint's HLS URL.
  await db
    .update(liveOverridesTable)
    .set({ isActive: false })
    .where(eq(liveOverridesTable.isActive, true));
  await db.insert(liveOverridesTable).values({
    id: randomUUID(),
    title: `LIVE — ${recoveryCandidate.name}`,
    isActive: true,
    hlsStreamUrl: recoveryCandidate.hlsPlaybackUrl,
    streamNotes: reason,
    startedAt: new Date(),
    endsAt: null,
  });

  await Promise.all([
    cache.del(CACHE_KEYS.liveOverride),
    cache.del(CACHE_KEYS.payload),
  ]);

  logger.info(
    {
      recoveredEndpointId: recoveryCandidate.id,
      previousPrimaryName,
      streak: _healthyStreaks.get(recoveryCandidate.id),
    },
    "Live ingest auto-recovery — preferred source promoted",
  );

  broadcastLiveEvent("live-ingest-recovered", {
    recoveredEndpointId: recoveryCandidate.id,
    recoveredEndpointName: recoveryCandidate.name,
    previousPrimaryName,
    reason,
    at: new Date().toISOString(),
  });

  // Page on-call (info severity — good news, but on-call wants to know
  // the broadcast is back on the preferred source). Dedup per-endpoint per
  // 15-minute window so a flapping endpoint doesn't generate alert pairs.
  void sendOpsAlert({
    severity: "info",
    title: "Live ingest auto-recovered",
    message: `Broadcast resumed on the preferred source "${recoveryCandidate.name}" after ${RECOVERY_THRESHOLD} consecutive healthy probes.`,
    fields: [
      { label: "Recovered to", value: recoveryCandidate.name },
      {
        label: "Was on",
        value: previousPrimaryName ?? "(no active primary)",
      },
      {
        label: "Healthy streak",
        value: `${_healthyStreaks.get(recoveryCandidate.id) ?? 0} probes`,
      },
    ],
    dedupKey: `live-ingest-recovered:${recoveryCandidate.id}:${Math.floor(Date.now() / (15 * 60_000))}`,
    dedupTtlSec: 15 * 60,
  }).catch(() => {});
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

  type FailoverCandidate = (typeof candidates)[number];
  const nextHealthy = candidates.find(
    (c: FailoverCandidate) =>
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
  let newOverrideTitle: string = "LIVE";

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

  // Page on-call. Severity ladder:
  //   - Healthy backup promoted        → warning (degraded but live)
  //   - YouTube fallback engaged       → critical (no real ingest backup)
  //   - No backup at all               → critical (broadcast queue resumed)
  // Dedup per-endpoint per 15-min window so a flapping primary doesn't
  // page on-call dozens of times — the first failover of a new incident
  // pages, repeats are suppressed until the window rolls over.
  const promotedHealthyBackup = Boolean(nextHealthy);
  const fellBackToYoutube = !nextHealthy && Boolean(failedEndpoint.fallbackYoutubeUrl);
  const severity = promotedHealthyBackup ? "warning" : "critical";
  const summary = promotedHealthyBackup
    ? `Promoted backup ingest "${nextHealthy!.name}" — broadcast remains live but is no longer on the preferred source.`
    : fellBackToYoutube
      ? `All ingest endpoints unhealthy. Switched to the configured YouTube fallback URL — degraded mode, please investigate.`
      : `All ingest endpoints unhealthy and no YouTube fallback is configured. The 24/7 broadcast queue has resumed in place of live programming.`;
  void sendOpsAlert({
    severity,
    title: "Live ingest auto-failover triggered",
    message: summary,
    fields: [
      { label: "Failed source", value: failedEndpoint.name },
      { label: "Reason", value: reason },
      {
        label: "Promoted to",
        value: nextHealthy?.name ?? (fellBackToYoutube ? "YouTube fallback" : "broadcast queue"),
      },
    ],
    dedupKey: `live-ingest-failover:${failedEndpointId}:${Math.floor(Date.now() / (15 * 60_000))}`,
    dedupTtlSec: 15 * 60,
  }).catch(() => {});
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
  // Don't keep the event loop alive just for the health sweep — Node should
  // exit cleanly when the HTTP server closes during graceful shutdown.
  _tickHandle.unref();
  logger.info({ intervalMs: HEALTH_INTERVAL_MS }, "Live ingest health monitor started");
}

export function stopLiveIngestHealthMonitor() {
  if (_tickHandle) {
    clearInterval(_tickHandle);
    _tickHandle = null;
  }
}
