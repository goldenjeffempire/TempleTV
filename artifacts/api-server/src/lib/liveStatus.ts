import { db, liveOverridesTable, pushTokensTable } from "@workspace/db";
import { count, desc, eq } from "drizzle-orm";
import { getLiveStatus, getLiveViewerCount } from "../routes/youtube";
import { getSSEClientCount } from "./liveEvents";

/**
 * Shared live-status helpers used by:
 *   - admin REST routes (manual Go Live / Stop / Extend)
 *   - the live-override scheduler (auto Go Live at scheduled time)
 *   - any other surface that needs the canonical "what's live right now"
 *     payload.
 *
 * Extracted from routes/admin.ts so the scheduler can emit the exact
 * same SSE payload the manual flow does — guarantees viewers see the
 * same shape regardless of how the override was started.
 */

export type LiveOverrideRow = typeof liveOverridesTable.$inferSelect;

/**
 * Returns the currently-active live override (if any), preferring the
 * most recently started one. Filters out rows whose `endsAt` has
 * passed — those should be auto-expired by `auto-expire` but we
 * defensively skip them here too.
 */
export async function getActiveLiveOverride(): Promise<LiveOverrideRow | null> {
  const overrides = await db
    .select()
    .from(liveOverridesTable)
    .where(eq(liveOverridesTable.isActive, true))
    .orderBy(desc(liveOverridesTable.startedAt));
  const now = new Date();
  return (
    overrides.find(
      (override: LiveOverrideRow) => !override.endsAt || override.endsAt > now,
    ) ?? null
  );
}

/**
 * Canonical "live status" payload for admin Mission Control surfaces.
 * Returned synchronously by `GET /api/admin/live` (admin-protected) and
 * pushed over the `/api/admin/live/events` SSE stream to all connected
 * admin clients whenever a state-changing event fires (admin override
 * start/stop/schedule, YouTube poller transition, scheduled override
 * boundary). Combines admin override state with the YouTube poller's
 * most recent observation so a single payload tells every admin
 * surface everything it needs to render. Not exposed to public
 * TV/mobile clients — those have their own dedicated read paths.
 */
export async function buildLiveStatusPayload() {
  const liveOverride = await getActiveLiveOverride().catch(() => null);
  const ytStatus = getLiveStatus();
  const [deviceCountResult] = await db
    .select({ count: count() })
    .from(pushTokensTable)
    .catch(() => [{ count: 0 }]);
  const deviceCount = Number(deviceCountResult?.count ?? 0);
  const now = Date.now();
  const concurrentViewers = getSSEClientCount();
  const ytLiveViewerCount = ytStatus.isLive ? getLiveViewerCount() : null;
  return {
    isLive: !!(liveOverride || ytStatus.isLive),
    ytLive: ytStatus.isLive,
    ytVideoId: ytStatus.videoId,
    ytTitle: ytStatus.title,
    ytViewerCount: ytLiveViewerCount,
    deviceCount,
    concurrentViewers,
    sseClients: concurrentViewers,
    liveOverride: liveOverride
      ? {
          id: liveOverride.id,
          title: liveOverride.title,
          startedAt: liveOverride.startedAt.toISOString(),
          endsAt: liveOverride.endsAt?.toISOString() ?? null,
          elapsedSecs: Math.floor(
            (now - liveOverride.startedAt.getTime()) / 1000,
          ),
          remainingSecs: liveOverride.endsAt
            ? Math.max(
                0,
                Math.floor((liveOverride.endsAt.getTime() - now) / 1000),
              )
            : null,
          hlsStreamUrl: liveOverride.hlsStreamUrl ?? null,
          youtubeVideoId: liveOverride.youtubeVideoId ?? null,
        }
      : null,
    ts: now,
  };
}
