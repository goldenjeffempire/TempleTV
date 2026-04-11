import { pgTable, text, timestamp, boolean, integer } from "drizzle-orm/pg-core";
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
});

export const insertVideoSchema = createInsertSchema(videosTable).omit({ importedAt: true });
export type InsertVideo = z.infer<typeof insertVideoSchema>;
export type ManagedVideo = typeof videosTable.$inferSelect;
