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

export async function checkLiveStatus(): Promise<LiveCheckResult> {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(getChannelLiveUrl())}&format=json`;
    const response = await fetch(oembedUrl, { signal: AbortSignal.timeout(5000) });

    if (response.ok) {
      const data = (await response.json()) as { title?: string; html?: string };
      const match = data.html?.match(/embed\/([a-zA-Z0-9_-]{11})/);
      const videoId = match ? match[1] : null;
      return { isLive: !!videoId, videoId, title: data.title ?? null };
    }
    return { isLive: false, videoId: null, title: null };
  } catch {
    return { isLive: false, videoId: null, title: null };
  }
}
