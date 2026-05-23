import type { V2Source } from "../domain/types.js";
import { env } from "../../../config/env.js";

/**
 * URL allowlist: prevents SSRF by refusing to resolve sources to arbitrary
 * hosts. Add CDN/origin hosts here when onboarding new providers.
 */
const ALLOWED_HOST_SUFFIXES: ReadonlyArray<string> = [
  // AWS / CloudFront CDN
  ".cloudfront.net",
  ".amazonaws.com",
  // Replit — dev and production subdomains
  ".replit.app",
  ".replit.dev",
  // Render.com hosting — covers the default *.onrender.com service URLs
  // used before a custom domain is wired up (e.g. temple-tv-api-xxx.onrender.com).
  // Render services that have custom domains will match via the templetv.org.ng
  // entries below; this entry covers the raw Render URLs during initial
  // deployment and in staging/preview environments.
  ".onrender.com",
  // YouTube / Google video delivery
  "youtube.com",
  "youtu.be",
  ".googlevideo.com",
  ".ytimg.com",
  // Vimeo — covers Vimeo hosted streams and their CDN delivery domains
  "vimeo.com",
  ".vimeocdn.com",
  // Bunny CDN — widely used for affordable HLS/MP4 video delivery
  ".b-cdn.net",
  ".bunnycdn.com",
  // Google Cloud Storage — frequently used for video hosting
  "storage.googleapis.com",
  // Cloudflare Stream / R2 / Workers
  ".cloudflare.com",
  ".cloudflarestream.com",
  ".r2.dev",
  // Backblaze B2 + CDN partners
  ".backblazeb2.com",
  // First-party Temple TV origins. The bare domain and its api/cdn
  // subdomains must both match — `endsWith(".templetv.org.ng")`
  // would skip the apex, and a bare `templetv.org.ng` entry is also
  // included so `host === suf` short-circuits before suffix logic.
  "templetv.org.ng",
  ".templetv.org.ng",
  // Sister/related first-party domains
  "jctm.org.ng",
  ".jctm.org.ng",
  // Local development: allow localhost and loopback so locally-uploaded
  // videos resolve when running without a public origin (no Replit/Render
  // env vars, no API_ORIGIN configured). This allowlist gates what URLs the
  // orchestrator sends to player clients in broadcast snapshots — it does NOT
  // control what HTTP requests this server makes itself (no SSRF exposure).
  // A player client that receives a localhost URL simply connects to its own
  // loopback, which is the correct behaviour in a local dev setup where the
  // API server and players run on the same machine.
  "localhost",
  "127.0.0.1",
];

const HLS_EXT = /\.m3u8(?:$|\?|#)/i;
const DASH_EXT = /\.mpd(?:$|\?)/i;
// Expanded to cover all common video container formats served as progressive
// download or via a CDN. The player's <video> element handles all of these
// natively or via MSE — classifying them all as "mp4" is safe because the
// distinction only matters for HLS (needs hls.js) vs progressive MP4.
const MP4_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|ogg|ogv|3gp|ts|mts|m2ts)(?:$|\?|#)/i;
const YT_HOST = /(?:^|\.)(youtube\.com|youtu\.be)$/i;
// Vimeo player/CDN hosts
const VIMEO_HOST = /(?:^|\.)vimeo(?:cdn)?\.com$/i;

export interface ResolverInput {
  /** Primary URL (HLS preferred, then MP4, then YouTube watch URL). */
  primaryUrl: string | null;
  /** Optional fallback MP4 URL. */
  mp4Url?: string | null;
}

export interface ResolvedSource {
  source: V2Source;
  failoverSource: { kind: "hls" | "mp4"; url: string } | null;
}

export class SourceAllowlistError extends Error {
  constructor(public readonly url: string) {
    super(`source URL not in allowlist: ${url}`);
  }
}

// IPv4 literals in private/loopback/link-local/CGNAT/multicast ranges.
// Hostnames that resolve via DNS are not checked here (would require an
// async lookup the resolver path is not set up for); the suffix allowlist
// limits DNS-name surface to known CDN providers that do not let arbitrary
// users register subdomains on the root domains we trust.
const PRIVATE_IPV4_PATTERNS: ReadonlyArray<RegExp> = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 100.64.0.0/10 CGNAT
  /^0\./,
  /^22[4-9]\.|^23\d\./, // multicast 224.0.0.0/4
  /^24\d\.|^25[0-5]\./, // reserved 240.0.0.0/4
];

