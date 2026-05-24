/**
 * YouTube Live Auto-Override Bridge
 *
 * Subscribes to the existing `ytPoller` (artifacts/api-server/src/modules/
 * youtube-live/youtube-live.poller.ts) and automatically drives the
 * broadcast-v2 orchestrator into an `override` mode whenever the configured
 * YouTube channel goes live. When the live stream ends, the override is
 * stopped and the queue position is restored (resumeQueueOnEnd: true).
 *
 * Why this exists:
 *   - `ytPoller` already detects live state every 60–90 s (dual API+RSS).
 *   - All client surfaces (TV / mobile) already auto-switch their player
 *     UI when `/api/youtube/live/status.isLive === true`.
 *   - However, the server-side v2 orchestrator stayed in `queue` mode, so
 *     analytics, the admin Master Control UI, and any future v2-only client
 *     surface had no idea the channel was on a YouTube takeover. This bridge
 *     closes that loop without duplicating polling or override machinery.
 *
 * Safety guarantees:
 *   - Idempotent. If a YouTube override for the same videoId is already
 *     active, the bridge no-ops.
 *   - Respects manual overrides. If an admin manually started a different
 *     override (HLS/RTMP/different YouTube video), the bridge will not
 *     overwrite or stop it.
 *   - Debounced. State changes within DEBOUNCE_MS are coalesced.
 *   - Fails closed. Any error in start/stopOverride is logged but never
 *     crashes the process; the next poller tick re-evaluates.
 *   - Kill switch. `YOUTUBE_AUTO_OVERRIDE_DISABLE=1` skips installation
 *     entirely (poller still runs for the SSE/REST channels).
 */

import { logger } from "../../infrastructure/logger.js";
import { broadcastOrchestrator } from "../broadcast-v2/engine/broadcast-orchestrator.js";
import { ytPoller, type YtLiveState } from "./youtube-live.poller.js";

const DEBOUNCE_MS = 1500;

interface AutoOverrideStats {
  enabled: boolean;
  installedAt: number | null;
  lastDetectionAt: number | null;
  lastLiveVideoId: string | null;
  lastOverrideId: string | null;
  lastStartAt: number | null;
  lastStopAt: number | null;
  startCount: number;
  stopCount: number;
  lastError: string | null;
  lastErrorAt: number | null;
}

const stats: AutoOverrideStats = {
  enabled: false,
  installedAt: null,
  lastDetectionAt: null,
  lastLiveVideoId: null,
  lastOverrideId: null,
  lastStartAt: null,
  lastStopAt: null,
  startCount: 0,
  stopCount: 0,
  lastError: null,
  lastErrorAt: null,
};

let installed = false;
let unsubscribe: (() => void) | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let lastEvaluatedVideoId: string | null = null;

/**
 * Build the YouTube watch URL the orchestrator/player layer expects.
 * The TV + mobile YouTube embeds resolve this canonical form.
 */
function buildYouTubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function recordError(stage: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  stats.lastError = `${stage}: ${message}`;
  stats.lastErrorAt = Date.now();
  logger.error({ err, stage }, "[yt-auto-override] error");
}

async function evaluate(state: YtLiveState): Promise<void> {
  stats.lastDetectionAt = state.checkedAt;

  // Skip evaluation while the orchestrator is mid-boot or stopped.
  if (!broadcastOrchestrator.isStarted()) return;

  const snap = broadcastOrchestrator.snapshot();
  const currentOverride = snap.override ?? null;

  if (state.isLive && state.videoId) {
    stats.lastLiveVideoId = state.videoId;
    const wantUrl = buildYouTubeUrl(state.videoId);

    // Already overriding to the exact same YouTube stream — no-op.
    if (
      currentOverride &&
      currentOverride.kind === "youtube" &&
      currentOverride.url === wantUrl
    ) {
      return;
    }

    // A different override is active (manual admin action, HLS, RTMP, or a
    // different YouTube video). Respect the operator — never overwrite
    // manual overrides. The admin can stop their override and the next
    // poller tick will pick up the YouTube live.
    if (currentOverride && currentOverride.id !== stats.lastOverrideId) {
      logger.info(
        { activeOverrideId: currentOverride.id, activeKind: currentOverride.kind },
        "[yt-auto-override] live detected but manual override active — deferring",
      );
      return;
    }

    try {
      const ov = await broadcastOrchestrator.startOverride({
        kind: "youtube",
        url: wantUrl,
        title: state.title ?? "Temple TV — Live",
        endsAtMs: null,
        resumeQueueOnEnd: true,
      });
      stats.lastOverrideId = ov.id;
      stats.lastStartAt = Date.now();
      stats.startCount += 1;
      stats.lastError = null;
      logger.info(
        { overrideId: ov.id, videoId: state.videoId, title: state.title },
        "[yt-auto-override] YouTube live detected — override started",
      );
    } catch (err) {
      recordError("startOverride", err);
    }
    return;
  }

  // Not live. Only stop an override WE started; never touch a manual one.
  if (
    currentOverride &&
    stats.lastOverrideId &&
    currentOverride.id === stats.lastOverrideId
  ) {
    try {
      await broadcastOrchestrator.stopOverride();
      stats.lastStopAt = Date.now();
      stats.stopCount += 1;
      stats.lastOverrideId = null;
      stats.lastError = null;
      logger.info(
        { previousVideoId: stats.lastLiveVideoId },
        "[yt-auto-override] YouTube live ended — queue resumed",
      );
    } catch (err) {
      recordError("stopOverride", err);
    }
  }
}

