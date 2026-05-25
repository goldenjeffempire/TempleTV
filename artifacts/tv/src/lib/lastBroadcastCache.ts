import type { BroadcastCurrent } from "./api";

const KEY = "templetv:lastBroadcastCurrent";
// Extended from 60 s to 30 min: a device that wakes from sleep or briefly
// loses signal should not show a blank screen — the cached item provides a
// valid source URL the player can attempt while the transport reconnects.
const TTL_MS = 30 * 60 * 1000; // 30 minutes

interface Envelope {
  v: 1;
  cachedAt: number;
  payload: BroadcastCurrent;
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    // localStorage survives page reloads and tab restores; sessionStorage
    // was limited to a single session and caused blank screens after reload.
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readLastBroadcast(): BroadcastCurrent | null {
  const store = safeStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(KEY);
    if (!raw) return null;
    const env = JSON.parse(raw) as Envelope;
    if (!env || env.v !== 1 || typeof env.cachedAt !== "number") return null;
    if (Date.now() - env.cachedAt > TTL_MS) return null;
    if (!env.payload || typeof env.payload !== "object") return null;
    return env.payload;
  } catch {
    return null;
  }
}

export function writeLastBroadcast(payload: BroadcastCurrent | null): void {
  const store = safeStorage();
  if (!store) return;
  try {
    if (!payload) {
      store.removeItem(KEY);
      return;
    }
    const env: Envelope = { v: 1, cachedAt: Date.now(), payload };
    store.setItem(KEY, JSON.stringify(env));
  } catch {
    // Quota exceeded or storage disabled — silent (cache is best-effort).
  }
}
