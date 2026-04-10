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
  faith: "Faith",
  believe: "Faith",
  trust: "Faith",
};

function inferCategory(title: string, desc: string): SermonCategory {
  const text = `${title} ${desc}`.toLowerCase();
  for (const [keyword, category] of Object.entries(CATEGORY_KEYWORDS)) {
    if (text.includes(keyword)) return category;
  }
  return "Faith";
}

function rssVideoToSermon(v: RssVideo, index: number): Sermon {
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

  const fetchRss = useCallback(async (force = false) => {
    try {
      // Check cache first
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

      // On web, route through our API proxy to avoid CORS. On native, fetch directly.
      const rssEndpoint =
        Platform.OS === "web"
          ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api/youtube/rss`
          : APP_CONFIG.rssUrl;

      const res = await fetch(rssEndpoint, {
        signal: AbortSignal.timeout(8000),
        headers: { Accept: "application/xml, text/xml, */*" },
      });

      if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);

      const xml = await res.text();
      const videos = parseYouTubeRss(xml);

      if (videos.length === 0) throw new Error("No videos found in RSS feed");

      const rssSermons = videos.map((v, i) => rssVideoToSermon(v, i));
      setSermons(rssSermons);
      setIsFromRss(true);
      setError(null);

      await AsyncStorage.setItem(
        STORAGE_KEYS.rssCache,
        JSON.stringify({ data: rssSermons, timestamp: Date.now() }),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Network error";
      setError(message);
      // Keep showing local data on error
      setSermons(SERMONS);
      setIsFromRss(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      fetchRss();
    }
  }, [fetchRss]);

  const refresh = useCallback(async () => {
    setLoading(true);
    await fetchRss(true);
  }, [fetchRss]);

  return { sermons, loading, error, refresh, isFromRss };
}
