import { count, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import { invalidateVideosCatalogCache } from "../videos/videos.routes.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { isUndefinedColumnError } from "../../infrastructure/db-schema-guard.js";
import { scanLibraryAndEnqueue } from "../broadcast/auto-enqueue.service.js";

const CHANNEL_ID = "UCPFFvkE-KGpR37qJgvYriJg";
const YT_API_BASE = "https://www.googleapis.com/youtube/v3";
const RSS_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;

// ── 5-year content window ─────────────────────────────────────────────────────
const CONTENT_WINDOW_DAYS = Number(process.env.YOUTUBE_CONTENT_WINDOW_DAYS ?? 1825);
const CONTENT_WINDOW_MS   = CONTENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

function cutoffDate(): Date {
  return new Date(Date.now() - CONTENT_WINDOW_MS);
}

// ── Concurrency guard ─────────────────────────────────────────────────────────
// Prevents two concurrent syncs (scheduler + manual, rapid manual clicks)
// from running simultaneously and racing on the same 400+ row batch.

let _syncInProgress = false;
export function isSyncInProgress(): boolean { return _syncInProgress; }

// ── Content fingerprint ───────────────────────────────────────────────────────
// Tracks a compact fingerprint of the last successfully-synced video set so
// that scheduled (non-manual) syncs can skip the 17-batch DB upsert when
// nothing has changed since the previous run.
//
// Fingerprint format: sorted "videoId:durationSecs:titlePrefix20" tokens
// joined by "\n".  Including durationSecs and a title prefix catches the
// common cases where a video's metadata is edited after upload.  Sorting
// eliminates false "changed" signals from playlist reordering.
//
// This eliminates the primary idle CPU load: 423 videos × 17 DB batches
// every 15 minutes even when the YouTube channel has had no new uploads.
// Manual triggers (`triggeredBy = "manual"`) always bypass the check so
// operators can force a refresh from the admin panel.
let _lastSyncFingerprint: string | null = null;

function computeSyncFingerprint(videos: { videoId: string; durationSecs: number; title: string }[]): string {
  return videos
    .map((v) => `${v.videoId}:${v.durationSecs}:${v.title.slice(0, 20)}`)
    .sort()
    .join("\n");
}

// ── Enum allowlists ───────────────────────────────────────────────────────────
// The managed_videos columns are plain `text` — no PostgreSQL enum type —
// so any string passes the DB level. These sets encode what the application
// actually understands; values outside them are normalised to the default.

const VALID_VIDEO_SOURCES = new Set(["youtube", "local", "hls"]);
const VALID_TRANSCODING_STATUSES = new Set([
  "none", "queued", "encoding", "processing", "ready", "hls_ready", "failed",
]);
const VALID_SOURCE_CLEANUP_STATUSES = new Set([
  "none", "scheduled", "deleted", "skipped", "failed",
]);

// ── Quota tracking ────────────────────────────────────────────────────────────

interface QuotaEntry { cost: number; count: number }
interface QuotaState {
  used: number;
  total: number;
  resetsAt: string;
  operations: Array<{ operation: string; cost: number; count: number }>;
}
interface QuotaSnapshot {
  date: string;
  used: number;
  operations: Record<string, QuotaEntry>;
}

const quotaTracker = new Map<string, QuotaEntry>();
let quotaUsed = 0;
const QUOTA_TOTAL = Number(process.env.YOUTUBE_QUOTA_DAILY_LIMIT ?? 10_000);
const QUOTA_SNAPSHOT_KEY = "yt:quota:snapshot";

function nextMidnightUtc(): Date {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d;
}
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
let quotaResetAt = nextMidnightUtc();

function trackQuota(operation: string, cost: number): void {
  const now = new Date();
  if (now >= quotaResetAt) {
    quotaUsed = 0;
    quotaTracker.clear();
    quotaResetAt = nextMidnightUtc();
  }
  quotaUsed += cost;
  const entry = quotaTracker.get(operation) ?? { cost, count: 0 };
  entry.count++;
  quotaTracker.set(operation, entry);
}

export function getQuotaStatus(): QuotaState {
  const now = new Date();
  if (now >= quotaResetAt) {
    quotaUsed = 0;
    quotaTracker.clear();
    quotaResetAt = nextMidnightUtc();
  }
  return {
    used: quotaUsed,
    total: QUOTA_TOTAL,
    resetsAt: quotaResetAt.toISOString(),
    operations: Array.from(quotaTracker.entries()).map(([operation, entry]) => ({
      operation,
      cost: entry.cost,
      count: entry.count,
    })),
  };
}

async function persistQuota(): Promise<void> {
  const snapshot: QuotaSnapshot = {
    date: todayUtc(),
    used: quotaUsed,
    operations: Object.fromEntries(quotaTracker.entries()),
  };
  try {
    await db
      .insert(schema.appConfigTable)
      .values({ key: QUOTA_SNAPSHOT_KEY, value: JSON.stringify(snapshot) })
      .onConflictDoUpdate({
        target: schema.appConfigTable.key,
        set: { value: JSON.stringify(snapshot), updatedAt: new Date() },
      });
  } catch (err) {
    logger.warn({ err }, "youtube-sync: failed to persist quota snapshot (non-fatal)");
  }
}

export async function restoreQuota(): Promise<void> {
  try {
    const [row] = await db
      .select()
      .from(schema.appConfigTable)
      .where(eq(schema.appConfigTable.key, QUOTA_SNAPSHOT_KEY))
      .limit(1);
    if (!row) return;
    const snapshot = JSON.parse(row.value) as QuotaSnapshot;
    if (snapshot.date !== todayUtc()) return;
    quotaUsed = snapshot.used ?? 0;
    quotaTracker.clear();
    for (const [op, entry] of Object.entries(snapshot.operations ?? {})) {
      quotaTracker.set(op, entry);
    }
    logger.info({ used: quotaUsed, ops: quotaTracker.size }, "youtube-sync: quota restored from DB snapshot");
  } catch (err) {
    logger.warn({ err }, "youtube-sync: failed to restore quota snapshot (non-fatal)");
  }
}

// ── Sync state ────────────────────────────────────────────────────────────────

export interface SyncStatus {
  lastSyncId: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncSource: string | null;
  videosFound: number | null;
  videosInserted: number | null;
  videosUpdated: number | null;
  videosSkipped: number | null;
  videosDeleted: number | null;
  errorMessage: string | null;
  totalYoutubeVideos: number;
  nextSyncAt: string | null;
  contentWindowDays: number;
}

let nextSyncAt: Date | null = null;
export function setNextSyncAt(d: Date): void { nextSyncAt = d; }

export async function getSyncStatus(): Promise<SyncStatus> {
  const [lastLog] = await db
    .select()
    .from(schema.youtubeSyncLogTable)
    .orderBy(sql`${schema.youtubeSyncLogTable.startedAt} DESC`)
    .limit(1);

  const [totalRow] = await db
    .select({ c: count() })
    .from(schema.videosTable)
    .where(eq(schema.videosTable.videoSource, "youtube"));

  return {
    lastSyncId: lastLog?.id ?? null,
    lastSyncAt: lastLog?.completedAt?.toISOString() ?? lastLog?.startedAt?.toISOString() ?? null,
    lastSyncStatus: lastLog?.status ?? null,
    lastSyncSource: lastLog?.source ?? null,
    videosFound: lastLog?.videosFound ?? null,
    videosInserted: lastLog?.videosInserted ?? null,
    videosUpdated: lastLog?.videosUpdated ?? null,
    videosSkipped: lastLog?.videosSkipped ?? null,
    videosDeleted: lastLog?.videosDeleted ?? null,
    errorMessage: lastLog?.errorMessage ?? null,
    totalYoutubeVideos: Number(totalRow?.c ?? 0),
    nextSyncAt: nextSyncAt?.toISOString() ?? null,
    contentWindowDays: CONTENT_WINDOW_DAYS,
  };
}

// ── Duration parser ───────────────────────────────────────────────────────────

function parseDurationToSeconds(iso: string): number {
  if (!iso) return 0;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (
    (parseInt(match[1] ?? "0", 10) * 3600) +
    (parseInt(match[2] ?? "0", 10) * 60) +
    parseInt(match[3] ?? "0", 10)
  );
}

// ── Utility helpers ───────────────────────────────────────────────────────────

/** Pause execution for `ms` milliseconds. Used for retry backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sanitize a text field for PostgreSQL storage:
 * – Strip null bytes (\u0000) — PostgreSQL text columns reject them.
 * – Strip lone surrogates — invalid in UTF-8, rejected by pg.
 * – Truncate to `maxLen` code-units.
 */
function sanitizeText(val: string | null | undefined, maxLen: number): string {
  if (!val) return "";
  return val
    .replace(/\0/g, "")
    .replace(/[\uD800-\uDFFF]/g, "")
    .slice(0, maxLen);
}

/** Sanitize a URL — strip null bytes and cap length. */
function sanitizeUrl(val: string | null | undefined, maxLen = 2048): string {
  if (!val) return "";
  return val.replace(/\0/g, "").slice(0, maxLen);
}

/**
 * Validate a field value against an allowlist of known-good values.
 * If the value is not in the allowlist, the `fallback` is returned and a
 * warning is pushed to the `warnings` array so it appears in sync logs.
 */
function sanitizeEnum<T extends string>(
  val: string | null | undefined,
  allowlist: Set<string>,
  fallback: T,
  fieldName: string,
  warnings: string[],
): T {
  if (!val || !allowlist.has(val)) {
    if (val) warnings.push(`field "${fieldName}" had unknown value "${val.slice(0, 40)}" → normalised to "${fallback}"`);
    return fallback;
  }
  return val as T;
}

/**
 * Returns true for transient database errors that are safe to retry
 * (lock timeouts, serialisation failures, connection interruptions).
 * Returns false for permanent errors (constraint violations, type mismatches)
 * where retrying would simply fail again.
 */
function isTransientDbError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("lock timeout") ||
    msg.includes("deadlock") ||
    msg.includes("serialization failure") ||
    msg.includes("could not connect") ||
    msg.includes("connection") ||
    msg.includes("timeout") ||
    msg.includes("too many clients")
  );
}

