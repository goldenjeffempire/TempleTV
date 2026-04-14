export interface PlatformStatus {
  generatedAt: string;
  overallStatus: "ok" | "degraded" | "critical";
  checks: Array<{ key: string; label: string; status: "ok" | "degraded" | "critical" }>;
  database?: {
    counts?: {
      videos?: number;
      activeScheduleEntries?: number;
    };
  };
  broadcast?: {
    activeQueueItems?: number;
    activeLiveOverrides?: number;
  };
}

export async function fetchPlatformStatus(): Promise<PlatformStatus | null> {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (!domain) return null;
  try {
    const res = await fetch(`https://${domain}/api/ops/status`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    return await res.json() as PlatformStatus;
  } catch {
    return null;
  }
}