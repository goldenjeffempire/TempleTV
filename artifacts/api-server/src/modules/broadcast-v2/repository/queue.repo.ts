import { createHmac } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { resolveSource } from "../resolver/universal-source-resolver.js";
import { logger } from "../../../infrastructure/logger.js";
import { env } from "../../../config/env.js";
import type { V2Item, V2Source } from "../domain/types.js";
import { isUndefinedColumnError } from "../../../infrastructure/db-schema-guard.js";
import { runtimeRepo } from "./runtime.repo.js";

/**
 * Normalise a possibly-relative URL into an absolute one the resolver
 * (and the player) can use.
 *
 * Relative paths in the queue come from locally-uploaded videos whose
 * `localVideoUrl` is stored as `/api/v1/uploads/{key}` by the upload
 * pipeline. We must absolutize against THIS server's public origin, not
 * against PROD_SYNC_API_URL — the prod-sync module already rewrites prod
 * items to absolute URLs before inserting them into the local DB, so any
 * remaining relative path belongs to a locally-uploaded file served by
 * this process.
 *
 * Resolution order (first truthy wins):
 *   1. API_ORIGIN        — explicit own-origin, required in production
 *   2. RENDER_EXTERNAL_URL — auto-set by Render; zero-config self-detection
 *   3. Raw path returned — resolver will reject with allowlist error;
 *                          surfaces a clear log instead of a silent null.
 *
 * NOTE: PROD_SYNC_API_URL is intentionally excluded. Using it would
 * proxy local file requests to the upstream production server — broken
 * in dev and a security issue in prod.
 */

// True only when the Node process is explicitly running in production mode.
// In all other environments (development, test, staging) API_ORIGIN must NOT
// be used as "this server's own origin" — in a dev environment API_ORIGIN
// should be unset or point to this server's own public Render/dev URL.
// RENDER_EXTERNAL_URL auto-reflects the dev/staging instance's
// actual public address and should be preferred over API_ORIGIN in non-production.
//
// API_ORIGIN MUST equal this server's own canonical domain in production
// (e.g. https://api.templetv.org.ng). Do NOT set it to the admin SPA domain
// (admin.templetv.org.ng) — that would absolutize upload paths to the SPA,
// which returns HTML for /api/* requests in a standalone SPA deployment.
const IS_PROD_NODE_ENV = process.env.NODE_ENV === "production";

export function normalizeQueueUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    // Rewrite stale *.onrender.com URLs to the current canonical API origin.
    //
    // Background: before a custom domain was configured, locally-uploaded
    // video URLs and HLS master URLs were stored as absolute
    // `https://<service>.onrender.com/api/v1/uploads/…` or
    // `https://<service>.onrender.com/api/v1/hls/…` paths. Once the
    // service moved to api.templetv.org.ng the old Render URL became a
    // dead/sleeping host — the orchestrator probe fails, FSM enters
    // RECOVERING_PRIMARY, and real viewers on TV/mobile/web receive the
    // same dead URL and cannot play.
    //
    // Fix: swap only the origin (protocol + hostname + port) to the
    // current canonical own-base, preserving the full path/query/hash.
    // Uses the same resolution order as the relative-URL path below.
    // This is intentionally idempotent: if the URL is already on the
    // canonical host the `endsWith(".onrender.com")` guard is false and
    // the URL is returned unchanged.
    try {
      const parsed = new URL(raw);
      if (parsed.hostname.endsWith(".onrender.com")) {
        const ownPublicBase = (
          (IS_PROD_NODE_ENV ? env.API_ORIGIN : undefined) ??
          process.env["RENDER_EXTERNAL_URL"]
        )?.replace(/\/+$/, "");
        if (ownPublicBase) {
          const absBase = /^https?:\/\//i.test(ownPublicBase)
            ? ownPublicBase
            : `https://${ownPublicBase}`;
          const baseParsed = new URL(absBase);
          parsed.protocol = baseParsed.protocol;
          parsed.hostname = baseParsed.hostname;
          parsed.port = baseParsed.port;
          logger.info(
            { from: new URL(raw).hostname, to: baseParsed.hostname, path: parsed.pathname },
            "[broadcast-v2] rewrote stale onrender.com URL to canonical API origin",
          );
          return parsed.toString();
        }
      }
    } catch { /* malformed URL — fall through and return as-is */ }

    // Rewrite stale *.replit.app / *.repl.co URLs when this server has
    // migrated to a custom domain (e.g. api.templetv.org.ng). Follows
    // the same pattern as the onrender.com rewrite: swap the origin,
    // preserve path/query/hash. The guard `!ownPublicBase.includes(".replit.app")`
    // prevents a self-rewrite in dev environments where the server IS
    // still on a Replit subdomain — rewriting to itself is a no-op but
    // the log noise would be confusing.
    try {
      const parsedReplit = new URL(raw);
      if (
        parsedReplit.hostname.endsWith(".replit.app") ||
        parsedReplit.hostname.endsWith(".repl.co")
      ) {
        const ownPublicBase = (
          (IS_PROD_NODE_ENV ? env.API_ORIGIN : undefined) ??
          process.env["RENDER_EXTERNAL_URL"]
        )?.replace(/\/+$/, "");
        if (
          ownPublicBase &&
          !ownPublicBase.includes(".replit.app") &&
          !ownPublicBase.includes(".repl.co")
        ) {
          const absBase = /^https?:\/\//i.test(ownPublicBase) ? ownPublicBase : `https://${ownPublicBase}`;
          const baseParsed = new URL(absBase);
          const fromHost = parsedReplit.hostname;
          parsedReplit.protocol = baseParsed.protocol;
          parsedReplit.hostname = baseParsed.hostname;
          parsedReplit.port = baseParsed.port;
          logger.info(
            { from: fromHost, to: baseParsed.hostname, path: parsedReplit.pathname },
            "[broadcast-v2] rewrote stale replit.app/repl.co URL to canonical API origin",
          );
          return parsedReplit.toString();
        }
      }
    } catch { /* malformed — fall through */ }

    return raw;
  }
  // Resolution order (first truthy wins):
  //   1. API_ORIGIN            — explicit own-origin; ONLY used in production.
  //                              Must equal THIS server's canonical URL
  //                              (e.g. https://api.templetv.org.ng). Do NOT set
  //                              it to an admin SPA domain or a remote server URL.
  //   2. RENDER_EXTERNAL_URL   — Render auto-sets this to the service's public HTTPS URL;
  //                              gives zero-config self-origin detection on Render deploys.
  //   3. DEV_DOMAIN            — optional generic override for any dev/tunnel environment
  //                              (e.g. ngrok, localtunnel, Cloudflare Tunnel). Set to the
  //                              public HTTPS hostname without protocol or trailing slash.
  //   4. http://localhost:PORT — Pure local dev fallback (no public origin configured).
  //                              localhost is now in the SSRF allowlist so the resolver
  //                              accepts these URLs and the player can load uploads from
  //                              the dev server running on the same machine.
  const devDomain = process.env["DEV_DOMAIN"];
  const publicBase = (
    (IS_PROD_NODE_ENV ? env.API_ORIGIN : undefined) ??
    process.env["RENDER_EXTERNAL_URL"] ??
    (devDomain ? `https://${devDomain}` : undefined)
  )?.replace(/\/+$/, "");
  const base = publicBase ?? `http://localhost:${env.PORT ?? 5000}`;
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  // Preserve the protocol of the base (http:// for localhost, https:// otherwise).
  const absBase = /^https?:\/\//i.test(base) ? base : `https://${base}`;
  return `${absBase.replace(/\/+$/, "")}${path}`;
}