// ── Date string validation ────────────────────────────────────────────────────

function isValidDateString(val: string | null | undefined): boolean {
  if (!val) return false;
  if (!/^\d{4}-\d{2}-\d{2}/.test(val)) return false;
  return !isNaN(new Date(val).getTime());
}

// ── Auto-categorization ───────────────────────────────────────────────────────

const CATEGORY_RULES: Array<{ category: string; keywords: string[] }> = [
  { category: "worship",     keywords: ["worship","praise","glory","choir","anthem","hymn","sing","worship night","praise night","music ministry"] },
  { category: "deliverance", keywords: ["deliverance","deliver","freedom","captive","bondage","oppression","stronghold","deliverance service","breaking chains"] },
  { category: "prophecy",    keywords: ["prophecy","prophetic","prophet","vision","revelation","oracle","word of the lord","thus saith","anointing"] },
  { category: "prayer",      keywords: ["prayer","prayer service","prayer meeting","intercession","intercessory","fasting","prayer and fasting","night prayer","prayer vigil","prayer points","midnight prayer"] },
  { category: "crusade",     keywords: ["crusade","revival","evangelism","evangelistic","outreach","open air","open-air","harvest","salvation crusade"] },
  { category: "conference",  keywords: ["conference","convention","summit","seminar","symposium","men's conference","women's conference","youth conference","ministers conference","pastors conference"] },
  { category: "testimony",   keywords: ["testimony","testimonies","testify","witness","miracle story","breakthrough story","what god did","thanksgiving testimony"] },
  { category: "faith",       keywords: ["faith","believe","trust","salvation","grace","gospel","scripture","bible study","word of god"] },
  { category: "special",     keywords: ["anniversary","special program","special service","ceremony","celebration","inauguration","dedication","ordination","crossover"] },
  { category: "teaching",    keywords: ["teaching","lesson","study","doctrine","truth","instruction","message","sermon","preach"] },
];

