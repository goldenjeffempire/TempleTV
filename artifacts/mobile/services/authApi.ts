import { Platform } from "react-native";
import { secureStorage } from "@/lib/secureStorage";
import { STORAGE_KEYS, SECURE_KEYS } from "@/constants/config";
import { getApiBase } from "@/lib/apiBase";
import { fetchWithRetry } from "@/lib/fetchWithRetry";

// Auth endpoints only retry on 5xx — 4xx responses (wrong credentials, token
// expired, account locked, etc.) are intentional server rejections that should
// surface to the caller immediately, not be silently retried.
const AUTH_RETRY = { maxRetries: 2, baseDelayMs: 400, isRetryable: (r: Response) => r.status >= 500 };

// Proactive refresh: when an access token has < this many seconds remaining,
// the next authFetch() will refresh BEFORE making the call instead of waiting
// for a 401 round-trip. Eliminates the perceptible glitch around token expiry.
const PROACTIVE_REFRESH_WINDOW_SECONDS = 90;

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

/**
 * Thrown by apiLogin when the server requires a second factor (TOTP).
 * The UI catches this and prompts the user for their 6-digit code.
 */
export class MfaRequiredError extends Error {
  mfaToken: string;
  constructor(mfaToken: string) {
    super("Multi-factor authentication required.");
    this.name = "MfaRequiredError";
    this.mfaToken = mfaToken;
  }
}

function getDeviceName(): string {
  const os = Platform.OS;
  if (os === "ios") return "iPhone / iPad";
  if (os === "android") return "Android Device";
  return "Mobile App";
}

/**
 * Best-effort decode of a JWT's `exp` claim (seconds-since-epoch). Returns
 * null if the token is malformed. We do NOT verify the signature — clients
 * cannot, and don't need to: the worst case of a bogus exp is a redundant
 * proactive refresh which the server will reject if the token is bad.
 */
function decodeJwtExp(token: string): number | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    // RN has no atob in all engines — use Buffer/global fallback.
    const g = globalThis as typeof globalThis & {
      atob?: (s: string) => string;
      Buffer?: { from(s: string, enc: string): { toString(enc: string): string } };
    };
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "===".slice((base64.length + 3) % 4);
    const json = typeof g.atob === "function"
      ? g.atob(padded)
      : (typeof g.Buffer !== "undefined" ? g.Buffer.from(padded, "base64").toString("utf8") : null);
    if (!json) return null;
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

function isAccessTokenNearExpiry(token: string | null): boolean {
  if (!token) return false;
  const exp = decodeJwtExp(token);
  if (exp == null) return false;
  return exp - Math.floor(Date.now() / 1000) < PROACTIVE_REFRESH_WINDOW_SECONDS;
}

/**
 * Extract a human-readable error message from a fetch Response that we
 * believe is an error. Handles every envelope the server might produce:
 *   { error: "string" }
 *   { error: { message: "..." } }
 *   { message: "..." }
 *   { detail: "..." }                              (FastAPI / RFC7807 style)
 *   { error: { code: "...", message: "...", details: {...} } }
 *   plain text body
 * Falls back to status-based copy on a 5xx so the user never sees raw JSON.
 */
async function extractApiError(res: Response, fallback: string): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return fallback;
    try {
      const data = JSON.parse(text) as unknown;
      if (data && typeof data === "object") {
        const d = data as Record<string, unknown>;
        if (typeof d.message === "string" && d.message) return d.message;
        if (typeof d.detail === "string" && d.detail) return d.detail;
        if (typeof d.error === "string" && d.error) return d.error;
        if (d.error && typeof d.error === "object") {
          const e = d.error as Record<string, unknown>;
          if (typeof e.message === "string" && e.message) return e.message;
        }
      }
      return fallback;
    } catch {
      return text.length < 200 ? text : fallback;
    }
  } catch {
    if (res.status === 429) return "Too many attempts. Please wait a moment and try again.";
    if (res.status >= 500) return "Server is temporarily unavailable. Please try again shortly.";
    return fallback;
  }
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

/** Raw shape returned by /login, /signup, /me, and /profile endpoints. */
interface RawAuthUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string | null;
  emailVerified?: boolean;
}

/**
 * Normalize a raw API user object into a stable {@link AuthUser}.
 * Exported so every entry point (login, signup, /me, profile update,
 * and AuthContext.signIn) produces the EXACT same shape — no undefined
 * fields that flip between sessions, no rerender flicker.
 */
