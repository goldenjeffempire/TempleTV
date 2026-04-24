const BASE_URL = import.meta.env.BASE_URL.replace(/\/$/, "");

function apiUrl(path: string): string {
  const origin = window.location.origin;
  return `${origin}/api${path}`;
}

export interface VideoItem {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  thumbnailUrl: string;
  channelName: string;
  duration: string;
  viewCount: string;
  videoSource: "youtube" | "local";
  localVideoUrl: string | null;
  /** Category as set by the admin (e.g. "sermon", "music"). Used directly for local uploads. */
  apiCategory: string;
}

export interface LiveStatus {
  isLive: boolean;
  videoId: string | null;
  title: string | null;
  checkedAt: number;
  detectionMethod?: string;
}

export interface BroadcastItem {
  id: string;
  videoId: string;
  youtubeId?: string;
  title: string;
  thumbnailUrl?: string;
  durationSecs: number;
  localVideoUrl?: string | null;
  videoSource?: string;
  startedAt?: string;
}

export interface BroadcastCurrent {
  item: BroadcastItem | null;
  nextItem: BroadcastItem | null;
  positionSecs: number;
  totalSecs: number;
  progressPercent: number;
  queueLength: number;
  syncedAt: string;
  serverTimeMs: number;
  activeSchedule?: { contentType: string } | null;
  liveOverride?: { title: string } | null;
}

export interface GuideItem {
  id: string;
  youtubeId: string;
  title: string;
  thumbnailUrl: string;
  durationSecs: number;
  localVideoUrl: string | null;
  videoSource: string;
  startMs: number;
  endMs: number;
  isCurrent: boolean;
  positionSecs: number;
  progressPercent: number;
}

export interface GuideResponse {
  items: GuideItem[];
  liveOverride?: { title: string } | null;
}

// Shape returned by the public /api/videos endpoint (DB format).
interface DbVideo {
  id: string;
  youtubeId: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  duration: string;
  category: string;
  preacher: string;
  publishedAt: string | null;
  importedAt: string;
  viewCount: number;
  videoSource: string;
  localVideoUrl: string | null;
  hlsMasterUrl: string | null;
}

function dbVideoToVideoItem(v: DbVideo): VideoItem {
  const isLocal = v.videoSource === "local";
  return {
    videoId: isLocal ? v.id : (v.youtubeId ?? v.id),
    title: v.title,
    description: v.description ?? "",
    publishedAt: v.publishedAt ?? v.importedAt ?? "",
    thumbnailUrl: v.thumbnailUrl ?? "",
    channelName: v.preacher || "Temple TV JCTM",
    duration: v.duration ?? "",
    viewCount: String(v.viewCount ?? 0),
    videoSource: isLocal ? "local" : "youtube",
    localVideoUrl: v.hlsMasterUrl ?? v.localVideoUrl ?? null,
    apiCategory: v.category ?? "",
  };
}

/**
 * Fetch all videos (YouTube + local uploads) from the public catalogue endpoint.
 * This is the canonical source of truth for the TV library.
 */
export async function fetchVideos(): Promise<VideoItem[]> {
  const res = await fetch(apiUrl("/videos?limit=500"), {
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error("Failed to fetch videos");
  const data = await res.json() as { videos: DbVideo[] };
  return (data.videos ?? []).map(dbVideoToVideoItem);
}

export async function fetchLiveStatus(): Promise<LiveStatus> {
  const res = await fetch(apiUrl("/youtube/live/status"), {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error("Failed to fetch live status");
  return res.json() as Promise<LiveStatus>;
}

export async function fetchBroadcastCurrent(): Promise<BroadcastCurrent> {
  const res = await fetch(apiUrl("/broadcast/current"), {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error("Failed to fetch broadcast");
  return res.json() as Promise<BroadcastCurrent>;
}

export async function fetchGuide(): Promise<GuideResponse> {
  const res = await fetch(apiUrl("/broadcast/guide"), {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error("Failed to fetch guide");
  return res.json() as Promise<GuideResponse>;
}

export { BASE_URL };
