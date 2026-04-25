import { useEffect, useMemo, useRef, useState } from "react";
import { fetchVideos, fetchLiveStatus, type VideoItem, type LiveStatus } from "../lib/api";

export interface Sermon extends VideoItem {
  category: string;
}

const CATEGORIES = [
  "Faith",
  "Healing",
  "Deliverance",
  "Worship",
  "Teachings",
  "Special Programs",
];

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  Faith: ["faith", "believe", "trust", "salvation", "grace", "prayer", "gospel", "word", "scripture", "bible"],
  Healing: ["healing", "heal", "miracle", "health", "sick", "recovery", "restore", "wholeness", "body"],
  Deliverance: ["deliverance", "deliver", "freedom", "captive", "bondage", "oppress", "demon", "stronghold"],
  Worship: ["worship", "praise", "sing", "glory", "holy", "spirit", "presence", "choir", "music"],
  Teachings: ["teaching", "lesson", "study", "message", "sermon", "preach", "doctrine", "truth", "instruction"],
  "Special Programs": ["conference", "special", "convention", "program", "service", "crusade", "revival", "anniversary"],
};

// Maps admin-set category slugs to display category names used by the TV app.
const API_CATEGORY_MAP: Record<string, string> = {
  faith: "Faith",
  healing: "Healing",
  deliverance: "Deliverance",
  worship: "Worship",
  music: "Worship",
  sermon: "Teachings",
  teaching: "Teachings",
  teachings: "Teachings",
  prophecy: "Faith",
  special: "Special Programs",
  "special programs": "Special Programs",
};

function categorizeVideo(video: VideoItem, index: number): string {
  // For local uploads the admin already chose a category — honour it directly.
  if (video.videoSource === "local" && video.apiCategory) {
    const mapped = API_CATEGORY_MAP[video.apiCategory.toLowerCase()];
    if (mapped) return mapped;
  }
  const text = `${video.title} ${video.description}`.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => text.includes(kw))) {
      return category;
    }
  }
  return CATEGORIES[index % CATEGORIES.length]!;
}

function categorize(videos: VideoItem[]): Sermon[] {
  return videos.map((v, i) => ({
    ...v,
    category: categorizeVideo(v, i),
  }));
}

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — picks up newly uploaded videos

export function useSermons() {
  const [sermons, setSermons] = useState<Sermon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = (isInitial: boolean) => {
      if (isInitial) setLoading(true);
      fetchVideos()
        .then((videos) => {
          if (!cancelled) {
            setSermons(categorize(videos));
            setLoading(false);
          }
        })
        .catch((err) => {
          if (!cancelled && isInitial) {
            setError(err instanceof Error ? err.message : "Failed to load");
            setLoading(false);
          }
          // Swallow background refresh errors — stale data is fine
        });
    };

    load(true);
    const timer = setInterval(() => load(false), POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const byCategory = useMemo(
    () =>
      CATEGORIES.reduce<Record<string, Sermon[]>>((acc, cat) => {
        acc[cat] = sermons.filter((s) => s.category === cat);
        return acc;
      }, {}),
    [sermons],
  );

  return { sermons, byCategory, loading, error };
}

export function useLiveStatus() {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const s = await fetchLiveStatus();
        if (!cancelled) setStatus(s);
      } catch { }
      if (!cancelled) {
        timerRef.current = setTimeout(poll, 30_000);
      }
    };

    poll();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return status;
}
