import express, { Router } from "express";
import { db, pushTokensTable, notificationsTable, liveOverridesTable } from "@workspace/db";
import { eq, asc, inArray } from "drizzle-orm";
import { randomUUID, createHash } from "crypto";
import {
  broadcastLiveEvent,
  addSSEClient,
  removeSSEClient,
  startSSEHeartbeat,
  SSECapacityError,
  type LiveStatusSnapshot,
} from "../lib/liveEvents";
import { emitBroadcastState } from "./broadcast";
import { cache } from "../lib/cache";
import { logger } from "../lib/logger";
import { sendOpsAlert } from "../lib/alerts";
import { getClientIp } from "../middlewares/security";
import { recordFailureReport, type LiveFailureSurface } from "../lib/liveFailureReports";

const router = Router();

const CHANNEL_ID = "UCPFFvkE-KGpR37qJgvYriJg";
const CHANNEL_HANDLE = "templetvjctm";
const UPLOADS_PLAYLIST_ID = "UUPFFvkE-KGpR37qJgvYriJg";
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY ?? "";

const BROWSER_HEADERS = {
  Accept: "application/xml, text/xml, */*",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes in ms

// ── YouTube Data API v3 quota gate ───────────────────────────────────────────
// The free YouTube Data API quota is 10,000 units/day and resets at midnight
// Pacific Time. Hitting the cap returns HTTP 403 with `reason: "quotaExceeded"`
// (or `dailyLimitExceeded`). Before this guard, every scheduled tick and every
// admin request would re-hit the API, get the 403, and emit a `level:50`
// ERROR log — polluting Sentry / Render error metrics on a *recoverable*
// condition. This module-level helper:
//   1. Short-circuits all youtube.googleapis.com calls when the quota gate is
//      set, returning null (callers already handle null as "no data, fall
//      back to cache or empty list").
//   2. Sets the gate (in the distributed cache, so siblings see it too) when
//      a 403 quota error is observed.
//   3. Logs the quota-exhaustion event at WARN once per hour at most — never
//      ERROR — and logs the silent skips at DEBUG.
const QUOTA_EXHAUSTED_KEY = "youtube:quota:exhaustedUntilMs";
const QUOTA_USAGE_KEY_PREFIX = "youtube:quota:usage:"; // suffix: YYYY-MM-DD (UTC)
const QUOTA_CONTEXT_KEY_PREFIX = "youtube:quota:context:"; // suffix: YYYY-MM-DD (UTC)
const QUOTA_DAILY_LIMIT = Number(process.env.YOUTUBE_QUOTA_DAILY_LIMIT ?? "10000");
// Number of historical days to render in the admin dashboard chart.
const QUOTA_HISTORY_DAYS = 7;
let _lastQuotaWarnAtMs = 0;

// UTC date label for the bucket key. Quota actually resets at Pacific midnight,
// but the YYYY-MM-DD bucket only needs to be monotonic+stable over a day —
// the absolute reset moment is tracked separately by `nextQuotaResetMs()`.
function utcDateLabel(now: number = Date.now()): string {
  const d = new Date(now);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function quotaBucketKey(now: number = Date.now()): string {
  return `${QUOTA_USAGE_KEY_PREFIX}${utcDateLabel(now)}`;
}

function quotaContextKey(now: number = Date.now()): string {
  return `${QUOTA_CONTEXT_KEY_PREFIX}${utcDateLabel(now)}`;
}

/**
 * Best-effort daily-quota counter. We can't query the real "units consumed"
 * from Google, so we attribute each call by its documented cost (search=100,
 * everything else we use today=1). Two parallel counters are written:
 *
 *   1. Daily total — for the headline number / banner threshold.
 *   2. Per-context breakdown — a small object keyed by the API context name
 *      (e.g. "playlistItems", "videos.details", "yt-status") so the admin
 *      dashboard can show which scheduler / endpoint is burning units.
 *
 * Both persist in the distributed cache so they survive restarts and are
 * shared across replicas. TTL is set generously (`QUOTA_HISTORY_DAYS + 1`
 * days) so historical buckets are still readable for the chart.
 */
async function recordQuotaUsage(
  costUnits: number,
  context: string,
): Promise<void> {
  if (costUnits <= 0) return;
  const ttlMs = (QUOTA_HISTORY_DAYS + 1) * 24 * 60 * 60 * 1000;

  // Daily total
  const totalKey = quotaBucketKey();
  const currentTotal = (await cache.get<number>(totalKey)) ?? 0;
  await cache.set(totalKey, currentTotal + costUnits, ttlMs);

  // Per-context breakdown (small object; cheap read-modify-write)
  const ctxKey = quotaContextKey();
  const currentCtx =
    (await cache.get<Record<string, number>>(ctxKey)) ?? {};
  currentCtx[context] = (currentCtx[context] ?? 0) + costUnits;
  await cache.set(ctxKey, currentCtx, ttlMs);
}

// ── Auto-throttling thresholds ───────────────────────────────────────────────
// At THROTTLE_PCT_T1 (default 90%) we pause the SINGLE noisiest context for
// the rest of the UTC day. At THROTTLE_PCT_T2 (default 95%) we pause the top
// TWO. The hard quota gate (set by Google's 403 response) is the last line of
// defence; this throttle exists to prevent ever reaching it. Both thresholds
// are env-tunable for operators that want to be more or less aggressive.
const THROTTLE_PCT_T1 = Math.max(
  10,
  Math.min(100, Number(process.env.YOUTUBE_QUOTA_THROTTLE_T1_PCT ?? "90")),
);
const THROTTLE_PCT_T2 = Math.max(
  THROTTLE_PCT_T1,
  Math.min(100, Number(process.env.YOUTUBE_QUOTA_THROTTLE_T2_PCT ?? "95")),
);
const THROTTLE_ENABLED = (process.env.YOUTUBE_QUOTA_AUTO_THROTTLE ?? "true") !== "false";

// Track which contexts were throttled in *this process* so we only emit the
// SSE notification once per context per day (instead of every blocked call).
const _throttleNotifiedToday = new Map<string, string>(); // context → utcDateLabel

/**
 * Returns the list of contexts that should currently be paused based on
 * today's per-context usage and the configured thresholds. The "noisiest"
 * contexts (highest unit count today) are pinned first.
 *
 * Cheap to call — single cache.get for the per-context map.
 */
async function getThrottledContextsAsync(): Promise<{
  contexts: string[];
  thresholdPct: number;
  percentUsed: number;
}> {
  if (!THROTTLE_ENABLED) {
    return { contexts: [], thresholdPct: THROTTLE_PCT_T1, percentUsed: 0 };
  }
  const used = (await cache.get<number>(quotaBucketKey())) ?? 0;
  const percentUsed = Math.min(100, Math.round((used / QUOTA_DAILY_LIMIT) * 100));
  if (percentUsed < THROTTLE_PCT_T1) {
    return { contexts: [], thresholdPct: THROTTLE_PCT_T1, percentUsed };
  }
  const ctx = (await cache.get<Record<string, number>>(quotaContextKey())) ?? {};
  const ranked = Object.entries(ctx)
    .map(([context, units]) => ({ context, units }))
    .sort((a, b) => b.units - a.units);
  // T2 → throttle top 2; T1 → throttle top 1.
  const topN = percentUsed >= THROTTLE_PCT_T2 ? 2 : 1;
  const contexts = ranked.slice(0, topN).map((r) => r.context);
  return {
    contexts,
    thresholdPct: percentUsed >= THROTTLE_PCT_T2 ? THROTTLE_PCT_T2 : THROTTLE_PCT_T1,
    percentUsed,
  };
}

/**
 * Public read-only accessor for the admin dashboard. Mirrors
 * `getThrottledContextsAsync` but lives here so admin.ts doesn't depend on
 * private helpers.
 */
export async function getYouTubeThrottleStatus(): Promise<{
  enabled: boolean;
  contexts: string[];
  thresholdPct: number;
  percentUsed: number;
  t1Pct: number;
  t2Pct: number;
}> {
  const s = await getThrottledContextsAsync();
  return {
    enabled: THROTTLE_ENABLED,
    contexts: s.contexts,
    thresholdPct: s.thresholdPct,
    percentUsed: s.percentUsed,
    t1Pct: THROTTLE_PCT_T1,
    t2Pct: THROTTLE_PCT_T2,
  };
}

/**
 * Last-N-days quota usage for the admin dashboard chart and per-context
 * breakdown for today. `dailyTotals` is ordered oldest → newest and always
 * contains exactly `QUOTA_HISTORY_DAYS` entries (zero-filled for missing days).
 */
export async function getYouTubeQuotaHistory(): Promise<{
  dailyTotals: Array<{ date: string; units: number }>;
  todayByContext: Array<{ context: string; units: number }>;
  dailyLimit: number;
}> {
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  const dailyTotals: Array<{ date: string; units: number }> = [];
  for (let i = QUOTA_HISTORY_DAYS - 1; i >= 0; i--) {
    const ts = now - i * oneDayMs;
    const date = utcDateLabel(ts);
    const units =
      (await cache.get<number>(`${QUOTA_USAGE_KEY_PREFIX}${date}`)) ?? 0;
    dailyTotals.push({ date, units });
  }
  const ctx =
    (await cache.get<Record<string, number>>(quotaContextKey())) ?? {};
  const todayByContext = Object.entries(ctx)
    .map(([context, units]) => ({ context, units }))
    .sort((a, b) => b.units - a.units);
  return {
    dailyTotals,
    todayByContext,
    dailyLimit: QUOTA_DAILY_LIMIT,
  };
}

/**
 * Snapshot of quota state for the admin operations dashboard. Returns the
 * estimated units consumed today, the configured daily limit, the percentage
 * used, and (if we've hit the gate) the exact reset timestamp. Always cheap,
 * always read-only.
 */
export async function getYouTubeQuotaStatus(): Promise<{
  estimatedUsedToday: number;
  dailyLimit: number;
  percentUsed: number;
  exhaustedUntil: string | null;
  exhausted: boolean;
  nextResetAt: string;
}> {
  const used = (await cache.get<number>(quotaBucketKey())) ?? 0;
  const exhaustedUntilMs = await cache.get<number>(QUOTA_EXHAUSTED_KEY);
  const isGated =
    typeof exhaustedUntilMs === "number" && exhaustedUntilMs > Date.now();
  return {
    estimatedUsedToday: used,
    dailyLimit: QUOTA_DAILY_LIMIT,
    percentUsed: Math.min(100, Math.round((used / QUOTA_DAILY_LIMIT) * 100)),
    exhaustedUntil: isGated ? new Date(exhaustedUntilMs!).toISOString() : null,
    exhausted: isGated,
    nextResetAt: new Date(nextQuotaResetMs()).toISOString(),
  };
}

// Compute the next quota reset (~ midnight Pacific = 08:00 UTC during PST,
// 07:00 UTC during PDT). We use 08:00 UTC as a safe upper bound; if we're
// already past 08:00 today, we target tomorrow 08:00 UTC.
function nextQuotaResetMs(now: number = Date.now()): number {
  const d = new Date(now);
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8, 0, 0, 0),
  );
  if (target.getTime() <= now) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime();
}

