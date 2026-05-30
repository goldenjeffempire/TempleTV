/**
 * Auth state for the smart-TV app.
 *
 * TVs don't have keyboards, so we don't show login forms here — instead
 * the TV displays a short pairing code and the user enters it on their
 * phone (see deviceLink.ts and AuthGateModal.tsx). Once paired, the
 * device-link exchange endpoint returns access + refresh tokens which
 * we persist to localStorage.
 *
 * Auto-refresh: every API call is wrapped by authFetch which detects
 * 401 responses, performs a transparent token rotation, and retries.
 * A proactive refresh timer also rotates the access token 2 minutes
 * before its 15-minute expiry to keep the session alive during playback.
 */

const STORAGE_KEYS = {
  accessToken: "templetv:auth:accessToken",
  refreshToken: "templetv:auth:refreshToken",
  userDisplayName: "templetv:auth:displayName",
  accessTokenExpiry: "templetv:auth:accessTokenExpiry",
} as const;

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const PROACTIVE_REFRESH_BEFORE_MS = 2 * 60 * 1000; // refresh 2 min before expiry

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

export function getRefreshToken(): string | null {
  return safeGet(STORAGE_KEYS.refreshToken);
}

/**
 * Returns true when the user has any stored credential.
 * We check the access token first (fast-path); the refresh token acts as a
 * fallback so that having a valid refresh token — but a momentarily missing
 * access token — does not incorrectly show the user as logged out.
 */
export function isLoggedIn(): boolean {
  return !!(getAccessToken() || getRefreshToken());
}

export function saveAuth(payload: {
  accessToken: string;
  refreshToken?: string | null;
  displayName?: string | null;
}): void {
  safeSet(STORAGE_KEYS.accessToken, payload.accessToken);
  safeSet(STORAGE_KEYS.accessTokenExpiry, String(Date.now() + ACCESS_TOKEN_TTL_MS));
  if (payload.refreshToken !== undefined) {
    safeSet(STORAGE_KEYS.refreshToken, payload.refreshToken);
  }
  if (payload.displayName !== undefined) {
    safeSet(STORAGE_KEYS.userDisplayName, payload.displayName);
  }
  scheduleProactiveRefresh();
  notify();
}

export function clearAuth(): void {
  safeSet(STORAGE_KEYS.accessToken, null);
  safeSet(STORAGE_KEYS.refreshToken, null);
  safeSet(STORAGE_KEYS.userDisplayName, null);
  safeSet(STORAGE_KEYS.accessTokenExpiry, null);
  cancelProactiveRefresh();
  notify();
}

function notify(): void {
  const value = isLoggedIn();
  listeners.forEach((fn) => {
    try {
      fn(value);
    } catch {
      /* swallow listener errors */
    }
  });
}

export function subscribeAuth(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ── Token refresh ──────────────────────────────────────────────────────────

let inflightRefresh: Promise<string | null> | null = null;
let proactiveRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function cancelProactiveRefresh(): void {
  if (proactiveRefreshTimer !== null) {
    clearTimeout(proactiveRefreshTimer);
    proactiveRefreshTimer = null;
  }
}

function scheduleProactiveRefresh(): void {
  cancelProactiveRefresh();
  const expiryStr = safeGet(STORAGE_KEYS.accessTokenExpiry);
  if (!expiryStr) return;
  const expiryMs = parseInt(expiryStr, 10);
  // Guard against corrupted storage: NaN here would make Math.max return NaN
  // and setTimeout fire immediately in a tight refresh loop.
  if (!Number.isFinite(expiryMs)) return;
  // Floor at 5 s so that an already-expired token (expiryMs in the past)
  // doesn't produce a delay of 0 and spin the refresh loop at maximum rate.
  const delay = Math.max(5_000, expiryMs - Date.now() - PROACTIVE_REFRESH_BEFORE_MS);
  proactiveRefreshTimer = setTimeout(() => {
    proactiveRefreshTimer = null;
    performRefresh().catch(() => {});
  }, delay);
}

async function performRefresh(): Promise<string | null> {
  const refreshToken = safeGet(STORAGE_KEYS.refreshToken);
  if (!refreshToken) return null;

  try {
    const { resolveApiOrigin } = await import("./api");
    const res = await fetch(`${resolveApiOrigin()}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken, deviceName: "Smart TV" }),
    });

    if (!res.ok) {
      // Only a genuine 401 means the refresh token was rejected by the server.
      // 5xx / network errors are transient — leave stored tokens intact so the
      // next API call can retry; do NOT sign the user out.
      if (res.status === 401) {
        clearAuth();
      }
      return null;
    }

    const data = (await res.json()) as { accessToken: string; refreshToken: string };
    saveAuth({ accessToken: data.accessToken, refreshToken: data.refreshToken });
    return data.accessToken;
  } catch {
    // Network error — transient, leave stored tokens intact.
    return null;
  }
}

export async function refreshAccessToken(): Promise<string | null> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = performRefresh().finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

/**
 * Authenticated fetch wrapper for the TV app.
 * Attaches the current access token and transparently rotates it on 401.
 */
export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = getAccessToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let resolvedOrigin = typeof window !== "undefined" ? window.location.origin : "";
  try {
    const { resolveApiOrigin } = await import("./api");
    resolvedOrigin = resolveApiOrigin();
  } catch { /* fallback to window.location.origin */ }
  const url = typeof input === "string" && !input.startsWith("http")
    ? `${resolvedOrigin}${input}`
    : input;

  const res = await fetch(url, { ...init, headers });

  if (res.status !== 401) return res;

  // Try to refresh and retry once.
  const newToken = await refreshAccessToken();
  if (!newToken) return res;

  const retryHeaders = new Headers(init?.headers);
  retryHeaders.set("Authorization", `Bearer ${newToken}`);
  return fetch(url, { ...init, headers: retryHeaders });
}

// Kick off proactive refresh on module load if already authenticated.
// If only a refresh token is present (access token missing/expired), force an
// immediate refresh so the first API call has a valid access token ready.
if (typeof window !== "undefined") {
  if (getRefreshToken() && !getAccessToken()) {
    // No access token in storage — refresh immediately so subsequent API calls
    // have a valid bearer token without waiting for the first 401.
    performRefresh().catch(() => {});
  } else if (isLoggedIn()) {
    scheduleProactiveRefresh();
  }
}
