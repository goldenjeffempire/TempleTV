/**
 * LiveStreamController — YouTube live detection & admin override management.
 *
 * Two independent signal sources are monitored and merged:
 *
 *   1. SERVER PUSH (via StateSyncService → BroadcastEngine)
 *      The WirePlaybackState carries `liveOverride` (admin's explicit Go Live)
 *      and the SSE/WS channels carry `ytLive`/`ytVideoId` flags from the
 *      server's own YouTube channel scrape. This is the primary source.
 *
 *   2. CLIENT POLL (this module)
 *      Independently polls GET /api/youtube/live/status every CLIENT_POLL_MS.
 *      This catches the brief window before the SSE handshake completes
 *      (cold-start) and acts as a cross-check when the WS reconnects. The
 *      client poll is intentionally slower than the server's check to avoid
 *      hammering the API.
 *
 * Takeover logic (matches the spec's priority order):
 *   1. Admin override (liveOverride from wire state) — wins unconditionally.
 *   2. YouTube channel live (ytLive from server push OR client poll).
 *   3. Queue fallback — neither of the above.
 *
 * When a live override or channel live event ends, the controller signals
 * QUEUE_RESUME so the PlaybackEngine can restore the last queue position.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LiveOverrideState {
  id: string;
  title: string;
  hlsStreamUrl:   string | null;
  youtubeVideoId: string | null;
}

export type LiveMode = "queue" | "override" | "channel-live";

export interface LiveControllerState {
  mode:         LiveMode;
  /** Non-null when mode === "override" or mode === "channel-live". */
  youtubeVideoId: string | null;
  hlsStreamUrl:   string | null;
  title:          string | null;
  liveOverride:   LiveOverrideState | null;
  ytLive:         boolean;
  ytVideoId:      string | null;
  ytTitle:        string | null;
  /** True during the brief window after a live stream ends while queue resyncs. */
  resumingQueue:  boolean;
}

export interface LiveStatusApiResponse {
  isLive:  boolean;
  videoId: string | null;
  title:   string | null;
  checkedAt?: number;
}

export interface LiveControllerCallbacks {
  onStateChanged(state: LiveControllerState): void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Client polls every 2 min as a cold-start fallback and cross-check.
// The server's own poller fires every 30-60 s and pushes results via SSE
// ("yt-status") and via V2 WS frames, so the client poll is intentionally
// much slower — it catches the brief pre-handshake window and acts as a
// safety net when the server push channel is unavailable.
const CLIENT_POLL_MS = 120_000; // client checks every 2 min
const FETCH_TIMEOUT_MS = 6_000;

// ── LiveStreamController ──────────────────────────────────────────────────────

export class LiveStreamController {
  private readonly liveStatusUrl: string | undefined;
  private readonly cb: LiveControllerCallbacks;

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  private state: LiveControllerState = {
    mode:           "queue",
    youtubeVideoId: null,
    hlsStreamUrl:   null,
    title:          null,
    liveOverride:   null,
    ytLive:         false,
    ytVideoId:      null,
    ytTitle:        null,
    resumingQueue:  false,
  };


  constructor(liveStatusUrl: string | undefined, callbacks: LiveControllerCallbacks) {
    this.liveStatusUrl = liveStatusUrl;
    this.cb = callbacks;
  }

  start(): void {
    if (this.destroyed) return;
    // Kick an immediate check so cold-start paint happens before WS handshake.
    void this.pollLiveStatus();
    this.schedulePoll();
  }

  stop(): void {
    this.destroyed = true;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }

  // ── Server-pushed updates (from BroadcastEngine) ──────────────────────────