function isQuotaErrorBody(body: string): boolean {
  // We only need a substring check — Google's error JSON consistently
  // includes the literal "quotaExceeded" or "dailyLimitExceeded" reason.
  return (
    body.includes("quotaExceeded") ||
    body.includes("dailyLimitExceeded") ||
    body.includes("rateLimitExceeded")
  );
}

async function isQuotaGateActive(): Promise<boolean> {
  const until = await cache.get<number>(QUOTA_EXHAUSTED_KEY);
  return typeof until === "number" && until > Date.now();
}

async function setQuotaGate(): Promise<number> {
  const until = nextQuotaResetMs();
  const ttlMs = Math.max(60_000, until - Date.now());
  await cache.set(QUOTA_EXHAUSTED_KEY, until, ttlMs);
  return until;
}

/**
 * Wrapper around `fetch()` for youtube.googleapis.com endpoints that:
 *   - Skips the call if the quota gate is set (returns null with debug log).
 *   - Detects quota-exhaustion 403s, sets the gate, and warns at most once/hr.
 *   - Returns parsed JSON on 2xx, or null on any non-OK response (caller is
 *     expected to treat null as "no data this attempt").
 *   - Records best-effort daily quota usage so the admin dashboard can show
 *     how close we are to the cap before exhaustion.
 *
 * `costUnits` should match Google's documented cost for the endpoint:
 *   - search.list           → 100
 *   - playlistItems.list    →   1
 *   - videos.list           →   1
 *   - channels.list         →   1
 * Defaults to 1 (the cheapest read), which is correct for every call site
 * we make today except `search.list`.
 */
