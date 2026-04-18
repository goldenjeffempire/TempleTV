import { useCallback, useEffect, useRef, useState } from "react";
import { fetchVideos, type VideoItem } from "../lib/api";

export function useSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VideoItem[]>([]);
  const [allVideos, setAllVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchVideos()
      .then((videos) => { setAllVideos(videos); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

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

  return { query, results, loading, search, allVideos };
}
