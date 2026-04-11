import { Router } from "express";
import { db, videosTable, playlistsTable, playlistVideosTable, scheduleTable, notificationsTable, pushTokensTable, liveOverridesTable, transcodingJobsTable } from "@workspace/db";
import { eq, ilike, or, count, sql, desc, asc, and } from "drizzle-orm";
import { queueTranscodingJob, retryTranscodingJob } from "../lib/transcoder";
import { broadcastLiveEvent, addSSEClient, removeSSEClient, getSSEClientCount } from "../lib/liveEvents";
import { getLiveStatus } from "./youtube";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { createWriteStream, existsSync } from "fs";
import multer from "multer";
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
  limits: { fileSize: 50 * 1024 * 1024 },
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
  };
  thumbnailPath?: string;
  createdAt: Date;
  lastActivity: Date;
}

const uploadSessions = new Map<string, ChunkedSession>();

const SESSION_META_FILE = "session.json";

async function writeSessionToDisk(session: ChunkedSession): Promise<void> {
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
  } catch {}
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
          metadata: meta.metadata,
          thumbnailPath: meta.thumbnailPath,
          createdAt: new Date(meta.createdAt),
          lastActivity,
        };
        uploadSessions.set(session.id, session);
        console.log(`[Upload] Recovered session ${session.id} (${session.uploadedChunks.size}/${session.totalChunks} chunks)`);
      } catch {}
    }
  } catch (err) {
    console.error("[Upload] Session recovery failed:", err);
  }
}

recoverSessionsFromDisk();

setInterval(() => {
  const inactiveCutoff = new Date(Date.now() - 6 * 60 * 60 * 1000);
  for (const [id, session] of uploadSessions.entries()) {
    if (session.lastActivity < inactiveCutoff) {
      fs.rm(session.tmpDir, { recursive: true, force: true }).catch(() => {});
      uploadSessions.delete(id);
    }
  }
}, 30 * 60 * 1000);