// ── Media proxy helpers ────────────────────────────────────────────────────
//
// When a queue item's source URL is on a different origin from this server
// (e.g. prod-sync items from api.templetv.org.ng in a dev environment), the browser blocks the
// media load because the remote server returns `Cross-Origin-Resource-Policy:
// same-origin`. We rewrite those external MP4 URLs to go through our own
// /api/v1/media-proxy endpoint which strips the restriction and serves with
// CORP: cross-origin. HLS manifests are left as-is because segment URLs
// embedded in the manifest would still be cross-origin even if the manifest
// itself were proxied — that case is handled separately if/when HLS sources
// from external origins are introduced.

/**
 * Returns this server's own absolute public base URL, used to:
 *   1. Determine whether a queue item's source URL is "same-origin" (no proxy needed).
 *   2. Construct the absolute media-proxy URL emitted in broadcast snapshots.
 *
 * Resolution order — identical to normalizeQueueUrl but with the same
 * production-only guard on API_ORIGIN:
 *   1. API_ORIGIN          — ONLY in production. Must be THIS server's own
 *                            canonical URL (e.g. https://api.templetv.org.ng).
 *                            Do NOT set API_ORIGIN to an admin SPA domain or a
 *                            remote server URL in dev — use the options below.
 *   2. RENDER_EXTERNAL_URL — zero-config Render self-detection
 *   3. DEV_DOMAIN          — generic dev/tunnel public hostname (no protocol)
 *   4. http://localhost:PORT fallback
 */
function getOwnBase(): string {
  const devDomain = process.env["DEV_DOMAIN"];
  const publicBase = (
    (IS_PROD_NODE_ENV ? env.API_ORIGIN : undefined) ??
    process.env["RENDER_EXTERNAL_URL"] ??
    (devDomain ? `https://${devDomain}` : undefined)
  )?.replace(/\/+$/, "");
  const base = publicBase ?? `http://localhost:${env.PORT ?? 5000}`;
  return /^https?:\/\//i.test(base) ? base : `https://${base}`;
}

/**
 * Returns true when `url` is hosted on this server (same hostname + port).
 * Same-origin sources are served directly and don't need the proxy.
 */
function isOwnOriginUrl(url: string, ownBase: string): boolean {
  try {
    const u = new URL(url);
    const b = new URL(ownBase);
    const normalPort = (parsed: URL) =>
      parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return u.hostname === b.hostname && normalPort(u) === normalPort(b);
  } catch {
    return false;
  }
}

/**
 * Build a signed proxy URL for `externalUrl`. The HMAC-SHA256 signature
 * (keyed with JWT_ACCESS_SECRET) is verified by media-proxy.routes.ts
 * before the proxy fetches anything, preventing unauthorised use of the
 * proxy as an open relay.
 */
export function makeMediaProxyUrl(externalUrl: string, ownBase?: string): string {
  const base = ownBase ?? getOwnBase();
  const sig = createHmac("sha256", env.JWT_ACCESS_SECRET)
    .update(externalUrl)
    .digest("hex");
  return `${base}/api/v1/media-proxy?url=${encodeURIComponent(externalUrl)}&sig=${sig}`;
}

/**
 * Rewrite an external MP4/dash source URL through the media proxy.
 * YouTube watch URLs and HLS sources are returned unchanged.
 * Same-origin sources are returned unchanged (no proxy needed).
 */
function proxyExternalSource<T extends Pick<V2Source, "kind" | "url">>(
  source: T,
  ownBase: string,
): T {
  // YouTube watch URLs are handled by the native YouTube IFrame player — never proxy.
  if (source.kind === "youtube") return source;
  // HLS: rewriting the manifest is not enough because embedded segment URLs
  // would still be fetched from the external origin. Leave HLS unchanged;
  // the SSRF allowlist already gates which HLS origins reach the player.
  if (source.kind === "hls") return source;
  // Already on this server — no proxy needed.
  if (isOwnOriginUrl(source.url, ownBase)) return source;
  // External MP4/DASH — rewrite to proxy.
  return { ...source, url: makeMediaProxyUrl(source.url, ownBase) };
}

