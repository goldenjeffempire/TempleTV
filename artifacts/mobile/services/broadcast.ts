export interface BroadcastItem {
  id: string;
  youtubeId: string;
  title: string;
  thumbnailUrl: string;
  durationSecs: number;
  localVideoUrl: string | null;
  videoSource: string;
}

export interface BroadcastCurrentResult {
  item: BroadcastItem | null;
  nextItem: BroadcastItem | null;
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
  liveOverride?: {
    id: string;
    title: string;
    startedAt: string;
    endsAt: string | null;
  } | null;
}

function toAbsoluteUrl(url: string | null, domain: string): string | null {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `https://${domain}${url.startsWith("/") ? url : `/${url}`}`;
}

function normalizeItem(item: BroadcastItem | null, domain: string): BroadcastItem | null {
  if (!item) return null;
  return {
    ...item,
    localVideoUrl: toAbsoluteUrl(item.localVideoUrl, domain),
    thumbnailUrl: toAbsoluteUrl(item.thumbnailUrl, domain) ?? item.thumbnailUrl,
  };
}

export interface BroadcastGuideItem {
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

export interface BroadcastGuideResult {
  items: BroadcastGuideItem[];
  liveOverride?: { title: string } | null;
}

export async function fetchBroadcastGuide(): Promise<BroadcastGuideResult | null> {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (!domain) return null;
  try {
    const res = await fetch(`https://${domain}/api/broadcast/guide`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as BroadcastGuideResult;
    return {
      ...data,
      items: data.items.map((item) => ({
        ...item,
        localVideoUrl: toAbsoluteUrl(item.localVideoUrl, domain),
        thumbnailUrl: toAbsoluteUrl(item.thumbnailUrl, domain) ?? item.thumbnailUrl,
      })),
    };
  } catch {
    return null;
  }
}

export async function checkBroadcastCurrent(): Promise<BroadcastCurrentResult | null> {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (!domain) return null;
  try {
    const res = await fetch(`https://${domain}/api/broadcast/current`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as BroadcastCurrentResult;
    return {
      ...data,
      item: normalizeItem(data.item, domain),
      nextItem: normalizeItem(data.nextItem, domain),
    };
  } catch {
    return null;
  }
}
