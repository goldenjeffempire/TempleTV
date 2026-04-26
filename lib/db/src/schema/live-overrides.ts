import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const liveOverridesTable = pgTable("live_overrides", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  hlsStreamUrl: text("hls_stream_url"),
  /**
   * 11-character YouTube video ID for a live broadcast. When set, viewers
   * receive a YouTube embed instead of the HLS stream — admins can paste
   * a YouTube live URL into Live Control and instantly air it across TV,
   * mobile, web, and radio surfaces. Resolved from `youtubeUrl` server-side
   * by `extractYouTubeVideoId()` before persistence.
   */
  youtubeVideoId: text("youtube_video_id"),
  rtmpIngestKey: text("rtmp_ingest_key"),
  streamNotes: text("stream_notes"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  /**
   * When set in the future and `is_active=false`, the live-override
   * scheduler activates this row at the specified time. Lets admins
   * queue a recurring service URL (e.g. Sunday 9am) the night before
   * and have it auto-go-live across all surfaces with no manual
   * touch. `auto_started=true` is set when the scheduler fires it,
   * for audit/visibility.
   */
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  autoStarted: boolean("auto_started").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertLiveOverrideSchema = createInsertSchema(liveOverridesTable).omit({ createdAt: true });
export type InsertLiveOverride = z.infer<typeof insertLiveOverrideSchema>;
export type LiveOverride = typeof liveOverridesTable.$inferSelect;
