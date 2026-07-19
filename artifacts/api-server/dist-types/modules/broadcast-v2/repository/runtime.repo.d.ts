import type { V2Mode } from "../domain/types.js";
export interface RuntimeStateRecord {
    channelId: string;
    mode: V2Mode;
    currentItemId: string | null;
    startedAtMs: number | null;
    offsetMs: number;
    activeOverrideId: string | null;
    sequence: number;
    failoverActive: boolean;
    failoverReason: string | null;
}
export interface PersistedBadUrlState {
    /** url → expiresAtMs */
    urlCache: Record<string, number>;
    /** itemId → consecutive failure count */
    skipCounts: Record<string, number>;
}
export interface PersistedYtShuffleState {
    playlist: {
        youtubeId: string;
        title: string;
        duration: string;
    }[];
    playlistIndex: number;
    currentVideoId: string | null;
    currentVideoTitle: string | null;
    /** Wall-clock ms when the current video started airing. */
    currentVideoStartedAtMs: number | null;
    activatedAtMs: number | null;
    /** Wall-clock ms when this state was written — used for staleness checks. */
    savedAtMs: number;
}
export declare const runtimeRepo: {
    load(channelId: string): Promise<RuntimeStateRecord | null>;
    save(rec: RuntimeStateRecord): Promise<void>;
    bumpSequence(channelId: string, next: number): Promise<void>;
    /**
     * Persist the bad-URL blacklist and skip-count maps so they survive a
     * server restart. Writes only the `bad_url_cache` column — does not
     * clobber any other runtime state. Non-throwing; callers fire-and-forget.
     */
    saveBadUrlCache(channelId: string, state: PersistedBadUrlState): Promise<void>;
    /**
     * Load the persisted bad-URL state. Returns null when no row exists or
     * the column is NULL. The caller is responsible for filtering expired
     * urlCache entries by checking `expiresAtMs > Date.now()`.
     */
    loadBadUrlCache(channelId: string): Promise<PersistedBadUrlState | null>;
    /**
     * Persist the media-integrity-scanner's per-item consecutive failure counts
     * so they survive process restarts. Writes only the `scanner_failure_counts`
     * column — does not clobber any other runtime state. Non-throwing; callers
     * fire-and-forget.
     */
    saveFailureCounts(channelId: string, counts: Record<string, {
        count: number;
        lastFailedAtMs: number | null;
    }>): Promise<void>;
    /**
     * Load the persisted scanner failure counts. Returns null when no row exists
     * or the column is NULL (first boot, column just added, or deliberately cleared).
     */
    loadFailureCounts(channelId: string): Promise<Record<string, {
        count: number;
        lastFailedAtMs: number | null;
    }> | null>;
    /**
     * Persist the current broadcast queue as a DB-backed snapshot so it survives
     * process restarts even when the broadcast_queue table is temporarily
     * unreachable. Primary DR source — eliminates the /tmp filesystem dependency.
     * Non-throwing; callers fire-and-forget.
     */
    saveQueueBackup(channelId: string, backup: {
        channelId: string;
        savedAt: number;
        items: unknown[];
    }): Promise<void>;
    /**
     * Load the DB-backed queue snapshot. Returns null when no row exists, the
     * column is NULL, the backup is empty, or the savedAt timestamp is older
     * than 24 hours (pre-signed CDN URLs may have expired).
     */
    loadQueueBackup(channelId: string): Promise<{
        channelId: string;
        savedAt: number;
        items: unknown[];
    } | null>;
    /**
     * Persist the YouTube shuffle-fallback state (shuffled playlist, current
     * playlist index/video, and when the current video started airing) so a
     * restart resumes the SAME video at the correct elapsed position instead
     * of re-shuffling the catalog and starting a random video from 0:00.
     * Non-throwing; callers fire-and-forget.
     */
    saveYtShuffleState(channelId: string, state: PersistedYtShuffleState): Promise<void>;
    /**
     * Load the persisted YouTube shuffle-fallback state. Returns null when no
     * row exists or the column is NULL (first boot, column just added, or the
     * shuffle was never active before the last shutdown).
     */
    loadYtShuffleState(channelId: string): Promise<PersistedYtShuffleState | null>;
    /**
     * Clear the persisted YouTube shuffle-fallback state. Called on deactivate()
     * so a stale "resume video X" record doesn't linger after the shuffle
     * fallback is intentionally stopped (e.g. local content became available).
     */
    clearYtShuffleState(channelId: string): Promise<void>;
};
