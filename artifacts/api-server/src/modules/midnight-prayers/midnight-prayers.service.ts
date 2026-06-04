/**
 * Midnight Prayers Service
 *
 * Self-contained broadcast engine for the Midnight Prayers channel.
 * Automatically cycles through all videos with category = "midnight-prayers",
 * providing a V2Snapshot-compatible API so the existing player-core FSM works
 * without modifications.
 *
 * Key design decisions:
 * - No manual queue management: every playable midnight-prayers video is
 *   included automatically.  Admins just upload with the right category.
 * - Virtual cycle: startsAtMs is computed from a per-viewer epochMs (the
 *   viewer's local midnight) so playback is synchronised within each timezone.
 * - Config (startHour / endHour / timezone) is a singleton DB row; the server
 *   reloads it on PATCH; clients poll /config once per session.
 */

import { eq, and, or, isNotNull } from "drizzle-orm";
import { db, schema, ensureMidnightPrayersTable } from "../../infrastructure/db.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { logger } from "../../infrastructure/logger.js";

// ── Wire types (mirrors lib/player-core/src/types.ts) ────────────────────────

export interface MPV2Source {
  kind: "hls" | "mp4";
  url: string;
  expiresAtMs: number | null;
}

export interface MPV2Item {
  id: string;
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  durationSecs: number;
  source: MPV2Source;
  failoverSource: null;
  startsAtMs: number;
  endsAtMs: number;
}

export interface MPV2Snapshot {
  channelId: "midnight-prayers";
  sequence: number;
  serverTimeMs: number;
  mode: "queue" | "offline_hold";
  current: MPV2Item | null;
  next: MPV2Item | null;
  nextNext: MPV2Item | null;
  override: null;
  checkpoint: null;
  failover: { active: false; reason: null };
  meta: {
    totalVideos: number;
    totalDurationSecs: number;
    cycleLengthMs: number;
    epochMs: number;
  };
}

export type MPServerFrame =
  | { type: "hello"; serverTimeMs: number; sequence: number }
  | { type: "snapshot"; sequence: number; state: MPV2Snapshot }
  | { type: "heartbeat"; serverTimeMs: number; sequence: number }
  | { type: "error"; code: string; message: string };

// ── Internal video record ─────────────────────────────────────────────────────

interface MPVideo {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  durationSecs: number;
  localVideoUrl: string | null;
  hlsMasterUrl: string | null;
}

export interface MidnightPrayersConfigData {
  enabled: boolean;
  startHour: number;
  endHour: number;
  timezone: string;
  updatedAt: Date;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CHANNEL_ID = "midnight-prayers" as const;
const VIDEO_RELOAD_INTERVAL_MS = 5 * 60_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const ITEM_WATCH_INTERVAL_MS = 4_000;
const DEFAULT_DURATION_SECS = 1800;
const MIN_API_ORIGIN = process.env["API_ORIGIN"] ?? "";

// ── Timezone midnight helper ──────────────────────────────────────────────────

/**
 * Returns the Unix timestamp (ms) for 00:00:00 today in the given IANA
 * timezone, using Intl.DateTimeFormat formatToParts to extract local time
 * components without any third-party library.
 */
export function getTodayMidnightMs(tz: string): number {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    }).formatToParts(now);

    const get = (type: string) =>
      parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);

    const h = get("hour");   // 0-23  (or 24 for Intl midnight quirk)
    const m = get("minute");
    const s = get("second");

    // Elapsed milliseconds since local midnight in this timezone
    const elapsedMs = ((h % 24) * 3600 + m * 60 + s) * 1_000;
    return now.getTime() - elapsedMs;
  } catch {
    // Fallback to UTC midnight on unsupported timezone string
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }
}

/** Absolutise a server-relative path for the API origin. */
function absolutise(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (MIN_API_ORIGIN) return `${MIN_API_ORIGIN}${url}`;
  return url;
}

// ── Service class ─────────────────────────────────────────────────────────────

type FrameSink = (frame: MPServerFrame) => void;

class MidnightPrayersService {
  private videos: MPVideo[] = [];
  private config: MidnightPrayersConfigData = {
    enabled: true,
    startHour: 0,
    endHour: 3,
    timezone: "Africa/Lagos",
    updatedAt: new Date(),
  };

