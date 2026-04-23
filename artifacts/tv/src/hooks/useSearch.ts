import { useCallback, useEffect, useRef, useState } from "react";
import { fetchVideos, type VideoItem } from "../lib/api";

export function useSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VideoItem[]>([]);
  const [allVideos, setAllVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadVideos = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchVideos()
      .then((videos) => { setAllVideos(videos); setLoading(false); })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load videos");
        setLoading(false);
      });
  }, []);

  useEffect(() => { loadVideos(); }, [loadVideos]);

  const search = useCallback((q: string) => {
    setQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const trimmed = q.trim().toLowerCase();
      if (!trimmed) { setResults([]); return; }
      const filtered = allVideos.filter(
        (v) =>
          v.title.toLowerCase().includes(trimmed) ||
          v.description.toLowerCase().includes(trimmed) ||
          v.channelName.toLowerCase().includes(trimmed),
      );
      setResults(filtered);
    }, 300);
  }, [allVideos]);

  return { query, results, loading, error, search, allVideos, retry: loadVideos };
}
