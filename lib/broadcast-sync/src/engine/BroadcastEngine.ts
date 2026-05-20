/**
 * BroadcastEngine — Main orchestrator for broadcast state.
 *
 * Wires together:
 *   • StateSyncService   — WebSocket + HTTP + SSE + OMEGA signals
 *   • QueueManager       — FIFO queue projection (current/next/nextNext/position)
 *   • LiveStreamController — YouTube live detection + admin override management
 *   • FailoverHandler    — error recovery chain (per platform adapter)
 *
 * Emits a single BroadcastSyncState to all subscribers on every change.
 * This class is DOM-free and platform-agnostic — it manages state only.
 * The per-platform PlaybackEngine (video elements, hls.js) lives in each
 * surface's own codebase and subscribes to BroadcastEngine for state.
 */

import type { BroadcastSyncState } from "@workspace/broadcast-types";
import type {
  WirePlaybackState,
  OmegaSignal,
  ConnectionStatus,
  BroadcastEngineOptions,
} from "./types";
import { QueueManager } from "./QueueManager";
import { StateSyncService } from "./StateSyncService";
import { LiveStreamController } from "./LiveStreamController";

// ── Initial state ─────────────────────────────────────────────────────────────

const INITIAL: BroadcastSyncState = {
  isLive:             false,
  title:              null,
  videoId:            null,
  hlsStreamUrl:       null,
  failoverHlsUrl:     null,
  liveOverride:       null,
  ytLive:             false,
  ytVideoId:          null,
  ytTitle:            null,
  syncedAt:           null,
  serverTimeMs:       null,
  connected:          false,
  positionSecs:       null,
  currentItemEndsAtMs: null,
  itemStartEpochSecs: null,
  index:              null,
  totalSecs:          null,
  queueLength:        null,
  progressPercent:    null,
  currentItem:        null,
  nextItem:           null,
  nextNextItem:       null,
  viewerCount:        null,
  payload:            null,
  libraryRevision:    0,
  scheduleRevision:   0,
  emergencyBroadcast: false,
  emergencyMessage:   null,
};

// ── BroadcastEngine ───────────────────────────────────────────────────────────

export class BroadcastEngine {
  private readonly sync: StateSyncService;
  private readonly queue: QueueManager;
  private readonly live: LiveStreamController;

  private state: BroadcastSyncState = { ...INITIAL };
  private readonly subscribers = new Set<(s: BroadcastSyncState) => void>();
  private destroyed = false;

  // Mutable counters — not part of deep-equal checks but patched in on emit.
  private libraryRevision = 0;
  private scheduleRevision = 0;
  private emergencyBroadcast = false;
  private emergencyMessage: string | null = null;

