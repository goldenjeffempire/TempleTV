import { and, count, desc, eq, gt, ilike, or, sql, sum } from "drizzle-orm";
import type { z } from "zod";
import { db, schema } from "../../infrastructure/db.js";
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
      generatedAt: new Date().toISOString(),
    };
  },

  async getAnalytics() {
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
        thumbnailUrl: v.thumbnailUrl,
      })),
      totalViews: Number(totals[0]?.s ?? 0),
      generatedAt: new Date().toISOString(),
    };
  },
};