function isPrivateIp(host: string): boolean {
  // IPv6 loopback / unspecified / link-local / unique-local
  if (host === "::1" || host === "::" || host === "[::1]" || host === "[::]") return true;
  if (/^\[?f[cd][0-9a-f]{2}:/i.test(host)) return true; // fc00::/7
  if (/^\[?fe[89ab][0-9a-f]:/i.test(host)) return true; // fe80::/10
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return PRIVATE_IPV4_PATTERNS.some((r) => r.test(host));
  }
  return false;
}

function isAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  // Reject credentials in URL — common SSRF + credential-leak vector
  // (`http://attacker.com@victim.internal/` style).
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  const isLoopbackHost = host === "localhost" || host === "127.0.0.1";
  // Loopback is permitted in dev/test only. In production the server has
  // outbound fetch sinks (media-integrity-scanner HEAD probes, faststart
  // worker, etc.) — letting a compromised editor enqueue an item whose URL
  // resolves to 127.0.0.1 would let them probe / interact with the server's
  // own admin port from inside the cluster.
  if (isLoopbackHost && env.NODE_ENV === "production") return false;
  if (!isLoopbackHost && isPrivateIp(host)) return false;
  return ALLOWED_HOST_SUFFIXES.some((suf) => host === suf.replace(/^\./, "") || host.endsWith(suf));
}

function classify(url: string): V2Source["kind"] | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (YT_HOST.test(parsed.hostname)) return "youtube";
  // Vimeo player URLs (vimeo.com/123456) are treated like YouTube — the
  // player must handle them via the Vimeo embed API, not a raw <video>.
  // Vimeo CDN URLs (vimeocdn.com) serve actual HLS/MP4 bytes directly.
  if (VIMEO_HOST.test(parsed.hostname) && !parsed.hostname.includes("cdn")) return "youtube";
  // HLS — check path first, then full URL string (handles query-param-only manifests)
  if (HLS_EXT.test(parsed.pathname) || HLS_EXT.test(url)) return "hls";
  if (DASH_EXT.test(parsed.pathname) || DASH_EXT.test(url)) return "dash";
  if (MP4_EXT.test(parsed.pathname) || MP4_EXT.test(url)) return "mp4";
  // No recognized file extension — default to mp4 for known upload paths.
  // Locally-uploaded videos are served at /api/v1/uploads/{key} (and the
  // legacy /api/uploads/{key}) without a .mp4 suffix. The Content-Type is
  // video/mp4 but we cannot probe it here without an HTTP round-trip.
  // Classifying as mp4 is safe: the player's <video> element will load
  // and report an error if the content-type is actually wrong, which
  // triggers the normal RECOVERING path rather than a silent skip.
  if (/\/(?:api\/v1\/)?uploads?\//i.test(parsed.pathname)) return "mp4";
  // HLS streams delivered via a CDN "playlist" path (e.g. /live/playlist,
  // /hls/stream, /index) are common in self-hosted setups. Treat paths that
  // contain these keywords as HLS before falling back to unknown.
  if (/\/(playlist|manifest|master|index|stream)(?:$|\/|\?)/i.test(parsed.pathname)) return "hls";
  return null;
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
export function resolveSource(input: ResolverInput): ResolvedSource | null {
  const candidates: Array<{ url: string; kind: V2Source["kind"] }> = [];

  if (input.primaryUrl) {
    const kind = classify(input.primaryUrl);
    if (kind) candidates.push({ url: input.primaryUrl, kind });
  }
  if (input.mp4Url) {
    const kind = classify(input.mp4Url);
    if (kind === "mp4" || kind === "hls") candidates.push({ url: input.mp4Url, kind });
  }
  if (candidates.length === 0) {
    return null; // no classifiable URL — caller logs and skips this item
  }

  // Prefer HLS > DASH > MP4 > YouTube (explicit watch URL stored in primaryUrl)
  const order: Record<V2Source["kind"], number> = { hls: 0, dash: 1, mp4: 2, youtube: 3 };
  candidates.sort((a, b) => order[a.kind] - order[b.kind]);

  const primary = candidates[0]!;
  if (!isAllowed(primary.url)) {
    return null; // SSRF allowlist rejection — caller logs with URL context
  }

  // Failover: prefer an MP4/HLS different from the primary.
  let failoverSource: ResolvedSource["failoverSource"] = null;
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (c.url === primary.url) continue;
    if (c.kind === "mp4" || c.kind === "hls") {
      if (!isAllowed(c.url)) continue;
      failoverSource = { kind: c.kind, url: c.url };
      break;
    }
  }

  return {
    source: { kind: primary.kind, url: primary.url, expiresAtMs: null },
    failoverSource,
  };
}

/**
 * Backward-compatible alias for resolveSource().
 *
 * resolveSource() no longer throws — this wrapper is kept for callers that
 * were written when it did and used resolveSourceSafe() for the no-throw
 * contract. Both functions are now identical in behaviour.
 */
export function resolveSourceSafe(input: ResolverInput): ResolvedSource | null {
  return resolveSource(input);
}
