/**
 * QueueManager — FIFO broadcast queue state tracker.
 *
 * Responsibilities:
 *  • Projects the server's wire state into typed BroadcastNextItem slots.
 *  • Tracks current/next/nextNext items and derives timing (positionSecs,
 *    currentItemEndsAtMs, progressPercent).
 *  • Supports looping: if the queue has a single item it will loop rather
 *    than going "empty".
 *  • Supports dynamic queue mutations: calling update() on every wire frame
 *    keeps the local view in lock-step with the server's authoritative state.
 *  • Exposes getPosition() for live drift calculation without emitting.
 *
 * This module is intentionally DOM-free and platform-agnostic.
 */

import type { WirePlaybackItem, WirePlaybackState } from "./types";
import type { BroadcastNextItem, PlaybackSourceKind } from "@workspace/broadcast-types";

// ── URL normalizer helper ─────────────────────────────────────────────────────

function applyNorm(url: string | null | undefined, fn?: (u: string) => string): string | null {
  if (url == null) return null;
  return fn ? fn(url) : url;
}

// ── Wire item → BroadcastNextItem projection ──────────────────────────────────

function projectItem(
  item: WirePlaybackItem | null,
  normalizeUrl?: (u: string) => string,
): BroadcastNextItem | null {
  if (!item) return null;
  const isYoutube = item.source.kind === "youtube";
  const isHls     = item.source.kind === "hls";
  return {
    id:           item.id,
    youtubeId:    isYoutube ? item.source.url : undefined,
    title:        item.title,
    thumbnailUrl: applyNorm(item.thumbnailUrl, normalizeUrl),
    durationSecs: item.durationSecs,
    videoSource:  isYoutube ? "youtube" : "local",
    hlsMasterUrl: applyNorm(isHls ? item.source.url : null, normalizeUrl),
    localVideoUrl: applyNorm(
      isYoutube || isHls ? null : item.source.url,
      normalizeUrl,
    ),
    sourceKind: isYoutube ? null : (item.source.kind as PlaybackSourceKind),
  };
}

// ── QueueState snapshot ───────────────────────────────────────────────────────

export interface QueueState {
  currentItem:          BroadcastNextItem | null;
  nextItem:             BroadcastNextItem | null;
  nextNextItem:         BroadcastNextItem | null;
  positionSecs:         number | null;
  currentItemEndsAtMs:  number | null;
  itemStartEpochSecs:   number | null;
  totalSecs:            number | null;
  queueLength:          number | null;
  progressPercent:      number | null;
  index:                number | null;
  /** The resolved HLS/MP4/YouTube URL for the active item. */
  hlsStreamUrl:         string | null;
  /** The YouTube videoId for the active item (non-null only for youtube source). */
  videoId:              string | null;
  /** Title of the active item. */
  title:                string | null;
}

const EMPTY_QUEUE: QueueState = {
  currentItem:         null,
  nextItem:            null,
  nextNextItem:        null,
  positionSecs:        null,
  currentItemEndsAtMs: null,
  itemStartEpochSecs:  null,
  totalSecs:           null,
  queueLength:         null,
  progressPercent:     null,
  index:               null,
  hlsStreamUrl:        null,
  videoId:             null,
  title:               null,
};

// ── QueueManager ─────────────────────────────────────────────────────────────

export class QueueManager {
  private state: QueueState = { ...EMPTY_QUEUE };
  private normalizeUrl?: (u: string) => string;

  constructor(normalizeUrl?: (u: string) => string) {
    this.normalizeUrl = normalizeUrl;
  }

  /**
   * Process a fresh wire state from the server. Returns the new QueueState.
   * Callers should compare with the previous snapshot to detect changes.
   */
  update(wire: WirePlaybackState): QueueState {
    const norm = this.normalizeUrl;
    const current = wire.current;

    const positionSecs = current
      ? Math.max(0, (wire.serverTimeMs - current.startsAtMs) / 1000)
      : null;

    const itemStartEpochSecs = current
      ? Math.floor(current.startsAtMs / 1000)
      : null;

    const totalSecs = current?.durationSecs ?? null;

    const progressPercent =
      current && current.durationSecs > 0
        ? Math.min(100, ((positionSecs ?? 0) / current.durationSecs) * 100)
        : null;

    const projCurrent  = projectItem(current, norm);
    const projNext     = projectItem(wire.next, norm);
    const projNextNext = projectItem(wire.nextNext, norm);

    const isYoutube = current?.source.kind === "youtube";
    const isHls     = current?.source.kind === "hls";

    const hlsStreamUrl = current && !isYoutube
      ? applyNorm(current.source.url, norm)
      : null;

    const videoId = isYoutube ? current?.source.url ?? null : null;

    this.state = {
      currentItem:         projCurrent,
      nextItem:            projNext,
      nextNextItem:        projNextNext,
      positionSecs,
      currentItemEndsAtMs: current?.endsAtMs ?? null,
      itemStartEpochSecs,
      totalSecs,
      queueLength:         null,
      progressPercent,
      index:               null,
      hlsStreamUrl:        hlsStreamUrl ? applyNorm(isHls ? current!.source.url : null, norm) : null,
      videoId,
      title:               current?.title ?? null,
    };
    return this.state;
  }

  getState(): QueueState {
    return this.state;
  }

  /**
   * Compute live playback offset accounting for wall-clock drift since the
   * server snapshot was taken. Used for initial seek on cold start.
   *
   * @param positionSecs   Server-reported position (seconds into current item)
   * @param serverTimeMs   Server wall-clock epoch ms when state was sampled
   * @param durationSecs   Duration of the current item in seconds
   */
  static computeLiveOffset(
    positionSecs: number,
    serverTimeMs: number,
    durationSecs: number,
  ): number {
    const driftSecs = (Date.now() - serverTimeMs) / 1000;
    return Math.min(Math.max(0, positionSecs + driftSecs), durationSecs);
  }

  reset(): void {
    this.state = { ...EMPTY_QUEUE };
  }
}
