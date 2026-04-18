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
}

export interface LiveStatus {
  isLive: boolean;
  videoId: string | null;
  title: string | null;
  checkedAt: number;
  detectionMethod?: string;
}

export interface BroadcastItem {
  type: string;
  title: string;
  thumbnailUrl?: string;
  youtubeId?: string;
  startedAt?: string;
}

export interface BroadcastCurrent {
  current: BroadcastItem | null;
  syncedAt: string;
  serverTimeMs: number;
  isLive?: boolean;
  liveVideoId?: string | null;
}

export async function fetchVideos(): Promise<VideoItem[]> {
  const res = await fetch(apiUrl("/youtube/videos"), {
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error("Failed to fetch videos");
  const data = await res.json() as { videos: VideoItem[] };
  return data.videos ?? [];
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

export { BASE_URL };
