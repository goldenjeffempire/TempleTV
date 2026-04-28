import { z } from "zod";

export const BroadcastItemSchema = z.object({
  id: z.string(),
  videoId: z.string().nullable(),
  youtubeId: z.string(),
  title: z.string(),
  thumbnailUrl: z.string(),
  durationSecs: z.number().int().positive(),
  localVideoUrl: z.string().nullable(),
  videoSource: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
});

export const BroadcastSnapshotSchema = z.object({
  channelId: z.string(),
  generatedAt: z.string(),
  current: BroadcastItemSchema.nullable(),
  next: BroadcastItemSchema.nullable(),
  upcoming: z.array(BroadcastItemSchema),
  preloadAt: z.string().nullable(),
  failoverHlsUrl: z.string().nullable(),
});

export const AddQueueItemSchema = z.object({
  videoId: z.string().nullable().optional(),
  youtubeId: z.string().min(1),
  title: z.string().min(1).max(200),
  thumbnailUrl: z.string().default(""),
  durationSecs: z.number().int().positive().max(60 * 60 * 12).default(1800),
  localVideoUrl: z.string().nullable().optional(),
  videoSource: z.enum(["youtube", "local", "hls"]).default("youtube"),
  sortOrder: z.number().int().optional(),
});

export const ReorderQueueSchema = z.object({
  itemIds: z.array(z.string()).min(1),
});

export type BroadcastItemDto = z.infer<typeof BroadcastItemSchema>;
export type BroadcastSnapshotDto = z.infer<typeof BroadcastSnapshotSchema>;
