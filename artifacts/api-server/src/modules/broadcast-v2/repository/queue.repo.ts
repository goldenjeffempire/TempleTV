import { createHmac } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { resolveSource } from "../resolver/universal-source-resolver.js";
import { logger } from "../../../infrastructure/logger.js";
import { env } from "../../../config/env.js";
import type { V2Item, V2Source } from "../domain/types.js";
import { isUndefinedColumnError } from "../../../infrastructure/db-schema-guard.js";

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
 *   2. REPLIT_DEV_DOMAIN — Replit-managed public dev domain (auto-set)
 *   3. Raw path returned — resolver will reject with allowlist error;
 *                          surfaces a clear log instead of a silent null.
 *
 * NOTE: PROD_SYNC_API_URL is intentionally excluded. Using it would
 * proxy local file requests to the upstream production server — broken
 * in dev and a security issue in prod.
 */

function normalizeQueueUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  // Resolution order (first truthy wins):
  //   1. API_ORIGIN            — explicit own-origin, always wins (required in production)
  //   2. RENDER_EXTERNAL_URL   — Render auto-sets this to the service's public HTTPS URL;
  //                              gives zero-config self-origin detection on Render deploys
  //   3. REPLIT_DEV_DOMAIN     — Replit dev environment public domain
  //   4. http://localhost:PORT — Pure local dev fallback (no public origin configured).
  //                              localhost is now in the SSRF allowlist so the resolver
  //                              accepts these URLs and the player can load uploads from
  //                              the dev server running on the same machine.
  const publicBase = (
    env.API_ORIGIN ??
    process.env["RENDER_EXTERNAL_URL"] ??
    process.env["REPLIT_DEV_DOMAIN"]
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
// (e.g. prod-sync items from api.templetv.org.ng), the browser blocks the
// media load because the remote server returns `Cross-Origin-Resource-Policy:
// same-origin`. We rewrite those external MP4 URLs to go through our own
// /api/v1/media-proxy endpoint which strips the restriction and serves with
// CORP: cross-origin. HLS manifests are left as-is because segment URLs
// embedded in the manifest would still be cross-origin even if the manifest
// itself were proxied — that case is handled separately if/when HLS sources
// from external origins are introduced.

/**
 * Returns this server's own absolute public base URL using the same priority
 * order as normalizeQueueUrl (API_ORIGIN > RENDER_EXTERNAL_URL >
 * REPLIT_DEV_DOMAIN > http://localhost:PORT).
 */
function getOwnBase(): string {
  const publicBase = (
    env.API_ORIGIN ??
    process.env["RENDER_EXTERNAL_URL"] ??
    process.env["REPLIT_DEV_DOMAIN"]
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
 * YouTube and HLS sources are returned unchanged.
 * Same-origin sources are returned unchanged (no proxy needed).
 */
function proxyExternalSource<T extends Pick<V2Source, "kind" | "url">>(
  source: T,
  ownBase: string,
): T {
  // YouTube is handled by the native YouTube player on TV/mobile — never proxy.
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

export const BAD_URL_TTL_MS = 15_000; // 15 seconds — fast dead-air recovery

// url → expiresAtMs
const badUrlCache = new Map<string, number>();

/** Mark a source URL as recently confirmed unreachable. */
export function markBadUrl(url: string): void {
  const now = Date.now();
  // Lazy GC: trim expired entries on every write to keep the map bounded.
  // We iterate the whole map only when we're writing, not on every read.
  if (badUrlCache.size > 500) {
    for (const [u, exp] of badUrlCache) {
      if (exp < now) badUrlCache.delete(u);
    }
  }
  badUrlCache.set(url, now + BAD_URL_TTL_MS);
  logger.info({ url, ttlMs: BAD_URL_TTL_MS }, "[broadcast-v2] URL marked bad — will skip in snapshots");
}

/** Clear a URL from the bad cache (e.g. after a queue reload with new sources). */
export function clearBadUrl(url: string): void {
  badUrlCache.delete(url);
}

/** Flush the entire bad-URL cache (e.g. operator-triggered "clear blocks"). */
export function clearAllBadUrls(): void {
  badUrlCache.clear();
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
// the counter reaches BAD_URL_SKIP_THRESHOLD the item is automatically
// deactivated in the DB (is_active = false) so it stops consuming retry
// cycles and causing dead air on air.
//
// The counter lives in memory only; it resets on server restart.  This is
// intentional — a restart implies operator intervention and the item gets
// a fresh chance before suspension kicks in again.
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
export async function autoSuspendQueueItem(
  itemId: string,
  title: string | null,
  failCount: number,
): Promise<void> {
  try {
    await db
      .update(schema.broadcastQueueTable)
      .set({ isActive: false })
      .where(eq(schema.broadcastQueueTable.id, itemId));
    // Reset counter so if the operator re-activates the item it starts fresh.
    badUrlSkipCounts.delete(itemId);
    recentlySuspended.push({ itemId, title, failCount, suspendedAtMs: Date.now() });
    if (recentlySuspended.length > 50) recentlySuspended.shift();
    logger.warn(
      { itemId, title, failCount, threshold: BAD_URL_SKIP_THRESHOLD },
      "[broadcast-v2] queue item auto-suspended: URL failed repeatedly — deactivated until operator re-enables",
    );
  } catch (err) {
    logger.error(
      { err, itemId, title, failCount },
      "[broadcast-v2] autoSuspendQueueItem: DB update failed (item stays in rotation)",
    );
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
export function getItemsHealth(
  rows: RawQueueRow[],
): Record<string, { status: "ok" | "bad"; badUntilMs: number | null }> {
  const now = Date.now();
  const ownBase = getOwnBase();
  const result: Record<string, { status: "ok" | "bad"; badUntilMs: number | null }> = {};
  for (const row of rows) {
    const primary = normalizeQueueUrl(row.hlsMasterUrl ?? row.localVideoUrl);

    // For external MP4 sources the cache entry is the proxied URL.
    // For locally-hosted or HLS sources the cache entry is the raw URL.
    let exp: number | undefined;

    if (primary !== null) {
      const isExternal = !isOwnOriginUrl(primary, ownBase);
      if (isExternal) {
        const proxied = makeMediaProxyUrl(primary, ownBase);
        exp = badUrlCache.get(proxied);
        if (exp !== undefined && exp <= now) {
          badUrlCache.delete(proxied);
          exp = undefined;
        }
      }

      // Fallback: check the raw/normalized URL for locally-hosted items and
      // for entries written before the proxied-URL fix.
      if (exp === undefined) {
        exp = badUrlCache.get(primary);
        if (exp !== undefined && exp <= now) {
          badUrlCache.delete(primary);
          exp = undefined;
        }
      }
    }

    const isBad = exp !== undefined && exp > now;
    result[row.id] = {
      status: isBad ? "bad" : "ok",
      badUntilMs: isBad ? exp! : null,
    };
  }
  return result;
}

const q = schema.broadcastQueueTable;
const v = schema.videosTable;

/**
 * Parse a YouTube duration string into seconds.
 *
 * Handles:
 *   • ISO 8601  "PT1H30M45S" → 5445
 *   • Numeric   "3600.5"     → 3601
 *   • null / ""              → 1200 (20-minute placeholder)
 */
function parseYoutubeDuration(dur: string | null | undefined): number {
  if (!dur) return 1200;
  // Numeric seconds (some sync paths store raw seconds as a string)
  const numeric = parseFloat(dur);
  if (!isNaN(numeric) && numeric > 0) return Math.round(numeric);
  // ISO 8601 PT format: PT[nH][nM][nS]
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(dur);
  if (match) {
    const h = parseInt(match[1] ?? "0", 10);
    const m = parseInt(match[2] ?? "0", 10);
    const s = Math.round(parseFloat(match[3] ?? "0"));
    const total = h * 3600 + m * 60 + s;
    return total > 0 ? total : 1200;
  }
  return 1200;
}

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
            // Still-blocked state (item excluded from broadcast):
            //   'processing'— faststart.service.ts is re-encoding and re-uploading
            //                 the moov-rewritten file via multipart upload. The
            //                 original key remains readable throughout (no 404
            //                 window), but we hold the item back until the new
            //                 file is atomically committed so the player doesn't
            //                 bind to the un-faststarted source mid-cycle.
            //                 The item re-enters the queue immediately after
            //                 faststart completes and the orchestrator reloads
            //                 (broadcast-queue-updated event).
            //
            // Allowed states (item is safe to serve via localVideoUrl):
            //   'none'      — no transcoding requested; raw upload is the final
            //                 artifact. Legacy / externally-created rows with no
            //                 transcoding history.
            //   'queued'    — transcoding job created but ffmpeg has NOT yet
            //                 started. The original upload blob at localVideoUrl
            //                 is completely intact and readable. Blocking this
            //                 state causes a guaranteed off-air window between
            //                 upload and the first transcoding tick. Allow it so
            //                 videos air immediately when added to the queue.
            //   'encoding'  — HLS ffmpeg is running. The transcoder downloads
            //                 the source to a temp directory and encodes there;
            //                 the ORIGINAL localVideoUrl object in storage is
            //                 never modified during this phase. Safe to serve.
            //   'ready'     — MP4 faststart complete; moov atom at byte 0, fully seekable.
            //   'hls_ready' — full HLS transcode done; hlsMasterUrl is also set and
            //                 preferred over localVideoUrl by toItem().
            //   'failed'    — Transcoding or faststart failed.
            //                 Only admit when `faststart_applied = true` (moov
            //                 atom confirmed at byte-0, safe to stream) OR when
            //                 an HLS master URL is already available.
            //                 Un-faststarted 'failed' files have the moov atom
            //                 at EOF — browsers must download the entire file
            //                 before they can parse metadata, causing timeouts
            //                 and SKIP_PENDING dead-air loops on large uploads.
            //                 Recovery path: Videos page → Re-apply faststart,
            //                 or convert to HLS via the transcoder.
            //
            // Items with hlsMasterUrl set are always admitted regardless of status:
            // the HLS playlist is the authoritative streamable source and is already
            // stable by the time hlsMasterUrl is written to the DB.
            or(
              sql`${v.id} IS NULL`,
              isNotNull(v.hlsMasterUrl),
              // 'ready' and 'hls_ready' are always safe: faststart/HLS is complete.
              inArray(v.transcodingStatus, ["ready", "hls_ready"]),
              // 'none', 'queued', 'encoding': only admit when faststart has
              // relocated the moov atom to byte 0. Raw uploads (faststartApplied=false)
              // have the moov atom at EOF — the browser must download the entire file
              // before it can parse metadata, causing player timeouts and infinite
              // SKIP_PENDING dead-air loops on large MP4 uploads.
              // Videos are auto-added to the queue by faststart.service.ts AFTER
              // faststartApplied=true, so the window here is only for items manually
              // added via the admin queue page while faststart is still running.
              and(
                inArray(v.transcodingStatus, ["none", "queued", "encoding"]),
                eq(v.faststartApplied, true),
              ),
              // 'failed': admit only when the moov atom is confirmed at byte-0.
              and(
                eq(v.transcodingStatus, "failed"),
                or(isNotNull(q.hlsMasterUrl), isNotNull(v.hlsMasterUrl), eq(v.faststartApplied, true)),
              ),
            ),
          ),
        )
        .orderBy(asc(q.sortOrder), asc(q.addedAt));

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
      const parsedVideoDuration = r.videoDuration ? Math.round(parseFloat(r.videoDuration)) : 0;
      const effectiveDurationSecs = parsedVideoDuration > 0 ? parsedVideoDuration : r.durationSecs;
      if (effectiveDurationSecs <= 0) {
        // Duration is unknown (ffprobe hasn't run yet, or the video row is
        // not joined). Use a 30-minute placeholder so the item still airs
        // rather than being silently discarded. The placeholder matches the
        // value written at upload-time before probing completes; the queue
        // row's duration_secs will be corrected by updateDurationSecs() once
        // the transcoder or naturalItemEnd writes the real value.
        logger.warn(
          { itemId: r.id, title: r.title, durationSecs: r.durationSecs, videoDuration: r.videoDuration },
          "[broadcast-v2] queue item has zero/unknown duration — using 1800 s placeholder (will self-correct after probe)",
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
   * Load all YouTube videos from the managed_videos library for fallback
   * broadcast playback.
   *
   * Returns up to `limit` rows (default 300) with a stable play-ready
   * representation.  The caller is responsible for shuffling.
   *
   * Duration is parsed from the stored text column which may contain:
   *   • ISO 8601 ("PT1H30M45S") — from the YouTube Data API
   *   • Numeric string ("3600.5") — seconds, from some sync paths
   * Unparseable or zero-length values fall back to 1200 s (20 minutes).
   */
  async loadYoutubeLibrary(limit = 300): Promise<Array<{
    youtubeId: string;
    title: string;
    thumbnailUrl: string | null;
    durationSecs: number;
  }>> {
    const rows = await db
      .select({
        youtubeId: v.youtubeId,
        title: v.title,
        thumbnailUrl: v.thumbnailUrl,
        duration: v.duration,
      })
      .from(v)
      .where(
        and(
          eq(v.videoSource, "youtube"),
          isNotNull(v.youtubeId),
          ne(v.youtubeId, ""),
        ),
      )
      .limit(limit);

    return rows
      .filter((r): r is typeof r & { youtubeId: string } => typeof r.youtubeId === "string" && r.youtubeId.length > 0)
      .map((r) => ({
        youtubeId: r.youtubeId,
        title: r.title,
        thumbnailUrl: r.thumbnailUrl ?? null,
        durationSecs: parseYoutubeDuration(r.duration),
      }));
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
    return {
      id: row.id,
      title: row.title,
      thumbnailUrl: row.thumbnailUrl,
      durationSecs: row.durationSecs,
      source,
      failoverSource,
      startsAtMs,
      endsAtMs,
    };
  },
};
