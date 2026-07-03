/**
 * Queue Self-Healing Worker
 *
 * State-machine-driven automated repair for broadcast queue items.
 *
 * Scan cycle (every 2 min, registered in index.ts):
 *   1. Load all active queue items + their health rows.
 *   2. Detect newly-unhealthy items (gap2/gap3 confidence) → quarantine.
 *   3. Detect recovered items (bad-URL cache cleared) → promote to healthy.
 *   4. For quarantined items due for retry → attempt repair sequence.
 *   5. Repair outcomes:
 *        success  → "approved" (orchestrator reload triggered)
 *        failure  → "quarantined" with back-off | "blocked" after MAX_ATTEMPTS
 *   6. Prune orphaned health rows.
 *
 * Repair sequence (applied in order until one succeeds):
 *   R1. Clear bad-URL cache entry + re-probe reachability (transient network error)
 *   R2. If source hash changed (re-upload detected) → fresh clearBadUrl + reprobe
 *   R3. Clear bad-URL confidence source-set + force orchestrator reload
 *   → All strategies failed → record failure, reschedule
 *
 * Auto-suggests a human fix when the item is blocked:
 *   "NO_PLAYABLE_URL" / "ALL_SOURCES_BAD" → "Re-upload video or check CDN"
 *   "MISSING_VIDEO_JOIN"                   → "Re-upload video"
 *   "SUSPICIOUS_DURATION"                  → "Re-probe duration from admin panel"
 *   default                                → "Review source URL"
 */
import { eq, and, sql } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { broadcastOrchestrator } from "./broadcast-orchestrator.js";
import { assetHealthRepo } from "../repository/asset-health.repo.js";
import {
  isKnownBadUrl,
  clearBadUrl,
  getUrlConfidenceState,
  clearSourceApproval,
  normalizeQueueUrl,
} from "../repository/queue.repo.js";
import { env } from "../../../config/env.js";

const LOG_TAG = "[queue-self-healing]";

// ── Repair suggestion map ─────────────────────────────────────────────────────

function buildSuggestedFix(errorCode: string | null): string {
  switch (errorCode) {
    case "MISSING_VIDEO_JOIN":
    case "ORPHANED_VIDEO_REF":
      return "Re-upload the video — the original file reference is missing";
    case "SUSPICIOUS_DURATION":
      return "Use admin panel Reprobe Duration to correct the item duration";
    case "NO_PLAYABLE_URL":
    case "ALL_SOURCES_BAD":
      return "Re-upload video or check that the CDN/hosting URL is reachable";
    case "OPERATOR_QUARANTINE":
      return "Investigate the source reported by the operator, then approve";
    default:
      return "Review the source URL and re-upload if needed";
  }
}

// ── Source reachability probe (lightweight HTTP HEAD + content-hash) ──────────

/**
 * Convert an own-origin upload URL to http://127.0.0.1:PORT/… for local
 * probing, mirroring media-integrity-scanner.ts toLocalhostProbeUrl().
 *
 * Why: normalizeQueueUrl() absolutises relative /api/v1/uploads/… paths to
 * https://<REPLIT_DEV_DOMAIN>/api/v1/uploads/… in production. Probing that
 * external URL traverses Replit's proxy and can time out, falsely marking a
 * healthy BYTEA blob as unreachable. Loopback probes are immune to proxy
 * hiccups and are always routed directly to the API process.
 */
