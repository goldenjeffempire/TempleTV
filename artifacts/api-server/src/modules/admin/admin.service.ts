import { and, avg, count, desc, eq, gt, gte, ilike, or, sql, sum } from "drizzle-orm";
import type { z } from "zod";
import { db, schema } from "../../infrastructure/db.js";
import { cache } from "../../infrastructure/cache.js";
import { NotFoundError } from "../../shared/errors.js";
import type {
  ListUsersQuerySchema,
  UpdateUserRoleBodySchema,
} from "./admin.schemas.js";

const users = schema.usersTable;
const videos = schema.videosTable;
const playlists = schema.playlistsTable;
const sched = schema.scheduleTable;
const sent = schema.notificationsTable;
const broadcastQueue = schema.broadcastQueueTable;
const pushTokens = schema.pushTokensTable;

function toUserDto(row: typeof users.$inferSelect) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    role: row.role,
    emailVerified: row.emailVerified,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const adminService = {
  async listUsers(query: z.infer<typeof ListUsersQuerySchema>) {
    const conditions = [];
    if (query.role) conditions.push(eq(users.role, query.role));
    if (query.search) {
      conditions.push(
        or(
          ilike(users.email, `%${query.search}%`),
          ilike(users.displayName, `%${query.search}%`),
        )!,
      );
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(users)
        .where(where)
        .orderBy(desc(users.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      db.select({ c: count() }).from(users).where(where),
    ]);

    return {
      items: rows.map(toUserDto),
      total: Number(totalRows[0]?.c ?? 0),
      limit: query.limit,
      offset: query.offset,
    };
  },

  async updateUserRole(id: string, body: z.infer<typeof UpdateUserRoleBodySchema>) {
    const [row] = await db
      .update(users)
      .set({ role: body.role, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    if (!row) throw new NotFoundError("User not found");
    return toUserDto(row);
  },

  async getStats() {
    const STATS_CACHE_KEY = "admin:stats:v1";
    const STATS_TTL_SECONDS = 30;

    // Serve from cache on cache-hit — avoids 13 concurrent COUNT queries
    // on every admin dashboard load. SSE-driven invalidation keeps the
    // displayed data fresh within 30 seconds without hammering the DB.
    const cached = await cache().get<ReturnType<typeof buildStats>>(STATS_CACHE_KEY);
    if (cached) return cached;

    const result = await buildStats();
    await cache().set(STATS_CACHE_KEY, result, STATS_TTL_SECONDS);
    return result;

    async function buildStats() {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [
        videosTotal,
        videosFeatured,
        videosBySource,
        usersTotal,
        usersByRole,
        playlistsTotal,
        schedTotal,
        schedActive,
        sentLast24h,
        sentTotal,
        queueTotal,
        queueActive,
        devicesTotal,
      ] = await Promise.all([
        db.select({ c: count() }).from(videos),
        db.select({ c: count() }).from(videos).where(eq(videos.featured, true)),
        db
          .select({ source: videos.videoSource, c: count() })
          .from(videos)
          .groupBy(videos.videoSource),
        db.select({ c: count() }).from(users),
        db.select({ role: users.role, c: count() }).from(users).groupBy(users.role),
        db.select({ c: count() }).from(playlists),
        db.select({ c: count() }).from(sched),
        db.select({ c: count() }).from(sched).where(eq(sched.isActive, true)),
        db.select({ c: count() }).from(sent).where(gt(sent.sentAt, dayAgo)),
        db.select({ c: count() }).from(sent),
        db.select({ c: count() }).from(broadcastQueue),
        db
          .select({ c: count() })
          .from(broadcastQueue)
          .where(eq(broadcastQueue.isActive, true)),
        db.select({ c: count() }).from(pushTokens),
      ]);

      const bySource: Record<string, number> = {};
      for (const r of videosBySource) bySource[r.source ?? "unknown"] = Number(r.c ?? 0);
      const byRole: Record<string, number> = {};
      for (const r of usersByRole) byRole[r.role ?? "user"] = Number(r.c ?? 0);

      return {
        videos: {
          total: Number(videosTotal[0]?.c ?? 0),
          featured: Number(videosFeatured[0]?.c ?? 0),
          bySource,
        },
        users: { total: Number(usersTotal[0]?.c ?? 0), byRole },
        playlists: { total: Number(playlistsTotal[0]?.c ?? 0) },
        schedule: {
          total: Number(schedTotal[0]?.c ?? 0),
          active: Number(schedActive[0]?.c ?? 0),
        },
        notifications: {
          sentLast24h: Number(sentLast24h[0]?.c ?? 0),
          sentTotal: Number(sentTotal[0]?.c ?? 0),
        },
        broadcast: {
          queueDepth: Number(queueTotal[0]?.c ?? 0),
          activeQueueDepth: Number(queueActive[0]?.c ?? 0),
        },
        devices: {
          total: Number(devicesTotal[0]?.c ?? 0),
        },
        generatedAt: new Date().toISOString(),
      };
    }
  },

  async getAnalytics() {
    const CACHE_KEY = "admin:analytics:v1";
    const cached = await cache().get<Awaited<ReturnType<typeof buildAnalytics>>>(CACHE_KEY);
    if (cached) return cached;
    const result = await buildAnalytics();
    await cache().set(CACHE_KEY, result, 60); // 60-second TTL — view counts update infrequently
    return result;

    async function buildAnalytics() {
      const [topVideos, totals] = await Promise.all([
        db
          .select({
            id: videos.id,
            title: videos.title,
            viewCount: videos.viewCount,
            thumbnailUrl: videos.thumbnailUrl,
          })
          .from(videos)
          .orderBy(desc(videos.viewCount))
          .limit(10),
        db.select({ s: sum(videos.viewCount) }).from(videos),
      ]);
      return {
        topVideos: topVideos.map((v) => ({
          id: v.id,
          title: v.title,
          viewCount: Number(v.viewCount ?? 0),
          thumbnailUrl: v.thumbnailUrl ?? "",
        })),
        totalViews: Number(totals[0]?.s ?? 0),
        generatedAt: new Date().toISOString(),
      };
    }
  },

  async getAnalyticsOverview(range: "7d" | "30d" | "90d" = "30d") {
    const CACHE_KEY = `admin:analytics:overview:${range}:v1`;
    const cached = await cache().get<Awaited<ReturnType<typeof buildOverview>>>(CACHE_KEY);
    if (cached) return cached;
    const result = await buildOverview(range);
    await cache().set(CACHE_KEY, result, 60); // 60-second TTL
    return result;

    async function buildOverview(range: "7d" | "30d" | "90d") {
    const sessions = schema.viewerSessionsTable;
    const rangeDays = range === "7d" ? 7 : range === "30d" ? 30 : 90;
    const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000);

    const [topVideos, totals, sessionMetrics, platformRows, dailyRows] =
      await Promise.all([
        db
          .select({
            id: videos.id,
            title: videos.title,
            viewCount: videos.viewCount,
            thumbnailUrl: videos.thumbnailUrl,
          })
          .from(videos)
          .orderBy(desc(videos.viewCount))
          .limit(10),

        db.select({ s: sum(videos.viewCount) }).from(videos),

        db
          .select({
            total: count(),
            completed: sql<number>`count(*) filter (where ${sessions.completed} = true)`,
            avgSecs: avg(sessions.watchedSecs),
          })
          .from(sessions)
          .where(gte(sessions.startedAt, since)),

        db
          .select({ platform: sessions.platform, sessions: count() })
          .from(sessions)
          .where(gte(sessions.startedAt, since))
          .groupBy(sessions.platform),

        db
          .select({
            date: sql<string>`date_trunc('day', ${sessions.startedAt})::date::text`,
            views: count(),
          })
          .from(sessions)
          .where(gte(sessions.startedAt, since))
          .groupBy(sql`date_trunc('day', ${sessions.startedAt})`)
          .orderBy(sql`date_trunc('day', ${sessions.startedAt})`),
      ]);

    const totalSessions = Number(sessionMetrics[0]?.total ?? 0);
    const completedSessions = Number(sessionMetrics[0]?.completed ?? 0);
    const completionRate =
      totalSessions > 0 ? completedSessions / totalSessions : 0;
    const avgWatchSecs = Number(sessionMetrics[0]?.avgSecs ?? 0);

    return {
      totalViews: Number(totals[0]?.s ?? 0),
      totalSessions,
      completionRate: Math.round(completionRate * 1000) / 1000,
      avgWatchSecs: Math.round(avgWatchSecs),
      platformBreakdown: platformRows.map((r) => ({
        platform: r.platform,
        sessions: Number(r.sessions),
      })),
      dailyViews: dailyRows.map((r) => ({
        date: r.date,
        views: Number(r.views),
      })),
      topVideos: topVideos.map((v) => ({
        id: v.id,
        title: v.title,
        viewCount: Number(v.viewCount ?? 0),
        thumbnailUrl: v.thumbnailUrl ?? "",
      })),
      generatedAt: new Date().toISOString(),
    };
    } // end buildOverview
  },

  async deleteUser(id: string) {
    const [row] = await db
      .delete(users)
      .where(eq(users.id, id))
      .returning({ id: users.id });
    if (!row) throw new NotFoundError("User not found");
    return { deleted: true as const, id: row.id };
  },
};
