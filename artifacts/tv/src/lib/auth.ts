/**
 * Minimal auth state for the smart-TV app.
 *
 * TVs don't have keyboards, so we don't show login forms here — instead
 * the TV displays a short pairing code and the user enters it on their
 * phone (see {@link ./deviceLink.ts} and {@link ../components/AuthGateModal.tsx}).
 * Once paired, the device-link `exchange` endpoint returns access +
 * refresh tokens which we persist to localStorage.
 *
 * The TV makes very few authenticated requests; we only need a boolean
 * "is signed in" gate before allowing playback. A subscriber pattern
 * lets React components stay in sync without a full context provider.
 */

const STORAGE_KEYS = {
  accessToken: "templetv:auth:accessToken",
  refreshToken: "templetv:auth:refreshToken",
  userDisplayName: "templetv:auth:displayName",
} as const;

type Listener = (loggedIn: boolean) => void;
const listeners = new Set<Listener>();

function safeGet(key: string): string | null {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string | null): void {
  try {
    if (typeof window === "undefined") return;
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* localStorage may be unavailable on some embedded browsers */
  }
}

export function getAccessToken(): string | null {
  return safeGet(STORAGE_KEYS.accessToken);
}

export function getDisplayName(): string | null {
  return safeGet(STORAGE_KEYS.userDisplayName);
}

export function isLoggedIn(): boolean {
  return !!getAccessToken();
}

export function saveAuth(payload: {
  accessToken: string;
  refreshToken?: string | null;
  displayName?: string | null;
}): void {
  safeSet(STORAGE_KEYS.accessToken, payload.accessToken);
  if (payload.refreshToken !== undefined) {
    safeSet(STORAGE_KEYS.refreshToken, payload.refreshToken);
  }
  if (payload.displayName !== undefined) {
    safeSet(STORAGE_KEYS.userDisplayName, payload.displayName);
  }
  notify();
}

export function clearAuth(): void {
  safeSet(STORAGE_KEYS.accessToken, null);
  safeSet(STORAGE_KEYS.refreshToken, null);
  safeSet(STORAGE_KEYS.userDisplayName, null);
  notify();
}

function notify(): void {
  const value = isLoggedIn();
  listeners.forEach((fn) => {
    try {
      fn(value);
    } catch {
      /* swallow listener errors — never let one bad listener break the chain */
    }
  });
}

export function subscribeAuth(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
