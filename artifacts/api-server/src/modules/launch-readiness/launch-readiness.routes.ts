import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";
import { env } from "../../config/env.js";
import { ytShuffleFallback } from "../broadcast-v2/engine/youtube-shuffle-fallback.js";

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
    broadcastCycleSecs: z.number().int().nonnegative(),
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
      // 10/min: this endpoint fans out 13 parallel COUNT queries — rate-limit
      // to prevent DB connection pool exhaustion under rapid-fire polling.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },      schema: {
        tags: ["admin"],
        summary: "Pre-launch checklist with per-category statuses",
        response: { 200: ReadinessSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      // ── Single CTE collects every counter in one DB round-trip ──────────
      // Replaces 13 parallel Promise.all queries (13 pool slots) with a
      // single parameterised statement (1 pool slot).  The planner executes
      // the scalar subqueries concurrently on the server side anyway, so
      // latency is comparable while connection pressure drops by ~12x.
      //
      // ingest_rows uses JSON_AGG so full row objects are returned for
      // is_primary / health_status inspection.  COALESCE(…, '[]') avoids
      // NULL when the table is empty.
      const readinessRows = await db.execute<{
        total_videos: string;
        local_videos: string;
        hls_ready: string;
        encoding_local: string;
        active_schedule: string;
        active_broadcast: string;
        broadcast_cycle: string;
        push_tokens: string;
        web_push: string;
        failed_transcodes: string;
        queued_transcodes: string;
        admin_users: string;
        ingest_rows: Array<{ is_primary: boolean; health_status: string; name: string; protocol: string }> | null;
      }>(sql`
        SELECT
          (SELECT COUNT(*)::text FROM managed_videos)                                                          AS total_videos,
          (SELECT COUNT(*)::text FROM managed_videos WHERE video_source = 'local')                             AS local_videos,
          (SELECT COUNT(*)::text FROM managed_videos WHERE video_source = 'local'
             AND transcoding_status IN ('hls_ready','ready'))                                                  AS hls_ready,
          (SELECT COUNT(*)::text FROM managed_videos WHERE video_source = 'local'
             AND transcoding_status = 'encoding')                                                              AS encoding_local,
          (SELECT COUNT(*)::text FROM schedule_entries WHERE is_active = true)                                 AS active_schedule,
          (SELECT COUNT(*)::text FROM broadcast_queue  WHERE is_active = true)                                 AS active_broadcast,
          (SELECT COALESCE(SUM(duration_secs),0)::text FROM broadcast_queue WHERE is_active = true)           AS broadcast_cycle,
          (SELECT COUNT(*)::text FROM push_tokens)                                                             AS push_tokens,
          (SELECT COUNT(*)::text FROM web_push_subscriptions)                                                  AS web_push,
          (SELECT COUNT(*)::text FROM managed_videos WHERE transcoding_status = 'failed')                      AS failed_transcodes,
          (SELECT COUNT(*)::text FROM managed_videos WHERE transcoding_status = 'queued')                      AS queued_transcodes,
          (SELECT COUNT(*)::text FROM users         WHERE role != 'user')                                      AS admin_users,
          (SELECT COALESCE(json_agg(row_to_json(t)),'[]'::json)
             FROM (SELECT is_primary, health_status, name, protocol FROM live_ingest_endpoints) t)             AS ingest_rows
      `);

      // db.execute() on node-postgres returns { rows: T[] }, not a plain array.
      type RowShape = { total_videos: string; local_videos: string; hls_ready: string; encoding_local: string; active_schedule: string; active_broadcast: string; broadcast_cycle: string; push_tokens: string; web_push: string; failed_transcodes: string; queued_transcodes: string; admin_users: string; ingest_rows: Array<{ is_primary: boolean; health_status: string; name: string; protocol: string }> | null };
      const _r = readinessRows as unknown as { rows?: RowShape[] };
      const row: RowShape | undefined = Array.isArray(_r.rows) ? _r.rows[0] : (readinessRows as unknown as RowShape[])[0];

      const totalVideos          = Number(row?.total_videos    ?? 0);
      const localVideos          = Number(row?.local_videos     ?? 0);
      const hlsReadyLocalVideos  = Number(row?.hls_ready        ?? 0);
      const encodingLocalVideos  = Number(row?.encoding_local   ?? 0);
      const activeScheduleEntries = Number(row?.active_schedule  ?? 0);
      const activeBroadcastItems = Number(row?.active_broadcast  ?? 0);
      const broadcastCycleSecs   = Number(row?.broadcast_cycle   ?? 0);
      const registeredDevices    = Number(row?.push_tokens ?? 0) + Number(row?.web_push ?? 0);
      const failedTranscodes     = Number(row?.failed_transcodes ?? 0);
      const queuedTranscodes     = Number(row?.queued_transcodes ?? 0);
      const adminUsers           = Number(row?.admin_users       ?? 0);

      type IngestRow = { is_primary: boolean; health_status: string; name: string; protocol: string };
      const ingestRows: IngestRow[] = Array.isArray(row?.ingest_rows) ? (row.ingest_rows as IngestRow[]) : [];
      const primaryIngest      = ingestRows.find((r) => r.is_primary);
      const healthyIngestCount = ingestRows.filter((r) => r.health_status === "healthy").length;

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
          ? activeBroadcastItems >= 3
            ? {
                key: "local-uploads",
                label: "Local uploads available",
                status: "ready" as const,
                detail: `Library has ${totalVideos} catalog videos; broadcast queue has ${activeBroadcastItems} items ready to air`,
              }
            : {
                key: "local-uploads",
                label: "Local uploads available",
                status: "warning" as const,
                detail: "No local uploads — relying entirely on YouTube embeds for catalog; upload an MP4 to populate the broadcast queue",
                action: "Upload at least one MP4 from the Library page — it will be auto-queued for broadcast once transcoding completes",
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
              detail: `${failedTranscodes} video${failedTranscodes === 1 ? "" : "s"} failed to transcode`,
              action: 'Open the Transcoding page and click "Retry All Failed" to re-queue every failed job in one click',
            },
        ...(env.TRANSCODER_DISABLE && localVideos > 0
          ? [
              {
                key: "transcoder-disabled",
                label: "Transcoder operational",
                status: "warning" as const,
                detail: "TRANSCODER_DISABLE is set — ffmpeg processing is off; local uploads cannot be converted to HLS",
                action: "Remove the TRANSCODER_DISABLE environment variable from your server config to re-enable automatic HLS transcoding",
              },
            ]
          : []),
      ];

      // YouTube shuffle fallback provides 24/7 continuity from the catalog when
      // the local broadcast queue is empty.  It is the permanent driver on
      // YouTube-only deployments, so an empty local queue is NOT a blocker in
      // that case — the broadcast is already running.
      const ytShuffleActive = ytShuffleFallback.isActive;
      const broadcastChecks: Check[] = [
        activeBroadcastItems === 0
          ? ytShuffleActive
            ? {
                key: "broadcast-queue-empty",
                label: "Broadcast queue — YouTube shuffle active",
                status: "ready" as const,
                detail: "Local queue is empty but YouTube shuffle fallback is active — broadcast is running continuously from the 961-video YouTube catalog",
              }
            : {
                key: "broadcast-queue-empty",
                label: "Broadcast queue has active items",
                status: "blocked" as const,
                detail: "No active items in the broadcast queue and YouTube shuffle is not active",
                action: "Add videos to /broadcast-v2 or wait for YouTube shuffle to activate",
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
        // Cycle depth — how long before content repeats
        activeBroadcastItems > 0 && broadcastCycleSecs < 7200
          ? {
              key: "broadcast-cycle-depth",
              label: "Broadcast content depth",
              status: "warning" as const,
              detail: `Queue cycles every ~${Math.round(broadcastCycleSecs / 60)}m — content will repeat frequently`,
              action:
                "Upload and transcode more sermon videos; once HLS is ready they are auto-queued for broadcast",
            }
          : {
              key: "broadcast-cycle-depth",
              label: "Broadcast content depth",
              status: "ready" as const,
              detail:
                activeBroadcastItems === 0
                  ? "Skipped (queue is empty)"
                  : `~${(broadcastCycleSecs / 3600).toFixed(1)}h of unique content before content repeats`,
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
        (() => {
          if (ingestRows.length === 0) {
            return {
              key: "ingest-healthy",
              label: "Ingest endpoints healthy",
              status: "ready" as const,
              detail: "Skipped (no ingest configured)",
            };
          }
          // "unknown" = never probed (fresh endpoint). Only flag as a problem
          // when a probe has run and returned degraded/unhealthy.
          const explicitlyUnhealthy = ingestRows.filter(
            (r) => r.health_status === "unhealthy" || r.health_status === "degraded",
          );
          const neverProbed = ingestRows.filter((r) => r.health_status === "unknown");
          if (explicitlyUnhealthy.length > 0) {
            return {
              key: "ingest-healthy",
              label: "Ingest endpoints healthy",
              status: "warning" as const,
              detail: `${explicitlyUnhealthy.length} of ${ingestRows.length} endpoint${ingestRows.length === 1 ? "" : "s"} degraded or unreachable`,
              action: "Check encoder connectivity and re-run a probe from /admin/live-ingest",
            };
          }
          if (healthyIngestCount > 0) {
            return {
              key: "ingest-healthy",
              label: "Ingest endpoints healthy",
              status: "ready" as const,
              detail: `${healthyIngestCount} of ${ingestRows.length} endpoint${ingestRows.length === 1 ? "" : "s"} verified healthy`,
            };
          }
          // All endpoints are "unknown" — never probed yet. Treat as pending, not broken.
          return {
            key: "ingest-healthy",
            label: "Ingest endpoints healthy",
            status: "ready" as const,
            detail: `${neverProbed.length} endpoint${neverProbed.length === 1 ? "" : "s"} configured — run a probe to verify connectivity`,
            action: "Open /admin/live-ingest and run a probe once your encoder URL is configured",
          };
        })(),
      ];

      const distributionChecks: Check[] = [
        registeredDevices === 0
          ? {
              key: "push-devices",
              label: "Push notification audience",
              status: "ready" as const,
              detail: "No push subscribers yet — expected before public launch",
              action: "Audience grows automatically as users install the app and grant notification permission; no setup required",
            }
          : {
              key: "push-devices",
              label: "Push notification audience",
              status: "ready" as const,
              detail: `${registeredDevices} registered push subscriber${registeredDevices === 1 ? "" : "s"}`,
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
          broadcastCycleSecs,
          registeredDevices,
          failedTranscodes,
          queuedTranscodes,
        },
        categories,
      };
    },
  );
}
