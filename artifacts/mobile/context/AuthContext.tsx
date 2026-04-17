import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "@/constants/config";
import { apiGetMe, type AuthUser } from "@/services/authApi";

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  isLoggedIn: boolean;
  signIn: (token: string, user: AuthUser) => Promise<void>;
  signOut: () => Promise<void>;
  updateUser: (user: AuthUser) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const restore = async () => {
      try {
        const [storedToken, storedUser] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEYS.authToken),
          AsyncStorage.getItem(STORAGE_KEYS.authUser),
        ]);
        if (storedToken && storedUser) {
          setToken(storedToken);
          setUser(JSON.parse(storedUser) as AuthUser);
          apiGetMe()
            .then((freshUser) => {
              setUser(freshUser);
              AsyncStorage.setItem(STORAGE_KEYS.authUser, JSON.stringify(freshUser)).catch(() => {});
            })
            .catch(() => {});
        }
      } catch {
      } finally {
        setIsLoading(false);
      }
    };
    restore();
  }, []);

  const signIn = useCallback(async (newToken: string, newUser: AuthUser) => {
    await Promise.all([
      AsyncStorage.setItem(STORAGE_KEYS.authToken, newToken),
      AsyncStorage.setItem(STORAGE_KEYS.authUser, JSON.stringify(newUser)),
    ]);
    setToken(newToken);
    setUser(newUser);
  }, []);

  const signOut = useCallback(async () => {
    await Promise.all([
      AsyncStorage.removeItem(STORAGE_KEYS.authToken),
      AsyncStorage.removeItem(STORAGE_KEYS.authUser),
    ]);
    setToken(null);
    setUser(null);
  }, []);

  const updateUser = useCallback((updated: AuthUser) => {
    setUser(updated);
    AsyncStorage.setItem(STORAGE_KEYS.authUser, JSON.stringify(updated)).catch(() => {});
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, token, isLoading, isLoggedIn: !!user, signIn, signOut, updateUser }}
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
