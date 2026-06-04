import { pgTable, text, timestamp, boolean, integer, real, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import type { z } from "zod/v4";

/**
 * Live ingest endpoints — vMix / OBS / Wirecast / Cloudflare Stream / Mux / AWS IVS
 * configurations. Each row represents a single configured input source the
 * broadcast system can pull from.
 *
 * The pipeline is:
 *   external encoder (vMix, OBS, ...) →  ingest URL (RTMP/RTMPS/SRT)
 *      → upstream HLS packager (provider) →  hlsPlaybackUrl (consumed by clients)
 *
 * The API never accepts raw RTMP frames itself (Replit / Render don't expose
 * RTMP ports); customers run their own ingest endpoint at a provider that
 * gives them an HLS playback URL, which is what we play and health-check.
 *
 * The `streamKey` is generated server-side and copy-pasted into the encoder
 * (or used to derive the provider's ingest URL).
 */
export const liveIngestEndpointsTable = pgTable("live_ingest_endpoints", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  protocol: text("protocol").notNull(),
  ingestUrl: text("ingest_url").notNull(),
  streamKey: text("stream_key").notNull(),
  hlsPlaybackUrl: text("hls_playback_url").notNull(),
  fallbackYoutubeUrl: text("fallback_youtube_url"),
  isPrimary: boolean("is_primary").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  priority: integer("priority").notNull().default(100),
  notes: text("notes"),
  healthStatus: text("health_status").notNull().default("unknown"),
  lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
  lastHealthyAt: timestamp("last_healthy_at", { withTimezone: true }),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastBitrateKbps: real("last_bitrate_kbps"),
  lastSegmentLatencyMs: integer("last_segment_latency_ms"),
  droppedFramesPct: real("dropped_frames_pct"),
  lastError: text("last_error"),
  metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertLiveIngestEndpointSchema = createInsertSchema(liveIngestEndpointsTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertLiveIngestEndpoint = z.infer<typeof insertLiveIngestEndpointSchema>;
export type LiveIngestEndpoint = typeof liveIngestEndpointsTable.$inferSelect;

export type LiveIngestProtocol = "rtmp" | "rtmps" | "srt" | "hls" | "whip";
export type LiveIngestHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";
