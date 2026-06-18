/**
 * useYouTubeSyncStatus
 *
 * Polls the lightweight public /api/admin/youtube/sync/mobile-status endpoint
 * every POLL_INTERVAL_MS (default 10 minutes) so the mobile UI can show:
 *   - Last sync time ("Updated 3 minutes ago")
 *   - Whether the YouTube shuffle fallback is currently serving content
 *   - Total video count in the catalog
 *
 * Deliberately uses a plain interval rather than TanStack Query so it does
 * NOT conflict with the aggressive staleTime/gcTime settings on the videos
 * catalog queries. This is a low-priority background health check, not
 * a data-driving fetch.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, AppStateStatus } from "react-native";
import { getApiBase } from "@/lib/apiBase";

const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const RETRY_DELAY_MS = 60 * 1000;         // 1 minute on error
const FOREGROUND_MIN_STALE_MS = 5 * 60 * 1000; // re-fetch on foreground if > 5 min old

export interface YouTubeSyncStatus {
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  totalVideos: number;
  syncInProgress: boolean;
  shuffleFallbackActive: boolean;
  nextSyncAt: string | null;
  fetchedAtMs: number | null;
  error: string | null;
}

const INITIAL: YouTubeSyncStatus = {
  lastSyncAt: null,
  lastSyncStatus: null,
  totalVideos: 0,
  syncInProgress: false,
  shuffleFallbackActive: false,
  nextSyncAt: null,
  fetchedAtMs: null,
  error: null,
};

export function useYouTubeSyncStatus(): YouTubeSyncStatus {
  const [status, setStatus] = useState<YouTubeSyncStatus>(INITIAL);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const lastFetchAtMs = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const fetchStatus = useCallback(async () => {
    clearTimer();
    const apiBase = getApiBase();
    try {
      const res = await fetch(`${apiBase}/api/admin/youtube/sync/mobile-status`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!mountedRef.current) return;
      if (res.ok) {
        const data = await res.json() as {
          lastSyncAt: string | null;
          lastSyncStatus: string | null;
          totalVideos: number;
          syncInProgress: boolean;
          shuffleFallbackActive: boolean;
          nextSyncAt: string | null;
        };
        const now = Date.now();
        lastFetchAtMs.current = now;
        setStatus({
          ...data,
          fetchedAtMs: now,
          error: null,
        });
        timerRef.current = setTimeout(() => void fetchStatus(), POLL_INTERVAL_MS);
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setStatus((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }));
      timerRef.current = setTimeout(() => void fetchStatus(), RETRY_DELAY_MS);
    }
  }, []);

  // Fetch on mount
  useEffect(() => {
    mountedRef.current = true;
    void fetchStatus();
    return () => {
      mountedRef.current = false;
      clearTimer();
    };
  }, [fetchStatus]);

  // Re-fetch when app comes to foreground after being away > 5 min
  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState !== "active") return;
      const now = Date.now();
      const age = lastFetchAtMs.current !== null ? now - lastFetchAtMs.current : Infinity;
      if (age >= FOREGROUND_MIN_STALE_MS) {
        void fetchStatus();
      }
    };

    const sub = AppState.addEventListener("change", handleAppStateChange);
    return () => sub.remove();
  }, [fetchStatus]);

  return status;
}
