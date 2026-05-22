import { Platform } from "react-native";
import { secureStorage } from "@/lib/secureStorage";
import { STORAGE_KEYS } from "@/constants/config";
import { getApiBase } from "@/lib/apiBase";
import { fetchWithRetry } from "@/lib/fetchWithRetry";

// Auth endpoints only retry on 5xx — 4xx responses (wrong credentials, token
// expired, account locked, etc.) are intentional server rejections that should
// surface to the caller immediately, not be silently retried.
const AUTH_RETRY = { maxRetries: 2, baseDelayMs: 400, isRetryable: (r: Response) => r.status >= 500 };

/**
 * Thrown by apiGetMe() when the server returns 404 — meaning the JWT is
 * structurally valid and the auth middleware accepted it, but the user row
 * no longer exists in the database (e.g. account deleted, DB re-seeded).
 *
 * AuthContext catches this to clear the stale session and sign the user out
 * rather than silently keeping them in a logged-in-but-broken state.
 */
export class UserNotFoundError extends Error {
  constructor() {
    super("User account not found. Please sign in again.");
    this.name = "UserNotFoundError";
  }
}

function getDeviceName(): string {
  const os = Platform.OS;
  if (os === "ios") return "iPhone / iPad";
  if (os === "android") return "Android Device";
  return "Mobile App";
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  emailVerified: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
}

export interface AuthResponse extends AuthTokens {
  /** Back-compat field also returned by the server. */
  token: string;
  user: AuthUser;
}

// ── Refresh-token coordination ───────────────────────────────────────────
// Multiple in-flight requests may simultaneously hit a 401. We dedupe the
// refresh into a single network call and let everyone await the same result.
let inflightRefresh: Promise<string | null> | null = null;
// Allow the AuthContext to react when the refresh permanently fails (forces
// signOut in the UI without circular imports).
let onSessionExpired: (() => void) | null = null;
export function setOnSessionExpired(handler: (() => void) | null): void {
  onSessionExpired = handler;
}

async function attemptRefresh(): Promise<string | null> {
  const refreshToken = await secureStorage.getItem(STORAGE_KEYS.authRefreshToken);
  if (!refreshToken) return null;
  try {
    const res = await fetchWithRetry(
      `${getApiBase()}/api/auth/refresh`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken, deviceName: getDeviceName() }),
        signal: AbortSignal.timeout(12_000),
      },
      AUTH_RETRY,
    );
    if (!res.ok) {
      // Only treat a genuine 401 as a permanently invalid token — that means
      // the server explicitly rejected the refresh token (expired or revoked).
      // Any other failure (5xx, network timeout caught below) is transient and
      // should NOT wipe the stored session; the next request will retry.
      if (res.status === 401) {
        await Promise.all([
          secureStorage.removeItem(STORAGE_KEYS.authToken),
          secureStorage.removeItem(STORAGE_KEYS.authRefreshToken),
        ]);
        onSessionExpired?.();
      }
      return null;
    }
    const data = (await res.json()) as { accessToken: string; refreshToken: string };
    await Promise.all([
      secureStorage.setItem(STORAGE_KEYS.authToken, data.accessToken),
      secureStorage.setItem(STORAGE_KEYS.authRefreshToken, data.refreshToken),
    ]);
    return data.accessToken;
  } catch {
    // Network / parse error — transient, leave stored tokens intact.
    return null;
  }
}

async function refreshAccessToken(): Promise<string | null> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = attemptRefresh().finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

/**
 * Authenticated fetch with automatic 401 → token-refresh → retry cycle.
 * Exported so other API modules (e.g. services/api.ts) can reuse the full
 * auth lifecycle without duplicating the refresh-coordination logic here.
 * Internal callers and external callers both go through the same
 * single-flight inflightRefresh deduplication.
 */
export async function authFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = await secureStorage.getItem(STORAGE_KEYS.authToken);
  const buildHeaders = (t: string | null): Record<string, string> => {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    };
    if (t) h.Authorization = `Bearer ${t}`;
    return h;
  };
  const url = `${getApiBase()}${path}`;
  // 12-second timeout on every auth fetch — prevents indefinite hangs on bad
  // network conditions (tunnel timeouts, captive portals, etc.).
  const signal = options.signal ?? AbortSignal.timeout(12_000);
  // Retry on network errors and 5xx; never retry 401/403 — those go through
  // the token-refresh path below, not the retry path.
  const initial = await fetchWithRetry(url, { ...options, signal, headers: buildHeaders(token) }, AUTH_RETRY);
  // Auto-refresh on 401 for any authenticated route except the auth endpoints
  // themselves (where 401 means bad credentials, not an expired access token).
  if (initial.status !== 401 || path.startsWith("/api/auth/")) return initial;
  const newToken = await refreshAccessToken();
  if (!newToken) return initial;
  return fetchWithRetry(url, { ...options, signal: AbortSignal.timeout(12_000), headers: buildHeaders(newToken) }, AUTH_RETRY);
}

