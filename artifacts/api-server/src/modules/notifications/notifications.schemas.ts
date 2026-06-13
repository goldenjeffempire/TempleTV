import { z } from "zod";

export const NotificationSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  type: z.string(),
  videoId: z.string().nullable(),
  // Timestamp at which the notification was persisted / sent.
  sentAt: z.string(),
  // Aliases so the admin SPA history hook (SentNotification type) can spread
  // the row directly. Both map to sentAt for sent_notifications rows, which
  // have no separate creation or scheduling timestamp.
  createdAt: z.string(),
  scheduledAt: z.string(),
  sentCount: z.number().int().nonnegative(),
  status: z.string(),
  attempts: z.number().int().nonnegative(),
  // Exposed as `errorMessage` to match the SentNotification client type
  // (the DB column is `last_error` but the SPA was always written against
  // `errorMessage`).
  errorMessage: z.string().nullable(),
});

export const ListNotificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).default(50).catch(50).transform(v => Math.min(v, 200)),
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
  type: z.enum(["live", "new_video", "announcement", "test", "app_update"]).default("announcement"),
  videoId: z.string().nullable().optional(),
  // Optional caller-supplied dedup key. Repeated POSTs with the same
  // key short-circuit to the original audit row. Also accepted via the
  // `Idempotency-Key` request header (header takes precedence) — see
  // notifications.routes.ts.
  idempotencyKey: z.string().min(1).max(128).optional(),
});

export const SendPushResponseSchema = NotificationSchema.extend({
  recipients: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  deduplicated: z.boolean(),
});
