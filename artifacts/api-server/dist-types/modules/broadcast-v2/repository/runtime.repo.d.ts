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
};
