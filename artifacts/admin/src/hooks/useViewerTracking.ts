/**
 * useViewerTracking
 *
 * Returns live viewer counts + 5-min trend for all streams (or a specific
 * streamId).  Data is fetched via TanStack Query and invalidated immediately
 * whenever the admin SSE channel emits a `viewer-count-updated` event —
 * keeping the display latency under 5 s without constant polling.
 *
 * When SSE is unavailable the query falls back to a 15 s polling interval
 * so the panel still refreshes automatically.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSSEEvent } from "@/contexts/sse-context";
import { api } from "@/lib/api";
import { useSseGatedInterval } from "@/hooks/useSseGatedInterval";

export interface TrendPoint {
  ts:    number;
  count: number;
}

export interface StreamViewerStats {
  streamId:    string;
  current:     number;
  peak:        number;
  trend:       TrendPoint[];
  updatedAtMs: number;
}

export interface ViewerTrackingData {
  streams:      StreamViewerStats[];
  totalCurrent: number;
  totalPeak:    number;
}

const QUERY_KEY = (streamId?: string) =>
  streamId ? ["viewer-tracking", streamId] : ["viewer-tracking"];

async function fetchViewerStats(streamId?: string): Promise<ViewerTrackingData> {
  const path = streamId
    ? `/api/viewer-tracking/stats/${encodeURIComponent(streamId)}`
    : "/api/viewer-tracking/stats";
  const res = await api(path);
  if (!res.ok) throw new Error(`viewer-tracking stats: ${res.status}`);
  return res.json() as Promise<ViewerTrackingData>;
}

export function useViewerTracking(streamId?: string): {
  data:      ViewerTrackingData | undefined;
  isLoading: boolean;
  error:     Error | null;
} {
  const qc = useQueryClient();
  const key = QUERY_KEY(streamId);

  // SSE-invalidate: push a fresh fetch whenever the server emits a count update
  useSSEEvent("viewer-count-updated", (raw) => {
    const payload = raw as { streamId?: string } | null;
    // Invalidate specific stream query or the aggregate depending on what changed
    if (streamId) {
      if (!payload?.streamId || payload.streamId === streamId) {
        void qc.invalidateQueries({ queryKey: key });
      }
    } else {
      void qc.invalidateQueries({ queryKey: ["viewer-tracking"] });
    }
  });

  // Fallback polling when SSE is degraded/offline
  const fallbackInterval = useSseGatedInterval(15_000);

  const { data, isLoading, error } = useQuery<ViewerTrackingData, Error>({
    queryKey:    key,
    queryFn:     () => fetchViewerStats(streamId),
    staleTime:   10_000,
    gcTime:      60_000,
    refetchInterval: fallbackInterval,
  });

  return { data, isLoading, error };
}
