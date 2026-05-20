import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, count, eq, inArray, ne } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";
import { env } from "../../config/env.js";

/**
 * Launch-readiness checklist for the admin SPA's go/no-go dashboard.
 *
 * The page expects a structured doc grouped by category, with each
 * check carrying a status (`ready` / `warning` / `blocked`) and a
 * one-line detail string. We intentionally compute the whole thing
 * inline against the live DB rather than caching — it runs once when
 * an editor opens the page, and the freshness guarantee outweighs the
 * cost of half-a-dozen `count()` queries.
 *
 * Status semantics:
 *   ready    — green, nothing to do
 *   warning  — yellow, can launch but should be fixed soon
 *   blocked  — red, cannot launch until resolved
 *
 * Overall status = worst of all checks.
 */

const videos = schema.videosTable;
const broadcast = schema.broadcastQueueTable;
const scheduleTable = schema.scheduleTable;
const ingest = schema.liveIngestEndpointsTable;
const pushTokens = schema.pushTokensTable;
const webPush = schema.webPushSubscriptionsTable;
const users = schema.usersTable;

const StatusSchema = z.enum(["ready", "warning", "blocked"]);

const CheckSchema = z.object({
  key: z.string(),
  label: z.string(),
  status: StatusSchema,
  detail: z.string(),
  action: z.string().optional(),
});

const CategorySchema = z.object({
  key: z.string(),
  label: z.string(),
  checks: z.array(CheckSchema),
});

