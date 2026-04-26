import { Router } from "express";
import { db, videosTable, playlistsTable, playlistVideosTable, scheduleTable, notificationsTable, scheduledNotificationsTable, pushTokensTable, webPushSubscriptionsTable, liveOverridesTable, liveIngestEndpointsTable, transcodingJobsTable, broadcastQueueTable, usersTable, userWatchHistoryTable, prayerRequestsTable, s3UploadTelemetryTable, S3_TELEMETRY_EVENTS, type S3TelemetryEvent } from "@workspace/db";
import {
  generateStreamKey,
  probeHlsEndpoint,
  promoteEndpoint as promoteIngestEndpoint,
  runHealthSweep as runIngestHealthSweep,
  stopActiveIngestOverride,
  validateStreamKey,
} from "../lib/liveIngestHealth";
import { getVapidPublicKey, sendWebPushNotifications } from "../services/web-push";
import { eq, ilike, or, count, sql, desc, asc, and, lte, gte, inArray } from "drizzle-orm";
import { queueTranscodingJob, retryTranscodingJob, TRANSCODER_HEARTBEAT_KEY } from "../lib/transcoder";
import { isFfmpegReady } from "../lib/ffmpeg";
import { broadcastLiveEvent, addSSEClient, removeSSEClient, getSSEClientCount } from "../lib/liveEvents";
import {
  sendOpsAlert,
  getAlertingChannels,
  getLastAlertDelivery,
  getRecentAlerts,
} from "../lib/alerts";
import {
  getLiveStatus,
  getLiveMonitorData,
  getYouTubeQuotaStatus,
  getYouTubeQuotaHistory,
  getYouTubeThrottleStatus,
} from "./youtube";
import { emitBroadcastState } from "./broadcast";
import { cache } from "../lib/cache";
import { invalidatePublicVideoCaches, invalidatePublicPlaylistCaches } from "../lib/publicCacheInvalidation";
import { logger } from "../lib/logger";
import { metricsSnapshot } from "../middlewares/observability";
import { randomUUID, createHash, webcrypto } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { createWriteStream, createReadStream, existsSync } from "fs";
import multer from "multer";
import { validateUploadedFileMagicBytes } from "../lib/fileValidation";
import { BROADCAST_QUEUE_LOCK_KEY } from "../lib/broadcastQueueLock";
import {
  AWS_S3_BUCKET,
  AWS_REGION,
  isS3Configured,
  headObject as s3HeadObject,
  getSignedPutUrl as s3GetSignedPutUrl,
  getSignedGetUrl as s3GetSignedGetUrl,
  replaceObjectMetadata as s3ReplaceObjectMetadata,
  putObject as s3PutObject,
  createMultipartUpload as s3CreateMultipartUpload,
  signUploadPartUrl as s3SignUploadPartUrl,
  completeMultipartUpload as s3CompleteMultipartUpload,
  abortMultipartUpload as s3AbortMultipartUpload,
  S3_MULTIPART_MIN_PART_BYTES,
  S3_MULTIPART_MAX_PARTS,
} from "../lib/s3Storage";
import {
  ImportVideoBody,
  UpdateAdminVideoBody,
  UpdateAdminVideoParams,
  DeleteAdminVideoParams,
  ListAdminVideosQueryParams,
  CreatePlaylistBody,
  UpdatePlaylistBody,
  UpdatePlaylistParams,
  DeletePlaylistParams,
  GetPlaylistParams,
  AddVideoToPlaylistBody,
  AddVideoToPlaylistParams,
  RemoveVideoFromPlaylistParams,
  ReorderPlaylistBody,
  ReorderPlaylistParams,
  CreateScheduleEntryBody,
  UpdateScheduleEntryBody,
  UpdateScheduleEntryParams,
  DeleteScheduleEntryParams,
  SendPushNotificationBody,
  GetAnalyticsQueryParams,
} from "@workspace/api-zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, "..", "uploads"),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("video/") || file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only video and image files are allowed"));
    }
  },
});

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB — supports up to 64 MB adaptive chunks
});

const thumbnailUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, "..", "uploads"),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `thumb-${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files allowed for thumbnails"));
  },
});

interface ChunkedSession {
  id: string;
  ext: string;
  mimeType?: string;
  totalChunks: number;
  uploadedChunks: Set<number>;
  tmpDir: string;
  totalBytes: number;
  receivedBytes: number;
  metadata: {
    title: string;
    category: string;
    preacher: string;
    featured: boolean;
    durationSecs: number;
    originalFilename: string;
  };
  thumbnailPath?: string;
  createdAt: Date;
  lastActivity: Date;
  /**
   * True while /finalize is mid-flight. Guards against concurrent finalize calls
   * (double-click, proxy retry, network jitter) that would otherwise insert
   * duplicate DB rows and spawn duplicate transcoding jobs.
   */
  finalizing?: boolean;
}

/**
 * Tear down a session: clear any pending debounced disk-flush, drop the in-memory
 * entry, and remove the temp directory. Call this anywhere we delete a session.
 */
function destroyUploadSession(sessionId: string, tmpDir?: string): void {
  const pending = sessionFlushTimers.get(sessionId);
  if (pending) {
    clearTimeout(pending);
    sessionFlushTimers.delete(sessionId);
  }
  uploadSessions.delete(sessionId);
  if (tmpDir) {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

const uploadSessions = new Map<string, ChunkedSession>();

const SESSION_META_FILE = "session.json";

// ── Debounced session persistence ────────────────────────────────────────────
// Writing session metadata to disk on every chunk creates excessive disk I/O.
// Instead, flush at most once every 4 seconds per session, and always on finalize.
const sessionFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

async function flushSessionToDisk(session: ChunkedSession): Promise<void> {
  try {
    const meta = {
      id: session.id,
      ext: session.ext,
      totalChunks: session.totalChunks,
      uploadedChunks: Array.from(session.uploadedChunks),
      tmpDir: session.tmpDir,
      totalBytes: session.totalBytes,
      receivedBytes: session.receivedBytes,
      metadata: session.metadata,
      thumbnailPath: session.thumbnailPath,
      createdAt: session.createdAt.toISOString(),
      lastActivity: session.lastActivity.toISOString(),
    };
    await fs.writeFile(path.join(session.tmpDir, SESSION_META_FILE), JSON.stringify(meta));
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, "Failed to persist upload session metadata to disk");
  }
}

// Validate user-supplied stream URLs. Empty/null is allowed (means "use YouTube fallback").
// Reject anything other than http/https to block javascript:, data:, file:, etc.
function validateStreamUrl(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null || value === undefined || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "stream URL must be a string" };
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: null };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "stream URL is not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "stream URL must use http or https" };
  }
  return { ok: true, value: trimmed };
}

function writeSessionToDisk(session: ChunkedSession): void {
  // Debounce: cancel any pending write for this session and schedule a fresh one
  const existing = sessionFlushTimers.get(session.id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    sessionFlushTimers.delete(session.id);
    flushSessionToDisk(session).catch(() => {});
  }, 4000);
  sessionFlushTimers.set(session.id, timer);
}

async function getDirectorySizeBytes(dir: string): Promise<number> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const sizes = await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return getDirectorySizeBytes(fullPath);
      const stat = await fs.stat(fullPath).catch(() => null);
      return stat?.size ?? 0;
    }));
    return sizes.reduce((total, size) => total + size, 0);
  } catch {
    return 0;
  }
}

async function recoverSessionsFromDisk(): Promise<void> {
  try {
    const tmpRoot = path.join(__dirname, "..", "uploads", "tmp");
    await fs.mkdir(tmpRoot, { recursive: true });
    const entries = await fs.readdir(tmpRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(tmpRoot, entry.name, SESSION_META_FILE);
      try {
        const raw = await fs.readFile(metaPath, "utf-8");
        const meta = JSON.parse(raw) as {
          id: string; ext: string; totalChunks: number; uploadedChunks: number[];
          tmpDir: string; totalBytes: number; receivedBytes: number;
          metadata: ChunkedSession["metadata"]; thumbnailPath?: string;
          createdAt: string; lastActivity: string;
        };
        const lastActivity = new Date(meta.lastActivity);
        const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
        if (lastActivity < sixHoursAgo) {
          await fs.rm(meta.tmpDir, { recursive: true, force: true }).catch(() => {});
          continue;
        }
        const session: ChunkedSession = {
          id: meta.id,
          ext: meta.ext,
          totalChunks: meta.totalChunks,
          uploadedChunks: new Set(meta.uploadedChunks),
          tmpDir: meta.tmpDir,
          totalBytes: meta.totalBytes,
          receivedBytes: meta.receivedBytes,
          metadata: {
            ...meta.metadata,
            originalFilename: meta.metadata.originalFilename ?? "",
          },
          thumbnailPath: meta.thumbnailPath,
          createdAt: new Date(meta.createdAt),
          lastActivity,
        };
        uploadSessions.set(session.id, session);
        logger.info({ sessionId: session.id, uploadedChunks: session.uploadedChunks.size, totalChunks: session.totalChunks }, "Recovered upload session");
      } catch {}
    }
  } catch (err) {
    logger.error({ err }, "Upload session recovery failed");
  }
}

recoverSessionsFromDisk();

// .unref() so this background GC doesn't keep the event loop alive during
// graceful shutdown. We still want SIGTERM to exit cleanly within a second
// or two (Render's shutdown grace) instead of waiting on the 15s force-kill.
setInterval(() => {
  const inactiveCutoff = new Date(Date.now() - 6 * 60 * 60 * 1000);
  for (const [id, session] of uploadSessions.entries()) {
    if (session.lastActivity < inactiveCutoff) {
      // Skip GC for sessions actively being finalized — assembly may take
      // seconds-to-minutes for large files and we must not yank the rug out.
      if (session.finalizing) continue;
      destroyUploadSession(id, session.tmpDir);
    }
  }
}, 30 * 60 * 1000).unref();

async function autoExpireLiveOverrides(): Promise<void> {
  try {
    const now = new Date();
    // Atomic: find candidates first (cheap read), then guard each UPDATE with the
    // is_active=true predicate so concurrent runners can't double-expire and
    // double-emit SSE events. Only emit when our UPDATE actually changed a row.
    const expired = await db
      .update(liveOverridesTable)
      .set({ isActive: false })
      .where(
        and(
          eq(liveOverridesTable.isActive, true),
          lte(liveOverridesTable.endsAt, now),
        ),
      )
      .returning();

    if (expired.length === 0) return;

    await invalidateBroadcastCache();
    for (const override of expired) {
      logger.info({ liveOverrideId: override.id, title: override.title }, "Live override auto-expired");
      broadcastLiveEvent("override-expired", {
        id: override.id,
        title: override.title,
        expiredAt: now.toISOString(),
      });
      emitBroadcastState("live-override-expired", { id: override.id });
    }
    broadcastLiveEvent("status", await buildLiveStatusPayload());
  } catch (err) {
    logger.warn({ err }, "Auto-expire live overrides failed");
  }
}

async function buildLiveStatusPayload() {
  const liveOverride = await getActiveLiveOverride().catch(() => null);
  const ytStatus = getLiveStatus();
  const [deviceCountResult] = await db.select({ count: count() }).from(pushTokensTable).catch(() => [{ count: 0 }]);
  const deviceCount = Number((deviceCountResult as any)?.count ?? 0);
  const now = Date.now();
  return {
    isLive: !!(liveOverride || ytStatus.isLive),
    ytLive: ytStatus.isLive,
    ytVideoId: ytStatus.videoId,
    ytTitle: ytStatus.title,
    deviceCount,
    sseClients: getSSEClientCount(),
    liveOverride: liveOverride ? {
      id: liveOverride.id,
      title: liveOverride.title,
      startedAt: liveOverride.startedAt.toISOString(),
      endsAt: liveOverride.endsAt?.toISOString() ?? null,
      elapsedSecs: Math.floor((now - liveOverride.startedAt.getTime()) / 1000),
      remainingSecs: liveOverride.endsAt
        ? Math.max(0, Math.floor((liveOverride.endsAt.getTime() - now) / 1000))
        : null,
    } : null,
    ts: now,
  };
}

setInterval(autoExpireLiveOverrides, 30 * 1000).unref();
autoExpireLiveOverrides();

const router = Router();

const EXPO_PUSH_API = "https://exp.host/--/api/v2/push/send";

const BROADCAST_CACHE_KEYS = ["broadcast:live_override", "broadcast:schedule_entries", "broadcast:queue"] as const;

async function invalidateBroadcastCache(): Promise<void> {
  await Promise.all(BROADCAST_CACHE_KEYS.map((key) => cache.del(key)));
}

function parseDurationSecs(value: string | null | undefined): number {
  if (!value) return 1800;
  if (!value.includes(":") && !value.match(/[a-z]/i)) {
    const plain = Number(value);
    if (Number.isFinite(plain) && plain > 0) return Math.max(60, Math.round(plain));
  }
  const parts = value.split(":").map((part) => Number(part));
  if (parts.every((part) => Number.isFinite(part))) {
    if (parts.length === 3) return Math.max(60, parts[0]! * 3600 + parts[1]! * 60 + parts[2]!);
    if (parts.length === 2) return Math.max(60, parts[0]! * 60 + parts[1]!);
  }
  const minutesMatch = value.match(/(\d+)\s*m/i);
  if (minutesMatch?.[1]) return Math.max(60, Number(minutesMatch[1]) * 60);
  return 1800;
}

async function upsertBroadcastQueueVideo(video: typeof videosTable.$inferSelect): Promise<void> {
  const durationSecs = parseDurationSecs(video.duration);
  const streamUrl = video.hlsMasterUrl || video.localVideoUrl || null;

  // Acquire the advisory lock first, then run dedup-check + insert/update in a
  // single transaction. Without this, two concurrent calls for the same videoId
  // could both miss the existing-row check and insert duplicate rows.
  type AdminDbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  await db.transaction(async (tx: AdminDbTx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BROADCAST_QUEUE_LOCK_KEY})`);

    const [matching] = await tx
      .select({ id: broadcastQueueTable.id })
      .from(broadcastQueueTable)
      .where(eq(broadcastQueueTable.videoId, video.id))
      .limit(1);

    if (matching) {
      await tx
        .update(broadcastQueueTable)
        .set({
          youtubeId: video.youtubeId,
          title: video.title,
          thumbnailUrl: video.thumbnailUrl,
          durationSecs,
          localVideoUrl: streamUrl,
          videoSource: video.videoSource,
          isActive: true,
        })
        .where(eq(broadcastQueueTable.id, matching.id));
    } else {
      await tx.insert(broadcastQueueTable).values({
        id: randomUUID(),
        videoId: video.id,
        youtubeId: video.youtubeId,
        title: video.title,
        thumbnailUrl: video.thumbnailUrl,
        durationSecs,
        localVideoUrl: streamUrl,
        videoSource: video.videoSource,
        isActive: true,
        sortOrder: sql`COALESCE((SELECT MAX(${broadcastQueueTable.sortOrder}) + 1 FROM ${broadcastQueueTable}), 0)`,
      });
    }
  });

  await invalidateBroadcastCache();
  broadcastLiveEvent("broadcast-queue-updated", {
    videoId: video.id,
    youtubeId: video.youtubeId,
    title: video.title,
    queuedAt: new Date().toISOString(),
  });
  emitBroadcastState("queue-video-upserted", { videoId: video.id });
}

async function getActiveLiveOverride() {
  const overrides = await db
    .select()
    .from(liveOverridesTable)
    .where(eq(liveOverridesTable.isActive, true))
    .orderBy(desc(liveOverridesTable.startedAt));
  const now = new Date();
  return overrides.find((override: typeof liveOverridesTable.$inferSelect) => !override.endsAt || override.endsAt > now) ?? null;
}

