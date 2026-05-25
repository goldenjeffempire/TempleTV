/**
 * Mobile broadcast storage — in-memory sync cache backed by AsyncStorage.
 *
 * Problem: `localStorage` and `sessionStorage` are `undefined` on React Native,
 * so the player-core transport's snapshot cache and sequence persistence silently
 * no-op on mobile. Every app wake-from-background or cold start begins with an
 * empty BOOTSTRAP state even though the device had perfectly good broadcast state
 * just seconds ago.
 *
 * Solution: a module-level `Map<string, string>` that satisfies the synchronous
 * `StorageAdapter` interface expected by `configureMobileStorage()`. Reads are
 * O(1) from memory (required: the transport calls them synchronously in its
 * constructor). Writes persist asynchronously to AsyncStorage so the cache
 * survives app kills and cold starts — on the next launch `init()` hydrates the
 * Map before any player session is created.
 *
 * Usage:
 *   Call `setupMobileBroadcastStorage()` once at module level in app/_layout.tsx
 *   (before any React component mounts). The function is synchronous — it wires
 *   the adapter immediately — and kicks off the async AsyncStorage hydration in
 *   the background. If the player screen mounts before hydration completes the
 *   transport falls back to sequence=0 / no cached snapshot (same as today). On
 *   typical devices AsyncStorage reads complete in <30 ms — well within the
 *   splash-screen / font-load window.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { configureMobileStorage } from "@workspace/player-core";

const MEMORY = new Map<string, string>();
const AS_KEY_PREFIX = "ttv:transport:";

/**
 * Hydrate the in-memory store from AsyncStorage.
 * Called asynchronously at startup — safe to fire-and-forget.
 */
async function hydrateFromStorage(): Promise<void> {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const ttvKeys = (allKeys as readonly string[]).filter((k) =>
      k.startsWith(AS_KEY_PREFIX),
    );
    if (ttvKeys.length === 0) return;
    const pairs = await AsyncStorage.multiGet(ttvKeys as string[]);
    for (const [rawKey, value] of pairs) {
      if (value !== null) {
        MEMORY.set(rawKey.slice(AS_KEY_PREFIX.length), value);
      }
    }
  } catch {
    // best-effort — app still works without persisted cache
  }
}

/**
 * Wire the mobile storage adapter and begin async hydration from AsyncStorage.
 *
 * Call once at the very start of app/_layout.tsx (module level, before any
 * hook runs) so the adapter is in place before the first V2Transport is
 * constructed.
 */
export function setupMobileBroadcastStorage(): void {
  configureMobileStorage({
    getItem(key: string): string | null {
      return MEMORY.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      MEMORY.set(key, value);
      AsyncStorage.setItem(`${AS_KEY_PREFIX}${key}`, value).catch(() => {});
    },
    removeItem(key: string): void {
      MEMORY.delete(key);
      AsyncStorage.removeItem(`${AS_KEY_PREFIX}${key}`).catch(() => {});
    },
  });
  hydrateFromStorage().catch(() => {});
}
