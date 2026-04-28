/**
 * Playback event bus.
 *
 * Single fan-out hub for `PlaybackEvent`s. Used by the playback engine to
 * notify the WS gateway and any in-process listeners. Designed with a small
 * pluggable surface so a Redis pub/sub adapter can be wired in later without
 * touching call-sites:
 *
 *   - `InProcessBus` (default) — EventEmitter-backed, single-instance only.
 *   - `RedisBus` (stub)        — would publish to a Redis channel and bridge
 *                                 inbound frames into the local emitter.
 *                                 Not implemented in this session because
 *                                 REDIS_URL is not provisioned in this
 *                                 environment, but the interface is here so
 *                                 the swap is a one-file change.
 *
 * The existing `liveEventsBus.ts` (SSE bridge) is the reference design for
 * the Redis adapter; the same dual-client pattern (publisher + subscriber),
 * loop prevention via `instanceId`, and capped-backoff reconnect should be
 * reused when the time comes.
 */

import { EventEmitter } from "node:events";
import type { PlaybackEvent } from "./types";

export interface PlaybackBus {
  publish(event: PlaybackEvent): void;
  subscribe(listener: (event: PlaybackEvent) => void): () => void;
  /** Listener count — diagnostic. */
  size(): number;
}

class InProcessBus implements PlaybackBus {
  private readonly emitter = new EventEmitter();
  // Hard cap mirrors `MAX_SSE_CLIENTS_GLOBAL` envelope so a future flood
  // (every WS client is a listener) can't trip Node's default 10-listener
  // warning and silently lose subscribers.
  constructor() {
    this.emitter.setMaxListeners(0);
  }
  publish(event: PlaybackEvent): void {
    this.emitter.emit("ev", event);
  }
  subscribe(listener: (event: PlaybackEvent) => void): () => void {
    this.emitter.on("ev", listener);
    return () => {
      this.emitter.off("ev", listener);
    };
  }
  size(): number {
    return this.emitter.listenerCount("ev");
  }
}

const bus: PlaybackBus = new InProcessBus();

export function getPlaybackBus(): PlaybackBus {
  return bus;
}
