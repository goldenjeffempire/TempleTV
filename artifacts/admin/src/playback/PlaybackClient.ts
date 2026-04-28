/**
 * PlaybackClient — WebSocket client for the new /api/playback/ws gateway.
 *
 * Responsibilities:
 *   1. Open and maintain a WebSocket connection to the playback gateway.
 *   2. Pull a snapshot from /api/playback/state on every (re)connect so the
 *      UI paints instantly even before the server's "subscribe" frame lands.
 *   3. Reconnect with exponential backoff + full jitter (max 30 s) so a
 *      thousand reloading admins don't form a thundering herd after a
 *      deploy.
 *   4. Surface a connection-state machine (connecting / connected /
 *      reconnecting / offline) so the UI can show a status pill.
 *   5. Fan out every server frame to subscribed listeners via a tiny
 *      EventEmitter shim — kept allocation-free in the steady state.
 *
 * The client owns no rendering. The DualBufferPlayer consumes its frames
 * via the `useLivePlayback` hook.
 */

import { apiBase, apiUrl } from "@/lib/api-base";
import type {
  PlaybackConnectionState,
  PlaybackEvent,
  PlaybackState,
} from "./types";

type Listener<T> = (value: T) => void;

const RECONNECT_BASE_MS = 500;
const RECONNECT_CAP_MS = 30_000;

function wsUrlFromApiBase(): string {
  // apiBase() returns either "/api" (same-origin) or "https://host/api"
  // (split-domain). Convert to ws(s):// keeping the same host.
  const base = apiBase();
  if (base.startsWith("http")) {
    const u = new URL(base);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return `${u.toString().replace(/\/$/, "")}/playback/ws`;
  }
  // Relative form: derive from window.location so wss/ws matches https/http.
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${base}/playback/ws`;
}

export class PlaybackClient {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private destroyed = false;

  private state: PlaybackState | null = null;
  private connection: PlaybackConnectionState = "connecting";

  private readonly stateListeners = new Set<Listener<PlaybackState>>();
  private readonly eventListeners = new Set<Listener<PlaybackEvent>>();
  private readonly connListeners = new Set<Listener<PlaybackConnectionState>>();

  start(): void {
    this.connect();
    // Pull a snapshot in parallel with the WS handshake so the first frame
    // can paint before the server's subscribe-frame arrives. If the WS
    // beats the fetch, the WS state wins because it's strictly fresher.
    this.fetchSnapshot();
  }

  stop(): void {
    this.destroyed = true;
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* noop */
      }
      this.ws = null;
    }
  }

  getState(): PlaybackState | null {
    return this.state;
  }

  getConnection(): PlaybackConnectionState {
    return this.connection;
  }

  onState(listener: Listener<PlaybackState>): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onEvent(listener: Listener<PlaybackEvent>): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onConnection(listener: Listener<PlaybackConnectionState>): () => void {
    this.connListeners.add(listener);
    return () => this.connListeners.delete(listener);
  }

  private setConnection(next: PlaybackConnectionState) {
    if (this.connection === next) return;
    this.connection = next;
    for (const l of this.connListeners) l(next);
  }

  private setState(next: PlaybackState) {
    this.state = next;
    for (const l of this.stateListeners) l(next);
  }

  private async fetchSnapshot() {
    try {
      const res = await fetch(apiUrl("/playback/state"), {
        credentials: "same-origin",
      });
      if (!res.ok) return;
      const data = (await res.json()) as PlaybackState;
      // Only adopt the snapshot if no fresher WS frame has landed.
      if (!this.state || data.serverTimeMs >= this.state.serverTimeMs) {
        this.setState(data);
      }
    } catch {
      /* network error — WS path is responsible for surfacing offline state */
    }
  }

  private connect() {
    if (this.destroyed) return;
    this.setConnection(
      this.reconnectAttempt === 0 ? "connecting" : "reconnecting",
    );
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrlFromApiBase());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.setConnection("connected");
    });

    ws.addEventListener("message", (msg) => {
      let event: PlaybackEvent;
      try {
        event = JSON.parse(typeof msg.data === "string" ? msg.data : "") as PlaybackEvent;
      } catch {
        return;
      }
      // Dispatch to event listeners first (so e.g. the engine can react
      // to `preload` hints) then update the published state.
      for (const l of this.eventListeners) l(event);
      if (event.type === "state" || event.type === "preload") {
        this.setState(event.state);
      }
    });

    const handleClose = () => {
      this.ws = null;
      if (this.destroyed) return;
      this.setConnection("offline");
      this.scheduleReconnect();
    };
    ws.addEventListener("close", handleClose);
    ws.addEventListener("error", () => {
      try { ws.close(); } catch { /* noop */ }
    });
  }

  private scheduleReconnect() {
    if (this.destroyed) return;
    const exp = Math.min(
      RECONNECT_CAP_MS,
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
    );
    // Full jitter — uniform in [0, exp) — minimises reconnect-burst
    // collision probability on a fleet-wide deploy.
    const wait = Math.floor(Math.random() * exp);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
      // After a successful connect the gateway sends a "subscribe" state
      // frame, but if the WS open event fires before that frame lands the
      // hook will momentarily show stale data; the snapshot fetch closes
      // that window for the reconnect path too.
      this.fetchSnapshot();
    }, wait);
  }
}
