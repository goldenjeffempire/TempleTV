/**
 * Reactive auth state hook for the TV app.
 *
 * Subscribes to the auth module's listener system so any component can
 * react to sign-in / sign-out events without prop-drilling.
 */

import { useCallback, useEffect, useState } from "react";
import {
  isLoggedIn,
  getDisplayName,
  clearAuth,
  subscribeAuth,
} from "../lib/auth";

export interface UseAuthResult {
  loggedIn: boolean;
  displayName: string | null;
  signOut: () => void;
}

export function useAuth(): UseAuthResult {
  const [loggedIn, setLoggedIn] = useState<boolean>(() => isLoggedIn());
  const [displayName, setDisplayName] = useState<string | null>(() => getDisplayName());

  useEffect(() => {
    const unsub = subscribeAuth((state) => {
      setLoggedIn(state);
      setDisplayName(state ? getDisplayName() : null);
    });
    return unsub;
  }, []);

  const signOut = useCallback(() => {
    clearAuth();
  }, []);

  return { loggedIn, displayName, signOut };
}
