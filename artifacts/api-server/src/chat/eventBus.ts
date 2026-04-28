/**
 * Chat event bus.
 *
 * Single fan-out hub for `ChatServerEvent`s. Used by the WS gateway and
 * the moderation/store layer so any code path that mutates chat state
 * (new message, delete, ban) can publish once and have every connected
 * socket receive it.
 *
 * Designed with the same pluggable surface as `playback/eventBus.ts` so a
 * Redis pub/sub adapter can be wired in later without touching call sites:
 *
 *   - `InProcessBus` (default) — EventEmitter-backed, single-instance only.
 *   - `RedisBus` (stub)        — would publish to a Redis channel and
 *                                 bridge inbound frames into the local
 *                                 emitter. The reference design is the
 *                                 existing `liveEventsBus.ts` (dual-client
 *                                 publisher+subscriber, loop prevention via
 *                                 instanceId, capped-backoff reconnect).
 *                                 Not implemented here because REDIS_URL
 *                                 isn't provisioned in this environment;
 *                                 the swap is a one-file change.
 */

import { EventEmitter } from "node:events";
import type { ChatServerEvent } from "./types";

export interface ChatBus {
  publish(event: ChatServerEvent): void;
  subscribe(listener: (event: ChatServerEvent) => void): () => void;
  size(): number;
}

class InProcessChatBus implements ChatBus {
  private readonly emitter = new EventEmitter();
  constructor() {
    // Match `playback/eventBus.ts` — every connected WS is a listener so
    // Node's default 10-listener warning would fire long before we hit our
    // 5000-client cap.
    this.emitter.setMaxListeners(0);
  }
  publish(event: ChatServerEvent): void {
    this.emitter.emit("ev", event);
  }
  subscribe(listener: (event: ChatServerEvent) => void): () => void {
    this.emitter.on("ev", listener);
    return () => {
      this.emitter.off("ev", listener);
    };
  }
  size(): number {
    return this.emitter.listenerCount("ev");
  }
}

const bus: ChatBus = new InProcessChatBus();

export function getChatBus(): ChatBus {
  return bus;
}
