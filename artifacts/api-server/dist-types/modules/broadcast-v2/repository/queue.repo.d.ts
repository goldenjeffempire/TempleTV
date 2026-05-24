import type { V2Item } from "../domain/types.js";
/**
 * Build a signed proxy URL for `externalUrl`. The HMAC-SHA256 signature
 * (keyed with JWT_ACCESS_SECRET) is verified by media-proxy.routes.ts
 * before the proxy fetches anything, preventing unauthorised use of the
 * proxy as an open relay.
 */
export declare function makeMediaProxyUrl(externalUrl: string, ownBase?: string): string;
export declare const BAD_URL_TTL_MS = 90000;
/** Mark a source URL as recently confirmed unreachable. */
export declare function markBadUrl(url: string): void;
/** Clear a URL from the bad cache (e.g. after a queue reload with new sources). */
export declare function clearBadUrl(url: string): void;
/** Flush the entire bad-URL cache (e.g. operator-triggered "clear blocks"). */
export declare function clearAllBadUrls(): void;
/** True if the URL is currently blacklisted and should not be served. */
export declare function isKnownBadUrl(url: string): boolean;
/** Consecutive URL-failure reports required before auto-suspension.
 *  Raised from 3 → 5 to avoid auto-suspending items on transient network
 *  blips or brief storage hiccups that self-resolve within one bad-URL TTL. */
export declare const BAD_URL_SKIP_THRESHOLD = 5;
/** Increment the URL-failure counter for `itemId`. Returns the new count. */
export declare function incrementBadUrlSkipCount(itemId: string): number;
/** Reset the URL-failure counter for `itemId` (call after a successful play). */
export declare function resetBadUrlSkipCount(itemId: string): void;
/**
 * Clear the auto-suspension state for an item that an operator has manually
 * re-enabled.  Resets the skip counter and removes the item from the
 * `recentlySuspended` list so the diagnostics panel stops showing it as
 * suspended and the next proactive probe starts with a clean slate.
 */
export declare function clearSuspended(itemId: string): void;
/** Returns the items auto-suspended in the current server session. */
export declare function getRecentlySuspended(): ReadonlyArray<{
    itemId: string;
    title: string | null;
    failCount: number;
    suspendedAtMs: number;
}>;
/**
 * Deactivate a queue item that has exceeded the bad-URL skip threshold.
 *
 * Sets `is_active = false` in the DB so the item is excluded from every
 * future orchestrator reload until an operator re-enables it manually.
 * Records the suspension in `recentlySuspended` for the /diagnostics
 * endpoint.
 *
 * Non-throwing: DB errors are logged and swallowed so a suspension
 * failure never crashes the broadcast loop.
 */
export declare function autoSuspendQueueItem(itemId: string, title: string | null, failCount: number): Promise<void>;
/**
 * Returns per-item health status for an array of raw queue rows.
 * Normalises each row's URL (relative → absolute) before looking it up in
 * the bad-URL cache so callers don't have to replicate the normalisation.
 * Used by the /source-health admin endpoint.
 *
 * The bad-URL cache is keyed by the URL that the orchestrator actually serves
 * to players — which is the media-proxy URL for external sources (written by
 * `toItem()` via `proxyExternalSource()`). Stall reports mark that proxied URL
 * via `markBadUrl(snapshot.current.source.url)`. To correctly detect blocked
 * items, we must look up BOTH the proxied URL (primary check) and the raw
 * normalized URL (backward compat / local sources).
 */
export declare function getItemsHealth(rows: RawQueueRow[]): Record<string, {
    status: "ok" | "bad";
    badUntilMs: number | null;
}>;
export interface RawQueueRow {
    id: string;
    videoId: string | null;
    youtubeId: string;
    title: string;
    thumbnailUrl: string | null;
    durationSecs: number;
    localVideoUrl: string | null;
    hlsMasterUrl: string | null;
    /** True when faststart.service.ts successfully relocated the moov atom. */
    faststartApplied: boolean;
    /**
     * Raw ffprobe duration string from the joined managed_videos row
     * (e.g. "3600.123"). Preferred over durationSecs when valid — prevents
     * the 1800-second placeholder that is written at upload-time (before
     * ffprobe has run) from causing the server to hold a slot 3× too long.
     */
    videoDuration: string | null;
}
export declare const queueRepo: {
    loadActive(): Promise<RawQueueRow[]>;
    /**
     * Update the duration_secs on a specific broadcast_queue row.
     *
     * Called by:
     *   - naturalItemEnd(): writes back the actual elapsed wall-clock duration
     *     so future loop iterations use the real length instead of the 1800 s
     *     placeholder.
     *   - transcoder dispatcher: writes the ffprobe duration once HLS is ready.
     *   - upload finalize: writes the ffprobe duration after the initial probe.
     *
     * Non-fatal — callers .catch() the returned promise.
     */
    updateDurationSecs(itemId: string, durationSecs: number): Promise<void>;
    /**
     * Update duration_secs for all broadcast_queue rows that reference a given
     * video ID. Used when the transcoder or upload probe provides the real
     * duration after the queue row was already created with a placeholder.
     */
    updateDurationSecsByVideoId(videoId: string, durationSecs: number): Promise<void>;
    /**
     * Project a raw queue row + a wall-clock window into a v2 V2Item.
     *
     * Returns null when:
     *   - The item's primary URL is in the bad-URL cache (player stall report)
     *   - resolveSource() returns null (no classifiable URL or allowlist failure)
     *
     * Never throws — resolveSource() is now null-returning, not throwing.
     * Callers (reloadInner pre-resolution loop, snapshot projection) use a
     * simple null check instead of try/catch.
     */
    toItem(row: RawQueueRow, startsAtMs: number): V2Item | null;
};
