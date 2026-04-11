import { useEffect, useState } from "react";
import type { Sermon, SermonCategory } from "@/types";

interface FeaturedVideo {
  id: string;
  youtubeId: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  duration: string;
  category: string;
  preacher: string;
  publishedAt: string | null;
  views: number;
}

function toSermon(v: FeaturedVideo): Sermon {
  return {
    id: v.id,
    youtubeId: v.youtubeId,
    title: v.title,
    description: v.description,
    thumbnailUrl: v.thumbnailUrl || `https://img.youtube.com/vi/${v.youtubeId}/hqdefault.jpg`,
    duration: v.duration,
    category: (v.category as SermonCategory) || "Faith",
    preacher: v.preacher || "JCTM",
    date: v.publishedAt ?? "",
    views: v.views,
  };
}

export function useFeaturedVideos() {
  const [featured, setFeatured] = useState<Sermon[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const domain = process.env.EXPO_PUBLIC_DOMAIN ?? "";
    const base = domain ? `https://${domain}` : "";
    fetch(`${base}/api/videos/featured`)
      .then((r) => r.json())
      .then((data: FeaturedVideo[]) => {
        if (Array.isArray(data)) setFeatured(data.map(toSermon));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return { featured, loading };
}