export function detectCategory(title: string, description: string): string {
  const titleLower = title.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((kw) => titleLower.includes(kw))) return rule.category;
  }
  if (description) {
    const descLower = description.slice(0, 300).toLowerCase();
    for (const rule of CATEGORY_RULES) {
      if (rule.keywords.some((kw) => descLower.includes(kw))) return rule.category;
    }
  }
  return "teaching";
}

// ── Preacher name extraction ──────────────────────────────────────────────────

const HONORIFICS = ["pastor","bishop","apostle","prophet","prophetess","rev","reverend","evangelist","dr","elder","deacon","minister","overseer"];
const HONORIFIC_PAT = HONORIFICS.join("|");

export function extractPreacher(title: string): string {
  const prefixMatch = title.match(
    new RegExp(`^((?:${HONORIFIC_PAT})\\.?\\s+(?:[A-ZÀ-ÖØ-öø-ÿ][a-zÀ-ÖØ-öø-ÿ']+(?:\\s+[A-ZÀ-ÖØ-öø-ÿ][a-zÀ-ÖØ-öø-ÿ']+){0,3}))\\s*[-|:–]`, "i"),
  );
  if (prefixMatch?.[1]) return prefixMatch[1].trim();

  const suffixMatch = title.match(
    new RegExp(`[-|:–]\\s*((?:${HONORIFIC_PAT})\\.?\\s+(?:[A-ZÀ-ÖØ-öø-ÿ][a-zÀ-ÖØ-öø-ÿ']+(?:\\s+[A-ZÀ-ÖØ-öø-ÿ][a-zÀ-ÖØ-öø-ÿ']+){0,3}))\\s*$`, "i"),
  );
  if (suffixMatch?.[1]) return suffixMatch[1].trim();

  return "";
}

// ── YouTube Data API v3 ───────────────────────────────────────────────────────

interface PlaylistItem {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  thumbnailUrl: string;
}

interface VideoDetails {
  duration: string;
  viewCount: string;
}

