import { z } from "zod";

export const LiveOverrideSchema = z.object({
  id: z.string(),
  title: z.string(),
  isActive: z.boolean(),
  hlsStreamUrl: z.string().nullable(),
  youtubeVideoId: z.string().nullable(),
  rtmpIngestKey: z.string().nullable(),
  streamNotes: z.string().nullable(),
  startedAt: z.string(),
  endsAt: z.string().nullable(),
  scheduledFor: z.string().nullable(),
  autoStarted: z.boolean(),
  createdAt: z.string(),
});

export const LiveStatusSchema = z.object({
  isLive: z.boolean(),
  active: LiveOverrideSchema.nullable(),
});

export const StartOverrideBodySchema = z
  .object({
    title: z.string().min(1).max(200),
    hlsStreamUrl: z.string().url().nullable().optional(),
    youtubeUrl: z.string().nullable().optional(),
    rtmpIngestKey: z.string().nullable().optional(),
    streamNotes: z.string().max(2000).nullable().optional(),
    endsAt: z.string().datetime().nullable().optional(),
    scheduledFor: z.string().datetime().nullable().optional(),
  })
  .refine(
    (v) =>
      Boolean(v.hlsStreamUrl) || Boolean(v.youtubeUrl) || Boolean(v.rtmpIngestKey),
    { message: "Provide one of: hlsStreamUrl, youtubeUrl, or rtmpIngestKey" },
  );
