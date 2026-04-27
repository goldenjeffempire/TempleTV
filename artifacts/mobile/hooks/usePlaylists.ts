import { useEffect, useState } from "react";
import type { Sermon, SermonCategory } from "@/types";
import { getApiBase } from "@/lib/apiBase";

export interface PlaylistItem {
  id: string;
  name: string;
  description: string;
  loopMode: string;
  isActive: boolean;
  createdAt: string;
  videoCount: number;
}

export interface PlaylistVideo {
  id: string;
  playlistId: string;
  videoId: string;
  youtubeId: string;
  title: string;
  thumbnailUrl: string;
  duration: string;
  category: string;
  sortOrder: number;
}

export interface PlaylistDetail extends PlaylistItem {
  videos: PlaylistVideo[];
}

function playlistVideoToSermon(v: PlaylistVideo): Sermon {
  return {
    id: v.videoId,
    youtubeId: v.youtubeId,
    title: v.title,
    description: "",
    thumbnailUrl: v.thumbnailUrl || `https://img.youtube.com/vi/${v.youtubeId}/hqdefault.jpg`,
    duration: v.duration,
    category: (v.category as SermonCategory) || "Faith",
    preacher: "JCTM",
    date: "",
  };
}

// Thin shim around the canonical `getApiBase()` helper. Kept under the
// same `getBase()` name to avoid touching every call site in this file —
// behavior is now: prefer `EXPO_PUBLIC_API_URL` (the documented going-
// forward env, set by EAS profiles and `render.yaml`), fall back to the
// legacy `EXPO_PUBLIC_DOMAIN`, return "" when neither is set so callers
// continue to early-return on no-op builds. See `mobile/lib/apiBase.ts`.
function getBase() {
  return getApiBase();
}

export function usePlaylists() {
  const [playlists, setPlaylists] = useState<PlaylistItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${getBase()}/api/playlists`)
      .then((r) => r.json())
      .then((data: PlaylistItem[]) => {
        if (Array.isArray(data)) setPlaylists(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return { playlists, loading };
}

export function usePlaylistDetail(id: string | null) {
  const [detail, setDetail] = useState<PlaylistDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!id) { setDetail(null); return; }
    setLoading(true);
    fetch(`${getBase()}/api/playlists/${id}`)
      .then((r) => r.json())
      .then((data: PlaylistDetail) => setDetail(data))
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [id]);

  const sermons: Sermon[] = detail?.videos.map(playlistVideoToSermon) ?? [];

  return { detail, loading, sermons };
}
