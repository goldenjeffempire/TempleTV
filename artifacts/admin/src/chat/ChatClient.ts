/**
 * Browser-side live-chat WebSocket client.
 *
 * Responsibilities
 *   - Persistent WS to /api/chat/ws on the same origin (vite proxies in dev,
 *     direct same-origin in prod).
 *   - Auto-reconnect with capped exponential backoff (250ms → 8s).
 *   - Capped local message buffer (cap = 500 in admin, 60 in TV — passed in).
 *   - Optimistic send with `clientMsgId`; the server's `ack` swaps the
 *     temporary id for the canonical one.
 *   - Pluggable subscription model — the React hook above just listens.
 *
 * No polling, no REST send. Read of history is done once on first state
 * frame; reconnect re-fetches a fresh state via the WS handshake itself.
 */

import type {
  ChatClientFrame,
  ChatConnectionState,
  ChatIdentity,
  ChatMessage,
  ChatServerEvent,
} from "./types";

export interface ChatClientOptions {
  /** Channel to subscribe to. Defaults to TEMPLE_TV_LIVE_CHANNEL. */
  channelId?: string;
  /** Max messages kept in memory. Older ones are dropped FIFO. */
  bufferSize?: number;
  /**
   * Static auth bearer token. If provided alongside `getToken`, `getToken`
   * takes precedence on each connection attempt.
   */
  token?: string | null;
  /**
   * Dynamic token factory — called on every connection and reconnection
   * attempt so the WebSocket always presents the current access token.
   * Use this instead of `token` in admin contexts so that proactive token
   * rotation does not rebuild the ChatClient (and tear down the socket)
   * on every keep-alive cycle.
   */
  getToken?: () => string | null | undefined;
  /** Override the WS URL (testing). */
  url?: string;
}

type Listener = (snapshot: ChatSnapshot) => void;

export interface PendingMessage {
  clientMsgId: string;
  body: string;
  status: "sending" | "ack" | "error";
  error?: string;
  retryAtMs?: number;
}

export interface ChatSnapshot {
  state: ChatConnectionState;
  identity: ChatIdentity | null;
  viewers: number;
  messages: ChatMessage[];
  pending: PendingMessage[];
  lastError: { code: string; message: string; atMs: number } | null;
}

const DEFAULT_BUFFER = 500;

function buildUrl(opts: ChatClientOptions, resolvedToken?: string | null): string {
  if (opts.url) return opts.url;
  const isHttps = typeof window !== "undefined" && window.location.protocol === "https:";
  const proto = isHttps ? "wss:" : "ws:";
  const host = typeof window !== "undefined" ? window.location.host : "localhost";
  const params = new URLSearchParams();
  if (opts.channelId) params.set("channel", opts.channelId);
  const token = resolvedToken ?? opts.token;
  if (token) params.set("token", token);
  const qs = params.toString();
  return `${proto}//${host}/api/chat/ws${qs ? `?${qs}` : ""}`;
}

export class ChatClient {
  private ws: WebSocket | null = null;
  private state: ChatConnectionState = "idle";
  private identity: ChatIdentity | null = null;
  private viewers = 0;
  private messages: ChatMessage[] = [];
  private pending: PendingMessage[] = [];
  private lastError: ChatSnapshot["lastError"] = null;
  private listeners = new Set<Listener>();
  /**
   * Cached snapshot reference. `useSyncExternalStore` calls `getSnapshot`
   * on every render and compares with `Object.is`; if we returned a fresh
   * object literal each time, React would loop forever ("getSnapshot
   * should be cached to avoid an infinite loop"). We invalidate this
   * cache from `emit()` whenever any internal state actually changes.
   */
  private cachedSnapshot: ChatSnapshot | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private readonly bufferSize: number;
  private readonly opts: ChatClientOptions;