// ── URL bad-cache ──────────────────────────────────────────────────────────
//
// When a player reports a stall (the active source failed to load after all
// local retries), the /report-stall REST handler calls `markBadUrl()` to
// blacklist that URL for BAD_URL_TTL_MS. `toItem()` checks the cache before
// calling resolveSource() — if the primary URL is blacklisted it returns null
// immediately, causing the orchestrator's snapshot() to skip the item and
// advance to the next one without waiting for the player to exhaust its own
// retry budget again.
//
// Effect: a single stall report from ANY player client immediately removes the
// broken source from rotation for 2 minutes. If ALL items share the same bad
// URL, the orchestrator presents null current → FSM → SYNCING → overlay shows
// "Off air" instead of an infinite "Retrying source…" loop.
//
// The cache is process-local (no Redis) — that is intentional. Each API
// process independently learns about bad URLs and the 45-second TTL is short
// enough that a single-server deployment recovers automatically. Multi-process
// deployments (Render, Kubernetes) may have a brief window where a second
// process re-serves the same bad item once before its own stall report arrives,
// which is acceptable. Persistent blacklisting belongs in the DB layer and is
// future work.

export const BAD_URL_TTL_MS = 90_000; // 90 seconds — base TTL for persistent failures

// ── Exponential backoff TTL schedule ────────────────────────────────────────
// First failure: 20 s — brief window that allows a transient stall (network
// blip, CDN cold-start, brief 503) to self-recover before the orchestrator
// forward-scans past the item.  If the URL fails again within those 20 s the
// count becomes 2 → 3-minute block, making repeated failures progressively
// more penalised.
//
// URLs that repeatedly fail get exponentially longer blacklist windows so a
// genuinely broken source doesn't flood the orchestrator's snapshot() logic
// with fruitless retries. After 4+ failures the URL stays out of rotation for
// 10 minutes — long enough to expire while the transcoder produces a
// replacement HLS stream, or for an operator to swap the source.
//
// The per-URL failure counts live in `badUrlFailureCounts` (separate from
// badUrlSkipCounts which is per-itemId). Counts are cleared on clearBadUrl()
// and clearAllBadUrls() so a manual operator clear gives a clean slate.
function badUrlTtlForCount(count: number): number {
  if (count <= 1) return 20_000;   // 20 s — first failure: brief recovery window
  if (count === 2) return 180_000; // 3 min — second failure: persistent problem
  if (count === 3) return 300_000; // 5 min
  return 600_000;                   // 10 min (4+)
}

// url → consecutive failure count (for TTL escalation)
const badUrlFailureCounts = new Map<string, number>();

/**
 * How long a repeatedly-failing item is kept out of broadcast rotation.
 * Longer than BAD_URL_TTL_MS so the standard per-snapshot check doesn't
 * clear the block before the suspension window has elapsed.
 * After this TTL the item automatically re-enters rotation — no operator
 * action required, preventing permanent Off Air states from transient failures.
 */
export const SUSPENSION_TTL_MS = 5 * 60_000; // 5 minutes

// url → expiresAtMs
const badUrlCache = new Map<string, number>();

/** Returns the current number of URLs in the bad-URL blacklist cache. */
export function getBadUrlCacheSize(): number {
  return badUrlCache.size;
}

/** Mark a source URL as recently confirmed unreachable.
 *
 * Uses exponential backoff: each successive call for the same URL doubles
 * the blacklist window (90 s → 3 min → 5 min → 10 min) so genuinely broken
 * sources don't re-enter rotation every 90 s and cause cascading RECOVERING
 * → SKIP_PENDING cycles. The per-URL failure count is reset by clearBadUrl()
 * or clearAllBadUrls() so an operator "clear blocks" action always gives a
 * clean slate.
 */
export function markBadUrl(url: string): void {
  const now = Date.now();
  // Lazy GC: trim expired entries on every write to keep the map bounded.
  // We iterate the whole map only when we're writing, not on every read.
  if (badUrlCache.size > 500) {
    for (const [u, exp] of badUrlCache) {
      if (exp < now) badUrlCache.delete(u);
    }
  }
  // Increment the per-URL failure count and pick the corresponding TTL.
  const prevCount = badUrlFailureCounts.get(url) ?? 0;
  const newCount = prevCount + 1;
  badUrlFailureCounts.set(url, newCount);
  const ttlMs = badUrlTtlForCount(newCount);
  badUrlCache.set(url, now + ttlMs);
  logger.info({ url, ttlMs, failureCount: newCount }, "[broadcast-v2] URL marked bad — will skip in snapshots");
}

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
export function markBadUrlWithTtl(url: string, ttlMs: number): void {
  const now = Date.now();
  if (badUrlCache.size > 500) {
    for (const [u, exp] of badUrlCache) {
      if (exp < now) badUrlCache.delete(u);
    }
  }
  badUrlCache.set(url, now + ttlMs);
  logger.info(
    { url, ttlMs },
    "[broadcast-v2] URL suppressed with custom TTL — will skip in snapshots until transcoding completes",
  );
}

/** Clear a URL from the bad cache (e.g. after a queue reload with new sources).
 * Also resets the per-URL failure count so the next failure starts fresh at 90 s TTL. */
export function clearBadUrl(url: string): void {
  badUrlCache.delete(url);
  badUrlFailureCounts.delete(url);
}

/** Flush the entire bad-URL cache (e.g. operator-triggered "clear blocks").
 * Also resets all per-URL failure counts so every URL gets a clean slate. */
export function clearAllBadUrls(): void {
  badUrlCache.clear();
  badUrlFailureCounts.clear();
}

/** True if the URL is currently blacklisted and should not be served. */
export function isKnownBadUrl(url: string): boolean {
  const exp = badUrlCache.get(url);
  if (exp === undefined) return false;
  if (Date.now() > exp) {
    badUrlCache.delete(url);
    return false;
  }
  return true;
}

