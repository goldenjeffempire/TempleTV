import { z } from "zod";

export const NotificationSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  type: z.string(),
  videoId: z.string().nullable(),
  sentAt: z.string(),
  sentCount: z.number().int().nonnegative(),
});

export const ListNotificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export const ListNotificationsResponseSchema = z.object({
  items: z.array(NotificationSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

export const SendPushBodySchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(500),
  type: z.enum(["live", "new_video", "announcement", "test"]).default("announcement"),
  videoId: z.string().nullable().optional(),
});

export const SendPushResponseSchema = NotificationSchema.extend({
  recipients: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
});