  constructor(opts: ChatClientOptions = {}) {
    this.opts = opts;
    this.bufferSize = Math.max(20, opts.bufferSize ?? DEFAULT_BUFFER);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  start(): void {
    this.closedByUser = false;
    this.connect();
  }

  stop(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(1000, "client closed"); } catch { /* noop */ }
    }
    this.ws = null;
    this.setState("closed");
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  send(body: string): { clientMsgId: string } | null {
    const trimmed = body.trim();
    if (!trimmed) return null;
    const clientMsgId = `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const pending: PendingMessage = { clientMsgId, body: trimmed, status: "sending" };
    this.pending = [...this.pending, pending];
    this.emit();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const frame: ChatClientFrame = { type: "send", clientMsgId, body: trimmed };
      try { this.ws.send(JSON.stringify(frame)); } catch (err) {
        this.markPendingError(clientMsgId, err instanceof Error ? err.message : "send failed");
      }
    } else {
      this.markPendingError(clientMsgId, "Not connected — reconnecting…");
    }
    return { clientMsgId };
  }

  snapshot(): ChatSnapshot {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    this.cachedSnapshot = {
      state: this.state,
      identity: this.identity,
      viewers: this.viewers,
      messages: this.messages,
      pending: this.pending,
      lastError: this.lastError,
    };
    return this.cachedSnapshot;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private connect(): void {
    if (this.closedByUser) return;
    this.setState(this.reconnectAttempts === 0 ? "connecting" : "reconnecting");
    // Resolve the current token on every connection/reconnection attempt so
    // that a rotated or extended access token is always used in the WS
    // handshake URL — prevents reconnects from using a stale/expired token.
    const currentToken = this.opts.getToken?.() ?? this.opts.token;
    let ws: WebSocket;
    try {
      ws = new WebSocket(buildUrl(this.opts, currentToken));
    } catch (err) {
      this.scheduleReconnect();
      this.lastError = {
        code: "internal",
        message: err instanceof Error ? err.message : "WebSocket construction failed",
        atMs: Date.now(),
      };
      this.emit();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setState("open");
    };

    ws.onmessage = (ev: MessageEvent<string>) => {
      let frame: ChatServerEvent;
      try {
        frame = JSON.parse(ev.data) as ChatServerEvent;
      } catch {
        return;
      }
      this.handleServerFrame(frame);
    };

    ws.onerror = () => {
      // onclose follows; the actual diagnostic is in the close-code path.
    };

    ws.onclose = () => {
      this.ws = null;
      if (!this.closedByUser) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    this.reconnectAttempts += 1;
    // 250ms → 500ms → 1s → 2s → 4s → 8s (capped). Jitter avoids thundering herd.
    const baseMs = Math.min(8_000, 250 * 2 ** Math.min(this.reconnectAttempts, 6));
    const jitter = Math.random() * 0.3 * baseMs;
    const delay = Math.floor(baseMs + jitter);
    this.setState("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleServerFrame(frame: ChatServerEvent): void {
    switch (frame.type) {
      case "state":
        this.identity = frame.you;
        this.viewers = frame.viewers;
        this.messages = this.dedupeAndCap(frame.recent);
        this.emit();
        return;
      case "message":
        this.messages = this.dedupeAndCap([...this.messages, frame.message]);
        this.emit();
        return;
      case "delete":
        this.messages = this.messages.filter((m) => m.id !== frame.messageId);
        this.emit();
        return;
      case "moderate":
        // Not surfaced in the buffer — the moderation page will subscribe to
        // raw frames if it needs to react.
        return;
      case "presence":
        this.viewers = frame.viewers;
        this.emit();
        return;
      case "ack": {
        const next: PendingMessage[] = [];
        for (const p of this.pending) {
          if (p.clientMsgId === frame.clientMsgId) continue;
          next.push(p);
        }
        this.pending = next;
        this.emit();
        return;
      }
      case "error":
        this.lastError = { code: frame.code, message: frame.message, atMs: Date.now() };
        // If we have a most-recent pending send, mark it errored so the UI
        // can show a per-message indicator.
        if (this.pending.length > 0) {
          const last = this.pending[this.pending.length - 1];
          this.markPendingError(last.clientMsgId, frame.message, frame.retryAtMs);
        } else {
          this.emit();
        }
        return;
      case "ping":
        // server-initiated ping — wsServer also pings; we just observe.
        return;
    }
  }

  private dedupeAndCap(messages: ChatMessage[]): ChatMessage[] {
    const seen = new Set<string>();
    const out: ChatMessage[] = [];
    for (const m of messages) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
    if (out.length > this.bufferSize) {
      return out.slice(out.length - this.bufferSize);
    }
    return out;
  }

  private markPendingError(clientMsgId: string, message: string, retryAtMs?: number): void {
    this.pending = this.pending.map((p) =>
      p.clientMsgId === clientMsgId
        ? { ...p, status: "error", error: message, retryAtMs }
        : p,
    );
    this.emit();
  }

  private setState(state: ChatConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit();
  }

  private emit(): void {
    this.cachedSnapshot = null;
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }
}
