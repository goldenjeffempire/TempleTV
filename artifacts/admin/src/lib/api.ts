import { apiBase } from "./api-base";
import { apiErrorBus } from "./api-error-bus";

const ACCESS_KEY = "ttv_access";
const REFRESH_KEY = "ttv_refresh";

// ── BroadcastChannel — cross-tab token synchronisation ───────────────────────
//
// Problem being solved:
//   Two admin tabs open with the same refresh token. Tab A's keep-alive rotates
//   the token first. Tab B then presents the (now-revoked) old token and gets a
//   401, which without coordination would fire ttv:auth-expired and log out Tab B
//   mid-session.
//
// Solution:
//   After every successful refresh/extend this tab broadcasts the new access+
//   refresh pair to all other authenticated admin tabs. A receiving tab updates
//   its own sessionStorage immediately, so by the time its next keep-alive fires
//   it holds the current token and the rotation race is avoided.
//
//   Additionally, the 401 handler waits a brief grace period after a hard-auth
//   failure before firing ttv:auth-expired. If a BC message arrives during that
//   window, the handler retries with the synced token instead of logging out.

type BcMsg =
  | { t: "tokens"; access: string; refresh: string }
  | { t: "ping" };

const _bc: BroadcastChannel | null = (() => {
  try {
    return typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel("ttv:session-v1")
      : null;
  } catch {
    return null;
  }
})();

// Incremented every time tokens are written to sessionStorage (locally or via
// a BC message from another tab). The 401 handler snapshots this before the
// grace-period wait and compares it after — if it changed, fresh tokens arrived
// from a sibling tab and the request can be retried without forcing a logout.
let _tokenVersion = 0;

// ── Error type ────────────────────────────────────────────────────────────────

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    /**
     * Milliseconds to wait before retrying, parsed from the server's
     * `Retry-After` response header on 429 responses. Undefined when
     * the header was absent or the response was not a 429.
     */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// ── Token store ───────────────────────────────────────────────────────────────
//
// Tokens live in sessionStorage so they are naturally scoped to the browser
// tab. Closing the tab, opening a brand-new tab, or doing a full browser
// refresh (F5 / Cmd+R) all clear sessionStorage and end the session — exactly
// the intended expiry policy for an enterprise admin console.
//
// Cross-tab sync is handled by the BroadcastChannel above: when Tab A extends
// or rotates a token it broadcasts the new pair; Tab B's onmessage handler
// writes it to its own sessionStorage so both tabs converge on the same active
// token pair.

export const tokenStore = {
  getAccess: (): string => sessionStorage.getItem(ACCESS_KEY) ?? "",
  getRefresh: (): string => sessionStorage.getItem(REFRESH_KEY) ?? "",
  setAccess: (t: string) => {
    sessionStorage.setItem(ACCESS_KEY, t);
    _tokenVersion++;
  },
  setRefresh: (t: string) => {
    sessionStorage.setItem(REFRESH_KEY, t);
  },
  clear: () => {
    sessionStorage.removeItem(ACCESS_KEY);
    sessionStorage.removeItem(REFRESH_KEY);
    _tokenVersion++;
  },
};

// Wire up inbound cross-tab token sync.
if (_bc) {
  _bc.onmessage = (ev: MessageEvent<BcMsg>) => {
    if (ev.data.t !== "tokens") return;
    const { access, refresh } = ev.data;
    // Only adopt new tokens if this tab already has an active session.
    // This prevents an unauthenticated tab from being auto-logged-in by a
    // sibling tab's rotation broadcast.
    if (!sessionStorage.getItem(ACCESS_KEY) && !sessionStorage.getItem(REFRESH_KEY)) return;
    sessionStorage.setItem(ACCESS_KEY, access);
    sessionStorage.setItem(REFRESH_KEY, refresh);
    _tokenVersion++;
  };
}

// ── Upload-activity probe ─────────────────────────────────────────────────────
// Registered by session-activity.ts to avoid a circular import.

let _uploadActiveProbe: () => boolean = () => false;
export function registerUploadActiveProbe(fn: () => boolean): void {
  _uploadActiveProbe = fn;
}
function _isUploadActive(): boolean {
  try { return _uploadActiveProbe(); } catch { return false; }
}

// ── Auth-expired event — deduplicated ────────────────────────────────────────
//
// Multiple concurrent requests can all hit 401 simultaneously and each try to
// fire ttv:auth-expired. The guard ensures only one dispatch happens per
// session-expiry event. It resets after 5 s so a subsequent login + re-expiry
// behaves normally.

