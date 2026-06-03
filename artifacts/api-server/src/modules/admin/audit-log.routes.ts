/**
 * Admin Audit Log — activity feed for the admin panel.
 *
 * Builds a unified activity trail by querying multiple tables:
 *   • videos  — recently added / finalized uploads
 *   • users   — recently registered accounts
 *   • scheduleItems — recent schedule additions
 *
 * All items are merged, sorted by timestamp, and returned as a flat
 * array of AuditEntry objects — no dedicated audit table required.
 * Limit: 200 most-recent entries.
 */

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { desc } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";

const AuditEntrySchema = z.object({
  id: z.string(),
  type: z.enum(["video_uploaded", "video_transcoded", "user_created", "schedule_added", "config_changed"]),
  timestamp: z.string(),
  actor: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  meta: z.record(z.unknown()).optional(),
});

type AuditEntry = z.infer<typeof AuditEntrySchema>;

export async function auditLogRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/audit-log",
    {
      preHandler: requireAuth("admin"),
      // Strict per-IP limit: this endpoint fans out to 4+ sequential DB scans
      // and performs in-memory merging. Without a low cap, a single client can
      // saturate the DB connection pool at the global 120/min default.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["admin"],
        summary: "Get admin activity audit log (latest 200 entries)",
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(100),
          // Page offset into the merged, sorted result set. Without this, the
          // endpoint is stuck at the first `limit` entries regardless of how
          // many rows exist across the source tables.
          offset: z.coerce.number().int().min(0).default(0),
          type: z.enum(["video_uploaded", "video_transcoded", "user_created", "schedule_added", "config_changed", "all"]).default("all"),
        }),
        response: {
          200: z.object({
            entries: z.array(AuditEntrySchema),
            total: z.number(),
          }),
        },
      },
    },
    async (req, reply) => {
      const { limit, offset, type } = req.query;
      // Fetch enough rows from each source table to cover any requested page.
      // Without this, entries beyond the original hard-coded ceiling (100/50/30)
      // were never fetched, making offset > 0 return empty results.
      const fetchLimit = Math.min(limit + offset + 200, 500);
      const entries: AuditEntry[] = [];

      // ── Videos (uploaded / transcoded) ────────────────────────────────────
      if (type === "all" || type === "video_uploaded" || type === "video_transcoded") {
        const videos = await db
          .select({
            id: schema.videosTable.id,
            title: schema.videosTable.title,
            transcodingStatus: schema.videosTable.transcodingStatus,
            importedAt: schema.videosTable.importedAt,
            category: schema.videosTable.category,
            preacher: schema.videosTable.preacher,
          })
          .from(schema.videosTable)
          .orderBy(desc(schema.videosTable.importedAt))
          .limit(fetchLimit);

        for (const v of videos) {
          const ts = v.importedAt?.toISOString() ?? new Date().toISOString();
          if (type === "all" || type === "video_uploaded") {
            entries.push({
              id: `vid-upload-${v.id}`,
              type: "video_uploaded",
              timestamp: ts,
              actor: null,
              title: "Video Uploaded",
              description: v.title ?? "Untitled",
              meta: {
                videoId: v.id,
                category: v.category ?? "",
                preacher: v.preacher ?? "",
                transcodingStatus: v.transcodingStatus ?? "pending",
              },
            });
          }
          if ((type === "all" || type === "video_transcoded") && v.transcodingStatus === "completed") {
            entries.push({
              id: `vid-transcode-${v.id}`,
              type: "video_transcoded",
              timestamp: ts,
              actor: null,
              title: "Transcoding Completed",
              description: v.title ?? "Untitled",
              meta: { videoId: v.id },
            });
          }
        }
      }

      // ── Users (recently registered) ────────────────────────────────────────
      if (type === "all" || type === "user_created") {
        const users = await db
          .select({
            id: schema.usersTable.id,
            email: schema.usersTable.email,
            role: schema.usersTable.role,
            createdAt: schema.usersTable.createdAt,
          })
          .from(schema.usersTable)
          .orderBy(desc(schema.usersTable.createdAt))
          .limit(fetchLimit);

        for (const u of users) {
          const ts = u.createdAt?.toISOString() ?? new Date().toISOString();
          entries.push({
            id: `user-${u.id}`,
            type: "user_created",
            timestamp: ts,
            actor: null,
            title: "User Registered",
            description: u.email ?? "",
            meta: { userId: u.id, role: u.role },
          });
        }
      }

      // ── Schedule items ─────────────────────────────────────────────────────
      if (type === "all" || type === "schedule_added") {
        try {
          const schedItems = await db
            .select({
              id: schema.scheduleTable.id,
              title: schema.scheduleTable.title,
              createdAt: schema.scheduleTable.createdAt,
              startTime: schema.scheduleTable.startTime,
            })
            .from(schema.scheduleTable)
            .orderBy(desc(schema.scheduleTable.createdAt))
            .limit(fetchLimit);

          for (const s of schedItems) {
            const ts = s.createdAt?.toISOString() ?? new Date().toISOString();
            entries.push({
              id: `sched-${s.id}`,
              type: "schedule_added",
              timestamp: ts,
              actor: null,
              title: "Scheduled Broadcast",
              description: s.title ?? "Untitled",
              meta: { scheduleId: s.id, startTime: s.startTime },
            });
          }
        } catch {
          /* schedule table might not exist in all envs — skip */
        }
      }

      // ── App config changes ─────────────────────────────────────────────────
      if (type === "all" || type === "config_changed") {
        try {
          const configs = await db
            .select({
              key: schema.appConfigTable.key,
              value: schema.appConfigTable.value,
              updatedAt: schema.appConfigTable.updatedAt,
            })
            .from(schema.appConfigTable)
            .orderBy(desc(schema.appConfigTable.updatedAt))
            .limit(fetchLimit);

          for (const c of configs) {
            const ts = c.updatedAt?.toISOString() ?? new Date().toISOString();
            entries.push({
              id: `cfg-${c.key}-${ts}`,
              type: "config_changed",
              timestamp: ts,
              actor: null,
              title: "Config Updated",
              description: `${c.key} = ${String(c.value).slice(0, 80)}`,
              meta: { key: c.key },
            });
          }
        } catch {
          /* app_config table might not exist — skip */
        }
      }

      // Sort all entries newest-first, then apply offset + limit
      entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      const sliced = entries.slice(offset, offset + limit);

      return reply.send({ entries: sliced, total: entries.length });
    },
  );
}
