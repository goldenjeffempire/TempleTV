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

/**
 * Fetches published sermon series from the API.
 * Used on the TV Home page to render the horizontal series browsing row.
 */
export function useSeries() {
  const [series, setSeries] = useState<SeriesItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const origin = resolveApiOrigin();
    fetch(`${origin}/api/series?limit=20`)
      .then((r) => (r.ok ? (r.json() as Promise<SeriesResponse>) : { series: [], total: 0 }))
      .then((data) => setSeries(data.series ?? []))
      .catch(() => setSeries([]))
      .finally(() => setLoading(false));
  }, []);

  return { series, loading };
}