let _authExpiredPending = false;

function _dispatchAuthExpired(): void {
  if (_authExpiredPending) return;
  _authExpiredPending = true;
  window.dispatchEvent(new Event("ttv:auth-expired"));
  setTimeout(() => { _authExpiredPending = false; }, 5_000);
}

// ── Token operations ──────────────────────────────────────────────────────────

/**
 * Non-rotating keep-alive: validates the refresh token and issues a new access
 * token WITHOUT revoking the refresh token. Used by the proactive keep-alive so
 * normal session maintenance never creates a rotation race between concurrent
 * admin tabs.
 *
 * Only rotates when the refresh token has < 7 days remaining (the server
 * handles this transparently — the response will include a new refreshToken
 * only when rotation happened).
 *
 * Network / transient failures throw HttpError(0 / 5xx) — callers must NOT
 * clear the session on these; the next keep-alive tick will retry.
 * Hard auth rejections throw HttpError(401 / 403) — the 401 handler path
 * applies the BC grace period before clearing the session.
 */
async function extendToken(): Promise<void> {
  const refreshToken = tokenStore.getRefresh();
  if (!refreshToken) throw new HttpError(401, "No refresh token");

  let res: Response;
  try {
    res = await fetch(`${apiBase()}/auth/extend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    // Pure network failure — do NOT clear session.
    throw new HttpError(0, "Network error during session extension");
  }

  // Transient server errors — let the interval retry.
  if (!res.ok && res.status !== 401 && res.status !== 403) {
    throw new HttpError(res.status, "Session extension failed (transient)");
  }

  // Hard rejection — refresh token is genuinely invalid.
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(res.status, "Session extension rejected");
  }

  const data = await res.json() as { accessToken: string; refreshToken?: string };
  const newRefresh = data.refreshToken ?? tokenStore.getRefresh();

  sessionStorage.setItem(ACCESS_KEY, data.accessToken);
  if (data.refreshToken) sessionStorage.setItem(REFRESH_KEY, data.refreshToken);
  _tokenVersion++;

  // Broadcast new tokens to sibling tabs.
  _bc?.postMessage({ t: "tokens", access: data.accessToken, refresh: newRefresh } satisfies BcMsg);
}

/**
 * Full rotation: presents the refresh token, the server revokes it and issues
 * a new refresh+access pair. Used by the reactive 401 recovery path (not the
 * proactive keep-alive). Rotation is correct here because the access token was
 * actually rejected — we want to confirm the refresh token is still live.
 */
async function refreshTokens(): Promise<void> {
  const refreshToken = tokenStore.getRefresh();
  if (!refreshToken) throw new HttpError(401, "No refresh token");

  let res: Response;
  try {
    res = await fetch(`${apiBase()}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    // Pure network failure — DO NOT clear the session. The admin stays signed
    // in; the next keep-alive tick or user action will retry automatically.
    throw new HttpError(0, "Network error during token refresh");
  }

  // Transient server errors (5xx, 429, 408) — let the interval retry.
  if (!res.ok && res.status !== 401 && res.status !== 403) {
    throw new HttpError(res.status, "Refresh failed (transient)");
  }

  // Hard rejection — the refresh token is genuinely invalid.
  // We intentionally do NOT clear sessionStorage here. Clearing is deferred
  // to the request() 401 handler AFTER the BroadcastChannel grace period
  // (see below), which prevents a false logout when another tab has already
  // rotated the token and is about to broadcast fresh credentials.
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(res.status, "Refresh rejected");
  }

  const data = await res.json() as { accessToken: string; refreshToken?: string };
  const newRefresh = data.refreshToken ?? tokenStore.getRefresh();

  // Persist new tokens locally.
  sessionStorage.setItem(ACCESS_KEY, data.accessToken);
  if (data.refreshToken) sessionStorage.setItem(REFRESH_KEY, newRefresh);
  _tokenVersion++;

  // Broadcast to sibling admin tabs so they adopt the new refresh token
  // before their next keep-alive attempt. This is the core of the cross-tab
  // rotation race fix: Tab B gets the new token within milliseconds of Tab A
  // rotating it, so Tab B never tries to use the old (now-revoked) one.
  _bc?.postMessage({ t: "tokens", access: data.accessToken, refresh: newRefresh } satisfies BcMsg);
}

