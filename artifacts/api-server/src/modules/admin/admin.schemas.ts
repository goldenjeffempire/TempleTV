import { z } from "zod";

export const AdminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  role: z.string(),
  emailVerified: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ListUsersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().nonnegative().default(0),
  role: z.string().optional(),
  search: z.string().min(1).max(120).optional(),
});

export const ListUsersResponseSchema = z.object({
  items: z.array(AdminUserSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

export const UpdateUserRoleBodySchema = z.object({
  role: z.enum(["user", "editor", "admin"]),
});

export const AdminStatsSchema = z.object({
  videos: z.object({
    total: z.number().int().nonnegative(),
    featured: z.number().int().nonnegative(),
    bySource: z.record(z.string(), z.number().int().nonnegative()),
  }),
  users: z.object({
    total: z.number().int().nonnegative(),
    byRole: z.record(z.string(), z.number().int().nonnegative()),
  }),
  playlists: z.object({ total: z.number().int().nonnegative() }),
  schedule: z.object({
    total: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
  }),
  notifications: z.object({
    sentLast24h: z.number().int().nonnegative(),
    sentTotal: z.number().int().nonnegative(),
  }),
  broadcast: z.object({
    queueDepth: z.number().int().nonnegative(),
    activeQueueDepth: z.number().int().nonnegative(),
  }),
  generatedAt: z.string(),
});

export const AnalyticsSchema = z.object({
  topVideos: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      viewCount: z.number().int().nonnegative(),
      thumbnailUrl: z.string(),
    }),
  ),
  totalViews: z.number().int().nonnegative(),
  generatedAt: z.string(),
});
