/**
 * useVideos — API-driven video catalog hook.
 *
 * Replaces the legacy useYouTubeChannel + useLocalVideos fragmentation.
 * Single source of truth: everything comes from GET /api/videos.
 *
 * Features:
 *  • AsyncStorage cache with 10-min TTL for offline-first cold starts
 *  • SSE-driven instant refetch on libraryRevision bump (admin upload, edit, delete)
 *  • Client-side category filter + text search (memoized, no extra network calls)
 *  • Stable Sermon shape used throughout the app
 *
 * usePaginatedVideos — server-side paginated hook for the Library screen.
 *  • Fetches 30 videos per page with server-side search/category/sort
 *  • Supports infinite scroll via loadMore()
 *  • Resets on filter/sort change
 *  • Debounces search input (350 ms)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { fetchVideos, type ApiVideo } from "@/services/api";
import { useBroadcastSync } from "@/hooks/useBroadcastSync";
import type { Sermon, SermonCategory, SortMode } from "@/types";

const CACHE_KEY = "@temple_tv/videos_v2";
// 30 min — aligns mobile with TV (`ttv:catalog:v1` 30-min TTL) so cold-start
// shimmer is suppressed for the same window. Library mutations still bypass
// this via the `libraryRevision` SSE/WS bump, so freshness isn't impacted.
const CACHE_TTL_MS = 30 * 60 * 1000;

const CATEGORY_MAP: Record<string, SermonCategory> = {
  Deliverance: "Deliverance",
  deliverance: "Deliverance",
  Sermons: "Sermons",
  teachings: "Sermons",
  teaching: "Sermons",
  sermon: "Sermons",
  faith: "Sermons",
  Faith: "Sermons",
  worship: "Sermons",
  Worship: "Sermons",
  music: "Sermons",
  prophecy: "Sermons",
  Prophecy: "Sermons",
  special: "Sermons",
  "Special Programs": "Sermons",
  Prayers: "Prayers",
  prayers: "Prayers",
  prayer: "Prayers",
  Crusades: "Crusades",
  crusades: "Crusades",
  crusade: "Crusades",
  Conferences: "Conferences",
  conferences: "Conferences",
  conference: "Conferences",
  Testimonies: "Testimonies",
  testimonies: "Testimonies",
  testimony: "Testimonies",
};

const CATEGORY_KEYWORDS: Record<SermonCategory, string[]> = {
  Deliverance: ["deliver", "freedom", "bondage", "oppress", "demon"],
  Prayers: ["prayer", "fast", "intercession", "supplicate", "vigil"],
  Crusades: ["crusade", "revival", "evangelism", "outreach", "campaign"],
  Conferences: ["conference", "convention", "summit", "symposium", "seminar"],
  Testimonies: ["testimony", "testimonies", "witness", "miracle story", "breakthrough story"],
  Sermons: ["teaching", "lesson", "sermon", "preach", "doctrine", "truth", "faith", "worship", "prophecy"],
  All: [],
};

const CATEGORY_ORDER: SermonCategory[] = [
  "Deliverance", "Sermons",
  "Prayers", "Crusades", "Conferences", "Testimonies",
];

function mapCategory(raw: string | null | undefined): SermonCategory {
  if (!raw) return "Sermons";
  return CATEGORY_MAP[raw] ?? inferCategory(raw);
}

function inferCategory(text: string): SermonCategory {
  const lower = text.toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS) as [SermonCategory, string[]][]) {
    if (cat === "All") continue;
    if (keywords.some((kw) => lower.includes(kw))) return cat;
  }
  return "Sermons";
}

function formatDuration(raw: string | null | undefined): string {
  if (!raw) return "";
  // ISO 8601 — e.g. PT1H23M45S
  const iso = raw.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (iso) {
    const h = parseInt(iso[1] ?? "0");
    const m = parseInt(iso[2] ?? "0");
    const s = parseInt(iso[3] ?? "0");
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  // Plain seconds — e.g. "5400"
  const totalSecs = parseInt(raw);
  if (!isNaN(totalSecs) && totalSecs > 0) {
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  return raw;
}

function apiVideoToSermon(v: ApiVideo, fallbackIndex: number): Sermon {
  const isLocal = v.videoSource === "local";
  const category = mapCategory(v.category) || inferCategory(v.title);
  return {
    id: v.id,
    title: v.title,
    description: v.description ?? "",
    youtubeId: v.youtubeId ?? "",
    thumbnailUrl: v.thumbnailUrl ?? "",
    duration: formatDuration(v.duration),
    category,
    preacher: v.preacher || "Temple TV",
    date: v.publishedAt ?? v.importedAt ?? "",
    views: v.viewCount ?? 0,
    videoSource: isLocal ? "local" : "youtube",
    localVideoUrl: v.hlsMasterUrl ?? v.localVideoUrl ?? undefined,
  };
}

interface CachePayload {
  sermons: Sermon[];
  cachedAt: number;
}

async function readCache(): Promise<Sermon[] | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachePayload;
    if (!parsed.sermons?.length || !parsed.cachedAt) return null;
    if (Date.now() - parsed.cachedAt > CACHE_TTL_MS) {
      await AsyncStorage.removeItem(CACHE_KEY);
      return null;
    }
    return parsed.sermons;
  } catch {
    return null;
  }
}

async function writeCache(sermons: Sermon[]): Promise<void> {
  try {
    const payload: CachePayload = { sermons, cachedAt: Date.now() };
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    /* non-critical */
  }
}