async function getUploadsPlaylistId(apiKey: string): Promise<string> {
  trackQuota("channels.list", 1);
  const url = `${YT_API_BASE}/channels?part=contentDetails&id=${CHANNEL_ID}&key=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`channels API ${res.status}`);
  const data = await res.json() as {
    items?: { contentDetails: { relatedPlaylists: { uploads: string } } }[];
  };
  const id = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!id) throw new Error("uploads playlist not found");
  return id;
}

async function getAllPlaylistItems(
  playlistId: string,
  apiKey: string,
  cutoff: Date,
): Promise<{ items: PlaylistItem[]; hitCutoff: boolean }> {
  const items: PlaylistItem[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  let hitCutoff = false;
  do {
    trackQuota("playlistItems.list", 1);
    const params = new URLSearchParams({
      part: "snippet", playlistId, maxResults: "50", key: apiKey,
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await fetch(`${YT_API_BASE}/playlistItems?${params}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`playlistItems API ${res.status}`);
    const data = await res.json() as {
      nextPageToken?: string;
      items?: {
        snippet: {
          resourceId: { videoId: string };
          title: string;
          description: string;
          publishedAt: string;
          thumbnails?: {
            maxres?: { url: string }; high?: { url: string };
            medium?: { url: string }; default?: { url: string };
          };
        };
      }[];
    };
    for (const item of data.items ?? []) {
      const s = item.snippet;
      const videoId = s.resourceId.videoId;
      if (!videoId || s.title === "Deleted video" || s.title === "Private video") continue;
      if (s.publishedAt && new Date(s.publishedAt) < cutoff) { hitCutoff = true; break; }
      const thumb =
        s.thumbnails?.maxres?.url ?? s.thumbnails?.high?.url ??
        s.thumbnails?.medium?.url ?? s.thumbnails?.default?.url ??
        `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
      items.push({ videoId, title: s.title, description: s.description ?? "", publishedAt: s.publishedAt, thumbnailUrl: thumb });
    }
    pageToken = data.nextPageToken;
    pages++;
    if (hitCutoff || pages > 100) break;
  } while (pageToken);
  return { items, hitCutoff };
}

async function getVideoDetailsBatch(videoIds: string[], apiKey: string): Promise<Map<string, VideoDetails>> {
  const map = new Map<string, VideoDetails>();
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    trackQuota("videos.list", 1);
    const params = new URLSearchParams({ part: "contentDetails,statistics", id: batch.join(","), key: apiKey });
    try {
      const res = await fetch(`${YT_API_BASE}/videos?${params}`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      const data = await res.json() as {
        items?: { id: string; contentDetails: { duration: string }; statistics: { viewCount?: string } }[];
      };
      for (const item of data.items ?? []) {
        map.set(item.id, { duration: item.contentDetails?.duration ?? "", viewCount: item.statistics?.viewCount ?? "0" });
      }
    } catch (err) {
      logger.warn({ err }, "youtube-sync: video details batch failed (non-fatal)");
    }
  }
  return map;
}

// ── RSS fallback ──────────────────────────────────────────────────────────────

interface RssVideo {
  videoId: string; title: string; description: string;
  publishedAt: string; thumbnailUrl: string;
}

function extractRssTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() : "";
}
function extractRssAttr(xml: string, tag: string, attr: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, "i"));
  return m ? m[1] : "";
}

async function fetchRssVideos(): Promise<RssVideo[]> {
  const res = await fetch(RSS_URL, {
    signal: AbortSignal.timeout(15_000),
    headers: { Accept: "application/xml, text/xml, */*", "User-Agent": "TempleTV-Sync/2.0" },
  });
  if (!res.ok) throw new Error(`YouTube RSS ${res.status}`);
  const xml = await res.text();
  const videos: RssVideo[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const e = m[1];
    const vidMatch = e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    if (!vidMatch) continue;
    const videoId = vidMatch[1].trim();
    const title = extractRssTag(e, "title") || extractRssTag(e, "media:title");
    if (!videoId || !title) continue;
    videos.push({
      videoId, title,
      description: extractRssTag(e, "media:description") || "",
      publishedAt: extractRssTag(e, "published"),
      thumbnailUrl: extractRssAttr(e, "media:thumbnail", "url") || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    });
  }
  return videos;
}

// ── Unified video shape ───────────────────────────────────────────────────────

interface NormalizedVideo {
  videoId: string; title: string; description: string;
  publishedAt: string; thumbnailUrl: string;
  durationSecs: number; viewCount: number;
  category: string; preacher: string;
}

async function fetchAllChannelVideos(
  apiKey: string, cutoff: Date,
): Promise<{ videos: NormalizedVideo[]; source: "youtube_api" | "rss"; skipped: number }> {
  try {
    logger.info({ cutoff: cutoff.toISOString() }, "youtube-sync: fetching channel library via Data API v3");
    const playlistId = await getUploadsPlaylistId(apiKey);
    const { items, hitCutoff } = await getAllPlaylistItems(playlistId, apiKey, cutoff);
    const videoIds = items.map((v) => v.videoId);
    const details = await getVideoDetailsBatch(videoIds, apiKey);
    const videos: NormalizedVideo[] = items.map((item) => {
      const d = details.get(item.videoId);
      return {
        videoId: item.videoId, title: item.title, description: item.description,
        publishedAt: item.publishedAt, thumbnailUrl: item.thumbnailUrl,
        durationSecs: d?.duration ? parseDurationToSeconds(d.duration) : 0,
        viewCount: d?.viewCount ? parseInt(d.viewCount, 10) : 0,
        category: detectCategory(item.title, item.description),
        preacher: extractPreacher(item.title),
      };
    });
    logger.info({ count: videos.length, hitCutoff }, "youtube-sync: Data API fetch complete");
    return { videos, source: "youtube_api", skipped: hitCutoff ? -1 : 0 };
  } catch (err) {
    logger.warn({ err }, "youtube-sync: Data API failed, falling back to RSS");
    const rss = await fetchRssVideos();
    const within = rss.filter((v) => !v.publishedAt || new Date(v.publishedAt) >= cutoff);
    return {
      videos: within.map((v) => ({
        videoId: v.videoId, title: v.title, description: v.description,
        publishedAt: v.publishedAt, thumbnailUrl: v.thumbnailUrl,
        durationSecs: 0, viewCount: 0,
        category: detectCategory(v.title, v.description),
        preacher: extractPreacher(v.title),
      })),
      source: "rss",
      skipped: rss.length - within.length,
    };
  }
}

async function fetchWithRssOnly(cutoff: Date): Promise<{ videos: NormalizedVideo[]; source: "rss"; skipped: number }> {
  const rss = await fetchRssVideos();
  const within = rss.filter((v) => !v.publishedAt || new Date(v.publishedAt) >= cutoff);
  return {
    videos: within.map((v) => ({
      videoId: v.videoId, title: v.title, description: v.description,
      publishedAt: v.publishedAt, thumbnailUrl: v.thumbnailUrl,
      durationSecs: 0, viewCount: 0,
      category: detectCategory(v.title, v.description),
      preacher: extractPreacher(v.title),
    })),
    source: "rss",
    skipped: rss.length - within.length,
  };
}

// ── Row shape ─────────────────────────────────────────────────────────────────

interface VideoRow {
  id: string;
  youtubeId: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  duration: string;
  viewCount: number;
  publishedAt: string | null;
  videoSource: string;
  category: string;
  preacher: string;
  transcodingStatus: string;
  sourceCleanupStatus: string;
}

// ── Per-row validation ────────────────────────────────────────────────────────
/**
 * Validate and fully sanitize a NormalizedVideo into a VideoRow.
 *
 * This function NEVER rejects — it returns a sanitized row plus a list of
 * warnings for any field that needed normalisation. Operators can inspect
 * warnings in the sync log to understand data quality issues without those
 * issues ever causing insertion failures.
 *
 * Sanitization applied:
 *  • text fields  — null bytes / lone surrogates stripped; length-capped
 *  • enum fields  — validated against allowlist; unknown values → canonical default
 *  • viewCount    — non-finite / negative values → 0
 *  • thumbnailUrl — must start with http(s)://; bad URLs → YT default thumbnail
 *  • publishedAt  — must be a valid ISO date string; invalid → null
 *  • title        — empty string after sanitization → "(untitled)"
 */
function buildAndValidateRow(v: NormalizedVideo): { row: VideoRow; warnings: string[] } {
  const warnings: string[] = [];

  // ── Text fields ──────────────────────────────────────────────────────────
  const rawTitle = sanitizeText(v.title, 500);
  const title = rawTitle || "(untitled)";
  if (!rawTitle) warnings.push("title was empty — set to (untitled)");

  const description  = sanitizeText(v.description, 8000);
  const preacher     = sanitizeText(v.preacher, 200);
  const rawCategory  = sanitizeText(v.category, 64);
  const category     = rawCategory || "teaching";

  // ── Thumbnail URL ────────────────────────────────────────────────────────
  const rawThumb = sanitizeUrl(v.thumbnailUrl);
  let thumbnailUrl = rawThumb;
  if (!thumbnailUrl.startsWith("http://") && !thumbnailUrl.startsWith("https://")) {
    thumbnailUrl = `https://img.youtube.com/vi/${v.videoId}/hqdefault.jpg`;
    if (rawThumb) warnings.push(`thumbnailUrl "${rawThumb.slice(0, 60)}" is not a valid URL — using YT default`);
  }

  // ── viewCount ────────────────────────────────────────────────────────────
  let viewCount = 0;
  if (Number.isFinite(v.viewCount) && v.viewCount >= 0) {
    viewCount = Math.floor(v.viewCount);
  } else if (v.viewCount !== 0) {
    warnings.push(`viewCount "${v.viewCount}" is invalid — set to 0`);
  }

  // ── publishedAt ──────────────────────────────────────────────────────────
  let publishedAt: string | null = null;
  if (v.publishedAt) {
    if (isValidDateString(v.publishedAt)) {
      publishedAt = v.publishedAt;
    } else {
      warnings.push(`publishedAt "${v.publishedAt.slice(0, 40)}" is not a valid ISO date — stored as null`);
    }
  }

  // ── Enum fields ──────────────────────────────────────────────────────────
  const videoSource = sanitizeEnum(
    "youtube", VALID_VIDEO_SOURCES, "youtube", "videoSource", warnings,
  );
  const transcodingStatus = sanitizeEnum(
    "none", VALID_TRANSCODING_STATUSES, "none", "transcodingStatus", warnings,
  );
  const sourceCleanupStatus = sanitizeEnum(
    "none", VALID_SOURCE_CLEANUP_STATUSES, "none", "sourceCleanupStatus", warnings,
  );

  // ── Duration ─────────────────────────────────────────────────────────────
  const duration = v.durationSecs > 0 ? String(v.durationSecs) : "";

  return {
    row: {
      id: `yt-${v.videoId}`,
      youtubeId: v.videoId,
      title, description, thumbnailUrl, duration,
      viewCount, publishedAt,
      videoSource, category, preacher,
      transcodingStatus, sourceCleanupStatus,
    },
    warnings,
  };
}

