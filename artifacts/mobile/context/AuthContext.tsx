import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import { secureStorage } from "@/lib/secureStorage";
import { STORAGE_KEYS, SECURE_KEYS } from "@/constants/config";
import {
  apiGetMe,
  apiLogout,
  ensureFreshAccessToken,
  setOnSessionExpired,
  UserNotFoundError,
  type AuthUser,
  type AuthResponse,
} from "@/services/authApi";
import { setAuthGateBindings, type PendingPlayback } from "@/utils/auth-gate";

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  isLoggedIn: boolean;
  /** True for ~3 s after onSessionExpired fired so the UI can show a toast. */
  sessionExpiredAt: number | null;
  /**
   * Persist the auth response from a login/signup call. Accepts either the
   * full {@link AuthResponse} (preferred) or, for backward-compat, a single
   * legacy access-token string.
   */
  signIn: (resp: AuthResponse | string, user: AuthUser) => Promise<void>;
  signOut: (everywhere?: boolean) => Promise<void>;
  /** Local-only wipe — used after a server-side account deletion. */
  forgetSession: () => Promise<void>;
  updateUser: (user: AuthUser) => void;
  // ── Gating modal state ────────────────────────────────────────────
  isAuthGateOpen: boolean;
  pendingPlayback: PendingPlayback | null;
  openAuthGate: (target: PendingPlayback) => void;
  closeAuthGate: (opts?: { keepPending?: boolean }) => void;
  consumePendingPlayback: () => PendingPlayback | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * In-app caches that hold user-scoped data and MUST be flushed on sign-out
 * so a second user signing in on the same device never sees the first
 * user's favorites/history/playlists. Keys must match what favourites /
 * history / playlists modules read.
 */
const USER_SCOPED_STORAGE_PREFIXES = [
  "@temple_tv/favorites",
  "@temple_tv/history",
  "@temple_tv/watch_history",
  "@temple_tv/playlists",
  // Individual playlist detail cache (usePlaylists.ts). Key format is
  // "@temple_tv/playlist_detail_v1:<id>" — the prefix "playlists" above
  // catches "playlists_v1" but NOT "playlist_detail_v1" (no 's').
  "@temple_tv/playlist_detail_v1",
  "@temple_tv/cloud_sync",
  // Video catalog cache (useVideos.ts CACHE_KEY) — must be cleared on sign-out
  // so a second user on the same device never sees the first user's cached library.
  "@temple_tv/videos_v2",
  // Per-video watch-position cache (useWatchProgress.ts). Keyed by video id,
  // so a second user on the same device must not inherit the first user's positions.
  "@temple_tv/watch_progress",
  // Recent search history (search.tsx RECENT_KEY). On a shared device a second
  // user must not see the first user's search queries (may reveal sensitive
  // prayer/sermon topics).
  "@temple_tv/recent_searches",
];

