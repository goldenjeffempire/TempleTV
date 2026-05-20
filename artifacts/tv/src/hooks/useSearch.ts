import { useCallback, useEffect, useRef, useState } from "react";
import { fetchVideos, type VideoItem } from "../lib/api";
import { useLiveSync } from "./useLiveSync";

export function useSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VideoItem[]>([]);
  const [allVideos, setAllVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped by `useLiveSync` whenever the API broadcasts
  // `videos-library-updated` (admin upload finalize, edit, delete,
  // transcoding completion, YouTube sync). Watching it here ensures the
  // Search page picks up newly uploaded videos within a few hundred ms
  // without any manual refresh.
  const { libraryRevision } = useLiveSync();

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

  // Background refetch on SSE library bump. We don't toggle the
  // `loading` flag here so the search UI doesn't flicker; users only
  // see the new video appear in `allVideos` on the next render.
  useEffect(() => {
    if (libraryRevision === 0) return;
    let cancelled = false;
    fetchVideos()
      .then((videos) => { if (!cancelled) setAllVideos(videos); })
      .catch(() => {
        // Background refetch failures are non-fatal — the user can
        // still retry via the existing `retry` action.
      });
    return () => { cancelled = true; };
  }, [libraryRevision]);

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
