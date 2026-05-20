/**
 * In-memory ring-buffer analytics store for broadcast playback events.
 *
 * Records stalls, skips, natural ends, recoveries, preloads, and
 * session lifecycle events with millisecond timestamps. No DB persistence
 * — the orchestrator event log already stores business events; this store
 * is a fast in-process aggregation layer for the /analytics REST endpoint.
 *
 * Ring buffer: once capacity (RING_SIZE) is reached, oldest events are
 * overwritten. getReport(windowMs) filters to a configurable time window
 * so consumers only see recent activity regardless of buffer fill level.
 */

export type AnalyticsEventType =
  | "stall"
  | "skip"
  | "natural_end"
  | "recovery"
  | "preload_fired"
  | "session_open"
  | "session_close"
  | "url_blocked"
  | "url_cleared"
  | "reload"
  | "item_advanced";

export interface AnalyticsEvent {
  type: AnalyticsEventType;
  itemId: string | null;
  itemTitle: string | null;
  ts: number;
  meta?: Record<string, unknown>;
}

export interface ItemAnalyticsStats {
  itemId: string;
  itemTitle: string | null;
  stalls: number;
  skips: number;
  naturalEnds: number;
  recoveries: number;
  preloadsFired: number;
  advances: number;
  lastEventAtMs: number | null;
}

export interface SessionCounters {
  active: number;
  peakInLast5Min: number;
  total: number;
}

export interface AnalyticsReport {
  windowMs: number;
  from: number;
  to: number;
  totalEvents: number;
  counts: Partial<Record<AnalyticsEventType, number>>;
  byItem: ItemAnalyticsStats[];
  sessions: SessionCounters;
  lastEventAtMs: number | null;
  bufferUtilizationPct: number;
}

const RING_SIZE = 8_000;
const DEFAULT_WINDOW_MS = 60 * 60_000;

class PlaybackAnalyticsStore {
  private readonly ring: (AnalyticsEvent | undefined)[] = new Array<AnalyticsEvent | undefined>(RING_SIZE).fill(undefined);
  private head = 0;
  private filled = 0;
  private activeSessions = 0;
  private totalSessions = 0;
  private peakSessions = 0;
  private peakResetAtMs = Date.now();

  record(ev: AnalyticsEvent): void {
    this.ring[this.head] = ev;
    this.head = (this.head + 1) % RING_SIZE;
    if (this.filled < RING_SIZE) this.filled++;

    if (ev.type === "session_open") {
      this.activeSessions++;
      this.totalSessions++;
      if (this.activeSessions > this.peakSessions) {
        this.peakSessions = this.activeSessions;
      }
      if (Date.now() - this.peakResetAtMs > 5 * 60_000) {
        this.peakSessions = this.activeSessions;
        this.peakResetAtMs = Date.now();
      }
    } else if (ev.type === "session_close") {
      this.activeSessions = Math.max(0, this.activeSessions - 1);
    }
  }

  getReport(windowMs = DEFAULT_WINDOW_MS): AnalyticsReport {
    const now = Date.now();
    const from = now - windowMs;
    const counts: Partial<Record<AnalyticsEventType, number>> = {};
    const itemStats = new Map<string, ItemAnalyticsStats>();
    let lastEventAtMs: number | null = null;
    let totalInWindow = 0;

    for (let i = 0; i < this.filled; i++) {
      const idx = (this.head - this.filled + i + RING_SIZE) % RING_SIZE;
      const ev = this.ring[idx];
      if (!ev || ev.ts < from) continue;
      totalInWindow++;
      counts[ev.type] = (counts[ev.type] ?? 0) + 1;
      if (!lastEventAtMs || ev.ts > lastEventAtMs) lastEventAtMs = ev.ts;

      if (ev.itemId) {
        let s = itemStats.get(ev.itemId);
        if (!s) {
          s = {
            itemId: ev.itemId,
            itemTitle: ev.itemTitle,
            stalls: 0,
            skips: 0,
            naturalEnds: 0,
            recoveries: 0,
            preloadsFired: 0,
            advances: 0,
            lastEventAtMs: null,
          };
          itemStats.set(ev.itemId, s);
        }
        if (!s.lastEventAtMs || ev.ts > s.lastEventAtMs) s.lastEventAtMs = ev.ts;
        switch (ev.type) {
          case "stall":         s.stalls++;         break;
          case "skip":          s.skips++;          break;
          case "natural_end":   s.naturalEnds++;    break;
          case "recovery":      s.recoveries++;     break;
          case "preload_fired": s.preloadsFired++;  break;
          case "item_advanced": s.advances++;       break;
        }
      }
    }

    return {
      windowMs,
      from,
      to: now,
      totalEvents: totalInWindow,
      counts,
      byItem: Array.from(itemStats.values()).sort(
        (a, b) => (b.lastEventAtMs ?? 0) - (a.lastEventAtMs ?? 0),
      ),
      sessions: {
        active: this.activeSessions,
        peakInLast5Min: this.peakSessions,
        total: this.totalSessions,
      },
      lastEventAtMs,
      bufferUtilizationPct: Math.round((this.filled / RING_SIZE) * 100),
    };
  }

  getActiveSessions(): number {
    return this.activeSessions;
  }
}

export const playbackAnalytics = new PlaybackAnalyticsStore();
