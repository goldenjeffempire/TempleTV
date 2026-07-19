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
 * - STRICT SERVER-SIDE WINDOW ENFORCEMENT: getSnapshot() returns offline_hold
 *   outside the [startHour, endHour) window in the configured timezone. The
 *   itemWatchTimer tracks window transitions and pushes offline_hold to all
 *   connected clients the moment the window closes at endHour.
 */
import { getLocalHour, isWindowActive, type MPWindowConfig } from "./window-utils.js";
export { getLocalHour, isWindowActive, type MPWindowConfig };
export interface MPV2Source {
    kind: "hls" | "mp4" | "youtube";
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
    failover: {
        active: false;
        reason: null;
    };
    meta: {
        totalVideos: number;
        totalDurationSecs: number;
        cycleLengthMs: number;
        epochMs: number;
        windowActive: boolean;
        windowDescription: string;
    };
}
export type MPServerFrame = {
    type: "hello";
    serverTimeMs: number;
    sequence: number;
} | {
    type: "snapshot";
    sequence: number;
    state: MPV2Snapshot;
} | {
    type: "heartbeat";
    serverTimeMs: number;
    sequence: number;
} | {
    type: "error";
    code: string;
    message: string;
};
interface MPVideo {
    id: string;
    title: string;
    thumbnailUrl: string | null;
    durationSecs: number;
    localVideoUrl: string | null;
    hlsMasterUrl: string | null;
    youtubeId: string | null;
}
export interface MidnightPrayersConfigData {
    enabled: boolean;
    startHour: number;
    endHour: number;
    timezone: string;
    updatedAt: Date;
}
/**
 * Returns the Unix timestamp (ms) for 00:00:00 today in the given IANA
 * timezone, using Intl.DateTimeFormat formatToParts to extract local time
 * components without any third-party library.
 */
export declare function getTodayMidnightMs(tz: string): number;
type FrameSink = (frame: MPServerFrame) => void;
declare class MidnightPrayersService {
    private videos;
    private config;
    private sequence;
    private readonly sseSinks;
    private readonly wsSinks;
    private videoReloadTimer;
    private heartbeatTimer;
    private itemWatchTimer;
    private lastBroadcastedId;
    /** Tracks the last known window state so the timer can detect transitions. */
    private lastWindowActive;
    init(): Promise<void>;
    getConfig(): MidnightPrayersConfigData;
    loadConfig(): Promise<void>;
    saveConfig(patch: Partial<Pick<MidnightPrayersConfigData, "enabled" | "startHour" | "endHour" | "timezone">>): Promise<MidnightPrayersConfigData>;
    loadVideos(): Promise<void>;
    getVideos(): MPVideo[];
    getDiagnostics(): Promise<{
        total: number;
        playable: number;
        encoding: number;
        failed: number;
        queued: number;
        inRotation: number;
        deadAirRisk: boolean;
        windowActive: boolean;
        statusCounts: Record<string, number>;
        config: MidnightPrayersConfigData;
    }>;
    /**
     * Build a V2Snapshot-compatible object for the current moment in time.
     *
     * STRICT TIME-WINDOW ENFORCEMENT: This method enforces the [startHour,
     * endHour) window in the configured IANA timezone on every call. Outside
     * the window it returns mode="offline_hold" with all items null so the
     * player-core FSM goes dark. This is the authoritative server-side check —
     * client-side switching is a UX optimisation on top of it, not a substitute.
     *
     * @param epochMs  The client's local midnight (ms since epoch).
     *                 Defaults to today's midnight in the server's configured
     *                 timezone so the cycle position is deterministic for
     *                 clients that don't supply their own epoch.
     */
    getSnapshot(epochMs?: number): MPV2Snapshot;
    subscribeSSE(sink: FrameSink): () => void;
    subscribeWS(sink: FrameSink): () => void;
    private broadcastToAll;
    private broadcastSnapshot;
    private startTimers;
}
export declare const midnightPrayersService: MidnightPrayersService;
