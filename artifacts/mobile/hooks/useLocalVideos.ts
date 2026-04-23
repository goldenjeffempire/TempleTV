import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Sermon, SermonCategory } from "@/types";

const CACHE_KEY = "@temple_tv/local_videos_cache";
// Cache is only used as an offline fallback — fresh data is always fetched on mount.
const CACHE_TTL_MS = 10 * 60 * 1000;

const CATEGORY_MAP: Record<string, SermonCategory> = {
  Faith: "Faith",
  Healing: "Healing",
  Deliverance: "Deliverance",
  Worship: "Worship",
  Prophecy: "Prophecy",
  Teachings: "Teachings",
  "Special Programs": "Special Programs",
  sermon: "Teachings",
  music: "Worship",
  teaching: "Teachings",
  prophecy: "Prophecy",
  healing: "Healing",
  deliverance: "Deliverance",
  worship: "Worship",
  faith: "Faith",
  special: "Special Programs",
};

interface ApiVideo {
  id: string;
  youtubeId: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  duration: string;
  category: string;
  preacher: string;
  publishedAt?: string;
  importedAt: string;
  viewCount: number;
  videoSource: string;
  localVideoUrl?: string | null;
  hlsMasterUrl?: string | null;
}

function mapCategory(cat: string): SermonCategory {
  return CATEGORY_MAP[cat] ?? "Teachings";
}

/**
 * Convert a duration value from the API into a display string like "1:23:45".
 * The API stores local-video durations as plain seconds ("5400") and YouTube
 * durations as ISO 8601 ("PT1H23M45S").  Both are handled here.
 */
function formatDuration(raw: string | null | undefined): string {
  if (!raw) return "";

  // ISO 8601 — YouTube format
  const iso = raw.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (iso) {
    const h = parseInt(iso[1] ?? "0");
    const m = parseInt(iso[2] ?? "0");
    const s = parseInt(iso[3] ?? "0");
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  // Plain seconds — local upload format
  const totalSec = parseInt(raw, 10);
  if (!isNaN(totalSec) && totalSec > 0) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  return "";
}

function apiVideoToSermon(v: ApiVideo): Sermon {
  return {
    id: v.id,
    title: v.title,
    description: v.description ?? "",
    youtubeId: v.youtubeId,
    thumbnailUrl: v.thumbnailUrl ?? "",
    duration: formatDuration(v.duration),
    category: mapCategory(v.category),
    preacher: v.preacher || "Temple TV JCTM",
    date: (v.publishedAt ?? v.importedAt ?? "").slice(0, 10),
    views: v.viewCount,
    videoSource: (v.videoSource as "youtube" | "local") ?? "youtube",
    // Prefer HLS master playlist for local videos (adaptive bitrate), fall back to raw file.
    localVideoUrl: v.hlsMasterUrl ?? v.localVideoUrl ?? undefined,
  };
}

export function useLocalVideos() {
  const [videos, setVideos] = useState<Sermon[]>([]);
  const [loading, setLoading] = useState(true);
  const fetchedRef = useRef(false);

  const fetchVideos = useCallback(async (force = false) => {
    try {
      // Stale-while-revalidate: serve whatever is in the cache immediately for
      // instant UI, then always hit the network so uploads are reflected ASAP.
      let cacheIsFresh = false;
      try {
        const cached = await AsyncStorage.getItem(CACHE_KEY);
        if (cached) {
          const { data, timestamp } = JSON.parse(cached) as { data: Sermon[]; timestamp: number };
          if (Array.isArray(data) && data.length > 0) {
            setVideos(data);
            setLoading(false);
            cacheIsFresh = Date.now() - timestamp < CACHE_TTL_MS;
          }
        }
      } catch {}

      // Skip the network call only when cache is fresh and we are not forcing.
      if (cacheIsFresh && !force) return;

      const domain = process.env.EXPO_PUBLIC_DOMAIN;
      if (!domain) {
        setLoading(false);
        return;
      }

      // Use the public /api/videos endpoint — no admin token required.
      const res = await fetch(`https://${domain}/api/videos?limit=500`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Failed to fetch videos: ${res.status}`);

      const json = (await res.json()) as { videos: ApiVideo[] };
      const mapped = (json.videos ?? []).map(apiVideoToSermon);

      setVideos(mapped);
      await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ data: mapped, timestamp: Date.now() }));
    } catch {
      try {
        const cached = await AsyncStorage.getItem(CACHE_KEY);
        if (cached) {
          const { data } = JSON.parse(cached) as { data: Sermon[] };
          if (Array.isArray(data)) setVideos(data);
        }
      } catch {}
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      // Always fetch fresh on mount so newly uploaded videos appear immediately.
      // The fetchVideos implementation still serves cached data immediately as
      // a placeholder while the network request is in flight.
      fetchVideos(true);
    }
  }, [fetchVideos]);

  const refresh = useCallback(() => fetchVideos(true), [fetchVideos]);

  const localOnly = videos.filter((v) => v.videoSource === "local");
  const youtubeManaged = videos.filter((v) => v.videoSource !== "local");

  return { videos, localOnly, youtubeManaged, loading, refresh };
}