async function youtubeApiFetch<T>(
  url: string,
  context: string,
  costUnits: number = 1,
): Promise<T | null> {
  if (await isQuotaGateActive()) {
    logger.debug({ context }, "YouTube call skipped — quota gate active");
    return null;
  }

  // ── Pre-emptive auto-throttle ─────────────────────────────────────────────
  // If we're past the throttle threshold and this is one of the top callers,
  // skip the request to preserve quota for the more important / cheaper call
  // sites. This prevents ever hitting the hard 403 gate. Throttling resets
  // automatically at the next UTC day boundary because both the daily total
  // and the per-context map naturally roll to a new bucket.
  const throttle = await getThrottledContextsAsync();
  if (throttle.contexts.includes(context)) {
    const today = utcDateLabel();
    if (_throttleNotifiedToday.get(context) !== today) {
      _throttleNotifiedToday.set(context, today);
      logger.warn(
        {
          context,
          percentUsed: throttle.percentUsed,
          thresholdPct: throttle.thresholdPct,
          throttledContexts: throttle.contexts,
        },
        "YouTube call auto-throttled — pausing noisiest context for the rest of the day",
      );
      try {
        broadcastLiveEvent("youtube-quota-throttled", {
          context,
          percentUsed: throttle.percentUsed,
          thresholdPct: throttle.thresholdPct,
          throttledContexts: throttle.contexts,
        });
      } catch {
        // SSE broadcast best-effort.
      }
      // Page on-call (warning, not critical) — gives operators a chance to
      // intervene before we hit the hard quota gate. Dedup is per
      // context+day so each newly-throttled context fires once.
      void sendOpsAlert({
        severity: "warning",
        title: "YouTube quota auto-throttle engaged",
        message: `Pausing the noisiest YouTube call site for the rest of the UTC day to preserve remaining quota for cheaper / more important calls.`,
        fields: [
          { label: "Throttled context", value: context },
          { label: "Usage", value: `${throttle.percentUsed}% of daily limit` },
          { label: "Threshold", value: `${throttle.thresholdPct}%` },
          {
            label: "All paused",
            value: throttle.contexts.join(", "),
          },
        ],
        dedupKey: `youtube-quota-throttled:${context}:${today}`,
        dedupTtlSec: 24 * 60 * 60,
      }).catch(() => {});
    } else {
      logger.debug({ context }, "YouTube call skipped — auto-throttle active");
    }
    return null;
  }
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    logger.warn({ err, context }, "YouTube fetch failed (network/timeout)");
    return null;
  }
  if (res.ok) {
    // Attribute the cost only on successful responses — failed calls don't
    // count against quota in Google's accounting. Tagged with `context` so
    // the admin dashboard can show which call sites are burning units.
    void recordQuotaUsage(costUnits, context);
    try {
      return (await res.json()) as T;
    } catch (err) {
      logger.warn({ err, context }, "YouTube response was not valid JSON");
      return null;
    }
  }
  // Non-OK: read body, check for quota
  const body = await res.text().catch(() => "");
  if (res.status === 403 && isQuotaErrorBody(body)) {
    const until = await setQuotaGate();
    const now = Date.now();
    if (now - _lastQuotaWarnAtMs > 60 * 60 * 1000) {
      _lastQuotaWarnAtMs = now;
      logger.warn(
        {
          context,
          quotaResetAt: new Date(until).toISOString(),
          backoffMs: until - now,
        },
        "YouTube Data API quota exhausted — backing off until next reset",
      );
      // Real-time admin notification — admin dashboard shows a banner so
      // operators know YouTube features are degraded without having to
      // tail server logs. Only fired once per warn window (≥1h) so we don't
      // spam connected SSE clients during sustained exhaustion.
      try {
        broadcastLiveEvent("youtube-quota-exhausted", {
          context,
          quotaResetAt: new Date(until).toISOString(),
          backoffMs: until - now,
        });
      } catch {
        // SSE broadcast is best-effort; never let it break the API call.
      }
      // Page on-call: WARNING (not critical). Quota exhaustion is a routine
      // ceiling on the free 10K-units/day tier — the gate auto-clears at the
      // next UTC-08:00 reset, mobile/TV live detection cleanly falls back to
      // RSS/HTML, and the 24h dedup prevents spam. Tagging it `critical`
      // surfaced as ERROR-level log noise on every reset boundary (observed
      // in production at 2026-04-27T13:33:23Z) and would train operators to
      // ignore the critical channel. A real critical condition here would be
      // "RSS fallback is also failing" — that's caught separately by the
      // live-ingest health monitor, which DOES warrant critical.
      void sendOpsAlert({
        severity: "warning",
        title: "YouTube Data API quota exhausted",
        message:
          "All YouTube API features are paused until the quota resets. Mobile & TV live status will fall back to RSS/HTML detection.",
        fields: [
          { label: "Triggered by", value: context },
          {
            label: "Resets at",
            value: new Date(until).toISOString(),
          },
          {
            label: "Backoff",
            value: `${Math.round((until - now) / 60_000)} min`,
          },
        ],
        dedupKey: `youtube-quota-exhausted:${utcDateLabel()}`,
        dedupTtlSec: 24 * 60 * 60,
      }).catch(() => {});
    } else {
      logger.debug({ context }, "YouTube quota error (suppressed)");
    }
    return null;
  }
  // Genuine unexpected error — keep at error level (snippet only, not full body)
  logger.error(
    { context, status: res.status, errSnippet: body.slice(0, 300) },
    "YouTube API error (non-quota)",
  );
  return null;
}
const YOUTUBE_VIDEOS_CACHE_KEY = "youtube:videos";
const YOUTUBE_RSS_CACHE_KEY = "youtube:rss";
const LIVE_POLL_NORMAL_MS = 60 * 1000;
const LIVE_POLL_BURST_MS = 15 * 1000;
const BURST_WINDOW_MS = 10 * 60 * 1000;
const EXPO_PUSH_API = "https://exp.host/--/api/v2/push/send";

export interface LiveStatus {
  isLive: boolean;
  videoId: string | null;
  title: string | null;
  checkedAt: number;
  detectionMethod?: string;
}

let cachedLiveStatus: LiveStatus = {
  isLive: false,
  videoId: null,
  title: null,
  checkedAt: 0,
};

let lastStateChangeAt = 0;
let lastNotifiedVideoId: string | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let liveSessionStartedAt: number | null = null;
let currentPollIntervalMs = LIVE_POLL_NORMAL_MS;
let currentViewerCount: number | null = null;

export interface LiveEventRecord {
  ts: number;
  isLive: boolean;
  videoId: string | null;
  title: string | null;
  method: string | null;
}

export interface ViewerSnapshot {
  ts: number;
  count: number;
}

const MAX_HISTORY = 50;
const MAX_VIEWER_SNAPSHOTS = 120;
const liveHistory: LiveEventRecord[] = [];
const viewerHistory: ViewerSnapshot[] = [];

export function getLiveStatus(): LiveStatus {
  return { ...cachedLiveStatus };
}

/**
 * Returns the most-recent scraped concurrent viewer count for the
 * currently-live YouTube broadcast, or null if we're off-air or the
 * scrape hasn't run yet. Surfaced on /api/admin/stats and the
 * Mission Control hero so admins see real-time viewership.
 */
export function getLiveViewerCount(): number | null {
  return currentViewerCount;
}

export function getLiveMonitorData() {
  const uptimeSecs =
    cachedLiveStatus.isLive && liveSessionStartedAt
      ? Math.floor((Date.now() - liveSessionStartedAt) / 1000)
      : 0;
  return {
    current: {
      ...cachedLiveStatus,
      staleSec: Math.floor((Date.now() - cachedLiveStatus.checkedAt) / 1000),
      uptimeSecs,
      liveSessionStartedAt,
      viewerCount: currentViewerCount,
    },
    polling: {
      intervalMs: currentPollIntervalMs,
      mode: currentPollIntervalMs === LIVE_POLL_BURST_MS ? "burst" : "normal",
      lastStateChangeAt,
    },
    history: [...liveHistory].reverse(),
    viewerHistory: [...viewerHistory],
  };
}