// ── DB upsert helper ──────────────────────────────────────────────────────────
// Targets the PRIMARY KEY (`id`) as the conflict target, not the nullable
// `youtubeId` unique index. Rationale:
//
//   id = yt-${youtubeId}  (deterministic — always set for YouTube rows)
//
// When BOTH the PK and youtube_id unique index would conflict on the SAME row
// PostgreSQL evaluates constraints in index-creation order. If the PK fires
// first and ON CONFLICT targets youtube_id, the PK violation is unhandled.
// Targeting the PK (`id`) removes the ambiguity while still satisfying the
// youtube_id unique constraint (same physical row).

async function upsertBatch(rows: VideoRow[]): Promise<void> {
  const v = schema.videosTable;
  // Full upsert: preserve admin-curated category/preacher when metadata_locked = true.
  // Falls back to a simpler upsert (always overwrite) if the column doesn't exist yet
  // in the production DB — only hit before the migration runs on next Render deploy.
  try {
    await db
      .insert(v)
      .values(rows)
      .onConflictDoUpdate({
        target: v.id,
        set: {
          title:        sql`excluded.title`,
          description:  sql`excluded.description`,
          thumbnailUrl: sql`excluded.thumbnail_url`,
          duration:     sql`excluded.duration`,
          viewCount:    sql`excluded.view_count`,
          publishedAt:  sql`excluded.published_at`,
          // Preserve admin-curated values when metadata_locked = true.
          category: sql`CASE WHEN managed_videos.metadata_locked THEN managed_videos.category ELSE excluded.category END`,
          preacher: sql`CASE WHEN managed_videos.metadata_locked THEN managed_videos.preacher ELSE excluded.preacher END`,
        },
      });
  } catch (err: unknown) {
    if (!isUndefinedColumnError(err, "metadata_locked")) throw err;
    // metadata_locked column not yet present in the production DB.
    // Retry without the lock guard — always overwrite category/preacher.
    await db
      .insert(v)
      .values(rows)
      .onConflictDoUpdate({
        target: v.id,
        set: {
          title:        sql`excluded.title`,
          description:  sql`excluded.description`,
          thumbnailUrl: sql`excluded.thumbnail_url`,
          duration:     sql`excluded.duration`,
          viewCount:    sql`excluded.view_count`,
          publishedAt:  sql`excluded.published_at`,
          category:     sql`excluded.category`,
          preacher:     sql`excluded.preacher`,
        },
      });
  }
}