// ── Per-item URL-failure skip counter ────────────────────────────────────
//
// Each time a queue item's source URL is confirmed unreachable (via stall
// report or proactive probe), its failure counter is incremented.  When
// the counter reaches BAD_URL_SKIP_THRESHOLD the item's primary URL is
// extended in the bad-URL cache to SUSPENSION_TTL_MS (5 min) so the item
// is kept out of rotation without permanently disabling it in the DB.
// After the TTL the item auto-recovers — no operator action needed.
//
// The counter lives in memory only; it resets on server restart, giving
// every item a fresh chance after operator intervention.
//
// Counter reset path: `resetBadUrlSkipCount()` is called by the
// orchestrator when `naturalItemEnd()` fires — a successful natural
// completion proves the source was reachable and prior counts are stale.

/** Consecutive URL-failure reports required before auto-suspension.
 *  Raised from 3 → 5 to avoid auto-suspending items on transient network
 *  blips or brief storage hiccups that self-resolve within one bad-URL TTL. */
export const BAD_URL_SKIP_THRESHOLD = 5;

// itemId → consecutive URL-failure count
const badUrlSkipCounts = new Map<string, number>();

/**
 * Recent auto-suspensions (capped at 50) — exposed via /diagnostics so
 * operators can see why an item disappeared from rotation without digging
 * through server logs.
 */
const recentlySuspended: Array<{
  itemId: string;
  title: string | null;
  failCount: number;
  suspendedAtMs: number;
}> = [];

/** Increment the URL-failure counter for `itemId`. Returns the new count. */
export function incrementBadUrlSkipCount(itemId: string): number {
  // Lazy GC: prune oldest entries (by insertion order) when the map grows
  // beyond the cap. The map is keyed by itemId — not by URL — so we cannot
  // use isKnownBadUrl() here (that function expects a URL key and would
  // always return false for an itemId, incorrectly evicting live counters).
  // In normal operation the map rarely exceeds single digits; > 500 entries
  // indicates something unusual and pruning to 450 is safe.
  if (badUrlSkipCounts.size > 500) {
    // Evict the entries with the LOWEST skip count (least relevant) rather
    // than the oldest-inserted. This ensures actively-failing items (high
    // skip count, close to the suspension threshold) are never displaced to
    // make room for new entries — those are precisely the items whose
    // accumulated count must be preserved so they reach suspension and stop
    // burning broadcast skip budget.
    const toEvict = badUrlSkipCounts.size - 450;
    const sorted = [...badUrlSkipCounts.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < toEvict; i++) {
      badUrlSkipCounts.delete(sorted[i]![0]);
    }
  }
  const next = (badUrlSkipCounts.get(itemId) ?? 0) + 1;
  badUrlSkipCounts.set(itemId, next);
  return next;
}

/** Reset the URL-failure counter for `itemId` (call after a successful play). */
export function resetBadUrlSkipCount(itemId: string): void {
  badUrlSkipCounts.delete(itemId);
}

/**
 * Clear the auto-suspension state for an item that an operator has manually
 * re-enabled.  Resets the skip counter and removes the item from the
 * `recentlySuspended` list so the diagnostics panel stops showing it as
 * suspended and the next proactive probe starts with a clean slate.
 */
export function clearSuspended(itemId: string): void {
  badUrlSkipCounts.delete(itemId);
  const idx = recentlySuspended.findIndex((s) => s.itemId === itemId);
  if (idx !== -1) recentlySuspended.splice(idx, 1);
}

/** Returns the items auto-suspended in the current server session. */
export function getRecentlySuspended(): ReadonlyArray<{
  itemId: string;
  title: string | null;
  failCount: number;
  suspendedAtMs: number;
}> {
  return recentlySuspended;
}

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
export function autoSuspendQueueItem(
  itemId: string,
  title: string | null,
  failCount: number,
  primaryUrl?: string,
): void {
  // Extend the bad-URL TTL to SUSPENSION_TTL_MS for this item's URL.
  // markBadUrl() already set a 90 s TTL; we overwrite it with 5 min.
  if (primaryUrl) {
    badUrlCache.set(primaryUrl, Date.now() + SUSPENSION_TTL_MS);
    logger.info(
      { url: primaryUrl, ttlMs: SUSPENSION_TTL_MS },
      "[broadcast-v2] URL suspension TTL extended — will auto-recover",
    );
  }
  // Reset counter so the item starts fresh after recovery.
  badUrlSkipCounts.delete(itemId);
  recentlySuspended.push({ itemId, title, failCount, suspendedAtMs: Date.now() });
  if (recentlySuspended.length > 50) recentlySuspended.shift();
  logger.error(
    { itemId, title, failCount, threshold: BAD_URL_SKIP_THRESHOLD, suspensionTtlMs: SUSPENSION_TTL_MS },
    "[broadcast-v2] queue item temporarily suspended: URL failed repeatedly — will auto-recover after suspension TTL",
  );
  void import("../../../infrastructure/sentry.js").then(({ captureEvent }) =>
    captureEvent(
      `[broadcast-v2] Queue item temporarily suspended: "${title ?? itemId}" failed ${failCount} times — auto-recovery in ${SUSPENSION_TTL_MS / 60_000} min`,
      "error",
      { itemId, title, failCount, threshold: BAD_URL_SKIP_THRESHOLD, suspensionTtlMs: SUSPENSION_TTL_MS },
    ),
  ).catch(() => {});
}

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
export async function reEnableAllSuspended(): Promise<number> {
  try {
    // Only re-enable items that were deactivated by the system (validator,
    // auto-suspend, or legacy per-session auto-suspend) — identified by having
    // a non-null validatorDeactivatedReason. Items that operators intentionally
    // disabled have validatorDeactivatedReason=null and must never be silently
    // re-activated here; operators must re-enable those explicitly.
    //
    // This guards against "Reload from queue" blowing away deliberate operator
    // choices (e.g. a paused live event, a video flagged for review) when the
    // intent is only to recover from system-generated suspensions.
    const result = await db
      .update(schema.broadcastQueueTable)
      .set({ isActive: true, validatorDeactivatedReason: null })
      .where(
        and(
          eq(schema.broadcastQueueTable.isActive, false),
          isNotNull(schema.broadcastQueueTable.validatorDeactivatedReason),
        ),
      )
      .returning({ id: schema.broadcastQueueTable.id });
    const count = result.length;
    if (count > 0) {
      logger.info(
        { count },
        "[broadcast-v2] startup: re-enabled system-deactivated queue items — broadcast queue restored",
      );
    }
    return count;
  } catch (err) {
    logger.warn({ err }, "[broadcast-v2] startup: reEnableAllSuspended failed (non-fatal)");
    return 0;
  }
}

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

