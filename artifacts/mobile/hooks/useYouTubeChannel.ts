import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { parseYouTubeRss, type RssVideo } from "@/utils/xmlParser";
import { APP_CONFIG, STORAGE_KEYS } from "@/constants/config";
import { SERMONS } from "@/data/sermons";
import type { Sermon, SermonCategory } from "@/types";

const CATEGORY_KEYWORDS: Record<string, SermonCategory> = {
  heal: "Healing",
  miracle: "Healing",
  deliverance: "Deliverance",
  free: "Deliverance",
  chain: "Deliverance",
  worship: "Worship",
  praise: "Worship",
  prophet: "Prophecy",
  prophetic: "Prophecy",
  vision: "Prophecy",
  reveal: "Prophecy",
  faith: "Faith",
  believe: "Faith",
  trust: "Faith",
  teaching: "Teachings",
  teach: "Teachings",
  bible: "Teachings",
  study: "Teachings",
  lesson: "Teachings",
  doctrine: "Teachings",
  scripture: "Teachings",
  annual: "Special Programs",
  thanksgiving: "Special Programs",
  crossover: "Special Programs",
  special: "Special Programs",
  program: "Special Programs",
  conference: "Special Programs",
  crusade: "Special Programs",
  revival: "Special Programs",
  convention: "Special Programs",
};

function inferCategory(title: string, desc: string): SermonCategory {
  const text = `${title} ${desc}`.toLowerCase();
  for (const [keyword, category] of Object.entries(CATEGORY_KEYWORDS)) {
    if (text.includes(keyword)) return category;
  }
  return "Faith";
}

interface ApiVideo {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  thumbnailUrl: string;
  channelName: string;
  duration: string;
  viewCount: string;
}

function apiVideoToSermon(v: ApiVideo): Sermon {
  return {
    id: `yt_${v.videoId}`,
    title: v.title,
    description: v.description,
    youtubeId: v.videoId,
    thumbnailUrl: v.thumbnailUrl,
    duration: formatDuration(v.duration),
    category: inferCategory(v.title, v.description),
    preacher: v.channelName || "Prophet Amos",
    date: v.publishedAt ? v.publishedAt.slice(0, 10) : "",
  };
}

function formatDuration(iso: string): string {
  if (!iso) return "";
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return "";
  const h = parseInt(match[1] ?? "0");
  const m = parseInt(match[2] ?? "0");
  const s = parseInt(match[3] ?? "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function rssVideoToSermon(v: RssVideo): Sermon {
  return {
    id: `rss_${v.videoId}`,
    title: v.title,
    description: v.description,
    youtubeId: v.videoId,
    thumbnailUrl: v.thumbnailUrl,
    duration: "",
    category: inferCategory(v.title, v.description),
    preacher: v.channelName || "Prophet Amos",
    date: v.published ? v.published.slice(0, 10) : "",
  };
}

interface UseYouTubeChannelResult {
  sermons: Sermon[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  isFromRss: boolean;
}

export function useYouTubeChannel(): UseYouTubeChannelResult {
  const [sermons, setSermons] = useState<Sermon[]>(SERMONS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFromRss, setIsFromRss] = useState(false);
  const fetchedRef = useRef(false);

  const fetchVideos = useCallback(async (force = false) => {
    try {
      if (!force) {
        const cached = await AsyncStorage.getItem(STORAGE_KEYS.rssCache);
        if (cached) {
          const { data, timestamp } = JSON.parse(cached) as { data: Sermon[]; timestamp: number };
          const ageMs = Date.now() - timestamp;
          if (ageMs < APP_CONFIG.rssCacheMinutes * 60 * 1000) {
            setSermons(data);
            setIsFromRss(true);
            setLoading(false);
            return;
          }
        }
      }

      const domain = process.env.EXPO_PUBLIC_DOMAIN;
      const apiBase = domain ? `https://${domain}` : "";

      if (Platform.OS === "web" && apiBase) {
        try {
          const res = await fetch(`${apiBase}/api/youtube/videos`, {
            signal: AbortSignal.timeout(15000),
          });
          if (res.ok) {
            const json = (await res.json()) as { videos: ApiVideo[]; total: number };
            if (json.videos?.length > 0) {
              const allSermons = json.videos.map(apiVideoToSermon);
              setSermons(allSermons);
              setIsFromRss(true);
              setError(null);
              await AsyncStorage.setItem(
                STORAGE_KEYS.rssCache,
                JSON.stringify({ data: allSermons, timestamp: Date.now() })
              );
              setLoading(false);
              return;
            }
          }
        } catch {
          // fall through to RSS
        }
      }

      const rssEndpoint =
        Platform.OS === "web" && apiBase
          ? `${apiBase}/api/youtube/rss`
          : APP_CONFIG.rssUrl;

      const res = await fetch(rssEndpoint, {
        signal: AbortSignal.timeout(8000),
        headers: { Accept: "application/xml, text/xml, */*" },
      });

      if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);

      const xml = await res.text();
      const videos = parseYouTubeRss(xml);

      if (videos.length === 0) throw new Error("No videos found in RSS feed");

      const rssSermons = videos.map(rssVideoToSermon);
      setSermons(rssSermons);
      setIsFromRss(true);
      setError(null);

      await AsyncStorage.setItem(
        STORAGE_KEYS.rssCache,
        JSON.stringify({ data: rssSermons, timestamp: Date.now() })
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Network error";
      setError(message);
      setSermons(SERMONS);
      setIsFromRss(false);
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

  const refresh = useCallback(async () => {
    setLoading(true);
    await fetchVideos(true);
  }, [fetchVideos]);

  return { sermons, loading, error, refresh, isFromRss };
}