async function sendExpoPushNotifications(
  tokens: string[],
  title: string,
  body: string,
  data: Record<string, unknown> = {}
): Promise<{ sent: number; failed: number }> {
  if (tokens.length === 0) return { sent: 0, failed: 0 };

  const messages = tokens.map((token) => ({
    to: token,
    title,
    body,
    sound: "default",
    data,
  }));

  const CHUNK_SIZE = 100;
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
    const chunk = messages.slice(i, i + CHUNK_SIZE);
    try {
      const res = await fetch(EXPO_PUSH_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
        },
        body: JSON.stringify(chunk),
        signal: AbortSignal.timeout(15000),
      });

      if (res.ok) {
        const result = (await res.json()) as { data?: Array<{ status: string }> };
        const statuses = result.data ?? [];
        for (const s of statuses) {
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

  return { sent, failed };
}

const ADMIN_STATS_CACHE_KEY = "admin:stats:v1";
const ADMIN_STATS_TTL_MS = 2 * 60 * 1000; // 2 minutes

router.get("/admin/stats", async (req, res) => {
  try {
    const cached = await cache.get<object>(ADMIN_STATS_CACHE_KEY);
    if (cached) {
      res.json(cached);
      return;
    }

    const [
      [totalVideosResult],
      [totalPlaylistsResult],
      [activeScheduleResult],
      [recentImportsResult],
      [todayNotifResult],
      [registeredNativeDevicesResult],
      [registeredWebDevicesResult],
      [registeredUsersResult],
      categoryCounts,
    ] = await Promise.all([
      db.select({ count: count() }).from(videosTable),
      db.select({ count: count() }).from(playlistsTable),
      db.select({ count: count() }).from(scheduleTable).where(eq(scheduleTable.isActive, true)),
      db.select({ count: count() }).from(videosTable).where(sql`imported_at > now() - interval '7 days'`),
      db.select({ count: count() }).from(notificationsTable).where(sql`sent_at > now() - interval '1 day'`),
      db.select({ count: count() }).from(pushTokensTable),
      db.select({ count: count() }).from(webPushSubscriptionsTable),
      db.select({ count: count() }).from(usersTable),
      db.select({ category: videosTable.category, count: count() }).from(videosTable).groupBy(videosTable.category).orderBy(desc(count())).limit(1),
    ]);
    const registeredDevicesResult = {
      count: Number(registeredNativeDevicesResult?.count ?? 0) + Number(registeredWebDevicesResult?.count ?? 0),
    };

    let liveStatus = { isLive: false, viewerCount: 0 };
    try {
      const liveRes = await fetch(
        "https://www.youtube.com/oembed?url=https://www.youtube.com/@templetvjctm/live&format=json",
        { signal: AbortSignal.timeout(5000) }
      );
      if (liveRes.ok) {
        const d = (await liveRes.json()) as { title?: string; thumbnail_url?: string };
        const vidMatch = (d.thumbnail_url ?? "").match(/\/vi\/([^/]+)\//);
        liveStatus.isLive = !!(vidMatch?.[1] && d.title);
      }
    } catch {}

    const liveOverride = await getActiveLiveOverride();
    if (liveOverride) {
      liveStatus.isLive = true;
    }

    const payload = {
      totalVideos: totalVideosResult?.count ?? 0,
      totalPlaylists: totalPlaylistsResult?.count ?? 0,
      activeScheduleEntries: activeScheduleResult?.count ?? 0,
      notificationsSentToday: todayNotifResult?.count ?? 0,
      isLiveNow: liveStatus.isLive,
      liveViewerEstimate: liveStatus.viewerCount,
      recentImports: recentImportsResult?.count ?? 0,
      topCategory: categoryCounts[0]?.category ?? "sermon",
      registeredDevices: registeredDevicesResult?.count ?? 0,
      registeredUsers: Number(registeredUsersResult?.count ?? 0),
    };

    await cache.set(ADMIN_STATS_CACHE_KEY, payload, ADMIN_STATS_TTL_MS);
    res.json(payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/admin/users", async (req, res) => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.trim() : undefined;
    const page = Math.max(1, Number(req.query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
    const offset = (page - 1) * limit;

    const where = search
      ? or(ilike(usersTable.email, `%${search}%`), ilike(usersTable.displayName, `%${search}%`))
      : undefined;

    const [totalResult] = await db
      .select({ count: count() })
      .from(usersTable)
      .where(where);

    const rows = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        displayName: usersTable.displayName,
        avatarUrl: usersTable.avatarUrl,
        emailVerified: usersTable.emailVerified,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .where(where)
      .orderBy(desc(usersTable.createdAt))
      .limit(limit)
      .offset(offset);

    const total = Number(totalResult?.count ?? 0);

    res.json({
      users: rows,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

/**
 * Real-time YouTube Data API quota status — used by the admin dashboard to
 * show a banner before the daily 10,000-unit limit is reached. Without this
 * the first sign of trouble was a flood of `quotaExceeded` 403s in the logs.
 *
 * `estimatedUsedToday` is best-effort — we attribute each successful call by
 * its documented cost (search=100, list endpoints=1) since Google doesn't
 * expose a "real consumed units" query. Counter persists in the distributed
 * cache so it survives restarts and is shared across replicas.
 */
router.get("/admin/youtube/quota", async (_req, res) => {
  try {
    const [status, throttle] = await Promise.all([
      getYouTubeQuotaStatus(),
      getYouTubeThrottleStatus(),
    ]);
    // Bundle throttle state into the status payload so the banner and
    // headline card can render without a second round-trip.
    res.json({ ...status, throttle });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

/**
 * Ops alerting status — channels configured + last delivery telemetry.
 * Lets operators verify alerting is wired up without having to trigger a
 * real incident.
 */
router.get("/admin/alerts/status", async (_req, res) => {
  try {
    const [channels, lastDelivery] = await Promise.all([
      Promise.resolve(getAlertingChannels()),
      getLastAlertDelivery(),
    ]);
    res.json({
      channels,
      configured: channels.slack || channels.webhook,
      lastDelivery,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

/**
 * Rolling history of recent ops alerts (newest first). Capped at 100 entries
 * server-side; client may further narrow with `?limit=N`. Includes both real
 * deliveries and dedup-suppressed events so operators can debug "why didn't
 * I get paged?" without tailing logs.
 */
router.get("/admin/alerts/history", async (req, res) => {
  try {
    const raw = req.query.limit;
    const limit =
      typeof raw === "string" && /^\d+$/.test(raw)
        ? Math.min(100, Math.max(1, Number(raw)))
        : undefined;
    const entries = await getRecentAlerts(limit);
    res.json({ entries, count: entries.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

/**
 * Send a test alert through every configured channel. No dedup so operators
 * can re-trigger as many times as they need to verify their receiving end.
 */
router.post("/admin/alerts/test", async (_req, res) => {
  try {
    const result = await sendOpsAlert({
      severity: "info",
      title: "Test alert from JCTM ops",
      message:
        "If you can see this, your alerting webhook(s) are wired up correctly. This message was triggered manually from the admin dashboard and is safe to ignore.",
      fields: [
        { label: "Triggered at", value: new Date().toISOString() },
        { label: "Source", value: "admin /admin/alerts/test" },
      ],
    });
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

/**
 * Historical YouTube quota usage — last 7 daily totals (oldest first) plus
 * today's per-context breakdown. Drives the YouTube Quota detail page so
 * operators can see which scheduler is burning units BEFORE the gate engages.
 */
router.get("/admin/youtube/quota/history", async (_req, res) => {
  try {
    const history = await getYouTubeQuotaHistory();
    res.json(history);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/admin/ops/status", async (_req, res) => {
  const generatedAt = new Date();
  const uploadsDir = path.join(__dirname, "..", "uploads");
  const hlsDir = path.join(uploadsDir, "hls");

  try {
    const [
      dbProbe,
      totalVideosResult,
      localVideosResult,
      totalPlaylistsResult,
      activeScheduleResult,
      nativeDevicesResult,
      webDevicesResult,
      activeBroadcastResult,
      inactiveBroadcastResult,
      liveOverrideResult,
      processingJobsResult,
      queuedJobsResult,
      doneJobsResult,
      failedJobsResult,
      cancelledJobsResult,
      uploadBytes,
      hlsBytes,
    ] = await Promise.all([
      db.execute(sql`select 1 as ok`).then(() => true).catch(() => false),
      db.select({ count: count() }).from(videosTable),
      db.select({ count: count() }).from(videosTable).where(eq(videosTable.videoSource, "local")),
      db.select({ count: count() }).from(playlistsTable),
      db.select({ count: count() }).from(scheduleTable).where(eq(scheduleTable.isActive, true)),
      db.select({ count: count() }).from(pushTokensTable),
      db.select({ count: count() }).from(webPushSubscriptionsTable),
      db.select({ count: count() }).from(broadcastQueueTable).where(eq(broadcastQueueTable.isActive, true)),
      db.select({ count: count() }).from(broadcastQueueTable).where(eq(broadcastQueueTable.isActive, false)),
      db.select({ count: count() }).from(liveOverridesTable).where(eq(liveOverridesTable.isActive, true)),
      db.select({ count: count() }).from(transcodingJobsTable).where(eq(transcodingJobsTable.status, "processing")),
      db.select({ count: count() }).from(transcodingJobsTable).where(eq(transcodingJobsTable.status, "queued")),
      db.select({ count: count() }).from(transcodingJobsTable).where(eq(transcodingJobsTable.status, "done")),
      db.select({ count: count() }).from(transcodingJobsTable).where(eq(transcodingJobsTable.status, "failed")),
      db.select({ count: count() }).from(transcodingJobsTable).where(eq(transcodingJobsTable.status, "cancelled")),
      getDirectorySizeBytes(uploadsDir),
      getDirectorySizeBytes(hlsDir),
    ]);

    const processingJobs = Number(processingJobsResult[0]?.count ?? 0);
    const queuedJobs = Number(queuedJobsResult[0]?.count ?? 0);
    const failedJobs = Number(failedJobsResult[0]?.count ?? 0);
    const activeBroadcastItems = Number(activeBroadcastResult[0]?.count ?? 0);
    const activeLiveOverrides = Number(liveOverrideResult[0]?.count ?? 0);
    const dbConnected = Boolean(dbProbe);
    const cacheStatus = cache.status();

    const s3Bucket = process.env.AWS_S3_BUCKET?.trim() ?? "";
    const s3Region = process.env.AWS_REGION?.trim() ?? "";
    const s3CredsPresent = Boolean(
      process.env.AWS_ACCESS_KEY_ID?.trim() &&
        process.env.AWS_SECRET_ACCESS_KEY?.trim(),
    );
    const publicObjectPaths = process.env.PUBLIC_OBJECT_SEARCH_PATHS?.trim() ?? "";
    const privateObjectDir = process.env.PRIVATE_OBJECT_DIR?.trim() ?? "";
    const objectStorageConfigured = Boolean(
      s3Bucket && s3Region && s3CredsPresent && publicObjectPaths && privateObjectDir,
    );

    const checks = [
      { key: "api", label: "API process", status: "ok" },
      { key: "database", label: "Database", status: dbConnected ? "ok" : "critical" },
      {
        key: "cache",
        label: "Distributed cache",
        status: (cacheStatus.redis?.connected || cacheStatus.postgresql?.connected) ? "ok" : "degraded",
      },
      {
        key: "object_storage",
        label: "Cloud storage",
        status: objectStorageConfigured ? "ok" : "degraded",
      },
      { key: "transcoding", label: "Transcoding queue", status: failedJobs > 0 ? "degraded" : "ok" },
      { key: "broadcast", label: "Broadcast continuity", status: activeBroadcastItems > 0 || activeLiveOverrides > 0 ? "ok" : "degraded" },
    ];

    const overallStatus = checks.some((check) => check.status === "critical")
      ? "critical"
      : checks.some((check) => check.status === "degraded")
        ? "degraded"
        : "ok";

    res.json({
      generatedAt: generatedAt.toISOString(),
      environment: process.env.NODE_ENV ?? "development",
      overallStatus,
      checks,
      metrics: metricsSnapshot(),
      cache: cacheStatus,
      infrastructure: {
        objectStorage: {
          provider: "aws-s3",
          configured: objectStorageConfigured,
          bucket: s3Bucket || null,
          region: s3Region || null,
          publicSearchPaths: publicObjectPaths || null,
          privateDir: privateObjectDir || null,
        },
        cache: {
          backend: cacheStatus.backend,
          redis: {
            configured: Boolean(process.env.REDIS_URL?.trim()),
            connected: cacheStatus.redis?.connected ?? false,
          },
          postgresql: {
            configured: true,
            connected: cacheStatus.postgresql?.connected ?? false,
          },
        },
        transcoder: {
          ffmpegReady: isFfmpegReady(),
          cloudUploadEnabled: objectStorageConfigured,
          pendingJobs: queuedJobs,
        },
      },
      database: {
        connected: dbConnected,
        counts: {
          videos: Number(totalVideosResult[0]?.count ?? 0),
          localVideos: Number(localVideosResult[0]?.count ?? 0),
          playlists: Number(totalPlaylistsResult[0]?.count ?? 0),
          activeScheduleEntries: Number(activeScheduleResult[0]?.count ?? 0),
          registeredDevices:
            Number(nativeDevicesResult[0]?.count ?? 0) + Number(webDevicesResult[0]?.count ?? 0),
        },
      },
      broadcast: {
        activeQueueItems: activeBroadcastItems,
        inactiveQueueItems: Number(inactiveBroadcastResult[0]?.count ?? 0),
        activeLiveOverrides,
        connectedAdminClients: getSSEClientCount(),
      },
      videoPipeline: {
        processing: processingJobs,
        queued: queuedJobs,
        done: Number(doneJobsResult[0]?.count ?? 0),
        failed: failedJobs,
        cancelled: Number(cancelledJobsResult[0]?.count ?? 0),
        uploadBytes,
        hlsBytes,
      },
      uploadSessions: {
        active: uploadSessions.size,
      },
    });
  } catch (err) {
    logger.error({ err }, "Operations status failed");
    res.status(500).json({
      generatedAt: generatedAt.toISOString(),
      overallStatus: "critical",
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

type LaunchCheckStatus = "ready" | "warning" | "blocked";

function launchCheck(
  key: string,
  label: string,
  status: LaunchCheckStatus,
  detail: string,
  action?: string,
) {
  return { key, label, status, detail, action };
}

router.get("/admin/launch/readiness", async (_req, res) => {
  const generatedAt = new Date();

  try {
    const [
      totalVideosResult,
      localVideos,
      featuredVideosResult,
      activeScheduleResult,
      activeBroadcastResult,
      nativeDevicesResult,
      webDevicesResult,
      failedJobsResult,
      queuedJobsResult,
    ] = await Promise.all([
      db.select({ count: count() }).from(videosTable),
      db.select().from(videosTable).where(eq(videosTable.videoSource, "local")),
      db.select({ count: count() }).from(videosTable).where(eq(videosTable.featured, true)),
      db.select({ count: count() }).from(scheduleTable).where(eq(scheduleTable.isActive, true)),
      db.select({ count: count() }).from(broadcastQueueTable).where(eq(broadcastQueueTable.isActive, true)),
      db.select({ count: count() }).from(pushTokensTable),
      db.select({ count: count() }).from(webPushSubscriptionsTable),
      db.select({ count: count() }).from(transcodingJobsTable).where(eq(transcodingJobsTable.status, "failed")),
      db.select({ count: count() }).from(transcodingJobsTable).where(eq(transcodingJobsTable.status, "queued")),
    ]);

    const totalVideos = Number(totalVideosResult[0]?.count ?? 0);
    const hlsReadyLocalVideos = localVideos.filter((video: (typeof localVideos)[number]) => Boolean(video.hlsMasterUrl)).length;
    const featuredVideos = Number(featuredVideosResult[0]?.count ?? 0);
    const activeScheduleEntries = Number(activeScheduleResult[0]?.count ?? 0);
    const activeBroadcastItems = Number(activeBroadcastResult[0]?.count ?? 0);
    const registeredNativeDevices = Number(nativeDevicesResult[0]?.count ?? 0);
    const registeredWebDevices = Number(webDevicesResult[0]?.count ?? 0);
    const registeredDevices = registeredNativeDevices + registeredWebDevices;
    const failedTranscodes = Number(failedJobsResult[0]?.count ?? 0);
    const queuedTranscodes = Number(queuedJobsResult[0]?.count ?? 0);
    const adminTokenConfigured = Boolean(process.env.ADMIN_API_TOKEN?.trim());
    const corsConfigured = Boolean(process.env.ALLOWED_ORIGINS?.trim());
    const objectStorageConfigured = Boolean(process.env.PRIVATE_OBJECT_DIR?.trim() || process.env.PUBLIC_OBJECT_SEARCH_PATHS?.trim());
    // Distributed cache is active when Redis is configured OR when the PostgreSQL
    // cache is ready (which is always true when DATABASE_URL is set — our standard).
    const distributedCacheConfigured = Boolean(process.env.REDIS_URL?.trim()) || Boolean(process.env.DATABASE_URL?.trim());
    const adsConfigured = Boolean(
      process.env.ADMOB_APP_ID?.trim() ||
      process.env.EXPO_PUBLIC_ADMOB_APP_ID?.trim() ||
      process.env.ADSENSE_CLIENT_ID?.trim(),
    );
    const donationConfigured = Boolean(
      process.env.DONATION_URL?.trim() ||
      process.env.EXPO_PUBLIC_DONATION_URL?.trim() ||
      process.env.STRIPE_SECRET_KEY?.trim(),
    );
    const appStoreConfigured = Boolean(process.env.APPLE_TEAM_ID?.trim() || process.env.EXPO_PUBLIC_REPL_ID?.trim());

    const categories = [
      {
        key: "security",
        label: "Security & access",
        checks: [
          launchCheck(
            "admin-token",
            "Admin API protection",
            adminTokenConfigured ? "ready" : process.env.NODE_ENV === "production" ? "blocked" : "warning",
            adminTokenConfigured ? "Admin API token is configured." : "Admin API token is not configured.",
            "Set ADMIN_API_TOKEN before production launch.",
          ),
          launchCheck(
            "cors",
            "Allowed production origins",
            process.env.NODE_ENV === "production" && !corsConfigured ? "blocked" : corsConfigured ? "ready" : "warning",
            corsConfigured ? "Allowed origins are explicitly configured." : "Production CORS allowlist is not set.",
            "Set ALLOWED_ORIGINS to the public web and admin domains.",
          ),
          launchCheck(
            "rate-limit",
            "Rate limiting and security headers",
            "ready",
            "API rate limits, request IDs, and hardened response headers are active.",
          ),
        ],
      },
      {
        key: "content",
        label: "Content & broadcast",
        checks: [
          launchCheck(
            "video-library",
            "Video library",
            totalVideos > 0 ? "ready" : "blocked",
            `${totalVideos} managed videos are available.`,
            "Import YouTube videos or upload local sermons.",
          ),
          launchCheck(
            "featured-content",
            "Featured content",
            featuredVideos > 0 ? "ready" : "warning",
            `${featuredVideos} videos are marked as featured.`,
            "Mark at least one sermon as featured for the home experience.",
          ),
          launchCheck(
            "broadcast-queue",
            "24/7 broadcast queue",
            activeBroadcastItems > 0 ? "ready" : "blocked",
            `${activeBroadcastItems} active broadcast queue items are available.`,
            "Add active items to the broadcast queue.",
          ),
          launchCheck(
            "schedule",
            "Programming schedule",
            activeScheduleEntries > 0 ? "ready" : "warning",
            `${activeScheduleEntries} active schedule entries are configured.`,
            "Create weekly schedule entries for planned programming.",
          ),
        ],
      },
      {
        key: "streaming",
        label: "Streaming pipeline",
        checks: [
          launchCheck(
            "object-storage",
            "Cloud media storage",
            objectStorageConfigured ? "ready" : "warning",
            objectStorageConfigured ? "Object storage paths are configured." : "Object storage environment paths are not configured.",
            "Configure object storage before relying on large production media libraries.",
          ),
          launchCheck(
            "hls",
            "Adaptive HLS readiness",
            localVideos.length === 0 || hlsReadyLocalVideos === localVideos.length ? "ready" : "warning",
            `${hlsReadyLocalVideos} of ${localVideos.length} local uploads have HLS renditions.`,
            "Let queued transcodes complete or retry failed jobs.",
          ),
          launchCheck(
            "transcoding",
            "Transcoding queue health",
            failedTranscodes > 0 ? "blocked" : queuedTranscodes > 0 ? "warning" : "ready",
            `${failedTranscodes} failed jobs and ${queuedTranscodes} queued jobs.`,
            "Retry failed encodes from the Transcoding Queue page.",
          ),
          launchCheck(
            "cache",
            "Distributed cache",
            distributedCacheConfigured ? "ready" : "warning",
            distributedCacheConfigured
              ? process.env.REDIS_URL?.trim()
                ? "Redis distributed cache is configured."
                : "PostgreSQL distributed cache active (shared across all instances)."
              : "Running with in-memory cache fallback (single-instance only).",
            process.env.REDIS_URL?.trim() ? undefined : "Optionally add REDIS_URL for lower-latency caching.",
          ),
        ],
      },
      {
        key: "growth",
        label: "Growth & distribution",
        checks: [
          launchCheck(
            "push-devices",
            "Push notification reach",
            registeredDevices > 0 ? "ready" : "warning",
            registeredDevices > 0
              ? `${registeredDevices} devices registered (native: ${registeredNativeDevices}, web: ${registeredWebDevices}).`
              : "0 devices are registered for notifications.",
            "Open the web app and allow notifications, or open the mobile app on test devices.",
          ),
          launchCheck(
            "ads",
            "Ad monetization",
            adsConfigured ? "ready" : "warning",
            adsConfigured ? "Ad monetization identifiers are configured." : "Ad monetization identifiers are not configured.",
            "Add AdMob or AdSense configuration when ads are approved.",
          ),
          launchCheck(
            "donations",
            "Donations and premium access",
            donationConfigured ? "ready" : "warning",
            donationConfigured ? "Donation or payment configuration is present." : "Donation/payment configuration is not present.",
            "Connect the approved giving provider.",
          ),
          launchCheck(
            "app-store",
            "App launch metadata",
            appStoreConfigured ? "ready" : "warning",
            appStoreConfigured ? "Launch build metadata is available." : "App store account metadata is not configured.",
            "Prepare Apple developer metadata before store submission.",
          ),
        ],
      },
    ];

    const allChecks = categories.flatMap((category) => category.checks);
    const blocked = allChecks.filter((check) => check.status === "blocked").length;
    const warnings = allChecks.filter((check) => check.status === "warning").length;
    const ready = allChecks.filter((check) => check.status === "ready").length;

    res.json({
      generatedAt: generatedAt.toISOString(),
      environment: process.env.NODE_ENV ?? "development",
      overallStatus: blocked > 0 ? "blocked" : warnings > 0 ? "warning" : "ready",
      summary: { ready, warnings, blocked, total: allChecks.length },
      counts: {
        totalVideos,
        localVideos: localVideos.length,
        hlsReadyLocalVideos,
        featuredVideos,
        activeScheduleEntries,
        activeBroadcastItems,
        registeredDevices,
        failedTranscodes,
        queuedTranscodes,
      },
      categories,
    });
  } catch (err) {
    logger.error({ err }, "Launch readiness failed");
    res.status(500).json({
      generatedAt: generatedAt.toISOString(),
      overallStatus: "blocked",
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

// ── Public video catalogue (no admin token required) ──────────────────────────
// Consumed by the mobile app, TV app, and any other unauthenticated client.
// Returns all videos (YouTube + local) ordered by importedAt DESC.
router.get("/videos", async (req, res) => {
  try {
    const rawLimit = parseInt(String(req.query.limit ?? "100"), 10);
    const limit = isNaN(rawLimit) || rawLimit < 1 ? 100 : Math.min(rawLimit, 500);
    const rawPage = parseInt(String(req.query.page ?? "1"), 10);
    const page = isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;
    const offset = (page - 1) * limit;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : undefined;
    const source = typeof req.query.source === "string" ? req.query.source.trim() : undefined;

    const conditions = [];
    if (search) conditions.push(or(ilike(videosTable.title, `%${search}%`), ilike(videosTable.preacher, `%${search}%`)));
    if (source === "local") conditions.push(eq(videosTable.videoSource, "local"));
    if (source === "youtube") conditions.push(eq(videosTable.videoSource, "youtube"));

    const [rows, [totalResult]] = await Promise.all([
      db.select().from(videosTable)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(videosTable.importedAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(videosTable)
        .where(conditions.length ? and(...conditions) : undefined),
    ]);

    const total = totalResult?.count ?? 0;

    res.setHeader("Cache-Control", "no-cache");
    res.json({ videos: rows, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/admin/videos", async (req, res) => {
  try {
    const parsed = ListAdminVideosQueryParams.safeParse(req.query);
    const params = parsed.success ? parsed.data : { page: 1, limit: 20, search: undefined, category: undefined };
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const offset = (page - 1) * limit;

    // source is not in the generated Zod schema so we read it directly from req.query
    const source = typeof req.query.source === "string" ? req.query.source.trim() : undefined;
    const transcodingStatus = typeof req.query.transcodingStatus === "string" ? req.query.transcodingStatus.trim() : undefined;

    const conditions = [];
    if (params.search) {
      conditions.push(or(ilike(videosTable.title, `%${params.search}%`), ilike(videosTable.preacher, `%${params.search}%`)));
    }
    if (params.category) {
      conditions.push(eq(videosTable.category, params.category));
    }
    if (source === "local") conditions.push(eq(videosTable.videoSource, "local"));
    if (source === "youtube") conditions.push(eq(videosTable.videoSource, "youtube"));
    if (transcodingStatus && transcodingStatus !== "all") {
      conditions.push(eq(videosTable.transcodingStatus, transcodingStatus));
    }
    const whereClause = conditions.length ? and(...conditions) : undefined;

    const [rows, [totalResult]] = await Promise.all([
      db
        .select()
        .from(videosTable)
        .where(whereClause)
        .orderBy(desc(videosTable.importedAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(videosTable).where(whereClause),
    ]);

    const total = totalResult?.count ?? 0;

    res.setHeader("Cache-Control", "no-store").json({
      videos: rows,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/videos/upload", upload.fields([{ name: "video", maxCount: 1 }, { name: "thumbnail", maxCount: 1 }]), async (req, res) => {
  try {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const videoFile = files?.video?.[0];
    const thumbnailFile = files?.thumbnail?.[0];

    if (!videoFile) {
      return void res.status(400).json({ error: "Video file is required" });
    }

    // Content-sniffing: confirm the bytes match the declared MIME type.
    // The fileFilter only checks the client-provided MIME header, which is
    // trivially spoofable. validateUploadedFileMagicBytes reads the first
    // bytes off disk and deletes the file if the signature is wrong.
    const videoCheck = await validateUploadedFileMagicBytes(videoFile.path, "video");
    if (!videoCheck.valid) {
      // Companion thumbnail (if any) is now an orphan — unlink it.
      if (thumbnailFile) {
        await fs.unlink(thumbnailFile.path).catch(() => {});
      }
      return void res.status(415).json({
        error: "Uploaded file does not appear to be a valid video (magic-byte mismatch)",
      });
    }
    if (thumbnailFile) {
      const thumbCheck = await validateUploadedFileMagicBytes(thumbnailFile.path, "image");
      if (!thumbCheck.valid) {
        // Video already passed, but the thumbnail is bogus — unlink the
        // video too so we don't keep a half-uploaded asset on disk.
        await fs.unlink(videoFile.path).catch(() => {});
        return void res.status(415).json({
          error: "Uploaded thumbnail does not appear to be a valid image (magic-byte mismatch)",
        });
      }
    }

    const { title, category, preacher, featured, durationSecs: durationSecsStr } = req.body as {
      title?: string;
      category?: string;
      preacher?: string;
      featured?: string;
      durationSecs?: string;
    };

    if (!title?.trim()) {
      return void res.status(400).json({ error: "Title is required" });
    }

    const durationSecsNum = durationSecsStr ? parseInt(durationSecsStr, 10) : null;
    const durationText = durationSecsNum && durationSecsNum > 0
      ? String(durationSecsNum)
      : "";

    const devDomain = process.env.REPLIT_DEV_DOMAIN;
    const baseUrl = process.env.API_BASE_URL ?? (devDomain ? `https://${devDomain}` : "");
    const localVideoUrl = `${baseUrl}/api/uploads/${videoFile.filename}`;
    const thumbnailUrl = thumbnailFile
      ? `${baseUrl}/api/uploads/${thumbnailFile.filename}`
      : "";

    // Capture upload metadata for this single-shot multipart path too.
    const checksumSha256 = await new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(videoFile.path);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", reject);
    });

    const id = randomUUID();
    const pseudoYoutubeId = `local-${id}`;

    const [video] = await db
      .insert(videosTable)
      .values({
        id,
        youtubeId: pseudoYoutubeId,
        title: title.trim(),
        description: "",
        thumbnailUrl,
        duration: durationText,
        category: category ?? "sermon",
        preacher: preacher ?? "",
        publishedAt: null,
        featured: featured === "true",
        viewCount: 0,
        videoSource: "local",
        localVideoUrl,
        originalFilename: videoFile.originalname ?? null,
        mimeType: videoFile.mimetype ?? null,
        sizeBytes: videoFile.size ?? null,
        checksumSha256,
        objectPath: null,
        uploadedBy: null,
      })
      .returning();

    // Register in broadcast queue (best-effort — video is already saved to DB)
    try {
      await upsertBroadcastQueueVideo(video);
    } catch (bqErr) {
      logger.error({ err: bqErr, videoId: video?.id }, "upsertBroadcastQueueVideo failed after simple upload");
    }

    await invalidatePublicVideoCaches();
    res.status(201).json(video);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

// ── Public session-info endpoint (no admin token required) ───────────────────
// The upload init endpoint below redirects here (303 See Other) after creating
// a session. Because response bodies and custom headers can be stripped by
// Replit's HTTP/1.1 ↔ HTTP/2 proxy translation layer, the client reads the
// session ID from response.url (which is set from the Location header — a
// standard HTTP header that ALWAYS survives HTTP/2 conversion) rather than from
// the response body. This endpoint is public because the session UUID is
// cryptographically random (122 bits) and therefore unguessable.
router.get("/upload-session/:sessionId", (req, res) => {
  const { sessionId } = req.params as { sessionId: string };
  const session = uploadSessions.get(sessionId);
  if (!session) return void res.status(404).json({ error: "Upload session not found" });
  return res
    .setHeader("Cache-Control", "no-store")
    .json({ sessionId: session.id, totalChunks: session.totalChunks });
});

router.post("/admin/videos/upload/init", async (req, res) => {
  try {
    const { title, category, preacher, featured, durationSecs, totalChunks, totalBytes, ext, sessionId: clientSessionId, originalFilename, mimeType: clientMimeType } = req.body as {
      title?: string;
      category?: string;
      preacher?: string;
      featured?: string;
      durationSecs?: string;
      totalChunks?: string;
      totalBytes?: string;
      ext?: string;
      sessionId?: string;
      originalFilename?: string;
      mimeType?: string;
    };

    if (!title?.trim()) return void res.status(400).json({ error: "Title is required" });
    if (!totalChunks || !totalBytes) return void res.status(400).json({ error: "totalChunks and totalBytes are required" });

    // The client generates a UUID and sends it here. This sidesteps all proxy
    // issues — no response body or headers need to carry the session ID back.
    // We validate the format strictly so clients can't inject arbitrary IDs.
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const sessionId = (clientSessionId && uuidPattern.test(clientSessionId))
      ? clientSessionId
      : randomUUID();

    // Reject if this session already exists (prevents double-init on retries)
    if (uploadSessions.has(sessionId)) {
      return void res.status(204).end();
    }

    const tmpDir = path.join(__dirname, "..", "uploads", "tmp", sessionId);
    await fs.mkdir(tmpDir, { recursive: true });

    const now = new Date();
    // Capture the original Content-Type from the client (File.type). We only
    // accept simple `type/subtype` MIME strings to avoid header injection.
    const sanitizedMimeType =
      typeof clientMimeType === "string" &&
      /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(clientMimeType.trim())
        ? clientMimeType.trim().toLowerCase()
        : undefined;

    const session: ChunkedSession = {
      id: sessionId,
      ext: ext ?? ".mp4",
      mimeType: sanitizedMimeType,
      totalChunks: parseInt(totalChunks, 10),
      uploadedChunks: new Set(),
      tmpDir,
      totalBytes: parseInt(totalBytes, 10),
      receivedBytes: 0,
      metadata: {
        title: title.trim(),
        category: category ?? "sermon",
        preacher: preacher ?? "",
        featured: featured === "true",
        durationSecs: durationSecs ? parseInt(durationSecs, 10) : 0,
        originalFilename: originalFilename?.trim() ?? "",
      },
      createdAt: now,
      lastActivity: now,
    };

    uploadSessions.set(sessionId, session);
    writeSessionToDisk(session);

    // 204 No Content — the client already knows the session ID it generated.
    res.setHeader("Cache-Control", "no-store").status(204).end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/videos/upload/:sessionId/chunk", chunkUpload.single("chunk"), async (req, res) => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const { chunkIndex, checksum } = req.body as { chunkIndex?: string; checksum?: string };

    const session = uploadSessions.get(sessionId);
    if (!session) return void res.status(404).json({ error: "Upload session not found or expired" });

    const chunk = req.file;
    if (!chunk) return void res.status(400).json({ error: "No chunk data provided" });

    const idx = parseInt(chunkIndex ?? "0", 10);
    if (isNaN(idx) || idx < 0 || idx >= session.totalChunks) {
      return void res.status(400).json({ error: `Invalid chunk index: ${idx}` });
    }

    // Verify SHA-256 checksum when provided — uses async Web Crypto so the
    // event loop is never blocked, keeping all concurrent chunks flowing freely.
    if (checksum) {
      const hashBuf = await (webcrypto as Crypto).subtle.digest("SHA-256", new Uint8Array(chunk.buffer as unknown as ArrayBuffer));
      const actualChecksum = Buffer.from(hashBuf).toString("hex");
      if (actualChecksum !== checksum) {
        logger.warn({ sessionId, chunkIndex: idx, expected: checksum, actual: actualChecksum }, "Chunk checksum mismatch");
        return void res.status(400).json({ error: `Checksum mismatch for chunk ${idx} — data corrupted in transit` });
      }
    }

    // Kick off disk write and checksum verification concurrently
    const chunkPath = path.join(session.tmpDir, `chunk-${String(idx).padStart(6, "0")}`);
    await fs.writeFile(chunkPath, chunk.buffer);

    // Idempotency: only count bytes the first time a chunk arrives. The same
    // index can be uploaded twice (network retry, mid-flight failover) and we
    // must not let `receivedBytes` drift past `totalBytes` and corrupt the
    // progress telemetry shown to operators.
    const isNewChunk = !session.uploadedChunks.has(idx);
    session.uploadedChunks.add(idx);
    if (isNewChunk) {
      session.receivedBytes += chunk.buffer.length;
    }
    session.lastActivity = new Date();

    // Debounced write — does not block the response
    writeSessionToDisk(session);

    res.json({
      sessionId,
      chunkIndex: idx,
      uploadedChunks: session.uploadedChunks.size,
      totalChunks: session.totalChunks,
      progressPercent: Math.round((session.uploadedChunks.size / session.totalChunks) * 100),
      checksumVerified: !!checksum,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/admin/videos/upload/:sessionId/status", (req, res) => {
  const { sessionId } = req.params as { sessionId: string };
  const session = uploadSessions.get(sessionId);
  if (!session) return void res.status(404).json({ error: "Session not found" });

  const missingChunks: number[] = [];
  for (let i = 0; i < session.totalChunks; i++) {
    if (!session.uploadedChunks.has(i)) missingChunks.push(i);
  }

  res.json({
    sessionId,
    uploadedChunks: session.uploadedChunks.size,
    uploadedChunkIndices: Array.from(session.uploadedChunks),
    totalChunks: session.totalChunks,
    missingChunks,
    progressPercent: Math.round((session.uploadedChunks.size / session.totalChunks) * 100),
    receivedBytes: session.receivedBytes,
    totalBytes: session.totalBytes,
    metadata: session.metadata,
  });
});

router.post("/admin/videos/upload/:sessionId/thumbnail", thumbnailUpload.single("thumbnail"), async (req, res) => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const session = uploadSessions.get(sessionId);
    if (!session) return void res.status(404).json({ error: "Session not found or expired" });

    if (req.file) {
      const filePath = path.join(__dirname, "..", "uploads", req.file.filename);
      const check = await validateUploadedFileMagicBytes(filePath, "image");
      if (!check.valid) {
        return void res.status(415).json({
          error: "Uploaded thumbnail does not appear to be a valid image (magic-byte mismatch)",
        });
      }
      session.thumbnailPath = req.file.filename;
    }

    res.json({ ok: true, thumbnailPath: session.thumbnailPath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/videos/upload/:sessionId/finalize", async (req, res) => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const session = uploadSessions.get(sessionId);
    if (!session) return void res.status(404).json({ error: "Session not found or expired" });

    // Concurrency guard: a second finalize call (double-click, proxy retry,
    // browser refresh during assembly) would race the first — both pass the
    // missing-chunk check, both delete tmpDir, both insert DB rows, both
    // spawn transcoding jobs. Reject the second call with 409.
    if (session.finalizing) {
      return void res.status(409).json({
        error: "finalize_in_progress",
        message: "Finalization is already in progress for this upload session.",
      });
    }
    session.finalizing = true;

    const missingChunks: number[] = [];
    for (let i = 0; i < session.totalChunks; i++) {
      if (!session.uploadedChunks.has(i)) missingChunks.push(i);
    }

    if (missingChunks.length > 0) {
      // Premature finalize (client raced ahead of its own chunk uploads, or a
      // retry after a partial network failure). Release the concurrency flag
      // so the next finalize attempt isn't permanently 409'd, leaving the
      // session uploadable + cancellable + GC-eligible as before.
      session.finalizing = false;
      return void res.status(400).json({ error: `Missing chunks: ${missingChunks.join(", ")}`, missingChunks });
    }

    const finalFilename = `${randomUUID()}${session.ext}`;
    const finalPath = path.join(__dirname, "..", "uploads", finalFilename);
    // 4 MB write buffer — fewer kernel flushes than the default 64 KB
    const writeStream = createWriteStream(finalPath, { highWaterMark: 4 * 1024 * 1024 });
    const assemblyStart = Date.now();

    try {
      // ── Pipelined chunk assembly ──────────────────────────────────────────
      // Read chunk N+PIPELINE_DEPTH into memory while chunk N is being written,
      // so disk-read latency is fully hidden behind disk-write latency.
      // This is 2-3× faster than sequential read-then-write for large files.
      const PIPELINE_DEPTH = 3;
      const prefetchMap = new Map<number, Promise<Buffer>>();

      const prefetchChunk = (idx: number): void => {
        if (idx < session.totalChunks && !prefetchMap.has(idx)) {
          const p = path.join(session.tmpDir, `chunk-${String(idx).padStart(6, "0")}`);
          prefetchMap.set(idx, fs.readFile(p));
        }
      };

      // Seed the pipeline
      for (let i = 0; i < Math.min(PIPELINE_DEPTH, session.totalChunks); i++) {
        prefetchChunk(i);
      }

      for (let i = 0; i < session.totalChunks; i++) {
        // Kick off the read for the next pipeline window
        prefetchChunk(i + PIPELINE_DEPTH);

        // Wait for the current chunk to be ready (already in-flight)
        const buffer = await prefetchMap.get(i)!;
        prefetchMap.delete(i); // free the Promise reference / allow GC

        // Write to stream, respecting backpressure
        const canContinue = writeStream.write(buffer);
        if (!canContinue) {
          await new Promise<void>((res) => writeStream.once("drain", res));
        }
      }

      await new Promise<void>((resolve, reject) => {
        writeStream.end();
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
      });
    } catch (err) {
      writeStream.destroy();
      await fs.unlink(finalPath).catch(() => {});
      throw err;
    }

    const assemblyMs = Date.now() - assemblyStart;

    // Magic-byte validation on the assembled video (defends against MIME spoofing).
    const magicCheck = await validateUploadedFileMagicBytes(finalPath, "video");
    if (!magicCheck.valid) {
      await fs.unlink(finalPath).catch(() => {});
      destroyUploadSession(sessionId, session.tmpDir);
      return void res.status(415).json({
        error: "Uploaded file does not appear to be a valid video (magic-byte mismatch)",
      });
    }

    await fs.rm(session.tmpDir, { recursive: true, force: true });

    // From here on, the assembled file lives at `finalPath`. Any failure
    // before we successfully insert the DB row would orphan that file, so
    // we wrap the remaining work in a try/catch that cleans up on failure.
    try {
      // ── Upload-metadata capture (Postgres is the source of truth) ───────
      // Compute SHA-256 by streaming the assembled file (no full-file buffer).
      const sizeBytes = (await fs.stat(finalPath)).size;
      const checksumSha256 = await new Promise<string>((resolve, reject) => {
        const hash = createHash("sha256");
        const stream = createReadStream(finalPath);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", reject);
      });
      // Derive a best-effort MIME type from the file extension. The chunked
      // upload session doesn't carry the original Content-Type header, but
      // the extension was set at /init time from the client-supplied filename.
      const extToMime: Record<string, string> = {
        ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
        ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
        ".flv": "video/x-flv", ".ogv": "video/ogg", ".ts": "video/mp2t",
        ".3gp": "video/3gpp",
      };
      // Prefer the original Content-Type captured at /init (browser-supplied
      // File.type — already format-validated). Fall back to the extension map
      // for legacy clients that didn't send a mimeType.
      const mimeType =
        session.mimeType ??
        extToMime[session.ext.toLowerCase()] ??
        "application/octet-stream";

      const id = randomUUID();
      const devDomain = process.env.REPLIT_DEV_DOMAIN;
      const baseUrl = process.env.API_BASE_URL ?? (devDomain ? `https://${devDomain}` : "");

      // ── Mirror to S3 ────────────────────────────────────────────────────
      // The /api/uploads/* route 302-redirects to S3 when the object exists
      // there (lib/staticWithS3Fallback.ts redirectFromS3 mode), so the API
      // process never has to stream the bytes. Mirror the assembled video
      // and any thumbnail to `videos/<filename>` here so that redirect path
      // is taken from the very first playback instead of waiting for a
      // separate backfill. Best-effort: a failure leaves the file on local
      // disk where express.static still serves it, and the standalone
      // backfill script (`pnpm --filter @workspace/api-server run backfill-uploads`)
      // can reconcile later.
      let mirroredToS3 = false;
      const s3VideoKey = `videos/${finalFilename}`;
      if (isS3Configured()) {
        try {
          await s3PutObject(s3VideoKey, createReadStream(finalPath), {
            contentType: mimeType,
          });
          mirroredToS3 = true;
          logger.info(
            { finalFilename, sizeBytes },
            "Source MP4 mirrored to S3 (videos/) — /api/videos/:id/source will 302-redirect",
          );
        } catch (s3Err) {
          logger.warn(
            { err: s3Err instanceof Error ? s3Err.message : String(s3Err), finalFilename },
            "S3 mirror failed for assembled MP4 — file still on local disk; backfill-uploads will reconcile",
          );
        }
        if (session.thumbnailPath) {
          const thumbPath = path.join(__dirname, "..", "uploads", session.thumbnailPath);
          try {
            await s3PutObject(`videos/${session.thumbnailPath}`, createReadStream(thumbPath));
          } catch (s3Err) {
            logger.warn(
              { err: s3Err instanceof Error ? s3Err.message : String(s3Err), thumb: session.thumbnailPath },
              "S3 mirror failed for thumbnail — file still on local disk; backfill-uploads will reconcile",
            );
          }
        }
      }

      // Choose the canonical playback URL. When the mirror succeeded we use
      // the cleaner `/api/videos/:id/source` redirect endpoint (which 302s to
      // a fresh presigned S3 URL by reading `objectPath` from the videos
      // row). When the mirror failed we leave the URL pointing at the
      // legacy `/api/uploads/*` route — that route also redirects to S3 if
      // the object becomes available later via backfill, but in the
      // meantime express.static serves it directly off local disk.
      const localVideoUrl = mirroredToS3
        ? `${baseUrl}/api/videos/${id}/source`
        : `${baseUrl}/api/uploads/${finalFilename}`;
      const thumbnailUrl = session.thumbnailPath
        ? `${baseUrl}/api/uploads/${session.thumbnailPath}`
        : "";
      const [video] = await db
        .insert(videosTable)
        .values({
          id,
          youtubeId: `local-${id}`,
          title: session.metadata.title,
          description: "",
          thumbnailUrl,
          duration: session.metadata.durationSecs > 0 ? String(session.metadata.durationSecs) : "",
          category: session.metadata.category,
          preacher: session.metadata.preacher,
          publishedAt: null,
          featured: session.metadata.featured,
          viewCount: 0,
          videoSource: "local",
          localVideoUrl,
          originalFilename: session.metadata.originalFilename || null,
          mimeType,
          sizeBytes,
          checksumSha256,
          // Persist the canonical S3 key whenever the post-finalize mirror
          // succeeded, so /api/videos/:id/source can issue a clean 302 to a
          // fresh presigned GET URL. When the mirror failed we leave it
          // null and rely on /api/uploads/* (disk fast path + S3 fallback).
          objectPath: mirroredToS3 ? s3VideoKey : null,
          uploadedBy: null,
        })
        .returning();

      destroyUploadSession(sessionId);

      // Diagnostics: log assembly performance
      logger.info(
        { sessionId, chunks: session.totalChunks, sizeBytes, assemblyMs },
        "Upload finalized — pipeline assembly complete",
      );

      // ── Broadcast-queue registration (BEFORE 201 response) ───────────────
      // This MUST complete before we send the 201 so that the client's
      // immediate loadAll() / refetch() call sees the video in the queue.
      // If this step fails the video is still in the DB — we log the error
      // and set broadcastQueued=false in the response so the client can
      // surface a warning without blocking the upload success toast.
      let broadcastQueued = false;
      try {
        await upsertBroadcastQueueVideo(video);
        broadcastQueued = true;
      } catch (bqErr) {
        logger.error(
          { err: bqErr, videoId: id },
          "upsertBroadcastQueueVideo failed after finalize — video is in DB but may not appear in broadcast queue immediately",
        );
      }

      await invalidatePublicVideoCaches();
      res.status(201).json({ ...video, _assemblyMs: assemblyMs, broadcastQueued });

      // Transcoding is a background job — does not affect queue visibility.
      queueTranscodingJob(id, finalPath, 1).catch(() => {});
    } catch (postAssemblyErr) {
      // Hash/stat/DB-insert failed after assembly (before DB write). Delete
      // the orphan file, tear down the in-memory session, surface a 500.
      await fs.unlink(finalPath).catch(() => {});
      destroyUploadSession(sessionId);
      throw postAssemblyErr;
    }
  } catch (err) {
    // Clear the finalizing flag so the operator (or client) can retry instead
    // of being permanently locked out by a transient failure. We only do this
    // when the session is still in-memory — successful finalize already removed
    // it via destroyUploadSession.
    const { sessionId } = req.params as { sessionId: string };
    const lingering = uploadSessions.get(sessionId);
    if (lingering) lingering.finalizing = false;
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

// ── Direct browser → S3 upload (presigned PUT) ──────────────────────────────
//
// Bypasses the API server for the byte-stream:
//   1. Client POSTs metadata to /admin/videos/upload/s3-init → server mints
//      a 1-hour presigned PUT URL pointing at videos/<uuid>.<ext> in the
//      configured S3 bucket and returns it.
//   2. Browser PUTs the file directly to S3 — the API server never sees the
//      bytes, so server CPU and bandwidth are not in the upload critical path.
//   3. Client POSTs the same sessionId + objectKey to /s3-finalize → server
//      verifies the object exists in S3 (HEAD), stamps ACL metadata, inserts
//      the videos row, queues the transcoding job, and returns the row.
//
// Files larger than the 5 GB single-PUT cap should fall back to the chunked
// /admin/videos/upload/init flow.

const S3_VIDEO_PREFIX = "videos";
const S3_PUT_TTL_SEC = 3600;          // 1 hour to complete the upload
const S3_GET_REDIRECT_TTL_SEC = 21600; // 6 hours per playback URL
const S3_MAX_DIRECT_PUT_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB S3 PUT cap

const SAFE_EXT_RE = /^[a-z0-9]{1,10}$/;
const SAFE_OBJECT_KEY_RE = /^videos\/[A-Za-z0-9._-]+$/;
const SAFE_MIME_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

function sanitiseExt(raw: unknown, fallback = "mp4"): string {
  const ext = String(raw ?? "").trim().replace(/^\.+/, "").toLowerCase();
  return SAFE_EXT_RE.test(ext) ? ext : fallback;
}

function sanitiseMime(raw: unknown): string | undefined {
  const mime = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return mime && SAFE_MIME_RE.test(mime) ? mime : undefined;
}

// ── Telemetry helper ──────────────────────────────────────────────────────────
// Best-effort: never throw to the calling endpoint. A telemetry insert failure
// must not break a real upload, so we swallow errors and log them instead.
async function recordS3Telemetry(row: {
  event: S3TelemetryEvent;
  sessionId?: string | null;
  videoId?: string | null;
  sizeBytes?: number | null;
  durationMs?: number | null;
  errorKind?: string | null;
  errorMessage?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  try {
    const throughputBps =
      row.sizeBytes && row.durationMs && row.durationMs > 0
        ? Math.round((row.sizeBytes * 1000) / row.durationMs)
        : null;
    await db.insert(s3UploadTelemetryTable).values({
      id: randomUUID(),
      event: row.event,
      sessionId: row.sessionId ?? null,
      videoId: row.videoId ?? null,
      sizeBytes: row.sizeBytes ?? null,
      durationMs: row.durationMs ?? null,
      throughputBps,
      errorKind: row.errorKind ? row.errorKind.slice(0, 80) : null,
      // Cap message length to keep the table small even under sustained
      // failure storms.
      errorMessage: row.errorMessage ? row.errorMessage.slice(0, 500) : null,
      userAgent: row.userAgent ? row.userAgent.slice(0, 240) : null,
    });
  } catch (err) {
    logger.warn({ err, event: row.event }, "recordS3Telemetry failed (swallowed)");
  }
}

router.post("/admin/videos/upload/s3-init", async (req, res) => {
  try {
    if (!isS3Configured()) {
      return void res.status(503).json({
        error: "S3 object storage is not configured on this server.",
      });
    }

    const {
      title,
      sizeBytes,
      ext,
      mimeType,
    } = req.body as {
      title?: string;
      sizeBytes?: string | number;
      ext?: string;
      mimeType?: string;
    };

    if (!title?.trim()) {
      return void res.status(400).json({ error: "Title is required" });
    }

    const totalBytes = typeof sizeBytes === "number"
      ? sizeBytes
      : parseInt(String(sizeBytes ?? "0"), 10);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
      return void res.status(400).json({ error: "sizeBytes is required" });
    }
    if (totalBytes > S3_MAX_DIRECT_PUT_BYTES) {
      return void res.status(413).json({
        error: `File too large for single-PUT upload (max ${S3_MAX_DIRECT_PUT_BYTES} bytes). Use the chunked endpoint instead.`,
      });
    }

    const safeExt = sanitiseExt(ext, "mp4");
    const safeMime = sanitiseMime(mimeType) ?? "application/octet-stream";

    const sessionId = randomUUID();
    const objectKey = `${S3_VIDEO_PREFIX}/${sessionId}.${safeExt}`;

    const uploadUrl = await s3GetSignedPutUrl(objectKey, S3_PUT_TTL_SEC, {
      contentType: safeMime,
    });

    void recordS3Telemetry({
      event: "init",
      sessionId,
      sizeBytes: totalBytes,
      userAgent: req.headers["user-agent"] ?? null,
    });

    res
      .setHeader("Cache-Control", "no-store")
      .json({
        sessionId,
        objectKey,
        uploadUrl,
        contentType: safeMime,
        expiresIn: S3_PUT_TTL_SEC,
        bucket: AWS_S3_BUCKET,
        region: AWS_REGION,
      });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err }, "s3-init failed");
    res.status(500).json({ error: msg });
  }
});

// ── CORS pre-flight test ────────────────────────────────────────────────────
// Mints a tiny, short-lived presigned PUT URL pointing at `cors-test/<uuid>.bin`
// so the admin UI can verify the bucket's CORS policy without needing a real
// upload to fail first. The frontend PUTs a 1-byte payload and inspects the
// response: success + readable ETag header == policy is correctly configured.
// Failure (CORS error / missing ETag) gives a precise remediation message.
router.post("/admin/videos/upload/s3-cors-test", async (_req, res) => {
  try {
    if (!isS3Configured()) {
      return void res.status(503).json({
        error: "S3 object storage is not configured on this server.",
      });
    }
    const objectKey = `cors-test/${randomUUID()}.bin`;
    const presignedUrl = await s3GetSignedPutUrl(objectKey, 300, {
      contentType: "application/octet-stream",
    });
    res.setHeader("Cache-Control", "no-store").json({
      presignedUrl,
      objectKey,
      bucket: AWS_S3_BUCKET,
      region: AWS_REGION,
      expiresIn: 300,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err }, "s3-cors-test presign failed");
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/videos/upload/s3-finalize", async (req, res) => {
  try {
    if (!isS3Configured()) {
      return void res.status(503).json({
        error: "S3 object storage is not configured on this server.",
      });
    }

    const {
      sessionId,
      objectKey,
      title,
      category,
      preacher,
      featured,
      durationSecs,
      sizeBytes,
      mimeType,
      originalFilename,
      checksumSha256,
      clientDurationMs,
    } = req.body as {
      sessionId?: string;
      objectKey?: string;
      title?: string;
      category?: string;
      preacher?: string;
      featured?: boolean | string;
      durationSecs?: number | string;
      sizeBytes?: number | string;
      mimeType?: string;
      originalFilename?: string;
      checksumSha256?: string;
      clientDurationMs?: number | string;
    };

    const measuredClientMs = (() => {
      const n = typeof clientDurationMs === "number"
        ? clientDurationMs
        : parseInt(String(clientDurationMs ?? "0"), 10);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    })();

    if (!title?.trim()) {
      void recordS3Telemetry({
        event: "server_fail",
        sessionId,
        errorKind: "validation",
        errorMessage: "Title is required",
        userAgent: req.headers["user-agent"] ?? null,
      });
      return void res.status(400).json({ error: "Title is required" });
    }
    if (!objectKey || !SAFE_OBJECT_KEY_RE.test(objectKey)) {
      void recordS3Telemetry({
        event: "server_fail",
        sessionId,
        errorKind: "validation",
        errorMessage: "Invalid or missing objectKey",
        userAgent: req.headers["user-agent"] ?? null,
      });
      return void res.status(400).json({ error: "Invalid or missing objectKey" });
    }

    // Verify the object actually landed in S3 before we commit a DB row.
    const head = await s3HeadObject(objectKey);
    if (!head) {
      void recordS3Telemetry({
        event: "server_fail",
        sessionId,
        errorKind: "head_missing",
        errorMessage: "Uploaded object not found in S3",
        durationMs: measuredClientMs,
        userAgent: req.headers["user-agent"] ?? null,
      });
      return void res.status(404).json({
        error: "Uploaded object not found in S3 — the PUT may have failed or expired",
      });
    }
    const actualSize = typeof head.contentLength === "number" ? head.contentLength : 0;
    if (actualSize <= 0) {
      void recordS3Telemetry({
        event: "server_fail",
        sessionId,
        errorKind: "empty_object",
        errorMessage: "Uploaded object is empty",
        userAgent: req.headers["user-agent"] ?? null,
      });
      return void res.status(400).json({ error: "Uploaded object is empty" });
    }

    const claimedSize = typeof sizeBytes === "number"
      ? sizeBytes
      : parseInt(String(sizeBytes ?? "0"), 10);
    if (claimedSize > 0 && Math.abs(claimedSize - actualSize) > 1024) {
      logger.warn(
        { objectKey, claimedSize, actualSize },
        "s3-finalize: client size differs from S3 ContentLength — using S3 value",
      );
    }

    const safeMime = sanitiseMime(mimeType) ?? head.contentType ?? "application/octet-stream";
    const safeDuration = typeof durationSecs === "number"
      ? durationSecs
      : parseInt(String(durationSecs ?? "0"), 10);
    const safeFeatured = featured === true || featured === "true";

    // Stamp ACL policy onto the S3 object so future ACL checks pass without
    // a DB roundtrip. Best-effort — failures are logged but don't block the
    // commit (the video row itself is the source of truth for ownership).
    try {
      await s3ReplaceObjectMetadata(
        objectKey,
        {
          aclpolicy: JSON.stringify({
            owner: "admin",
            visibility: "private",
          }),
        },
        { contentType: safeMime },
      );
    } catch (aclErr) {
      logger.warn({ err: aclErr, objectKey }, "ACL stamp failed");
    }

    const id = randomUUID();
    const devDomain = process.env.REPLIT_DEV_DOMAIN;
    const baseUrl = process.env.API_BASE_URL ?? (devDomain ? `https://${devDomain}` : "");
    const localVideoUrl = `${baseUrl}/api/videos/${id}/source`;
    // Custom thumbnails are not yet supported in the direct-S3 flow — the
    // transcoder will auto-generate one. Users needing a custom thumbnail
    // should use the legacy chunked upload path.
    const thumbnailUrl = "";

    const [video] = await db
      .insert(videosTable)
      .values({
        id,
        youtubeId: `local-${id}`,
        title: title.trim(),
        description: "",
        thumbnailUrl,
        duration: safeDuration > 0 ? String(safeDuration) : "",
        category: (category ?? "sermon").trim() || "sermon",
        preacher: (preacher ?? "").trim(),
        publishedAt: null,
        featured: safeFeatured,
        viewCount: 0,
        videoSource: "local",
        localVideoUrl,
        originalFilename: (originalFilename ?? "").trim() || null,
        mimeType: safeMime,
        sizeBytes: actualSize,
        checksumSha256: typeof checksumSha256 === "string" && /^[a-f0-9]{64}$/i.test(checksumSha256)
          ? checksumSha256.toLowerCase()
          : null,
        // Persist the canonical S3 key. Used by the playback redirect, the
        // transcoder source resolver, and any future bulk-cleanup pass.
        objectPath: objectKey,
        uploadedBy: null,
      })
      .returning();

    let broadcastQueued = false;
    try {
      await upsertBroadcastQueueVideo(video);
      broadcastQueued = true;
    } catch (bqErr) {
      logger.error(
        { err: bqErr, videoId: id, sessionId },
        "upsertBroadcastQueueVideo failed after s3-finalize",
      );
    }

    await invalidatePublicVideoCaches();

    logger.info(
      {
        videoId: id,
        sessionId,
        objectKey,
        sizeBytes: actualSize,
      },
      "S3 direct upload finalized",
    );

    // Empty videoPath signals "use HTTP fallback" inside the transcoder —
    // it will fetch localVideoUrl, which 302-redirects to a presigned S3 GET.
    queueTranscodingJob(id, "", 1).catch((err) => {
      logger.error({ err, videoId: id }, "queueTranscodingJob failed after s3-finalize");
    });

    void recordS3Telemetry({
      event: "success",
      sessionId,
      videoId: id,
      sizeBytes: actualSize,
      durationMs: measuredClientMs,
      userAgent: req.headers["user-agent"] ?? null,
    });

    res.status(201).json({ ...video, broadcastQueued });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err }, "s3-finalize failed");
    void recordS3Telemetry({
      event: "server_fail",
      sessionId: (req.body as { sessionId?: string } | undefined)?.sessionId ?? null,
      errorKind: err instanceof Error ? err.name : "Error",
      errorMessage: msg,
      userAgent: req.headers["user-agent"] ?? null,
    });
    res.status(500).json({ error: msg });
  }
});

// ── Direct browser → S3 multipart upload (parallel parts) ──────────────────
//
// The single-PUT direct-S3 path (`s3-init` → PUT → `s3-finalize`) cannot
// saturate a 5G / fibre uplink because a single HTTPS stream is throughput-
// limited by TCP windowing, server CPU, and the round-trip time. S3's
// multipart upload protocol fixes this by letting the browser open many
// parallel HTTPS PUTs to S3, each carrying one "part" of the file, and then
// commit them all as a single object via Complete.
//
// Wire format
// ───────────
//   1. POST /s3-multipart-init
//        body: { title, sizeBytes, ext, mimeType, partSize }
//        response: { sessionId, uploadId, objectKey, partSize, totalParts,
//                    contentType, expiresIn }
//
//   2. POST /s3-multipart-sign         (called as many times as needed)
//        body: { uploadId, objectKey, partNumbers: number[] }
//        response: { urls: { partNumber, url }[], expiresIn }
//      The browser pulls a batch of presigned PUT URLs, then PUTs the part
//      bytes directly to S3 in parallel. S3 returns the part's ETag in the
//      response header.
//
//   3. POST /s3-multipart-complete
//        body: same `videos`-row metadata as `s3-finalize` PLUS
//              { uploadId, parts: [{ partNumber, etag }] }
//        S3 assembles the final object, then we HEAD-verify, insert the
//        videos row (with `objectPath` set), and queue transcoding.
//
//   4. POST /s3-multipart-abort       (best-effort cleanup on cancel/error)
//        body: { uploadId, objectKey }
//        S3 throws away any uploaded parts so the user isn't billed for
//        orphan storage.
//
// Bucket lifecycle
// ────────────────
// We rely on the bucket having a lifecycle rule that auto-aborts any
// multipart upload older than ~7 days, so even if the abort step fails the
// orphan parts eventually get reclaimed. This is a one-time bucket setting.

const S3_MULTIPART_PUT_TTL_SEC = 6 * 3600; // 6h to upload a single part
const SAFE_UPLOAD_ID_RE = /^[A-Za-z0-9._\-+/=]{8,512}$/;
const SAFE_ETAG_RE = /^"?[A-Za-z0-9._\-]+"?$/;

router.post("/admin/videos/upload/s3-multipart-init", async (req, res) => {
  try {
    if (!isS3Configured()) {
      return void res.status(503).json({
        error: "S3 object storage is not configured on this server.",
      });
    }
    const { title, sizeBytes, ext, mimeType, partSize } = req.body as {
      title?: string;
      sizeBytes?: string | number;
      ext?: string;
      mimeType?: string;
      partSize?: string | number;
    };
    if (!title?.trim()) {
      return void res.status(400).json({ error: "Title is required" });
    }
    const totalBytes =
      typeof sizeBytes === "number" ? sizeBytes : parseInt(String(sizeBytes ?? "0"), 10);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
      return void res.status(400).json({ error: "sizeBytes is required" });
    }
    const requestedPart =
      typeof partSize === "number" ? partSize : parseInt(String(partSize ?? "0"), 10);
    // Clamp to S3 hard requirements: ≥5 MiB, and totalParts ≤ 10,000. If the
    // client picked a part size that would exceed 10,000 parts, we round up
    // to the smallest size that fits.
    const minByPartCap = Math.ceil(totalBytes / S3_MULTIPART_MAX_PARTS);
    const effectivePartSize = Math.max(
      S3_MULTIPART_MIN_PART_BYTES,
      requestedPart > 0 ? requestedPart : 16 * 1024 * 1024,
      minByPartCap,
    );
    const totalParts = Math.max(1, Math.ceil(totalBytes / effectivePartSize));
    if (totalParts > S3_MULTIPART_MAX_PARTS) {
      return void res.status(413).json({
        error: `File is too large for S3 multipart upload (max ${S3_MULTIPART_MAX_PARTS} parts).`,
      });
    }

    const safeExt = sanitiseExt(ext, "mp4");
    const safeMime = sanitiseMime(mimeType) ?? "application/octet-stream";
    const sessionId = randomUUID();
    const objectKey = `${S3_VIDEO_PREFIX}/${sessionId}.${safeExt}`;

    const uploadId = await s3CreateMultipartUpload(objectKey, {
      contentType: safeMime,
    });

    void recordS3Telemetry({
      event: "init",
      sessionId,
      sizeBytes: totalBytes,
      userAgent: req.headers["user-agent"] ?? null,
    });

    res.setHeader("Cache-Control", "no-store").json({
      sessionId,
      uploadId,
      objectKey,
      partSize: effectivePartSize,
      totalParts,
      contentType: safeMime,
      expiresIn: S3_MULTIPART_PUT_TTL_SEC,
      bucket: AWS_S3_BUCKET,
      region: AWS_REGION,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err }, "s3-multipart-init failed");
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/videos/upload/s3-multipart-sign", async (req, res) => {
  try {
    if (!isS3Configured()) {
      return void res.status(503).json({
        error: "S3 object storage is not configured on this server.",
      });
    }
    const { uploadId, objectKey, partNumbers } = req.body as {
      uploadId?: string;
      objectKey?: string;
      partNumbers?: number[];
    };
    if (!uploadId || !SAFE_UPLOAD_ID_RE.test(uploadId)) {
      return void res.status(400).json({ error: "Invalid or missing uploadId" });
    }
    if (!objectKey || !SAFE_OBJECT_KEY_RE.test(objectKey)) {
      return void res.status(400).json({ error: "Invalid or missing objectKey" });
    }
    if (!Array.isArray(partNumbers) || partNumbers.length === 0) {
      return void res.status(400).json({ error: "partNumbers must be a non-empty array" });
    }
    if (partNumbers.length > 1000) {
      return void res.status(400).json({
        error: "Too many partNumbers in one request (max 1000) — split into batches.",
      });
    }
    for (const n of partNumbers) {
      if (!Number.isInteger(n) || n < 1 || n > S3_MULTIPART_MAX_PARTS) {
        return void res.status(400).json({
          error: `Invalid partNumber ${n} — must be an integer in [1, ${S3_MULTIPART_MAX_PARTS}].`,
        });
      }
    }

    const urls = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await s3SignUploadPartUrl(
          objectKey,
          uploadId,
          partNumber,
          S3_MULTIPART_PUT_TTL_SEC,
        ),
      })),
    );

    res.setHeader("Cache-Control", "no-store").json({
      urls,
      expiresIn: S3_MULTIPART_PUT_TTL_SEC,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err }, "s3-multipart-sign failed");
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/videos/upload/s3-multipart-complete", async (req, res) => {
  try {
    if (!isS3Configured()) {
      return void res.status(503).json({
        error: "S3 object storage is not configured on this server.",
      });
    }
    const {
      sessionId,
      uploadId,
      objectKey,
      parts,
      title,
      category,
      preacher,
      featured,
      durationSecs,
      sizeBytes,
      mimeType,
      originalFilename,
      checksumSha256,
      clientDurationMs,
    } = req.body as {
      sessionId?: string;
      uploadId?: string;
      objectKey?: string;
      parts?: { partNumber: number; etag: string }[];
      title?: string;
      category?: string;
      preacher?: string;
      featured?: boolean | string;
      durationSecs?: number | string;
      sizeBytes?: number | string;
      mimeType?: string;
      originalFilename?: string;
      checksumSha256?: string;
      clientDurationMs?: number | string;
    };

    if (!title?.trim()) {
      return void res.status(400).json({ error: "Title is required" });
    }
    if (!uploadId || !SAFE_UPLOAD_ID_RE.test(uploadId)) {
      return void res.status(400).json({ error: "Invalid or missing uploadId" });
    }
    if (!objectKey || !SAFE_OBJECT_KEY_RE.test(objectKey)) {
      return void res.status(400).json({ error: "Invalid or missing objectKey" });
    }
    if (!Array.isArray(parts) || parts.length === 0) {
      return void res.status(400).json({ error: "parts must be a non-empty array" });
    }
    if (parts.length > S3_MULTIPART_MAX_PARTS) {
      return void res.status(400).json({
        error: `Too many parts (${parts.length}) — S3 caps at ${S3_MULTIPART_MAX_PARTS}.`,
      });
    }
    const cleanedParts = parts.map((p) => {
      if (
        !Number.isInteger(p.partNumber) ||
        p.partNumber < 1 ||
        p.partNumber > S3_MULTIPART_MAX_PARTS
      ) {
        throw new Error(`Invalid partNumber: ${p.partNumber}`);
      }
      if (typeof p.etag !== "string" || !SAFE_ETAG_RE.test(p.etag)) {
        throw new Error(`Invalid etag for part ${p.partNumber}`);
      }
      // S3 expects ETags wrapped in double quotes for Complete.
      const etag = p.etag.startsWith('"') ? p.etag : `"${p.etag}"`;
      return { partNumber: p.partNumber, etag };
    });

    // Tell S3 to assemble the parts. After this returns, the object exists.
    await s3CompleteMultipartUpload(objectKey, uploadId, cleanedParts);

    // Verify it actually landed before we commit a DB row.
    const head = await s3HeadObject(objectKey);
    if (!head) {
      void recordS3Telemetry({
        event: "server_fail",
        sessionId,
        errorKind: "head_missing",
        errorMessage: "Multipart upload completed but HEAD found nothing",
        userAgent: req.headers["user-agent"] ?? null,
      });
      return void res.status(404).json({
        error: "Multipart upload completed but object was not found in S3",
      });
    }
    const actualSize = typeof head.contentLength === "number" ? head.contentLength : 0;
    if (actualSize <= 0) {
      return void res.status(400).json({ error: "Assembled object is empty" });
    }

    const claimedSize =
      typeof sizeBytes === "number" ? sizeBytes : parseInt(String(sizeBytes ?? "0"), 10);
    if (claimedSize > 0 && Math.abs(claimedSize - actualSize) > 1024) {
      logger.warn(
        { objectKey, claimedSize, actualSize },
        "s3-multipart-complete: client size differs from S3 ContentLength — using S3 value",
      );
    }

    const safeMime = sanitiseMime(mimeType) ?? head.contentType ?? "application/octet-stream";
    const safeDuration =
      typeof durationSecs === "number" ? durationSecs : parseInt(String(durationSecs ?? "0"), 10);
    const safeFeatured = featured === true || featured === "true";

    try {
      await s3ReplaceObjectMetadata(
        objectKey,
        {
          aclpolicy: JSON.stringify({ owner: "admin", visibility: "private" }),
        },
        { contentType: safeMime },
      );
    } catch (aclErr) {
      logger.warn({ err: aclErr, objectKey }, "ACL stamp failed");
    }

    const id = randomUUID();
    const devDomain = process.env.REPLIT_DEV_DOMAIN;
    const baseUrl = process.env.API_BASE_URL ?? (devDomain ? `https://${devDomain}` : "");
    const localVideoUrl = `${baseUrl}/api/videos/${id}/source`;

    const measuredClientMs = (() => {
      const n =
        typeof clientDurationMs === "number"
          ? clientDurationMs
          : parseInt(String(clientDurationMs ?? "0"), 10);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    })();

    const [video] = await db
      .insert(videosTable)
      .values({
        id,
        youtubeId: `local-${id}`,
        title: title.trim(),
        description: "",
        thumbnailUrl: "",
        duration: safeDuration > 0 ? String(safeDuration) : "",
        category: (category ?? "sermon").trim() || "sermon",
        preacher: (preacher ?? "").trim(),
        publishedAt: null,
        featured: safeFeatured,
        viewCount: 0,
        videoSource: "local",
        localVideoUrl,
        originalFilename: (originalFilename ?? "").trim() || null,
        mimeType: safeMime,
        sizeBytes: actualSize,
        checksumSha256:
          typeof checksumSha256 === "string" && /^[a-f0-9]{64}$/i.test(checksumSha256)
            ? checksumSha256.toLowerCase()
            : null,
        objectPath: objectKey,
        uploadedBy: null,
      })
      .returning();

    let broadcastQueued = false;
    try {
      await upsertBroadcastQueueVideo(video);
      broadcastQueued = true;
    } catch (bqErr) {
      logger.error(
        { err: bqErr, videoId: id, sessionId },
        "upsertBroadcastQueueVideo failed after s3-multipart-complete",
      );
    }

    await invalidatePublicVideoCaches();

    logger.info(
      {
        videoId: id,
        sessionId,
        objectKey,
        sizeBytes: actualSize,
        partsCount: cleanedParts.length,
      },
      "S3 multipart upload finalized",
    );

    queueTranscodingJob(id, "", 1).catch((err) => {
      logger.error(
        { err, videoId: id },
        "queueTranscodingJob failed after s3-multipart-complete",
      );
    });

    void recordS3Telemetry({
      event: "success",
      sessionId,
      videoId: id,
      sizeBytes: actualSize,
      durationMs: measuredClientMs,
      userAgent: req.headers["user-agent"] ?? null,
    });

    res.status(201).json({ ...video, broadcastQueued });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err }, "s3-multipart-complete failed");
    void recordS3Telemetry({
      event: "server_fail",
      sessionId: (req.body as { sessionId?: string } | undefined)?.sessionId ?? null,
      errorKind: err instanceof Error ? err.name : "Error",
      errorMessage: msg,
      userAgent: req.headers["user-agent"] ?? null,
    });
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/videos/upload/s3-multipart-abort", async (req, res) => {
  try {
    if (!isS3Configured()) {
      return void res.status(503).json({
        error: "S3 object storage is not configured on this server.",
      });
    }
    const { uploadId, objectKey } = req.body as {
      uploadId?: string;
      objectKey?: string;
    };
    if (!uploadId || !SAFE_UPLOAD_ID_RE.test(uploadId)) {
      return void res.status(400).json({ error: "Invalid or missing uploadId" });
    }
    if (!objectKey || !SAFE_OBJECT_KEY_RE.test(objectKey)) {
      return void res.status(400).json({ error: "Invalid or missing objectKey" });
    }
    await s3AbortMultipartUpload(objectKey, uploadId);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err }, "s3-multipart-abort failed");
    res.status(500).json({ error: msg });
  }
});

// ── Client-reported telemetry (stalls, network errors, aborts) ──────────────
// The browser POSTs here when something goes wrong client-side so we can see
// it on the dashboard. Best-effort: we accept and log even on partial data.
router.post("/admin/videos/upload/s3-telemetry", async (req, res) => {
  try {
    const {
      sessionId,
      event,
      sizeBytes,
      durationMs,
      errorKind,
      errorMessage,
    } = req.body as {
      sessionId?: string;
      event?: string;
      sizeBytes?: number | string;
      durationMs?: number | string;
      errorKind?: string;
      errorMessage?: string;
    };

    const allowedClientEvents = new Set<S3TelemetryEvent>([
      "client_error",
      "client_stall",
      "client_abort",
    ]);
    if (!event || !allowedClientEvents.has(event as S3TelemetryEvent)) {
      return void res.status(400).json({
        error: `event must be one of: ${[...allowedClientEvents].join(", ")}`,
      });
    }

    const safeSize = (() => {
      const n = typeof sizeBytes === "number" ? sizeBytes : parseInt(String(sizeBytes ?? "0"), 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    })();
    const safeDuration = (() => {
      const n = typeof durationMs === "number" ? durationMs : parseInt(String(durationMs ?? "0"), 10);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    })();

    await recordS3Telemetry({
      event: event as S3TelemetryEvent,
      sessionId: sessionId ?? null,
      sizeBytes: safeSize,
      durationMs: safeDuration,
      errorKind: errorKind ?? null,
      errorMessage: errorMessage ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    });

    res.status(204).end();
  } catch (err) {
    logger.error({ err }, "s3-telemetry endpoint failed");
    res.status(500).json({ error: "telemetry_failed" });
  }
});

// Aggregations for the Operations page. Window in hours (default 24, max 168).
router.get("/admin/uploads/s3-telemetry/summary", async (req, res) => {
  try {
    const hoursRaw = parseInt(String(req.query.hours ?? "24"), 10);
    const hours = Math.min(Math.max(Number.isFinite(hoursRaw) ? hoursRaw : 24, 1), 168);
    const since = new Date(Date.now() - hours * 3600 * 1000);

    // Single round-trip aggregation by event type.
    const counts = await db
      .select({
        event: s3UploadTelemetryTable.event,
        count: count(),
      })
      .from(s3UploadTelemetryTable)
      .where(gte(s3UploadTelemetryTable.createdAt, since))
      .groupBy(s3UploadTelemetryTable.event);

    const byEvent: Record<string, number> = {};
    for (const e of S3_TELEMETRY_EVENTS) byEvent[e] = 0;
    for (const c of counts) byEvent[c.event] = Number(c.count);

    const initCount = byEvent.init ?? 0;
    const successCount = byEvent.success ?? 0;
    const failCount =
      (byEvent.server_fail ?? 0) + (byEvent.client_error ?? 0) + (byEvent.client_stall ?? 0);
    const totalAttempts = initCount;
    const successRatePct =
      totalAttempts > 0 ? Math.round((successCount / totalAttempts) * 1000) / 10 : null;

    // Throughput percentiles using PostgreSQL's percentile_cont over the
    // success rows (where throughputBps was computed at insert time).
    const throughputRows = await db.execute(sql`
      SELECT
        percentile_cont(0.5)  WITHIN GROUP (ORDER BY throughput_bps) AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY throughput_bps) AS p95,
        AVG(size_bytes)::bigint AS avg_size_bytes,
        SUM(size_bytes)::bigint AS total_bytes
      FROM s3_upload_telemetry
      WHERE event = 'success'
        AND created_at >= ${since}
        AND throughput_bps IS NOT NULL
    `);
    const tp = (throughputRows.rows[0] ?? {}) as {
      p50: string | number | null;
      p95: string | number | null;
      avg_size_bytes: string | number | null;
      total_bytes: string | number | null;
    };

    // Top error messages — group by errorMessage, top 5 by count.
    const topErrors = await db
      .select({
        errorKind: s3UploadTelemetryTable.errorKind,
        errorMessage: s3UploadTelemetryTable.errorMessage,
        count: count(),
      })
      .from(s3UploadTelemetryTable)
      .where(
        and(
          gte(s3UploadTelemetryTable.createdAt, since),
          inArray(s3UploadTelemetryTable.event, [
            "server_fail",
            "client_error",
            "client_stall",
          ]),
        ),
      )
      .groupBy(s3UploadTelemetryTable.errorKind, s3UploadTelemetryTable.errorMessage)
      .orderBy(desc(count()))
      .limit(5);

    res
      .setHeader("Cache-Control", "private, max-age=15")
      .json({
        windowHours: hours,
        since: since.toISOString(),
        counts: byEvent,
        attempts: totalAttempts,
        successes: successCount,
        failures: failCount,
        successRatePct,
        throughput: {
          p50Bps: tp.p50 != null ? Number(tp.p50) : null,
          p95Bps: tp.p95 != null ? Number(tp.p95) : null,
          avgSizeBytes: tp.avg_size_bytes != null ? Number(tp.avg_size_bytes) : null,
          totalBytes: tp.total_bytes != null ? Number(tp.total_bytes) : null,
        },
        topErrors: topErrors.map((e: { errorKind: string | null; errorMessage: string | null; count: number | string }) => ({
          errorKind: e.errorKind,
          errorMessage: e.errorMessage,
          count: Number(e.count),
        })),
      });
  } catch (err) {
    logger.error({ err }, "s3-telemetry summary failed");
    res.status(500).json({ error: "summary_failed" });
  }
});

// Stable playback URL for S3-hosted source files. Issues a 302 redirect to a
// short-lived presigned GET URL so the bytes are served straight from S3
// (Range requests, parallel connections, etc. are handled by S3) without
// requiring the client to know how to mint presigned URLs.
router.get("/videos/:id/source", async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const rows = await db
      .select({ objectPath: videosTable.objectPath })
      .from(videosTable)
      .where(eq(videosTable.id, id))
      .limit(1);
    const objectPath = rows[0]?.objectPath;
    if (!objectPath) {
      return void res.status(404).json({ error: "Video source not found" });
    }
    if (!isS3Configured()) {
      return void res.status(503).json({ error: "S3 not configured" });
    }
    const url = await s3GetSignedGetUrl(objectPath, S3_GET_REDIRECT_TTL_SEC);
    // Cache the redirect for less than the URL TTL so clients don't hold a
    // stale signature past expiry.
    res.setHeader("Cache-Control", `private, max-age=${Math.floor(S3_GET_REDIRECT_TTL_SEC / 2)}`);
    res.redirect(302, url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err }, "videos/:id/source failed");
    res.status(500).json({ error: msg });
  }
});

/**
 * Operator visibility into in-flight chunked uploads. Returns lightweight
 * summaries (no chunk-by-chunk detail) so the Operations page can show a
 * live "Active Uploads" panel and offer cancel-stuck-uploads ergonomics.
 */
router.get("/admin/uploads/active", (_req, res) => {
  const now = Date.now();
  const sessions = Array.from(uploadSessions.values())
    .map((s) => {
      const ageSecs = Math.max(0, Math.floor((now - s.createdAt.getTime()) / 1000));
      const idleSecs = Math.max(0, Math.floor((now - s.lastActivity.getTime()) / 1000));
      const progressPercent =
        s.totalChunks > 0
          ? Math.min(100, Math.round((s.uploadedChunks.size / s.totalChunks) * 100))
          : 0;
      return {
        sessionId: s.id,
        title: s.metadata.title,
        originalFilename: s.metadata.originalFilename || null,
        category: s.metadata.category,
        totalBytes: s.totalBytes,
        receivedBytes: Math.min(s.receivedBytes, s.totalBytes),
        totalChunks: s.totalChunks,
        uploadedChunks: s.uploadedChunks.size,
        progressPercent,
        ageSecs,
        idleSecs,
        finalizing: !!s.finalizing,
        createdAt: s.createdAt.toISOString(),
        lastActivity: s.lastActivity.toISOString(),
      };
    })
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));

  res.setHeader("Cache-Control", "no-store").json({ count: sessions.length, sessions });
});

router.delete("/admin/videos/upload/:sessionId", async (req, res) => {
  const { sessionId } = req.params as { sessionId: string };
  const session = uploadSessions.get(sessionId);
  // Don't yank an in-flight finalize — assembly is writing to disk and
  // about to insert the DB row. The cancel will succeed naturally once the
  // session is deleted by finalize itself.
  if (session?.finalizing) {
    return void res.status(409).json({
      error: "finalize_in_progress",
      message: "Cannot cancel an upload that is currently being finalized.",
    });
  }
  if (session) {
    destroyUploadSession(sessionId, session.tmpDir);
  }
  res.json({ ok: true });
});

router.post("/admin/videos/import", async (req, res) => {
  try {
    const parsed = ImportVideoBody.safeParse(req.body);
    if (!parsed.success) {
      return void res.status(400).json({ error: "Invalid request body" });
    }
    const { youtubeId, category, preacher, featured } = parsed.data;

    const cleanId = youtubeId.includes("youtube.com")
      ? new URL(youtubeId).searchParams.get("v") ?? youtubeId
      : youtubeId.replace(/^https?:\/\/(www\.)?youtu\.be\//, "").trim();

    let title = `YouTube Video ${cleanId}`;
    let thumbnailUrl = `https://img.youtube.com/vi/${cleanId}/hqdefault.jpg`;
    let description = "";
    let publishedAt: string | null = null;
    let duration = "";

    try {
      const oembedRes = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${cleanId}&format=json`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (oembedRes.ok) {
        const data = (await oembedRes.json()) as { title?: string; thumbnail_url?: string };
        if (data.title) title = data.title;
        if (data.thumbnail_url) thumbnailUrl = data.thumbnail_url;
      }
    } catch {}

    const id = randomUUID();
    const [video] = await db
      .insert(videosTable)
      .values({
        id,
        youtubeId: cleanId,
        title,
        description,
        thumbnailUrl,
        duration,
        category: category ?? "sermon",
        preacher: preacher ?? "",
        publishedAt,
        featured: featured ?? false,
        viewCount: 0,
      })
      .onConflictDoUpdate({
        target: videosTable.youtubeId,
        set: {
          title,
          thumbnailUrl,
          category: category ?? "sermon",
          preacher: preacher ?? "",
          featured: featured ?? false,
        },
      })
      .returning();

    await upsertBroadcastQueueVideo(video);
    await invalidatePublicVideoCaches();
    res.status(201).json(video);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.put("/admin/videos/:id", async (req, res) => {
  try {
    const { id } = UpdateAdminVideoParams.parse(req.params);
    const body = UpdateAdminVideoBody.safeParse(req.body);
    if (!body.success) {
      return void res.status(400).json({ error: "Invalid body" });
    }
    const updates = Object.fromEntries(Object.entries(body.data).filter(([, v]) => v !== undefined));
    const [video] = await db.update(videosTable).set(updates).where(eq(videosTable.id, id)).returning();
    if (!video) return void res.status(404).json({ error: "Video not found" });
    await upsertBroadcastQueueVideo(video);
    await invalidatePublicVideoCaches();
    res.json(video);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.delete("/admin/videos/:id", async (req, res) => {
  try {
    const { id } = DeleteAdminVideoParams.parse(req.params);
    const [video] = await db.select().from(videosTable).where(eq(videosTable.id, id)).limit(1);

    await db.delete(videosTable).where(eq(videosTable.id, id));
    await db.delete(broadcastQueueTable).where(eq(broadcastQueueTable.videoId, id));
    await invalidateBroadcastCache();
    broadcastLiveEvent("broadcast-queue-updated", { videoId: id, deleted: true, queuedAt: new Date().toISOString() });
    emitBroadcastState("queue-video-deleted", { videoId: id });

    if (video?.videoSource === "local") {
      const uploadsDir = path.join(__dirname, "..", "uploads");
      const hlsDir = path.join(uploadsDir, "hls", id);

      if (video.localVideoUrl) {
        try {
          const urlParts = video.localVideoUrl.split("/api/uploads/");
          const filename = urlParts[urlParts.length - 1];
          if (filename && !filename.includes("/")) {
            await fs.unlink(path.join(uploadsDir, filename)).catch(() => {});
          }
        } catch {}
      }
      await fs.rm(hlsDir, { recursive: true, force: true }).catch(() => {});

      if (video.thumbnailUrl) {
        try {
          const thumbParts = video.thumbnailUrl.split("/api/uploads/");
          const thumbFilename = thumbParts[thumbParts.length - 1];
          if (thumbFilename && !thumbFilename.includes("/")) {
            await fs.unlink(path.join(uploadsDir, thumbFilename)).catch(() => {});
          }
        } catch {}
      }
    }

    await invalidatePublicVideoCaches();
    res.json({ success: true, message: "Video deleted" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/videos/:youtubeId/view", async (req, res) => {
  try {
    const youtubeId = req.params.youtubeId;
    await db
      .update(videosTable)
      .set({ viewCount: sql`coalesce(view_count, 0) + 1` })
      .where(eq(videosTable.youtubeId, youtubeId));
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

const PUBLIC_LIST_CACHE_TTL_MS = 60_000;
const PUBLIC_LIST_CDN_HEADER = "public, max-age=30, stale-while-revalidate=60";

function projectVideoForPublic(v: typeof videosTable.$inferSelect) {
  return {
    id: v.id,
    youtubeId: v.youtubeId,
    title: v.title,
    description: v.description,
    thumbnailUrl: v.thumbnailUrl,
    duration: v.duration,
    category: v.category,
    preacher: v.preacher,
    publishedAt: v.publishedAt,
    views: v.viewCount,
    videoSource: v.videoSource,
    localVideoUrl: v.localVideoUrl,
    hlsMasterUrl: v.hlsMasterUrl,
    transcodingStatus: v.transcodingStatus,
  };
}

router.get("/videos/trending", async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const sinceDays = Math.min(365, Math.max(1, Number(req.query.sinceDays) || 90));
    const cacheKey = `public:videos:trending:${limit}:${sinceDays}`;

    const payload = await cache.getOrSet(
      cacheKey,
      async () => {
        const sinceDate = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
        const videos = await db
          .select()
          .from(videosTable)
          .where(sql`${videosTable.importedAt} >= ${sinceDate.toISOString()}`)
          .orderBy(desc(videosTable.viewCount), desc(videosTable.importedAt))
          .limit(limit);
        return videos.map(projectVideoForPublic);
      },
      PUBLIC_LIST_CACHE_TTL_MS,
    );

    res.setHeader("Cache-Control", PUBLIC_LIST_CDN_HEADER);
    res.json(payload);
  } catch (err) {
    logger.error({ err }, "/videos/trending failed");
    res.status(500).json({ error: "internal_error" });
  }
});

router.get("/videos/featured", async (_req, res) => {
  try {
    const payload = await cache.getOrSet(
      "public:videos:featured",
      async () => {
        const videos = await db
          .select()
          .from(videosTable)
          .where(eq(videosTable.featured, true))
          .orderBy(desc(videosTable.importedAt))
          .limit(10);
        return videos.map(projectVideoForPublic);
      },
      PUBLIC_LIST_CACHE_TTL_MS,
    );

    res.setHeader("Cache-Control", PUBLIC_LIST_CDN_HEADER);
    res.json(payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/playlists", async (_req, res) => {
  try {
    const rows = await cache.getOrSet(
      "public:playlists:active",
      async () =>
        db
          .select({
            id: playlistsTable.id,
            name: playlistsTable.name,
            description: playlistsTable.description,
            loopMode: playlistsTable.loopMode,
            isActive: playlistsTable.isActive,
            createdAt: playlistsTable.createdAt,
            updatedAt: playlistsTable.updatedAt,
            videoCount: sql<number>`CAST(COUNT(${playlistVideosTable.id}) AS INTEGER)`,
          })
          .from(playlistsTable)
          .leftJoin(playlistVideosTable, eq(playlistVideosTable.playlistId, playlistsTable.id))
          .where(eq(playlistsTable.isActive, true))
          .groupBy(playlistsTable.id)
          .orderBy(desc(playlistsTable.createdAt)),
      30_000,
    );

    res.setHeader("Cache-Control", PUBLIC_LIST_CDN_HEADER);
    res.json(rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/playlists/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const [playlist] = await db
      .select()
      .from(playlistsTable)
      .where(eq(playlistsTable.id, id));
    if (!playlist) return void res.status(404).json({ error: "Playlist not found" });
    const videos = await db
      .select()
      .from(playlistVideosTable)
      .where(eq(playlistVideosTable.playlistId, id))
      .orderBy(playlistVideosTable.sortOrder);
    res.json({ ...playlist, videos });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

async function getPlaylistWithVideos(id: string) {
  const [playlist] = await db.select().from(playlistsTable).where(eq(playlistsTable.id, id));
  if (!playlist) return null;
  const videos = await db
    .select()
    .from(playlistVideosTable)
    .where(eq(playlistVideosTable.playlistId, id))
    .orderBy(playlistVideosTable.sortOrder);
  return { ...playlist, videos };
}

router.get("/admin/playlists", async (req, res) => {
  try {
    const rows = await db
      .select({
        id: playlistsTable.id,
        name: playlistsTable.name,
        description: playlistsTable.description,
        loopMode: playlistsTable.loopMode,
        isActive: playlistsTable.isActive,
        createdAt: playlistsTable.createdAt,
        updatedAt: playlistsTable.updatedAt,
        videoCount: sql<number>`CAST(COUNT(${playlistVideosTable.id}) AS INTEGER)`,
      })
      .from(playlistsTable)
      .leftJoin(playlistVideosTable, eq(playlistVideosTable.playlistId, playlistsTable.id))
      .groupBy(playlistsTable.id)
      .orderBy(desc(playlistsTable.createdAt));
    res.json(rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/playlists", async (req, res) => {
  try {
    const parsed = CreatePlaylistBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid body" });
    const { name, description, loopMode, isActive } = parsed.data;
    const [playlist] = await db
      .insert(playlistsTable)
      .values({
        id: randomUUID(),
        name,
        description: description ?? "",
        loopMode: loopMode ?? "sequential",
        isActive: isActive ?? true,
      })
      .returning();
    await invalidatePublicPlaylistCaches();
    res.status(201).json({ ...playlist, videoCount: 0 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/admin/playlists/:id", async (req, res) => {
  try {
    const { id } = GetPlaylistParams.parse(req.params);
    const result = await getPlaylistWithVideos(id);
    if (!result) return void res.status(404).json({ error: "Playlist not found" });
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.put("/admin/playlists/:id", async (req, res) => {
  try {
    const { id } = UpdatePlaylistParams.parse(req.params);
    const parsed = UpdatePlaylistBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid body" });
    const updates = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    const [playlist] = await db.update(playlistsTable).set(updates).where(eq(playlistsTable.id, id)).returning();
    if (!playlist) return void res.status(404).json({ error: "Playlist not found" });
    const [countResult] = await db
      .select({ count: count() })
      .from(playlistVideosTable)
      .where(eq(playlistVideosTable.playlistId, id));
    await invalidatePublicPlaylistCaches();
    res.json({ ...playlist, videoCount: countResult?.count ?? 0 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.delete("/admin/playlists/:id", async (req, res) => {
  try {
    const { id } = DeletePlaylistParams.parse(req.params);
    await db.delete(playlistsTable).where(eq(playlistsTable.id, id));
    await invalidatePublicPlaylistCaches();
    res.json({ success: true, message: "Playlist deleted" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/playlists/:id/videos", async (req, res) => {
  try {
    const { id } = AddVideoToPlaylistParams.parse(req.params);
    const parsed = AddVideoToPlaylistBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid body" });
    const { videoId } = parsed.data;

    const [video] = await db.select().from(videosTable).where(eq(videosTable.id, videoId));
    if (!video) return void res.status(404).json({ error: "Video not found" });

    const existing = await db
      .select()
      .from(playlistVideosTable)
      .where(eq(playlistVideosTable.playlistId, id))
      .orderBy(desc(playlistVideosTable.sortOrder))
      .limit(1);

    const maxOrder = existing[0]?.sortOrder ?? -1;
    await db.insert(playlistVideosTable).values({
      id: randomUUID(),
      playlistId: id,
      videoId: video.id,
      youtubeId: video.youtubeId,
      title: video.title,
      thumbnailUrl: video.thumbnailUrl,
      duration: video.duration,
      category: video.category,
      sortOrder: maxOrder + 1,
    });

    const result = await getPlaylistWithVideos(id);
    await invalidatePublicPlaylistCaches();
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.delete("/admin/playlists/:id/videos/:videoId", async (req, res) => {
  try {
    const { id } = RemoveVideoFromPlaylistParams.parse(req.params);
    const videoId = req.params.videoId;
    await db.delete(playlistVideosTable).where(sql`playlist_id = ${id} AND (video_id = ${videoId} OR id = ${videoId})`);
    const result = await getPlaylistWithVideos(id);
    await invalidatePublicPlaylistCaches();
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.put("/admin/playlists/:id/reorder", async (req, res) => {
  try {
    const { id } = ReorderPlaylistParams.parse(req.params);
    const parsed = ReorderPlaylistBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid body" });
    const { videoIds } = parsed.data;

    for (let i = 0; i < videoIds.length; i++) {
      await db
        .update(playlistVideosTable)
        .set({ sortOrder: i })
        .where(sql`playlist_id = ${id} AND (video_id = ${videoIds[i]} OR id = ${videoIds[i]})`);
    }

    const result = await getPlaylistWithVideos(id);
    await invalidatePublicPlaylistCaches();
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/admin/schedule", async (req, res) => {
  try {
    const entries = await db
      .select()
      .from(scheduleTable)
      .orderBy(scheduleTable.dayOfWeek, scheduleTable.startTime);
    res.json(entries);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/schedule", async (req, res) => {
  try {
    const parsed = CreateScheduleEntryBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid body" });
    const [entry] = await db
      .insert(scheduleTable)
      .values({
        id: randomUUID(),
        ...parsed.data,
        isRecurring: parsed.data.isRecurring ?? true,
        isActive: parsed.data.isActive ?? true,
      })
      .returning();
    await invalidateBroadcastCache();
    broadcastLiveEvent("broadcast-schedule-updated", { id: entry.id, reason: "created", queuedAt: new Date().toISOString() });
    emitBroadcastState("schedule-created", { id: entry.id });
    res.status(201).json(entry);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.put("/admin/schedule/:id", async (req, res) => {
  try {
    const { id } = UpdateScheduleEntryParams.parse(req.params);
    const parsed = UpdateScheduleEntryBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid body" });
    const updates = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    const [entry] = await db.update(scheduleTable).set(updates).where(eq(scheduleTable.id, id)).returning();
    if (!entry) return void res.status(404).json({ error: "Schedule entry not found" });
    await invalidateBroadcastCache();
    broadcastLiveEvent("broadcast-schedule-updated", { id: entry.id, reason: "updated", queuedAt: new Date().toISOString() });
    emitBroadcastState("schedule-updated", { id: entry.id });
    res.json(entry);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.delete("/admin/schedule/:id", async (req, res) => {
  try {
    const { id } = DeleteScheduleEntryParams.parse(req.params);
    await db.delete(scheduleTable).where(eq(scheduleTable.id, id));
    await invalidateBroadcastCache();
    broadcastLiveEvent("broadcast-schedule-updated", { id, reason: "deleted", queuedAt: new Date().toISOString() });
    emitBroadcastState("schedule-deleted", { id });
    res.json({ success: true, message: "Schedule entry deleted" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/push-tokens", async (req, res) => {
  try {
    const { token, platform } = req.body as { token?: string; platform?: string };
    if (!token || typeof token !== "string" || token.length === 0) {
      return void res.status(400).json({ error: "token is required" });
    }
    if (platform !== "ios" && platform !== "android") {
      return void res.status(400).json({ error: "platform must be ios or android" });
    }

    await db
      .insert(pushTokensTable)
      .values({ id: randomUUID(), token, platform })
      .onConflictDoUpdate({
        target: pushTokensTable.token,
        set: { lastSeenAt: sql`now()`, platform },
      });

    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/push/web-vapid-public-key", async (_req, res) => {
  try {
    const publicKey = await getVapidPublicKey();
    res.json({ publicKey });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/push/web-subscriptions", async (req, res) => {
  try {
    const { endpoint, keys, userAgent } = req.body as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
      userAgent?: string;
    };
    if (!endpoint || typeof endpoint !== "string" || endpoint.length === 0) {
      return void res.status(400).json({ error: "endpoint is required" });
    }
    if (!keys?.p256dh || !keys?.auth) {
      return void res.status(400).json({ error: "keys.p256dh and keys.auth are required" });
    }
    await db
      .insert(webPushSubscriptionsTable)
      .values({
        id: randomUUID(),
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent: userAgent ?? null,
      })
      .onConflictDoUpdate({
        target: webPushSubscriptionsTable.endpoint,
        set: { p256dh: keys.p256dh, auth: keys.auth, lastSeenAt: sql`now()` },
      });
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/notifications/send", async (req, res) => {
  try {
    const parsed = SendPushNotificationBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid body" });
    const { title, body, type, videoId } = parsed.data;

    const tokenRows = await db.select({ token: pushTokensTable.token }).from(pushTokensTable);
    const tokens = tokenRows.map((r: { token: string }) => r.token);

    const expoData: { type: typeof type; videoId?: string } = { type };
    if (videoId) expoData.videoId = videoId;

    const [expoResult, webResult] = await Promise.all([
      tokens.length > 0
        ? sendExpoPushNotifications(tokens, title, body, expoData)
        : Promise.resolve({ sent: 0, failed: 0 }),
      sendWebPushNotifications(title, body, expoData),
    ]);

    const sent = expoResult.sent + webResult.sent;
    const failed = expoResult.failed + webResult.failed;
    const [webSubsCountResult] = await db
      .select({ count: count() })
      .from(webPushSubscriptionsTable);
    const webSubsCount = Number(webSubsCountResult?.count ?? 0);
    const totalRecipients = tokens.length + webSubsCount;

    await db.insert(notificationsTable).values({
      id: randomUUID(),
      title,
      body,
      type,
      videoId: videoId ?? null,
      sentCount: sent,
    });

    res.json({
      sent,
      failed,
      total: totalRecipients,
      message:
        totalRecipients === 0
          ? "No registered devices found. Devices register automatically when they open the app."
          : `Notification sent to ${sent}/${totalRecipients} devices (native: ${expoResult.sent}/${tokens.length}, web: ${webResult.sent}/${webSubsCount}).`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/admin/notifications/history", async (req, res) => {
  try {
    const history = await db
      .select()
      .from(notificationsTable)
      .orderBy(desc(notificationsTable.sentAt))
      .limit(50);
    res.json(history);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/admin/notifications/scheduled", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(scheduledNotificationsTable)
      .orderBy(asc(scheduledNotificationsTable.scheduledAt))
      .limit(100);
    res.json(rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/notifications/schedule", async (req, res) => {
  try {
    const { title, body, type, videoId, scheduledAt } = req.body as {
      title: string;
      body: string;
      type: string;
      videoId?: string;
      scheduledAt: string;
    };
    if (!title || !body || !type || !scheduledAt) {
      return void res.status(400).json({ error: "title, body, type, and scheduledAt are required" });
    }
    const schedDate = new Date(scheduledAt);
    if (isNaN(schedDate.getTime()) || schedDate <= new Date()) {
      return void res.status(400).json({ error: "scheduledAt must be a valid future date" });
    }
    const row = {
      id: randomUUID(),
      title,
      body,
      type,
      videoId: videoId ?? null,
      scheduledAt: schedDate,
      status: "pending" as const,
    };
    await db.insert(scheduledNotificationsTable).values(row);
    res.json(row);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.delete("/admin/notifications/scheduled/:id", async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const rows = await db
      .select()
      .from(scheduledNotificationsTable)
      .where(eq(scheduledNotificationsTable.id, id));
    if (rows.length === 0) return void res.status(404).json({ error: "Not found" });
    if (rows[0].status !== "pending") {
      return void res.status(400).json({ error: "Only pending notifications can be cancelled" });
    }
    await db
      .update(scheduledNotificationsTable)
      .set({ status: "cancelled" })
      .where(eq(scheduledNotificationsTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/admin/analytics", async (req, res) => {
  try {
    const parsed = GetAnalyticsQueryParams.safeParse(req.query);
    const period = parsed.success ? (parsed.data.period ?? "30d") : "30d";
    const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [
      totalViewsResult,
      topVideosRows,
      categoryRows,
      dailyWatchRows,
      uniqueViewersResult,
      avgWatchTimeResult,
      liveEventsResult,
    ] = await Promise.all([
      db.select({ total: sql<number>`coalesce(sum(view_count), 0)` }).from(videosTable),
      db
        .select({
          youtubeId: videosTable.youtubeId,
          title: videosTable.title,
          views: videosTable.viewCount,
          thumbnailUrl: videosTable.thumbnailUrl,
        })
        .from(videosTable)
        .orderBy(desc(videosTable.viewCount))
        .limit(5),
      db.select({ category: videosTable.category, count: count() }).from(videosTable).groupBy(videosTable.category),
      db
        .select({
          date: sql<string>`to_char(watched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
          views: count(),
        })
        .from(userWatchHistoryTable)
        .where(gte(userWatchHistoryTable.watchedAt, cutoff))
        .groupBy(sql`to_char(watched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`)
        .orderBy(sql`to_char(watched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`),
      db
        .select({ count: sql<number>`count(DISTINCT user_id)` })
        .from(userWatchHistoryTable)
        .where(gte(userWatchHistoryTable.watchedAt, cutoff)),
      db
        .select({ avgSecs: sql<number>`coalesce(round(avg(progress_secs)), 0)` })
        .from(userWatchHistoryTable)
        .where(gte(userWatchHistoryTable.watchedAt, cutoff)),
      db
        .select({ count: count() })
        .from(liveOverridesTable)
        .where(gte(liveOverridesTable.createdAt, cutoff)),
    ]);

    const totalCatCount = categoryRows.reduce((s: number, r: { category: string; count: number }) => s + r.count, 0);
    const dailyViewsMap = new Map<string, number>(dailyWatchRows.map((r: { date: string; views: number | string }) => [r.date, Number(r.views)]));

    const dailyViews = Array.from({ length: days }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (days - 1 - i));
      const dateStr = d.toISOString().split("T")[0];
      return { date: dateStr, views: dailyViewsMap.get(dateStr) ?? 0 };
    });

    res.json({
      period,
      totalViews: Number(totalViewsResult[0]?.total ?? 0),
      uniqueViewers: Number(uniqueViewersResult[0]?.count ?? 0),
      avgWatchTimeMinutes: Math.round(Number(avgWatchTimeResult[0]?.avgSecs ?? 0) / 60),
      liveStreamEvents: Number(liveEventsResult[0]?.count ?? 0),
      topVideos: topVideosRows,
      categoryBreakdown: categoryRows.map((r: { category: string; count: number }) => ({
        category: r.category,
        count: r.count,
        percentage: totalCatCount > 0 ? Math.round((r.count / totalCatCount) * 100) : 0,
      })),
      dailyViews,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/admin/live/events", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // Disable Nagle buffering so each SSE frame is sent immediately
  req.socket?.setNoDelay(true);

  res.flushHeaders();

  const client = addSSEClient(res, req.query.platform ?? "admin");

  try {
    const payload = await buildLiveStatusPayload();
    res.write(`event: status\ndata: ${JSON.stringify(payload)}\n\n`);
    // Flush compression/proxy buffers so the frame reaches the client now
    const r = res as unknown as { flush?: () => void };
    if (typeof r.flush === "function") r.flush();
  } catch (err) {
    logger.error({ err }, "[SSE /admin/live/events] initial write failed");
  }

  req.on("close", () => removeSSEClient(client));
});

router.get("/admin/live", async (_req, res) => {
  try {
    const [liveOverride, deviceCountResult] = await Promise.all([
      getActiveLiveOverride(),
      db.select({ count: count() }).from(pushTokensTable),
    ]);
    const deviceCount = Number(deviceCountResult[0]?.count ?? 0);

    const ytStatus = getLiveStatus();
    const ytLive = ytStatus.isLive;
    const ytVideoId = ytStatus.videoId;
    const ytTitle = ytStatus.title;

    const isLive = !!(liveOverride || ytLive);
    const now = Date.now();
    const elapsedSecs = liveOverride
      ? Math.floor((now - liveOverride.startedAt.getTime()) / 1000)
      : null;
    const remainingSecs = liveOverride?.endsAt
      ? Math.max(0, Math.floor((liveOverride.endsAt.getTime() - now) / 1000))
      : null;

    res.json({
      isLive,
      deviceCount,
      ytLive,
      ytVideoId,
      ytTitle,
      checkedAt: ytStatus.checkedAt,
      liveOverride: liveOverride ? {
        id: liveOverride.id,
        title: liveOverride.title,
        startedAt: liveOverride.startedAt.toISOString(),
        endsAt: liveOverride.endsAt?.toISOString() ?? null,
        elapsedSecs,
        remainingSecs,
      } : null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/admin/live-overrides", async (_req, res) => {
  try {
    const overrides = await db.select().from(liveOverridesTable).orderBy(desc(liveOverridesTable.startedAt));
    res.json(overrides);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

router.post("/admin/live-overrides", async (req, res) => {
  try {
    const { title, hlsStreamUrl, rtmpIngestKey, streamNotes, endsAt, notify = true } = req.body as {
      title?: string;
      hlsStreamUrl?: string | null;
      rtmpIngestKey?: string | null;
      streamNotes?: string | null;
      endsAt?: string | null;
      notify?: boolean;
    };
    if (title !== undefined && typeof title !== "string") {
      return void res.status(400).json({ error: "title must be a string" });
    }
    if (rtmpIngestKey !== undefined && rtmpIngestKey !== null && typeof rtmpIngestKey !== "string") {
      return void res.status(400).json({ error: "rtmpIngestKey must be a string" });
    }
    if (streamNotes !== undefined && streamNotes !== null && typeof streamNotes !== "string") {
      return void res.status(400).json({ error: "streamNotes must be a string" });
    }
    if (notify !== undefined && typeof notify !== "boolean") {
      return void res.status(400).json({ error: "notify must be a boolean" });
    }
    const urlCheck = validateStreamUrl(hlsStreamUrl);
    if (!urlCheck.ok) return void res.status(400).json({ error: urlCheck.error });
    let endsAtDate: Date | null = null;
    if (endsAt) {
      endsAtDate = new Date(endsAt);
      if (Number.isNaN(endsAtDate.getTime())) {
        return void res.status(400).json({ error: "endsAt must be a valid ISO date" });
      }
    }
    await db.update(liveOverridesTable).set({ isActive: false }).where(eq(liveOverridesTable.isActive, true));
    const startedAt = new Date();
    const [override] = await db.insert(liveOverridesTable).values({
      id: randomUUID(),
      title: title?.trim() || "Temple TV Live",
      hlsStreamUrl: urlCheck.value,
      rtmpIngestKey: rtmpIngestKey?.trim() || null,
      streamNotes: streamNotes?.trim() || null,
      startedAt,
      endsAt: endsAtDate,
      isActive: true,
    }).returning();

    if (notify) {
      const tokenRows = await db.select().from(pushTokensTable);
      const pushResult = await sendExpoPushNotifications(
        tokenRows.map((r: typeof pushTokensTable.$inferSelect) => r.token),
        "Temple TV is Live",
        override.title,
        { type: "live_service", route: "/player", live: true }
      );
      await db.insert(notificationsTable).values({
        id: randomUUID(), title: "Temple TV is Live", body: override.title, type: "live_service", sentCount: pushResult.sent,
      });
    }

    await invalidateBroadcastCache();
    emitBroadcastState("live-started", { id: override.id });
    broadcastLiveEvent("broadcast-control-updated", { reason: "live-started", id: override.id, queuedAt: new Date().toISOString() });
    res.status(201).json(override);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

router.patch("/admin/live-overrides/:id", async (req, res) => {
  const { id } = req.params as { id: string };
  try {
    const { isActive, title, hlsStreamUrl, streamNotes, endsAt } = req.body as {
      isActive?: boolean; title?: string; hlsStreamUrl?: string | null; streamNotes?: string | null; endsAt?: string | null;
    };
    const updates: Record<string, unknown> = {};
    if (isActive !== undefined) {
      if (typeof isActive !== "boolean") return void res.status(400).json({ error: "isActive must be a boolean" });
      updates.isActive = isActive;
    }
    if (title !== undefined) {
      if (typeof title !== "string") return void res.status(400).json({ error: "title must be a string" });
      updates.title = title.trim();
    }
    if (hlsStreamUrl !== undefined) {
      const urlCheck = validateStreamUrl(hlsStreamUrl);
      if (!urlCheck.ok) return void res.status(400).json({ error: urlCheck.error });
      updates.hlsStreamUrl = urlCheck.value;
    }
    if (streamNotes !== undefined) {
      if (streamNotes !== null && typeof streamNotes !== "string") {
        return void res.status(400).json({ error: "streamNotes must be a string" });
      }
      updates.streamNotes = streamNotes ? streamNotes.trim() : null;
    }
    if (endsAt !== undefined) {
      if (endsAt === null) {
        updates.endsAt = null;
      } else {
        const d = new Date(endsAt);
        if (Number.isNaN(d.getTime())) return void res.status(400).json({ error: "endsAt must be a valid ISO date" });
        updates.endsAt = d;
      }
    }
    if (Object.keys(updates).length === 0) {
      return void res.status(400).json({ error: "No valid fields to update" });
    }
    const [updated] = await db.update(liveOverridesTable).set(updates).where(eq(liveOverridesTable.id, id)).returning();
    if (!updated) return void res.status(404).json({ error: "Override not found" });
    await invalidateBroadcastCache();
    emitBroadcastState("live-updated", { id });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

router.post("/admin/live/override/start", async (req, res) => {
  try {
    const { title, durationMinutes = 120, notify = true, hlsStreamUrl, rtmpIngestKey, streamNotes } = req.body as {
      title?: string;
      durationMinutes?: number;
      notify?: boolean;
      hlsStreamUrl?: string | null;
      rtmpIngestKey?: string | null;
      streamNotes?: string | null;
    };
    if (title !== undefined && typeof title !== "string") {
      return void res.status(400).json({ error: "title must be a string" });
    }
    if (rtmpIngestKey !== undefined && rtmpIngestKey !== null && typeof rtmpIngestKey !== "string") {
      return void res.status(400).json({ error: "rtmpIngestKey must be a string" });
    }
    if (streamNotes !== undefined && streamNotes !== null && typeof streamNotes !== "string") {
      return void res.status(400).json({ error: "streamNotes must be a string" });
    }
    if (notify !== undefined && typeof notify !== "boolean") {
      return void res.status(400).json({ error: "notify must be a boolean" });
    }
    if (durationMinutes !== undefined && typeof durationMinutes !== "number") {
      return void res.status(400).json({ error: "durationMinutes must be a number" });
    }
    const urlCheck = validateStreamUrl(hlsStreamUrl);
    if (!urlCheck.ok) return void res.status(400).json({ error: urlCheck.error });
    const safeDuration = Number.isFinite(durationMinutes) ? Math.max(5, Math.min(480, durationMinutes)) : 120;
    const startedAt = new Date();
    const endsAt = new Date(startedAt.getTime() + safeDuration * 60 * 1000);

    await db.update(liveOverridesTable).set({ isActive: false }).where(eq(liveOverridesTable.isActive, true));

    const [override] = await db
      .insert(liveOverridesTable)
      .values({
        id: randomUUID(),
        title: title?.trim() || "Temple TV Live Service",
        hlsStreamUrl: urlCheck.value,
        rtmpIngestKey: rtmpIngestKey?.trim() || null,
        streamNotes: streamNotes?.trim() || null,
        startedAt,
        endsAt,
        isActive: true,
      })
      .returning();

    let pushResult = { sent: 0, failed: 0 };
    if (notify) {
      const tokenRows = await db.select().from(pushTokensTable);
      pushResult = await sendExpoPushNotifications(
        tokenRows.map((row: typeof pushTokensTable.$inferSelect) => row.token),
        "Temple TV is live",
        override.title,
        { type: "live_service", route: "/player", live: true }
      );
      await db.insert(notificationsTable).values({
        id: randomUUID(),
        title: "Temple TV is live",
        body: override.title,
        type: "live_service",
        sentCount: pushResult.sent,
      });
    }

    await invalidateBroadcastCache();
    buildLiveStatusPayload().then((payload) => broadcastLiveEvent("status", payload)).catch(() => {});
    broadcastLiveEvent("broadcast-control-updated", { reason: "live-started", id: override.id, queuedAt: new Date().toISOString() });
    emitBroadcastState("live-started", { id: override.id });

    res.status(201).json({ override, push: pushResult });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/live/override/stop", async (_req, res) => {
  try {
    const active = await getActiveLiveOverride();
    if (!active) return void res.json({ ok: true, stopped: 0 });
    await db
      .update(liveOverridesTable)
      .set({ isActive: false, endsAt: new Date() })
      .where(eq(liveOverridesTable.id, active.id));

    await invalidateBroadcastCache();
    buildLiveStatusPayload().then((payload) => broadcastLiveEvent("status", payload)).catch(() => {});
    broadcastLiveEvent("broadcast-control-updated", { reason: "live-stopped", id: active.id, queuedAt: new Date().toISOString() });
    emitBroadcastState("live-stopped", { id: active.id });

    res.json({ ok: true, stopped: 1 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/live/override/extend", async (req, res) => {
  try {
    const { extraMinutes = 30 } = req.body as { extraMinutes?: number };
    const safe = Number.isFinite(extraMinutes) ? Math.max(5, Math.min(240, extraMinutes)) : 30;
    const active = await getActiveLiveOverride();
    if (!active) return void res.status(404).json({ error: "No active live override" });
    const base = active.endsAt && active.endsAt > new Date() ? active.endsAt : new Date();
    const newEndsAt = new Date(base.getTime() + safe * 60 * 1000);
    const [updated] = await db
      .update(liveOverridesTable)
      .set({ endsAt: newEndsAt })
      .where(eq(liveOverridesTable.id, active.id))
      .returning();

    await invalidateBroadcastCache();
    buildLiveStatusPayload().then((payload) => broadcastLiveEvent("status", payload)).catch(() => {});
    broadcastLiveEvent("broadcast-control-updated", { reason: "live-extended", id: active.id, queuedAt: new Date().toISOString() });
    emitBroadcastState("live-extended", { id: active.id });

    res.json({ ok: true, override: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

// ── Process status (per-process role + transcoder worker liveness) ──────────
// Reports the current process's identity (the API process answering this
// request) and infers the worker's liveness from its heartbeat written to
// the shared cache by `lib/transcoder.ts#startRetryTick`. Used by the Live
// Monitor to show both processes side-by-side after the api/worker split.
router.get("/admin/process-status", async (_req, res) => {
  try {
    const runMode = (process.env.RUN_MODE ?? "all").toLowerCase();
    const memUsage = process.memoryUsage();
    const thisProcess = {
      pid: process.pid,
      runMode,
      role: runMode === "worker" ? "worker" : "api",
      uptimeSec: Math.round(process.uptime()),
      rssMb: Math.round(memUsage.rss / 1024 / 1024),
      heapUsedMb: Math.round(memUsage.heapUsed / 1024 / 1024),
      nodeVersion: process.version,
    };

    // Single grouped count for queue depth — keeps DB load to one query.
    const groups = await db
      .select({
        status: transcodingJobsTable.status,
        n: count(),
      })
      .from(transcodingJobsTable)
      .groupBy(transcodingJobsTable.status);

    const queue = { queued: 0, processing: 0, failed: 0, done: 0 };
    for (const g of groups) {
      const k = g.status as keyof typeof queue;
      if (k in queue) queue[k] = Number(g.n);
    }

    // Worker heartbeat (written by the transcoder process to shared cache).
    // In `RUN_MODE=all` (single-process dev), this process IS the worker so
    // the heartbeat reflects ourselves; in production-split deployments the
    // worker is a separate Render service and writes its own heartbeat.
    const beat = await cache.get<{
      pid: number;
      ts: number;
      runMode: string;
      nodeVersion: string;
      rssMb: number;
    }>(TRANSCODER_HEARTBEAT_KEY);

    const now = Date.now();
    const heartbeatAgeSec = beat ? Math.round((now - beat.ts) / 1000) : null;
    // Healthy if a heartbeat arrived in the last 90s (retry tick is 30s).
    const workerAlive = heartbeatAgeSec !== null && heartbeatAgeSec < 90;
    const sameProcess = beat?.pid === process.pid;

    // Most recent finished job (done or failed) — joined to videos for title.
    // Surfaces "is the worker actually doing work?" beyond just liveness.
    const lastJobRows = await db
      .select({
        id: transcodingJobsTable.id,
        videoId: transcodingJobsTable.videoId,
        status: transcodingJobsTable.status,
        startedAt: transcodingJobsTable.startedAt,
        completedAt: transcodingJobsTable.completedAt,
        errorMessage: transcodingJobsTable.errorMessage,
        videoTitle: videosTable.title,
      })
      .from(transcodingJobsTable)
      .leftJoin(videosTable, eq(transcodingJobsTable.videoId, videosTable.id))
      .where(inArray(transcodingJobsTable.status, ["done", "failed"]))
      .orderBy(desc(transcodingJobsTable.completedAt))
      .limit(1);

    const lastJob = lastJobRows[0]
      ? (() => {
          const r = lastJobRows[0];
          const completedMs = r.completedAt ? r.completedAt.getTime() : null;
          const startedMs = r.startedAt ? r.startedAt.getTime() : null;
          return {
            id: r.id,
            videoId: r.videoId,
            videoTitle: r.videoTitle ?? null,
            status: r.status as "done" | "failed",
            completedAt: r.completedAt ? r.completedAt.toISOString() : null,
            endedAgoSec:
              completedMs !== null
                ? Math.max(0, Math.round((now - completedMs) / 1000))
                : null,
            durationMs:
              completedMs !== null && startedMs !== null
                ? Math.max(0, completedMs - startedMs)
                : null,
            errorMessage: r.errorMessage,
          };
        })()
      : null;

    const s3Configured = isS3Configured();
    res.setHeader("Cache-Control", "no-store").json({
      thisProcess,
      transcoder: {
        queue,
        heartbeat: beat
          ? {
              pid: beat.pid,
              ageSec: heartbeatAgeSec,
              runMode: beat.runMode,
              nodeVersion: beat.nodeVersion,
              rssMb: beat.rssMb,
              sameProcess,
            }
          : null,
        alive: workerAlive,
        lastJob,
      },
      infrastructure: {
        s3: {
          configured: s3Configured,
          bucket: s3Configured ? AWS_S3_BUCKET : null,
          region: s3Configured ? AWS_REGION : null,
        },
        cache: cache.status(),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err }, "process-status failed");
    res.status(500).json({ error: msg });
  }
});

router.get("/admin/transcoding/queue", async (_req, res) => {
  try {
    const jobs = await db
      .select({
        job: transcodingJobsTable,
        videoTitle: videosTable.title,
        videoThumbnail: videosTable.thumbnailUrl,
      })
      .from(transcodingJobsTable)
      .leftJoin(videosTable, eq(transcodingJobsTable.videoId, videosTable.id))
      .orderBy(desc(transcodingJobsTable.priority), asc(transcodingJobsTable.createdAt));

    type JobRow = (typeof jobs)[number];
    const activeCount = jobs.filter((j: JobRow) => j.job.status === "processing").length;
    const queuedCount = jobs.filter((j: JobRow) => j.job.status === "queued").length;
    const failedCount = jobs.filter((j: JobRow) => j.job.status === "failed").length;
    const doneCount = jobs.filter((j: JobRow) => j.job.status === "done").length;

    res.json({
      jobs: jobs.map((r: JobRow) => ({
        ...r.job,
        videoTitle: r.videoTitle ?? "Unknown",
        videoThumbnail: r.videoThumbnail ?? "",
      })),
      stats: { activeCount, queuedCount, failedCount, doneCount, total: jobs.length },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/admin/transcoding/jobs/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params as { jobId: string };
    const rows = await db
      .select({
        job: transcodingJobsTable,
        videoTitle: videosTable.title,
        videoThumbnail: videosTable.thumbnailUrl,
      })
      .from(transcodingJobsTable)
      .leftJoin(videosTable, eq(transcodingJobsTable.videoId, videosTable.id))
      .where(eq(transcodingJobsTable.id, jobId));

    const row = rows[0];
    if (!row) return void res.status(404).json({ error: "Job not found" });

    res.json({ ...row.job, videoTitle: row.videoTitle ?? "Unknown", videoThumbnail: row.videoThumbnail ?? "" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/transcoding/retry/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params as { jobId: string };
    await retryTranscodingJob(jobId);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

// NOTE: /clear must be declared before /:jobId so the literal path wins over the wildcard.
router.delete("/admin/transcoding/clear", async (req, res) => {
  try {
    const { status } = req.query as { status?: string };
    const allowed = ["done", "failed", "cancelled"];
    const statuses: string[] = status === "all" ? allowed : allowed.filter((s) => s === status);
    if (statuses.length === 0) {
      return void res.status(400).json({ error: "Invalid status. Use done, failed, cancelled, or all." });
    }
    const result = await db
      .delete(transcodingJobsTable)
      .where(inArray(transcodingJobsTable.status, statuses as ("done" | "failed" | "cancelled")[]))
      .returning({ id: transcodingJobsTable.id });
    res.json({ cleared: result.length, statuses });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.delete("/admin/transcoding/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params as { jobId: string };
    const rows = await db
      .select()
      .from(transcodingJobsTable)
      .where(
        and(
          eq(transcodingJobsTable.id, jobId),
          inArray(transcodingJobsTable.status, ["queued", "failed"]),
        ),
      );

    if (rows.length === 0) {
      return void res.status(400).json({ error: "Only queued or failed jobs can be cancelled" });
    }

    await db
      .update(transcodingJobsTable)
      .set({ status: "cancelled" })
      .where(eq(transcodingJobsTable.id, jobId));

    const job = rows[0];
    if (job) {
      await db.update(videosTable).set({ transcodingStatus: "none" }).where(eq(videosTable.id, job.videoId));
    }

    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/transcoding/requeue/:videoId", async (req, res) => {
  try {
    const { videoId } = req.params as { videoId: string };
    const videos = await db.select().from(videosTable).where(eq(videosTable.id, videoId));
    const video = videos[0];
    if (!video) return void res.status(404).json({ error: "Video not found" });
    if (video.videoSource !== "local" || !video.localVideoUrl) {
      return void res.status(400).json({ error: "Only locally uploaded videos can be transcoded" });
    }

    const urlPath = video.localVideoUrl.split("/api/uploads/")[1];
    if (!urlPath) return void res.status(400).json({ error: "Could not determine local file path" });

    const localFilePath = path.join(__dirname, "..", "uploads", urlPath);
    const { priority = 0 } = req.body as { priority?: number };
    const jobId = await queueTranscodingJob(videoId, localFilePath, priority);
    res.status(201).json({ jobId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/admin/live/health", (_req, res) => {
  res.json(getLiveMonitorData());
});

router.get("/admin/prayers", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "50"), 10) || 50));
    const unreadOnly = req.query["unread"] === "true";

    const where = unreadOnly
      ? eq(prayerRequestsTable.isRead, false)
      : undefined;

    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(prayerRequestsTable)
        .where(where)
        .orderBy(desc(prayerRequestsTable.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db
        .select({ total: count() })
        .from(prayerRequestsTable)
        .where(where),
    ]);

    const [{ unread }] = await db
      .select({ unread: count() })
      .from(prayerRequestsTable)
      .where(eq(prayerRequestsTable.isRead, false));

    res.json({ items: rows, total, page, limit, unread });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.patch("/admin/prayers/:id/read", async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const { isRead = true } = req.body as { isRead?: boolean };
    const [updated] = await db
      .update(prayerRequestsTable)
      .set({ isRead })
      .where(eq(prayerRequestsTable.id, id))
      .returning();
    if (!updated) return void res.status(404).json({ error: "Prayer request not found" });
    res.json(updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.delete("/admin/prayers/:id", async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const [deleted] = await db
      .delete(prayerRequestsTable)
      .where(eq(prayerRequestsTable.id, id))
      .returning();
    if (!deleted) return void res.status(404).json({ error: "Prayer request not found" });
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

// ===========================================================================
// Live Ingest — Broadcast Operations Center
// ===========================================================================
//
// Manages external broadcast inputs (vMix / OBS / Wirecast / Cloudflare Stream
// / Mux / AWS IVS). Each row stores: ingest URL + stream key (handed to the
// encoder), HLS playback URL (consumed by clients), and a fallback YouTube
// URL used when every primary endpoint is unhealthy.
//
// The health monitor (lib/liveIngestHealth.ts) probes each active endpoint on
// a 15-second cadence and auto-promotes the next healthy fallback when the
// primary fails N consecutive times. Promotion creates a live override
// pinned to the new endpoint's HLS URL, which the existing broadcast pipeline
// already understands. No client-side changes required.
// ===========================================================================

const ALLOWED_INGEST_PROTOCOLS = ["rtmp", "rtmps", "srt", "hls", "whip"] as const;
type IngestProtocol = (typeof ALLOWED_INGEST_PROTOCOLS)[number];

router.get("/admin/live-ingest/endpoints", async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(liveIngestEndpointsTable)
      .orderBy(desc(liveIngestEndpointsTable.isPrimary), asc(liveIngestEndpointsTable.priority));
    res.json({
      endpoints: rows,
      summary: {
        total: rows.length,
        active: rows.filter((r: (typeof rows)[number]) => r.isActive).length,
        primary: rows.find((r: (typeof rows)[number]) => r.isPrimary)?.id ?? null,
        healthy: rows.filter((r: (typeof rows)[number]) => r.healthStatus === "healthy").length,
        degraded: rows.filter((r: (typeof rows)[number]) => r.healthStatus === "degraded").length,
        unhealthy: rows.filter((r: (typeof rows)[number]) => r.healthStatus === "unhealthy").length,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/live-ingest/endpoints", async (req, res) => {
  try {
    const {
      name,
      protocol,
      ingestUrl,
      hlsPlaybackUrl,
      fallbackYoutubeUrl,
      priority,
      notes,
    } = req.body as {
      name?: string;
      protocol?: string;
      ingestUrl?: string;
      hlsPlaybackUrl?: string;
      fallbackYoutubeUrl?: string;
      priority?: number;
      notes?: string;
    };
    if (!name?.trim() || !protocol || !ingestUrl?.trim() || !hlsPlaybackUrl?.trim()) {
      return void res.status(400).json({
        error: "name, protocol, ingestUrl, and hlsPlaybackUrl are required",
      });
    }
    if (!ALLOWED_INGEST_PROTOCOLS.includes(protocol as IngestProtocol)) {
      return void res.status(400).json({
        error: `protocol must be one of: ${ALLOWED_INGEST_PROTOCOLS.join(", ")}`,
      });
    }
    const id = randomUUID();
    const streamKey = generateStreamKey();
    const row = {
      id,
      name: name.trim(),
      protocol,
      ingestUrl: ingestUrl.trim(),
      streamKey,
      hlsPlaybackUrl: hlsPlaybackUrl.trim(),
      fallbackYoutubeUrl: fallbackYoutubeUrl?.trim() || null,
      isPrimary: false,
      isActive: true,
      priority: typeof priority === "number" ? priority : 100,
      notes: notes?.trim() || null,
      healthStatus: "unknown" as const,
    };
    await db.insert(liveIngestEndpointsTable).values(row);
    res.json(row);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.patch("/admin/live-ingest/endpoints/:id", async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const allowed: Record<string, unknown> = {};
    for (const key of [
      "name",
      "protocol",
      "ingestUrl",
      "hlsPlaybackUrl",
      "fallbackYoutubeUrl",
      "priority",
      "notes",
      "isActive",
    ]) {
      if (body[key] !== undefined) allowed[key] = body[key];
    }
    if (allowed.protocol && !ALLOWED_INGEST_PROTOCOLS.includes(allowed.protocol as IngestProtocol)) {
      return void res.status(400).json({
        error: `protocol must be one of: ${ALLOWED_INGEST_PROTOCOLS.join(", ")}`,
      });
    }
    allowed.updatedAt = new Date();
    const [updated] = await db
      .update(liveIngestEndpointsTable)
      .set(allowed as Parameters<typeof db.update>[0] extends never ? never : Record<string, unknown>)
      .where(eq(liveIngestEndpointsTable.id, id))
      .returning();
    if (!updated) return void res.status(404).json({ error: "Endpoint not found" });
    res.json(updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.delete("/admin/live-ingest/endpoints/:id", async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const [deleted] = await db
      .delete(liveIngestEndpointsTable)
      .where(eq(liveIngestEndpointsTable.id, id))
      .returning();
    if (!deleted) return void res.status(404).json({ error: "Endpoint not found" });
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/live-ingest/endpoints/:id/rotate-key", async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const newKey = generateStreamKey();
    const [updated] = await db
      .update(liveIngestEndpointsTable)
      .set({ streamKey: newKey, updatedAt: new Date() })
      .where(eq(liveIngestEndpointsTable.id, id))
      .returning();
    if (!updated) return void res.status(404).json({ error: "Endpoint not found" });
    res.json({ id, streamKey: newKey });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/live-ingest/endpoints/:id/promote", async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    await promoteIngestEndpoint(id);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/live-ingest/stop", async (_req, res) => {
  try {
    await stopActiveIngestOverride();
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/live-ingest/endpoints/:id/probe", async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const rows = await db
      .select()
      .from(liveIngestEndpointsTable)
      .where(eq(liveIngestEndpointsTable.id, id))
      .limit(1);
    const endpoint = rows[0];
    if (!endpoint) return void res.status(404).json({ error: "Endpoint not found" });
    const probe = await probeHlsEndpoint(endpoint.hlsPlaybackUrl);
    const now = new Date();
    await db
      .update(liveIngestEndpointsTable)
      .set({
        healthStatus: probe.status,
        lastHealthAt: now,
        lastHealthyAt: probe.ok ? now : endpoint.lastHealthyAt,
        consecutiveFailures: probe.ok ? 0 : endpoint.consecutiveFailures + 1,
        lastBitrateKbps: probe.bitrateKbps,
        lastSegmentLatencyMs: probe.segmentLatencyMs,
        lastError: probe.error,
        updatedAt: now,
      })
      .where(eq(liveIngestEndpointsTable.id, id));
    res.json({ id, ...probe });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

// Stream-key validation endpoint for the operations center: lets an admin
// confirm an encoder is configured with the right key without leaking the
// key into a UI that auto-displays it. Used by the "Test encoder" flow.
router.post("/admin/live-ingest/validate-key", async (req, res) => {
  try {
    const { name, key } = req.body as { name?: string; key?: string };
    if (!name || !key) return void res.status(400).json({ error: "name and key are required" });
    const result = await validateStreamKey(name, key);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/live-ingest/sweep", async (_req, res) => {
  try {
    const results = await runIngestHealthSweep();
    res.json({ results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

export default router;
