import { z } from "zod";

export const MediaItemSchema = z.object({
  id: z.string(),
  youtubeId: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  thumbnailUrl: z.string(),
  duration: z.string(),
  category: z.string(),
  preacher: z.string(),
  publishedAt: z.string().nullable(),
  importedAt: z.string(),
  viewCount: z.number().int().nonnegative(),
  featured: z.boolean(),
  videoSource: z.string(),
  localVideoUrl: z.string().nullable(),
  hlsMasterUrl: z.string().nullable(),
});

export const ListMediaQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).default(20).catch(20).transform(v => Math.min(v, 100)),
  offset: z.coerce.number().int().nonnegative().default(0),
  category: z.string().optional(),
  featured: z.coerce.boolean().optional(),
  search: z.string().min(1).max(120).optional(),
});

export const ListMediaResponseSchema = z.object({
  items: z.array(MediaItemSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

export const CreateMediaBodySchema = z.object({
  youtubeId: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).default(""),
  thumbnailUrl: z.string().max(2048).default(""),
  duration: z.string().max(32).default(""),
  category: z.string().max(64).default("sermon"),
  preacher: z.string().max(255).default(""),
  videoSource: z.enum(["youtube", "local", "hls"]).default("youtube"),
  localVideoUrl: z.string().max(2048).nullable().optional(),
  featured: z.boolean().default(false),
  publishedAt: z.string().optional(),
});

export const UpdateMediaBodySchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).optional(),
    thumbnailUrl: z.string().max(2048).optional(),
    duration: z.string().max(32).optional(),
    category: z.string().max(64).optional(),
    preacher: z.string().max(255).optional(),
    featured: z.boolean().optional(),
    publishedAt: z.string().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Patch body must include at least one field" });

export const SignedUploadBodySchema = z.object({
  filename: z.string().min(1).max(200),
  contentType: z.string().min(1).max(120),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024 * 1024),
});

export const SignedUploadResponseSchema = z.object({
  key: z.string(),
  url: z.string(),
  expiresIn: z.number().int().positive(),
});