function onPollerState(state: YtLiveState): void {
  // Skip noise-only changes (same videoId, same isLive). This catches the
  // poller emitting identical state during transient errors.
  const sig = `${state.isLive ? "1" : "0"}:${state.videoId ?? ""}`;
  if (sig === lastEvaluatedVideoId) return;

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    // Only mark the signature as "evaluated" AFTER evaluate() returns. If
    // startOverride/stopOverride throws (DB blip, etc.), the next poller
    // tick re-fires evaluation rather than waiting for a real state change
    // — which on a steady-live channel could be hours.
    void evaluate(state)
      .then(() => { lastEvaluatedVideoId = sig; })
      .catch((err) => recordError("evaluate", err));
  }, DEBOUNCE_MS);
  debounceTimer.unref?.();
}

/**
 * Install the auto-override bridge. Idempotent. Safe to call multiple times.
 * The poller is started here so the bridge works without any client SSE
 * connection — required for 24/7 unattended operation.
 */
export function installYouTubeAutoOverride(): void {
  if (installed) return;
  if (process.env["YOUTUBE_AUTO_OVERRIDE_DISABLE"] === "1" ||
      process.env["YOUTUBE_AUTO_OVERRIDE_DISABLE"] === "true") {
    logger.info("[yt-auto-override] disabled via YOUTUBE_AUTO_OVERRIDE_DISABLE");
    return;
  }
  // Channel ID resolution: prefer the explicit env var so operators can
  // point the bridge at a different channel without a code change, but
  // fall back to the canonical Temple TV channel ID baked into the
  // youtube-sync module. Without this fallback the bridge was inactive
  // in every production deploy that hadn't set the env var — exactly the
  // production state observed via /api/broadcast-v2/health
  // (`youtubeAutoOverride.enabled: false`) despite the bridge being shipped.
  //
  // CRITICAL: ytPoller reads `process.env.YOUTUBE_CHANNEL_ID` lazily inside
  // `poll()` / `start()`, so we must MUTATE process.env (not just compute a
  // local variable) for the fallback to take effect. Computing it locally
  // and only logging it — as a prior revision did — left the poller bailing
  // with `no-channel-configured`, so the bridge appeared enabled in stats
  // but never received a live-state event.
  const DEFAULT_TEMPLE_TV_CHANNEL_ID = "UCPFFvkE-KGpR37qJgvYriJg";
  if (!process.env["YOUTUBE_CHANNEL_ID"]) {
    process.env["YOUTUBE_CHANNEL_ID"] = DEFAULT_TEMPLE_TV_CHANNEL_ID;
  }
  const channelId = process.env["YOUTUBE_CHANNEL_ID"];

  installed = true;
  stats.enabled = true;
  stats.installedAt = Date.now();

  // Ensure the poller is running even if no client SSE connects.
  ytPoller.start();

  // subscribe() fires immediately with current state, then on every change.
  unsubscribe = ytPoller.subscribe(onPollerState);

  logger.info(
    { channelId, source: process.env["YOUTUBE_CHANNEL_ID"] ? "env" : "default" },
    "[yt-auto-override] installed — watching YouTube channel for live transitions",
  );
}

export function uninstallYouTubeAutoOverride(): void {
  if (!installed) return;
  installed = false;
  stats.enabled = false;
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  lastEvaluatedVideoId = null;
}

export function getYouTubeAutoOverrideStats(): Readonly<AutoOverrideStats> {
  return stats;
}
