import { authFetch } from "./authApi";

export interface CloudWatchLaterItem {
  id: string;
  videoId: string;
  videoTitle: string;
  videoThumbnail: string;
  videoCategory: string;
  addedAt: string;
}

export async function apiGetWatchLater(): Promise<CloudWatchLaterItem[]> {
  const res = await authFetch("/api/user/watch-later");
  if (!res.ok) return [];
  const data = (await res.json()) as { items: CloudWatchLaterItem[] };
  return data.items ?? [];
}

export async function apiAddWatchLater(video: {
  videoId: string;
  videoTitle: string;
  videoThumbnail: string;
  videoCategory: string;
}): Promise<void> {
  await authFetch("/api/user/watch-later", {
    method: "POST",
    body: JSON.stringify(video),
  });
}

export async function apiRemoveWatchLater(videoId: string): Promise<void> {
  await authFetch(`/api/user/watch-later/${encodeURIComponent(videoId)}`, {
    method: "DELETE",
  });
}

export async function apiClearWatchLater(): Promise<void> {
  await authFetch("/api/user/watch-later", { method: "DELETE" });
}
