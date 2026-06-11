import { useEffect, useMemo, useRef, useState } from "react";
import { fetchVideos, fetchLiveStatus, type VideoItem, type LiveStatus } from "../lib/api";
import { useLiveSync } from "./useLiveSync";

export interface Sermon extends VideoItem {
  category: string;
}

const CATEGORIES = [
  "Live Service",
  "Deliverance",
  "Sermons",
  "Prayers",
  "Crusades",
  "Conferences",
  "Testimonies",
];

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  "Live Service": ["sunday service", "live service", "holy spirit sunday", "holy spirit sunday service", "holy spirit sunday message", "holy spirit service", "holy spirit live", "morning service", "evening service", "church service", "worship service", "sunday morning service", "sunday morning worship", "sunday morning live", "sunday morning", "sunday night service", "sunday evening service", "sunday message", "live worship service"],
  Deliverance: ["deliverance", "deliver", "freedom", "captive", "bondage", "oppress", "demon", "stronghold"],
  Sermons: ["teaching", "lesson", "study", "message", "sermon", "preach", "doctrine", "truth", "instruction", "faith", "worship", "prophecy"],
  Prayers: ["prayer", "prayer service", "intercession", "intercessory", "fasting", "vigil", "night prayer"],
  Crusades: ["crusade", "revival", "evangelism", "evangelistic", "outreach", "open air", "harvest"],
  Conferences: ["conference", "convention", "summit", "seminar", "symposium", "ministers conference"],
  Testimonies: ["testimony", "testimonies", "testify", "witness", "miracle story", "breakthrough story"],
};

// Maps admin-set category slugs to display category names used by the TV app.
const API_CATEGORY_MAP: Record<string, string> = {
  live_service: "Live Service",
  "live-service": "Live Service",
  "live service": "Live Service",
  faith: "Sermons",
  deliverance: "Deliverance",
  worship: "Sermons",
  music: "Sermons",
  sermon: "Sermons",
  teaching: "Sermons",
  teachings: "Sermons",
  prophecy: "Sermons",
  prayer: "Prayers",
  prayers: "Prayers",
  crusade: "Crusades",
  crusades: "Crusades",
  conference: "Conferences",
  conferences: "Conferences",
  testimony: "Testimonies",
  testimonies: "Testimonies",
  special: "Sermons",
  "special programs": "Sermons",
};

function categorizeVideo(video: VideoItem, index: number): string {
  // If the admin has explicitly assigned a category (any source), honour it.
  if (video.apiCategory) {
    const mapped = API_CATEGORY_MAP[video.apiCategory.toLowerCase()];
    if (mapped) return mapped;
  }
  const text = `${video.title} ${video.description}`.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => text.includes(kw))) {
      return category;
    }
  }
  void index;
  return "Sermons";
}

function categorize(videos: VideoItem[]): Sermon[] {
  return videos.map((v, i) => ({
    ...v,
    category: categorizeVideo(v, i),
  }));
}

// ── Catalog localStorage cache ─────────────────────────────────────────────
// Persists the categorized sermon list across page reloads so Smart TV
// users see their content catalog instantly (from localStorage) on every
// cold start instead of staring at a shimmer skeleton for 300–800 ms while
// the network request completes. TTL is 30 minutes — stale enough to avoid
// unnecessary network traffic but fresh enough to always reflect recent
// admin uploads (SSE-driven refetch picks up changes within milliseconds).
//
// The cache key embeds a build-time ID (injected by vite.config.ts) so that
// every production deployment automatically invalidates any catalog data
// cached by the previous release. Old keys are never read after a deploy —
// they will be evicted silently by the browser's LRU storage manager.
declare const __BUILD_ID__: string;
const _BUILD_ID: string = typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev";
const CATALOG_CACHE_KEY = `ttv:catalog:v2:${_BUILD_ID}`;
const CATALOG_CACHE_TTL_MS = 30 * 60 * 1000;

// Remove the legacy v1 key left by older builds so it doesn't consume quota.
try { localStorage.removeItem("ttv:catalog:v1"); } catch { /* storage may be blocked */ }

interface CatalogCache {
  sermons: Sermon[];
  cachedAt: number;
}

function readCatalogCache(): Sermon[] | null {
  try {
    const raw = localStorage.getItem(CATALOG_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CatalogCache;
    if (!parsed.sermons || !parsed.cachedAt) return null;
    if (Date.now() - parsed.cachedAt > CATALOG_CACHE_TTL_MS) {
      localStorage.removeItem(CATALOG_CACHE_KEY);
      return null;
    }
    return parsed.sermons;
  } catch {
    return null;
  }
}

function writeCatalogCache(sermons: Sermon[]): void {
  try {
    const payload: CatalogCache = { sermons, cachedAt: Date.now() };
    localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // localStorage may be unavailable (private browsing, storage quota).
    // Non-fatal — the network path always provides the canonical data.
  }
}

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — picks up newly uploaded videos

export function useSermons() {
  // Prime with the localStorage cache so the first render shows content
  // immediately (within a synchronous paint cycle) instead of waiting for
  // the network. The cache is replaced with live data after the first fetch
  // completes, and the loading flag is set to false only then.
  const [sermons, setSermons] = useState<Sermon[]>(() => readCatalogCache() ?? []);
  // Start in loading state only if we have NO cached data. If the cache
  // hydrated sermons above, suppress the shimmer skeleton on cold start —
  // the cached content is already on screen, so a loading indicator would
  // feel like a regression rather than progress.
  const [loading, setLoading] = useState(() => readCatalogCache() === null);
  const [error, setError] = useState<string | null>(null);
  // `useLiveSync` carries a `libraryRevision` counter that the server bumps
  // (via the `videos-library-updated` SSE event) whenever the public video
  // catalogue changes — admin upload finalize, edit, delete, transcoding
  // completion, or YouTube sync. Watching it here means newly uploaded
  // sermons appear on TV within a few hundred ms instead of waiting on the
  // 5-minute background poll.
  const { libraryRevision } = useLiveSync();

  useEffect(() => {
    let cancelled = false;

    const load = (isInitial: boolean) => {
      if (isInitial) setLoading(true);
      fetchVideos()
        .then((videos) => {
          if (!cancelled) {
            // null = 304 Not Modified — library unchanged, keep current data.
            if (videos === null) {
              setLoading(false);
              return;
            }
            const categorized = categorize(videos);
            setSermons(categorized);
            setLoading(false);
            // Keep localStorage warm so the next cold start is instant.
            writeCatalogCache(categorized);
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

  // Refetch on every library-revision bump (skip the initial 0 value, which
  // is already covered by the mount-time load above).
  useEffect(() => {
    if (libraryRevision === 0) return;
    let cancelled = false;
    fetchVideos()
      .then((videos) => {
        if (!cancelled && videos !== null) {
          // null = 304 Not Modified — library unchanged, nothing to update.
          const categorized = categorize(videos);
          setSermons(categorized);
          writeCatalogCache(categorized);
        }
      })
      .catch(() => {
        // SSE-driven refetch failures are non-fatal — the next poll boundary
        // or the next SSE bump will catch up.
      });
    return () => { cancelled = true; };
  }, [libraryRevision]);

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
