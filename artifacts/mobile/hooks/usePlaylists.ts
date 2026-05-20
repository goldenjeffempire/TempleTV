/**
 * usePlaylists — fetch published playlists from GET /api/playlists.
 * usePlaylistDetail — fetch a single playlist with its videos.
 */

import { useCallback, useEffect, useState } from "react";
import { getApiBase } from "@/lib/apiBase";

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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const apiBase = getApiBase();
      const res = await fetch(`${apiBase}/api/playlists?limit=100`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { playlists?: PlaylistItem[]; data?: PlaylistItem[] };
      setPlaylists(data.playlists ?? data.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { playlists, loading, error, refetch: load };
}

export function usePlaylistDetail(id: string | null) {
  const [playlist, setPlaylist] = useState<PlaylistDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (playlistId: string) => {
    setLoading(true);
    setError(null);
    try {
      const apiBase = getApiBase();
      const res = await fetch(`${apiBase}/api/playlists/${playlistId}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { playlist?: PlaylistDetail } | PlaylistDetail;
      const detail = ("playlist" in data && data.playlist) ? data.playlist : (data as PlaylistDetail);
      setPlaylist(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (id) load(id);
  }, [id, load]);

  return { playlist, loading, error, refetch: () => id && load(id) };
}
