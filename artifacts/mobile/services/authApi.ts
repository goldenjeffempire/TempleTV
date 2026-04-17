import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "@/constants/config";

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  emailVerified: boolean;
}

function getApiBase(): string {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (domain) return `https://${domain}`;
  return "";
}

async function authFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = await AsyncStorage.getItem(STORAGE_KEYS.authToken);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${getApiBase()}${path}`, { ...options, headers });
}

export async function apiSignup(
  email: string,
  password: string,
  displayName: string,
): Promise<{ token: string; user: AuthUser }> {
  const res = await authFetch("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password, displayName }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Signup failed");
  return data as { token: string; user: AuthUser };
}

export async function apiLogin(
  email: string,
  password: string,
): Promise<{ token: string; user: AuthUser }> {
  const res = await authFetch("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Login failed");
  return data as { token: string; user: AuthUser };
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
