export declare function makeHlsToken(videoId: string): {
    token: string;
    expiresAt: number;
};
export declare function validateHlsToken(videoId: string, raw: string): boolean;
/**
 * Extract the videoId from an internal HLS proxy URL.
 * Handles /api/hls/:videoId/* and /api/v1/hls/:videoId/* patterns.
 * Returns null if the URL is not an internal HLS proxy path.
 */
export declare function extractHlsVideoId(url: string): string | null;
/**
 * Append a short-lived HMAC auth token to an internal HLS proxy URL.
 *
 * No-op when:
 *  - REQUIRE_HLS_TOKEN is false/unset
 *  - The URL does not contain a recognisable /api/hls/ path
 *  - The URL is already tokenized (has a ?t= param)
 *
 * Safe to call on any URL — non-HLS URLs are returned unchanged.
 * The token is scoped to the videoId so leakage of one token does not
 * grant access to other video assets.
 */
export declare function withHlsToken(url: string | null | undefined): string;