async function persistAuthResponse(data: AuthResponse): Promise<void> {
  await Promise.all([
    secureStorage.setItem(STORAGE_KEYS.authToken, data.accessToken ?? data.token),
    data.refreshToken
      ? secureStorage.setItem(STORAGE_KEYS.authRefreshToken, data.refreshToken)
      : Promise.resolve(),
  ]);
}

export async function apiSignup(
  email: string,
  password: string,
  displayName: string,
): Promise<AuthResponse> {
  const res = await fetchWithRetry(
    `${getApiBase()}/api/auth/register`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, displayName, deviceName: getDeviceName() }),
      signal: AbortSignal.timeout(12_000),
    },
    AUTH_RETRY,
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Signup failed");
  await persistAuthResponse(data as AuthResponse);
  return data as AuthResponse;
}

export async function apiLogin(
  email: string,
  password: string,
): Promise<AuthResponse> {
  const res = await fetchWithRetry(
    `${getApiBase()}/api/auth/login`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, deviceName: getDeviceName() }),
      signal: AbortSignal.timeout(12_000),
    },
    AUTH_RETRY,
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Login failed");
  await persistAuthResponse(data as AuthResponse);
  return data as AuthResponse;
}

export async function apiLogout(everywhere = false): Promise<void> {
  const refreshToken = await secureStorage.getItem(STORAGE_KEYS.authRefreshToken);
  // Best-effort server revocation; never block local sign-out on network failure.
  try {
    await authFetch("/api/auth/logout", {
      method: "POST",
      body: JSON.stringify({ refreshToken, everywhere }),
    });
  } catch {
    /* swallow */
  }
  await Promise.all([
    secureStorage.removeItem(STORAGE_KEYS.authToken),
    secureStorage.removeItem(STORAGE_KEYS.authRefreshToken),
  ]);
}

export async function apiGetMe(): Promise<AuthUser> {
  const res = await authFetch("/api/auth/me");
  const data = await res.json();
  if (res.status === 404) {
    // The JWT was accepted (auth middleware ran) but the user row is gone —
    // most likely the DB was re-seeded or the account was deleted. Throw a
    // typed error so AuthContext can clear the stale session automatically.
    throw new UserNotFoundError();
  }
  if (!res.ok) throw new Error(data.error ?? "Failed to fetch user");
  // /api/auth/me returns user fields at the top level (not nested under "user")
  const u = data as { id: string; email: string; displayName: string; avatarUrl?: string | null; emailVerified?: boolean };
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName ?? "",
    avatarUrl: u.avatarUrl ?? null,
    emailVerified: u.emailVerified ?? false,
  };
}

export async function apiUpdateProfile(displayName: string): Promise<AuthUser> {
  const res = await authFetch("/api/auth/profile", {
    method: "PATCH",
    body: JSON.stringify({ displayName }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to update profile");
  // PATCH /api/auth/profile returns user fields at the top level (not nested under "user")
  const u = data as { id: string; email: string; displayName: string; avatarUrl?: string | null; emailVerified?: boolean };
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName ?? "",
    avatarUrl: u.avatarUrl ?? null,
    emailVerified: u.emailVerified ?? false,
  };
}

export async function apiSyncFavorite(action: "add" | "remove", video: {
  videoId: string;
  videoTitle: string;
  videoThumbnail: string;
  videoCategory: string;
}): Promise<void> {
  if (action === "add") {
    await authFetch("/api/user/favorites", {
      method: "POST",
      body: JSON.stringify(video),
    });
  } else {
    await authFetch(`/api/user/favorites/${video.videoId}`, { method: "DELETE" });
  }
}

export async function apiSyncHistory(video: {
  videoId: string;
  videoTitle: string;
  videoThumbnail: string;
  videoCategory: string;
  progressSecs?: number;
}): Promise<void> {
  await authFetch("/api/user/history", {
    method: "POST",
    body: JSON.stringify(video),
  });
}

export async function apiClearHistory(): Promise<void> {
  await authFetch("/api/user/history", { method: "DELETE" });
}

export interface CloudFavorite {
  id: string;
  videoId: string;
  videoTitle: string;
  videoThumbnail: string;
  videoCategory: string;
  createdAt: string;
}

export interface CloudHistoryEntry {
  id: string;
  videoId: string;
  videoTitle: string;
  videoThumbnail: string;
  videoCategory: string;
  progressSecs: number;
  watchedAt: string;
}

export async function apiGetFavorites(): Promise<CloudFavorite[]> {
  const res = await authFetch("/api/user/favorites");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to fetch favorites");
  return (data as { favorites: CloudFavorite[] }).favorites ?? [];
}

export async function apiGetHistory(): Promise<CloudHistoryEntry[]> {
  const res = await authFetch("/api/user/history");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to fetch history");
  return (data as { history: CloudHistoryEntry[] }).history ?? [];
}

export async function apiChangePassword(currentPassword: string, newPassword: string): Promise<void> {
  const res = await authFetch("/api/auth/password", {
    method: "PATCH",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to change password");
}