async function clearUserScopedCaches(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const toRemove = keys.filter((k) => USER_SCOPED_STORAGE_PREFIXES.some((p) => k.startsWith(p)));
    if (toRemove.length > 0) await AsyncStorage.multiRemove(toRemove);
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[AuthContext] Failed to clear user-scoped caches:", e);
    }
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthGateOpen, setAuthGateOpen] = useState(false);
  const [pendingPlayback, setPendingPlayback] = useState<PendingPlayback | null>(null);
  const [sessionExpiredAt, setSessionExpiredAt] = useState<number | null>(null);
  // Tracks whether we've already navigated to /login for the current
  // session-expiry event, to avoid stacking navigations.
  const expiryNavigatedRef = useRef(false);

  useEffect(() => {
    const restore = async () => {
      try {
        // Migration: legacy AsyncStorage token → SecureStore (one-time).
        const legacyToken = await AsyncStorage.getItem(STORAGE_KEYS.authToken);
        if (legacyToken) {
          await secureStorage.setItem(SECURE_KEYS.authToken, legacyToken);
          await AsyncStorage.removeItem(STORAGE_KEYS.authToken);
        }
        const legacyRefresh = await AsyncStorage.getItem(STORAGE_KEYS.authRefreshToken);
        if (legacyRefresh) {
          await secureStorage.setItem(SECURE_KEYS.authRefreshToken, legacyRefresh);
          await AsyncStorage.removeItem(STORAGE_KEYS.authRefreshToken);
        }
        const legacyUser = await AsyncStorage.getItem(STORAGE_KEYS.authUser);
        if (legacyUser) {
          await secureStorage.setItem(SECURE_KEYS.authUser, legacyUser);
          await AsyncStorage.removeItem(STORAGE_KEYS.authUser);
        }

        // Read credentials from SecureStore. On Android, the hardware-backed
        // keystore can be temporarily unavailable immediately after device
        // reboot (keystore daemon still warming up). Retry once with a short
        // delay before treating the exception as permanent — this prevents a
        // valid session from being silently dropped on every cold-boot.
        let storedToken: string | null = null;
        let storedRefresh: string | null = null;
        let storedUser: string | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            [storedToken, storedRefresh, storedUser] = await Promise.all([
              secureStorage.getItem(SECURE_KEYS.authToken),
              secureStorage.getItem(SECURE_KEYS.authRefreshToken),
              secureStorage.getItem(SECURE_KEYS.authUser),
            ]);
            break; // success — exit retry loop
          } catch (secErr) {
            if (attempt === 0) {
              // First failure: could be a transient keystore initialisation
              // race. Wait 500 ms and try once more.
              await new Promise<void>((r) => setTimeout(r, 500));
            } else {
              // Second failure: treat as permanent and propagate to the outer
              // catch so the user stays logged out rather than in an unknown
              // credential state.
              throw secErr;
            }
          }
        }

        const hasCredential = !!(storedToken || storedRefresh);
        if (!hasCredential) return;

        if (storedToken) setToken(storedToken);
        if (storedUser) {
          try {
            setUser(JSON.parse(storedUser) as AuthUser);
          } catch {
            /* corrupted cache — will be refetched below */
          }
        }

        // Proactively refresh the access token if it's near expiry BEFORE
        // making /me, so the user never sees a refresh round-trip on cold start.
        try {
          const fresh = await ensureFreshAccessToken();
          if (fresh && fresh !== storedToken) setToken(fresh);
        } catch {
          /* transient — apiGetMe will retry */
        }

        apiGetMe()
          .then((freshUser) => {
            setUser(freshUser);
            secureStorage.setItem(SECURE_KEYS.authUser, JSON.stringify(freshUser)).catch(() => {});
          })
          .catch(async (err: unknown) => {
            if (err instanceof UserNotFoundError) {
              await clearLocal();
            }
            // Transient (network/5xx) failures are swallowed — the cached
            // session stays usable. onSessionExpired fires separately for
            // genuine 401-permanent failures via authApi.
          });
      } catch {
        /* ignore restore errors — stay logged out */
      } finally {
        setIsLoading(false);
      }
    };
    restore();
  }, []);

  const clearLocal = useCallback(async () => {
    await Promise.all([
      secureStorage.removeItem(SECURE_KEYS.authToken),
      secureStorage.removeItem(SECURE_KEYS.authRefreshToken),
      secureStorage.removeItem(SECURE_KEYS.authUser),
      clearUserScopedCaches(),
    ]);
    setToken(null);
    setUser(null);
  }, []);

  // Wire authApi → context so a permanent refresh failure forces signOut
  // AND navigates the user to /login (otherwise they're stranded on an
  // authenticated screen with a "Not Signed In" empty state).
  useEffect(() => {
    setOnSessionExpired(() => {
      setSessionExpiredAt(Date.now());
      clearLocal().catch(() => {});
      if (!expiryNavigatedRef.current) {
        expiryNavigatedRef.current = true;
        // Defer one tick so any in-flight UI updates settle first.
        setTimeout(() => {
          try {
            router.replace("/login");
          } catch {
            /* router not ready — restore handler will pick up on next mount */
          }
          // Clear the flag after navigation so a future expiry can navigate again.
          setTimeout(() => { expiryNavigatedRef.current = false; }, 3000);
        }, 0);
      }
    });
    return () => setOnSessionExpired(null);
  }, [clearLocal]);

  // Re-check token freshness whenever the app comes back to the foreground.
  // Catches the case where the device was backgrounded long enough for the
  // access token to expire — refresh now so the first user action in the
  // resumed app doesn't hit a 401.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (next === "active" && user) {
        ensureFreshAccessToken().then((t) => {
          if (t) setToken(t);
        }).catch(() => {});
      }
    });
    return () => sub.remove();
  }, [user]);

  const signIn = useCallback(async (resp: AuthResponse | string, newUser: AuthUser) => {
    // authApi.apiLogin/apiSignup already persisted both tokens to SecureStore
    // when given an AuthResponse; we only need to mirror state and the user.
    const accessToken = typeof resp === "string" ? resp : (resp.accessToken ?? resp.token);
    if (typeof resp === "string") {
      await secureStorage.setItem(SECURE_KEYS.authToken, resp);
    }
    // Normalize the user object so a freshly-logged-in user has the EXACT
    // same shape as a user restored from /me on cold-start. The server's
    // /login response omits `avatarUrl` and `emailVerified` entirely (and
    // /me only includes them sometimes), so without this normalization the
    // user state object has `undefined` for those fields after login but
    // `null`/`false` after restart — React rerenders flicker and downstream
    // `user.emailVerified` checks behave inconsistently across sessions.
    // Match the defaults apiGetMe applies so all entry points produce
    // identical state.
    const normalizedUser: AuthUser = {
      id: newUser.id,
      email: newUser.email,
      displayName: newUser.displayName ?? "",
      avatarUrl: newUser.avatarUrl ?? null,
      emailVerified: newUser.emailVerified ?? false,
    };
    await secureStorage.setItem(SECURE_KEYS.authUser, JSON.stringify(normalizedUser));
    setToken(accessToken);
    setUser(normalizedUser);
    setSessionExpiredAt(null);
  }, []);

  const signOut = useCallback(async (everywhere = false) => {
    // Revoke the push token before clearing credentials. The DELETE endpoint
    // is unauthenticated (token = proof of ownership), but calling it first
    // while we still have the stored token in AsyncStorage ensures revocation
    // completes before the local storage is wiped. Best-effort: failure never
    // blocks sign-out.
    await import("@/services/notifications").then(({ unregisterCurrentPushToken }) =>
      unregisterCurrentPushToken(),
    ).catch(() => {});
    await apiLogout(everywhere).catch(() => {});
    await clearLocal();
    // Intentionally does NOT navigate — callers decide where to go because
    // the right destination is screen-specific (account.tsx → /(tabs)/settings;
    // settings.tsx → stay on the tab and re-render as logged-out). The
    // session-expiry path is the only flow that auto-navigates, because
    // there's no caller in control of that one.
  }, [clearLocal]);

  const forgetSession = useCallback(async () => {
    // Local-only wipe — server has already revoked the tokens (e.g. after
    // an account-delete call). Skips the network round-trip.
    await clearLocal();
  }, [clearLocal]);

  const updateUser = useCallback((updated: AuthUser) => {
    setUser(updated);
    secureStorage.setItem(SECURE_KEYS.authUser, JSON.stringify(updated)).catch(() => {});
  }, []);

  const openAuthGate = useCallback((target: PendingPlayback) => {
    setPendingPlayback(target);
    setAuthGateOpen(true);
  }, []);

  const closeAuthGate = useCallback((opts?: { keepPending?: boolean }) => {
    setAuthGateOpen(false);
    if (!opts?.keepPending) setPendingPlayback(null);
  }, []);

  const consumePendingPlayback = useCallback((): PendingPlayback | null => {
    let snapshot: PendingPlayback | null = null;
    setPendingPlayback((prev) => {
      snapshot = prev;
      return null;
    });
    return snapshot;
  }, []);

  const isLoggedIn = !!user;
  useEffect(() => {
    setAuthGateBindings({
      isLoggedIn,
      isLoading,
      openGate: openAuthGate,
    });
  }, [isLoggedIn, isLoading, openAuthGate]);

  useEffect(() => {
    if (isLoggedIn && isAuthGateOpen) setAuthGateOpen(false);
  }, [isLoggedIn, isAuthGateOpen]);

  // Memoize the context value so consumers only re-render when a value they
  // actually use changes, not on every AuthProvider render tick. Without this,
  // any auth state change (token refresh, sessionExpiredAt update, auth-gate
  // toggle) causes ALL context consumers — including V2PlayerContainer,
  // BroadcastBuffer, and every screen — to re-render unnecessarily.
  const contextValue = useMemo(
    () => ({
      user,
      token,
      isLoading,
      isLoggedIn,
      sessionExpiredAt,
      signIn,
      signOut,
      forgetSession,
      updateUser,
      isAuthGateOpen,
      pendingPlayback,
      openAuthGate,
      closeAuthGate,
      consumePendingPlayback,
    }),
    [
      user,
      token,
      isLoading,
      isLoggedIn,
      sessionExpiredAt,
      signIn,
      signOut,
      forgetSession,
      updateUser,
      isAuthGateOpen,
      pendingPlayback,
      openAuthGate,
      closeAuthGate,
      consumePendingPlayback,
    ],
  );

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