  constructor(opts: BroadcastEngineOptions) {
    this.queue = new QueueManager(opts.normalizeUrl);
    this.live  = new LiveStreamController(opts.liveStatusUrl, {
      onStateChanged: () => this.emitMerged(),
    });
    this.sync  = new StateSyncService(opts, {
      onState: (wire, reason, leadMs) => this.handleWireState(wire, reason, leadMs),
      onOmegaSignal: (sig) => this.handleOmegaSignal(sig),
      onConnectionChanged: (status) => this.handleConnection(status),
      onLibraryRevision: (rev) => {
        this.libraryRevision = rev > 0
          ? Math.max(this.libraryRevision + 1, rev)
          : this.libraryRevision + 1;
        this.emitMerged();
      },
      onScheduleRevision: () => {
        this.scheduleRevision += 1;
        this.emitMerged();
      },
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    if (this.destroyed) return;
    this.live.start();
    this.sync.start();
    // Dispatch a browser event so ConnectivityBanner can react without
    // prop drilling. Silently skipped on React Native where window is undefined.
    this.dispatchConnectionEvent(false);
  }

  stop(): void {
    this.destroyed = true;
    this.sync.stop();
    this.live.stop();
    this.subscribers.clear();
  }

  // ── Subscription ─────────────────────────────────────────────────────────

  subscribe(listener: (state: BroadcastSyncState) => void): () => void {
    this.subscribers.add(listener);
    // Immediately emit current state to the new subscriber.
    listener(this.state);
    return () => this.subscribers.delete(listener);
  }

  getState(): BroadcastSyncState {
    return this.state;
  }

  // ── Wire state handler ────────────────────────────────────────────────────

  private handleWireState(
    wire: WirePlaybackState,
    _reason: string,
    _leadMs?: number,
  ): void {
    // Update queue manager.
    this.queue.update(wire);

    // Update live controller with server-pushed override/live data.
    const current = wire.current;
    const isOverride = wire.source === "override" && !!wire.liveOverride;
    const overrideYoutubeId =
      isOverride && current?.source.kind === "youtube" ? current.source.url : null;
    const overrideHlsUrl =
      isOverride && current?.source.kind === "hls" ? current.source.url : null;

    this.live.applyServerState({
      liveOverride:      wire.liveOverride,
      overrideYoutubeId,
      overrideHlsUrl,
      source:            wire.source,
      currentYoutubeId:  current?.source.kind === "youtube" ? current.source.url : null,
    });

    this.emitMerged(wire);
  }

  // ── OMEGA signal handler ──────────────────────────────────────────────────

  private handleOmegaSignal(sig: OmegaSignal): void {
    switch (sig.type) {
      case "EMERGENCY_BROADCAST":
        this.emergencyBroadcast = true;
        this.emergencyMessage   = sig.message ?? null;
        break;
      case "PROGRAM_CHANGED":
        this.emergencyBroadcast = false;
        this.emergencyMessage   = null;
        break;
      default:
        break;
    }
    this.emitMerged();
  }

  // ── Connection handler ────────────────────────────────────────────────────

  private handleConnection(status: ConnectionStatus): void {
    const connected = status === "connected";
    this.patch({ connected });
    this.dispatchConnectionEvent(connected);
  }

  // ── State merger ──────────────────────────────────────────────────────────

  /**
   * Merge QueueManager state + LiveStreamController state + mutable counters
   * into the full BroadcastSyncState and notify all subscribers.
   */
  private emitMerged(wire?: WirePlaybackState): void {
    if (this.destroyed) return;
    const q = this.queue.getState();
    const l = this.live.getState();

    const isLive = !!q.currentItem || l.mode === "override" || l.mode === "channel-live";

    const title =
      l.liveOverride?.title ??
      (l.mode === "channel-live" ? l.ytTitle : null) ??
      q.title;

    // Override wins for YouTube videoId and HLS URL.
    const videoId = l.mode === "override"
      ? l.liveOverride?.youtubeVideoId ?? null
      : (l.mode === "channel-live" ? l.ytVideoId : q.videoId);

    const hlsStreamUrl = l.mode === "override"
      ? l.liveOverride?.hlsStreamUrl ?? null
      : q.hlsStreamUrl;

    const payload: Record<string, unknown> = {
      item:              q.currentItem,
      nextItem:          q.nextItem,
      upcomingItems:     q.nextNextItem ? [q.nextItem, q.nextNextItem] : q.nextItem ? [q.nextItem] : [],
      positionSecs:      q.positionSecs,
      serverTimeMs:      wire?.serverTimeMs ?? this.state.serverTimeMs,
      currentItemEndsAtMs: q.currentItemEndsAtMs,
      itemStartEpochSecs:  q.itemStartEpochSecs,
      queueLength:       0,
      totalSecs:         q.totalSecs,
      progressPercent:   q.progressPercent,
      liveOverride:      l.liveOverride,
    };

    const next: BroadcastSyncState = {
      isLive,
      title,
      videoId,
      hlsStreamUrl,
      failoverHlsUrl:    wire?.failoverHlsUrl ?? this.state.failoverHlsUrl,
      liveOverride:      l.liveOverride,
      ytLive:            l.ytLive,
      ytVideoId:         l.ytVideoId,
      ytTitle:           l.ytTitle,
      syncedAt:          wire ? new Date(wire.serverTimeMs).toISOString() : this.state.syncedAt,
      serverTimeMs:      wire?.serverTimeMs ?? this.state.serverTimeMs,
      connected:         this.state.connected,
      positionSecs:      q.positionSecs,
      currentItemEndsAtMs: q.currentItemEndsAtMs,
      itemStartEpochSecs:  q.itemStartEpochSecs,
      index:             q.index,
      totalSecs:         q.totalSecs,
      queueLength:       q.queueLength,
      progressPercent:   q.progressPercent,
      currentItem:       q.currentItem,
      nextItem:          q.nextItem,
      nextNextItem:      q.nextNextItem,
      viewerCount:       this.state.viewerCount,
      payload,
      libraryRevision:   this.libraryRevision,
      scheduleRevision:  this.scheduleRevision,
      emergencyBroadcast: this.emergencyBroadcast,
      emergencyMessage:   this.emergencyMessage,
    };

    this.state = next;
    for (const sub of this.subscribers) sub(next);
  }

  private patch(partial: Partial<BroadcastSyncState>): void {
    this.state = { ...this.state, ...partial };
    for (const sub of this.subscribers) sub(this.state);
  }

  // ── Browser event dispatch ────────────────────────────────────────────────

  private dispatchConnectionEvent(connected: boolean): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("temple-tv-broadcast-connected", { detail: { connected } }),
    );
  }
}