async function checkViaOembed(): Promise<{ isLive: boolean; videoId: string | null; title: string | null }> {
  const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/@${CHANNEL_HANDLE}/live&format=json`;
  const response = await fetch(oembedUrl, {
    signal: AbortSignal.timeout(6000),
    headers: BROWSER_HEADERS,
  });
  if (!response.ok) return { isLive: false, videoId: null, title: null };
  const data = (await response.json()) as { title?: string; thumbnail_url?: string };
  const title = data.title ?? null;
  const thumbnailUrl = data.thumbnail_url ?? "";
  const videoIdMatch = thumbnailUrl.match(/\/vi\/([^/]+)\//);
  const videoId = videoIdMatch ? videoIdMatch[1] : null;
  const isLive = !!videoId && !!title;
  return { isLive, videoId, title };
}

async function checkViaYouTubeLivePage(): Promise<{ isLive: boolean; videoId: string | null; title: string | null }> {
  const url = `https://www.youtube.com/@${CHANNEL_HANDLE}/live`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: {
      ...BROWSER_HEADERS,
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!response.ok) return { isLive: false, videoId: null, title: null };
  const html = await response.text();

  const isLiveMatch = html.match(/"isLiveNow"\s*:\s*true/);
  const videoIdMatch = html.match(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/);
  const titleMatch = html.match(/"title"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([^"]+)"/);

  if (isLiveMatch && videoIdMatch) {
    return {
      isLive: true,
      videoId: videoIdMatch[1] ?? null,
      title: titleMatch?.[1] ?? "Live Stream",
    };
  }
  return { isLive: false, videoId: null, title: null };
}

async function scrapeViewerCount(videoId: string): Promise<number | null> {
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { ...BROWSER_HEADERS, Accept: "text/html,application/xhtml+xml" },
    });
    if (!response.ok) return null;
    const html = await response.text();

    const patterns = [
      /"concurrentViewers"\s*:\s*"(\d+)"/,
      /"viewCount"\s*:\s*\{\s*"videoViewCountRenderer"\s*:\s*\{\s*"viewCount"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([\d,]+)/,
      /"viewCount"\s*:\s*"(\d+)"/,
      /"watching_now"\s*:\s*(\d+)/,
      /(\d[\d,]*)\s+(?:watching|viewers?\s+now)/i,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        const count = parseInt(match[1].replace(/,/g, ""), 10);
        if (!isNaN(count) && count > 0) return count;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function checkYouTubeLive(): Promise<{ isLive: boolean; videoId: string | null; title: string | null; method: string }> {
  try {
    const result = await checkViaOembed();
    if (result.isLive) return { ...result, method: "oembed" };
  } catch {}

  try {
    const result = await checkViaYouTubeLivePage();
    if (result.isLive) return { ...result, method: "live-page" };
  } catch {}

  return { isLive: false, videoId: null, title: null, method: "all-failed" };
}

async function sendLiveAutoNotification(title: string, videoId: string | null) {
  try {
    const tokenRows = await db.select({ token: pushTokensTable.token }).from(pushTokensTable);
    const tokens = tokenRows.map((r: { token: string }) => r.token);
    if (tokens.length === 0) return;

    const messages = tokens.map((token: string) => ({
      to: token,
      title: "🔴 Temple TV is LIVE!",
      body: title,
      sound: "default",
      data: { type: "live", ...(videoId ? { videoId } : {}) },
    }));

    let sent = 0;
    let failed = 0;
    const CHUNK_SIZE = 100;
    for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
      const chunk = messages.slice(i, i + CHUNK_SIZE);
      try {
        const res = await fetch(EXPO_PUSH_API, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(chunk),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const result = (await res.json()) as { data?: Array<{ status: string }> };
          for (const s of result.data ?? []) {
            if (s.status === "ok") sent++;
            else failed++;
          }
        } else {
          failed += chunk.length;
        }
      } catch {
        failed += chunk.length;
      }
    }

    await db.insert(notificationsTable).values({
      id: randomUUID(),
      title: "Temple TV is LIVE!",
      body: title,
      type: "live",
      videoId: videoId ?? null,
      sentCount: sent,
    });

    logger.info({ sent, total: tokens.length }, "[LivePoller] Auto-notification sent");
  } catch (err) {
    logger.error({ err }, "[LivePoller] Failed to send auto-notification");
  }
}

async function pollLiveStatus() {
  const result = await checkYouTubeLive();
  const wasLive = cachedLiveStatus.isLive;
  const previousVideoId = cachedLiveStatus.videoId;

  const stateChanged = result.isLive !== wasLive || result.videoId !== previousVideoId;
  const now = Date.now();

  cachedLiveStatus = {
    isLive: result.isLive,
    videoId: result.videoId,
    title: result.title,
    checkedAt: now,
    detectionMethod: result.method,
  };

  if (stateChanged) {
    lastStateChangeAt = now;

    if (result.isLive && !wasLive) {
      liveSessionStartedAt = now;
      viewerHistory.length = 0;
    } else if (!result.isLive && wasLive) {
      liveSessionStartedAt = null;
      currentViewerCount = null;
    }

    const record: LiveEventRecord = {
      ts: now,
      isLive: result.isLive,
      videoId: result.videoId,
      title: result.title,
      method: result.method,
    };
    liveHistory.push(record);
    if (liveHistory.length > MAX_HISTORY) liveHistory.shift();

    broadcastLiveEvent("yt-status", {
      isLive: result.isLive,
      videoId: result.videoId,
      title: result.title,
      checkedAt: cachedLiveStatus.checkedAt,
    });
    emitBroadcastState("youtube-live-changed", {
      isLive: result.isLive,
      videoId: result.videoId,
      title: result.title,
      checkedAt: cachedLiveStatus.checkedAt,
    });

    // Also push the canonical `status` payload that the admin Mission
    // Control dashboard listens for. Without this, the dashboard would
    // only update on manual override actions or on next page load —
    // organic YouTube go-live transitions would silently leave the UI
    // stuck on "Off Air". Dynamic import avoids a circular dep with
    // lib/liveStatus (which imports getLiveStatus from this module).
    import("../lib/liveStatus")
      .then(({ buildLiveStatusPayload }) =>
        buildLiveStatusPayload().then((payload) =>
          broadcastLiveEvent("status", payload),
        ),
      )
      .catch((err) => {
        logger.warn(
          { err },
          "[LivePoller] failed to broadcast canonical status event",
        );
      });
  }

  if (result.isLive && result.videoId) {
    const count = await scrapeViewerCount(result.videoId);
    if (count !== null) {
      currentViewerCount = count;
      viewerHistory.push({ ts: now, count });
      if (viewerHistory.length > MAX_VIEWER_SNAPSHOTS) viewerHistory.shift();
    }
  }

  const justWentLive = result.isLive && (!wasLive || result.videoId !== previousVideoId);
  const isNewStream = result.isLive && result.videoId && result.videoId !== lastNotifiedVideoId;

  if (justWentLive && isNewStream && result.title) {
    lastNotifiedVideoId = result.videoId;
    logger.info(
      { method: result.method, title: result.title, videoId: result.videoId },
      "[LivePoller] New live stream detected",
    );
    await sendLiveAutoNotification(result.title, result.videoId);
  }

  const isInBurstWindow = now - lastStateChangeAt < BURST_WINDOW_MS;
  currentPollIntervalMs = isInBurstWindow ? LIVE_POLL_BURST_MS : LIVE_POLL_NORMAL_MS;

  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(pollLiveStatus, currentPollIntervalMs);
  // Don't block graceful shutdown on this background poll loop.
  pollTimer.unref();
}

pollLiveStatus();
startSSEHeartbeat();

export interface VideoItem {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  thumbnailUrl: string;
  channelName: string;
  duration: string;
  viewCount: string;
}

/**
 * Returns the cached video catalogue if available, falling back to the
 * in-memory stale cache. Designed for read-only consumers (e.g. sitemap
 * generation) that should never trigger a YouTube API fetch on the hot path.
 */
export async function getCachedVideosForSeo(): Promise<VideoItem[]> {
  const cached = await cache.get<VideoItem[]>(YOUTUBE_VIDEOS_CACHE_KEY);
  if (cached && cached.length > 0) return cached;
  if (_videosCacheFallback && _videosCacheFallback.videos.length > 0) {
    return _videosCacheFallback.videos;
  }
  return [];
}

// In-memory fallback if Redis not available (cache module handles tier selection)
let _videosCacheFallback: { videos: VideoItem[]; timestamp: number } | null = null;

async function fetchAllVideosFromApi(): Promise<VideoItem[] | null> {
  if (!YOUTUBE_API_KEY) return null;

  try {
    const videos: VideoItem[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        key: YOUTUBE_API_KEY,
        playlistId: UPLOADS_PLAYLIST_ID,
        part: "snippet",
        maxResults: "50",
      });
      if (pageToken) params.set("pageToken", pageToken);

      const data = await youtubeApiFetch<{
        nextPageToken?: string;
        items?: Array<{
          snippet: {
            title: string;
            description: string;
            publishedAt: string;
            channelTitle: string;
            resourceId: { videoId: string };
            thumbnails: {
              high?: { url: string };
              medium?: { url: string };
              default?: { url: string };
            };
          };
        }>;
      }>(
        `https://www.googleapis.com/youtube/v3/playlistItems?${params.toString()}`,
        "playlistItems",
      );
      if (!data) return null;

      const items = data.items ?? [];
      const videoIds = items
        .map((i) => i.snippet?.resourceId?.videoId)
        .filter(Boolean) as string[];

      let detailsMap: Record<string, { duration: string; viewCount: string }> = {};
      if (videoIds.length > 0) {
        const detailParams = new URLSearchParams({
          key: YOUTUBE_API_KEY,
          id: videoIds.join(","),
          part: "contentDetails,statistics",
        });
        const detailData = await youtubeApiFetch<{
          items?: Array<{
            id: string;
            contentDetails: { duration: string };
            statistics: { viewCount?: string };
          }>;
        }>(
          `https://www.googleapis.com/youtube/v3/videos?${detailParams.toString()}`,
          "videos.details",
        );
        // Missing details are non-fatal — the catalogue will simply omit
        // duration/viewCount for this batch and try again on the next sync.
        if (detailData?.items) {
          for (const d of detailData.items) {
            detailsMap[d.id] = {
              duration: d.contentDetails?.duration ?? "",
              viewCount: d.statistics?.viewCount ?? "0",
            };
          }
        }
      }

      for (const item of items) {
        const s = item.snippet;
        const vid = s?.resourceId?.videoId;
        if (!vid) continue;
        const thumb =
          s.thumbnails?.high?.url ||
          s.thumbnails?.medium?.url ||
          s.thumbnails?.default?.url ||
          `https://img.youtube.com/vi/${vid}/hqdefault.jpg`;
        videos.push({
          videoId: vid,
          title: s.title,
          description: s.description,
          publishedAt: s.publishedAt,
          thumbnailUrl: thumb,
          channelName: s.channelTitle || "Temple TV JCTM",
          duration: detailsMap[vid]?.duration ?? "",
          viewCount: detailsMap[vid]?.viewCount ?? "0",
        });
      }

      pageToken = data.nextPageToken;
    } while (pageToken);

    return videos.length > 0 ? videos : null;
  } catch (err) {
    logger.error({ err }, "fetchAllVideosFromApi error");
    return null;
  }
}

