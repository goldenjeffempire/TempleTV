/**
 * FailoverHandler — Per-item error chain management.
 *
 * Recovery chain for a failed primary stream URL:
 *   1. If `failoverHlsUrl` is configured → switch to backup stream
 *      (server's BROADCAST_FAILOVER_HLS_URL env var, propagated via wire state)
 *   2. After MAX_FAILOVER_RETRIES on the backup → signal SKIP to the caller
 *      (PlaybackEngine advances to the next queue item)
 *   3. Network offline → suspend retry budget, hold current frame, resume
 *      on "online" event without consuming a retry attempt
 *
 * The handler is stateless per-URL: call reset() whenever the active stream
 * URL changes (queue advance, override start/end) to clear the retry budget.
 */

export interface FailoverState {
  /** The backup stream URL to use (from wire state failoverHlsUrl). */
  failoverUrl: string | null;
  /** True while currently playing from the failover URL. */
  usingFailover: boolean;
  /** True while waiting for the device to come back online. */
  offlineWaiting: boolean;
}

export interface FailoverCallbacks {
  /** Request the player to switch to this URL immediately. */
  onActivateFailover(url: string): void;
  /** Request the player to skip to the next queue item. */
  onSkipToNext(): void;
  /** Notify that the device is offline and the stream is paused. */
  onOfflineWaiting(isWaiting: boolean): void;
}

const MAX_PRIMARY_RETRIES  = 3;
const MAX_FAILOVER_RETRIES = 2;

export class FailoverHandler {
  private failoverUrl: string | null = null;
  private usingFailover = false;
  private offlineWaiting = false;
  private primaryRetries = 0;
  private failoverRetries = 0;
  private readonly cb: FailoverCallbacks;

  constructor(callbacks: FailoverCallbacks) {
    this.cb = callbacks;
    this.bindNetworkEvents();
  }

  // ── Configuration ────────────────────────────────────────────────────────

  setFailoverUrl(url: string | null): void {
    this.failoverUrl = url;
  }

  /** Call when the active stream URL changes (queue advance / override). */
  reset(): void {
    this.usingFailover  = false;
    this.primaryRetries = 0;
    this.failoverRetries = 0;
    if (this.offlineWaiting) {
      this.offlineWaiting = false;
      this.cb.onOfflineWaiting(false);
    }
  }

  // ── Error handling ────────────────────────────────────────────────────────

  /**
   * Called by the PlaybackEngine whenever the active stream produces a
   * fatal error. Returns true if the failover handler is taking care of
   * recovery (caller should NOT show an error state), false if recovery
   * is exhausted and the caller should surface an error or skip the item.
   */
  handleError(opts: { isNetwork: boolean }): boolean {
    // If device is offline, hold the last frame rather than burning retries.
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    if (offline || (opts.isNetwork && this.isLikelyOffline())) {
      if (!this.offlineWaiting) {
        this.offlineWaiting = true;
        this.cb.onOfflineWaiting(true);
      }
      return true; // handled — wait for reconnect
    }

    if (!this.usingFailover) {
      this.primaryRetries += 1;
      if (this.primaryRetries <= MAX_PRIMARY_RETRIES) {
        // Still within primary retry budget — let hls.js / native retry.
        return true;
      }
      // Primary budget exhausted → try failover.
      if (this.failoverUrl) {
        this.usingFailover = true;
        this.primaryRetries = 0;
        this.cb.onActivateFailover(this.failoverUrl);
        return true;
      }
      // No failover configured → skip.
      this.cb.onSkipToNext();
      return false;
    }

    // Already on failover.
    this.failoverRetries += 1;
    if (this.failoverRetries <= MAX_FAILOVER_RETRIES) {
      return true; // still retrying on failover
    }
    // Failover exhausted → skip to next item.
    this.cb.onSkipToNext();
    return false;
  }

  getState(): FailoverState {
    return {
      failoverUrl:    this.failoverUrl,
      usingFailover:  this.usingFailover,
      offlineWaiting: this.offlineWaiting,
    };
  }

  // ── Network events ────────────────────────────────────────────────────────

  private bindNetworkEvents(): void {
    if (typeof window === "undefined") return;
    window.addEventListener("online",  this.handleOnline);
    window.addEventListener("offline", this.handleOffline);
  }

  unbind(): void {
    if (typeof window === "undefined") return;
    window.removeEventListener("online",  this.handleOnline);
    window.removeEventListener("offline", this.handleOffline);
  }

  private handleOnline = (): void => {
    if (!this.offlineWaiting) return;
    this.offlineWaiting = false;
    this.primaryRetries = 0;
    this.failoverRetries = 0;
    this.cb.onOfflineWaiting(false);
  };

  private handleOffline = (): void => {
    if (!this.offlineWaiting) {
      this.offlineWaiting = true;
      this.cb.onOfflineWaiting(true);
    }
  };

  private isLikelyOffline(): boolean {
    return typeof navigator !== "undefined" && navigator.onLine === false;
  }
}
