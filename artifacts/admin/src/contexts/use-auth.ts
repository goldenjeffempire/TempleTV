import { createContext, useContext } from "react";

export type UserRole = "user" | "moderator" | "editor" | "admin" | "system";

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  name?: string | null;
  avatarUrl?: string | null;
}

export interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
  isEditor: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * Set when the initial session-restore loop has hit ≥2 consecutive
   * transient failures (network down, 5xx, CORS, cold-start). The loop
   * keeps retrying in the background but UI can show this so the user is
   * not stranded on an infinite spinner.
   */
  restoreError: string | null;
  /** Force an immediate restore retry, bypassing the backoff timer. */
  retryRestore: () => void;
  /** Clear local tokens immediately and bounce to the login page (no server call). */
  forceSignOut: () => void;

  /**
   * Non-null when the login API returned `{ mfaRequired: true }`.
   * The login page renders the TOTP step when this is set.
   * Cleared after a successful verifyMfa() or by calling clearMfaPending().
   */
  mfaPendingToken: string | null;
  /**
   * Exchange the mfaToken (from the login MFA challenge) for real session
   * tokens by verifying a 6-digit TOTP code or a backup code.
   */
  verifyMfa: (mfaToken: string, code: string, backupCode?: string) => Promise<void>;
  /** Cancel the MFA step and go back to credentials entry. */
  clearMfaPending: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Read the auth state from the nearest <AuthProvider>. Throws when called
 * outside the provider so misuse fails loudly rather than silently returning
 * an empty user.
 *
 * Lives in this hook-only file (not alongside <AuthProvider>) so the React
 * Fast Refresh rule "components-only file" is satisfied — auth-context.tsx
 * mixing the component with this hook caused every dev edit there to force a
 * full page reload instead of an HMR patch.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
