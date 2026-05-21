import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { secureStorage } from "@/lib/secureStorage";
import { STORAGE_KEYS } from "@/constants/config";
import { apiGetMe, apiLogout, setOnSessionExpired, UserNotFoundError, type AuthUser, type AuthResponse } from "@/services/authApi";
import { setAuthGateBindings, type PendingPlayback } from "@/utils/auth-gate";

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  isLoggedIn: boolean;
  /**
   * Persist the auth response from a login/signup call. Accepts either the
   * full {@link AuthResponse} (preferred) or, for backward-compat, a single
   * legacy access-token string.
   */
  signIn: (resp: AuthResponse | string, user: AuthUser) => Promise<void>;
  signOut: (everywhere?: boolean) => Promise<void>;
  updateUser: (user: AuthUser) => void;
  // ── Gating modal state ────────────────────────────────────────────
  /** True while the AuthGateModal is on screen. */
  isAuthGateOpen: boolean;
  /** The playback target captured at the moment the gate opened. */
  pendingPlayback: PendingPlayback | null;
  /** Open the gate with an optional pending target to restore after auth. */
  openAuthGate: (target: PendingPlayback) => void;
  /**
   * Close the modal. By default also clears the pending playback target;
   * pass `keepPending: true` when navigating to login/signup so the
   * target survives until the auth flow completes.
   */
  closeAuthGate: (opts?: { keepPending?: boolean }) => void;
  /** Pop the pending target (one-shot) so the consumer can navigate to it. */
  consumePendingPlayback: () => PendingPlayback | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthGateOpen, setAuthGateOpen] = useState(false);
  const [pendingPlayback, setPendingPlayback] = useState<PendingPlayback | null>(null);

  useEffect(() => {
    const restore = async () => {
      try {
        // Migration: legacy AsyncStorage token → SecureStore (one-time).
        const legacyToken = await AsyncStorage.getItem(STORAGE_KEYS.authToken);
        if (legacyToken) {
          await secureStorage.setItem(STORAGE_KEYS.authToken, legacyToken);
          await AsyncStorage.removeItem(STORAGE_KEYS.authToken);
        }

        const [storedToken, storedRefresh, storedUser] = await Promise.all([
          secureStorage.getItem(STORAGE_KEYS.authToken),
          secureStorage.getItem(STORAGE_KEYS.authRefreshToken),
          AsyncStorage.getItem(STORAGE_KEYS.authUser),
        ]);

        // Restore if we have any stored credential (access OR refresh token).
        // A missing user-profile cache is recovered by the background apiGetMe() call.
        const hasCredential = !!(storedToken || storedRefresh);
        if (!hasCredential) return;

        // Immediately mark as logged in with cached data so the UI is responsive.
        if (storedToken) setToken(storedToken);
        if (storedUser) {
          try {
            setUser(JSON.parse(storedUser) as AuthUser);
          } catch {
            /* corrupted cache — will be refetched below */
          }
        }

        // Background: refresh user profile. Auto-refreshes the access token if
        // expired. Only fires onSessionExpired (→ logout) on a genuine 401, never
        // on transient network errors (fixed in authApi.ts).
        apiGetMe()
          .then((freshUser) => {
            setUser(freshUser);
            AsyncStorage.setItem(STORAGE_KEYS.authUser, JSON.stringify(freshUser)).catch(() => {});
          })
          .catch(async (err: unknown) => {
            if (err instanceof UserNotFoundError) {
              // The stored JWT is valid but the user row is gone (e.g. DB
              // re-seeded, account deleted). Clear the stale session so the
              // user lands on the sign-in screen instead of a broken state.
              await clearLocal();
            }
            // All other failures (network timeout, 5xx) are transient —
            // keep the cached session alive. A genuine 401 fires
            // onSessionExpired separately via authApi's refresh path.
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
      AsyncStorage.removeItem(STORAGE_KEYS.authUser),
    ]);
    setToken(null);
    setUser(null);
  }, []);

  // Wire authApi → context so a permanent refresh failure forces signOut.
  useEffect(() => {
    setOnSessionExpired(() => {
      clearLocal().catch(() => {});
    });
    return () => setOnSessionExpired(null);
  }, [clearLocal]);

  const signIn = useCallback(async (resp: AuthResponse | string, newUser: AuthUser) => {
    // authApi.apiLogin/apiSignup already persisted both tokens to SecureStore
    // when given an AuthResponse; we only need to mirror state and the user.
    const accessToken = typeof resp === "string" ? resp : (resp.accessToken ?? resp.token);
    if (typeof resp === "string") {
      // Legacy callers that only pass an access-token string: persist it here.
      await secureStorage.setItem(STORAGE_KEYS.authToken, resp);
    }
    await AsyncStorage.setItem(STORAGE_KEYS.authUser, JSON.stringify(newUser));
    setToken(accessToken);
    setUser(newUser);
  }, []);

  const signOut = useCallback(async (everywhere = false) => {
    await apiLogout(everywhere).catch(() => {});
    await clearLocal();
  }, [clearLocal]);

  const updateUser = useCallback((updated: AuthUser) => {
    setUser(updated);
    AsyncStorage.setItem(STORAGE_KEYS.authUser, JSON.stringify(updated)).catch(() => {});
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

  // Expose the live auth-gate bindings to non-React utilities (e.g.
  // navigateToSermon) via a module-level snapshot. Re-runs whenever
  // any input changes so the snapshot never goes stale.
  const isLoggedIn = !!user;
  useEffect(() => {
    setAuthGateBindings({
      isLoggedIn,
      isLoading,
      openGate: openAuthGate,
    });
  }, [isLoggedIn, isLoading, openAuthGate]);

  // If the user authenticates while the gate is open (e.g. via a
  // separate route), close it automatically.
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
        signIn,
        signOut,
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
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