export function getItemsHealth(
  rows: RawQueueRow[],
): Record<string, ItemHealthEntry> {
  const now = Date.now();
  const ownBase = getOwnBase();
  const result: Record<string, ItemHealthEntry> = {};
  for (const row of rows) {
    const primary = normalizeQueueUrl(row.hlsMasterUrl ?? row.localVideoUrl);

    // For external MP4 sources the cache entry is the proxied URL.
    // For locally-hosted or HLS sources the cache entry is the raw URL.
    let exp: number | undefined;
    let resolvedBlockedUrl: string | null = null;

    if (primary !== null) {
      const isExternal = !isOwnOriginUrl(primary, ownBase);
      if (isExternal) {
        const proxied = makeMediaProxyUrl(primary, ownBase);
        exp = badUrlCache.get(proxied);
        if (exp !== undefined && exp <= now) {
          badUrlCache.delete(proxied);
          exp = undefined;
        }
        if (exp !== undefined) resolvedBlockedUrl = proxied;
      }

      // Fallback: check the raw/normalized URL for locally-hosted items and
      // for entries written before the proxied-URL fix.
      if (exp === undefined) {
        exp = badUrlCache.get(primary);
        if (exp !== undefined && exp <= now) {
          badUrlCache.delete(primary);
          exp = undefined;
        }
        if (exp !== undefined) resolvedBlockedUrl = primary;
      }
    }

    const isBad = exp !== undefined && exp > now;
    const failureCount = resolvedBlockedUrl
      ? (badUrlFailureCounts.get(resolvedBlockedUrl) ?? 0)
      : (primary ? (badUrlFailureCounts.get(primary) ?? 0) : 0);

    result[row.id] = {
      status: isBad ? "bad" : "ok",
      badUntilMs: isBad ? exp! : null,
      failureCount,
      blockedUrl: isBad ? resolvedBlockedUrl : null,
    };
  }
  return result;
}

/**
 * Returns a snapshot of the bad-URL cache for monitoring and diagnostics.
 * Cleans up expired entries as a side effect.
 */
export function getBadUrlStats(): {
  blockedCount: number;
  entries: Array<{ url: string; expiresAtMs: number; failureCount: number }>;
} {
  const now = Date.now();
  const entries: Array<{ url: string; expiresAtMs: number; failureCount: number }> = [];
  for (const [url, exp] of badUrlCache) {
    if (exp <= now) {
      badUrlCache.delete(url);
    } else {
      entries.push({ url, expiresAtMs: exp, failureCount: badUrlFailureCounts.get(url) ?? 0 });
    }
  }
  entries.sort((a, b) => b.expiresAtMs - a.expiresAtMs);
  return { blockedCount: entries.length, entries };
}

const q = schema.broadcastQueueTable;
const v = schema.videosTable;

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
export async function countActiveRaw(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(q)
    .where(eq(q.isActive, true));
  return row?.n ?? 0;
}