const ReadinessSchema = z.object({
  generatedAt: z.string(),
  environment: z.string(),
  overallStatus: StatusSchema,
  summary: z.object({
    ready: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  counts: z.object({
    totalVideos: z.number().int().nonnegative(),
    localVideos: z.number().int().nonnegative(),
    hlsReadyLocalVideos: z.number().int().nonnegative(),
    encodingLocalVideos: z.number().int().nonnegative(),
    activeScheduleEntries: z.number().int().nonnegative(),
    activeBroadcastItems: z.number().int().nonnegative(),
    registeredDevices: z.number().int().nonnegative(),
    failedTranscodes: z.number().int().nonnegative(),
    queuedTranscodes: z.number().int().nonnegative(),
  }),
  categories: z.array(CategorySchema),
});

type Status = z.infer<typeof StatusSchema>;
type Check = z.infer<typeof CheckSchema>;

function worst(a: Status, b: Status): Status {
  if (a === "blocked" || b === "blocked") return "blocked";
  if (a === "warning" || b === "warning") return "warning";
  return "ready";
}

export async function launchReadinessRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/launch/readiness",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Pre-launch checklist with per-category statuses",
        response: { 200: ReadinessSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      // ── Roll up the counts in a single fan-out ──────────────────────────
      // Each Promise is a tiny indexed COUNT/SELECT — running them in
      // parallel keeps the whole endpoint under ~100ms even on cold
      // pooled connections.
      const [
        totalVideosRow,
        localVideosRow,
        hlsReadyRow,
        encodingLocalRow,
        activeScheduleRow,
        activeBroadcastRow,
        pushTokensRow,
        webPushRow,
        failedTranscodesRow,
        queuedTranscodesRow,
        adminUsersRow,
        ingestRows,
      ] = await Promise.all([
        db.select({ c: count() }).from(videos),
        db.select({ c: count() }).from(videos).where(eq(videos.videoSource, "local")),
        db
          .select({ c: count() })
          .from(videos)
          .where(and(eq(videos.videoSource, "local"), inArray(videos.transcodingStatus, ["hls_ready", "ready"]))),
        db
          .select({ c: count() })
          .from(videos)
          .where(and(eq(videos.videoSource, "local"), eq(videos.transcodingStatus, "encoding"))),
        db.select({ c: count() }).from(scheduleTable).where(eq(scheduleTable.isActive, true)),
        db.select({ c: count() }).from(broadcast).where(eq(broadcast.isActive, true)),
        db.select({ c: count() }).from(pushTokens),
        db.select({ c: count() }).from(webPush),
        db.select({ c: count() }).from(videos).where(eq(videos.transcodingStatus, "failed")),
        db.select({ c: count() }).from(videos).where(eq(videos.transcodingStatus, "queued")),
        db.select({ c: count() }).from(users).where(ne(users.role, "user")),
        db.select().from(ingest),
      ]);

      const totalVideos = Number(totalVideosRow[0]?.c ?? 0);
      const localVideos = Number(localVideosRow[0]?.c ?? 0);
      const hlsReadyLocalVideos = Number(hlsReadyRow[0]?.c ?? 0);
      const encodingLocalVideos = Number(encodingLocalRow[0]?.c ?? 0);
      const activeScheduleEntries = Number(activeScheduleRow[0]?.c ?? 0);
      const activeBroadcastItems = Number(activeBroadcastRow[0]?.c ?? 0);
      const registeredDevices =
        Number(pushTokensRow[0]?.c ?? 0) + Number(webPushRow[0]?.c ?? 0);
      const failedTranscodes = Number(failedTranscodesRow[0]?.c ?? 0);
      const queuedTranscodes = Number(queuedTranscodesRow[0]?.c ?? 0);
      const adminUsers = Number(adminUsersRow[0]?.c ?? 0);
      const primaryIngest = ingestRows.find((row) => row.isPrimary);
      const healthyIngestCount = ingestRows.filter((row) => row.healthStatus === "healthy").length;

      // ── Per-check evaluation ────────────────────────────────────────────
      const contentChecks: Check[] = [
        totalVideos === 0
          ? {
              key: "library-empty",
              label: "Video library populated",
              status: "blocked",
              detail: "No videos imported yet",
              action: "Import videos from YouTube or upload local files",
            }
          : {
              key: "library-empty",
              label: "Video library populated",
              status: "ready",
              detail: `${totalVideos} videos in the library`,
            },
        localVideos === 0
          ? {
              key: "local-uploads",
              label: "Local uploads available",
              status: "warning",
              detail: "No local uploads — relying entirely on YouTube embeds",
              action: "Upload at least one MP4 so the player has a CDN-served fallback",
            }
          : hlsReadyLocalVideos >= localVideos
            ? {
                key: "local-uploads",
                label: "Local uploads transcoded",
                status: "ready",
                detail: `All ${localVideos} local uploads have HLS ready`,
              }
            : (() => {
                const inPipeline = encodingLocalVideos + queuedTranscodes;
                const allAccountedFor = hlsReadyLocalVideos + inPipeline >= localVideos;
                const remaining = localVideos - hlsReadyLocalVideos;
                if (allAccountedFor && failedTranscodes === 0) {
                  const parts: string[] = [];
                  if (encodingLocalVideos > 0) parts.push(`${encodingLocalVideos} encoding`);
                  if (queuedTranscodes > 0) parts.push(`${queuedTranscodes} queued`);
                  return {
                    key: "local-uploads",
                    label: "Local uploads transcoded",
                    status: "warning" as const,
                    detail: `${hlsReadyLocalVideos} of ${localVideos} ready — ${parts.join(", ")} (${remaining} in pipeline)`,
                    action: "Transcoding is running automatically — no action needed. Refresh once complete.",
                  };
                }
                return {
                  key: "local-uploads",
                  label: "Local uploads transcoded",
                  status: "warning" as const,
                  detail: `${hlsReadyLocalVideos} of ${localVideos} local uploads have HLS ready`,
                  action: "Wait for transcoding to finish or investigate stuck jobs on the Transcoding page",
                };
              })(),
        failedTranscodes === 0
          ? {
              key: "transcodes-failed",
              label: "No failed transcodes",
              status: "ready",
              detail: "All transcoding jobs are healthy",
            }
          : {
              key: "transcodes-failed",
              label: "Failed transcodes",
              status: "warning",
              detail: `${failedTranscodes} videos failed to transcode`,
              action: "Re-run the transcoding pipeline for failed videos",
            },
      ];

      const broadcastChecks: Check[] = [
        activeBroadcastItems === 0
          ? {
              key: "broadcast-queue-empty",
              label: "Broadcast queue has active items",
              status: "blocked",
              detail: "No active items in the broadcast queue",
              action: "Add videos to /admin/broadcast",
            }
          : activeBroadcastItems < 3
            ? {
                key: "broadcast-queue-empty",
                label: "Broadcast queue length",
                status: "warning",
                detail: `Only ${activeBroadcastItems} active items — the queue will recycle quickly`,
                action: "Add more videos so viewers don't see repeats",
              }
            : {
                key: "broadcast-queue-empty",
                label: "Broadcast queue length",
                status: "ready",
                detail: `${activeBroadcastItems} active items in rotation`,
              },
        activeScheduleEntries === 0
          ? {
              key: "schedule-empty",
              label: "Live schedule configured",
              status: "warning",
              detail: "No scheduled programs configured",
              action: "Add at least one entry on the /admin/schedule page",
            }
          : {
              key: "schedule-empty",
              label: "Live schedule configured",
              status: "ready",
              detail: `${activeScheduleEntries} scheduled programs active`,
            },
      ];

      const liveChecks: Check[] = [
        ingestRows.length === 0
          ? {
              key: "ingest-configured",
              label: "Live ingest configured",
              status: "warning",
              detail: "No live-ingest endpoints configured",
              action: "Add an RTMP/SRT endpoint on /admin/live-ingest",
            }
          : !primaryIngest
            ? {
                key: "ingest-configured",
                label: "Primary ingest selected",
                status: "blocked",
                detail: `${ingestRows.length} ingest endpoints exist but none is marked primary`,
                action: "Promote one endpoint to primary",
              }
            : {
                key: "ingest-configured",
                label: "Primary ingest selected",
                status: "ready",
                detail: `Primary: ${primaryIngest.name} (${primaryIngest.protocol.toUpperCase()})`,
              },
        ingestRows.length > 0 && healthyIngestCount === 0
          ? {
              key: "ingest-healthy",
              label: "Ingest endpoints healthy",
              status: "warning",
              detail: "No ingest endpoints have a recent healthy probe",
              action: "Run a probe from /admin/live-ingest to verify connectivity",
            }
          : {
              key: "ingest-healthy",
              label: "Ingest endpoints healthy",
              status: "ready",
              detail:
                ingestRows.length === 0
                  ? "Skipped (no ingest configured)"
                  : `${healthyIngestCount} of ${ingestRows.length} endpoints healthy`,
            },
      ];

      const distributionChecks: Check[] = [
        registeredDevices === 0
          ? {
              key: "push-devices",
              label: "Push notification audience",
              status: "warning",
              detail: "No registered devices — push notifications will reach nobody",
              action: "Wait for users to install the app + grant push permission",
            }
          : {
              key: "push-devices",
              label: "Push notification audience",
              status: "ready",
              detail: `${registeredDevices} registered push subscribers`,
            },
      ];

      const accessChecks: Check[] = [
        adminUsers === 0
          ? {
              key: "admin-users",
              label: "Admin / editor accounts exist",
              status: "blocked",
              detail: "No editor or admin users in the database",
              action: "Create at least one admin user via POST /api/auth/seed (requires ADMIN_API_TOKEN)",
            }
          : {
              key: "admin-users",
              label: "Admin / editor accounts exist",
              status: "ready",
              detail: `${adminUsers} editor/admin accounts`,
            },
        env.ADMIN_API_TOKEN
          ? {
              key: "legacy-token",
              label: "Legacy admin API token",
              status: "warning",
              detail: "ADMIN_API_TOKEN is set — anyone with the token can act as system admin",
              action: "Rotate to JWT-only auth once tooling no longer relies on the token",
            }
          : {
              key: "legacy-token",
              label: "Legacy admin API token",
              status: "ready",
              detail: "Not configured (JWT auth only)",
            },
      ];

      const categories = [
        { key: "content", label: "Content library", checks: contentChecks },
        { key: "broadcast", label: "Broadcast & schedule", checks: broadcastChecks },
        { key: "live", label: "Live ingest", checks: liveChecks },
        { key: "distribution", label: "Distribution", checks: distributionChecks },
        { key: "access", label: "Access & security", checks: accessChecks },
      ];

      const allChecks = categories.flatMap((c) => c.checks);
      const ready = allChecks.filter((c) => c.status === "ready").length;
      const warnings = allChecks.filter((c) => c.status === "warning").length;
      const blocked = allChecks.filter((c) => c.status === "blocked").length;
      const overallStatus = allChecks.reduce<Status>((acc, c) => worst(acc, c.status), "ready");

      return {
        generatedAt: new Date().toISOString(),
        environment: env.NODE_ENV ?? "development",
        overallStatus,
        summary: { ready, warnings, blocked, total: allChecks.length },
        counts: {
          totalVideos,
          localVideos,
          hlsReadyLocalVideos,
          encodingLocalVideos,
          activeScheduleEntries,
          activeBroadcastItems,
          registeredDevices,
          failedTranscodes,
          queuedTranscodes,
        },
        categories,
      };
    },
  );
}