export function normalizeAuthUser(raw: RawAuthUser): AuthUser {
  return {
    id: raw.id,
    email: raw.email,
    displayName: raw.displayName ?? "",
    avatarUrl: raw.avatarUrl ?? null,
    emailVerified: raw.emailVerified ?? false,
  };
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
  const refreshToken = await secureStorage.getItem(SECURE_KEYS.authRefreshToken);
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
          secureStorage.removeItem(SECURE_KEYS.authToken),
          secureStorage.removeItem(SECURE_KEYS.authRefreshToken),
        ]);
        onSessionExpired?.();
      }
      return null;
    }
    const data = (await res.json()) as { accessToken: string; refreshToken: string };
    await Promise.all([
      secureStorage.setItem(SECURE_KEYS.authToken, data.accessToken),
      secureStorage.setItem(SECURE_KEYS.authRefreshToken, data.refreshToken),
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

/** Public hook used by AuthContext to force a refresh on app resume. */
export async function ensureFreshAccessToken(): Promise<string | null> {
  const current = await secureStorage.getItem(SECURE_KEYS.authToken);
  if (current && !isAccessTokenNearExpiry(current)) return current;
  return refreshAccessToken();
}

/**
 * Authenticated fetch with automatic 401 → token-refresh → retry cycle plus
 * proactive refresh when the access token is within 90 s of expiry.
 *
 * Exported so other API modules (e.g. services/api.ts) can reuse the full
 * auth lifecycle without duplicating the refresh-coordination logic here.
 * Internal callers and external callers both go through the same
 * single-flight inflightRefresh deduplication.
 */
export async function authFetch(path: string, options: RequestInit = {}): Promise<Response> {
  let token = await secureStorage.getItem(SECURE_KEYS.authToken);
  // Proactive refresh: if we already know the token is about to expire,
  // swap it for a fresh one BEFORE making the call. Eliminates the
  // 401-then-retry round-trip in the steady state.
  if (token && isAccessTokenNearExpiry(token) && !path.startsWith("/api/auth/refresh")) {
    const fresh = await refreshAccessToken();
    if (fresh) token = fresh;
  }
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
    secureStorage.setItem(SECURE_KEYS.authToken, data.accessToken ?? data.token),
    data.refreshToken
      ? secureStorage.setItem(SECURE_KEYS.authRefreshToken, data.refreshToken)
      : Promise.resolve(),
  ]);
}

// ── Client-side validators ────────────────────────────────────────────────
// Cheap pre-checks that avoid burning a server round-trip + rate-limit slot
// on obviously-malformed input. The server still validates everything.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}
export function validatePasswordStrength(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters long.";
  if (password.length > 128) return "Password cannot be longer than 128 characters.";
  // Trivial password sanity: server allows it but it's hostile to the user.
  if (/^(.)\1+$/.test(password)) return "Please choose a less predictable password.";
  return null;
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
  if (!res.ok) throw new Error(await extractApiError(res, "Sign up failed. Please try again."));
  const data = (await res.json()) as AuthResponse;
  await persistAuthResponse(data);
  return data;
}

export async function apiLogin(
  email: string,
  password: string,
  totpCode?: string,
): Promise<AuthResponse> {
  const body: Record<string, unknown> = { email, password, deviceName: getDeviceName() };
  if (totpCode) body.totpCode = totpCode;
  const res = await fetchWithRetry(
    `${getApiBase()}/api/auth/login`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    },
    AUTH_RETRY,
  );
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("Incorrect email or password. Please try again.");
    }
    if (res.status === 429) {
      throw new Error("Too many sign-in attempts. Please wait a minute and try again.");
    }
    throw new Error(await extractApiError(res, "Sign in failed. Please try again."));
  }
  const data = (await res.json()) as AuthResponse | { mfaRequired: true; mfaToken: string };
  if ("mfaRequired" in data && data.mfaRequired) {
    throw new MfaRequiredError((data as { mfaToken: string }).mfaToken);
  }
  await persistAuthResponse(data as AuthResponse);
  return data as AuthResponse;
}

/**
 * Complete MFA login — exchange a short-lived `mfaToken` (returned by the
 * initial sign-in when 2FA is enabled) plus a 6-digit TOTP code for a real
 * access + refresh token pair.
 */