export const queueRepo = {
  async loadActive(): Promise<RawQueueRow[]> {
    // STRICT BROADCAST POLICY: only uploaded / local platform videos
    // participate in the v2 broadcast cycle. YouTube items are
    // library-only — they remain visible in the catalog and the
    // dedicated YouTube live surfaces, but they MUST NOT enter the
    // continuous-broadcast queue. We enforce that here at the read
    // layer (non-destructive — existing YouTube rows stay in the
    // table but the orchestrator never picks them up).
    //
    // Eligible row criteria:
    //   1. q.is_active = true
    //   2. Has a playable platform source on the joined videos row
    //      (hlsMasterUrl OR localVideoUrl OR a row-level localVideoUrl
    //      from an early auto-enqueue before transcode finishes), AND
    //   3. The joined video is NOT sourced from YouTube.
    //
    // Schema resilience: faststartApplied references managed_videos.faststart_applied.
    // Production DBs deployed before this column was added will throw PostgreSQL error
    // 42703 (undefined_column). We catch that and retry with `false` as a safe fallback
    // — the field is informational only and is NOT used in toItem() or the orchestrator
    // state machine. The column is added automatically on the next Render deploy
    // (build command runs `pnpm --filter @workspace/db run push-force`).
    const buildQuery = (faststartExpr: ReturnType<typeof sql>) =>
      db
        .select({
          id: q.id,
          videoId: q.videoId,
          youtubeId: q.youtubeId,
          title: q.title,
          thumbnailUrl: sql<string | null>`COALESCE(NULLIF(${q.thumbnailUrl}, ''), ${v.thumbnailUrl})`,
          durationSecs: q.durationSecs,
          // Actual ffprobe duration from the joined video row. Preferred over
          // q.durationSecs in the post-query validation pass when it is a
          // valid positive number — see comment at the validation loop below.
          videoDuration: v.duration,
          // Coalesce against the joined videos row so an item enqueued before
          // its row-level `localVideoUrl` was populated (or with only a
          // joined HLS master) still resolves to a playable source in
          // `toItem()`. Without this, the WHERE clause could admit a row
          // that `toItem()` then fails to project, triggering a needless
          // auto-skip cycle on the orchestrator.
          localVideoUrl: sql<string | null>`COALESCE(${q.localVideoUrl}, ${v.localVideoUrl})`,
          // Prefer the HLS URL on the queue row itself (set by live-ingest or
          // an operator override) and fall back to the one on the joined video
          // row (written by the transcoder when HLS encoding completes).
          hlsMasterUrl: sql<string | null>`COALESCE(${q.hlsMasterUrl}, ${v.hlsMasterUrl})`,
          faststartApplied: faststartExpr as ReturnType<typeof sql<boolean>>,
        })
        .from(q)
        .leftJoin(v, eq(q.videoId, v.id))
        .where(
          and(
            eq(q.isActive, true),
            // Reject any joined video whose source is YouTube. Rows with
            // no joined video (videoId IS NULL) are kept only when they
            // carry their own localVideoUrl — covers the "early-enqueue
            // on upload finalize" path before the videos row is fully
            // hydrated.
            or(ne(v.videoSource, "youtube"), sql`${v.id} IS NULL`),
            // Admit the row if ANY playable URL exists — queue-row HLS/MP4,
            // or joined video-row HLS/MP4. Order reflects priority in toItem().
            or(isNotNull(q.hlsMasterUrl), isNotNull(v.hlsMasterUrl), isNotNull(v.localVideoUrl), isNotNull(q.localVideoUrl)),
            // Only admit items whose video asset is confirmed safe to stream.
            //
            // Allowed states (item is safe to serve via localVideoUrl):
            //   'none'       — no transcoding requested; raw upload is the final
            //                  artifact. Legacy / externally-created rows with no
            //                  transcoding history.
            //   'queued'     — transcoding job created but ffmpeg has NOT yet
            //                  started. The original upload blob at localVideoUrl
            //                  is completely intact and readable. Blocking this
            //                  state causes a guaranteed off-air window between
            //                  upload and the first transcoding tick.
            //   'encoding'   — HLS ffmpeg is running. The transcoder downloads
            //                  the source to a temp directory and encodes there;
            //                  the ORIGINAL localVideoUrl object in storage is
            //                  never modified during this phase. Safe to serve.
            //   'processing' — faststart.service.ts is re-uploading a moov-rewritten
            //                  file to the same storage key via multipart upload.
            //                  The ORIGINAL key is still served by storage throughout
            //                  (multipart parts are not visible until
            //                  completeMultipartUpload commits them atomically).
            //                  Blocking this state was wrong: it created an off-air
            //                  window that could last minutes for large files, even
            //                  though the video was perfectly playable the whole
            //                  time. Admitted on the same basis as 'queued'.
            //   'ready'      — MP4 faststart complete; moov atom at byte 0.
            //   'hls_ready'  — full HLS transcode done; hlsMasterUrl preferred.
            //   'failed'     — Transcoding or faststart failed.
            //                  Only admit when `faststart_applied = true` (moov
            //                  atom confirmed at byte-0, safe to stream) OR when
            //                  an HLS master URL is already available.
            //                  Un-faststarted 'failed' files may have the moov
            //                  atom at EOF — large uploads cause seek timeouts.
            //                  Recovery: Videos page → Re-apply faststart, or
            //                  convert to HLS via the transcoder.
            //
            // Items with hlsMasterUrl set are always admitted regardless of status:
            // the HLS playlist is the authoritative streamable source.
            or(
              sql`${v.id} IS NULL`,
              isNotNull(v.hlsMasterUrl),
              // 'ready' and 'hls_ready' are always safe: faststart/HLS is complete.
              inArray(v.transcodingStatus, ["ready", "hls_ready"]),
              // 'none', 'queued', 'encoding': admit immediately — the raw upload
              // blob is accessible at localVideoUrl. Faststart re-uploads to the
              // same key atomically; HLS adds a separate manifest. Both upgrade
              // in-place without a re-queue.
              inArray(v.transcodingStatus, ["none", "queued", "encoding"]),
              // 'processing': faststart.service is running the moov-atom relocation.
              //
              // Admitted unconditionally: the ORIGINAL blob at localVideoUrl is
              // always readable during a faststart re-upload because multipart parts
              // are not visible until completeMultipartUpload commits them atomically.
              // Even when faststartApplied=false (prior faststart run failed), the
              // source file still exists at localVideoUrl; faststart-recovery will
              // retry. The player watchdog + bad-URL cache + auto-skip handle any
              // range-streaming failure gracefully. Queue admission depends only on
              // source availability, not on moov position.
              eq(v.transcodingStatus, "processing"),
              // 'failed': transcoding or faststart permanently failed.
              // Admitted whenever ANY playable source URL exists — either an HLS
              // master on the queue row or joined video row, OR a localVideoUrl.
              // The faststart-recovery worker actively attempts to fix moov position
              // for failed+faststartApplied=false items in the background; the
              // player watchdog + bad-URL cache + auto-skip handles any unrecoverable
              // streaming failures without operator action.
              // Only items with truly absent sources (CORRUPT_SOURCE / SOURCE_MISSING
              // error codes — detected by the queue-integrity-validator and deactivated
              // there) have no URL and therefore fail this admission clause naturally.
              and(
                eq(v.transcodingStatus, "failed"),
                or(
                  isNotNull(q.hlsMasterUrl),
                  isNotNull(v.hlsMasterUrl),
                  isNotNull(v.localVideoUrl),
                  isNotNull(q.localVideoUrl),
                ),
              ),
            ),
          ),
        )
        .orderBy(asc(q.sortOrder), asc(q.addedAt))
        // Safety cap: prevents the orchestrator from loading an unbounded number
        // of rows into its in-memory cycle array on every 30 s reload.  Items
        // beyond the cap are NOT removed from the DB — they will air once
        // earlier items are removed or the cap is raised via BROADCAST_QUEUE_MAX_ITEMS.
        .limit(env.BROADCAST_QUEUE_MAX_ITEMS);

    let rows: Awaited<ReturnType<typeof buildQuery>>;
    try {
      rows = await buildQuery(sql<boolean>`COALESCE(${v.faststartApplied}, false)`);
    } catch (err: unknown) {
      // PostgreSQL SQLSTATE 42703 = "undefined_column". The production DB schema
      // may pre-date the `faststart_applied` column. Retry with a hardcoded false
      // — the field is informational only, not used by toItem() or the orchestrator.
      //
      // Drizzle wraps the raw pg error in _DrizzleQueryError, so the SQLSTATE code
      // lives on err.cause.code — not on err.code directly. Walk the error chain to
      // find it, and also check the error message as a belt-and-suspenders fallback
      // (PostgreSQL sets message = 'column "faststart_applied" does not exist').
      if (!isUndefinedColumnError(err, "faststart_applied")) throw err;
      logger.warn(
        "[broadcast-v2] loadActive: managed_videos.faststart_applied column not found " +
        "— retrying with faststartApplied=false (run `pnpm --filter @workspace/db run push` to fix permanently)",
      );
      rows = await buildQuery(sql<boolean>`false`);
    }
    // Warn operators when the queue is at or near the cap — items beyond the
    // limit are silently excluded from the current broadcast cycle.
    if (rows.length >= env.BROADCAST_QUEUE_MAX_ITEMS) {
      logger.warn(
        { loaded: rows.length, cap: env.BROADCAST_QUEUE_MAX_ITEMS },
        "[broadcast-v2] loadActive: queue at capacity cap — items beyond the limit will not air this cycle. " +
        "Raise BROADCAST_QUEUE_MAX_ITEMS or remove items from the queue.",
      );
    }

    // ── Post-query validation layer ──────────────────────────────────────
    // The WHERE clause above is the primary gate but we add a JS-level pass
    // here as defense-in-depth: it catches edge cases where COALESCE returns
    // an empty string, a video row was deleted mid-query, or a future schema
    // change loosens the WHERE predicate. Items that fail this check are
    // logged (not silently dropped) so operators can fix the root cause.
    const validated: typeof rows = [];
    for (const r of rows) {
      const primaryUrl = r.hlsMasterUrl ?? r.localVideoUrl;
      if (!primaryUrl || primaryUrl.trim() === "") {
        logger.warn(
          { itemId: r.id, title: r.title, videoId: r.videoId },
          "[broadcast-v2] queue item rejected by validation — no playable URL after COALESCE (skipping)",
        );
        continue;
      }
      // Prefer the actual ffprobe duration from the joined video row over
      // the queue row's durationSecs.  The queue row is often set to 1800 s
      // (30-minute placeholder) at upload-time before ffprobe has run; the
      // video row is updated once probing completes.  Using the real duration
      // means item-transition timing is accurate from the very first playback
      // — naturalItemEnd write-back and the transcoder also update the queue
      // row, but those are async; this coalesce is the primary defence.
      //
      // MIN_BROADCAST_SECS guards against probe-failure artifacts: the upload
      // race condition (moov atom not yet flushed when ffprobe ran) produces a
      // near-zero duration.  In that case fall back to the queue row's
      // durationSecs (typically the 1800 s upload-time placeholder), which will
      // be corrected once faststart/naturalItemEnd writes the real value.
      const MIN_BROADCAST_SECS = 10;
      const parsedVideoDuration = r.videoDuration ? Math.round(parseFloat(r.videoDuration)) : 0;
      const effectiveDurationSecs = parsedVideoDuration >= MIN_BROADCAST_SECS
        ? parsedVideoDuration
        : r.durationSecs;
      if (effectiveDurationSecs < MIN_BROADCAST_SECS) {
        // Duration is unknown, zero, or suspiciously short on both sources.
        // Use a 30-minute placeholder so the item still airs rather than being
        // silently discarded or cycling every few seconds.  The queue row's
        // duration_secs will be corrected by updateDurationSecs() once the
        // transcoder or naturalItemEnd writes the real value.
        logger.warn(
          { itemId: r.id, title: r.title, durationSecs: r.durationSecs, videoDuration: r.videoDuration },
          "[broadcast-v2] queue item has zero/unknown/suspicious duration — using 1800 s placeholder (will self-correct after probe)",
        );
        validated.push({ ...r, durationSecs: 1800 });
        continue;
      }
      validated.push({ ...r, durationSecs: effectiveDurationSecs });
    }
    if (validated.length < rows.length) {
      logger.warn(
        { total: rows.length, valid: validated.length, rejected: rows.length - validated.length },
        "[broadcast-v2] loadActive: some queue items failed validation — they will not air",
      );
    }
    return validated.map((r) => ({ ...r, durationSecs: Math.max(1, r.durationSecs) }));
  },

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
  async updateDurationSecs(itemId: string, durationSecs: number): Promise<void> {
    await db
      .update(q)
      .set({ durationSecs })
      .where(eq(q.id, itemId));
  },

  /**
   * Update duration_secs for all broadcast_queue rows that reference a given
   * video ID. Used when the transcoder or upload probe provides the real
   * duration after the queue row was already created with a placeholder.
   */
  async updateDurationSecsByVideoId(videoId: string, durationSecs: number): Promise<void> {
    await db
      .update(q)
      .set({ durationSecs })
      .where(eq(q.videoId, videoId));
  },

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
  toItem(row: RawQueueRow, startsAtMs: number): V2Item | null {
    // Normalise URLs: relative paths become absolute using PROD_SYNC_API_URL
    // (dev→prod mirror) or API_ORIGIN (production own-origin), or
    // RENDER_EXTERNAL_URL (zero-config Render self-detection), if configured.
    const primary = normalizeQueueUrl(row.hlsMasterUrl ?? row.localVideoUrl);
    const mp4 = normalizeQueueUrl(row.localVideoUrl);

    // NOTE: the bad-URL cache check is intentionally NOT here.
    // `toItem()` is called at reloadInner() time to build this.items — we
    // want this.items to always reflect the full resolvable queue so that
    // `itemCount` on /health is accurate ("3 items loaded, 2 blocked") even
    // when some items are blocked by stall reports.  The bad-URL filter
    // lives exclusively in projectItem() (snapshot time), where it gates
    // whether an item becomes `current` / `next` / `nextNext`.

    // youtubeId intentionally omitted — v2 broadcast is uploads-only.
    const resolved = resolveSource({ primaryUrl: primary, mp4Url: mp4 });

    if (!resolved) {
      // Log with enough context for operators to diagnose:
      //   - null primary + relative raw URL → API_ORIGIN not configured
      //   - non-null primary but still null → host not in SSRF allowlist
      logger.warn(
        {
          id: row.id,
          title: row.title,
          primaryUrl: primary ?? null,
          rawUrl: (row.hlsMasterUrl ?? row.localVideoUrl) ?? null,
        },
        "[broadcast-v2] item has no playable source — will not air" +
          (!primary || !/^https?:\/\//i.test(row.hlsMasterUrl ?? row.localVideoUrl ?? "")
            ? " (relative URL detected — set API_ORIGIN=https://api.templetv.org.ng in production)"
            : " (URL not in broadcast allowlist — add host to ALLOWED_HOST_SUFFIXES if legitimate)"),
      );
      return null;
    }

    // Rewrite any external MP4 source URL through this server's media proxy
    // so player clients (admin, TV, mobile) always receive a same-origin URL.
    // External origins (e.g. the production API) may return
    // `Cross-Origin-Resource-Policy: same-origin`, which the browser enforces
    // by blocking the cross-origin media load. Routing through the proxy strips
    // that restriction transparently.
    const ownBase = getOwnBase();
    const source = proxyExternalSource(resolved.source, ownBase);
    const failoverSource = resolved.failoverSource
      ? (proxyExternalSource(
          resolved.failoverSource as Pick<V2Source, "kind" | "url"> & typeof resolved.failoverSource,
          ownBase,
        ) as typeof resolved.failoverSource)
      : null;

    const endsAtMs = startsAtMs + row.durationSecs * 1000;

    // Absolutize relative thumbnail paths (e.g. /api/hls/…/thumbnail.jpg)
    // so client apps on any origin can display them without knowing the API
    // base URL.  Already-absolute URLs (http/https) are returned unchanged.
    const thumbnailUrl = (() => {
      if (!row.thumbnailUrl) return null;
      if (/^https?:\/\//i.test(row.thumbnailUrl)) return row.thumbnailUrl;
      const base = ownBase.replace(/\/+$/, "");
      const path = row.thumbnailUrl.startsWith("/") ? row.thumbnailUrl : `/${row.thumbnailUrl}`;
      return `${base}${path}`;
    })();

    return {
      id: row.id,
      title: row.title,
      thumbnailUrl,
      durationSecs: row.durationSecs,
      source,
      failoverSource,
      startsAtMs,
      endsAtMs,
    };
  },
};

// ── Bad-URL cache persistence ─────────────────────────────────────────────────
//
// Persists the in-memory badUrlCache (url → expiresAtMs) and badUrlSkipCounts
// (itemId → count) to the broadcast_runtime_state row so that suspension
// windows and accumulated failure counts survive a server restart.
//
// On boot, hydrateBadUrlCache() is called by the orchestrator to restore
// non-expired entries before the first queue reload runs. Expired URL entries
// are dropped silently; skip counts are restored as-is (they auto-expire when
// an item completes a natural play after restart).
//
// Persist is called:
//   • From autoSuspendQueueItem (immediate, critical moment)
//   • From a 60 s periodic timer in the orchestrator (drift correction)
//   • At graceful shutdown (best-effort)

/**
 * Serialize the current bad-URL blacklist and skip-count maps to the
 * broadcast_runtime_state row. Non-throwing — errors are debug-logged.
 */
export async function persistBadUrlCache(channelId: string): Promise<void> {
  try {
    const state = {
      urlCache: Object.fromEntries(badUrlCache) as Record<string, number>,
      skipCounts: Object.fromEntries(badUrlSkipCounts) as Record<string, number>,
    };
    await runtimeRepo.saveBadUrlCache(channelId, state);
  } catch (err) {
    logger.debug({ err }, "[broadcast-v2] bad-URL cache persist failed (non-fatal)");
  }
}

/**
 * Restore the bad-URL blacklist and skip-count maps from the DB on boot.
 * Expired urlCache entries are dropped. Non-throwing — an
 * isUndefinedColumnError means the schema migration hasn't run yet, which
 * is safe (the cache just starts empty).
 */
export async function hydrateBadUrlCache(channelId: string): Promise<void> {
  try {
    const state = await runtimeRepo.loadBadUrlCache(channelId);
    if (!state) return;
    const now = Date.now();
    let urlCount = 0;
    let skipCount = 0;
    if (state.urlCache && typeof state.urlCache === "object") {
      for (const [url, expiresAtMs] of Object.entries(state.urlCache)) {
        if (typeof expiresAtMs === "number" && expiresAtMs > now) {
          badUrlCache.set(url, expiresAtMs);
          urlCount++;
        }
      }
    }
    if (state.skipCounts && typeof state.skipCounts === "object") {
      for (const [itemId, count] of Object.entries(state.skipCounts)) {
        if (typeof count === "number" && count > 0) {
          badUrlSkipCounts.set(itemId, count);
          skipCount++;
        }
      }
    }
    if (urlCount > 0 || skipCount > 0) {
      logger.info(
        { channelId, urlCount, skipCount },
        "[broadcast-v2] hydrated bad-URL cache from persistent storage — suspension windows and failure counts restored",
      );
    }
  } catch (err) {
    if (isUndefinedColumnError(err)) {
      logger.debug("[broadcast-v2] bad_url_cache column not yet present — run 'pnpm --filter @workspace/db run push' to enable persistence (non-fatal)");
      return;
    }
    logger.debug({ err }, "[broadcast-v2] bad-URL cache hydrate failed (non-fatal)");
  }
}