function toLocalhostProbeUrl(url: string): string {
  try {
    const u = new URL(url);
    const ownHostnames = [
      env.API_ORIGIN,
      process.env["RENDER_EXTERNAL_URL"],
      process.env["DEV_DOMAIN"],
      process.env["REPLIT_DEV_DOMAIN"],
    ]
      .filter(Boolean)
      .map((h) => {
        try {
          return new URL(/^https?:\/\//i.test(h!) ? h! : `https://${h!}`).hostname;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as string[];

    if (ownHostnames.includes(u.hostname) && /\/api(?:\/v1)?\/uploads?\//.test(u.pathname)) {
      u.protocol = "http:";
      u.hostname = "127.0.0.1";
      u.port = String(env.PORT ?? 8080);
      return u.toString();
    }
  } catch {
    /* malformed URL — return as-is */
  }
  return url;
}

interface ProbeResult {
  reachable: boolean;
  contentHash: string | null;
  statusCode?: number;
}

/**
 * Probe a URL for HTTP reachability using HEAD first, falling back to a
 * ranged GET on 405 Method Not Allowed (some CDNs and BYTEA upload handlers
 * block HEAD while serving GET normally).
 *
 * Accepts 200, 206 (partial content OK), and 416 (Range Not Satisfiable —
 * server rejected our Range header but the file exists) as reachable.
 *
 * Always rewrites own-origin upload URLs to loopback before probing so
 * BYTEA blobs in PostgreSQL are never falsely condemned by proxy timeouts.
 */
async function probeSource(rawUrl: string): Promise<ProbeResult> {
  const url = toLocalhostProbeUrl(rawUrl);
  const headers: Record<string, string> = {
    "User-Agent": "TempleTV-HealthProbe/1.0",
    Range: "bytes=0-0",
  };
  if (env.INTERNAL_HLS_BYPASS_SECRET) {
    headers["x-internal-token"] = env.INTERNAL_HLS_BYPASS_SECRET;
  }

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    let res: Response;
    try {
      res = await fetch(url, { method: "HEAD", signal: ctrl.signal, headers });
    } finally {
      clearTimeout(t);
    }

    const etag = res.headers.get("etag") ?? null;
    const lastMod = res.headers.get("last-modified") ?? null;
    const contentHash = etag ?? lastMod ?? null;

    // HEAD not supported — fall back to a small ranged GET so HEAD-hostile
    // origins (including some BYTEA upload configurations) aren't falsely
    // marked unreachable.
    if (res.status === 405) {
      const getCtrl = new AbortController();
      const getT = setTimeout(() => getCtrl.abort(), 10_000);
      try {
        const getRes = await fetch(url, {
          method: "GET",
          signal: getCtrl.signal,
          headers: { ...headers, Range: "bytes=0-1023" },
        });
        clearTimeout(getT);
        await getRes.body?.cancel().catch(() => {});
        const ok = getRes.status === 200 || getRes.status === 206 || getRes.status === 416;
        return { reachable: ok, contentHash, statusCode: getRes.status };
      } catch {
        clearTimeout(getT);
        return { reachable: false, contentHash: null, statusCode: 405 };
      }
    }

    const ok = res.status === 200 || res.status === 206 || res.status === 416;
    return { reachable: ok, contentHash, statusCode: res.status };
  } catch {
    return { reachable: false, contentHash: null };
  }
}

// ── Resolve the best playable URL for a queue item ────────────────────────────

/**
 * Return the normalised absolute URL for a queue item's playable source.
 *
 * normalizeQueueUrl() converts relative /api/v1/uploads/… paths to absolute
 * HTTPS URLs using the same origin-resolution order as the orchestrator so
 * the returned key matches what the bad-URL cache stores. Without this
 * normalization, cache lookups (getUrlConfidenceState / isKnownBadUrl) always
 * return "healthy" for items whose localVideoUrl is still a relative path,
 * and Node.js fetch() would throw on a non-absolute URL.
 */
function resolveItemUrl(item: {
  localVideoUrl: string | null;
  videoSource: string;
}): string | null {
  if (item.localVideoUrl) return normalizeQueueUrl(item.localVideoUrl);
  return null;
}

// ── Main worker ───────────────────────────────────────────────────────────────

let lastScanMs = 0;
let scanRunning = false;

interface ScanResult {
  scanned: number;
  quarantined: number;
  repaired: number;
  blocked: number;
  recovered: number;
  orphansPruned: number;
  durationMs: number;
}

export const queueSelfHealingWorker = {
  async scan(): Promise<ScanResult> {
    if (scanRunning) {
      logger.debug(`${LOG_TAG} scan already running — skipping`);
      return { scanned: 0, quarantined: 0, repaired: 0, blocked: 0, recovered: 0, orphansPruned: 0, durationMs: 0 };
    }
    scanRunning = true;
    const startMs = Date.now();
    const result: ScanResult = { scanned: 0, quarantined: 0, repaired: 0, blocked: 0, recovered: 0, orphansPruned: 0, durationMs: 0 };

    try {
      // ── 0a. Recover stuck-repairing items (process-restart safety net) ───
      // Items left in "repairing" state for > 5 min after a process restart
      // would otherwise never transition again. Reset them to quarantined so
      // they re-enter the normal repair cycle.
      const STUCK_REPAIRING_THRESHOLD_MS = 5 * 60_000;
      const stuckItems = await assetHealthRepo.listStuckRepairing(STUCK_REPAIRING_THRESHOLD_MS);
      for (const stuck of stuckItems) {
        // Increment repairAttempts even on stuck-repairing reset so repeated
        // process crashes mid-repair count toward MAX_REPAIR_ATTEMPTS and the
        // item eventually transitions to "blocked" instead of spinning forever.
        const newAttempts = stuck.repairAttempts + 1;
        const maxAttempts = 5;
        const shouldBlock = newAttempts >= maxAttempts;
        await db
          .update(schema.queueAssetHealthTable)
          .set({
            state: shouldBlock ? "blocked" : "quarantined",
            repairAttempts: newAttempts,
            nextRetryAt: shouldBlock ? null : new Date(),
            repairLog: sql`(
              repair_log || jsonb_build_object(
                'ts', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'actor', 'system',
                'action', 'stuck_repairing_recovered',
                'detail', ${shouldBlock
                  ? `Item stuck in repairing state ${newAttempts} times — permanently blocked`
                  : `Item was stuck in repairing state after process restart — resetting to quarantined (attempt ${newAttempts}/${maxAttempts})`},
                'outcome', ${shouldBlock ? "blocked" : "pending"}
              )
            )`,
            updatedAt: new Date(),
          })
          .where(eq(schema.queueAssetHealthTable.queueItemId, stuck.queueItemId));
        if (shouldBlock) {
          logger.warn(
            { itemId: stuck.queueItemId, attempts: newAttempts },
            `${LOG_TAG} stuck-repairing item permanently blocked after ${newAttempts} crash-recovery cycles`,
          );
          adminEventBus.push("ops-alert", {
            level: "warn",
            title: "Queue Item Permanently Blocked",
            message: `Queue item ${stuck.queueItemId} was stuck in repairing state ${newAttempts} times and has been permanently blocked. Manual review required.`,
            timestamp: new Date().toISOString(),
            source: "queue-self-healing",
            queueItemId: stuck.queueItemId,
          });
        } else {
          logger.info({ itemId: stuck.queueItemId, attempts: newAttempts }, `${LOG_TAG} recovered stuck-repairing item`);
        }
      }

      // ── 0b. Auto-clear blocked items past 4h TTL ─────────────────────────
      // Blocked items that have been blocked for > 4 hours automatically
      // re-enter the repair cycle. This ensures 24/7 unattended operation
      // — a CDN outage that blocked items overnight will self-recover without
      // requiring operator intervention.
      const BLOCKED_ITEM_TTL_MS = 4 * 60 * 60_000; // 4 hours
      const autoUnblocked = await assetHealthRepo.clearExpiredBlocked(BLOCKED_ITEM_TTL_MS);
      if (autoUnblocked > 0) {
        logger.info({ count: autoUnblocked }, `${LOG_TAG} auto-unblocked ${autoUnblocked} item(s) past 4h TTL`);
        adminEventBus.push("ops-alert", {
          level: "info",
          title: "Blocked Items Auto-Cleared",
          message: `${autoUnblocked} queue item${autoUnblocked !== 1 ? "s" : ""} automatically re-entered repair cycle after 4-hour block TTL.`,
          timestamp: new Date().toISOString(),
          source: "queue-self-healing",
        });
      }

      // ── 1. Load active queue items ───────────────────────────────────────
      const activeItems = await db
        .select({
          id: schema.broadcastQueueTable.id,
          videoId: schema.broadcastQueueTable.videoId,
          title: schema.broadcastQueueTable.title,
          localVideoUrl: schema.broadcastQueueTable.localVideoUrl,
          videoSource: schema.broadcastQueueTable.videoSource,
        })
        .from(schema.broadcastQueueTable)
        .where(eq(schema.broadcastQueueTable.isActive, true))
        .limit(200);

      result.scanned = activeItems.length;

      if (activeItems.length === 0) {
        logger.debug(`${LOG_TAG} no active items — skipping scan`);
        return result;
      }

      // ── 2. Ensure health rows exist for all active items ─────────────────
      await assetHealthRepo.ensureRowsForItems(
        activeItems.map((i) => ({ id: i.id, videoId: i.videoId })),
      );

      // ── 3. Detect newly-unhealthy and recovered items ────────────────────
      for (const item of activeItems) {
        const url = resolveItemUrl(item);
        if (!url) {
          // No playable URL — quarantine unless it's a YouTube item
          if (item.videoSource === "youtube") continue;
          const healthRow = await assetHealthRepo.getByQueueItemId(item.id);
          if (!healthRow || healthRow.state === "healthy" || healthRow.state === "approved") {
            await assetHealthRepo.markQuarantined(item.id, {
              errorCode: "NO_PLAYABLE_URL",
              error: `Queue item "${item.title}" has no playable URL (no localVideoUrl)`,
              suggestedFix: buildSuggestedFix("NO_PLAYABLE_URL"),
            });
            result.quarantined++;
          }
          continue;
        }

        const confidence = getUrlConfidenceState(url);
        const isBad = isKnownBadUrl(url);

        const healthRow = await assetHealthRepo.getByQueueItemId(item.id);
        const currentState = healthRow?.state ?? "healthy";

        if ((confidence === "gap2" || confidence === "gap3") && !isBad) {
          // Confidence gap detected but not yet hard-blocked — mark quarantined
          if (currentState === "healthy" || currentState === "approved") {
            await assetHealthRepo.markQuarantined(item.id, {
              errorCode: `URL_CONFIDENCE_${confidence.toUpperCase()}`,
              error: `URL confidence degraded to ${confidence} — ${2 + (confidence === "gap3" ? 1 : 0)} sources reported unreachable`,
              suggestedFix: buildSuggestedFix("NO_PLAYABLE_URL"),
            });
            result.quarantined++;
          }
        } else if (isBad) {
          // Hard-blocked in bad-URL cache
          if (currentState === "healthy" || currentState === "approved") {
            await assetHealthRepo.markQuarantined(item.id, {
              errorCode: "ALL_SOURCES_BAD",
              error: `Source URL is in bad-URL cache — all ${confidence === "gap3" ? "3" : "2"} confirmation sources reported unreachable`,
              suggestedFix: buildSuggestedFix("ALL_SOURCES_BAD"),
            });
            result.quarantined++;
          }
        } else if ((currentState === "quarantined" || currentState === "repairing") && !isBad && confidence === "healthy") {
          // Source has recovered naturally (bad-URL cache expired or was cleared)
          await assetHealthRepo.markHealthy(item.id, {
            actor: "system",
            detail: "Source recovered — no longer in bad-URL cache",
          });
          result.recovered++;
          logger.info({ itemId: item.id, title: item.title }, `${LOG_TAG} item recovered naturally`);
        }
      }

      // ── 4. Attempt repair for quarantined items due for retry ────────────
      const dueItems = await assetHealthRepo.listDueForRepair();

      for (const healthRow of dueItems) {
        const queueItem = activeItems.find((i) => i.id === healthRow.queueItemId);
        if (!queueItem) continue;

        const url = resolveItemUrl(queueItem);
        if (!url) {
          // No URL — can't repair automatically, increment count toward blocked
          await assetHealthRepo.markRepairing(healthRow.queueItemId);
          await assetHealthRepo.recordRepairOutcome(
            healthRow.queueItemId,
            "failure",
            "No playable URL available — manual re-upload required",
          );
          if (healthRow.repairAttempts + 1 >= assetHealthRepo.MAX_REPAIR_ATTEMPTS) {
            result.blocked++;
          }
          continue;
        }

        // ── Terminal video error code short-circuit ───────────────────────
        // CORRUPT_SOURCE / SOURCE_MISSING blobs are broken or deleted — HEAD
        // probing returns 200 (corrupt content passes but fails playback) or
        // 404 (blob gone). Neither is fixable by URL probing. Skip R1/R2/R3
        // and burn one repair attempt so the item progresses toward "blocked"
        // without wasting 3 cycles × 4 h of fruitless retries.
        // ASSEMBLY_FAILED normally never reaches this path (isPlayableForBroadcast
        // rejects it), but we guard it here for safety.
        if (queueItem.videoId) {
          try {
            const [videoRow] = await db
              .select({ transcodingErrorCode: schema.videosTable.transcodingErrorCode })
              .from(schema.videosTable)
              .where(eq(schema.videosTable.id, queueItem.videoId))
              .limit(1);
            const errCode = videoRow?.transcodingErrorCode;
            const TERMINAL_CODES = ["ASSEMBLY_FAILED", "CORRUPT_SOURCE", "SOURCE_MISSING"] as const;
            if (errCode && (TERMINAL_CODES as ReadonlyArray<string>).includes(errCode)) {
              await assetHealthRepo.markRepairing(healthRow.queueItemId);
              const updatedRow = await assetHealthRepo.recordRepairOutcome(
                healthRow.queueItemId,
                "failure",
                `Terminal video error '${errCode}' — re-upload required, URL probing cannot recover this`,
              );
              if (updatedRow.state === "blocked") {
                result.blocked++;
                logger.warn(
                  { itemId: healthRow.queueItemId, title: queueItem.title, errCode },
                  `${LOG_TAG} item permanently blocked — terminal video error code (${errCode})`,
                );
                adminEventBus.push("ops-alert", {
                  level: "warning",
                  title: "Broadcast Item Blocked (Terminal Error)",
                  message: `Queue item "${queueItem.title}" blocked — terminal video error (${errCode}). Re-upload to restore.`,
                  timestamp: new Date().toISOString(),
                  source: "queue-self-healing",
                  queueItemId: healthRow.queueItemId,
                });
              } else {
                logger.info(
                  { itemId: healthRow.queueItemId, title: queueItem.title, errCode, attempts: updatedRow.repairAttempts },
                  `${LOG_TAG} terminal error code (${errCode}) — skipping URL probe, counting toward block`,
                );
              }
              continue;
            }
          } catch (terminalCheckErr) {
            logger.warn(
              { err: terminalCheckErr, itemId: healthRow.queueItemId },
              `${LOG_TAG} terminal error code check failed (non-fatal — proceeding with normal repair)`,
            );
          }
        }

        logger.info(
          { itemId: healthRow.queueItemId, title: queueItem.title, attempt: healthRow.repairAttempts + 1 },
          `${LOG_TAG} attempting repair`,
        );

        await assetHealthRepo.markRepairing(healthRow.queueItemId);

        // ── Repair Strategy R1: Clear bad-URL cache + reprobe ────────────
        let repaired = false;

        // Clear any stale bad-URL entries for this URL
        clearBadUrl(url);
        clearSourceApproval(healthRow.queueItemId);

        // Wait briefly for cache to settle, then probe
        await new Promise((r) => setTimeout(r, 500));

        const probeResult = await probeSource(url);

        if (probeResult.reachable) {
          // ── R1 success ────────────────────────────────────────────────
          const detail = `URL is reachable (HTTP ${probeResult.statusCode ?? "2xx"}) after cache clear`;
          await assetHealthRepo.recordRepairOutcome(healthRow.queueItemId, "success", detail);

          // Update source hash if we got a new one
          if (probeResult.contentHash && probeResult.contentHash !== healthRow.sourceHash) {
            await db
              .update(schema.queueAssetHealthTable)
              .set({ sourceHash: probeResult.contentHash, updatedAt: new Date() })
              .where(eq(schema.queueAssetHealthTable.queueItemId, healthRow.queueItemId));
          }

          repaired = true;
          result.repaired++;

          // Trigger orchestrator reload so the item re-enters rotation
          adminEventBus.push("broadcast-queue-updated", {
            reason: "self-heal-repair-success",
            queueItemId: healthRow.queueItemId,
          });

          logger.info(
            { itemId: healthRow.queueItemId, title: queueItem.title, statusCode: probeResult.statusCode },
            `${LOG_TAG} repair success — URL is reachable`,
          );
        }

        if (!repaired) {
          // ── R2: Check if content hash changed (new upload) ───────────
          if (probeResult.contentHash && healthRow.sourceHash && probeResult.contentHash !== healthRow.sourceHash) {
            // Content changed — reset the repair cycle for the new content
            clearBadUrl(url);
            const reprobe = await probeSource(url);
            if (reprobe.reachable) {
              await assetHealthRepo.recordRepairOutcome(
                healthRow.queueItemId,
                "success",
                `Content hash changed (${healthRow.sourceHash?.slice(0, 8)} → ${reprobe.contentHash?.slice(0, 8) ?? "new"}) — new upload detected and verified`,
              );
              repaired = true;
              result.repaired++;

              adminEventBus.push("broadcast-queue-updated", {
                reason: "self-heal-new-content-detected",
                queueItemId: healthRow.queueItemId,
              });

              logger.info(
                { itemId: healthRow.queueItemId, title: queueItem.title },
                `${LOG_TAG} repair success — new content detected`,
              );
            }
          }
        }

        if (!repaired) {
          // ── R3: Force orchestrator reload and mark failure ────────────
          // Reload pulls fresh data; if the item has been fixed at the DB level
          // (e.g., re-upload updated localVideoUrl), the orchestrator may admit it
          void broadcastOrchestrator.reload().catch(() => {});

          const updatedRow = await assetHealthRepo.recordRepairOutcome(
            healthRow.queueItemId,
            "failure",
            `Source unreachable (HTTP ${probeResult.statusCode ?? "no response"}) — ${url.slice(0, 80)}`,
          );

          if (updatedRow.state === "blocked") {
            result.blocked++;
            logger.warn(
              { itemId: healthRow.queueItemId, title: queueItem.title, attempts: updatedRow.repairAttempts },
              `${LOG_TAG} item blocked after ${updatedRow.repairAttempts} failed repair attempts`,
            );
            adminEventBus.push("ops-alert", {
              level: "warning",
              title: "Broadcast Item Blocked",
              message: `Queue item "${queueItem.title}" is blocked after ${updatedRow.repairAttempts} failed repair attempts. Manual intervention required.`,
              detail: `Error: ${healthRow.lastError ?? "Source unreachable"}. Suggested fix: ${buildSuggestedFix(healthRow.lastErrorCode)}`,
              timestamp: new Date().toISOString(),
              source: "queue-self-healing",
              queueItemId: healthRow.queueItemId,
            });
          } else {
            logger.info(
              { itemId: healthRow.queueItemId, title: queueItem.title, nextRetryAt: updatedRow.nextRetryAt },
              `${LOG_TAG} repair failed — rescheduled`,
            );
          }
        }
      }

      // ── 5. Prune orphaned health rows ────────────────────────────────────
      const pruned = await assetHealthRepo.pruneOrphans();
      result.orphansPruned = pruned;

    } catch (err) {
      logger.error({ err }, `${LOG_TAG} scan failed`);
      throw err;
    } finally {
      scanRunning = false;
      lastScanMs = Date.now();
      result.durationMs = Date.now() - startMs;
    }

    if (result.quarantined > 0 || result.repaired > 0 || result.blocked > 0 || result.recovered > 0) {
      logger.info(result, `${LOG_TAG} scan complete`);
    } else {
      logger.debug(result, `${LOG_TAG} scan complete (no changes)`);
    }

    // Push SSE event so the admin panel refreshes immediately instead of
    // waiting for the 60 s polling interval. Only push when state may have
    // changed (avoids noisy no-op events during quiet periods).
    const hasChanges = result.quarantined > 0 || result.repaired > 0 ||
      result.blocked > 0 || result.recovered > 0 || result.orphansPruned > 0;
    adminEventBus.push("asset-health-updated", {
      scanned: result.scanned,
      quarantined: result.quarantined,
      repaired: result.repaired,
      blocked: result.blocked,
      recovered: result.recovered,
      orphansPruned: result.orphansPruned,
      durationMs: result.durationMs,
      hasChanges,
      ts: new Date().toISOString(),
    });

    return result;
  },

  getLastScanMs(): number {
    return lastScanMs;
  },

  isRunning(): boolean {
    return scanRunning;
  },
};
