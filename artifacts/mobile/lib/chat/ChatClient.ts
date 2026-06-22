/**
 * React Native chat WebSocket client.
 *
 * Upgraded for YouTube-grade chat:
 *   • Handles `batch`, `pin`, `settings`, `reaction` server frames
 *   • `react(messageId, emoji)` sends a react frame
 *   • `lastAckAtMs` in snapshot — drives slow-mode countdown in UI
 *   • On `ack`, updates corresponding pending message and records timestamp
 *   • Reactions are applied to the in-memory message list in-place
 *
 * URL builder is the only platform-specific bit; all logic is reusable by
 * the browser-side clients (`admin/src/chat/ChatClient.ts`, `tv/src/chat/ChatClient.ts`).
 */

import { getApiBase } from "../apiBase";
import type {
  ChatClientFrame,
  ChatConnectionState,
  ChatIdentity,
  ChatMessage,
  ChatServerEvent,
  ChatSettings,
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
  settings: ChatSettings | null;
  pinnedMessage: ChatMessage | null;
  /** Epoch-ms of the last server `ack` frame — used to compute slow-mode countdown. */
  lastAckAtMs: number;
}

const DEFAULT_BUFFER = 80;

function buildUrl(opts: ChatClientOptions): string {
  if (opts.url) return opts.url;
  const base = getApiBase();
  if (!base) return "";
  const wsScheme = base
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
  private settings: ChatSettings | null = null;
  private pinnedMessage: ChatMessage | null = null;
  private lastAckAtMs = 0;
  private listeners = new Set<Listener>();
  private cachedSnapshot: ChatSnapshot | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private readonly bufferSize: number;
  private readonly opts: ChatClientOptions;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private lastServerActivityAt = 0;
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
    return () => { this.listeners.delete(listener); };
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

  /** Toggle a reaction emoji on a message. No-op if not connected. */
  react(messageId: string, emoji: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const frame: ChatClientFrame = { type: "react", messageId, emoji };
    try { this.ws.send(JSON.stringify(frame)); } catch { /* noop */ }
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
      settings: this.settings,
      pinnedMessage: this.pinnedMessage,
      lastAckAtMs: this.lastAckAtMs,
    };
    return this.cachedSnapshot;
  }

  private connect(): void {
    if (this.closedByUser) return;
    const url = buildUrl(this.opts);
    if (!url) {
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
      this.lastError = {
        code: "internal",
        message: err instanceof Error ? err.message : "WebSocket construction failed",
        atMs: Date.now(),
      };
      this.scheduleReconnect();
      this.emit();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.lastServerActivityAt = Date.now();
      this.setState("open");
      this.startPing(ws);
    };

    ws.onmessage = (ev: WebSocketMessageEvent) => {
      this.lastServerActivityAt = Date.now();
      if (typeof ev.data !== "string") return;
      let frame: ChatServerEvent;
      try { frame = JSON.parse(ev.data) as ChatServerEvent; } catch { return; }
      this.handleServerFrame(frame);
    };

    ws.onerror = () => { /* handled by onclose */ };

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
    const delay = Math.floor(baseMs + Math.random() * 0.3 * baseMs);
    this.setState("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleServerFrame(frame: ChatServerEvent): void {
    switch (frame.type) {
      case "state":
        this.identity = {
          sessionId: frame.you.sessionId,
          displayName: frame.you.displayName,
          isModerator: frame.you.isModerator,
          role: frame.you.role,
        };
        this.viewers = frame.viewers;
        this.messages = this.dedupeAndCap(frame.recent);
        this.settings = frame.settings ?? null;
        this.pinnedMessage = frame.pinnedMessage ?? null;
        this.emit();
        return;

      case "message":
        this.messages = this.dedupeAndCap([...this.messages, frame.message]);
        this.emit();
        return;

      case "batch":
        this.messages = this.dedupeAndCap([...this.messages, ...frame.messages]);
        this.emit();
        return;

      case "settings":
        this.settings = frame.settings;
        this.emit();
        return;

      case "pin":
        this.pinnedMessage = frame.message;
        this.emit();
        return;

      case "reaction":
        this.messages = this.messages.map((m) =>
          m.id === frame.messageId ? { ...m, reactions: frame.reactions } : m,
        );
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
        this.lastAckAtMs = Date.now();
        this.pending = this.pending.filter((p) => p.clientMsgId !== frame.clientMsgId);
        this.emit();
        return;

      case "error":
        this.lastError = { code: frame.code, message: frame.message, atMs: Date.now() };
        if (this.pending.length > 0) {
          const last = this.pending[this.pending.length - 1];
          if (last) this.markPendingError(last.clientMsgId, frame.message, frame.retryAtMs);
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
    return out.length > this.bufferSize
      ? out.slice(out.length - this.bufferSize)
      : out;
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

  private startPing(ws: WebSocket): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const silentMs = Date.now() - this.lastServerActivityAt;
      if (silentMs > this.PING_INTERVAL_MS * 2) {
        try { ws.close(1001, "pong-timeout"); } catch { /* noop */ }
        return;
      }
      try { ws.send(JSON.stringify({ type: "ping" })); } catch { /* noop */ }
    }, this.PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}
