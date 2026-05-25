import { useEffect, useState } from "react";
import { resolveApiOrigin } from "../lib/api";

export interface PlaylistItem {
  id: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  videoCount: number;
  category: string;
  createdAt: string;
}

export interface PlaylistVideo {
  id: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  duration: string;
  youtubeId: string;
  hlsMasterUrl: string | null;
  localVideoUrl: string | null;
  videoSource: "youtube" | "local" | "upload" | null;
  category: string;
  preacher: string;
  publishedAt: string;
}

export interface PlaylistDetail extends PlaylistItem {
  videos: PlaylistVideo[];
}

export function usePlaylists() {
  const [playlists, setPlaylists] = useState<PlaylistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const origin = resolveApiOrigin();
    setLoading(true);
    fetch(`${origin}/api/playlists?limit=100`, { signal: ctrl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ playlists?: PlaylistItem[]; data?: PlaylistItem[] }>;
      })
      .then((data) => {
        setPlaylists(data.playlists ?? data.data ?? []);
        setError(null);
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, []);

  return { playlists, loading, error };
}

export function usePlaylistDetail(id: string | null) {
  const [playlist, setPlaylist] = useState<PlaylistDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const ctrl = new AbortController();
    const origin = resolveApiOrigin();
    setLoading(true);
    setPlaylist(null);
    fetch(`${origin}/api/playlists/${id}`, { signal: ctrl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ playlist?: PlaylistDetail } | PlaylistDetail>;
      })
      .then((data) => {
        const detail = ("playlist" in data && data.playlist)
          ? data.playlist
          : (data as PlaylistDetail);
        setPlaylist(detail);
        setError(null);
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [id]);

  return { playlist, loading, error };
}
