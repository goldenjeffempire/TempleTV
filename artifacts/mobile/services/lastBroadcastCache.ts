import AsyncStorage from "@react-native-async-storage/async-storage";
import type { BroadcastCurrentResult } from "./broadcast";

const KEY = "templetv:lastBroadcastCurrent";
const TTL_MS = 60_000;

interface Envelope {
  v: 1;
  cachedAt: number;
  payload: BroadcastCurrentResult;
}

export async function readLastBroadcast(): Promise<BroadcastCurrentResult | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
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

export async function writeLastBroadcast(payload: BroadcastCurrentResult | null): Promise<void> {
  try {
    if (!payload) {
      await AsyncStorage.removeItem(KEY);
      return;
    }
    const env: Envelope = { v: 1, cachedAt: Date.now(), payload };
    await AsyncStorage.setItem(KEY, JSON.stringify(env));
  } catch {
    // Quota exceeded or storage disabled — silent (cache is best-effort).
  }
}
