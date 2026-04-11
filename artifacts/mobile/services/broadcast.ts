export interface BroadcastCurrentResult {
  item: {
    id: string;
    youtubeId: string;
    title: string;
    thumbnailUrl: string;
    durationSecs: number;
    localVideoUrl: string | null;
    videoSource: string;
  } | null;
  nextItem: {
    id: string;
    youtubeId: string;
    title: string;
    thumbnailUrl: string;
    durationSecs: number;
    localVideoUrl: string | null;
    videoSource: string;
  } | null;
  index: number;
  positionSecs: number;
  totalSecs: number;
  queueLength: number;
  progressPercent?: number;
  syncedAt?: string;
  failoverReason?: string | null;
  activeSchedule?: {
    id: string;
    title: string;
    contentType: "live" | "playlist" | "video";
    contentId: string | null;
    startTime: string;
    endTime: string | null;
  } | null;
}

export async function checkBroadcastCurrent(): Promise<BroadcastCurrentResult | null> {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (!domain) return null;
  try {
    const res = await fetch(`https://${domain}/api/broadcast/current`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as BroadcastCurrentResult;
  } catch {
    return null;
  }
}