function videosToXml(videos: VideoItem[]): string {
  const entries = videos
    .map((v) => {
      const safeTitle = v.title
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return `
  <entry>
    <yt:videoId>${v.videoId}</yt:videoId>
    <title>${safeTitle}</title>
    <published>${v.publishedAt}</published>
    <media:thumbnail url="${v.thumbnailUrl}"/>
    <media:description><![CDATA[${v.description}]]></media:description>
    <name>${v.channelName}</name>
  </entry>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">${entries}</feed>`;
}

async function fetchDirect(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: BROWSER_HEADERS,
    });
    if (!response.ok) return null;
    const text = await response.text();
    return text.includes("<entry>") ? text : null;
  } catch {
    return null;
  }
}

async function fetchViaAllOrigins(rssUrl: string): Promise<string | null> {
  try {
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(rssUrl)}`;
    const response = await fetch(proxyUrl, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) return null;
    const json = (await response.json()) as { contents?: string };
    const contents = json.contents ?? "";
    return contents.includes("<entry>") ? contents : null;
  } catch {
    return null;
  }
}

async function fetchViaRss2Json(rssUrl: string): Promise<string | null> {
  try {
    const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}`;
    const response = await fetch(apiUrl, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const json = (await response.json()) as {
      status: string;
      items?: Array<{
        title: string;
        link: string;
        pubDate: string;
        description: string;
        thumbnail: string;
        author: string;
      }>;
    };
    if (json.status !== "ok" || !json.items?.length) return null;

    const items = json.items
      .map((item) => {
        const vidMatch = item.link.match(/v=([^&]+)/);
        const videoId = vidMatch?.[1] ?? "";
        if (!videoId) return "";
        const thumbUrl =
          item.thumbnail ||
          `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        return `
  <entry>
    <yt:videoId>${videoId}</yt:videoId>
    <title>${item.title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</title>
    <published>${item.pubDate}</published>
    <media:thumbnail url="${thumbUrl}"/>
    <media:description><![CDATA[${item.description}]]></media:description>
    <name>${item.author || "Temple TV JCTM"}</name>
  </entry>`;
      })
      .filter(Boolean)
      .join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">${items}</feed>`;
  } catch {
    return null;
  }
}

async function fetchVideosFromRss(): Promise<VideoItem[] | null> {
  const DIRECT_RSS_URLS = [
    `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
    `https://www.youtube.com/feeds/videos.xml?user=${CHANNEL_HANDLE}`,
  ];

  let xml: string | null = null;
  for (const url of DIRECT_RSS_URLS) {
    xml = await fetchDirect(url);
    if (xml) break;
  }
  if (!xml) xml = await fetchViaAllOrigins(DIRECT_RSS_URLS[0]!);
  if (!xml) xml = await fetchViaRss2Json(DIRECT_RSS_URLS[0]!);
  if (!xml) return null;

  const videos: VideoItem[] = [];
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(xml)) !== null) {
    const entry = match[1];
    const videoIdMatch = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    if (!videoIdMatch) continue;
    const videoId = videoIdMatch[1].trim();
    const titleMatch = entry.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim() : "";
    const publishedMatch = entry.match(/<published>([^<]+)<\/published>/i);
    const published = publishedMatch ? publishedMatch[1].trim() : "";
    const thumbMatch = entry.match(/<media:thumbnail[^>]+url="([^"]+)"/i);
    const thumbnailUrl = thumbMatch ? thumbMatch[1] : `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    const descMatch = entry.match(/<media:description[^>]*>([\s\S]*?)<\/media:description>/i);
    const description = descMatch ? descMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() : "";
    const nameMatch = entry.match(/<name>([^<]+)<\/name>/i);
    const channelName = nameMatch ? nameMatch[1].trim() : "Temple TV JCTM";
    if (videoId && title) {
      videos.push({ videoId, title, description, publishedAt: published, thumbnailUrl, channelName, duration: "", viewCount: "0" });
    }
  }
  return videos.length > 0 ? videos : null;
}

router.get("/youtube/videos", async (req, res) => {
  try {
    const cached = await cache.get<VideoItem[]>(YOUTUBE_VIDEOS_CACHE_KEY);
    if (cached !== null) {
      res.setHeader("X-Cache", "HIT");
      return void res.json({ videos: cached, total: cached.length });
    }

    let videos = await fetchAllVideosFromApi();

    if (!videos || videos.length === 0) {
      videos = await fetchVideosFromRss();
    }

    if (!videos || videos.length === 0) {
      // Serve stale memory fallback if available rather than returning an error
      if (_videosCacheFallback) {
        res.setHeader("X-Cache", "STALE");
        return void res.json({ videos: _videosCacheFallback.videos, total: _videosCacheFallback.videos.length });
      }
      return void res.status(502).json({ error: "Could not fetch videos from YouTube." });
    }

    await cache.set(YOUTUBE_VIDEOS_CACHE_KEY, videos, CACHE_TTL_MS);
    _videosCacheFallback = { videos, timestamp: Date.now() };
    res.setHeader("Cache-Control", "public, max-age=600");
    res.setHeader("X-Source", videos[0]?.duration ? "youtube-api" : "rss");
    return void res.json({ videos, total: videos.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/youtube/rss", async (req, res) => {
  try {
    const cachedXml = await cache.get<string>(YOUTUBE_RSS_CACHE_KEY);
    if (cachedXml !== null) {
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.setHeader("X-Cache", "HIT");
      return void res.send(cachedXml);
    }

    if (YOUTUBE_API_KEY) {
      const cachedVideos = await cache.get<VideoItem[]>(YOUTUBE_VIDEOS_CACHE_KEY);
      if (cachedVideos !== null) {
        const xml = videosToXml(cachedVideos);
        await cache.set(YOUTUBE_RSS_CACHE_KEY, xml, CACHE_TTL_MS);
        res.setHeader("Content-Type", "application/xml; charset=utf-8");
        res.setHeader("X-Source", "youtube-api-cached");
        return void res.send(xml);
      }
      const videos = await fetchAllVideosFromApi();
      if (videos && videos.length > 0) {
        await cache.set(YOUTUBE_VIDEOS_CACHE_KEY, videos, CACHE_TTL_MS);
        _videosCacheFallback = { videos, timestamp: Date.now() };
        const xml = videosToXml(videos);
        await cache.set(YOUTUBE_RSS_CACHE_KEY, xml, CACHE_TTL_MS);
        res.setHeader("Content-Type", "application/xml; charset=utf-8");
        res.setHeader("X-Source", "youtube-api");
        return void res.send(xml);
      }
    }

    const DIRECT_RSS_URLS = [
      `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
      `https://www.youtube.com/feeds/videos.xml?user=${CHANNEL_HANDLE}`,
    ];

    let xml: string | null = null;
    for (const url of DIRECT_RSS_URLS) {
      xml = await fetchDirect(url);
      if (xml) { res.setHeader("X-Source", "direct"); break; }
    }
    if (!xml) {
      xml = await fetchViaAllOrigins(DIRECT_RSS_URLS[0]!);
      if (xml) res.setHeader("X-Source", "allorigins");
    }
    if (!xml) {
      xml = await fetchViaRss2Json(DIRECT_RSS_URLS[0]!);
      if (xml) res.setHeader("X-Source", "rss2json");
    }

    if (!xml) {
      return void res.status(502).json({
        error: "Could not fetch YouTube RSS feed. Fallback data will be used.",
      });
    }

    await cache.set(YOUTUBE_RSS_CACHE_KEY, xml, CACHE_TTL_MS);
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=600");
    res.send(xml);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/youtube/live", async (req, res) => {
  try {
    // An active live override that pins a specific YouTube video ID always
    // wins over the channel auto-detector. This is the path the new admin
    // YouTube-URL feature flows through: when the admin pastes a URL and
    // hits Go Live, every viewer surface that polls /youtube/live (mobile
    // supervisor, web home page) immediately sees the override video and
    // navigates to it — no separate broadcast/current round-trip needed.
    const overrideVideoId = await getActiveOverrideYouTubeVideoId().catch(() => null);
    if (overrideVideoId) {
      cachedLiveStatus = {
        isLive: true,
        videoId: overrideVideoId.videoId,
        title: overrideVideoId.title,
        checkedAt: Date.now(),
        detectionMethod: "live-override",
      };
      return void res.json({
        isLive: true,
        videoId: overrideVideoId.videoId,
        title: overrideVideoId.title,
        source: "override",
      });
    }
    const result = await checkYouTubeLive();
    cachedLiveStatus = {
      isLive: result.isLive,
      videoId: result.videoId,
      title: result.title,
      checkedAt: Date.now(),
      detectionMethod: result.method,
    };
    res.json({ isLive: result.isLive, videoId: result.videoId, title: result.title });
  } catch {
    res.json({ isLive: false, videoId: null, title: null });
  }
});

