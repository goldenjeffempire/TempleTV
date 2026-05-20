import { pgTable, text, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";

/**
 * Viewer Sessions — tracks active and completed viewing sessions.
 *
 * A session starts when a client sends a `started` watch event and ends when
 * a `completed` or `abandoned` event arrives, or when the heartbeat goes
 * stale (> 5 min without a heartbeat). Used to power the real-time viewer
 * count dashboard and historical engagement analytics.
 *
 * deviceId: anonymous per-device identifier (UUID stored in client storage).
 * platform: "tv" | "mobile" | "web"
 */
export const viewerSessionsTable = pgTable(
  "viewer_sessions",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    channelId: text("channel_id").notNull().default("temple-tv-live"),
    videoId: text("video_id"),
    platform: text("platform", { enum: ["tv", "mobile", "web"] }).notNull(),
    isLive: boolean("is_live").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** Total watch duration in seconds at session end. */
    watchedSecs: integer("watched_secs").notNull().default(0),
    /** Whether the viewer watched to completion (>= 90% of content). */
    completed: boolean("completed").notNull().default(false),
    country: text("country"),
    city: text("city"),
  },
  (t) => [
    index("idx_viewer_sessions_active").on(t.endedAt, t.lastHeartbeatAt),
    index("idx_viewer_sessions_channel").on(t.channelId, t.endedAt),
    index("idx_viewer_sessions_device").on(t.deviceId, t.startedAt),
    index("idx_viewer_sessions_started").on(t.startedAt),
  ],
);

export type ViewerSession = typeof viewerSessionsTable.$inferSelect;
export type NewViewerSession = typeof viewerSessionsTable.$inferInsert;