// Shared promise slot — deduplicates concurrent token operations within the
// same tab. Both extend (proactive) and refresh (reactive 401) use this slot
// so they cannot race each other within a single tab.
let _refreshPromise: Promise<void> | null = null;

/**
 * Proactively ensure the JWT access token is fresh. Uses the non-rotating
 * /auth/extend endpoint so normal keep-alive never triggers a rotation race.
 *
 * Threshold raised from 8 min → 12 min to give a 3-tick safety margin above
 * the 3-min keep-alive interval, surviving aggressive browser background-tab
 * timer throttling (Chrome minimum: ~1 min) with ample headroom.
 *
 * Safe to call frequently — no-op when the token is still fresh, and
 * concurrent calls are deduplicated via the shared _refreshPromise singleton.
 */
export async function ensureFreshToken(): Promise<void> {
  const token = tokenStore.getAccess();
  if (!token) return;
  try {
    const parts = token.split(".");
    if (parts.length < 2) return;
    const payload = JSON.parse(
      atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { exp?: number };
    const expiresInMs = ((payload.exp ?? 0) * 1000) - Date.now();
    // 12-minute proactive window (was 8 min). With a 1-hour default access
    // token and a 3-minute keep-alive interval, this gives at least 3 check
    // opportunities per token lifetime even under aggressive timer throttling.
    if (expiresInMs < 12 * 60 * 1000) {
      if (!_refreshPromise) {
        // Non-rotating extend for the keep-alive path — no DB revoke write.
        _refreshPromise = extendToken().finally(() => { _refreshPromise = null; });
      }
      await _refreshPromise;
    }
  } catch {
    // Unparseable token — let the next request proceed; the 401 path recovers.
  }
}

/**
 * Force an immediate token refresh (full rotation) regardless of current token
 * freshness. Called by the upload engine after a 401 mid-chunk so the transfer
 * can continue without restarting the file from scratch.
 * Uses full rotation (not extend) because the access token was explicitly
 * rejected — we confirm the refresh token is still live.
 * Concurrent calls are deduplicated via the shared _refreshPromise singleton.
 */
export async function forceRefreshToken(): Promise<void> {
  if (!_refreshPromise) {
    _refreshPromise = refreshTokens().finally(() => { _refreshPromise = null; });
  }
  await _refreshPromise;
}

// ── Core fetch wrapper ────────────────────────────────────────────────────────

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = apiBase();
  const url = path.startsWith("http") ? path : `${base}${path}`;
  const method = ((init.method as string | undefined) ?? "GET").toUpperCase();
  const isMutation = !["GET", "HEAD", "OPTIONS"].includes(method);
  const isAdmin = path.includes("/admin/") || path.includes("/admin");

  const buildHeaders = (token: string): Headers => {
    const h = new Headers(init.headers);
    if (token) h.set("Authorization", `Bearer ${token}`);
    if (isMutation && isAdmin) h.set("X-Admin-CSRF", "1");
    if (isMutation && !h.has("Content-Type") && typeof init.body === "string") {
      h.set("Content-Type", "application/json");
    }
    return h;
  };

  const run = async (token: string): Promise<Response> =>
    fetch(url, { ...init, headers: buildHeaders(token), credentials: "include" });

  let res: Response;
  try {
    res = await run(tokenStore.getAccess());
  } catch {
    const netErr = new HttpError(0, "Could not reach the server — check your connection and try again.");
    apiErrorBus.emit({ path, status: 0, message: netErr.message, ts: Date.now() });
    throw netErr;
  }

  // ── 401 handling with cross-tab grace period ──────────────────────────────
  //
  // Flow:
  //   1. First attempt returned 401 with a non-empty access token → try refresh.
  //      Uses full rotation here (not extend) because the token was actively
  //      rejected — we need to confirm the refresh token is still live.
  //   2. If refresh succeeds → retry the request with the fresh token.
  //   3. If refresh fails with a hard auth error (401/403):
  //      a. Upload shield: suppress logout while uploads are in flight.
  //      b. BroadcastChannel grace period: wait 700 ms for a sibling tab's
  //         token broadcast. If _tokenVersion changed, another tab delivered
  //         fresh credentials — retry once with them.
  //      c. If no sync arrived after 700 ms → the session is genuinely
  //         expired. Clear tokens, fire ttv:auth-expired, throw.
  //   4. Soft / transient failure → fall through with the original 401
  //      response so callers see HttpError(401) without a forced logout.
  //
  // Note: if _refreshPromise currently holds an extendToken() call (from the
  // proactive keep-alive), we await that result first. If extend succeeded,
  // the retry will succeed. If extend failed hard, we handle it below.

  if (res.status === 401 && tokenStore.getAccess()) {
    if (!_refreshPromise) {
      // Reactive path: access token was explicitly rejected, use full rotation.
      _refreshPromise = refreshTokens().finally(() => { _refreshPromise = null; });
    }

    try {
      await _refreshPromise;
      // Refresh/extend succeeded — retry with the fresh access token.
      try {
        res = await run(tokenStore.getAccess());
      } catch {
        throw new HttpError(0, "Could not reach the server — check your connection and try again.");
      }
    } catch (err) {
      const isHardAuth =
        err instanceof HttpError && (err.status === 401 || err.status === 403);

      if (isHardAuth) {
        // Upload shield: mid-transfer chunks have their own retry/backoff.
        // Clearing the session now would destroy the credentials they need.
        if (_isUploadActive()) {
          throw new HttpError(401, "Session refresh rejected (uploads active — will retry)");
        }

        // BroadcastChannel grace period ─────────────────────────────────────
        //
        // If another tab just rotated the refresh token, its BC message is
        // already in-flight. BroadcastChannel is synchronous within the same
        // event loop but crosses the browser's inter-tab messaging infrastructure,
        // which typically delivers in < 100 ms. We wait 700 ms as a conservative
        // upper bound that accommodates slow channels, memory pressure, and
        // extension-injected content-script overhead.
        const vBefore = _tokenVersion;
        await new Promise<void>((resolve) => setTimeout(resolve, 700));

        if (_tokenVersion !== vBefore && tokenStore.getAccess()) {
          // Fresh tokens arrived from a sibling tab. Retry the original request.
          try {
            res = await run(tokenStore.getAccess());
            // If the BC-synced token is also rejected, the session is truly dead.
            if (res.status === 401 || res.status === 403) {
              tokenStore.clear();
              _dispatchAuthExpired();
              throw new HttpError(401, "Session expired");
            }
            // Otherwise fall through to the res.ok check below.
          } catch (runErr) {
            if (runErr instanceof HttpError) throw runErr;
            throw new HttpError(0, "Could not reach the server — check your connection and try again.");
          }
        } else {
          // No cross-tab sync within the grace period → session is genuinely
          // expired. Clear tokens and signal the auth context to redirect to login.
          tokenStore.clear();
          _dispatchAuthExpired();
          throw new HttpError(401, "Session expired");
        }
      }
      // Transient/soft failure (network, 5xx, 429) — do NOT clear the session.
      // Fall through with the original 401 response so the caller can surface
      // an appropriate error message. The keep-alive will retry on the next tick.
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    const errMsg = (body.detail as string) ?? (body.message as string) ?? (body.error as string) ?? res.statusText;

    // Parse Retry-After for 429 responses so callers (query retryDelay) can
    // honour the server's requested back-off instead of using a fixed delay.
    // Supports both delta-seconds ("120") and HTTP-date formats.
    let retryAfterMs: number | undefined;
    if (res.status === 429) {
      const header = res.headers.get("Retry-After");
      if (header) {
        const secs = Number(header);
        if (!isNaN(secs) && secs > 0) {
          retryAfterMs = secs * 1_000;
        } else {
          const ts = Date.parse(header);
          if (!isNaN(ts) && ts > Date.now()) {
            retryAfterMs = ts - Date.now();
          }
        }
      }
    }

    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      apiErrorBus.emit({ path, status: res.status, message: errMsg, ts: Date.now() });
    }
    throw new HttpError(res.status, errMsg, body.code as string | undefined, retryAfterMs);
  }

  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as unknown as T;
  }

  try {
    return await (res.json() as Promise<T>);
  } catch {
    throw new HttpError(
      res.status,
      "Server returned an unexpected response — please try again.",
    );
  }
}

/**
 * Returns true for network-level and server-startup errors that are typically
 * transient. Use this to render the softer amber "Reconnecting…" ErrorAlert
 * style instead of the destructive red banner.
 */
export function isTransientError(err: unknown): boolean {
  return (
    err instanceof HttpError &&
    (err.status === 0 ||
      err.status === 502 ||
      err.status === 503 ||
      err.status === 504)
  );
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body !== undefined ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: <T>(path: string, formData: FormData) =>
    request<T>(path, { method: "POST", body: formData }),
};
