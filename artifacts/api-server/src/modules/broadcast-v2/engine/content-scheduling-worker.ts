/**
 * Content Scheduling Worker
 *
 * Runs every 60 seconds. Checks managed_videos for rows with:
 *   • scheduled_publish_at   <= NOW() AND broadcast_only = true   → publishes (broadcastOnly=false)
 *   • scheduled_unpublish_at <= NOW() AND broadcast_only = false  → unpublishes (broadcastOnly=true)
 *
 * After acting, clears the corresponding scheduled_* timestamp so the
 * trigger only fires once. Logs each action to media_audit_log for the
 * audit trail.
 *
 * Uses workerSupervisor for circuit-breaker, deadman-switch, and metrics.
 * A sustained DB outage trips the circuit after 10 consecutive failures and
 * suppresses alerts until the auto-reset window passes. This prevents log
 * flooding and false-positive ops-alerts during brief DB unavailability.
 */

import { and, isNotNull, lte, eq } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { invalidateVideosCatalogCache } from "../../videos/videos.routes.js";
import { workerSupervisor } from "./worker-supervisor.js";
import { logger as rootLogger } from "../../../infrastructure/logger.js";
import { randomUUID } from "node:crypto";

const logger = rootLogger.child({ module: "content-scheduling" });

const WORKER_NAME  = "content-scheduling";
const INTERVAL_MS  = parseInt(process.env.CONTENT_SCHEDULING_INTERVAL_MS ?? "60000", 10);
const INITIAL_DELAY = 15_000;

async function runSchedulingSweep(): Promise<void> {
  const now = new Date();

  // ── Auto-publish ────────────────────────────────────────────────────────────
  const toPublish = await db
    .select({ id: schema.videosTable.id, title: schema.videosTable.title })
    .from(schema.videosTable)
    .where(
      and(
        isNotNull(schema.videosTable.scheduledPublishAt),
        lte(schema.videosTable.scheduledPublishAt, now),
        eq(schema.videosTable.broadcastOnly, true),
      ),
    )
    .limit(50)
    .catch((err: unknown) => {
      // scheduled_publish_at column may not exist on pre-migration DBs
      const msg = String(err);
      if (msg.includes("does not exist") || msg.includes("42703")) return [];
      throw err;
    });

  for (const v of toPublish) {
    try {
      await db
        .update(schema.videosTable)
        .set({ broadcastOnly: false, scheduledPublishAt: null })
        .where(eq(schema.videosTable.id, v.id));

      await db.insert(schema.mediaAuditLogTable).values({
        id: randomUUID(),
        videoId: v.id,
        action: "scheduled_publish",
        reason: `Auto-published at scheduled time`,
        triggeredBy: WORKER_NAME,
      }).catch((auditErr: unknown) => {
        logger.warn({ videoId: v.id, err: auditErr }, "[content-scheduling] audit log insert failed (non-fatal)");
      });

      logger.info({ videoId: v.id, title: v.title }, "[content-scheduling] auto-published video");
      adminEventBus.push("videos-library-updated", { videoId: v.id, reason: "scheduled-publish" });
    } catch (err) {
      logger.warn({ videoId: v.id, err }, "[content-scheduling] failed to publish video");
    }
  }

  // ── Auto-unpublish ──────────────────────────────────────────────────────────
  const toUnpublish = await db
    .select({ id: schema.videosTable.id, title: schema.videosTable.title })
    .from(schema.videosTable)
    .where(
      and(
        isNotNull(schema.videosTable.scheduledUnpublishAt),
        lte(schema.videosTable.scheduledUnpublishAt, now),
        eq(schema.videosTable.broadcastOnly, false),
      ),
    )
    .limit(50)
    .catch((err: unknown) => {
      const msg = String(err);
      if (msg.includes("does not exist") || msg.includes("42703")) return [];
      throw err;
    });

  for (const v of toUnpublish) {
    try {
      await db
        .update(schema.videosTable)
        .set({ broadcastOnly: true, scheduledUnpublishAt: null })
        .where(eq(schema.videosTable.id, v.id));

      await db.insert(schema.mediaAuditLogTable).values({
        id: randomUUID(),
        videoId: v.id,
        action: "scheduled_unpublish",
        reason: `Auto-unpublished at scheduled time`,
        triggeredBy: WORKER_NAME,
      }).catch((auditErr: unknown) => {
        logger.warn({ videoId: v.id, err: auditErr }, "[content-scheduling] audit log insert failed (non-fatal)");
      });

      logger.info({ videoId: v.id, title: v.title }, "[content-scheduling] auto-unpublished video");
      adminEventBus.push("videos-library-updated", { videoId: v.id, reason: "scheduled-unpublish" });
    } catch (err) {
      logger.warn({ videoId: v.id, err }, "[content-scheduling] failed to unpublish video");
    }
  }

  if (toPublish.length > 0 || toUnpublish.length > 0) {
    void invalidateVideosCatalogCache();
  }
}

export function startContentSchedulingWorker(): void {
  workerSupervisor.spawn({
    name:           WORKER_NAME,
    fn:             runSchedulingSweep,
    intervalMs:     INTERVAL_MS,
    initialDelayMs: INITIAL_DELAY,
    backoffMs:      [5_000, 15_000, 30_000, 60_000],
  });
  logger.info({ intervalMs: INTERVAL_MS }, "[content-scheduling] worker registered with supervisor");
}

export function stopContentSchedulingWorker(): void {
  workerSupervisor.remove(WORKER_NAME);
}
