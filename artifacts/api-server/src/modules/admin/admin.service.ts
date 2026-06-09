import { and, avg, count, desc, eq, gt, gte, ilike, or, sql, sum } from "drizzle-orm";
import type { z } from "zod";
import { db, schema } from "../../infrastructure/db.js";
import { cache } from "../../infrastructure/cache.js";
import { NotFoundError } from "../../shared/errors.js";
import { invalidateSessionsValidAfterCache } from "../../middleware/auth.js";
import type {
  ListUsersQuerySchema,
  UpdateUserRoleBodySchema,
} from "./admin.schemas.js";

type ConcurrentBucket = { ts: string; concurrent: number; tv: number; mobile: number; web: number };
type ConcurrentResult = { buckets: ConcurrentBucket[]; peak: { concurrent: number; ts: string }; granularity: "hour" | "4h" | "day"; generatedAt: string };
type DailyPlatformDay = { date: string; tv: number; mobile: number; web: number; total: number };
type DailyPlatformResult = { days: DailyPlatformDay[]; generatedAt: string };

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
    const now = new Date();
    const [row] = await db
      .update(users)
      // Bump sessionsValidAfter so any JWT issued under the old role is
      // rejected at the next requireAuth check, forcing re-login.
      .set({ role: body.role, updatedAt: now, sessionsValidAfter: now })
      .where(eq(users.id, id))
      .returning();
    if (!row) throw new NotFoundError("User not found");
    // Flush the in-process SVA cache so the role change takes effect
    // immediately for any in-flight request on this instance, not after the
    // 30-second cache TTL expires.
    invalidateSessionsValidAfterCache(id);
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

  async getConcurrentViewers(range: "7d" | "30d" | "90d"): Promise<ConcurrentResult> {
    const CACHE_KEY = `admin:analytics:concurrent:${range}:v4`;
    const cached = await cache().get<ConcurrentResult>(CACHE_KEY);
    if (cached) return cached;

    const rangeDays = range === "7d" ? 7 : range === "30d" ? 30 : 90;
    const gran = range === "7d" ? "1 hour" : range === "30d" ? "4 hours" : "1 day";
    const granKey: "hour" | "4h" | "day" = range === "7d" ? "hour" : range === "30d" ? "4h" : "day";

    // Safety assertion: rangeDays and gran are derived from a Zod-validated
    // enum ("7d"|"30d"|"90d") at the route level, but we also guard here so
    // a direct service call cannot inject arbitrary SQL fragments.
    const safeRangeDays = ([7, 30, 90] as const).includes(rangeDays as 7 | 30 | 90) ? rangeDays : 7;
    const safeGran = (["1 hour", "4 hours", "1 day"] as const).includes(gran as "1 hour" | "4 hours" | "1 day") ? gran : "1 day";

    // Generate time buckets and count distinct sessions active at each bucket.
    // A session is "active" at time T when:
    //   started_at <= T  AND  (ended_at > T  OR  (ended_at IS NULL AND last_heartbeat_at >= T - 5 min))
    // The JOIN pre-filters sessions to only those within the query window for index efficiency.
    const rawRows = await db.execute(sql`
      WITH buckets AS (
        SELECT generate_series(
          date_trunc('hour', now()) - ${sql.raw(`'${safeRangeDays} days'`)}::interval,
          date_trunc('hour', now()),
          ${sql.raw(`'${safeGran}'`)}::interval
        ) AS bucket
      )
      SELECT
        to_char(bucket AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ts,
        COALESCE(COUNT(DISTINCT CASE
          WHEN vs.started_at <= b.bucket
          AND (vs.ended_at > b.bucket OR (vs.ended_at IS NULL AND vs.last_heartbeat_at >= b.bucket - INTERVAL '5 minutes'))
          THEN vs.id END), 0)::int AS concurrent,
        COALESCE(COUNT(DISTINCT CASE
          WHEN vs.platform = 'tv'
          AND vs.started_at <= b.bucket
          AND (vs.ended_at > b.bucket OR (vs.ended_at IS NULL AND vs.last_heartbeat_at >= b.bucket - INTERVAL '5 minutes'))
          THEN vs.id END), 0)::int AS tv,
        COALESCE(COUNT(DISTINCT CASE
          WHEN vs.platform = 'mobile'
          AND vs.started_at <= b.bucket
          AND (vs.ended_at > b.bucket OR (vs.ended_at IS NULL AND vs.last_heartbeat_at >= b.bucket - INTERVAL '5 minutes'))
          THEN vs.id END), 0)::int AS mobile,
        COALESCE(COUNT(DISTINCT CASE
          WHEN vs.platform = 'web'
          AND vs.started_at <= b.bucket
          AND (vs.ended_at > b.bucket OR (vs.ended_at IS NULL AND vs.last_heartbeat_at >= b.bucket - INTERVAL '5 minutes'))
          THEN vs.id END), 0)::int AS web
      FROM buckets b
      LEFT JOIN viewer_sessions vs ON
        vs.started_at <= b.bucket
        AND vs.started_at >= b.bucket - ${sql.raw(`'${safeRangeDays + 1} days'`)}::interval
      GROUP BY b.bucket
      ORDER BY b.bucket
    `);

    const buckets: ConcurrentBucket[] = (rawRows.rows as Array<Record<string, unknown>>).map((r) => ({
      ts: String(r["ts"] ?? ""),
      concurrent: Number(r["concurrent"] ?? 0),
      tv: Number(r["tv"] ?? 0),
      mobile: Number(r["mobile"] ?? 0),
      web: Number(r["web"] ?? 0),
    }));

    let peak: ConcurrentResult["peak"] = { concurrent: 0, ts: "" };
    for (const b of buckets) {
      if (b.concurrent > peak.concurrent) {
        peak = { concurrent: b.concurrent, ts: b.ts };
      }
    }

    const result: ConcurrentResult = { buckets, peak, granularity: granKey, generatedAt: new Date().toISOString() };
    await cache().set(CACHE_KEY, result, 60);
    return result;
  },

  async getDailyPlatformTrends(range: "7d" | "30d" | "90d"): Promise<DailyPlatformResult> {
    const CACHE_KEY = `admin:analytics:platform-trends:${range}:v2`;
    const cached = await cache().get<DailyPlatformResult>(CACHE_KEY);
    if (cached) return cached;

    const sessions = schema.viewerSessionsTable;
    const rangeDays = range === "7d" ? 7 : range === "30d" ? 30 : 90;
    const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000);

    const rows = await db
      .select({
        date: sql<string>`date_trunc('day', ${sessions.startedAt})::date::text`,
        platform: sessions.platform,
        sessions: count(),
      })
      .from(sessions)
      .where(gte(sessions.startedAt, since))
      .groupBy(sql`date_trunc('day', ${sessions.startedAt})`, sessions.platform)
      .orderBy(sql`date_trunc('day', ${sessions.startedAt})`);

    const dayMap = new Map<string, DailyPlatformDay>();
    for (const r of rows) {
      const d = r.date;
      if (!dayMap.has(d)) dayMap.set(d, { date: d, tv: 0, mobile: 0, web: 0, total: 0 });
      const entry = dayMap.get(d)!;
      const n = Number(r.sessions);
      if (r.platform === "tv") entry.tv += n;
      else if (r.platform === "mobile") entry.mobile += n;
      else if (r.platform === "web") entry.web += n;
      entry.total += n;
    }

    const days = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    const result: DailyPlatformResult = { days, generatedAt: new Date().toISOString() };
    await cache().set(CACHE_KEY, result, 60);
    return result;
  },
};