async function autoExpireLiveOverrides(): Promise<void> {
  try {
    const now = new Date();
    const active = await db
      .select()
      .from(liveOverridesTable)
      .where(eq(liveOverridesTable.isActive, true));
    for (const override of active) {
      if (override.endsAt && override.endsAt <= now) {
        await db.update(liveOverridesTable)
          .set({ isActive: false })
          .where(eq(liveOverridesTable.id, override.id));
        console.log(`[LiveOverride] Auto-expired: "${override.title}"`);
        broadcastLiveEvent("override-expired", {
          id: override.id,
          title: override.title,
          expiredAt: now.toISOString(),
        });
        broadcastLiveEvent("status", await buildLiveStatusPayload());
      }
    }
  } catch {}
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

setInterval(autoExpireLiveOverrides, 30 * 1000);
autoExpireLiveOverrides();

const router = Router();

const EXPO_PUSH_API = "https://exp.host/--/api/v2/push/send";

async function getActiveLiveOverride() {
  const overrides = await db
    .select()
    .from(liveOverridesTable)
    .where(eq(liveOverridesTable.isActive, true))
    .orderBy(desc(liveOverridesTable.startedAt));
  const now = new Date();
  return overrides.find((override) => !override.endsAt || override.endsAt > now) ?? null;
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

router.get("/admin/stats", async (req, res) => {
  try {
    const [totalVideosResult] = await db.select({ count: count() }).from(videosTable);
    const [totalPlaylistsResult] = await db.select({ count: count() }).from(playlistsTable);
    const [activeScheduleResult] = await db
      .select({ count: count() })
      .from(scheduleTable)
      .where(eq(scheduleTable.isActive, true));
    const [recentImportsResult] = await db
      .select({ count: count() })
      .from(videosTable)
      .where(sql`imported_at > now() - interval '7 days'`);
    const [todayNotifResult] = await db
      .select({ count: count() })
      .from(notificationsTable)
      .where(sql`sent_at > now() - interval '1 day'`);
    const [registeredDevicesResult] = await db.select({ count: count() }).from(pushTokensTable);

    const categoryCounts = await db
      .select({ category: videosTable.category, count: count() })
      .from(videosTable)
      .groupBy(videosTable.category)
      .orderBy(desc(count()))
      .limit(1);

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

    res.json({
      totalVideos: totalVideosResult?.count ?? 0,
      totalPlaylists: totalPlaylistsResult?.count ?? 0,
      activeScheduleEntries: activeScheduleResult?.count ?? 0,
      notificationsSentToday: todayNotifResult?.count ?? 0,
      isLiveNow: liveStatus.isLive,
      liveViewerEstimate: liveStatus.viewerCount,
      recentImports: recentImportsResult?.count ?? 0,
      topCategory: categoryCounts[0]?.category ?? "sermon",
      registeredDevices: registeredDevicesResult?.count ?? 0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/admin/videos", async (req, res) => {
  try {
    const parsed = ListAdminVideosQueryParams.safeParse(req.query);
    const params = parsed.success ? parsed.data : {};
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const offset = (page - 1) * limit;

    let rows: typeof videosTable.$inferSelect[];
    if (params.search) {
      rows = await db
        .select()
        .from(videosTable)
        .where(or(ilike(videosTable.title, `%${params.search}%`), ilike(videosTable.preacher, `%${params.search}%`)))
        .orderBy(desc(videosTable.importedAt))
        .limit(limit)
        .offset(offset);
    } else if (params.category) {
      rows = await db
        .select()
        .from(videosTable)
        .where(eq(videosTable.category, params.category))
        .orderBy(desc(videosTable.importedAt))
        .limit(limit)
        .offset(offset);
    } else {
      rows = await db
        .select()
        .from(videosTable)
        .orderBy(desc(videosTable.importedAt))
        .limit(limit)
        .offset(offset);
    }

    const [totalResult] = await db.select({ count: count() }).from(videosTable);
    const total = totalResult?.count ?? 0;

    res.json({
      videos: rows,
      total,
      page,
      totalPages: Math.ceil(total / limit),
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
      return res.status(400).json({ error: "Video file is required" });
    }

    const { title, category, preacher, featured, durationSecs: durationSecsStr } = req.body as {
      title?: string;
      category?: string;
      preacher?: string;
      featured?: string;
      durationSecs?: string;
    };

    if (!title?.trim()) {
      return res.status(400).json({ error: "Title is required" });
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
      })
      .returning();

    res.status(201).json(video);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/videos/upload/init", async (req, res) => {
  try {
    const { title, category, preacher, featured, durationSecs, totalChunks, totalBytes, ext } = req.body as {
      title?: string;
      category?: string;
      preacher?: string;
      featured?: string;
      durationSecs?: string;
      totalChunks?: string;
      totalBytes?: string;
      ext?: string;
    };

    if (!title?.trim()) return res.status(400).json({ error: "Title is required" });
    if (!totalChunks || !totalBytes) return res.status(400).json({ error: "totalChunks and totalBytes are required" });

    const sessionId = randomUUID();
    const tmpDir = path.join(__dirname, "..", "uploads", "tmp", sessionId);
    await fs.mkdir(tmpDir, { recursive: true });

    const now = new Date();
    const session: ChunkedSession = {
      id: sessionId,
      ext: ext ?? ".mp4",
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
      },
      createdAt: now,
      lastActivity: now,
    };

    uploadSessions.set(sessionId, session);
    await writeSessionToDisk(session);
    res.json({ sessionId, totalChunks: session.totalChunks });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/videos/upload/:sessionId/chunk", chunkUpload.single("chunk"), async (req, res) => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const { chunkIndex } = req.body as { chunkIndex?: string };

    const session = uploadSessions.get(sessionId);
    if (!session) return res.status(404).json({ error: "Upload session not found or expired" });

    const chunk = req.file;
    if (!chunk) return res.status(400).json({ error: "No chunk data provided" });

    const idx = parseInt(chunkIndex ?? "0", 10);
    if (isNaN(idx) || idx < 0 || idx >= session.totalChunks) {
      return res.status(400).json({ error: `Invalid chunk index: ${idx}` });
    }

    const chunkPath = path.join(session.tmpDir, `chunk-${String(idx).padStart(6, "0")}`);
    await fs.writeFile(chunkPath, chunk.buffer);

    session.uploadedChunks.add(idx);
    session.receivedBytes += chunk.buffer.length;
    session.lastActivity = new Date();

    writeSessionToDisk(session).catch(() => {});

    res.json({
      sessionId,
      chunkIndex: idx,
      uploadedChunks: session.uploadedChunks.size,
      totalChunks: session.totalChunks,
      progressPercent: Math.round((session.uploadedChunks.size / session.totalChunks) * 100),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/admin/videos/upload/:sessionId/status", (req, res) => {
  const { sessionId } = req.params as { sessionId: string };
  const session = uploadSessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

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
    if (!session) return res.status(404).json({ error: "Session not found or expired" });

    if (req.file) {
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
    if (!session) return res.status(404).json({ error: "Session not found or expired" });

    const missingChunks: number[] = [];
    for (let i = 0; i < session.totalChunks; i++) {
      if (!session.uploadedChunks.has(i)) missingChunks.push(i);
    }

    if (missingChunks.length > 0) {
      return res.status(400).json({ error: `Missing chunks: ${missingChunks.join(", ")}`, missingChunks });
    }

    const finalFilename = `${randomUUID()}${session.ext}`;
    const finalPath = path.join(__dirname, "..", "uploads", finalFilename);
    const writeStream = createWriteStream(finalPath);

    await new Promise<void>((resolve, reject) => {
      writeStream.on("error", reject);
      writeStream.on("finish", resolve);

      const writeChunks = async () => {
        try {
          for (let i = 0; i < session.totalChunks; i++) {
            const chunkPath = path.join(session.tmpDir, `chunk-${String(i).padStart(6, "0")}`);
            const data = await fs.readFile(chunkPath);
            await new Promise<void>((r, e) => {
              writeStream.write(data, (err) => { if (err) e(err); else r(); });
            });
          }
          writeStream.end();
        } catch (err) {
          reject(err);
        }
      };

      writeChunks();
    });

    await fs.rm(session.tmpDir, { recursive: true, force: true });

    const devDomain = process.env.REPLIT_DEV_DOMAIN;
    const baseUrl = process.env.API_BASE_URL ?? (devDomain ? `https://${devDomain}` : "");
    const localVideoUrl = `${baseUrl}/api/uploads/${finalFilename}`;
    const thumbnailUrl = session.thumbnailPath ? `${baseUrl}/api/uploads/${session.thumbnailPath}` : "";

    const id = randomUUID();
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
      })
      .returning();

    uploadSessions.delete(sessionId);

    queueTranscodingJob(id, finalPath, 1).catch(() => {});

    res.status(201).json(video);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.delete("/admin/videos/upload/:sessionId", async (req, res) => {
  const { sessionId } = req.params as { sessionId: string };
  const session = uploadSessions.get(sessionId);
  if (session) {
    await fs.rm(session.tmpDir, { recursive: true, force: true }).catch(() => {});
    uploadSessions.delete(sessionId);
  }
  res.json({ ok: true });
});

router.post("/admin/videos/import", async (req, res) => {
  try {
    const parsed = ImportVideoBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body" });
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
      return res.status(400).json({ error: "Invalid body" });
    }
    const updates = Object.fromEntries(Object.entries(body.data).filter(([, v]) => v !== undefined));
    const [video] = await db.update(videosTable).set(updates).where(eq(videosTable.id, id)).returning();
    if (!video) return res.status(404).json({ error: "Video not found" });
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

router.get("/videos/featured", async (req, res) => {
  try {
    const videos = await db
      .select()
      .from(videosTable)
      .where(eq(videosTable.featured, true))
      .orderBy(desc(videosTable.importedAt))
      .limit(10);
    res.json(videos.map((v) => ({
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
    })));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/playlists", async (req, res) => {
  try {
    const playlists = await db
      .select()
      .from(playlistsTable)
      .where(eq(playlistsTable.isActive, true))
      .orderBy(desc(playlistsTable.createdAt));
    const withCounts = await Promise.all(
      playlists.map(async (p) => {
        const [countResult] = await db
          .select({ count: count() })
          .from(playlistVideosTable)
          .where(eq(playlistVideosTable.playlistId, p.id));
        return { ...p, videoCount: countResult?.count ?? 0 };
      })
    );
    res.json(withCounts);
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
    if (!playlist) return res.status(404).json({ error: "Playlist not found" });
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
    const playlists = await db.select().from(playlistsTable).orderBy(desc(playlistsTable.createdAt));
    const withCounts = await Promise.all(
      playlists.map(async (p) => {
        const [countResult] = await db
          .select({ count: count() })
          .from(playlistVideosTable)
          .where(eq(playlistVideosTable.playlistId, p.id));
        return { ...p, videoCount: countResult?.count ?? 0 };
      })
    );
    res.json(withCounts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/playlists", async (req, res) => {
  try {
    const parsed = CreatePlaylistBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });
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
    if (!result) return res.status(404).json({ error: "Playlist not found" });
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
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });
    const updates = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    const [playlist] = await db.update(playlistsTable).set(updates).where(eq(playlistsTable.id, id)).returning();
    if (!playlist) return res.status(404).json({ error: "Playlist not found" });
    const [countResult] = await db
      .select({ count: count() })
      .from(playlistVideosTable)
      .where(eq(playlistVideosTable.playlistId, id));
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
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });
    const { videoId } = parsed.data;

    const [video] = await db.select().from(videosTable).where(eq(videosTable.id, videoId));
    if (!video) return res.status(404).json({ error: "Video not found" });

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
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });
    const { videoIds } = parsed.data;

    for (let i = 0; i < videoIds.length; i++) {
      await db
        .update(playlistVideosTable)
        .set({ sortOrder: i })
        .where(sql`playlist_id = ${id} AND (video_id = ${videoIds[i]} OR id = ${videoIds[i]})`);
    }

    const result = await getPlaylistWithVideos(id);
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
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });
    const [entry] = await db
      .insert(scheduleTable)
      .values({
        id: randomUUID(),
        ...parsed.data,
        isRecurring: parsed.data.isRecurring ?? true,
        isActive: parsed.data.isActive ?? true,
      })
      .returning();
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
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });
    const updates = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    const [entry] = await db.update(scheduleTable).set(updates).where(eq(scheduleTable.id, id)).returning();
    if (!entry) return res.status(404).json({ error: "Schedule entry not found" });
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
      return res.status(400).json({ error: "token is required" });
    }
    if (platform !== "ios" && platform !== "android") {
      return res.status(400).json({ error: "platform must be ios or android" });
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

router.post("/admin/notifications/send", async (req, res) => {
  try {
    const parsed = SendPushNotificationBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });
    const { title, body, type, videoId } = parsed.data;

    const tokenRows = await db.select({ token: pushTokensTable.token }).from(pushTokensTable);
    const tokens = tokenRows.map((r) => r.token);

    const { sent, failed } = await sendExpoPushNotifications(tokens, title, body, {
      type,
      ...(videoId ? { videoId } : {}),
    });

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
      total: tokens.length,
      message:
        tokens.length === 0
          ? "No registered devices found. Devices register automatically when they open the app."
          : `Notification sent to ${sent}/${tokens.length} devices.`,
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

router.get("/admin/analytics", async (req, res) => {
  try {
    const parsed = GetAnalyticsQueryParams.safeParse(req.query);
    const period = parsed.success ? (parsed.data.period ?? "30d") : "30d";
    const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;

    const [totalViewsResult] = await db
      .select({ total: sql<number>`coalesce(sum(view_count), 0)` })
      .from(videosTable);

    const topVideosRows = await db
      .select({
        youtubeId: videosTable.youtubeId,
        title: videosTable.title,
        views: videosTable.viewCount,
        thumbnailUrl: videosTable.thumbnailUrl,
      })
      .from(videosTable)
      .orderBy(desc(videosTable.viewCount))
      .limit(5);

    const categoryRows = await db
      .select({ category: videosTable.category, count: count() })
      .from(videosTable)
      .groupBy(videosTable.category);

    const totalCatCount = categoryRows.reduce((s, r) => s + r.count, 0);

    const [notifResult] = await db.select({ count: count() }).from(notificationsTable);
    const [deviceResult] = await db.select({ count: count() }).from(pushTokensTable);

    const notifHistory = await db
      .select({ sentAt: notificationsTable.sentAt, sentCount: notificationsTable.sentCount })
      .from(notificationsTable)
      .orderBy(desc(notificationsTable.sentAt))
      .limit(days);

    const dailyViewsMap = new Map<string, number>();
    for (const n of notifHistory) {
      const d = new Date(n.sentAt).toISOString().split("T")[0];
      dailyViewsMap.set(d, (dailyViewsMap.get(d) ?? 0) + (n.sentCount ?? 0));
    }

    const dailyViews = Array.from({ length: days }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (days - 1 - i));
      const dateStr = d.toISOString().split("T")[0];
      return { date: dateStr, views: dailyViewsMap.get(dateStr) ?? 0 };
    });

    res.json({
      period,
      totalViews: Number(totalViewsResult?.total ?? 0),
      uniqueViewers: Number(deviceResult?.count ?? 0),
      avgWatchTimeMinutes: 24.5,
      liveStreamEvents: notifResult?.count ?? 0,
      topVideos: topVideosRows,
      categoryBreakdown: categoryRows.map((r) => ({
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
  res.flushHeaders();

  const client = addSSEClient(res);

  try {
    const payload = await buildLiveStatusPayload();
    res.write(`event: status\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch {}

  req.on("close", () => removeSSEClient(client));
});

router.get("/admin/live", async (_req, res) => {
  try {
    let ytLive = false;
    let ytVideoId: string | null = null;
    let ytTitle: string | null = null;

    const [liveOverride, deviceCountResult] = await Promise.all([
      getActiveLiveOverride(),
      db.select({ count: count() }).from(pushTokensTable),
    ]);
    const deviceCount = Number(deviceCountResult[0]?.count ?? 0);

    try {
      const oembedRes = await fetch(
        "https://www.youtube.com/oembed?url=https://www.youtube.com/@templetvjctm/live&format=json",
        { signal: AbortSignal.timeout(4000) }
      );
      if (oembedRes.ok) {
        const data = (await oembedRes.json()) as { title?: string; thumbnail_url?: string };
        const vidMatch = (data.thumbnail_url ?? "").match(/\/vi\/([^/]+)\//);
        ytLive = !!(vidMatch?.[1] && data.title);
        if (ytLive) {
          ytVideoId = vidMatch![1];
          ytTitle = data.title ?? null;
        }
      }
    } catch {}

    const isLive = !!(liveOverride || ytLive);
    const elapsedSecs = liveOverride
      ? Math.floor((Date.now() - liveOverride.startedAt.getTime()) / 1000)
      : null;
    const remainingSecs = liveOverride?.endsAt
      ? Math.max(0, Math.floor((liveOverride.endsAt.getTime() - Date.now()) / 1000))
      : null;

    res.json({
      isLive,
      deviceCount,
      ytLive,
      ytVideoId,
      ytTitle,
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

router.post("/admin/live/override/start", async (req, res) => {
  try {
    const { title, durationMinutes = 120, notify = true } = req.body as {
      title?: string;
      durationMinutes?: number;
      notify?: boolean;
    };
    const safeDuration = Number.isFinite(durationMinutes) ? Math.max(5, Math.min(480, durationMinutes)) : 120;
    const startedAt = new Date();
    const endsAt = new Date(startedAt.getTime() + safeDuration * 60 * 1000);

    await db.update(liveOverridesTable).set({ isActive: false }).where(eq(liveOverridesTable.isActive, true));

    const [override] = await db
      .insert(liveOverridesTable)
      .values({
        id: randomUUID(),
        title: title?.trim() || "Temple TV Live Service",
        startedAt,
        endsAt,
        isActive: true,
      })
      .returning();

    let pushResult = { sent: 0, failed: 0 };
    if (notify) {
      const tokenRows = await db.select().from(pushTokensTable);
      pushResult = await sendExpoPushNotifications(
        tokenRows.map((row) => row.token),
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
        failedCount: pushResult.failed,
      });
    }

    buildLiveStatusPayload().then((payload) => broadcastLiveEvent("status", payload)).catch(() => {});

    res.status(201).json({ override, push: pushResult });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/live/override/stop", async (_req, res) => {
  try {
    const active = await getActiveLiveOverride();
    if (!active) return res.json({ ok: true, stopped: 0 });
    await db
      .update(liveOverridesTable)
      .set({ isActive: false, endsAt: new Date() })
      .where(eq(liveOverridesTable.id, active.id));

    buildLiveStatusPayload().then((payload) => broadcastLiveEvent("status", payload)).catch(() => {});

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
    if (!active) return res.status(404).json({ error: "No active live override" });
    const base = active.endsAt && active.endsAt > new Date() ? active.endsAt : new Date();
    const newEndsAt = new Date(base.getTime() + safe * 60 * 1000);
    const [updated] = await db
      .update(liveOverridesTable)
      .set({ endsAt: newEndsAt })
      .where(eq(liveOverridesTable.id, active.id))
      .returning();

    buildLiveStatusPayload().then((payload) => broadcastLiveEvent("status", payload)).catch(() => {});

    res.json({ ok: true, override: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
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

    const activeCount = jobs.filter((j) => j.job.status === "processing").length;
    const queuedCount = jobs.filter((j) => j.job.status === "queued").length;
    const failedCount = jobs.filter((j) => j.job.status === "failed").length;
    const doneCount = jobs.filter((j) => j.job.status === "done").length;

    res.json({
      jobs: jobs.map((r) => ({
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
    if (!row) return res.status(404).json({ error: "Job not found" });

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

router.delete("/admin/transcoding/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params as { jobId: string };
    const rows = await db
      .select()
      .from(transcodingJobsTable)
      .where(and(eq(transcodingJobsTable.id, jobId), eq(transcodingJobsTable.status, "queued")));

    if (rows.length === 0) {
      return res.status(400).json({ error: "Only queued jobs can be cancelled" });
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
    if (!video) return res.status(404).json({ error: "Video not found" });
    if (video.videoSource !== "local" || !video.localVideoUrl) {
      return res.status(400).json({ error: "Only locally uploaded videos can be transcoded" });
    }

    const urlPath = video.localVideoUrl.split("/api/uploads/")[1];
    if (!urlPath) return res.status(400).json({ error: "Could not determine local file path" });

    const localFilePath = path.join(__dirname, "..", "uploads", urlPath);
    const { priority = 0 } = req.body as { priority?: number };
    const jobId = await queueTranscodingJob(videoId, localFilePath, priority);
    res.status(201).json({ jobId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

export default router;
