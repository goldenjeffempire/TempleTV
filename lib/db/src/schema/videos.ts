import { pgTable, text, timestamp, boolean, integer, bigint, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const videosTable = pgTable("managed_videos", {
  id: text("id").primaryKey(),
  youtubeId: text("youtube_id").notNull().unique(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  thumbnailUrl: text("thumbnail_url").notNull().default(""),
  duration: text("duration").notNull().default(""),
  category: text("category").notNull().default("sermon"),
  preacher: text("preacher").notNull().default(""),
  publishedAt: text("published_at"),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  viewCount: integer("view_count").notNull().default(0),
  featured: boolean("featured").notNull().default(false),
  videoSource: text("video_source").notNull().default("youtube"),
  localVideoUrl: text("local_video_url"),
  hlsMasterUrl: text("hls_master_url"),
  transcodingStatus: text("transcoding_status").notNull().default("none"),
  // ── Upload metadata (Postgres = source of truth, bucket = bytes) ─────────
  // Populated for `videoSource === "local"` uploads. Nullable for legacy
  // YouTube imports and rows that pre-date the metadata migration.
  originalFilename: text("original_filename"),
  mimeType: text("mime_type"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  checksumSha256: text("checksum_sha256"),
  // Object-storage path (e.g. "/objects/uploads/<uuid>"). Populated when the
  // admin upload flow migrates from local disk to presigned-PUT GCS uploads.
  objectPath: text("object_path"),
  uploadedBy: text("uploaded_by"),
}, (table) => [
  index("idx_managed_videos_imported_at").on(table.importedAt),
  index("idx_managed_videos_category").on(table.category),
  index("idx_managed_videos_video_source").on(table.videoSource),
  index("idx_managed_videos_transcoding_status").on(table.transcodingStatus),
  index("idx_managed_videos_title").on(table.title),
  index("idx_managed_videos_preacher").on(table.preacher),
  index("idx_managed_videos_featured").on(table.featured),
  index("idx_managed_videos_view_count").on(table.viewCount),
]);

export const insertVideoSchema = createInsertSchema(videosTable).omit({ importedAt: true });
export type InsertVideo = z.infer<typeof insertVideoSchema>;
export type ManagedVideo = typeof videosTable.$inferSelect;
