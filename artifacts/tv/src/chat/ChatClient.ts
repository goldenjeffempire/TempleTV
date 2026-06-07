/**
 * Identical core to `artifacts/admin/src/chat/ChatClient.ts`. Duplicated
 * (rather than centralized in a shared lib) because the TV bundle is
 * shipped to embedded smart-TV browsers where each shared-package import
 * inflates startup latency and the admin/TV apps already version their
 * own copies of types like `ChatMessage`. Behaviour is intentionally
 * verbatim — keep them in sync when changing.
 */

import { resolveApiOrigin } from "../lib/api";
import type {
  ChatClientFrame,
  ChatConnectionState,
  ChatIdentity,
  ChatMessage,
  ChatServerEvent,
} from "./types";

export interface ChatClientOptions {
  channelId?: string;
  bufferSize?: number;
  token?: string | null;
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

const DEFAULT_BUFFER = 60;

function buildUrl(opts: ChatClientOptions): string {
  if (opts.url) return opts.url;
  // Use resolveApiOrigin() instead of window.location.host so that packaged
  // TV apps (Tizen, webOS, FireTV) loaded via file:// don't produce
  // "ws://null/…" URLs — resolveApiOrigin() falls back to the production API
  // origin in that case and respects VITE_API_URL at build time.
  const origin = resolveApiOrigin();
  const proto = origin.startsWith("https") ? "wss:" : "ws:";
  const host = origin.replace(/^https?:\/\//, "");
  const params = new URLSearchParams();
  if (opts.channelId) params.set("channel", opts.channelId);
  if (opts.token) params.set("token", opts.token);
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
  /** See admin/src/chat/ChatClient.ts — cached for useSyncExternalStore. */
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

  start(): void {
    // Guard against double-start: close any existing socket before opening a
    // new one. Without this, a second start() orphans the previous WebSocket
    // (it stays open server-side but loses its local reference).
    if (this.ws) {
      try { this.ws.close(1000, "restart"); } catch { /* noop */ }
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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

  private connect(): void {
    if (this.closedByUser) return;
    this.setState(this.reconnectAttempts === 0 ? "connecting" : "reconnecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(buildUrl(this.opts));
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

    ws.onerror = () => { /* see onclose */ };

    ws.onclose = () => {
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
      case "ack": {
        this.pending = this.pending.filter((p) => p.clientMsgId !== frame.clientMsgId);
        this.emit();
        return;
      }
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