  private sequence = 0;
  private readonly sseSinks = new Set<FrameSink>();
  private readonly wsSinks  = new Set<FrameSink>();

  private videoReloadTimer:  ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer:    ReturnType<typeof setInterval> | null = null;
  private itemWatchTimer:    ReturnType<typeof setInterval> | null = null;
  private lastBroadcastedId: string | null = null;

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await this.loadConfig();
    await this.loadVideos();
    this.startTimers();

    adminEventBus.on("videos-library-updated", () => {
      void this.loadVideos();
    });

    logger.info("[midnight-prayers] service initialised — %d videos loaded", this.videos.length);
  }

  // ── Config ─────────────────────────────────────────────────────────────────

  getConfig(): MidnightPrayersConfigData {
    return { ...this.config };
  }

  async loadConfig(): Promise<void> {
    // Defense-in-depth: if the table is missing (42P01 — "relation does not
    // exist"), create it now and retry once.  The primary guarantee is that
    // ensureMidnightPrayersTable() runs in main.ts BEFORE buildApp(), but a
    // transient race or a missed startup call would otherwise leave the service
    // permanently broken for the lifetime of the process.
    const tryLoad = async (): Promise<boolean> => {
      try {
        const rows = await db
          .select()
          .from(schema.midnightPrayersConfig)
          .where(eq(schema.midnightPrayersConfig.id, 1))
          .limit(1);

        if (rows.length > 0) {
          const r = rows[0]!;
          this.config = {
            enabled: r.enabled,
            startHour: r.startHour,
            endHour: r.endHour,
            timezone: r.timezone,
            updatedAt: r.updatedAt,
          };
        } else {
          // Seed default row (table exists but is empty — very unlikely after
          // ensureMidnightPrayersTable(), but handle it anyway).
          await db
            .insert(schema.midnightPrayersConfig)
            .values({ id: 1 })
            .onConflictDoNothing();
        }
        return true;
      } catch (err) {
        // SQLSTATE 42P01 = "relation does not exist"
        const code = (err as { code?: string }).code;
        if (code === "42P01") {
          return false; // signal: table missing, caller should ensure+retry
        }
        logger.warn({ err }, "[midnight-prayers] failed to load config — using defaults");
        return true; // other errors: give up but don't retry
      }
    };

    const loaded = await tryLoad();
    if (!loaded) {
      // Table was missing — create it now and retry once.
      logger.warn(
        "[midnight-prayers] midnight_prayers_config table missing at loadConfig() time — " +
          "running ensureMidnightPrayersTable() as fallback (should have run at startup)",
      );
      try {
        await ensureMidnightPrayersTable();
      } catch (ensureErr) {
        logger.error({ err: ensureErr }, "[midnight-prayers] ensureMidnightPrayersTable fallback failed — using in-memory defaults");
        return;
      }
      await tryLoad(); // second attempt; errors are logged inside tryLoad()
    }
  }

  async saveConfig(patch: Partial<Pick<MidnightPrayersConfigData, "enabled" | "startHour" | "endHour" | "timezone">>): Promise<MidnightPrayersConfigData> {
    const now = new Date();
    // Keep the previous config so we can revert if the DB write fails.
    // Do NOT update this.config until the DB write has succeeded — a failed
    // upsert would otherwise leave the in-memory state ahead of persisted
    // state, causing clients to see changes that were never durably stored.
    const previousConfig = { ...this.config };
    const nextConfig = { ...this.config, ...patch, updatedAt: now };

    try {
      await db
        .insert(schema.midnightPrayersConfig)
        .values({
          id: 1,
          enabled: nextConfig.enabled,
          startHour: nextConfig.startHour,
          endHour: nextConfig.endHour,
          timezone: nextConfig.timezone,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.midnightPrayersConfig.id,
          set: {
            enabled: nextConfig.enabled,
            startHour: nextConfig.startHour,
            endHour: nextConfig.endHour,
            timezone: nextConfig.timezone,
            updatedAt: now,
          },
        });
    } catch (err) {
      // DB write failed — leave in-memory state unchanged so it stays
      // consistent with what is actually persisted.
      this.config = previousConfig;
      logger.error({ err }, "[midnight-prayers] saveConfig: DB write failed — reverting in-memory state");
      throw err;
    }

    // DB write succeeded — now safe to update in-memory state.
    this.config = nextConfig;

    // Broadcast config change as a snapshot so connected players know
    // the window has changed without a page reload.
    this.broadcastSnapshot(getTodayMidnightMs(this.config.timezone));
    return this.getConfig();
  }

  // ── Video queue ────────────────────────────────────────────────────────────

  async loadVideos(): Promise<void> {
    try {
      const rows = await db
        .select({
          id: schema.videosTable.id,
          title: schema.videosTable.title,
          thumbnailUrl: schema.videosTable.thumbnailUrl,
          duration: schema.videosTable.duration,
          localVideoUrl: schema.videosTable.localVideoUrl,
          hlsMasterUrl: schema.videosTable.hlsMasterUrl,
          faststartApplied: schema.videosTable.faststartApplied,
          transcodingStatus: schema.videosTable.transcodingStatus,
          videoSource: schema.videosTable.videoSource,
        })
        .from(schema.videosTable)
        .where(
          and(
            eq(schema.videosTable.category, CHANNEL_ID),
            // Exclude YouTube-sourced videos
            eq(schema.videosTable.videoSource, "local"),
            // Only playable videos: needs an HLS manifest or a faststart MP4
            or(
              isNotNull(schema.videosTable.hlsMasterUrl),
              and(
                isNotNull(schema.videosTable.localVideoUrl),
                eq(schema.videosTable.faststartApplied, true),
              ),
            ),
          ),
        )
        .orderBy(schema.videosTable.importedAt);

      this.videos = rows.map((r) => ({
        id: r.id,
        title: r.title ?? "",
        thumbnailUrl: r.thumbnailUrl ?? null,
        durationSecs: typeof r.duration === "string" && r.duration !== ""
          ? (parseInt(r.duration, 10) || DEFAULT_DURATION_SECS)
          : DEFAULT_DURATION_SECS,
        localVideoUrl: absolutise(r.localVideoUrl ?? null),
        hlsMasterUrl:  absolutise(r.hlsMasterUrl  ?? null),
      }));

      logger.debug("[midnight-prayers] queue refreshed — %d videos", this.videos.length);
    } catch (err) {
      logger.error({ err }, "[midnight-prayers] video load failed");
    }
  }

  getVideos(): MPVideo[] {
    return [...this.videos];
  }

  // ── Snapshot computation ───────────────────────────────────────────────────

  /**
   * Build a V2Snapshot-compatible object for the current moment in time.
   *
   * @param epochMs  The client's local midnight (ms since epoch).
   *                 Defaults to today's midnight in the server's configured
   *                 timezone so the cycle position is deterministic for
   *                 clients that don't supply their own epoch.
   */
  getSnapshot(epochMs?: number): MPV2Snapshot {
    const epoch = epochMs ?? getTodayMidnightMs(this.config.timezone);
    const now   = Date.now();

    if (this.videos.length === 0) {
      return {
        channelId: CHANNEL_ID,
        sequence: this.sequence,
        serverTimeMs: now,
        mode: "offline_hold",
        current: null,
        next: null,
        nextNext: null,
        override: null,
        checkpoint: null,
        failover: { active: false, reason: null },
        meta: {
          totalVideos: 0,
          totalDurationSecs: 0,
          cycleLengthMs: 0,
          epochMs: epoch,
        },
      };
    }

    const totalDurationMs = this.videos.reduce(
      (acc, v) => acc + v.durationSecs * 1_000,
      0,
    );

    // Position within the current cycle (wraps on repeat)
    const elapsed  = Math.max(0, now - epoch);
    const position = elapsed % totalDurationMs;

    // Find current item index
    let accumulated = 0;
    let currentIdx  = 0;
    for (let i = 0; i < this.videos.length; i++) {
      const d = this.videos[i]!.durationSecs * 1_000;
      if (position < accumulated + d) {
        currentIdx = i;
        break;
      }
      accumulated += d;
    }

    const buildItem = (idx: number): MPV2Item => {
      const v = this.videos[idx % this.videos.length]!;
      // How many full cycles have elapsed? Use that + accumulated offsets for
      // absolute startsAtMs so the player can seek to the right position.
      const cycleNumber = Math.floor(elapsed / totalDurationMs);
      let offset = epoch + cycleNumber * totalDurationMs;
      // For items after the current one in a future cycle, advance by one more
      if (idx >= this.videos.length) {
        offset += totalDurationMs;
      }
      const realIdx = idx % this.videos.length;
      // Accumulated offset within the cycle for this item
      let cycleOffset = 0;
      for (let i = 0; i < realIdx; i++) {
        cycleOffset += this.videos[i]!.durationSecs * 1_000;
      }
      const startsAtMs = offset + cycleOffset;
      return {
        id: v.id,
        videoId: v.id,
        title: v.title,
        thumbnailUrl: v.thumbnailUrl,
        durationSecs: v.durationSecs,
        source: {
          kind: v.hlsMasterUrl ? "hls" : "mp4",
          url: (v.hlsMasterUrl ?? v.localVideoUrl)!,
          expiresAtMs: null,
        },
        failoverSource: null,
        startsAtMs,
        endsAtMs: startsAtMs + v.durationSecs * 1_000,
      };
    };

    return {
      channelId: CHANNEL_ID,
      sequence: this.sequence,
      serverTimeMs: now,
      mode: "queue",
      current: buildItem(currentIdx),
      next: buildItem(currentIdx + 1),
      nextNext: buildItem(currentIdx + 2),
      override: null,
      checkpoint: null,
      failover: { active: false, reason: null },
      meta: {
        totalVideos: this.videos.length,
        totalDurationSecs: Math.round(totalDurationMs / 1_000),
        cycleLengthMs: totalDurationMs,
        epochMs: epoch,
      },
    };
  }

  // ── SSE / WS subscription management ──────────────────────────────────────

  subscribeSSE(sink: FrameSink): () => void {
    this.sseSinks.add(sink);
    return () => this.sseSinks.delete(sink);
  }

  subscribeWS(sink: FrameSink): () => void {
    this.wsSinks.add(sink);
    return () => this.wsSinks.delete(sink);
  }

  // ── Internal broadcast helpers ─────────────────────────────────────────────

  private broadcastToAll(frame: MPServerFrame): void {
    for (const s of this.sseSinks) {
      try { s(frame); } catch { this.sseSinks.delete(s); }
    }
    for (const s of this.wsSinks) {
      try { s(frame); } catch { this.wsSinks.delete(s); }
    }
  }

  private broadcastSnapshot(epochMs?: number): void {
    this.sequence++;
    const snapshot = this.getSnapshot(epochMs);
    snapshot.sequence = this.sequence;
    this.broadcastToAll({ type: "snapshot", sequence: this.sequence, state: snapshot });
  }

  // ── Timer loops ───────────────────────────────────────────────────────────

  private startTimers(): void {
    // Periodic video list refresh
    this.videoReloadTimer = setInterval(() => {
      void this.loadVideos().then(() => {
        // If queue length changed, push a new snapshot
        this.broadcastSnapshot();
      });
    }, VIDEO_RELOAD_INTERVAL_MS);
    this.videoReloadTimer.unref?.();

    // Heartbeat to keep SSE/WS connections alive through proxies
    this.heartbeatTimer = setInterval(() => {
      const frame: MPServerFrame = {
        type: "heartbeat",
        serverTimeMs: Date.now(),
        sequence: this.sequence,
      };
      this.broadcastToAll(frame);
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();

    // Watch for item transitions and push snapshot when current item changes
    this.itemWatchTimer = setInterval(() => {
      if (this.videos.length === 0) return;
      const snap = this.getSnapshot();
      const currentId = snap.current?.id ?? null;
      if (currentId !== this.lastBroadcastedId) {
        this.lastBroadcastedId = currentId;
        this.broadcastSnapshot();
      }
    }, ITEM_WATCH_INTERVAL_MS);
    this.itemWatchTimer.unref?.();
  }
}

export const midnightPrayersService = new MidnightPrayersService();
