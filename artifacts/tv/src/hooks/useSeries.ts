import { useEffect, useState } from "react";
import { resolveApiOrigin } from "../lib/api";

export interface SeriesItem {
  id: string;
  title: string;
  slug: string;
  description: string;
  thumbnailUrl: string;
  preacher: string | null;
  category: string;
  isOngoing: boolean;
}

interface SeriesResponse {
  series: SeriesItem[];
  total: number;
}

export function useSeries() {
  const [series, setSeries] = useState<SeriesItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ctrl = new AbortController();
    const origin = resolveApiOrigin();
    fetch(`${origin}/api/series?limit=20`, { signal: ctrl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<SeriesResponse>) : { series: [], total: 0 }))
      .then((data) => setSeries(data.series ?? []))
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === "AbortError") return;
        setSeries([]);
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, []);

  return { series, loading };
}
