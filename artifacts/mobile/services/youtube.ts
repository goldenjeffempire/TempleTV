import { Platform } from "react-native";

export const JCTM_CHANNEL_HANDLE = "templetvjctm";
export const JCTM_CHANNEL_URL = `https://www.youtube.com/@${JCTM_CHANNEL_HANDLE}`;

export interface LiveCheckResult {
  isLive: boolean;
  videoId: string | null;
  title: string | null;
}

export function getYouTubeEmbedUrl(videoId: string, autoplay = true): string {
  const params = new URLSearchParams({
    autoplay: autoplay ? "1" : "0",
    playsinline: "1",
    rel: "0",
    modestbranding: "1",
    enablejsapi: "1",
    fs: "1",
  });
  return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
}

export function getLiveEmbedUrl(): string {
  return `https://www.youtube.com/embed?listType=user_uploads&list=${JCTM_CHANNEL_HANDLE}&autoplay=1&playsinline=1&rel=0&modestbranding=1`;
}

export function getChannelLiveUrl(): string {
  return `${JCTM_CHANNEL_URL}/live`;
}

export function getThumbnailUrl(videoId: string, quality: "default" | "hq" | "maxres" = "hq"): string {
  const suffix = quality === "maxres" ? "maxresdefault" : quality === "hq" ? "hqdefault" : "default";
  return `https://img.youtube.com/vi/${videoId}/${suffix}.jpg`;
}

async function checkLiveViaOembed(): Promise<LiveCheckResult> {
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(getChannelLiveUrl())}&format=json`;
  const response = await fetch(oembedUrl, { signal: AbortSignal.timeout(6000) });
  if (!response.ok) return { isLive: false, videoId: null, title: null };
  const data = (await response.json()) as { title?: string; html?: string; thumbnail_url?: string };
  // Try extracting videoId from embed HTML first
  const htmlMatch = data.html?.match(/embed\/([a-zA-Z0-9_-]{11})/);
  const thumbMatch = data.thumbnail_url?.match(/\/vi\/([a-zA-Z0-9_-]{11})\//);
  const videoId = htmlMatch?.[1] ?? thumbMatch?.[1] ?? null;
  return { isLive: !!videoId, videoId, title: data.title ?? null };
}

async function checkLiveViaCachedStatus(): Promise<LiveCheckResult | null> {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (!domain) return null;
  try {
    const res = await fetch(`https://${domain}/api/youtube/live/status`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as LiveCheckResult & { staleSec?: number };
    if ((data.staleSec ?? 999) > 120) return null;
    return { isLive: data.isLive, videoId: data.videoId, title: data.title };
  } catch {
    return null;
  }
}

async function checkLiveViaApiServer(): Promise<LiveCheckResult | null> {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (!domain) return null;
  try {
    const res = await fetch(`https://${domain}/api/youtube/live`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as LiveCheckResult;
    return data;
  } catch {
    return null;
  }
}

export async function checkLiveStatus(useCached = false): Promise<LiveCheckResult> {
  try {
    if (useCached) {
      const cached = await checkLiveViaCachedStatus();
      if (cached !== null) return cached;
    }
    const apiResult = await checkLiveViaApiServer();
    if (apiResult !== null) return apiResult;
    return await checkLiveViaOembed();
  } catch {
    return { isLive: false, videoId: null, title: null };
  }
}
