import { z } from "zod";

export const PlaylistSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  loopMode: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  videoCount: z.number().int().nonnegative(),
});

export const PlaylistVideoSchema = z.object({
  id: z.string(),
  playlistId: z.string(),
  videoId: z.string(),
  youtubeId: z.string(),
  title: z.string(),
  thumbnailUrl: z.string(),
  duration: z.string(),
  category: z.string(),
  sortOrder: z.number().int(),
  addedAt: z.string(),
  youtubeLiveStatus: z.enum(["live", "rebroadcast"]).nullable().optional(),
});

export const PlaylistDetailSchema = PlaylistSchema.extend({
  videos: z.array(PlaylistVideoSchema),
});

export const ListPlaylistsResponseSchema = z.object({
  items: z.array(PlaylistSchema),
  total: z.number().int().nonnegative(),
});

export const CreatePlaylistBodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(""),
  loopMode: z.enum(["sequential", "shuffle", "single"]).default("sequential"),
  isActive: z.boolean().default(true),
});

export const UpdatePlaylistBodySchema = CreatePlaylistBodySchema.partial();

export const AddVideoBodySchema = z.object({
  videoId: z.string().min(1).max(64),
});

export const ReorderBodySchema = z.object({
  videoIds: z.array(z.string().min(1)).min(1).max(500),
});
