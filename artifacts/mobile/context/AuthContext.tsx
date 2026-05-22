import React, { createContext, useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import { secureStorage } from "@/lib/secureStorage";
import { STORAGE_KEYS } from "@/constants/config";
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
  "@temple_tv/cloud_sync",
];

async function clearUserScopedCaches(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const toRemove = keys.filter((k) => USER_SCOPED_STORAGE_PREFIXES.some((p) => k.startsWith(p)));
    if (toRemove.length > 0) await AsyncStorage.multiRemove(toRemove);
  } catch {
    /* best-effort */
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
          await secureStorage.setItem(STORAGE_KEYS.authToken, legacyToken);
          await AsyncStorage.removeItem(STORAGE_KEYS.authToken);
        }
        const legacyUser = await AsyncStorage.getItem(STORAGE_KEYS.authUser);
        if (legacyUser) {
          await secureStorage.setItem(STORAGE_KEYS.authUser, legacyUser);
          await AsyncStorage.removeItem(STORAGE_KEYS.authUser);
        }

        const [storedToken, storedRefresh, storedUser] = await Promise.all([
          secureStorage.getItem(STORAGE_KEYS.authToken),
          secureStorage.getItem(STORAGE_KEYS.authRefreshToken),
          secureStorage.getItem(STORAGE_KEYS.authUser),
        ]);

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
            secureStorage.setItem(STORAGE_KEYS.authUser, JSON.stringify(freshUser)).catch(() => {});
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
      secureStorage.removeItem(STORAGE_KEYS.authToken),
      secureStorage.removeItem(STORAGE_KEYS.authRefreshToken),
      secureStorage.removeItem(STORAGE_KEYS.authUser),
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
      await secureStorage.setItem(STORAGE_KEYS.authToken, resp);
    }
    await secureStorage.setItem(STORAGE_KEYS.authUser, JSON.stringify(newUser));
    setToken(accessToken);
    setUser(newUser);
    setSessionExpiredAt(null);
  }, []);

  const signOut = useCallback(async (everywhere = false) => {
    await apiLogout(everywhere).catch(() => {});
    await clearLocal();
  }, [clearLocal]);

  const forgetSession = useCallback(async () => {
    // Local-only wipe — server has already revoked the tokens (e.g. after
    // an account-delete call). Skips the network round-trip.
    await clearLocal();
  }, [clearLocal]);

  const updateUser = useCallback((updated: AuthUser) => {
    setUser(updated);
    secureStorage.setItem(STORAGE_KEYS.authUser, JSON.stringify(updated)).catch(() => {});
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

  return (
    <AuthContext.Provider
      value={{
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
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