export async function apiLoginVerifyMfa(
  mfaToken: string,
  totpCode: string,
): Promise<AuthResponse> {
  const res = await fetchWithRetry(
    `${getApiBase()}/api/auth/mfa/verify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mfaToken, totpCode }),
      signal: AbortSignal.timeout(12_000),
    },
    AUTH_RETRY,
  );
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("Incorrect verification code. Please try again.");
    }
    if (res.status === 429) {
      throw new Error("Too many attempts. Please wait and try again.");
    }
    throw new Error(await extractApiError(res, "Verification failed. Please try again."));
  }
  const data = (await res.json()) as AuthResponse;
  await persistAuthResponse(data);
  return data;
}

export async function apiLogout(everywhere = false): Promise<void> {
  const refreshToken = await secureStorage.getItem(SECURE_KEYS.authRefreshToken);
  // Best-effort server revocation; never block local sign-out on network
  // failure. Use a tight 4 s timeout — we never want the user staring at a
  // spinner on the way OUT of the app.
  try {
    await fetchWithRetry(
      `${getApiBase()}/api/auth/logout`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken, everywhere }),
        signal: AbortSignal.timeout(4_000),
      },
      { maxRetries: 0, baseDelayMs: 0, isRetryable: () => false },
    );
  } catch {
    /* swallow */
  }
  await Promise.all([
    secureStorage.removeItem(SECURE_KEYS.authToken),
    secureStorage.removeItem(SECURE_KEYS.authRefreshToken),
  ]);
}

export async function apiGetMe(): Promise<AuthUser> {
  const res = await authFetch("/api/auth/me");
  if (res.status === 404) {
    // The JWT was accepted (auth middleware ran) but the user row is gone —
    // most likely the DB was re-seeded or the account was deleted. Throw a
    // typed error so AuthContext can clear the stale session automatically.
    throw new UserNotFoundError();
  }
  if (!res.ok) throw new Error(await extractApiError(res, "Failed to fetch user"));
  return normalizeAuthUser((await res.json()) as RawAuthUser);
}

export async function apiUpdateProfile(displayName: string): Promise<AuthUser> {
  const res = await authFetch("/api/auth/profile", {
    method: "PATCH",
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) throw new Error(await extractApiError(res, "Failed to update profile"));
  return normalizeAuthUser((await res.json()) as RawAuthUser);
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
  if (!res.ok) throw new Error(await extractApiError(res, "Failed to fetch favorites"));
  const data = (await res.json()) as { favorites: CloudFavorite[] };
  return data.favorites ?? [];
}

export async function apiGetHistory(): Promise<CloudHistoryEntry[]> {
  const res = await authFetch("/api/user/history");
  if (!res.ok) throw new Error(await extractApiError(res, "Failed to fetch history"));
  const data = (await res.json()) as { history: CloudHistoryEntry[] };
  return data.history ?? [];
}

/**
 * Thrown by apiChangePassword when the account has MFA enabled and no (or an
 * invalid) TOTP code was supplied. The UI catches this to prompt for the
 * 6-digit code and retry, rather than surfacing a dead-end generic error.
 */
export class ChangePasswordMfaRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangePasswordMfaRequiredError";
  }
}

export async function apiChangePassword(
  currentPassword: string,
  newPassword: string,
  totpCode?: string,
): Promise<void> {
  const body: Record<string, unknown> = { currentPassword, newPassword };
  if (totpCode) body.totpCode = totpCode;
  const res = await authFetch("/api/auth/password", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const message = await extractApiError(res, "Failed to change password");
    // Server signals the MFA-enabled case with a 401 and this exact message —
    // matched here so the UI can distinguish "wrong current password" (also a
    // 401) from "need a TOTP code" and prompt accordingly instead of just
    // failing.
    if (res.status === 401 && /totp code/i.test(message)) {
      throw new ChangePasswordMfaRequiredError(message);
    }
    throw new Error(message);
  }
}

/**
 * Request a password-reset email. Always resolves successfully on 202 —
 * the server intentionally does not disclose whether the email is registered
 * (prevents email enumeration).
 */
export async function apiForgotPassword(email: string): Promise<void> {
  const res = await fetchWithRetry(
    `${getApiBase()}/api/auth/forgot-password`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(12_000),
    },
    AUTH_RETRY,
  );
  // 202 is the only success — anything else is an error worth surfacing.
  if (res.status === 202) return;
  if (res.status === 429) {
    throw new Error("Too many reset requests. Please wait a minute and try again.");
  }
  throw new Error(await extractApiError(res, "Couldn't send reset email. Please try again."));
}

/**
 * Complete a password reset using the token from the email link.
 */
export async function apiResetPassword(token: string, newPassword: string): Promise<void> {
  const res = await fetchWithRetry(
    `${getApiBase()}/api/auth/reset-password`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword }),
      signal: AbortSignal.timeout(12_000),
    },
    AUTH_RETRY,
  );
  if (!res.ok) {
    if (res.status === 400 || res.status === 410) {
      throw new Error("This reset link is invalid or has expired. Please request a new one.");
    }
    throw new Error(await extractApiError(res, "Couldn't reset password. Please try again."));
  }
}

/**
 * Permanently delete the authenticated user's account. Requires the
 * current password as a confirmation step. App / Play Store compliance.
 */
export async function apiDeleteAccount(currentPassword: string): Promise<void> {
  const res = await authFetch("/api/auth/account", {
    method: "DELETE",
    body: JSON.stringify({ currentPassword }),
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error("Incorrect password. Please try again.");
    throw new Error(await extractApiError(res, "Couldn't delete account. Please try again."));
  }
  // Wipe local credentials immediately — the server already revoked the
  // refresh tokens via cascade delete, but we must not leave them on disk.
  await Promise.all([
    secureStorage.removeItem(SECURE_KEYS.authToken),
    secureStorage.removeItem(SECURE_KEYS.authRefreshToken),
  ]);
}
