import type { BroadcastCurrent } from "./api";

const KEY = "templetv:lastBroadcastCurrent";
const TTL_MS = 60_000;

interface Envelope {
  v: 1;
  cachedAt: number;
  payload: BroadcastCurrent;
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
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
