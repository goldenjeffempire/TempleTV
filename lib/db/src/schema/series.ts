import { pgTable, text, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";

/**
 * Series — sermon series / teaching collections with episode hierarchy.
 *
 * Hierarchy: Series → Episodes (linked to managed_videos).
 * A video can belong to multiple series; the series_episodes join table
 * tracks episode number and ordering within each series.
 */
export const seriesTable = pgTable(
  "series",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    slug: text("slug").notNull().unique(),
    description: text("description").notNull().default(""),
    thumbnailUrl: text("thumbnail_url").notNull().default(""),
    bannerUrl: text("banner_url"),
    preacher: text("preacher"),
    category: text("category").notNull().default("sermon"),
    /** Whether this series is published / visible to viewers. */
    isPublished: boolean("is_published").notNull().default(false),
    /** Whether new episodes are still being added. */
    isOngoing: boolean("is_ongoing").notNull().default(true),
    episodeCount: integer("episode_count").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_series_published").on(t.isPublished, t.sortOrder),
    index("idx_series_slug").on(t.slug),
    index("idx_series_category").on(t.category, t.isPublished),
  ],
);

export const seriesEpisodesTable = pgTable(
  "series_episodes",
  {
    id: text("id").primaryKey(),
    seriesId: text("series_id")
      .notNull()
      .references(() => seriesTable.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull(),
    episodeNumber: integer("episode_number").notNull().default(1),
    title: text("title"),
    description: text("description"),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_series_episodes_series").on(t.seriesId, t.episodeNumber),
    index("idx_series_episodes_video").on(t.videoId),
  ],
);

export type Series = typeof seriesTable.$inferSelect;
export type NewSeries = typeof seriesTable.$inferInsert;
export type SeriesEpisode = typeof seriesEpisodesTable.$inferSelect;
export type NewSeriesEpisode = typeof seriesEpisodesTable.$inferInsert;
