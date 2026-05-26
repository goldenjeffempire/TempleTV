/**
 * React Native chat WebSocket client.
 *
 * Behavior is intentionally identical to the browser-side ChatClients
 * in `artifacts/admin/src/chat/ChatClient.ts` and
 * `artifacts/tv/src/chat/ChatClient.ts` — only the URL builder differs
 * because RN doesn't have `window.location` and the api host comes from
 * `getApiBase()` (EXPO_PUBLIC_API_URL / EXPO_PUBLIC_DOMAIN).
 *
 * RN's global `WebSocket` is API-compatible with the browser's for the
 * subset we use (constructor, send, close, onopen/onmessage/onclose/
 * onerror, readyState). No polyfill needed.
 */

import { getApiBase } from "../apiBase";
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
  /** Auth bearer (JWT for users, ADMIN_API_TOKEN for moderators). */
  token?: string | null;
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

const DEFAULT_BUFFER = 80;

/**
 * Build the WebSocket URL from the resolved API base.
 *
 *   https://api.example.com  → wss://api.example.com/api/chat/ws?...
 *   http://10.0.2.2:5000     → ws://10.0.2.2:5000/api/chat/ws?...
 */
function buildUrl(opts: ChatClientOptions): string {
  if (opts.url) return opts.url;
  const base = getApiBase();
  if (!base) return "";
  const wsBase = base.replace(/^http/i, (m) => (m.toLowerCase() === "https" ? "wss" : "ws"));
  // getApiBase returns scheme://host[:port], no trailing slash. Strip a
  // possible leading scheme replacement leftover and append the path.
  const wsScheme = wsBase
    .replace(/^http:/i, "ws:")
    .replace(/^https:/i, "wss:");
  const params: string[] = [];
  if (opts.channelId) params.push(`channel=${encodeURIComponent(opts.channelId)}`);
  if (opts.token) params.push(`token=${encodeURIComponent(opts.token)}`);
  const qs = params.length ? `?${params.join("&")}` : "";
  return `${wsScheme}/api/chat/ws${qs}`;
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
  private cachedSnapshot: ChatSnapshot | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private readonly bufferSize: number;
  private readonly opts: ChatClientOptions;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  // 25 s is well under the ~2-5 min idle-drop window on mobile NAT gateways.
  // Sending a lightweight ping frame keeps the TCP connection alive and lets
  // us detect a silently-dead socket on the next send rather than waiting
  // for the user to tap Chat and discover nothing is coming through.
  private readonly PING_INTERVAL_MS = 25_000;

  constructor(opts: ChatClientOptions = {}) {
    this.opts = opts;
    this.bufferSize = Math.max(20, opts.bufferSize ?? DEFAULT_BUFFER);
  }

  start(): void {
    this.closedByUser = false;
    this.connect();
  }

  stop(): void {
    this.closedByUser = true;
    this.stopPing();
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
      try {
        this.ws.send(JSON.stringify(frame));
      } catch (err) {
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

  private connect(): void {
    if (this.closedByUser) return;
    const url = buildUrl(this.opts);
    if (!url) {
      // No API base configured (Expo Go without EXPO_PUBLIC_API_URL).
      // Surface a single error and stop reconnect storms.
      this.lastError = {
        code: "internal",
        message: "Live chat is unavailable in this build (no API URL).",
        atMs: Date.now(),
      };
      this.setState("closed");
      this.closedByUser = true;
      this.emit();
      return;
    }
    this.setState(this.reconnectAttempts === 0 ? "connecting" : "reconnecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
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
      this.startPing(ws);
    };

    ws.onmessage = (ev: WebSocketMessageEvent) => {
      // Skip binary frames — the chat protocol is JSON-only.  Some WebSocket
      // polyfills (React Native's built-in and some Android Hermes builds)
      // dispatch ArrayBuffer or Blob objects for binary messages. Passing
      // those to JSON.parse as "" (falsy fallthrough) throws SyntaxError and
      // silently drops the message, but the intent is clearer here.
      if (typeof ev.data !== "string") return;
      let frame: ChatServerEvent;
      try {
        frame = JSON.parse(ev.data) as ChatServerEvent;
      } catch {
        return;
      }
      this.handleServerFrame(frame);
    };

    ws.onerror = () => { /* see onclose */ };

    ws.onclose = () => {
      this.stopPing();
      this.ws = null;
      if (!this.closedByUser) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    this.reconnectAttempts += 1;
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
        return;
      case "presence":
        this.viewers = frame.viewers;
        this.emit();
        return;
      case "ack":
        this.pending = this.pending.filter((p) => p.clientMsgId !== frame.clientMsgId);
        this.emit();
        return;
      case "error":
        this.lastError = { code: frame.code, message: frame.message, atMs: Date.now() };
        if (this.pending.length > 0) {
          const last = this.pending[this.pending.length - 1];
          this.markPendingError(last.clientMsgId, frame.message, frame.retryAtMs);
        } else {
          this.emit();
        }
        return;
      case "ping":
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
      p.clientMsgId === clientMsgId ? { ...p, status: "error", error: message, retryAtMs } : p,
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

  /**
   * Start a periodic ping on the given socket. Sends a lightweight
   * `{ type: "ping" }` frame every PING_INTERVAL_MS to keep the TCP
   * connection alive through mobile NAT gateways that drop idle sockets
   * after 2–5 minutes. The server already handles inbound `ping` frames
   * (see handleServerFrame — type "ping" is a no-op). Errors are silently
   * swallowed; the next failed send will surface via the normal onclose path.
   */
  private startPing(ws: WebSocket): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: "ping" })); } catch { /* noop */ }
      }
    }, this.PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}
