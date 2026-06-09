/**
 * StateSyncService — Real-time broadcast state synchronisation.
 *
 * Architecture:
 *  1. WebSocket primary channel  (/api/playback/ws)
 *     • Receives state/preload/ping/signal/library-updated frames.
 *     • OMEGA signals processed inline (SYNC_REQUIRED, EMERGENCY_BROADCAST,
 *       PROGRAM_CHANGED, FAILOVER_ACTIVATED).
 *     • Exponential-backoff reconnect with full jitter (2 s → 60 s).
 *
 *  2. HTTP snapshot fallback  (/api/playback/state)
 *     • Fetched immediately on mount to paint before WS handshake.
 *     • Polled every FALLBACK_POLL_MS while WS is disconnected.
 *     • OMEGA 30-second resync loop regardless of WS health.
 *
 *  3. SSE sidecar  (/api/broadcast/events)
 *     • Web-only (EventSource unavailable in React Native — skipped silently).
 *     • Bumps libraryRevision on "videos-library-updated".
 *     • Bumps scheduleRevision on "broadcast-schedule-updated".
 *
 * This class emits typed callbacks and is intentionally DOM-free.
 */

import type {
  WirePlaybackState,
  WirePlaybackFrame,
  OmegaSignal,
  ConnectionStatus,
  BroadcastEngineOptions,
} from "./types";

// ── Constants ────────────────────────────────────────────────────────────────

const MIN_RETRY_MS   = 2_000;
const MAX_RETRY_MS   = 60_000;
const FALLBACK_POLL_MS = 30_000;
const OMEGA_RESYNC_MS  = 30_000;
const FETCH_TIMEOUT_MS = 8_000;
/** How long to wait for any SSE frame before treating the connection as zombie and reconnecting. */
const SSE_WATCHDOG_MS  = 60_000;
/**
 * Maximum time to wait for a WebSocket `open` event after calling
 * `new WebSocket(url)`. On flaky mobile networks or TV browsers the TCP
 * SYN can hang in CONNECTING state for minutes without firing `open` or
 * `error`. After this deadline we close the socket and schedule a
 * normal reconnect so the client falls back to HTTP polling instead of
 * showing "Connecting…" indefinitely.
 */
const WS_HANDSHAKE_TIMEOUT_MS = 10_000;

// ── Callbacks ─────────────────────────────────────────────────────────────────

export interface StateSyncCallbacks {
  onState(wire: WirePlaybackState, reason: string, leadMs?: number): void;
  onOmegaSignal(signal: OmegaSignal): void;
  onConnectionChanged(status: ConnectionStatus): void;
  onLibraryRevision(revision: number): void;
  onScheduleRevision(): void;
}

// ── StateSyncService ─────────────────────────────────────────────────────────

export class StateSyncService {
  private readonly opts: BroadcastEngineOptions;
  private readonly cb: StateSyncCallbacks;

  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = MIN_RETRY_MS;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncInterval: ReturnType<typeof setInterval> | null = null;
  private sseSource: EventSource | null = null;
  private sseWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private sseLastEventMs = 0;
  private destroyed = false;
  private lastServerTimeMs = 0;
  /** Fires if the WebSocket `open` event never arrives within WS_HANDSHAKE_TIMEOUT_MS. */
  private wsHandshakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while the WebSocket is open and healthy. Used to suppress the
   *  OMEGA 30-s resync loop — when WS is delivering push updates there is
   *  no need to also poll /api/playback/state every 30 s. */
  private wsConnected = false;

  constructor(opts: BroadcastEngineOptions, callbacks: StateSyncCallbacks) {
    this.opts = opts;
    this.cb   = callbacks;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    if (this.destroyed) return;
    this.cb.onConnectionChanged("connecting");

    if (typeof WebSocket !== "undefined" && this.opts.wsUrl) {
      this.connect();
    } else {
      this.startFallbackPoll();
    }

    this.startSseSidecar();

    this.resyncInterval = setInterval(() => {
      // Skip the HTTP resync when WS is connected and actively delivering
      // push updates — polling /api/playback/state every 30 s while a
      // healthy WS is running is redundant and adds unnecessary server load.
      if (!this.wsConnected) void this.fetchSnapshot();
    }, OMEGA_RESYNC_MS);

    // Immediate snapshot to paint before WS handshake completes.
    void this.fetchSnapshot();
  }

