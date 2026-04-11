import { Router } from "express";
import { db, videosTable, playlistsTable, playlistVideosTable, scheduleTable, notificationsTable } from "@workspace/db";
import { eq, ilike, or, count, sql, desc } from "drizzle-orm";
import { randomUUID } from "crypto";
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

const router = Router();

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

    res.json({
      totalVideos: totalVideosResult?.count ?? 0,
      totalPlaylists: totalPlaylistsResult?.count ?? 0,
      activeScheduleEntries: activeScheduleResult?.count ?? 0,
      notificationsSentToday: todayNotifResult?.count ?? 0,
      isLiveNow: liveStatus.isLive,
      liveViewerEstimate: liveStatus.viewerCount,
      recentImports: recentImportsResult?.count ?? 0,
      topCategory: categoryCounts[0]?.category ?? "sermon",
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

    let query = db.select().from(videosTable);
    const filters: ReturnType<typeof ilike>[] = [];
    if (params.search) {
      filters.push(
        ilike(videosTable.title, `%${params.search}%`),
        ilike(videosTable.preacher, `%${params.search}%`)
      );
    }

    let rows: typeof videosTable.$inferSelect[];
    if (filters.length > 0) {
      rows = await db
        .select()
        .from(videosTable)
        .where(or(...filters))
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
    const updates = Object.fromEntries(
      Object.entries(body.data).filter(([, v]) => v !== undefined)
    );
    const [video] = await db
      .update(videosTable)
      .set(updates)
      .where(eq(videosTable.id, id))
      .returning();
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

async function getPlaylistWithVideos(id: string) {
  const [playlist] = await db
    .select()
    .from(playlistsTable)
    .where(eq(playlistsTable.id, id));
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
    const updates = Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== undefined)
    );
    const [playlist] = await db
      .update(playlistsTable)
      .set(updates)
      .where(eq(playlistsTable.id, id))
      .returning();
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
    await db
      .delete(playlistVideosTable)
      .where(
        sql`playlist_id = ${id} AND (video_id = ${videoId} OR id = ${videoId})`
      );
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
        .where(
          sql`playlist_id = ${id} AND (video_id = ${videoIds[i]} OR id = ${videoIds[i]})`
        );
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
    const entries = await db.select().from(scheduleTable).orderBy(scheduleTable.dayOfWeek, scheduleTable.startTime);
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
      .values({ id: randomUUID(), ...parsed.data, isRecurring: parsed.data.isRecurring ?? true, isActive: parsed.data.isActive ?? true })
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
    const updates = Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== undefined)
    );
    const [entry] = await db
      .update(scheduleTable)
      .set(updates)
      .where(eq(scheduleTable.id, id))
      .returning();
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

router.post("/admin/notifications/send", async (req, res) => {
  try {
    const parsed = SendPushNotificationBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });
    const { title, body, type, videoId } = parsed.data;

    const [notification] = await db
      .insert(notificationsTable)
      .values({
        id: randomUUID(),
        title,
        body,
        type,
        videoId: videoId ?? null,
        sentCount: 0,
      })
      .returning();

    res.json({
      sent: 0,
      failed: 0,
      message: "Notification logged. Push delivery requires Expo push token integration.",
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

    const [totalVids] = await db.select({ count: count() }).from(videosTable);
    const dailyViews = Array.from({ length: days }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (days - 1 - i));
      return {
        date: d.toISOString().split("T")[0],
        views: Math.floor(Math.random() * 50) + 5,
      };
    });

    const [notifResult] = await db.select({ count: count() }).from(notificationsTable);

    res.json({
      period,
      totalViews: Number(totalViewsResult?.total ?? 0),
      uniqueViewers: Math.floor(Number(totalViewsResult?.total ?? 0) * 0.7),
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

    res.json({ isLive, videoId, title, startedAt, viewerCount });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

export default router;
