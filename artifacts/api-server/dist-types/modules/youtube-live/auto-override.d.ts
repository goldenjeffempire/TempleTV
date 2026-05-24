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
/**
 * Install the auto-override bridge. Idempotent. Safe to call multiple times.
 * The poller is started here so the bridge works without any client SSE
 * connection — required for 24/7 unattended operation.
 */
export declare function installYouTubeAutoOverride(): void;
export declare function uninstallYouTubeAutoOverride(): void;
export declare function getYouTubeAutoOverrideStats(): Readonly<AutoOverrideStats>;
export {};
