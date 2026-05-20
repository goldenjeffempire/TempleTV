import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, tokenStore, HttpError } from "@/lib/api";
import { apiBase } from "@/lib/api-base";
import { startSessionActivity } from "@/lib/session-activity";
import { AuthContext, type AuthUser, type UserRole } from "./use-auth";

const ADMIN_ROLES: UserRole[] = ["admin", "system"];
const EDITOR_ROLES: UserRole[] = ["admin", "system", "editor", "moderator"];

/** sessionStorage key for the in-flight MFA challenge token. */
const MFA_SESSION_KEY = "ttv:mfa-pending-token";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  // Holds the cleanup function returned by startSessionActivity so we can
  // stop the monitor on logout or when the idle timer fires.
  const stopActivityRef = useRef<(() => void) | null>(null);
  // Bumped by retryRestore() to wake the backoff loop early.
  const [restoreNonce, setRestoreNonce] = useState(0);
  // Holds the resolver for the in-flight backoff sleep so retryRestore()
  // can interrupt it and trigger an immediate next attempt.
  const wakeSleepRef = useRef<(() => void) | null>(null);

  const stopActivity = useCallback(() => {
    if (stopActivityRef.current) {
      stopActivityRef.current();
      stopActivityRef.current = null;
    }
  }, []);

  const startActivity = useCallback(() => {
    stopActivity(); // guard against double-start
    stopActivityRef.current = startSessionActivity();
  }, [stopActivity]);

  const logout = useCallback(async () => {
    stopActivity();
    const refresh = tokenStore.getRefresh();
    try {
      // Send the refresh token so the server can revoke it immediately,
      // preventing replay by a stolen token for the remaining 30-day window.
      await api.post("/auth/logout", refresh ? { refreshToken: refresh } : undefined);
    } catch { /* ignore — clear locally regardless */ }
    tokenStore.clear();
    setUser(null);
  }, [stopActivity]);

  // Restore session on mount.
  //
  // POLICY: tokens MUST NOT be cleared on transient failures (network down,
  // 5xx, CORS blip, dev-server restart). They are only cleared when the
  // server explicitly rejects the credential — i.e. a 401 / 403 from
  // /auth/me with a working refresh AND a 401 / 403 from /auth/refresh.
  // Anything else: leave the tokens in sessionStorage and let the running
  // keep-alive interval / next user action retry. Otherwise an admin who
  // briefly loses connectivity would be silently kicked out.
  useEffect(() => {
    const access = tokenStore.getAccess();
    if (!access) { setIsLoading(false); return; }

    let cancelled = false;
    let attempt = 0;

    // Outcome contract — `restoreOnce` returns one of three states so the
    // outer driver knows whether to stop, finish loading, or try again.
    type Outcome = "success" | "hard-auth-fail" | "transient";

    const restoreOnce = async (): Promise<Outcome> => {
      try {
        const u = await api.get<AuthUser>("/auth/me");
        if (cancelled) return "success";
        setUser(u);
        startActivity();
        return "success";
      } catch (err) {
        const isHardAuth =
          err instanceof HttpError && (err.status === 401 || err.status === 403);
        if (!isHardAuth) return "transient";
      }

      const refresh = tokenStore.getRefresh();
      if (!refresh) { tokenStore.clear(); return "hard-auth-fail"; }

      let res: Response;
      try {
        res = await fetch(`${apiBase()}/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: refresh }),
        });
      } catch {
        return "transient"; // network — retry later
      }

      if (res.status === 401 || res.status === 403) {
        tokenStore.clear();
        return "hard-auth-fail";
      }
      if (!res.ok) return "transient"; // 5xx/408/429 — retry later

      try {
        const data = await res.json() as { accessToken: string; refreshToken?: string };
        tokenStore.setAccess(data.accessToken);
        if (data.refreshToken) tokenStore.setRefresh(data.refreshToken);
        const u = await api.get<AuthUser>("/auth/me");
        if (cancelled) return "success";
        setUser(u);
        startActivity();
        return "success";
      } catch (err) {
        const isHardAuth =
          err instanceof HttpError && (err.status === 401 || err.status === 403);
        if (isHardAuth) { tokenStore.clear(); return "hard-auth-fail"; }
        return "transient";
      }
    };

    // Keep retrying restore on transient failures so a brief outage at
    // page load never bounces the admin to /login. Backoff: 1s, 2s, 4s,
    // 8s, capped at 30s. We flip `isLoading` false on the FIRST decisive
    // outcome (success or hard-auth-fail). For transient failures we keep
    // `isLoading=true` so AuthGate shows the loading state instead of
    // redirecting; the loop quietly keeps trying in the background until
    // the API is reachable again or the credentials are revoked.
    //
    // After the 2nd consecutive transient failure (~3 s elapsed) we expose
    // `restoreError` so the AuthGate can render an error banner with
    // Retry / Sign-out buttons — the user is never stranded on an infinite
    // spinner with no way out.
    const driveRestore = async () => {
      while (!cancelled) {
        const outcome = await restoreOnce();
        if (cancelled) return;
        if (outcome === "success") {
          setRestoreError(null);
          setIsLoading(false);
          return;
        }
        if (outcome === "hard-auth-fail") {
          setRestoreError(null);
          setIsLoading(false);
          return;
        }
        // transient
        attempt += 1;
        if (attempt >= 2) {
          setRestoreError(
            "Can't reach the server. Retrying automatically — check your connection.",
          );
        }
        const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt - 1, 5));
        // Sleep that can be woken early by retryRestore()
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = () => { if (done) return; done = true; resolve(); };
          wakeSleepRef.current = finish;
          setTimeout(finish, delay);
        });
        wakeSleepRef.current = null;
      }
    };

    driveRestore();
    return () => {
      cancelled = true;
      // Wake any in-flight backoff so the cleanup completes promptly.
      wakeSleepRef.current?.();
      stopActivity();
    };

  // restoreNonce dep makes retryRestore() trigger a fresh driver run.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreNonce]);

  /**
   * Force the restore loop to attempt right now. Wakes the current backoff
   * sleep if the loop is mid-wait, otherwise resets the driver effect.
   */
  const retryRestore = useCallback(() => {
    setRestoreError(null);
    if (wakeSleepRef.current) {
      // Loop is mid-sleep — just wake it.
      wakeSleepRef.current();
    } else {
      // Loop has exited or never started — re-arm by bumping the nonce.
      setIsLoading(true);
      setRestoreNonce((n) => n + 1);
    }
  }, []);

  /**
   * Local-only sign-out for when the server is unreachable. Skips the
   * `/auth/logout` call (which would just hang on the same dead network),
   * clears tokens, drops the user, and lets the router push them to /login.
   */
  const forceSignOut = useCallback(() => {
    stopActivity();
    tokenStore.clear();
    setUser(null);
    setRestoreError(null);
    setIsLoading(false);
  }, [stopActivity]);

  // When the idle timer fires or the API layer detects a hard 401, the
  // "ttv:auth-expired" event is dispatched. Handle it here by stopping the
  // activity monitor and clearing the session — the router will redirect to
  // the login page because isAuthenticated becomes false.
  useEffect(() => {
    const handler = () => {
      stopActivity();
      tokenStore.clear();
      setUser(null);
    };
    window.addEventListener("ttv:auth-expired", handler);
    return () => window.removeEventListener("ttv:auth-expired", handler);
  }, [stopActivity]);

  // Non-null when the server returned { mfaRequired: true } on login.
  // The login page renders the TOTP step while this is set.
  // Persisted to sessionStorage so a page refresh during the MFA step
  // does not lose the challenge token and force the user to re-enter
  // their credentials from scratch.
  const [mfaPendingToken, setMfaPendingTokenState] = useState<string | null>(() => {
    try { return sessionStorage.getItem(MFA_SESSION_KEY); } catch { return null; }
  });
  const setMfaPendingToken = useCallback((token: string | null) => {
    try {
      if (token) sessionStorage.setItem(MFA_SESSION_KEY, token);
      else sessionStorage.removeItem(MFA_SESSION_KEY);
    } catch { /* sessionStorage unavailable — in-memory only */ }
    setMfaPendingTokenState(token);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await api.post<
      | { mfaRequired: true; mfaToken: string }
      | { user: AuthUser; accessToken: string; refreshToken: string }
    >("/auth/login", { email, password });

    // MFA challenge: store the pending token so the login page can show the TOTP step.
    if ("mfaRequired" in data && data.mfaRequired) {
      setMfaPendingToken(data.mfaToken);
      return;
    }

    // Full auth: validate role and store tokens.
    const full = data as { user: AuthUser; accessToken: string; refreshToken: string };
    const role = full.user.role;
    if (!EDITOR_ROLES.includes(role as UserRole)) {
      tokenStore.clear();
      throw new HttpError(403, "Your account does not have access to the Admin Panel.");
    }
    tokenStore.setAccess(full.accessToken);
    tokenStore.setRefresh(full.refreshToken);
    setMfaPendingToken(null);
    setUser(full.user);
    startActivity();
  }, [startActivity, setMfaPendingToken]);

  const verifyMfa = useCallback(async (mfaToken: string, code: string, backupCode?: string) => {
    const data = await api.post<{ user: AuthUser; accessToken: string; refreshToken: string }>(
      "/auth/mfa/verify",
      { mfaToken, ...(backupCode ? { backupCode } : { code }) },
    );
    const role = data.user.role;
    if (!EDITOR_ROLES.includes(role as UserRole)) {
      throw new HttpError(403, "Your account does not have access to the Admin Panel.");
    }
    tokenStore.setAccess(data.accessToken);
    tokenStore.setRefresh(data.refreshToken);
    setMfaPendingToken(null);
    setUser(data.user);
    startActivity();
  }, [startActivity, setMfaPendingToken]);

  const clearMfaPending = useCallback(() => {
    setMfaPendingToken(null);
  }, [setMfaPendingToken]);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: user !== null,
        isAdmin: user !== null && ADMIN_ROLES.includes(user.role),
        isEditor: user !== null && EDITOR_ROLES.includes(user.role),
        login,
        logout,
        restoreError,
        retryRestore,
        forceSignOut,
        mfaPendingToken,
        verifyMfa,
        clearMfaPending,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