export interface UseVideosResult {
  sermons: Sermon[];
  byCategory: Record<string, Sermon[]>;
  loading: boolean;
  error: string | null;
  refetch: () => void;
  /** True while the displayed data is from the local cache (network fetch not yet complete). */
  isStale: boolean;
  /**
   * True when a background refresh attempt failed but we still have cached/
   * previously-fetched data to show. The stale banner should reflect this
   * state ("Couldn't refresh") rather than the generic "refreshing…" message.
   * Cleared automatically when a subsequent refresh succeeds.
   */
  refreshFailed: boolean;
  /** Timestamp of the last successful network fetch, or null if never fetched this session. */
  lastFetchedAt: Date | null;
}

export function useVideos(): UseVideosResult {
  const [sermons, setSermons] = useState<Sermon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);
  const loadedRef = useRef(false);
  // True once we have any data to show (from cache or network). Used to
  // decide whether a network failure should surface as a full error screen
  // (no data at all) or just flip the stale-banner to "Couldn't refresh".
  const hasDataRef = useRef(false);
  const { libraryRevision } = useBroadcastSync();

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      // Cold-start: paint cache immediately while the network fetch runs.
      // Mark isStale=true so the UI can surface a subtle "cached" indicator.
      if (!loadedRef.current) {
        const cached = await readCache();
        if (cached?.length) {
          setSermons(cached);
          hasDataRef.current = true;
          setIsStale(true);
          setLoading(false);
        }
      }
      // Fetch full catalog (limit=2000) so home-screen category grids
      // show the complete Temple TV library, not just the newest 500.
      const resp = await fetchVideos({ limit: 2000, sort: "newest" });
      const mapped = resp.videos.map((v, i) => apiVideoToSermon(v, i));
      setSermons(mapped);
      hasDataRef.current = true;
      setIsStale(false);
      setRefreshFailed(false);
      setLastFetchedAt(new Date());
      setLoading(false);
      loadedRef.current = true;
      await writeCache(mapped);
    } catch (err) {
      if (hasDataRef.current) {
        // We already have cached or previously-fetched data to show.
        // Flip the stale banner to "Couldn't refresh" instead of blowing
        // away the visible content with an error screen.
        setRefreshFailed(true);
        if (!silent) setLoading(false);
      } else {
        // No data at all — show the full empty-state error screen.
        setError(err instanceof Error ? err.message : "Failed to load videos");
        setLoading(false);
      }
    }
  }, []);

  // Initial load
  useEffect(() => {
    load(false);
    // Background refresh every 5 min
    const timer = setInterval(() => load(true), 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [load]);

  // SSE-driven instant refetch on library changes
  useEffect(() => {
    if (libraryRevision === 0) return;
    load(true);
  }, [libraryRevision, load]);

  const byCategory = useMemo(
    () =>
      CATEGORY_ORDER.reduce<Record<string, Sermon[]>>(
        (acc, cat) => {
          acc[cat] = sermons.filter((s) => s.category === cat);
          return acc;
        },
        { All: sermons },
      ),
    [sermons],
  );

  return { sermons, byCategory, loading, error, refetch: () => load(false), isStale, refreshFailed, lastFetchedAt };
}

export interface UseFilteredVideosOptions {
  search: string;
  category: SermonCategory;
  sort: SortMode;
}

export function useFilteredVideos(
  sermons: Sermon[],
  { search, category, sort }: UseFilteredVideosOptions,
): Sermon[] {
  return useMemo(() => {
    let result = sermons;

    if (category !== "All") {
      result = result.filter((s) => s.category === category);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.preacher.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      );
    }

    switch (sort) {
      case "oldest":
        result = [...result].sort(
          (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
        );
        break;
      case "popular":
        result = [...result].sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
        break;
      case "newest":
      default:
        result = [...result].sort(
          (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
        );
        break;
    }

    return result;
  }, [sermons, search, category, sort]);
}

// ── Paginated hook for Library screen ────────────────────────────────────────
// Uses server-side search/filter/sort via GET /api/videos with page param.
// Supports infinite scroll — call loadMore() from FlatList.onEndReached.

const PAGE_SIZE = 30;

export interface PaginatedVideosState {
  sermons: Sermon[];
  total: number;
  totalPages: number;
  page: number;
  /** True only during the initial load (no data yet). */
  loading: boolean;
  /** True during an infinite-scroll page fetch. */
  loadingMore: boolean;
  /** True while a pull-to-refresh runs on top of existing data. */
  isRefreshing: boolean;
  hasMore: boolean;
  /** Set on initial-load failure. Null when data loaded successfully. */
  error: string | null;
  /** Set when a background refresh fails but existing data is still shown. */
  refreshError: string | null;
  loadMore: () => void;
  refetch: () => void;
}

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// Map mobile category display names to API category slugs.
// The server stores lowercase slugs (faith, deliverance, worship, etc.)
// but mobile UI shows display names (Deliverance, Sermons, Worship, etc.).
function categoryToApiSlug(category: SermonCategory): string | undefined {
  if (category === "All") return undefined;
  const MAP: Record<SermonCategory, string> = {
    Deliverance: "deliverance",
    Sermons: "teaching",
    Prayers: "prayer",
    Crusades: "crusade",
    Conferences: "conference",
    Testimonies: "testimony",
    All: "",
  };
  return MAP[category] || undefined;
}

function sortModeToApi(sort: SortMode): string {
  switch (sort) {
    case "popular": return "views";
    case "oldest": return "oldest";
    default: return "newest";
  }
}

export function usePaginatedVideos(opts: {
  search: string;
  category: SermonCategory;
  sort: SortMode;
}): PaginatedVideosState {
  const debouncedSearch = useDebounce(opts.search, 350);
  const { libraryRevision } = useBroadcastSync();

  const [sermons, setSermons] = useState<Sermon[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const hasMore = page < totalPages;

  // Stable ref to latest opts to avoid stale closure in loadMore
  const optsRef = useRef({ debouncedSearch, category: opts.category, sort: opts.sort });
  optsRef.current = { debouncedSearch, category: opts.category, sort: opts.sort };

  // Snapshot of sermons before a background refresh so we can restore on failure
  const preRefreshSermonsRef = useRef<Sermon[]>([]);

  const fetchPage = useCallback(async (pageNum: number, replace: boolean) => {
    const { debouncedSearch: search, category, sort } = optsRef.current;
    const apiCategory = categoryToApiSlug(category);
    const apiSort = sortModeToApi(sort);

    const resp = await fetchVideos({
      limit: PAGE_SIZE,
      page: pageNum,
      search: search || undefined,
      category: apiCategory,
      sort: apiSort as "newest" | "oldest" | "views",
    });
    const mapped = resp.videos.map((v, i) => apiVideoToSermon(v, (pageNum - 1) * PAGE_SIZE + i));
    if (replace) {
      setSermons(mapped);
    } else {
      setSermons((prev) => {
        // Deduplicate by id in case of concurrent fetches
        const ids = new Set(prev.map((s) => s.id));
        return [...prev, ...mapped.filter((s) => !ids.has(s.id))];
      });
    }
    setTotal(resp.total ?? mapped.length);
    setTotalPages(resp.totalPages ?? 1);
    setPage(pageNum);
    setError(null);
    setRefreshError(null);
  }, []);

  // Reset and load page 1 when filters change
  useEffect(() => {
    setLoading(true);
    setSermons([]);
    setPage(1);
    setTotal(0);
    setTotalPages(1);
    setRefreshError(null);
    void fetchPage(1, true)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load videos"))
      .finally(() => setLoading(false));
  }, [debouncedSearch, opts.category, opts.sort, fetchPage, libraryRevision]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    void fetchPage(page + 1, false)
      .catch(() => { /* loadMore failures are silent — user can scroll again */ })
      .finally(() => setLoadingMore(false));
  }, [loadingMore, hasMore, page, fetchPage]);

  /**
   * Pull-to-refresh: if data is already showing, keep it visible while the
   * refresh runs (sets isRefreshing). On failure, restore the previous data
   * and surface refreshError. On success, replace with fresh data.
   */
  const refetch = useCallback(() => {
    if (sermons.length === 0) {
      // No data yet — fall back to a full loading state.
      setLoading(true);
      setPage(1);
      void fetchPage(1, true)
        .catch((err) => setError(err instanceof Error ? err.message : "Failed to load videos"))
        .finally(() => setLoading(false));
      return;
    }

    // Background refresh — keep existing data visible.
    preRefreshSermonsRef.current = sermons;
    setIsRefreshing(true);
    setRefreshError(null);
    setPage(1);

    void fetchPage(1, true)
      .catch((err) => {
        // Restore previous sermons so the user doesn't see an empty list.
        setSermons(preRefreshSermonsRef.current);
        setRefreshError(err instanceof Error ? err.message : "Couldn't refresh");
      })
      .finally(() => setIsRefreshing(false));
  }, [sermons, fetchPage]);

  return {
    sermons,
    total,
    totalPages,
    page,
    loading,
    loadingMore,
    isRefreshing,
    hasMore,
    error,
    refreshError,
    loadMore,
    refetch,
  };
}