/**
 * Returns the YouTube video ID + title from the currently-active live override
 * IFF the admin set one. Used by /youtube/live to give override-driven YouTube
 * broadcasts priority over the channel auto-detector.
 */
async function getActiveOverrideYouTubeVideoId(): Promise<{ videoId: string; title: string } | null> {
  const overrides = await db
    .select()
    .from(liveOverridesTable)
    .where(eq(liveOverridesTable.isActive, true))
    .orderBy(asc(liveOverridesTable.startedAt));
  const now = new Date();
  const active = overrides.find((o) => !o.endsAt || new Date(o.endsAt) > now);
  if (!active || !active.youtubeVideoId) return null;
  return { videoId: active.youtubeVideoId, title: active.title };
}

router.get("/youtube/live/status", async (_req, res) => {
  // Same override-takes-priority rule as /youtube/live, but evaluated on
  // every request (with a 5s in-route cache) so TV/web polls catch
  // newly-started YouTube overrides without waiting for the next channel
  // poll cycle. The TV's `useLiveStatus` polls this endpoint every 30s,
  // so this is the path that drives "admin pastes URL → TV switches".
  try {
    const override = await getActiveOverrideYouTubeVideoIdCached();
    if (override) {
      return void res.json({
        isLive: true,
        videoId: override.videoId,
        title: override.title,
        checkedAt: Date.now(),
        staleSec: 0,
        detectionMethod: "live-override",
        source: "override",
      });
    }
  } catch {
    // Fall through to cached status — never block the polling endpoint
    // on a DB hiccup.
  }
  res.json({
    isLive: cachedLiveStatus.isLive,
    videoId: cachedLiveStatus.videoId,
    title: cachedLiveStatus.title,
    checkedAt: cachedLiveStatus.checkedAt,
    staleSec: Math.floor((Date.now() - cachedLiveStatus.checkedAt) / 1000),
    detectionMethod: cachedLiveStatus.detectionMethod,
  });
});

/**
 * Viewer-side YouTube live embed failure telemetry.
 *
 * TV / mobile devices POST here when their YouTube live iframe fails to load
 * (load watchdog timeout, iframe `error` event, or `<YoutubePlayer>` onError
 * in live mode). The aggregated counts are surfaced on the admin Live Control
 * page so admins can spot platform-wide YouTube problems vs. one-off device
 * issues.
 *
 * Unauthenticated by design — viewer telemetry must work for anonymous TVs
 * and mobile guests too. Per-IP rate limiting in the lib protects against
 * abuse, and stored data is bounded + purely transient (5-min window, no DB).
 */
