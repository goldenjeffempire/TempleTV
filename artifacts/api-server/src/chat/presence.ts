/**
 * Per-channel presence tracker.
 *
 * Each connected WebSocket registers a session id; the count of sessions
 * per channel is the live viewer count. Presence updates are coalesced
 * with a small (250ms) debounce so a join/leave storm during a transition
 * doesn't flood every client with N near-identical frames.
 */

import { getChatBus } from "./eventBus";

const channels = new Map<string, Set<string>>();
const pendingPublish = new Map<string, ReturnType<typeof setTimeout>>();
const PUBLISH_DEBOUNCE_MS = 250;

function schedulePublish(channelId: string): void {
  if (pendingPublish.has(channelId)) return;
  const t = setTimeout(() => {
    pendingPublish.delete(channelId);
    const viewers = channels.get(channelId)?.size ?? 0;
    getChatBus().publish({ type: "presence", channelId, viewers });
  }, PUBLISH_DEBOUNCE_MS);
  t.unref();
  pendingPublish.set(channelId, t);
}

export function registerPresence(channelId: string, sessionId: string): void {
  let set = channels.get(channelId);
  if (!set) {
    set = new Set();
    channels.set(channelId, set);
  }
  if (set.has(sessionId)) return;
  set.add(sessionId);
  schedulePublish(channelId);
}

export function unregisterPresence(channelId: string, sessionId: string): void {
  const set = channels.get(channelId);
  if (!set || !set.has(sessionId)) return;
  set.delete(sessionId);
  if (set.size === 0) channels.delete(channelId);
  schedulePublish(channelId);
}

export function getViewerCount(channelId: string): number {
  return channels.get(channelId)?.size ?? 0;
}

export function getAllPresence(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of channels) out[k] = v.size;
  return out;
}