  stop(): void {
    this.destroyed = true;
    this.closeWs();
    if (this.reconnectTimer)  { clearTimeout(this.reconnectTimer);  this.reconnectTimer = null; }
    if (this.pollTimer)       { clearTimeout(this.pollTimer);        this.pollTimer = null; }
    if (this.resyncInterval)  { clearInterval(this.resyncInterval);  this.resyncInterval = null; }
    if (this.sseWatchdogTimer) { clearTimeout(this.sseWatchdogTimer); this.sseWatchdogTimer = null; }
    try { this.sseSource?.close(); } catch { /* noop */ }
    this.sseSource = null;
  }

  // ── WebSocket ────────────────────────────────────────────────────────────

  private connect(): void {
    if (this.destroyed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    // Handshake watchdog: if `open` never fires (e.g. TCP SYN hangs on a
    // flaky mobile network or TV browser), force-close and reconnect via the
    // normal backoff path so the client falls back to HTTP polling instead of
    // showing "Connecting…" indefinitely.
    this.wsHandshakeTimer = setTimeout(() => {
      this.wsHandshakeTimer = null;
      if (ws.readyState === WebSocket.CONNECTING) {
        try { ws.close(); } catch { /* noop */ }
        // close event fires after close() and will trigger scheduleReconnect.
      }
    }, WS_HANDSHAKE_TIMEOUT_MS);

    ws.addEventListener("open", () => {
      // Handshake succeeded — cancel the timeout.
      if (this.wsHandshakeTimer) {
        clearTimeout(this.wsHandshakeTimer);
        this.wsHandshakeTimer = null;
      }
      if (this.destroyed) return;
      this.reconnectDelay = MIN_RETRY_MS;
      this.wsConnected = true;
      this.stopFallbackPoll();
      this.cb.onConnectionChanged("connected");
      // Fetch snapshot on (re)connect so the UI paints before the subscribe
      // frame arrives from the server.
      void this.fetchSnapshot();
    });

    ws.addEventListener("message", (e: MessageEvent) => {
      if (this.destroyed) return;
      let frame: WirePlaybackFrame;
      try {
        frame = JSON.parse(e.data as string) as WirePlaybackFrame;
      } catch {
        return;
      }
      this.handleFrame(frame);
    });

    ws.addEventListener("close", () => {
      // Cancel the handshake watchdog if it's still pending (e.g. the socket
      // failed before `open` via an `error` + `close` sequence).
      if (this.wsHandshakeTimer) {
        clearTimeout(this.wsHandshakeTimer);
        this.wsHandshakeTimer = null;
      }
      this.ws = null;
      this.wsConnected = false;
      if (this.destroyed) return;
      this.cb.onConnectionChanged("disconnected");
      this.startFallbackPoll();
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      try { ws.close(); } catch { /* noop */ }
    });
  }

  private closeWs(): void {
    if (this.wsHandshakeTimer) {
      clearTimeout(this.wsHandshakeTimer);
      this.wsHandshakeTimer = null;
    }
    try { this.ws?.close(); } catch { /* noop */ }
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    const jitter = Math.random() * 0.3 * this.reconnectDelay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay + jitter);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RETRY_MS);
  }

  // ── Frame dispatch ────────────────────────────────────────────────────────

  private handleFrame(frame: WirePlaybackFrame): void {
    switch (frame.type) {
      case "state":
        this.applyWire(frame.state, frame.reason);
        break;
      case "preload":
        this.applyWire(frame.state, "preload", frame.leadMs);
        break;
      case "signal":
        this.handleOmega(frame.signal);
        break;
      case "library-updated":
        this.cb.onLibraryRevision(frame.revision);
        break;
      case "ping":
        // Browser handles pong automatically; no explicit reply needed.
        break;
      default:
        break;
    }
  }

  private applyWire(wire: WirePlaybackState, reason: string, leadMs?: number): void {
    // Guard against out-of-order frames: only accept frames with a strictly
    // newer server timestamp. Using <= prevents a stale HTTP snapshot (same ms)
    // from overwriting a fresh WebSocket event that arrived in the same tick.
    if (wire.serverTimeMs <= this.lastServerTimeMs) return;
    this.lastServerTimeMs = wire.serverTimeMs;
    this.cb.onState(wire, reason, leadMs);
  }

  // ── OMEGA signal handling ─────────────────────────────────────────────────

  private handleOmega(signal: OmegaSignal): void {
    this.cb.onOmegaSignal(signal);
    switch (signal.type) {
      case "SYNC_REQUIRED":
      case "FAILOVER_ACTIVATED":
      case "EMERGENCY_BROADCAST":
        // Re-anchor immediately on any of these signals.
        void this.fetchSnapshot();
        break;
      default:
        break;
    }
  }

  // ── HTTP snapshot ─────────────────────────────────────────────────────────

  async fetchSnapshot(): Promise<void> {
    if (this.destroyed || !this.opts.stateUrl) return;
    try {
      const res = await fetch(this.opts.stateUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return;
      const wire = await res.json() as WirePlaybackState;
      this.applyWire(wire, "http-snapshot");
    } catch {
      // Network error — next poll / WS will retry.
    }
  }

  // ── HTTP fallback poll ────────────────────────────────────────────────────

  private startFallbackPoll(): void {
    if (this.pollTimer) return;
    const tick = async () => {
      if (this.destroyed) return;
      await this.fetchSnapshot();
      if (!this.destroyed) {
        this.pollTimer = setTimeout(tick, FALLBACK_POLL_MS);
      }
    };
    this.pollTimer = setTimeout(tick, FALLBACK_POLL_MS);
  }

  private stopFallbackPoll(): void {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }

  // ── SSE sidecar ───────────────────────────────────────────────────────────

  private startSseSidecar(): void {
    const url = this.opts.sseUrl;
    if (!url) return;
    try {
      if (typeof EventSource === "undefined") return;
      const sse = new EventSource(url);
      this.sseSource = sse;

      const bump = () => { this.sseLastEventMs = Date.now(); };

      sse.addEventListener("videos-library-updated", () => {
        bump();
        if (!this.destroyed) this.cb.onLibraryRevision(0); // 0 = "bump"
      });
      sse.addEventListener("broadcast-schedule-updated", () => {
        bump();
        if (!this.destroyed) this.cb.onScheduleRevision();
      });

      // Also count the open event as proof-of-life so the first watchdog
      // cycle doesn't fire immediately on slow connections.
      sse.addEventListener("open", bump);

      // Arm the watchdog.
      this.armSseWatchdog();
    } catch {
      // EventSource constructor can throw on some TV browsers — skip.
    }
  }

  /**
   * Arms a recurring watchdog that detects zombie SSE connections — connections
   * that appear open but deliver no data (common on TV chipsets with aggressive
   * NAT that silently drop persistent HTTP streams without firing an error event).
   * When stale, we close + re-open the EventSource so events resume.
   */
  private armSseWatchdog(): void {
    if (this.sseWatchdogTimer) clearTimeout(this.sseWatchdogTimer);
    this.sseWatchdogTimer = setTimeout(() => {
      if (this.destroyed) return;
      const stallMs = Date.now() - this.sseLastEventMs;
      if (stallMs >= SSE_WATCHDOG_MS && this.sseSource && this.sseSource.readyState !== EventSource.CLOSED) {
        // Zombie detected — reconnect.
        try { this.sseSource.close(); } catch { /* noop */ }
        this.sseSource = null;
        this.sseLastEventMs = 0;
        this.startSseSidecar();
        return;
      }
      // Still alive — re-arm.
      this.armSseWatchdog();
    }, SSE_WATCHDOG_MS);
  }
}