  /**
   * Called by BroadcastEngine whenever a fresh WirePlaybackState arrives.
   * Merges server-side override + ytLive signals into the controller state.
   */
  applyServerState(opts: {
    liveOverride: { title: string; startedAtMs: number; endsAtMs: number | null } | null;
    overrideYoutubeId: string | null;
    overrideHlsUrl: string | null;
    source: "override" | "schedule" | "queue" | "empty";
    currentYoutubeId?: string | null;
  }): void {
    const prev = this.state;

    const hasOverride = opts.source === "override" && !!opts.liveOverride;
    const overrideLive: LiveOverrideState | null = hasOverride
      ? {
          id:             "override",
          title:          opts.liveOverride!.title,
          hlsStreamUrl:   opts.overrideHlsUrl,
          youtubeVideoId: opts.overrideYoutubeId,
        }
      : null;

    const mode: LiveMode = hasOverride ? "override" : this.state.mode;
    const wasLive = prev.mode !== "queue";
    const isNowQueue = !hasOverride && this.state.mode !== "channel-live";

    if (wasLive && isNowQueue) {
      this.emitResumeQueue();
    }

    this.state = {
      ...this.state,
      liveOverride:   overrideLive,
      mode,
      youtubeVideoId: hasOverride ? opts.overrideYoutubeId : this.state.ytVideoId,
      hlsStreamUrl:   hasOverride ? opts.overrideHlsUrl    : null,
      title:          hasOverride ? opts.liveOverride!.title : this.state.title,
      resumingQueue:  false,
    };

    if (this.state !== prev) this.cb.onStateChanged(this.state);
  }

  // ── Client-side YouTube live poll ─────────────────────────────────────────

  private schedulePoll(): void {
    if (this.destroyed) return;
    this.pollTimer = setTimeout(async () => {
      if (this.destroyed) return;
      await this.pollLiveStatus();
      this.schedulePoll();
    }, CLIENT_POLL_MS);
  }

  private async pollLiveStatus(): Promise<void> {
    if (!this.liveStatusUrl) return;
    try {
      const res = await fetch(this.liveStatusUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return;
      const data = await res.json() as LiveStatusApiResponse;
      this.applyPolledLiveStatus(data);
    } catch {
      // Network error — next poll will retry. Do not surface as live failure.
    }
  }

  private applyPolledLiveStatus(data: LiveStatusApiResponse): void {
    if (this.destroyed) return;

    const prev = this.state;

    // If admin override is active, the polled channel status is irrelevant.
    if (this.state.mode === "override") return;

    const wasChannelLive = this.state.mode === "channel-live";
    const isNowLive = data.isLive && !!data.videoId;

    if (isNowLive && !wasChannelLive) {
      // YouTube channel just went live — trigger takeover.
      this.state = {
        ...this.state,
        mode:           "channel-live",
        ytLive:         true,
        ytVideoId:      data.videoId,
        ytTitle:        data.title,
        youtubeVideoId: data.videoId,
        resumingQueue:  false,
      };
      this.cb.onStateChanged(this.state);
    } else if (!isNowLive && wasChannelLive) {
      // YouTube channel just went offline — resume queue.
      this.emitResumeQueue();
    } else if (isNowLive && wasChannelLive && data.videoId !== this.state.ytVideoId) {
      // Same live mode but different video (stream key changed mid-broadcast).
      this.state = { ...this.state, ytVideoId: data.videoId, youtubeVideoId: data.videoId, ytTitle: data.title };
      this.cb.onStateChanged(this.state);
    }

    void prev; // suppress unused-variable lint
  }

  private emitResumeQueue(): void {
    this.state = {
      ...this.state,
      mode:           "queue",
      ytLive:         false,
      ytVideoId:      null,
      youtubeVideoId: null,
      hlsStreamUrl:   null,
      title:          null,
      resumingQueue:  true,
    };
    this.cb.onStateChanged(this.state);
    // Clear resumingQueue flag after one tick.
    setTimeout(() => {
      if (!this.destroyed) {
        this.state = { ...this.state, resumingQueue: false };
        this.cb.onStateChanged(this.state);
      }
    }, 100);
  }

  getState(): LiveControllerState {
    return this.state;
  }
}
