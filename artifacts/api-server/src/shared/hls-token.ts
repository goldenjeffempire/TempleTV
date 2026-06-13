/**
 * Shared HLS authentication token utilities.
 *
 * Used by:
 *  - video-serve.routes.ts  — token issuance + validation for client requests
 *  - media-integrity-scanner.ts — token injection for internal HLS probes
 *  - broadcast-orchestrator.ts  — token injection for probeUrlReachability
 *
 * The token format is `HMAC_HEX:expiresAtMs` where HMAC covers `videoId:expiresAtMs`
 * using HLS_TOKEN_SECRET (or the public fallback when the secret is unset).
 *
 * withHlsToken() is safe to call on any URL — non-HLS or non-localhost URLs are
 * returned unchanged, so callers don't need to special-case their probe paths.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

const TOKEN_ALGO = "sha256";

export function makeHlsToken(videoId: string): { token: string; expiresAt: number } {
  const secret = env.HLS_TOKEN_SECRET ?? "temple-tv-hls-default";
  const expiresAt = Date.now() + env.HLS_TOKEN_TTL_SECONDS * 1000;
  const payload = `${videoId}:${expiresAt}`;
  const token = createHmac(TOKEN_ALGO, secret).update(payload).digest("hex");
  return { token: `${token}:${expiresAt}`, expiresAt };
}

export function validateHlsToken(videoId: string, raw: string): boolean {
  try {
    const parts = raw.split(":");
    if (parts.length !== 2) return false;
    const [token, expiresAtStr] = parts as [string, string];
    const expiresAt = parseInt(expiresAtStr, 10);
    if (isNaN(expiresAt) || Date.now() > expiresAt) return false;
    const secret = env.HLS_TOKEN_SECRET ?? "temple-tv-hls-default";
    const payload = `${videoId}:${expiresAt}`;
    const expected = createHmac(TOKEN_ALGO, secret).update(payload).digest("hex");
    const expectedBuf = Buffer.from(expected, "hex");
    const tokenBuf = Buffer.from(token, "hex");
    if (expectedBuf.length !== tokenBuf.length) return false;
    return timingSafeEqual(expectedBuf, tokenBuf);
  } catch {
    return false;
  }
}

/**
 * Extract the videoId from an internal HLS proxy URL.
 * Handles /api/hls/:videoId/* and /api/v1/hls/:videoId/* patterns.
 * Returns null if the URL is not an internal HLS proxy path.
 */
export function extractHlsVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    const m = /\/(?:api\/v1\/|api\/)?hls\/([^/?#]+)/.exec(u.pathname);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

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
export function withHlsToken(url: string | null | undefined): string {
  if (!url) return url ?? "";
  if (!env.REQUIRE_HLS_TOKEN) return url;
  try {
    const u = new URL(url);
    if (u.searchParams.has("t")) return url;
    const videoId = extractHlsVideoId(url);
    if (!videoId) return url;
    const { token } = makeHlsToken(videoId);
    u.searchParams.set("t", token);
    return u.toString();
  } catch {
    return url;
  }
}
