import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { parseYouTubeRss, type RssVideo } from "@/utils/xmlParser";
import { APP_CONFIG, STORAGE_KEYS } from "@/constants/config";
import { SERMONS } from "@/data/sermons";
import type { Sermon, SermonCategory } from "@/types";

const CATEGORY_KEYWORDS: Record<string, SermonCategory> = {
  heal: "Healing",
  healer: "Healing",
  healing: "Healing",
  miracle: "Healing",
  miracles: "Healing",
  sick: "Healing",
  sickness: "Healing",
  cancer: "Healing",
  health: "Healing",
  wellness: "Healing",
  disease: "Healing",

  deliverance: "Deliverance",
  deliver: "Deliverance",
  free: "Deliverance",
  freedom: "Deliverance",
  chain: "Deliverance",
  bondage: "Deliverance",
  oppression: "Deliverance",
  captive: "Deliverance",
  captivity: "Deliverance",
  curse: "Deliverance",
  demon: "Deliverance",
  generational: "Deliverance",

  worship: "Worship",
  praise: "Worship",
  glorify: "Worship",
  adoration: "Worship",
  hymn: "Worship",
  anthem: "Worship",
  hallelujah: "Worship",
  hosanna: "Worship",

  prophet: "Prophecy",
  prophetic: "Prophecy",
  prophecy: "Prophecy",
  vision: "Prophecy",
  reveal: "Prophecy",
  revelation: "Prophecy",
  oracle: "Prophecy",
  declare: "Prophecy",
  foretell: "Prophecy",
  anointing: "Prophecy",

  faith: "Faith",
  believe: "Faith",
  belief: "Faith",
  trust: "Faith",
  hope: "Faith",
  salvation: "Faith",
  saved: "Faith",
  grace: "Faith",
  gospel: "Faith",
  righteousness: "Faith",
  justified: "Faith",
  redemption: "Faith",

  teaching: "Teachings",
  teach: "Teachings",
  bible: "Teachings",
  study: "Teachings",
  lesson: "Teachings",
  doctrine: "Teachings",
  scripture: "Teachings",
  sermon: "Teachings",
  word: "Teachings",
  kingdom: "Teachings",
  discipleship: "Teachings",
  prayer: "Teachings",
  fasting: "Teachings",
  baptism: "Teachings",
  holy: "Teachings",

  annual: "Special Programs",
  thanksgiving: "Special Programs",
  crossover: "Special Programs",
  special: "Special Programs",
  program: "Special Programs",
  conference: "Special Programs",
  crusade: "Special Programs",
  revival: "Special Programs",
  convention: "Special Programs",
  concert: "Special Programs",
  summit: "Special Programs",
  congress: "Special Programs",
  rally: "Special Programs",
  festival: "Special Programs",
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
  const views = v.viewCount ? parseInt(v.viewCount, 10) : undefined;
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
    views: !isNaN(views as number) ? views : undefined,
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

async function fetchRssDirect(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { Accept: "application/xml, text/xml, */*" },
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.includes("<entry>") ? text : null;
  } catch {
    return null;
  }
}

interface UseYouTubeChannelResult {
  sermons: Sermon[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  clearCache: () => Promise<void>;
  isFromRss: boolean;
  cacheUpdatedAt: number | null;
  cacheAgeMinutes: number | null;
}

export function useYouTubeChannel(): UseYouTubeChannelResult {
  const [sermons, setSermons] = useState<Sermon[]>(SERMONS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFromRss, setIsFromRss] = useState(false);
  const [cacheUpdatedAt, setCacheUpdatedAt] = useState<number | null>(null);
  const fetchedRef = useRef(false);

  const fetchVideos = useCallback(async (force = false) => {
    let cachedData: Sermon[] | null = null;
    let cachedTimestamp: number | null = null;
    try {
      try {
        const cached = await AsyncStorage.getItem(STORAGE_KEYS.rssCache);
        if (cached) {
          const { data, timestamp } = JSON.parse(cached) as { data: Sermon[]; timestamp: number };
          if (Array.isArray(data) && data.length > 0 && typeof timestamp === "number") {
            cachedData = data;
            cachedTimestamp = timestamp;
            setCacheUpdatedAt(timestamp);
            const ageMs = Date.now() - timestamp;
            if (!force && ageMs < APP_CONFIG.rssCacheMinutes * 60 * 1000) {
              setSermons(data);
              setIsFromRss(true);
              setLoading(false);
              return;
            }
          }
        }
      } catch {
      }

      const domain = process.env.EXPO_PUBLIC_DOMAIN;
      const apiBase = domain ? `https://${domain}` : "";

      // On web, try the API server first (which includes RSS fallback)
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
              try {
                await AsyncStorage.setItem(
                  STORAGE_KEYS.rssCache,
                  JSON.stringify({ data: allSermons, timestamp: Date.now() })
                );
                setCacheUpdatedAt(Date.now());
              } catch {}
              setLoading(false);
              return;
            }
          }
        } catch {
          // Fall through to direct RSS
        }
      }

      // Direct RSS fetch (works on both native and web)
      const rssUrls = [
        APP_CONFIG.rssUrl,
        ...(Platform.OS === "web" && apiBase ? [`${apiBase}/api/youtube/rss`] : []),
      ];

      let xml: string | null = null;
      for (const url of rssUrls) {
        xml = await fetchRssDirect(url);
        if (xml) break;
      }

      if (!xml) throw new Error("Could not load sermons. Please check your connection.");

      const videos = parseYouTubeRss(xml);
      if (videos.length === 0) throw new Error("No videos found in feed.");

      const rssSermons = videos.map(rssVideoToSermon);
      setSermons(rssSermons);
      setIsFromRss(true);
      setError(null);

      try {
        const timestamp = Date.now();
        await AsyncStorage.setItem(
          STORAGE_KEYS.rssCache,
          JSON.stringify({ data: rssSermons, timestamp })
        );
        setCacheUpdatedAt(timestamp);
      } catch {}
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Network error";
      if (cachedData && cachedData.length > 0) {
        setSermons(cachedData);
        setIsFromRss(true);
        setError(`Showing offline sermon cache${cachedTimestamp ? ` from ${new Date(cachedTimestamp).toLocaleDateString()}` : ""}.`);
      } else {
        setError(message);
        setIsFromRss(false);
      }
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

  const clearCache = useCallback(async () => {
    await AsyncStorage.removeItem(STORAGE_KEYS.rssCache);
    setCacheUpdatedAt(null);
  }, []);

  const cacheAgeMinutes = cacheUpdatedAt ? Math.max(0, Math.floor((Date.now() - cacheUpdatedAt) / 60000)) : null;

  return { sermons, loading, error, refresh, clearCache, isFromRss, cacheUpdatedAt, cacheAgeMinutes };
}
