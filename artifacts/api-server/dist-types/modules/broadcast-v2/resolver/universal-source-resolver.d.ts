import type { V2Source } from "../domain/types.js";
export interface ResolverInput {
    /** Primary URL (HLS preferred, then MP4, then YouTube id/url). */
    primaryUrl: string | null;
    /** Optional fallback MP4 URL. */
    mp4Url?: string | null;
    /** YouTube video id (11 chars) — used when no other source is present. */
    youtubeId?: string | null;
}
export interface ResolvedSource {
    source: V2Source;
    failoverSource: {
        kind: "hls" | "mp4";
        url: string;
    } | null;
}
export declare class SourceAllowlistError extends Error {
    readonly url: string;
    constructor(url: string);
}
/**
 * Resolve a queue item to a playable v2 source + optional failover.
 *
 * Returns null (never throws) when:
 *   - No candidate URL can be classified (missing/relative/unrecognised URL)
 *   - The primary candidate URL is not in the SSRF allowlist
 *
 * Returning null instead of throwing means callers can use a simple null
 * check rather than a try/catch, and the orchestrator's pre-resolution loop
 * in reloadInner() never needs exception handling around this call.
 */
export declare function resolveSource(input: ResolverInput): ResolvedSource | null;
/**
 * Backward-compatible alias for resolveSource().
 *
 * resolveSource() no longer throws — this wrapper is kept for callers that
 * were written when it did and used resolveSourceSafe() for the no-throw
 * contract. Both functions are now identical in behaviour.
 */
export declare function resolveSourceSafe(input: ResolverInput): ResolvedSource | null;