// ── IngestionQueue ────────────────────────────────────────────────────────────
/**
 * Queue-based ingestion pipeline for YouTube video rows.
 *
 * Processing model:
 *   1. Rows are enqueued one at a time via enqueue().
 *   2. flush() processes them in chunks of CHUNK_SIZE (default 25).
 *      Smaller chunks lower the per-statement parameter count and reduce
 *      the blast radius of any single batch failure.
 *   3. If a batch fails, every row in that chunk is retried individually
 *      with exponential backoff (immediate → 300 ms → 1 000 ms).
 *      – Transient errors (lock timeout, connection, deadlock) get all
 *        three attempts.
 *      – Permanent errors (constraint, type) are logged and skipped after
 *        the first attempt to avoid wasting time.
 *   4. Each row's outcome (succeeded / failed) is tracked independently.
 *      A single bad row never affects its neighbours.
 *   5. flush() returns a detailed IngestionResult suitable for inclusion
 *      in the youtube_sync_log.error_message column.
 */

interface QueuedItem {
  row: VideoRow;
  warnings: string[];
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  lastError?: string;
}

export interface IngestionResult {
  succeeded: number;
  failed: number;
  totalAttempts: number;
  errors: string[];       // per-failed-row error summary
  warningRows: number;    // rows that needed field sanitization
  allWarnings: string[];  // up to 20 sample warnings for diagnostics
}

// Retry delays in ms for individual rows after a batch fails.
// Attempt 1 is immediate (0 ms), attempt 2 waits 300 ms, attempt 3 waits 1 000 ms.
const ROW_RETRY_DELAYS_MS = [0, 300, 1_000];
const MAX_ROW_RETRIES = ROW_RETRY_DELAYS_MS.length;

// Chunk size: 25 rows × ~13 params/row ≈ 325 parameters per statement,
// well under PostgreSQL's hard limit of 32 767 and comfortable for the
// pg client's default parameter buffer.
const CHUNK_SIZE = 25;

class IngestionQueue {
  private readonly items: QueuedItem[] = [];

  enqueue(row: VideoRow, warnings: string[]): void {
    this.items.push({ row, warnings, status: "pending", attempts: 0 });
  }

  get size(): number { return this.items.length; }

  /**
   * Process all queued rows and return a detailed result.
   * The queue is NOT cleared after flush — call clear() explicitly if reuse
   * is needed. This allows inspection of item statuses after the flush.
   */
  async flush(): Promise<IngestionResult> {
    // ── Pass 1: batch upserts ──────────────────────────────────────────────
    for (let i = 0; i < this.items.length; i += CHUNK_SIZE) {
      const chunk = this.items.slice(i, i + CHUNK_SIZE);
      const pending = chunk.filter((item) => item.status === "pending");
      if (pending.length === 0) continue;

      try {
        await upsertBatch(pending.map((item) => item.row));
        for (const item of pending) {
          item.status = "succeeded";
          item.attempts++;
        }
      } catch (batchErr) {
        const batchMsg = batchErr instanceof Error ? batchErr.message : String(batchErr);
        logger.warn(
          { chunkStart: i, chunkSize: pending.length, error: batchMsg.slice(0, 200) },
          "youtube-sync: batch upsert failed — falling back to per-row with retry",
        );

        // ── Pass 2 (per-row): retry each row with backoff ──────────────────
        for (const item of pending) {
          let succeeded = false;

          for (let attempt = 0; attempt < MAX_ROW_RETRIES && !succeeded; attempt++) {
            // Skip retry delay on first attempt; back off on subsequent ones.
            const delay = ROW_RETRY_DELAYS_MS[attempt] ?? 0;
            if (delay > 0) await sleep(delay);

            try {
              await upsertBatch([item.row]);
              item.status = "succeeded";
              item.attempts = attempt + 1;
              succeeded = true;
            } catch (rowErr) {
              item.attempts = attempt + 1;
              item.lastError = rowErr instanceof Error ? rowErr.message : String(rowErr);

              // Don't retry permanent errors — they will fail on every attempt.
              if (!isTransientDbError(rowErr)) {
                logger.warn(
                  {
                    youtubeId: item.row.youtubeId,
                    title: item.row.title.slice(0, 80),
                    attempt: attempt + 1,
                    error: item.lastError.slice(0, 300),
                  },
                  "youtube-sync: permanent row error — skipping retries",
                );
                break;
              }
            }
          }

          if (!succeeded) {
            item.status = "failed";
            logger.warn(
              {
                youtubeId: item.row.youtubeId,
                title: item.row.title.slice(0, 80),
                attempts: item.attempts,
                error: item.lastError?.slice(0, 300),
              },
              "youtube-sync: row permanently failed after all retries",
            );
          }
        }
      }
    }

    // ── Aggregate results ──────────────────────────────────────────────────
    const succeeded    = this.items.filter((i) => i.status === "succeeded").length;
    const failed       = this.items.filter((i) => i.status === "failed").length;
    const totalAttempts = this.items.reduce((sum, i) => sum + i.attempts, 0);

    const errors = this.items
      .filter((i) => i.status === "failed")
      .map((i) => `${i.row.youtubeId}(${i.row.title.slice(0, 40)}): ${(i.lastError ?? "unknown").slice(0, 200)}`);

    // Collect all warnings, capped at 20 samples to avoid log bloat.
    const allWarningsRaw = this.items.flatMap((i) => i.warnings.map((w) => `${i.row.youtubeId}: ${w}`));
    const warningRows    = this.items.filter((i) => i.warnings.length > 0).length;
    const allWarnings    = allWarningsRaw.slice(0, 20);

    return { succeeded, failed, totalAttempts, errors, warningRows, allWarnings };
  }

