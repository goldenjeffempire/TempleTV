import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Sermon, SermonCategory } from "@/types";

const CACHE_KEY = "@temple_tv/local_videos_cache";
const CACHE_TTL_MS = 5 * 60 * 1000;

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
}

function mapCategory(cat: string): SermonCategory {
  return CATEGORY_MAP[cat] ?? "Teachings";
}

function apiVideoToSermon(v: ApiVideo): Sermon {
  return {
    id: v.id,
    title: v.title,
    description: v.description ?? "",
    youtubeId: v.youtubeId,
    thumbnailUrl: v.thumbnailUrl ?? "",
    duration: v.duration ?? "",
    category: mapCategory(v.category),
    preacher: v.preacher || "Temple TV JCTM",
    date: (v.publishedAt ?? v.importedAt ?? "").slice(0, 10),
    views: v.viewCount,
    videoSource: (v.videoSource as "youtube" | "local") ?? "youtube",
    localVideoUrl: v.localVideoUrl ?? undefined,
  };
}

export function useLocalVideos() {
  const [videos, setVideos] = useState<Sermon[]>([]);
  const [loading, setLoading] = useState(true);
  const fetchedRef = useRef(false);

  const fetchVideos = useCallback(async (force = false) => {
    try {
      if (!force) {
        const cached = await AsyncStorage.getItem(CACHE_KEY);
        if (cached) {
          const { data, timestamp } = JSON.parse(cached) as { data: Sermon[]; timestamp: number };
          if (Array.isArray(data) && Date.now() - timestamp < CACHE_TTL_MS) {
            setVideos(data);
            setLoading(false);
            return;
          }
        }
      }

      const domain = process.env.EXPO_PUBLIC_DOMAIN;
      if (!domain) {
        setLoading(false);
        return;
      }

      const res = await fetch(`https://${domain}/api/admin/videos?limit=200`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error("Failed to fetch videos");

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
      fetchVideos();
    }
  }, [fetchVideos]);

  const refresh = useCallback(() => fetchVideos(true), [fetchVideos]);

  const localOnly = videos.filter((v) => v.videoSource === "local");
  const youtubeManaged = videos.filter((v) => v.videoSource !== "local");

  return { videos, localOnly, youtubeManaged, loading, refresh };
}
