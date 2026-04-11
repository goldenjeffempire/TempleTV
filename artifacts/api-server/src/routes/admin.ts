import { Router } from "express";
import { db, videosTable, playlistsTable, playlistVideosTable, scheduleTable, notificationsTable, pushTokensTable, liveOverridesTable } from "@workspace/db";
import { eq, ilike, or, count, sql, desc } from "drizzle-orm";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
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

    const { title, category, preacher, featured } = req.body as {
      title?: string;
      category?: string;
      preacher?: string;
      featured?: string;
    };

    if (!title?.trim()) {
      return res.status(400).json({ error: "Title is required" });
    }

    const devDomain = process.env.REPLIT_DEV_DOMAIN;
    const baseUrl = process.env.API_BASE_URL ?? (devDomain ? `https://${devDomain}` : "");
    const localVideoUrl = `${baseUrl}/uploads/${videoFile.filename}`;
    const thumbnailUrl = thumbnailFile
      ? `${baseUrl}/uploads/${thumbnailFile.filename}`
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
        duration: "",
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
    await db.delete(videosTable).where(eq(videosTable.id, id));
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

router.get("/admin/live", async (req, res) => {
  try {
    let isLive = false;
    let videoId: string | null = null;
    let title: string | null = null;
    let startedAt: string | null = null;
    let viewerCount = 0;

    const liveOverride = await getActiveLiveOverride();

    try {
      const oembedRes = await fetch(
        "https://www.youtube.com/oembed?url=https://www.youtube.com/@templetvjctm/live&format=json",
        { signal: AbortSignal.timeout(5000) }
      );
      if (oembedRes.ok) {
        const data = (await oembedRes.json()) as { title?: string; thumbnail_url?: string };
        const vidMatch = (data.thumbnail_url ?? "").match(/\/vi\/([^/]+)\//);
        isLive = !!(vidMatch?.[1] && data.title);
        if (isLive) {
          videoId = vidMatch![1];
          title = data.title ?? null;
        }
      }
    } catch {}

    if (liveOverride) {
      isLive = true;
      title = liveOverride.title;
      startedAt = liveOverride.startedAt.toISOString();
    }

    res.json({
      isLive,
      videoId,
      title,
      startedAt,
      viewerCount,
      liveOverride: liveOverride ? {
        id: liveOverride.id,
        title: liveOverride.title,
        startedAt: liveOverride.startedAt.toISOString(),
        endsAt: liveOverride.endsAt?.toISOString() ?? null,
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
      const tokenRows = await db.select().from(pushTokensTable).where(eq(pushTokensTable.isActive, true));
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
    res.json({ ok: true, stopped: 1 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

export default router;
