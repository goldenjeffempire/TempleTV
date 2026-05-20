import { Platform } from "react-native";
import { secureStorage } from "@/lib/secureStorage";
import { STORAGE_KEYS } from "@/constants/config";
import { getApiBase } from "@/lib/apiBase";

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
    const res = await fetch(`${getApiBase()}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken, deviceName: getDeviceName() }),
    });
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

async function authFetch(path: string, options: RequestInit = {}): Promise<Response> {
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
  const initial = await fetch(url, { ...options, headers: buildHeaders(token) });
  // Auto-refresh on 401 for any authenticated route except the auth endpoints
  // themselves (where 401 means bad credentials, not an expired access token).
  if (initial.status !== 401 || path.startsWith("/api/auth/")) return initial;
  const newToken = await refreshAccessToken();
  if (!newToken) return initial;
  return fetch(url, { ...options, headers: buildHeaders(newToken) });
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
  const res = await fetch(`${getApiBase()}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, displayName, deviceName: getDeviceName() }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Signup failed");
  await persistAuthResponse(data as AuthResponse);
  return data as AuthResponse;
}

export async function apiLogin(
  email: string,
  password: string,
): Promise<AuthResponse> {
  const res = await fetch(`${getApiBase()}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, deviceName: getDeviceName() }),
  });
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
  if (!res.ok) throw new Error(data.error ?? "Failed to fetch user");
  return (data as { user: AuthUser }).user;
}

export async function apiUpdateProfile(displayName: string): Promise<AuthUser> {
  const res = await authFetch("/api/auth/profile", {
    method: "PATCH",
    body: JSON.stringify({ displayName }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to update profile");
  return (data as { user: AuthUser }).user;
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
