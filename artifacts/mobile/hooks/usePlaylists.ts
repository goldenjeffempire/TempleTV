/**
 * usePlaylists — fetch published playlists from GET /api/playlists.
 * usePlaylistDetail — fetch a single playlist with its videos.
 *
 * Both hooks follow the same offline-first pattern as useVideos:
 *  1. Serve stale-while-revalidate from AsyncStorage (30 min TTL) so the
 *     UI is never a blank spinner on cold start or after navigation pop.
 *  2. Background-fetch from the network and write back to cache when data
 *     actually changes (avoids a re-render churn for identical responses).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getApiBase } from "@/lib/apiBase";
import { fetchWithRetry } from "@/lib/fetchWithRetry";

// ─── Cache constants ──────────────────────────────────────────────────────────

const PLAYLISTS_CACHE_KEY = "@temple_tv/playlists_v1";
const PLAYLIST_DETAIL_CACHE_PREFIX = "@temple_tv/playlist_detail_v1:";
// 30 min — same TTL as the video catalog (useVideos) so both surfaces
// enjoy the same offline-first window without going stale.
const CACHE_TTL_MS = 30 * 60 * 1000;

interface CacheEnvelope<T> {
  data: T;
  cachedAt: number;
}

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── usePlaylists ─────────────────────────────────────────────────────────────

export function usePlaylists() {
  const [playlists, setPlaylists] = useState<PlaylistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Prevent a background fetch completing after unmount from setting state.
  const mountedRef = useRef(true);
  // Tracks whether any data (from cache or network) has ever been displayed.
  // Used in the catch path to decide whether to surface an error — reading
  // state directly inside useCallback([]) would always see the initial empty
  // value (stale closure), so a ref is used instead.
  const hasDataRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async (opts?: { skipCache?: boolean }) => {
    setLoading(true);
    setError(null);

    // ── Step 1: serve from cache immediately ─────────────────────────────────
    if (!opts?.skipCache) {
      try {
        const raw = await AsyncStorage.getItem(PLAYLISTS_CACHE_KEY);
        if (raw) {
          const envelope = JSON.parse(raw) as CacheEnvelope<PlaylistItem[]>;
          const age = Date.now() - envelope.cachedAt;
          if (age < CACHE_TTL_MS && Array.isArray(envelope.data)) {
            if (mountedRef.current) {
              setPlaylists(envelope.data);
              hasDataRef.current = true;
              setLoading(false);
            }
          }
        }
      } catch {
        // Corrupted cache — continue to network fetch.
      }
    }

    // ── Step 2: background network fetch ─────────────────────────────────────
    try {
      const apiBase = getApiBase();
      const res = await fetchWithRetry(`${apiBase}/api/playlists?limit=100`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { playlists?: PlaylistItem[]; data?: PlaylistItem[] };
      const fetched = data.playlists ?? data.data ?? [];

      if (!mountedRef.current) return;
      setPlaylists(fetched);
      hasDataRef.current = true;
      setError(null);

      // Persist to cache only when data actually arrived.
      const envelope: CacheEnvelope<PlaylistItem[]> = { data: fetched, cachedAt: Date.now() };
      AsyncStorage.setItem(PLAYLISTS_CACHE_KEY, JSON.stringify(envelope)).catch(() => {});
    } catch (e) {
      if (!mountedRef.current) return;
      // Don't overwrite already-displayed cached data with an error on background refresh.
      if (!hasDataRef.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { playlists, loading, error, refetch: () => load({ skipCache: true }) };
}

// ─── usePlaylistDetail ────────────────────────────────────────────────────────

export function usePlaylistDetail(id: string | null) {
  const [playlist, setPlaylist] = useState<PlaylistDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // Ref-based guard: reading `playlist` state inside useCallback([]) would
  // always see null (stale closure). Use a ref so the catch path correctly
  // detects whether cached data is already on screen.
  const hasDataRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async (playlistId: string, opts?: { skipCache?: boolean }) => {
    setLoading(true);
    setError(null);

    const cacheKey = `${PLAYLIST_DETAIL_CACHE_PREFIX}${playlistId}`;

    // ── Step 1: serve from cache immediately ─────────────────────────────────
    if (!opts?.skipCache) {
      try {
        const raw = await AsyncStorage.getItem(cacheKey);
        if (raw) {
          const envelope = JSON.parse(raw) as CacheEnvelope<PlaylistDetail>;
          const age = Date.now() - envelope.cachedAt;
          if (age < CACHE_TTL_MS && envelope.data?.id) {
            if (mountedRef.current) {
              setPlaylist(envelope.data);
              hasDataRef.current = true;
              setLoading(false);
            }
          }
        }
      } catch {
        // Corrupted cache — continue to network fetch.
      }
    }

    // ── Step 2: background network fetch ─────────────────────────────────────
    try {
      const apiBase = getApiBase();
      const res = await fetchWithRetry(`${apiBase}/api/playlists/${playlistId}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { playlist?: PlaylistDetail } | PlaylistDetail;
      const detail = ("playlist" in data && data.playlist) ? data.playlist : (data as PlaylistDetail);

      if (!mountedRef.current) return;
      setPlaylist(detail);
      hasDataRef.current = true;
      setError(null);

      const envelope: CacheEnvelope<PlaylistDetail> = { data: detail, cachedAt: Date.now() };
      AsyncStorage.setItem(cacheKey, JSON.stringify(envelope)).catch(() => {});
    } catch (e) {
      if (!mountedRef.current) return;
      // Don't clobber already-displayed cached data with a network error.
      if (!hasDataRef.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (id) load(id);
  }, [id, load]);

  return { playlist, loading, error, refetch: () => id && load(id, { skipCache: true }) };
}
