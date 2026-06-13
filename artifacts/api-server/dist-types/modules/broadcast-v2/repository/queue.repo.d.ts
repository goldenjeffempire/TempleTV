import type { V2Item } from "../domain/types.js";
export declare function normalizeQueueUrl(raw: string | null | undefined): string | null;
/**
 * Build a signed proxy URL for `externalUrl`. The HMAC-SHA256 signature
 * (keyed with JWT_ACCESS_SECRET) is verified by media-proxy.routes.ts
 * before the proxy fetches anything, preventing unauthorised use of the
 * proxy as an open relay.
 */
export declare function makeMediaProxyUrl(externalUrl: string, ownBase?: string): string;
export declare const BAD_URL_TTL_MS = 90000;
/**
 * How long a repeatedly-failing item is kept out of broadcast rotation.
 * Longer than BAD_URL_TTL_MS so the standard per-snapshot check doesn't
 * clear the block before the suspension window has elapsed.
 * After this TTL the item automatically re-enters rotation — no operator
 * action required, preventing permanent Off Air states from transient failures.
 */
export declare const SUSPENSION_TTL_MS: number;
/** Mark a source URL as recently confirmed unreachable.
 *
 * Uses exponential backoff: each successive call for the same URL doubles
 * the blacklist window (90 s → 3 min → 5 min → 10 min) so genuinely broken
 * sources don't re-enter rotation every 90 s and cause cascading RECOVERING
 * → SKIP_PENDING cycles. The per-URL failure count is reset by clearBadUrl()
 * or clearAllBadUrls() so an operator "clear blocks" action always gives a
 * clean slate.
 */
export declare function markBadUrl(url: string): void;
/**
 * Mark a source URL as temporarily unavailable with a custom TTL.
 *
 * Used by autoEnqueueMissingHls to suppress items whose HLS is absent and
 * are being re-transcoded — those items should not air as raw MP4 (which
 * often fails too) while the transcoding job is in progress. A 10-minute
 * TTL covers worst-case transcoding time on a lightly-loaded server and
 * prevents the RECOVERING → SKIP_PENDING → FATAL cycle for every player.
 *
 * The item auto-recovers once the TTL expires regardless of transcoding
 * completion — the orchestrator will then serve it again. If HLS is still
 * absent at that point, the next autoEnqueueMissingHls call re-suppresses it.
 */
export declare function markBadUrlWithTtl(url: string, ttlMs: number): void;
/** Clear a URL from the bad cache (e.g. after a queue reload with new sources).
 * Also resets the per-URL failure count so the next failure starts fresh at 90 s TTL. */
export declare function clearBadUrl(url: string): void;
/** Flush the entire bad-URL cache (e.g. operator-triggered "clear blocks").
 * Also resets all per-URL failure counts so every URL gets a clean slate. */
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
 * Temporarily suspend a queue item that has exceeded the bad-URL skip threshold.
 *
 * CHANGED from permanent DB deactivation (is_active = false) to time-limited
 * in-memory suspension via extended bad-URL cache TTL. This prevents the
 * permanent Off Air state that occurred when all queue items were auto-suspended
 * and no operator action was available to recover them.
 *
 * Mechanism:
 *  • The item's primary URL is extended in the bad-URL cache to SUSPENSION_TTL_MS
 *    (5 min). The orchestrator's snapshot() already skips bad-URL items, so the
 *    item stays out of rotation for 5 minutes without touching the DB.
 *  • After the TTL expires the item auto-recovers and re-enters rotation.
 *  • The skip counter is reset so the item gets a fresh set of probe attempts.
 *  • The suspension is recorded in recentlySuspended for the /diagnostics endpoint.
 *
 * Non-throwing: errors are logged and swallowed so a suspension failure never
 * crashes the broadcast loop.
 */
export declare function autoSuspendQueueItem(itemId: string, title: string | null, failCount: number, primaryUrl?: string): void;
/**
 * Re-enable all queue items that are currently inactive (is_active = false).
 *
 * Called on server startup to recover items that were permanently deactivated
 * by the old auto-suspension logic (which wrote is_active=false to the DB).
 * The new autoSuspendQueueItem no longer touches the DB, but items suspended by
 * a previous server version need a one-time recovery pass.
 *
 * Returns the number of items re-enabled.
 * Non-throwing: errors are logged and swallowed.
 */
export declare function reEnableAllSuspended(): Promise<number>;
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
export interface ItemHealthEntry {
    status: "ok" | "bad";
    badUntilMs: number | null;
    /** How many consecutive probe/stall failures this URL has accumulated. */
    failureCount: number;
    /** The resolved URL that is blocked (for operator diagnostics). */
    blockedUrl: string | null;
}
export declare function getItemsHealth(rows: RawQueueRow[]): Record<string, ItemHealthEntry>;
/**
 * Returns a snapshot of the bad-URL cache for monitoring and diagnostics.
 * Cleans up expired entries as a side effect.
 */
export declare function getBadUrlStats(): {
    blockedCount: number;
    entries: Array<{
        url: string;
        expiresAtMs: number;
        failureCount: number;
    }>;
};
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
/**
 * Count broadcast_queue rows that are `is_active = true`, regardless of
 * whether the joined managed_videos row satisfies the faststart / transcoding
 * admission policy enforced by `loadActive()`.
 *
 * Used by the dead-air watchdog in the orchestrator to distinguish two
 * otherwise-identical states:
 *   A) "Truly empty" — no active rows in the DB → library-scan backstop
 *      is the right recovery path.
 *   B) "Filtered out" — active rows exist but are excluded by the strict
 *      broadcast policy (faststart_applied=false, status='processing', etc.)
 *      → re-enabling suspended items + triggering faststart recovery is the
 *      right path. Library scan would find nothing new to add, so running
 *      it alone doesn't help.
 *
 * Never throws — callers treat 0 as a safe fallback.
 */
export declare function countActiveRaw(): Promise<number>;
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
/**
 * Serialize the current bad-URL blacklist and skip-count maps to the
 * broadcast_runtime_state row. Non-throwing — errors are debug-logged.
 */
export declare function persistBadUrlCache(channelId: string): Promise<void>;
/**
 * Restore the bad-URL blacklist and skip-count maps from the DB on boot.
 * Expired urlCache entries are dropped. Non-throwing — an
 * isUndefinedColumnError means the schema migration hasn't run yet, which
 * is safe (the cache just starts empty).
 */
export declare function hydrateBadUrlCache(channelId: string): Promise<void>;