router.post("/live/report-failure", express.json({ limit: "1kb" }), (req, res) => {
  const body = (req.body ?? {}) as {
    videoId?: unknown;
    deviceId?: unknown;
    surface?: unknown;
  };
  const videoId = typeof body.videoId === "string" ? body.videoId.trim() : "";
  const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
  const rawSurface = typeof body.surface === "string" ? body.surface : "";

  // Validate videoId — YouTube IDs are 11 chars [A-Za-z0-9_-]. We accept up
  // to 32 to leave headroom for any future format change but reject obvious
  // junk so the ring stays clean.
  if (!videoId || videoId.length < 6 || videoId.length > 32 || !/^[A-Za-z0-9_-]+$/.test(videoId)) {
    return void res.status(400).json({ ok: false, error: "invalid_videoId" });
  }
  // DeviceId is opaque — we just need it stable per device. Anything between
  // 8–64 chars of url-safe characters is fine.
  if (!deviceId || deviceId.length < 8 || deviceId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(deviceId)) {
    return void res.status(400).json({ ok: false, error: "invalid_deviceId" });
  }
  const surface: LiveFailureSurface =
    rawSurface === "tv-hero" ||
    rawSurface === "tv-player" ||
    rawSurface === "mobile-hero" ||
    rawSurface === "mobile-player"
      ? rawSurface
      : "unknown";

  const result = recordFailureReport({
    videoId,
    deviceId,
    surface,
    ip: getClientIp(req),
  });
  if (!result.ok) {
    res.set("Retry-After", String(result.retryAfterSecs));
    return void res.status(429).json({ ok: false, error: result.reason });
  }
  res.status(204).end();
});

// 5-second in-process cache for the override probe. Polling clients
// (TV every 30s, mobile every 60s) plus shared-state coordination across
// Express workers means this endpoint can fire 1-2 times/sec in aggregate
// — caching keeps the load on `live_overrides` predictable.
let cachedOverrideProbe: { value: { videoId: string; title: string } | null; expiresAt: number } | null = null;
async function getActiveOverrideYouTubeVideoIdCached(): Promise<{ videoId: string; title: string } | null> {
  const now = Date.now();
  if (cachedOverrideProbe && cachedOverrideProbe.expiresAt > now) {
    return cachedOverrideProbe.value;
  }
  const value = await getActiveOverrideYouTubeVideoId();
  cachedOverrideProbe = { value, expiresAt: now + 5_000 };
  return value;
}

// ---------------------------------------------------------------------------
// Automatic YouTube channel catalogue sync
// ---------------------------------------------------------------------------
// Strategy:
//  1. On server boot run one sync immediately (warmup).
//  2. On warmup we seed the "known video IDs" set from whatever the YouTube
//     API returns so we DON'T spam every legacy video as a "new upload" push.
//  3. Every CATALOGUE_SYNC_INTERVAL_MS thereafter, refresh and detect any
//     IDs not in the set as freshly-uploaded → log + send a push.
//  4. The same routine is reused by the admin-triggered POST endpoint, but
//     callers from the endpoint pass `notifyOnNew=false` (avoid duplicates).
// ---------------------------------------------------------------------------
const CATALOGUE_SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const knownVideoIds = new Set<string>();
let catalogueWarmupComplete = false;
let catalogueSyncTimer: ReturnType<typeof setTimeout> | null = null;
let lastCatalogueSyncAt = 0;
let lastCatalogueSyncResult: {
  ok: boolean;
  total?: number;
  inserted?: number;
  updated?: number;
  skipped?: number;
  newVideoIds?: string[];
  error?: string;
  elapsedMs?: number;
  at: number;
} | null = null;

export function getCatalogueSyncStatus() {
  return {
    lastRunAt: lastCatalogueSyncAt,
    intervalMs: CATALOGUE_SYNC_INTERVAL_MS,
    knownVideoCount: knownVideoIds.size,
    warmupComplete: catalogueWarmupComplete,
    lastResult: lastCatalogueSyncResult,
  };
}

async function sendNewVideoNotification(video: VideoItem) {
  try {
    const tokenRows = await db.select({ token: pushTokensTable.token }).from(pushTokensTable);
    const tokens = tokenRows.map((r: { token: string }) => r.token);
    if (tokens.length === 0) return;

    const messages = tokens.map((token: string) => ({
      to: token,
      title: "🆕 New on Temple TV",
      body: video.title,
      sound: "default",
      data: { type: "video", videoId: video.videoId },
    }));

    let sent = 0;
    const CHUNK_SIZE = 100;
    for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
      const chunk = messages.slice(i, i + CHUNK_SIZE);
      try {
        const res = await fetch(EXPO_PUSH_API, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(chunk),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const result = (await res.json()) as { data?: Array<{ status: string }> };
          for (const s of result.data ?? []) if (s.status === "ok") sent++;
        }
      } catch {
        // ignore per-chunk failure; continue to next chunk
      }
    }

    await db.insert(notificationsTable).values({
      id: randomUUID(),
      title: "New on Temple TV",
      body: video.title,
      type: "video",
      videoId: video.videoId,
      sentCount: sent,
    });

    logger.info({ videoId: video.videoId, sent }, "[YouTubeSync] New-video notification sent");
  } catch (err) {
    logger.error({ err }, "[YouTubeSync] Failed to send new-video notification");
  }
}

