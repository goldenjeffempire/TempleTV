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
 * TTL: Each entry is wrapped with a `{ v, t }` envelope where `t` is the
 * write timestamp (epoch ms). On hydration, entries older than TTL_MS (24 h)
 * are discarded and deleted from AsyncStorage. This prevents state from a
 * previous day's session from being replayed into a fresh session, which can
 * confuse the FSM into thinking it is mid-stream when it should start fresh.
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

// ── Hydration gate ─────────────────────────────────────────────────────────
// Resolves once the AsyncStorage → in-memory hydration pass completes.
// Consumers (V2PlayerContainer) await this before enabling the broadcast
// session so the transport's initial storage reads use the persisted sequence,
// eliminating the spurious BOOTSTRAP → re-request cycle on cold-start.

let _resolveHydration!: () => void;
let _hydrationDone = false;

/** Resolves once AsyncStorage hydration into the in-memory map is complete. */
export const hydrationReady: Promise<void> = new Promise<void>((resolve) => {
  _resolveHydration = () => {
    _hydrationDone = true;
    resolve();
  };
});

/** Synchronous check — true once the initial hydration pass has finished. */
export function isHydrationDone(): boolean {
  return _hydrationDone;
}

/** 24-hour TTL — entries older than this are discarded on hydration. */
const TTL_MS = 24 * 60 * 60 * 1_000;

/** Wrapper stored in AsyncStorage: value + write timestamp. */
interface StoredEntry {
  v: string;
  t: number;
}

function wrapValue(value: string): string {
  const entry: StoredEntry = { v: value, t: Date.now() };
  return JSON.stringify(entry);
}

function unwrapValue(raw: string): string | null {
  try {
    const entry = JSON.parse(raw) as Partial<StoredEntry>;
    if (typeof entry.v !== "string") return null;
    // If timestamp is missing (legacy entries without TTL) treat as valid.
    if (typeof entry.t === "number" && Date.now() - entry.t > TTL_MS) return null;
    return entry.v;
  } catch {
    // Legacy plain-string entries (before TTL was added): treat as valid.
    return raw;
  }
}

/**
 * Hydrate the in-memory store from AsyncStorage.
 * Called asynchronously at startup — safe to fire-and-forget.
 * Expired entries are cleaned up from AsyncStorage during hydration.
 */
async function hydrateFromStorage(): Promise<void> {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const ttvKeys = (allKeys as readonly string[]).filter((k) =>
      k.startsWith(AS_KEY_PREFIX),
    );
    if (ttvKeys.length === 0) return;

    const pairs = await AsyncStorage.multiGet(ttvKeys as string[]);
    const expiredKeys: string[] = [];

    for (const [rawKey, raw] of pairs) {
      if (raw === null) continue;
      const memKey = rawKey.slice(AS_KEY_PREFIX.length);
      const value = unwrapValue(raw);
      if (value !== null) {
        MEMORY.set(memKey, value);
      } else {
        // Expired — schedule cleanup (fire-and-forget; never block hydration)
        expiredKeys.push(rawKey);
      }
    }

    if (expiredKeys.length > 0) {
      AsyncStorage.multiRemove(expiredKeys as string[]).catch(() => {});
    }
  } catch {
    // best-effort — app still works without persisted cache
  } finally {
    // Always resolve the hydration gate — even if AsyncStorage failed — so
    // V2PlayerContainer never blocks indefinitely waiting for storage.
    _resolveHydration();
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
      AsyncStorage.setItem(`${AS_KEY_PREFIX}${key}`, wrapValue(value)).catch(() => {});
    },
    removeItem(key: string): void {
      MEMORY.delete(key);
      AsyncStorage.removeItem(`${AS_KEY_PREFIX}${key}`).catch(() => {});
    },
  });
  hydrateFromStorage().catch(() => {});
}