  clear(): void { this.items.length = 0; }
}

// ── Core sync ─────────────────────────────────────────────────────────────────

export interface SyncResult {
  syncId: string;
  inserted: number;
  updated: number;
  total: number;
  skipped: number;
  deleted: number;
  durationMs: number;
  source: "youtube_api" | "rss";
  rowErrors: number;
}

export async function syncYouTubeChannel(triggeredBy: "scheduler" | "manual" = "scheduler"): Promise<SyncResult> {
  // ── Concurrency guard ──────────────────────────────────────────────────────
  if (_syncInProgress) {
    logger.warn({ triggeredBy }, "youtube-sync: sync already in progress — skipping duplicate trigger");
    throw new Error("A YouTube sync is already in progress");
  }
  _syncInProgress = true;

  const t0     = Date.now();
  const syncId = nanoid();
  const cutoff = cutoffDate();

  await db.insert(schema.youtubeSyncLogTable).values({
    id: syncId, startedAt: new Date(), status: "running", triggeredBy,
  });

  try {
    // ── Fetch from YouTube / RSS ─────────────────────────────────────────────
    const apiKey = process.env.YOUTUBE_API_KEY;
    const { videos: rawVideos, source, skipped } = apiKey
      ? await fetchAllChannelVideos(apiKey, cutoff)
      : await fetchWithRssOnly(cutoff);

    // ── Deduplicate by videoId ───────────────────────────────────────────────
    // YouTube playlists can contain the same videoId in multiple positions
    // (reshared content, premieres, moved videos). Two rows with the same
    // id = yt-${videoId} in one INSERT batch produce a PK violation.
    const seen = new Set<string>();
    const videos: NormalizedVideo[] = [];
    for (const v of rawVideos) {
      if (!v.videoId || seen.has(v.videoId)) continue;
      seen.add(v.videoId);
      videos.push(v);
    }
    if (videos.length !== rawVideos.length) {
      logger.warn(
        { original: rawVideos.length, deduped: videos.length, dropped: rawVideos.length - videos.length },
        "youtube-sync: duplicate videoIds removed before ingestion",
      );
    }

    // ── Fingerprint check (scheduler-only fast-path) ─────────────────────────
    // Compute once here so it is available both for the early-exit guard below
    // AND for storing after a successful full upsert (so the next scheduler run
    // can skip when nothing has changed again).
    //
    // The fingerprint includes videoId, durationSecs, and a title prefix so
    // metadata edits (title changes, re-encoded durations) still trigger a
    // real upsert.  View-count updates are intentionally excluded — they
    // change on every video every sync and would defeat the optimisation
    // while providing no broadcast-critical value.
    //
    // Manual triggers always bypass the early-exit so operators get a
    // guaranteed fresh write from the admin panel.
    const currentFingerprint = computeSyncFingerprint(videos);
    if (triggeredBy === "scheduler" && _lastSyncFingerprint !== null && _lastSyncFingerprint === currentFingerprint) {
      const durationMs = Date.now() - t0;
      logger.info(
        { syncId, durationMs, count: videos.length },
        "youtube-sync: content fingerprint unchanged — skipping DB upsert (no new videos)",
      );
      await db
        .update(schema.youtubeSyncLogTable)
        .set({
          completedAt: new Date(),
          status: "completed",
          videosFound: rawVideos.length,
          videosInserted: 0,
          videosUpdated: 0,
          videosSkipped: videos.length,
          videosDeleted: 0,
          errorMessage: null,
          source,
        })
        .where(eq(schema.youtubeSyncLogTable.id, syncId));
      void persistQuota();
      return {
        syncId, inserted: 0, updated: 0, total: rawVideos.length,
        skipped: videos.length, deleted: 0, durationMs, source,
        rowErrors: 0,
      };
    }

    const videos_ = schema.videosTable;

    // Count rows before to derive inserted vs updated after.
    const [beforeRow] = await db.select({ c: count() }).from(videos_).where(eq(videos_.videoSource, "youtube"));
    const beforeCount = Number(beforeRow?.c ?? 0);

    // ── Pre-sync ID normalisation ────────────────────────────────────────────
    // If any YouTube video was previously stored with a non-canonical id
    // (not yt-${youtube_id}), the INSERT would trigger a youtube_id unique
    // constraint violation that our ON CONFLICT (id) clause cannot intercept.
    // Correct such rows before the batch runs.
    try {
      await db.execute(
        sql`UPDATE managed_videos
            SET id = 'yt-' || youtube_id
            WHERE video_source = 'youtube'
              AND youtube_id IS NOT NULL
              AND id != 'yt-' || youtube_id`,
      );
    } catch (normErr) {
      logger.warn({ err: normErr }, "youtube-sync: ID normalisation pass failed (non-fatal, continuing)");
    }

    // ── Build validated rows and feed the ingestion queue ───────────────────
    const queue = new IngestionQueue();
    const validationWarnings: string[] = [];

    for (const v of videos) {
      const { row, warnings } = buildAndValidateRow(v);
      if (warnings.length > 0) validationWarnings.push(...warnings.slice(0, 3).map((w) => `${v.videoId}: ${w}`));
      queue.enqueue(row, warnings);
    }

    if (validationWarnings.length > 0) {
      logger.info(
        { count: validationWarnings.length, samples: validationWarnings.slice(0, 5) },
        "youtube-sync: field sanitization warnings (rows still ingested with safe fallbacks)",
      );
    }

    // ── Flush the queue (batch → per-row → retry) ────────────────────────────
    const ingestion = await queue.flush();

    if (ingestion.warningRows > 0 || ingestion.allWarnings.length > 0) {
      logger.info(
        { warningRows: ingestion.warningRows, samples: ingestion.allWarnings.slice(0, 5) },
        "youtube-sync: ingestion field warnings summary",
      );
    }

    // ── 5-year cleanup pass ──────────────────────────────────────────────────
    // Delete YouTube rows that aged out of the rolling window.
    // Regex guard on the ::timestamptz cast prevents malformed published_at
    // values from throwing and falsely marking the sync as "failed".
    let deletedCount = 0;
    try {
      const cutoffIso = cutoff.toISOString();
      const staleRows = await db
        .select({ id: videos_.id })
        .from(videos_)
        .where(
          sql`${videos_.videoSource} = 'youtube'
              AND ${videos_.publishedAt} IS NOT NULL
              AND ${videos_.publishedAt} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
              AND ${videos_.publishedAt}::timestamptz < ${cutoffIso}::timestamptz`,
        );
      deletedCount = staleRows.length;
      if (deletedCount > 0) {
        await db.delete(videos_).where(
          sql`${videos_.videoSource} = 'youtube'
              AND ${videos_.publishedAt} IS NOT NULL
              AND ${videos_.publishedAt} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
              AND ${videos_.publishedAt}::timestamptz < ${cutoffIso}::timestamptz`,
        );
        logger.info({ deleted: deletedCount, cutoff: cutoffIso }, "youtube-sync: removed stale videos outside 5-year window");
      }
    } catch (cleanupErr) {
      // Non-fatal: all inserts already committed independently.
      logger.warn({ err: cleanupErr }, "youtube-sync: cleanup pass failed (non-fatal)");
    }

    // ── Compute stats ────────────────────────────────────────────────────────
    const [afterRow] = await db.select({ c: count() }).from(videos_).where(eq(videos_.videoSource, "youtube"));
    const afterCount  = Number(afterRow?.c ?? 0);
    const inserted    = Math.max(0, afterCount - (beforeCount - deletedCount));
    const updated     = Math.max(0, ingestion.succeeded - inserted);

    // ── Persist sync log ─────────────────────────────────────────────────────
    const finalStatus = ingestion.failed > 0 ? "completed_with_errors" : "completed";
    let errorSummary: string | null = null;
    if (ingestion.failed > 0) {
      const sample = ingestion.errors.slice(0, 5).join("; ");
      const more   = ingestion.errors.length > 5 ? ` … (+${ingestion.errors.length - 5} more)` : "";
      errorSummary = `${ingestion.failed} row(s) failed after ${MAX_ROW_RETRIES} attempts: ${sample}${more}`;
    }

    await db
      .update(schema.youtubeSyncLogTable)
      .set({
        completedAt:     new Date(),
        status:          finalStatus,
        videosFound:     rawVideos.length,
        videosInserted:  inserted,
        videosUpdated:   updated,
        videosSkipped:   skipped >= 0 ? skipped : null,
        videosDeleted:   deletedCount,
        errorMessage:    errorSummary,
        source,
      })
      .where(eq(schema.youtubeSyncLogTable.id, syncId));

    void invalidateVideosCatalogCache();
    adminEventBus.push("videos-library-updated", null);
    void persistQuota();

    // Auto-reflect newly-imported YouTube rows into the broadcast queue so
    // the 24/7 stream picks them up without an operator clicking "Add to
    // Queue" for every video. Fire-and-forget: a transient DB blip must not
    // fail the sync run, and the orchestrator's empty-queue self-heal also
    // scans for missing rows as a backstop. Library scan handles the case
    // where a previous auto-enqueue was disabled or skipped — re-enabling
    // catches up on the next sync without manual intervention.
    void scanLibraryAndEnqueue({ reason: "yt-sync", maxToAdd: 500 }).catch(
      (err) => logger.warn({ err }, "youtube-sync: post-sync auto-enqueue failed (non-fatal)"),
    );

    // Store the fingerprint of this successful full upsert so the next
    // scheduled run can short-circuit when the channel content is unchanged.
    _lastSyncFingerprint = currentFingerprint;

    const durationMs = Date.now() - t0;
    logger.info(
      {
        syncId, source, durationMs, status: finalStatus,
        rawFetched: rawVideos.length, deduped: videos.length,
        inserted, updated, skipped, deleted: deletedCount,
        ingestion: {
          succeeded:     ingestion.succeeded,
          failed:        ingestion.failed,
          totalAttempts: ingestion.totalAttempts,
          warningRows:   ingestion.warningRows,
          chunkSize:     CHUNK_SIZE,
        },
      },
      "youtube-sync: completed",
    );

    return {
      syncId, inserted, updated, total: rawVideos.length,
      skipped, deleted: deletedCount, durationMs, source,
      rowErrors: ingestion.failed,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.youtubeSyncLogTable)
      .set({ completedAt: new Date(), status: "failed", errorMessage })
      .where(eq(schema.youtubeSyncLogTable.id, syncId))
      .catch((updateErr) => {
        logger.error({ err: updateErr }, "youtube-sync: failed to update sync log on error (non-fatal)");
      });
    logger.error({ err, syncId }, "youtube-sync: sync failed");
    throw err;
  } finally {
    _syncInProgress = false;
  }
}