export async function runYoutubeCatalogueSync(opts: { notifyOnNew?: boolean } = {}): Promise<{
  ok: boolean;
  total?: number;
  inserted?: number;
  updated?: number;
  skipped?: number;
  newVideoIds?: string[];
  error?: string;
  elapsedMs?: number;
}> {
  const startedAt = Date.now();
  if (!YOUTUBE_API_KEY) {
    const result = { ok: false, error: "youtube_api_key_missing", elapsedMs: 0 };
    lastCatalogueSyncAt = startedAt;
    lastCatalogueSyncResult = { ...result, at: startedAt };
    return result;
  }

  try {
    const fresh = await fetchAllVideosFromApi();
    if (!fresh || fresh.length === 0) {
      const result = { ok: false, error: "youtube_api_unavailable", elapsedMs: Date.now() - startedAt };
      lastCatalogueSyncAt = startedAt;
      lastCatalogueSyncResult = { ...result, at: startedAt };
      return result;
    }

    // Refresh in-memory + redis cache so /youtube/videos serves fast.
    await cache.set(YOUTUBE_VIDEOS_CACHE_KEY, fresh, CACHE_TTL_MS);
    _videosCacheFallback = { videos: fresh, timestamp: Date.now() };

    // Detect new videos relative to the in-memory known-set.
    const newVideos: VideoItem[] = [];
    if (catalogueWarmupComplete) {
      for (const v of fresh) {
        if (!knownVideoIds.has(v.videoId)) newVideos.push(v);
      }
    }
    for (const v of fresh) knownVideoIds.add(v.videoId);

    // Persist to DB so other surfaces (admin/videos table) reflect channel state.
    //
    // Memory/perf note: previously this loop fired one INSERT...ON CONFLICT
    // UPDATE per video on every 30-min tick. With 2117 videos that's 2117
    // round-trips even when zero rows actually changed — observed in logs as
    // `inserted: 0, updated: 2117`. Each driver round-trip allocates native
    // buffers (Node's `external` memory), and the sustained churn correlated
    // with RSS climbing from 1.2 GiB to 3.5 GiB on the all-in-one process.
    //
    // The skip-unchanged path: one SELECT pre-fetch keyed by youtubeId, then
    // we hash the YouTube-sourced content fields for each fresh video and
    // compare against the same hash computed from the existing row. If the
    // content hash matches AND the fresh viewCount isn't higher, we do
    // nothing — no UPDATE, no native buffer churn. Only genuinely new or
    // changed rows hit the database.
    const { db: dbInstance, videosTable } = await import("@workspace/db");
    const { sql } = await import("drizzle-orm");

    const hashContent = (
      title: string,
      description: string,
      thumbnailUrl: string,
      duration: string,
      publishedAt: string | null,
    ): string =>
      createHash("sha1")
        .update(title)
        .update("\u0001")
        .update(description)
        .update("\u0001")
        .update(thumbnailUrl)
        .update("\u0001")
        .update(duration)
        .update("\u0001")
        .update(publishedAt ?? "")
        .digest("hex");

    const youtubeIds = fresh.map((v) => v.videoId);
    type ExistingRow = {
      youtubeId: string;
      title: string;
      description: string;
      thumbnailUrl: string;
      duration: string;
      publishedAt: string | null;
      viewCount: number;
    };
    const existingRows: ExistingRow[] =
      youtubeIds.length === 0
        ? []
        : await dbInstance
            .select({
              youtubeId: videosTable.youtubeId,
              title: videosTable.title,
              description: videosTable.description,
              thumbnailUrl: videosTable.thumbnailUrl,
              duration: videosTable.duration,
              publishedAt: videosTable.publishedAt,
              viewCount: videosTable.viewCount,
            })
            .from(videosTable)
            .where(inArray(videosTable.youtubeId, youtubeIds));

    const existingByYoutubeId = new Map<string, ExistingRow>();
    for (const row of existingRows) existingByYoutubeId.set(row.youtubeId, row);

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    for (const v of fresh) {
      const freshTitle = v.title;
      const freshDescription = v.description ?? "";
      const freshThumbnailUrl = v.thumbnailUrl ?? "";
      const freshDuration = v.duration ?? "";
      const freshPublishedAt = v.publishedAt ?? null;
      const freshViewCount = Number(v.viewCount) || 0;

      const existing = existingByYoutubeId.get(v.videoId);
      if (existing) {
        const freshHash = hashContent(
          freshTitle,
          freshDescription,
          freshThumbnailUrl,
          freshDuration,
          freshPublishedAt,
        );
        const existingHash = hashContent(
          existing.title,
          existing.description,
          existing.thumbnailUrl,
          existing.duration,
          existing.publishedAt,
        );
        // Content unchanged AND viewCount can't move forward (GREATEST is a
        // no-op when fresh <= existing) → no UPDATE needed at all.
        if (freshHash === existingHash && freshViewCount <= existing.viewCount) {
          skipped += 1;
          continue;
        }
      }

      const result = await dbInstance
        .insert(videosTable)
        .values({
          id: randomUUID(),
          youtubeId: v.videoId,
          title: freshTitle,
          description: freshDescription,
          thumbnailUrl: freshThumbnailUrl,
          duration: freshDuration,
          category: "sermon",
          preacher: "",
          publishedAt: freshPublishedAt,
          viewCount: freshViewCount,
          featured: false,
          videoSource: "youtube",
        })
        .onConflictDoUpdate({
          target: videosTable.youtubeId,
          set: {
            title: freshTitle,
            description: freshDescription,
            thumbnailUrl: freshThumbnailUrl,
            duration: freshDuration,
            publishedAt: freshPublishedAt,
            viewCount: sql`GREATEST(${videosTable.viewCount}, ${freshViewCount})`,
          },
        })
        .returning({ id: videosTable.id, wasInsert: sql<boolean>`xmax = 0` });

      if (result[0]?.wasInsert) inserted += 1;
      else updated += 1;
    }

    if (!catalogueWarmupComplete) {
      catalogueWarmupComplete = true;
      logger.info({ totalSeeded: fresh.length }, "[YouTubeSync] Warmup complete (no notifications sent for seed)");
    } else if (opts.notifyOnNew && newVideos.length > 0) {
      // To avoid spamming, push notifications only for up to the 3 most recent new uploads.
      const sorted = [...newVideos].sort(
        (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
      );
      for (const v of sorted.slice(0, 3)) {
        await sendNewVideoNotification(v);
      }
    }

    const elapsedMs = Date.now() - startedAt;
    const summary = {
      ok: true as const,
      total: fresh.length,
      inserted,
      updated,
      skipped,
      newVideoIds: newVideos.map((v) => v.videoId),
      elapsedMs,
    };
    lastCatalogueSyncAt = startedAt;
    lastCatalogueSyncResult = { ...summary, at: startedAt };
    logger.info(summary, "[YouTubeSync] Catalogue sync complete");
    return summary;
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    logger.error({ err, elapsedMs }, "[YouTubeSync] Catalogue sync failed");
    const result = { ok: false, error: "sync_failed", elapsedMs };
    lastCatalogueSyncAt = startedAt;
    lastCatalogueSyncResult = { ...result, at: startedAt };
    return result;
  }
}

export function startYoutubeCatalogueScheduler() {
  const tick = async () => {
    try {
      await runYoutubeCatalogueSync({ notifyOnNew: true });
    } catch (err) {
      logger.error({ err }, "[YouTubeSync] Scheduled tick crashed");
    }
    catalogueSyncTimer = setTimeout(tick, CATALOGUE_SYNC_INTERVAL_MS);
    catalogueSyncTimer.unref();
  };
  // Kick off first run immediately on startup; subsequent runs every interval.
  if (catalogueSyncTimer) clearTimeout(catalogueSyncTimer);
  catalogueSyncTimer = setTimeout(tick, 0);
  catalogueSyncTimer.unref();
  logger.info({ intervalMs: CATALOGUE_SYNC_INTERVAL_MS }, "[YouTubeSync] Scheduler started");
}

router.post("/admin/youtube/sync", async (req, res) => {
  const result = await runYoutubeCatalogueSync({ notifyOnNew: false });
  if (!result.ok) {
    const status = result.error === "youtube_api_key_missing" ? 503 : 502;
    res.status(status).json(result);
    return;
  }
  res.json(result);
});

router.get("/admin/youtube/sync/status", (_req, res) => {
  res.json(getCatalogueSyncStatus());
});

router.get("/youtube/live/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Access-Control-Allow-Origin", "*");
  // Disable Nagle so each SSE frame is sent immediately (parity with
  // /broadcast/events — without this, frames could be coalesced).
  req.socket?.setNoDelay(true);
  res.flushHeaders();

  // Jittered retry hint AND first chunk written immediately. Some reverse
  // proxies (nginx, Cloudflare) hold the response in pending state until the
  // first body byte arrives — flushHeaders() alone is not enough — so the
  // retry comment doubles as a "wake the proxy" first chunk. Jitter range
  // matches /broadcast/events to spread reconnect waves identically.
  const retryMs = 3000 + Math.floor(Math.random() * 5000);
  try {
    res.write(`retry: ${retryMs}\n\n`);
    const r = res as unknown as { flush?: () => void };
    if (typeof r.flush === "function") r.flush();
  } catch {
    // Client hung up before we could write anything — nothing to clean up.
    return;
  }

  let client;
  try {
    client = addSSEClient(res, req.query.platform, getClientIp(req));
  } catch (e) {
    if (e instanceof SSECapacityError) {
      res.setHeader("Retry-After", String(e.retryAfterSecs));
      try { res.end(); } catch {}
      return;
    }
    throw e;
  }

  // The initial "connected" snapshot can throw if the client disconnects
  // between addSSEClient and the first write. Without try/catch this surfaces
  // as an unhandled error in the request scope. Wrapping it cleanly degrades
  // to "client never got initial state" — the next status broadcast will
  // catch them up anyway.
  try {
    res.write(`event: connected\ndata: ${JSON.stringify({
      isLive: cachedLiveStatus.isLive,
      videoId: cachedLiveStatus.videoId,
      title: cachedLiveStatus.title,
      checkedAt: cachedLiveStatus.checkedAt,
      ts: Date.now(),
    })}\n\n`);
  } catch {
    removeSSEClient(client);
    return;
  }

  req.on("close", () => removeSSEClient(client));
});

export default router;
