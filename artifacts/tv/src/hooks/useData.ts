import { useEffect, useRef, useState } from "react";
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

function categorize(videos: VideoItem[]): Sermon[] {
  return videos.map((v, i) => ({
    ...v,
    category: CATEGORIES[i % CATEGORIES.length]!,
  }));
}

export function useSermons() {
  const [sermons, setSermons] = useState<Sermon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchVideos()
      .then((videos) => {
        if (!cancelled) {
          setSermons(categorize(videos));
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load");
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, []);

  const byCategory = CATEGORIES.reduce<Record<string, Sermon[]>>((acc, cat) => {
    acc[cat] = sermons.filter((s) => s.category === cat);
    return acc;
  }, {});

  const featured = sermons.slice(0, 5);
  return { sermons, byCategory, featured, loading, error };
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
