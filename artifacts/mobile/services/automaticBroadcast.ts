import AsyncStorage from "@react-native-async-storage/async-storage";
import { getApiBase } from "../lib/apiBase";
import { downloadManager } from "./downloadManager";
import { OfflineBroadcastEngine, type BroadcastRecording } from "./offlineBroadcastEngine";

const KEY = "@temple_tv/automatic_broadcast_v1";

export const automaticBroadcast = new OfflineBroadcastEngine({
  async load() {
    await downloadManager.init();
    const value = await AsyncStorage.getItem(KEY);
    return value ? JSON.parse(value) : null;
  },
  async save(value) { await AsyncStorage.setItem(KEY, JSON.stringify(value)); },
  items: () => downloadManager.getAll(),
  prepare: item => downloadManager.prepareBroadcast(item),
  lineup: ids => downloadManager.setBroadcastLineup(ids),
  async page(cursor, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, 15_000);
    try {
      const response = await fetch(`${getApiBase()}/api/videos/offline-broadcast${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        { signal: controller.signal });
      if (!response.ok) throw new Error(`Automatic broadcast preparation HTTP ${response.status}`);
      return await response.json() as { items: BroadcastRecording[]; nextCursor: string | null };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  },
});
